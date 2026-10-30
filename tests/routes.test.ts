import { RwsError } from 'abb-rws-client';
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/server.js';
import { TOKEN_HEADER } from '../src/schema/v0.js';
import { registerControllerRoutes, type RouteDeps, type SavedDiscovery } from '../src/routes.js';
import { summarize, type FleetLike } from '../src/fleet.js';
import { idFromName, loadConfig, saveConfig, type ControllerConfig, type DiscoverySettings } from '../src/config.js';
import type { DiscoverRequest, DiscoveryAnswer } from '../src/discovery.js';
import type { Passport } from '../src/passport.js';
import { ReadLimitError } from '../src/readBudget.js';
import { ReplayModeError } from '../src/recording/contract.js';
import { EventFeed } from '../src/events.js';
import { SnapshotStream, registerStreamRoute } from '../src/stream.js';
import { SocketHub } from '../src/wsHub.js';

/** The daemon's access token in these tests, and the headers of a native consumer that holds it. */
const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const LOCAL = { host: '127.0.0.1:7810', [TOKEN_HEADER]: TOKEN };
const SECRET = 'hunter2-not-robotics';
const STATION = '{6F1C0E2A-8B3D-4E5F-9A7B-1C2D3E4F5A6B}';

/**
 * A controller refusal as the client raises it - status, raw body, the
 * controller's code and message - with the structured refusal a client that
 * describes refusals attaches, a station id and a credential among it.
 */
function heldRefusal(): RwsError {
  return Object.assign(
    new RwsError('Write access is held by another control station: 403 - release it there, then retry', 'MASTERSHIP_REQUIRED',
      403, `{"raw":"page","authorization":"Basic ${Buffer.from(`u:${SECRET}`).toString('base64')}"}`, -1073435870, 'held by another station'),
    { refusal: { kind: 'held-by-other', grantor: 'current-holder', holder: { kind: 'remote', name: 'RobotStudio', id: STATION }, pincode: SECRET } },
  );
}

/** A controller's event history in these tests: 30 messages, seq 1..30 (the recorded RWS 1.0 shape). */
function eventFeed(): EventFeed {
  const feed = new EventFeed('feed-1');
  feed.take(Array.from({ length: 30 }, (_, i) => ({
    seqnum: 30 - i, code: 10011, msgtype: 1, timestamp: `2026-09-23 T 19:59:${String(29 - i).padStart(2, '0')}`, srcName: 'MC0',
    title: 'Motors ON state', desc: '', causes: '', consequences: '', actions: '', args: [],
  })), { generation: 'rws1', offsetMs: 0, at: Date.parse('2026-09-23T20:00:00Z'), complete: true });
  return feed;
}

function fakeFleet(initial: ControllerConfig[] = []): FleetLike & {
  removed: string[]; watched: string[]; ioWatched: string[][]; ioSearched: object[]; ioTable: { loaded: boolean };
  /** What each events request asked the fleet for. */
  eventsAsked: Array<{ since: number | undefined; limit: number }>;
  /** The lease id each watch request carried (undefined: none), motion and I/O alike, in order. */
  leaseIds: Array<string | undefined>;
  /** While set, a request that would open a lease with an id is refused for the lease limit. */
  leasesFull: { value: boolean };
} {
  const map = new Map(initial.map(c => [c.id, c]));
  const removed: string[] = [];
  const watched: string[] = [];
  const ioWatched: string[][] = [];
  const ioSearched: object[] = [];
  const ioTable = { loaded: true };
  const leaseIds: Array<string | undefined> = [];
  const leasesFull = { value: false };
  const eventsAsked: Array<{ since: number | undefined; limit: number }> = [];
  const feed = eventFeed();
  // As the fleet answers: the id of the lease renewed, a fresh one for 'new', none for the anonymous lease.
  const leaseOf = (leaseId: string | undefined) => (leaseId === undefined ? {} : { leaseId: leaseId === 'new' ? 'minted-1' : leaseId });
  return {
    removed,
    watched,
    ioWatched,
    ioSearched,
    ioTable,
    leaseIds,
    leasesFull,
    eventsAsked,
    events: (id, since, limit) => {
      if (!map.has(id)) { return null; }
      eventsAsked.push({ since, limit });
      return feed.page(since, limit);
    },
    watchMotion: (id, leaseId) => {
      if (!map.has(id)) { return null; }
      leaseIds.push(leaseId);
      if (leaseId !== undefined && leasesFull.value) { return 'lease-limit'; }
      watched.push(id);
      return { leaseMs: 15_000, targetHz: 8, ...leaseOf(leaseId) };
    },
    watchIo: (id, signals, leaseId) => {
      if (!map.has(id)) { return null; }
      leaseIds.push(leaseId);
      if (leaseId !== undefined && leasesFull.value) { return 'lease-limit'; }
      ioWatched.push(signals);
      return {
        leaseMs: 15_000, accepted: signals.slice(0, 24),
        rejected: signals.slice(24).map(name => ({ name, reason: 'controller cap reached (at most 24 signals watched on this controller, all consumers together)' })),
        ...leaseOf(leaseId),
      };
    },
    searchIoSignals: async (id, criteria) => {
      if (!map.has(id)) { return null; }
      ioSearched.push(criteria);
      if (criteria.name === 'boom') {
        throw new RwsError('Resource does not exist on the controller: 404', 'RESOURCE_NOT_FOUND', 404, '<html>raw</html>', -1073445862, 'Signal not found');
      }
      if (criteria.name === 'flood') { throw new ReadLimitError(id, 1, 'rate'); }
      if (!ioTable.loaded) { return 'not-loaded'; }
      return [{ name: 'do_test', value: '1', lvalue: '1', type: 'DO' }];
    },
    has: id => map.has(id),
    all: () => [...map.values()],
    list: () => [...map.values()].map(c => summarize(c, null)),
    get: id => (map.has(id) ? summarize(map.get(id)!, null) : null),
    add: c => { map.set(c.id, c); },
    remove: async id => { map.delete(id); removed.push(id); },
    moduleSource: async (id, task, module) => {
      if (!map.has(id)) { return null; }
      if (module === 'Missing') { throw new RwsError(`Module ${module} not found in ${task}`, 'MODULE_NOT_FOUND'); }
      if (module === 'Held') { throw heldRefusal(); }
      if (module === 'Busy') { throw new ReadLimitError(id, 1, 'in-flight'); }
      if (module === 'Slow') { throw new ReadLimitError(id, 3, 'rate'); }
      return { task, module, kind: module === 'BASE' ? 'system' : 'program', text: 'MODULE X\nENDMODULE', changeCount: 3 };
    },
    rapidSymbol: async (id, task, module, symbol) => {
      if (!map.has(id)) { return null; }
      if (symbol === 'gone') {
        throw new RwsError('Resource does not exist on the controller: HTTP 404 from GET /rw/rapid/symbol/RAPID/T_ROB1/MainModule/gone/data (Symbol not found)',
          'RESOURCE_NOT_FOUND', 404, '<html>raw</html>', -1073442816, 'Symbol not found');
      }
      if (symbol === 'bigArray') { return 'no-value'; }
      if (symbol === 'busy') { throw new ReadLimitError(id, 1, 'in-flight'); }
      return {
        task, module, symbol, value: '"a ""b"""', truncated: false,
        resource: '/rw/rapid/symbol/RAPID/{task}/{module}/{symbol}/data', readAt: '2026-09-23T19:59:58.000Z',
      };
    },
  };
}

const cfg = (id: string, port: number): ControllerConfig =>
  ({ id, name: id.toUpperCase(), host: '127.0.0.1', port, useHttps: true, username: 'Default User', password: SECRET });

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

async function build(fleet: FleetLike, extra: Partial<RouteDeps> = {}) {
  app = createServer({ accessToken: TOKEN, now: () => Date.parse('2026-09-23T20:00:00Z') });
  await registerControllerRoutes(app, {
    fleet,
    discover: async () => ({ entries: [], notes: [] }),
    readPassport: async () => { throw new Error('not in this test'); },
    now: () => Date.parse('2026-09-23T20:00:00Z'),
    ...extra,
  });
  return app;
}

describe('GET /v0/controllers', () => {
  it('lists every controller with the schema version, and never a credential', async () => {
    await build(fakeFleet([cfg('rw7', 9403), cfg('rw8', 5466)]));
    const res = await app.inject({ method: 'GET', url: '/v0/controllers', headers: LOCAL });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.schemaVersion).toBe('0.15');
    expect(body.observedAt).toBe('2026-09-23T20:00:00.000Z');
    expect(body.controllers.map((c: { id: string }) => c.id)).toEqual(['rw7', 'rw8']);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toMatch(/password|username/i);
  });

  it('shows a never-connected controller as disconnected with no identity yet', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const c = (await app.inject({ method: 'GET', url: '/v0/controllers/rw7', headers: LOCAL })).json();
    expect(c.identity).toBeNull();
    expect(c.link).toMatchObject({ connected: false, quality: 'disconnected', port: 9403 });
  });

  it('answers 404 NO_CONTROLLER for an unknown id', async () => {
    await build(fakeFleet());
    const res = await app.inject({ method: 'GET', url: '/v0/controllers/nope', headers: LOCAL });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NO_CONTROLLER');
  });
});

describe('POST /v0/controllers', () => {
  const body = { host: '127.0.0.1', port: 9403, useHttps: true, username: 'Default User', password: SECRET, name: 'IRB1600_6_120_1' };

  it('adds a controller with an id derived from its name, and echoes no credential', async () => {
    const fleet = fakeFleet();
    await build(fleet);
    const res = await app.inject({ method: 'POST', url: '/v0/controllers', headers: LOCAL, payload: body });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe('irb1600-6-120-1');
    expect(fleet.all()[0].password).toBe(SECRET);
    expect(res.body).not.toContain(SECRET);
  });

  it('stores the system id from the passport, so the controller can be recognised later', async () => {
    const fleet = fakeFleet();
    await build(fleet);
    const res = await app.inject({ method: 'POST', url: '/v0/controllers', headers: LOCAL,
      payload: { ...body, systemId: '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}' } });
    expect(res.statusCode).toBe(201);
    expect(fleet.all()[0].systemId).toBe('{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}');
  });

  it('refuses the same address twice with 409 ALREADY_ADDED', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'POST', url: '/v0/controllers', headers: LOCAL, payload: body });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ALREADY_ADDED');
  });

  it('allows a different controller on an address saved for another one', async () => {
    // Live 2026-09-23: the old RW7 entry kept 9403 while a NEW RW7 VC took that port.
    const fleet = fakeFleet([{ ...cfg('old-rw7', 9403), systemId: '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}' }]);
    await build(fleet);
    const res = await app.inject({ method: 'POST', url: '/v0/controllers', headers: LOCAL,
      payload: { ...body, name: 'CRB1910_10_1520_1', systemId: '{D9E18C83-4414-4695-8B1B-F2D518D8DE89}' } });
    expect(res.statusCode).toBe(201);
    expect(fleet.all()).toHaveLength(2);
  });

  it('refuses the same system twice, whatever its address', async () => {
    const fleet = fakeFleet([{ ...cfg('rw7', 9403), systemId: '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}' }]);
    await build(fleet);
    const res = await app.inject({ method: 'POST', url: '/v0/controllers', headers: LOCAL,
      payload: { ...body, port: 9999, systemId: 'a3be1993-3fa0-4d46-93ff-7fa2d8086c81' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ALREADY_ADDED');
  });

  it('rejects a body with a missing field before any code runs', async () => {
    await build(fakeFleet());
    const { password: _omit, ...partial } = body;
    const res = await app.inject({ method: 'POST', url: '/v0/controllers', headers: LOCAL, payload: partial });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /v0/controllers/:id', () => {
  it('removes a controller, and 404s an unknown one', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    expect((await app.inject({ method: 'DELETE', url: '/v0/controllers/rw7', headers: LOCAL })).statusCode).toBe(204);
    expect(fleet.removed).toEqual(['rw7']);
    expect((await app.inject({ method: 'DELETE', url: '/v0/controllers/rw7', headers: LOCAL })).statusCode).toBe(404);
  });
});

describe('POST /v0/setup/discover', () => {
  const DISCOVER = '/v0/setup/discover';
  const answer: DiscoveryAnswer = {
    entries: [{
      host: '127.0.0.1', port: 9403, useHttps: true, generation: 'rws2', generationGuessed: false,
      systemName: 'IRB1600_6_120_5', rwVersion: '7.21.4+417', sources: ['this-pc'], alreadyAdded: null, name: null,
    }],
    notes: ['a note'],
  };
  /** A discover stand-in that records each call; `hold` keeps it running until opened. */
  function recorder(hold?: Promise<void>, fail?: unknown) {
    const calls: Array<{ request: DiscoverRequest; configured: ControllerConfig[]; signal: AbortSignal }> = [];
    const discover: RouteDeps['discover'] = async (request, configured, signal) => {
      calls.push({ request, configured, signal });
      if (hold) { await hold; }
      if (fail) { throw fail; }
      return answer;
    };
    return { calls, discover };
  }
  /** The client's refusal of an input, with the field, value and cap it names. */
  const refusal = (field: string, value: string, limit?: number | string) => Object.assign(
    new RwsError(`findControllers: ${field}: is refused (got ${value}). Nothing was sent.`, 'INVALID_ARGUMENT'),
    { field, value, ...(limit !== undefined ? { limit } : {}) },
  );

  it('passes the whole request, the fleet and a live signal through, and answers the entries and notes', async () => {
    const r = recorder();
    await build(fakeFleet([cfg('rw7', 9403)]), { discover: r.discover });
    const payload = {
      hosts: ['192.0.2.5'], manual: [{ host: 'cell-7', port: 5466, https: true }], ranges: ['10.0.5.0/28'],
      ports: [8443], serviceAddress: false, mdns: false,
    };
    const res = await app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(answer);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].request).toEqual(payload);
    expect(r.calls[0].configured.map(c => c.id)).toEqual(['rw7']);
    expect(r.calls[0].signal.aborted).toBe(false);
  });

  it('an empty body is a scan of this PC with the defaults', async () => {
    const r = recorder();
    await build(fakeFleet(), { discover: r.discover });
    expect((await app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL, payload: {} })).statusCode).toBe(200);
    expect(r.calls[0].request).toEqual({});
  });

  it('accepts ranges now, as ranges - hosts stay host names - and holds every list to its cap', async () => {
    const r = recorder();
    await build(fakeFleet(), { discover: r.discover, now: (() => { let t = 0; return () => (t += 60_000); })() });
    const post = (payload: object) => app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL, payload });
    expect((await post({ ranges: ['10.0.0.0/24'] })).statusCode).toBe(200);
    expect((await post({ ranges: ['10.0.5.20-10.0.5.60'] })).statusCode).toBe(200);
    expect(r.calls.map(c => c.request.ranges)).toEqual([['10.0.0.0/24'], ['10.0.5.20-10.0.5.60']]);

    const n = (k: number, f: (i: number) => unknown) => Array.from({ length: k }, (_, i) => f(i));
    for (const bad of [
      { hosts: ['10.0.0.0/24'] },                                   // a range is not a host name
      { hosts: n(17, i => `10.0.0.${i + 1}`) },
      { manual: n(17, i => ({ host: `10.0.0.${i + 1}` })) },
      { ranges: n(17, i => `10.0.${i}.0/30`) },
      { ranges: [''] },
      { ranges: ['1'.repeat(65)] },
      { ports: n(9, i => 8000 + i) },
      { ports: [0] },
      { manual: [{ port: 443 }] },
      { manual: [{ host: 'bad host' }] },
    ]) {
      const res = await post(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(r.calls).toHaveLength(2);
  });

  it('answers the client`s refusal as a 400 naming the field, value and cap; a host is named as sent', async () => {
    const ranges = recorder(undefined, refusal('ranges[0]', '"10.0.0.0/16"', 256));
    await build(fakeFleet(), { discover: ranges.discover });
    const res = await app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL, payload: { ranges: ['10.0.0.0/16'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'ranges[0]: is refused (got "10.0.0.0/16"). Nothing was sent.',
      code: 'INVALID_ARGUMENT', field: 'ranges[0]', value: '"10.0.0.0/16"', limit: 256,
    });
    await app.close();

    // The client sees `hosts` after `manual`: its manual[2] is the caller's hosts[1].
    const host = recorder(undefined, refusal('manual[2].host', '"::1"'));
    await build(fakeFleet(), { discover: host.discover });
    const res2 = await app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL,
      payload: { manual: [{ host: '192.0.2.1' }], hosts: ['192.0.2.2', 'cell-7'] } });
    expect(res2.statusCode).toBe(400);
    expect(res2.json()).toMatchObject({ code: 'INVALID_ARGUMENT', field: 'hosts[1].host', error: 'hosts[1].host: is refused (got "::1"). Nothing was sent.' });
    expect(res2.json()).not.toHaveProperty('limit');
  });

  it('caps manual and hosts together as the client does, and names both fields', async () => {
    const r = recorder();
    await build(fakeFleet(), { discover: r.discover });
    const post = (payload: object) => app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL, payload });
    const n = (k: number, f: (i: number) => unknown) => Array.from({ length: k }, (_, i) => f(i));
    const res = await post({ manual: [{ host: '192.0.2.1' }], hosts: n(16, i => `198.51.100.${i + 1}`) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'manual, hosts: at most 16 entries together (got 17). Nothing was sent.',
      code: 'INVALID_ARGUMENT', field: 'manual, hosts', value: '17', limit: 16,
    });
    expect(r.calls).toHaveLength(0);
    // 16 together is allowed.
    expect((await post({ manual: n(6, i => ({ host: `192.0.2.${i + 1}` })), hosts: n(10, i => `198.51.100.${i + 1}`) })).statusCode).toBe(200);
    expect(r.calls).toHaveLength(1);
  });

  it('a failure of the daemon`s own is not mistaken for bad input', async () => {
    const r = recorder(undefined, new Error('boom'));
    await build(fakeFleet(), { discover: r.discover });
    const res = await app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL, payload: {} });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('DAEMON_ERROR');
  });

  it('runs one discovery at a time: a second request while one runs is answered 409 DISCOVERY_RUNNING', async () => {
    let open!: () => void;
    const r = recorder(new Promise<void>(res => { open = res; }));
    await build(fakeFleet(), { discover: r.discover });
    const first = app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL, payload: {} });
    for (let i = 0; i < 200 && r.calls.length === 0; i++) { await new Promise(res => setTimeout(res, 5)); }
    const second = await app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL, payload: { hosts: ['192.0.2.9'] } });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'a discovery is already running; ask again when it has finished', code: 'DISCOVERY_RUNNING' });
    open();
    expect((await first).statusCode).toBe(200);
    expect(r.calls).toHaveLength(1);
    // Once it has finished, the next one runs.
    expect((await app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL, payload: {} })).statusCode).toBe(200);
    expect(r.calls).toHaveLength(2);
  });

  it('a run with ranges within 30 s of the previous range run`s end is answered 429 DISCOVERY_LIMIT with a Retry-After', async () => {
    let t = Date.parse('2026-10-03T12:00:00Z');
    const r = recorder();
    await build(fakeFleet(), { discover: r.discover, now: () => t });
    const post = (payload: object) => app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL, payload });
    expect((await post({ ranges: ['10.0.6.0/28'] })).statusCode).toBe(200);

    t += 10_500;
    const early = await post({ ranges: ['10.0.7.0/28'] });
    expect(early.statusCode).toBe(429);
    expect(early.headers['retry-after']).toBe('20');
    expect(early.json()).toEqual({ error: 'a range scan ended less than 30 s ago; try again in 20 s', code: 'DISCOVERY_LIMIT' });
    // A scan without ranges is not held back.
    expect((await post({ hosts: ['192.0.2.7'] })).statusCode).toBe(200);
    expect(r.calls).toHaveLength(2);

    t += 19_500;
    expect((await post({ ranges: ['10.0.7.0/28'] })).statusCode).toBe(200);
    expect(r.calls).toHaveLength(3);
  });

  it('a range run refused as bad input sent nothing, so it starts no 30 s wait', async () => {
    let calls = 0;
    const t = Date.parse('2026-10-03T12:00:00Z');
    await build(fakeFleet(), {
      now: () => t,
      discover: async request => {
        calls++;
        if (request.ranges?.[0] === '198.51.100.0/24') { throw refusal('ranges[0]', '"198.51.100.0/24"'); }
        return answer;
      },
    });
    const post = (payload: object) => app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL, payload });
    expect((await post({ ranges: ['198.51.100.0/24'] })).statusCode).toBe(400);
    expect((await post({ ranges: ['10.0.6.0/28'] })).statusCode).toBe(200);
    expect((await post({ ranges: ['10.0.6.0/28'] })).statusCode).toBe(429);
    expect(calls).toBe(2);
  });

  it('a caller that hangs up cancels the run', async () => {
    let seen: AbortSignal | null = null;
    let finished!: () => void;
    const ended = new Promise<void>(res => { finished = res; });
    app = createServer({ accessToken: TOKEN });
    await registerControllerRoutes(app, {
      fleet: fakeFleet(), readPassport: async () => { throw new Error('not in this test'); },
      discover: async (_request, _configured, signal) => {
        seen = signal;
        await new Promise<void>(res => { if (signal.aborted) { res(); } else { signal.addEventListener('abort', () => res(), { once: true }); } });
        finished();
        return { entries: [], notes: [] };
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const body = JSON.stringify({ hosts: ['192.0.2.5'] });
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: DISCOVER,
      headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.end(body);
    for (let i = 0; i < 400 && !seen; i++) { await new Promise(res => setTimeout(res, 5)); }
    expect(seen).not.toBeNull();
    expect(seen!.aborted).toBe(false);
    req.destroy();
    await ended;
    expect(seen!.aborted).toBe(true);
  });

  it('a run that finishes is never cancelled afterwards', async () => {
    const r = recorder();
    await build(fakeFleet(), { discover: r.discover });
    expect((await app.inject({ method: 'POST', url: DISCOVER, headers: LOCAL, payload: {} })).statusCode).toBe(200);
    expect(r.calls[0].signal.aborted).toBe(false);
  });
});

describe('GET and PUT /v0/setup/discover/saved', () => {
  const SAVED = '/v0/setup/discover/saved';
  function store(fail?: Error): SavedDiscovery & { current: DiscoverySettings; sets: number } {
    const s = {
      current: { manual: [{ host: '192.0.2.10', port: 5466 }], ranges: ['10.0.5.0/28'], ports: [] } as DiscoverySettings,
      sets: 0,
      get: () => s.current,
      set: async (next: DiscoverySettings) => {
        s.sets++;
        if (fail) { throw fail; }
        s.current = next;
        return next;
      },
    };
    return s;
  }

  it('serves what is saved, to pre-fill a scan', async () => {
    const s = store();
    await build(fakeFleet(), { savedDiscovery: s });
    const res = await app.inject({ method: 'GET', url: SAVED, headers: LOCAL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ manual: [{ host: '192.0.2.10', port: 5466 }], ranges: ['10.0.5.0/28'], ports: [] });
  });

  it('saving replaces what was saved (a list left out is emptied) and never starts a scan', async () => {
    const s = store();
    let scans = 0;
    await build(fakeFleet(), { savedDiscovery: s, discover: async () => { scans++; return { entries: [], notes: [] }; } });
    const res = await app.inject({ method: 'PUT', url: SAVED, headers: LOCAL, payload: { ranges: ['10.0.5.20-10.0.5.60'], ports: [8443] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ manual: [], ranges: ['10.0.5.20-10.0.5.60'], ports: [8443] });
    expect(s.current).toEqual({ manual: [], ranges: ['10.0.5.20-10.0.5.60'], ports: [8443] });
    expect(scans).toBe(0);
  });

  it('refuses input over the caps, as a scan does, and saves nothing', async () => {
    const s = store();
    await build(fakeFleet(), { savedDiscovery: s });
    for (const bad of [{ ranges: Array.from({ length: 17 }, (_, i) => `10.0.${i}.0/30`) }, { manual: [{ host: 'bad host' }] }, { ports: [70000] }]) {
      expect((await app.inject({ method: 'PUT', url: SAVED, headers: LOCAL, payload: bad })).statusCode).toBe(400);
    }
    expect(s.sets).toBe(0);
  });

  it('a config that could not be written is answered 503 NOT_SAVED', async () => {
    await build(fakeFleet(), { savedDiscovery: store(new Error('config c.json not saved: it could not be restricted to the current user')) });
    const res = await app.inject({ method: 'PUT', url: SAVED, headers: LOCAL, payload: { ranges: ['10.0.6.0/28'] } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'config c.json not saved: it could not be restricted to the current user', code: 'NOT_SAVED' });
  });

  it('is not served without a store', async () => {
    await build(fakeFleet());
    expect((await app.inject({ method: 'GET', url: SAVED, headers: LOCAL })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: SAVED, headers: LOCAL })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `${SAVED}/ranges?range=10.0.5.0%2F28`, headers: LOCAL })).statusCode).toBe(404);
  });

  it('DELETE clears the saved addresses and ranges and keeps the extra ports', async () => {
    const s = store();
    s.current = { ...s.current, ports: [8443] };
    await build(fakeFleet(), { savedDiscovery: s });
    const res = await app.inject({ method: 'DELETE', url: SAVED, headers: LOCAL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ manual: [], ranges: [], ports: [8443] });
    expect(s.current).toEqual({ manual: [], ranges: [], ports: [8443] });
  });

  it('DELETE of one entry removes it by value, never by position, and answers what is left', async () => {
    const s = store();
    s.current = {
      manual: [{ host: 'cell-7' }, { host: '192.0.2.10', port: 5466 }, { host: '192.0.2.10', port: 5466, https: true }],
      ranges: ['10.0.5.0/28', '10.0.6.0/28'], ports: [8443],
    };
    await build(fakeFleet(), { savedDiscovery: s });
    // Port and scheme must match exactly; the host's letter case does not matter.
    const res = await app.inject({ method: 'DELETE', url: `${SAVED}/manual?host=192.0.2.10&port=5466`, headers: LOCAL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      manual: [{ host: 'cell-7' }, { host: '192.0.2.10', port: 5466, https: true }], ranges: ['10.0.5.0/28', '10.0.6.0/28'], ports: [8443],
    });
    expect((await app.inject({ method: 'DELETE', url: `${SAVED}/manual?host=CELL-7`, headers: LOCAL })).json().manual)
      .toEqual([{ host: '192.0.2.10', port: 5466, https: true }]);
    expect((await app.inject({ method: 'DELETE', url: `${SAVED}/manual?host=192.0.2.10&port=5466&https=true`, headers: LOCAL })).json().manual)
      .toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `${SAVED}/ranges?range=10.0.6.0%2F28`, headers: LOCAL })).json().ranges).toEqual(['10.0.5.0/28']);
    expect((await app.inject({ method: 'DELETE', url: `${SAVED}/ports?port=8443`, headers: LOCAL })).json().ports).toEqual([]);
    expect(s.current).toEqual({ manual: [], ranges: ['10.0.5.0/28'], ports: [] });
  });

  it('DELETE of an entry that is not saved is 404 NO_SAVED_ENTRY and writes nothing', async () => {
    const s = store();
    await build(fakeFleet(), { savedDiscovery: s });
    const res = await app.inject({ method: 'DELETE', url: `${SAVED}/ports?port=8443`, headers: LOCAL });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no saved ports entry equal to 8443', code: 'NO_SAVED_ENTRY' });
    // The saved address has a port: one without a port is another entry.
    const bare = await app.inject({ method: 'DELETE', url: `${SAVED}/manual?host=192.0.2.10`, headers: LOCAL });
    expect(bare.statusCode).toBe(404);
    expect(bare.json()).toEqual({ error: 'no saved manual entry for 192.0.2.10', code: 'NO_SAVED_ENTRY' });
    expect(s.sets).toBe(0);
  });

  it('DELETE refuses an unknown list, a missing value or one that is not valid', async () => {
    const s = store();
    await build(fakeFleet(), { savedDiscovery: s });
    for (const url of [
      `${SAVED}/manual`, `${SAVED}/manual?host=bad%20host`, `${SAVED}/manual?host=x&port=70000`, `${SAVED}/manual?host=x&https=maybe`,
      `${SAVED}/ranges`, `${SAVED}/ranges?range=${'1'.repeat(65)}`, `${SAVED}/ports`, `${SAVED}/ports?port=x`,
    ]) {
      expect((await app.inject({ method: 'DELETE', url, headers: LOCAL })).statusCode, url).toBe(400);
    }
    expect((await app.inject({ method: 'DELETE', url: `${SAVED}/hosts?host=x`, headers: LOCAL })).statusCode).toBe(404);
    expect(s.sets).toBe(0);
  });

  it('two removals sent together apply one after the other, never to the same snapshot', async () => {
    const s = store();
    s.current = { manual: [], ranges: ['10.0.5.0/28', '10.0.6.0/28', '10.0.7.0/28'], ports: [] };
    const setFirst = s.set;
    // A slow save: without ordering, the second removal would read the list before the first one is saved.
    s.set = async next => { await new Promise(r => setTimeout(r, 20)); return setFirst(next); };
    await build(fakeFleet(), { savedDiscovery: s });
    const [a, b] = await Promise.all([
      app.inject({ method: 'DELETE', url: `${SAVED}/ranges?range=10.0.5.0%2F28`, headers: LOCAL }),
      app.inject({ method: 'DELETE', url: `${SAVED}/ranges?range=10.0.6.0%2F28`, headers: LOCAL }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(s.current.ranges).toEqual(['10.0.7.0/28']);
  });

  it('a removal the config could not save is answered 503 NOT_SAVED', async () => {
    await build(fakeFleet(), { savedDiscovery: store(new Error('config c.json not saved: it could not be read (EBUSY)')) });
    const res = await app.inject({ method: 'DELETE', url: `${SAVED}/ranges?range=10.0.5.0%2F28`, headers: LOCAL });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('NOT_SAVED');
  });

  it('a daemon replaying a recording saves nothing: 409 REPLAY_MODE, not a failed write', async () => {
    const s = store(new ReplayModeError());
    await build(fakeFleet(), { savedDiscovery: s });
    for (const [method, url, payload] of [
      ['PUT', SAVED, { ranges: ['10.0.6.0/28'] }], ['DELETE', SAVED, undefined], ['DELETE', `${SAVED}/ranges?range=10.0.5.0%2F28`, undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: LOCAL, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json()).toEqual({ error: 'the daemon is replaying a recording and reaches no controller', code: 'REPLAY_MODE' });
    }
    // The changes run one after another: a refused one does not hold up the next.
    const after = await app.inject({ method: 'GET', url: SAVED, headers: LOCAL });
    expect(after.statusCode).toBe(200);
  });
});

describe('POST /v0/setup/passport', () => {
  it('returns the passport and nothing secret', async () => {
    const passport = { target: { host: '127.0.0.1', port: 9403, useHttps: true } } as Passport;
    await build(fakeFleet(), { readPassport: async () => passport });
    const res = await app.inject({ method: 'POST', url: '/v0/setup/passport', headers: LOCAL,
      payload: { host: '127.0.0.1', port: 9403, useHttps: true, username: 'Default User', password: SECRET } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
  });

  it("a refused login answers with the controller's status and never with the credentials sent", async () => {
    const basic = Buffer.from(`Default User:${SECRET}`).toString('base64');
    await build(fakeFleet(), {
      readPassport: async () => {
        throw new RwsError(`Authentication failed - check username and password (Authorization: Basic ${basic})`,
          'AUTH_FAILED', 401, `WWW-Authenticate: Basic realm="x"\r\nAuthorization: Basic ${basic}`);
      },
    });
    const res = await app.inject({ method: 'POST', url: '/v0/setup/passport', headers: LOCAL,
      payload: { host: '127.0.0.1', port: 9403, useHttps: true, username: 'Default User', password: SECRET } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: 'Authentication failed - check username and password (Authorization: ***',
      code: 'AUTH_FAILED',
      controller: { httpStatus: 401, code: null, message: null },
    });
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(basic);
  });

  it('a body that is not JSON is refused without quoting the credentials in it', async () => {
    await build(fakeFleet());
    const res = await app.inject({ method: 'POST', url: '/v0/setup/passport', headers: { ...LOCAL, 'content-type': 'application/json' },
      payload: `{"host":"127.0.0.1","port":9403,"useHttps":true,"username":"Default User","password":"${SECRET}"` });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
    expect(res.body).not.toContain(SECRET);
  });
});

describe('config file', () => {
  it('round-trips, and treats a missing file as an empty fleet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-cfg-'));
    const path = join(dir, 'c.json');
    expect(await loadConfig(path)).toEqual([]);
    await saveConfig(path, [cfg('rw7', 9403)]);
    expect(await loadConfig(path)).toEqual([cfg('rw7', 9403)]);
  });

  it('never puts the file contents in an error - they hold passwords', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-cfg-'));
    const path = join(dir, 'c.json');
    await writeFile(path, `{"controllers": [{"password": "${SECRET}"`);
    await expect(loadConfig(path)).rejects.toThrow(/not valid JSON/);
    await expect(loadConfig(path)).rejects.not.toThrow(new RegExp(SECRET));
    await writeFile(path, JSON.stringify({ controllers: [{ id: 'x', password: SECRET }] }));
    const err = await loadConfig(path).catch(e => e as Error);
    expect(err.message).not.toContain(SECRET);
    expect(await readFile(path, 'utf8')).toContain(SECRET);   // the file itself is untouched
  });

  it('keeps a system id through a save and load, and rejects a non-string one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-cfg-'));
    const path = join(dir, 'c.json');
    await saveConfig(path, [{ ...cfg('rw7', 9403), systemId: '{A3BE}' }]);
    expect((await loadConfig(path))[0].systemId).toBe('{A3BE}');
    await writeFile(path, JSON.stringify({ controllers: [{ ...cfg('rw7', 9403), systemId: 42 }] }));
    await expect(loadConfig(path)).rejects.toThrow(/systemId/);
  });

  it('derives unique ids from system names', () => {
    expect(idFromName('IRB1600_6_120_1', new Set())).toBe('irb1600-6-120-1');
    expect(idFromName('IRB1600_6_120_1', new Set(['irb1600-6-120-1']))).toBe('irb1600-6-120-1-2');
  });
});

describe('GET /v0/controllers/:id/rapid/tasks/:task/modules/:module', () => {
  const url = (id: string, task: string, module: string) => `/v0/controllers/${id}/rapid/tasks/${task}/modules/${module}`;

  it('returns the module source with its kind and change count', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: url('rw7', 'T_ROB1', 'MainModule'), headers: LOCAL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ task: 'T_ROB1', module: 'MainModule', kind: 'program', text: 'MODULE X\nENDMODULE', changeCount: 3 });
  });

  it('404 NO_CONTROLLER for an unknown controller', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: url('nope', 'T_ROB1', 'MainModule'), headers: LOCAL });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NO_CONTROLLER');
  });

  it("passes the controller's refusal through with its code", async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: url('rw7', 'T_ROB1', 'Missing'), headers: LOCAL });
    expect(res.json().code).toBe('MODULE_NOT_FOUND');
    expect(res.statusCode).toBe(404);
  });

  it("keeps the controller's evidence and the client's refusal, and nothing secret", async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: url('rw7', 'T_ROB1', 'Held'), headers: LOCAL });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Write access is held by another control station: 403 - release it there, then retry',
      code: 'MASTERSHIP_REQUIRED',
      controller: { httpStatus: 403, code: -1073435870, message: 'held by another station' },
      refusal: { kind: 'held-by-other', grantor: 'current-holder', holder: { kind: 'remote', name: 'RobotStudio' } },
    });
    for (const leak of [SECRET, STATION, 'raw', 'Basic', 'authorization']) { expect(res.body).not.toContain(leak); }
  });

  it('429 READ_LIMIT with a Retry-After when the controller`s read budget has no room', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const busy = await app.inject({ method: 'GET', url: url('rw7', 'T_ROB1', 'Busy'), headers: LOCAL });
    expect(busy.statusCode).toBe(429);
    expect(busy.headers['retry-after']).toBe('1');
    expect(busy.json()).toEqual({
      error: '"rw7" already has 2 on-demand reads in flight, the most it takes at a time; try again in 1 s',
      code: 'READ_LIMIT',
    });
    const slow = await app.inject({ method: 'GET', url: url('rw7', 'T_ROB1', 'Slow'), headers: LOCAL });
    expect(slow.statusCode).toBe(429);
    expect(slow.headers['retry-after']).toBe('3');
    expect(slow.json()).toEqual({
      error: 'on-demand reads of "rw7" are over their rate (about 2 controller requests a second); try again in 3 s',
      code: 'READ_LIMIT',
    });
  });

  it('refuses a task or module name that is not a RAPID identifier', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    for (const bad of [url('rw7', 'T_ROB1', '..%2Fx'), url('rw7', '1BAD', 'MainModule'), url('rw7', 'T_ROB1', 'A'.repeat(40))]) {
      const res = await app.inject({ method: 'GET', url: bad, headers: LOCAL });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('GET /v0/controllers/:id/rapid/tasks/:task/modules/:module/symbols/:symbol', () => {
  const url = (id: string, symbol: string, task = 'T_ROB1', module = 'MainModule') =>
    `/v0/controllers/${id}/rapid/tasks/${task}/modules/${module}/symbols/${symbol}`;

  it('returns the value as the controller wrote it, with the resource it was read from and when', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: url('rw7', 'partPresent'), headers: LOCAL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      task: 'T_ROB1', module: 'MainModule', symbol: 'partPresent', value: '"a ""b"""', truncated: false,
      resource: '/rw/rapid/symbol/RAPID/{task}/{module}/{symbol}/data', readAt: '2026-09-23T19:59:58.000Z',
    });
  });

  it('404 NO_CONTROLLER for an unknown controller', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: url('nope', 'partPresent'), headers: LOCAL });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NO_CONTROLLER');
  });

  it('a symbol the controller does not find: 404 with the controller`s own code, and nothing raw', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: url('rw7', 'gone'), headers: LOCAL });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      controller: { httpStatus: 404, code: -1073442816, message: 'Symbol not found' },
    });
    expect(res.body).not.toContain('<html>');
  });

  it('502 VALUE_NOT_READ when the controller answered with no value text: no value field at all', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: url('rw7', 'bigArray'), headers: LOCAL });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: 'the controller answered the read of T_ROB1/MainModule/bigArray with no value'
        + ' (it does so for an array over its read limit, and for a type with no printable value)',
      code: 'VALUE_NOT_READ',
    });
  });

  it('429 READ_LIMIT with a Retry-After when the controller`s read budget has no room', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: url('rw7', 'busy'), headers: LOCAL });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.json().code).toBe('READ_LIMIT');
  });

  it('refuses a task, module or symbol name that is not a RAPID identifier, before asking the fleet', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    let asked = 0;
    await build({ ...fleet, rapidSymbol: async (...a) => { asked++; return fleet.rapidSymbol(...a); } });
    for (const bad of [
      url('rw7', 'reg1%7B2%7D'), url('rw7', '..%2Fx'), url('rw7', '1st'), url('rw7', 'A'.repeat(33)),
      url('rw7', 'reg1', 'T_ROB1', 'Main%2FModule'), url('rw7', 'reg1', 'T ROB1'),
    ]) {
      const res = await app.inject({ method: 'GET', url: bad, headers: LOCAL });
      expect(res.statusCode, bad).toBe(400);
    }
    expect(asked).toBe(0);
    const longest = await app.inject({ method: 'GET', url: url('rw7', 'A'.repeat(32)), headers: LOCAL });
    expect(longest.statusCode).toBe(200);
  });

  it('409 IDENTITY_MISMATCH: no value is read from a stranger on the saved port', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    let asked = false;
    await build({
      ...fleet,
      get: id => {
        const s = fleet.get(id);
        return s && { ...s, link: { ...s.link, identityCheck: { status: 'mismatch', expected: '{A}', actual: '{B}' } } };
      },
      rapidSymbol: async (...a) => { asked = true; return fleet.rapidSymbol(...a); },
    });
    const res = await app.inject({ method: 'GET', url: url('rw7', 'partPresent'), headers: LOCAL });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('IDENTITY_MISMATCH');
    expect(asked).toBe(false);
  });

  it('needs the access token like every route but health', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: url('rw7', 'partPresent'), headers: { host: LOCAL.host } });
    expect(res.statusCode).toBe(401);
  });
});

describe('module source from the wrong controller', () => {
  it('409 IDENTITY_MISMATCH: no program is read from a stranger on the saved port', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    let asked = false;
    const mismatched: FleetLike = {
      ...fleet,
      get: id => {
        const s = fleet.get(id);
        return s && { ...s, link: { ...s.link, identityCheck: { status: 'mismatch', expected: '{A}', actual: '{B}' } } };
      },
      moduleSource: async (...a) => { asked = true; return fleet.moduleSource(...a); },
    };
    await build(mismatched);
    const res = await app.inject({ method: 'GET', url: '/v0/controllers/rw7/rapid/tasks/T_ROB1/modules/MainModule', headers: LOCAL });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('IDENTITY_MISMATCH');
    expect(asked).toBe(false);
  });
});

describe('GET /v0/controllers/:id/events', () => {
  const get = (url: string) => app.inject({ method: 'GET', url, headers: LOCAL });

  it('without since: the newest events, EVENTS_PAGE_DEFAULT at most', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    const res = await get('/v0/controllers/rw7/events');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ feed: 'feed-1', firstSeq: 1, lastSeq: 30, gap: false, more: false });
    expect(body.events).toHaveLength(30);
    expect(body.events[0]).toMatchObject({
      seq: 1, seqnum: 1, code: 10011, severity: 'info', title: 'Motors ON state', titleFromCode: false, source: 'MC0',
      time: { raw: '2026-09-23 T 19:59:00', utc: '2026-09-23T19:59:00.000Z', corrected: true },
      receivedAt: '2026-09-23T20:00:00.000Z', backlog: true,
    });
    expect(fleet.eventsAsked).toEqual([{ since: undefined, limit: 50 }]);
  });

  it('with since and limit: the events after since, a page at a time', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    const body = (await get('/v0/controllers/rw7/events?since=20&limit=4')).json();
    expect(body.events.map((e: { seq: number }) => e.seq)).toEqual([21, 22, 23, 24]);
    expect(body.more).toBe(true);
    expect(fleet.eventsAsked).toEqual([{ since: 20, limit: 4 }]);
  });

  it('400 for a since or limit that is no whole number in range; nothing is asked of the fleet', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    for (const q of ['since=-1', 'since=abc', 'limit=0', 'limit=257', 'limit=2.5']) {
      const res = await get(`/v0/controllers/rw7/events?${q}`);
      expect(res.statusCode, q).toBe(400);
    }
    expect(fleet.eventsAsked).toEqual([]);
  });

  it('404 NO_CONTROLLER for an unknown controller', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await get('/v0/controllers/nope/events');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NO_CONTROLLER');
  });

  it('409 IDENTITY_MISMATCH while the link is on another controller', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    const mismatched: FleetLike = {
      ...fleet,
      get: id => {
        const s = fleet.get(id);
        return s && { ...s, link: { ...s.link, identityCheck: { status: 'mismatch', expected: '{A}', actual: '{B}' } } };
      },
    };
    await build(mismatched);
    const res = await get('/v0/controllers/rw7/events');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('IDENTITY_MISMATCH');
    expect(fleet.eventsAsked).toEqual([]);
  });

  it('the snapshot carries an events group, empty until the log has been read', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const c = (await get('/v0/controllers/rw7')).json();
    expect(c.events).toEqual({
      feed: null, lastSeq: 0, recent: [], via: null, clock: { offsetMs: null, measuredAt: null, problem: null }, asOf: null, error: null,
    });
  });
});

describe('POST /v0/controllers/:id/motion/watch', () => {
  it('starts or renews the lease and says how long it lasts and at what rate', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    const res = await app.inject({ method: 'POST', url: '/v0/controllers/rw7/motion/watch', headers: LOCAL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ leaseMs: 15000, targetHz: 8 });
    // a renewal, this time from a client that always sends a JSON body
    const renew = await app.inject({ method: 'POST', url: '/v0/controllers/rw7/motion/watch', headers: LOCAL, payload: {} });
    expect(renew.statusCode).toBe(200);
    expect(fleet.watched).toEqual(['rw7', 'rw7']);
  });

  it('404 NO_CONTROLLER for an unknown controller', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'POST', url: '/v0/controllers/nope/motion/watch', headers: LOCAL });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NO_CONTROLLER');
  });

  it('409 IDENTITY_MISMATCH: never samples a stranger on the saved port', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    const mismatched: FleetLike = {
      ...fleet,
      get: id => {
        const s = fleet.get(id);
        return s && { ...s, link: { ...s.link, identityCheck: { status: 'mismatch', expected: '{A}', actual: '{B}' } } };
      },
    };
    await build(mismatched);
    const res = await app.inject({ method: 'POST', url: '/v0/controllers/rw7/motion/watch', headers: LOCAL });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('IDENTITY_MISMATCH');
    expect(fleet.watched).toEqual([]);
  });

  it('is refused from a cross-site page like every other route', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'POST', url: '/v0/controllers/rw7/motion/watch',
      headers: { ...LOCAL, origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
  });

  it('a request with no lease id - no body, an empty one, or a body that is no JSON object - renews the anonymous lease', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    const url = '/v0/controllers/rw7/motion/watch';
    for (const extra of [{}, { payload: {} }, { payload: 'null', headers: { ...LOCAL, 'content-type': 'application/json' } }]) {
      const res = await app.inject({ method: 'POST', url, headers: LOCAL, ...extra });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ leaseMs: 15000, targetHz: 8 });
    }
    expect(fleet.leaseIds).toEqual([undefined, undefined, undefined]);
  });

  it('passes a lease id through, and answers with the lease`s id', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    const url = '/v0/controllers/rw7/motion/watch';
    const opened = await app.inject({ method: 'POST', url, headers: LOCAL, payload: { leaseId: 'new' } });
    expect(opened.json()).toEqual({ leaseMs: 15000, targetHz: 8, leaseId: 'minted-1' });
    const renewed = await app.inject({ method: 'POST', url, headers: LOCAL, payload: { leaseId: 'minted-1' } });
    expect(renewed.json()).toEqual({ leaseMs: 15000, targetHz: 8, leaseId: 'minted-1' });
    expect(fleet.leaseIds).toEqual(['new', 'minted-1']);
  });

  it('refuses a lease id that is not one, before the fleet sees it', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    for (const leaseId of ['', 'a b', '../x', 'x'.repeat(65)]) {
      const res = await app.inject({ method: 'POST', url: '/v0/controllers/rw7/motion/watch', headers: LOCAL, payload: { leaseId } });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
    }
    expect(fleet.leaseIds).toEqual([]);
  });

  it('429 LEASE_LIMIT with a Retry-After when the controller holds as many leases as it may', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    fleet.leasesFull.value = true;
    await build(fleet);
    const res = await app.inject({ method: 'POST', url: '/v0/controllers/rw7/motion/watch', headers: LOCAL, payload: { leaseId: 'new' } });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('LEASE_LIMIT');
    expect(Number(res.headers['retry-after'])).toBe(15);
    expect(fleet.watched).toEqual([]);
  });
});

describe('a never-watched controller', () => {
  it('shows motion idle, with no values', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const c = (await app.inject({ method: 'GET', url: '/v0/controllers/rw7', headers: LOCAL })).json();
    expect(c.motion).toEqual({ watching: false, units: [], rate: { targetHz: null, achievedHz: null, via: null }, asOf: null });
  });

  it('shows io idle, with no signals', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const c = (await app.inject({ method: 'GET', url: '/v0/controllers/rw7', headers: LOCAL })).json();
    expect(c.io).toEqual({ watching: false, signals: [], asOf: null });
  });
});

describe('POST /v0/controllers/:id/io/watch', () => {
  it('starts or renews the lease over the named signals and reports the cap by name', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    const res = await app.inject({ method: 'POST', url: '/v0/controllers/rw7/io/watch', headers: LOCAL,
      payload: { signals: ['do_a', 'di_b'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ leaseMs: 15000, accepted: ['do_a', 'di_b'], rejected: [] });
    expect(fleet.ioWatched).toEqual([['do_a', 'di_b']]);
  });

  it('requires a signals array', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'POST', url: '/v0/controllers/rw7/io/watch', headers: LOCAL, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('404 NO_CONTROLLER for an unknown controller', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'POST', url: '/v0/controllers/nope/io/watch', headers: LOCAL,
      payload: { signals: ['do_a'] } });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NO_CONTROLLER');
  });

  it('409 IDENTITY_MISMATCH: never watches a stranger on the saved port', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    const mismatched: FleetLike = {
      ...fleet,
      get: id => {
        const s = fleet.get(id);
        return s && { ...s, link: { ...s.link, identityCheck: { status: 'mismatch', expected: '{A}', actual: '{B}' } } };
      },
    };
    await build(mismatched);
    const res = await app.inject({ method: 'POST', url: '/v0/controllers/rw7/io/watch', headers: LOCAL,
      payload: { signals: ['do_a'] } });
    expect(res.statusCode).toBe(409);
    expect(fleet.ioWatched).toEqual([]);
  });

  it('without a lease id: the anonymous lease, and no lease id in the answer', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    const res = await app.inject({ method: 'POST', url: '/v0/controllers/rw7/io/watch', headers: LOCAL, payload: { signals: ['do_a'] } });
    expect(res.json()).toEqual({ leaseMs: 15000, accepted: ['do_a'], rejected: [] });
    expect(fleet.leaseIds).toEqual([undefined]);
  });

  it('passes a lease id through, and answers with the lease`s id', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    const url = '/v0/controllers/rw7/io/watch';
    const opened = await app.inject({ method: 'POST', url, headers: LOCAL, payload: { signals: ['do_a'], leaseId: 'new' } });
    expect(opened.json()).toEqual({ leaseMs: 15000, accepted: ['do_a'], rejected: [], leaseId: 'minted-1' });
    const renewed = await app.inject({ method: 'POST', url, headers: LOCAL, payload: { signals: ['do_a', 'di_b'], leaseId: 'minted-1' } });
    expect(renewed.json()).toMatchObject({ accepted: ['do_a', 'di_b'], leaseId: 'minted-1' });
    expect(fleet.leaseIds).toEqual(['new', 'minted-1']);
  });

  it('refuses a lease id that is not one, before the fleet sees it', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    for (const leaseId of ['', 'a&b=1', '../x', 'x'.repeat(65)]) {
      const res = await app.inject({ method: 'POST', url: '/v0/controllers/rw7/io/watch', headers: LOCAL, payload: { signals: ['do_a'], leaseId } });
      expect(res.statusCode).toBe(400);
    }
    expect(fleet.leaseIds).toEqual([]);
  });

  it('429 LEASE_LIMIT with a Retry-After when the controller holds as many leases as it may', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    fleet.leasesFull.value = true;
    await build(fleet);
    const res = await app.inject({ method: 'POST', url: '/v0/controllers/rw7/io/watch', headers: LOCAL,
      payload: { signals: ['do_a'], leaseId: 'new' } });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      error: '"rw7" already holds 32 I/O watch leases with an id; one frees when it is not renewed',
      code: 'LEASE_LIMIT',
    });
    expect(Number(res.headers['retry-after'])).toBe(15);
    expect(fleet.ioWatched).toEqual([]);
  });
});

describe('GET /v0/controllers/:id/io/signals', () => {
  it('serves the signal table, values flattened, criteria forwarded', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    const res = await app.inject({ method: 'GET', url: '/v0/controllers/rw7/io/signals?type=DO&name=do', headers: LOCAL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signals: [{ name: 'do_test', type: 'DO', value: '1' }] });
    expect(fleet.ioSearched).toEqual([{ type: 'DO', name: 'do' }]);
  });

  it('404 NO_CONTROLLER for an unknown controller', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: '/v0/controllers/nope/io/signals', headers: LOCAL });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NO_CONTROLLER');
  });

  it('503 NOT_READY with a Retry-After while the table is not read on the current connection, never 200 []', async () => {
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    fleet.ioTable.loaded = false;
    await build(fleet);
    const res = await app.inject({ method: 'GET', url: '/v0/controllers/rw7/io/signals', headers: LOCAL });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('NOT_READY');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    const unknown = await app.inject({ method: 'GET', url: '/v0/controllers/nope/io/signals', headers: LOCAL });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('NO_CONTROLLER');
    fleet.ioTable.loaded = true;
    const later = await app.inject({ method: 'GET', url: '/v0/controllers/rw7/io/signals', headers: LOCAL });
    expect(later.statusCode).toBe(200);
  });

  it("a failed search answers with the controller's status, code and message", async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: '/v0/controllers/rw7/io/signals?name=boom', headers: LOCAL });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'Resource does not exist on the controller: 404',
      code: 'RESOURCE_NOT_FOUND',
      controller: { httpStatus: 404, code: -1073445862, message: 'Signal not found' },
    });
    expect(res.body).not.toContain('<html>');
  });

  it('429 READ_LIMIT with a Retry-After when a search finds the read budget used up', async () => {
    await build(fakeFleet([cfg('rw7', 9403)]));
    const res = await app.inject({ method: 'GET', url: '/v0/controllers/rw7/io/signals?name=flood', headers: LOCAL });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.json().code).toBe('READ_LIMIT');
  });

  it('strips an unknown criterion rather than forwarding it', async () => {
    // Fastify's additionalProperties:false REMOVES unknown query keys; what
    // matters is that nothing unexpected reaches the controller search.
    const fleet = fakeFleet([cfg('rw7', 9403)]);
    await build(fleet);
    const res = await app.inject({ method: 'GET', url: '/v0/controllers/rw7/io/signals?password=x&type=DO', headers: LOCAL });
    expect(res.statusCode).toBe(200);
    expect(fleet.ioSearched).toEqual([{ type: 'DO' }]);
  });
});

describe('the access token on every route', () => {
  it('every route the daemon serves but health refuses a request without it, the stream included', async () => {
    app = createServer({ accessToken: TOKEN });
    const routes: Array<{ method: string; url: string }> = [];
    app.addHook('onRoute', r => {
      for (const method of [r.method].flat()) { routes.push({ method, url: r.url }); }
    });
    await registerControllerRoutes(app, {
      fleet: fakeFleet([cfg('rw7', 9403)]), discover: async () => ({ entries: [], notes: [] }), readPassport: async () => { throw new Error('not in this test'); },
      savedDiscovery: { get: () => ({ manual: [], ranges: [], ports: [] }), set: async s => s },
    });
    await registerStreamRoute(app, new SnapshotStream({ list: () => [], get: () => null, onChanged() {} }, new SocketHub({ heartbeatMs: 0 })));
    await app.ready();

    const served = routes.filter(r => r.url.startsWith('/v0/'));
    // Everything registerControllerRoutes and the stream serve, each method once, HEAD twins included.
    expect(served.filter(r => r.method !== 'HEAD').length).toBeGreaterThanOrEqual(11);
    for (const { method, url } of served) {
      const path = url.replace(/:([a-z]+)/g, (_m, p: string) => (p === 'id' ? 'rw7' : 'x'));
      const bare = await app.inject({ method: method as 'GET', url: path, headers: { host: '127.0.0.1:7810' } });
      const held = await app.inject({ method: method as 'GET', url: path, headers: LOCAL });
      expect(bare.statusCode, `${method} ${url}`).toBe(401);
      if (method !== 'HEAD') { expect(bare.json().code, `${method} ${url}`).toBe('TOKEN_MISSING'); }
      expect(held.statusCode, `${method} ${url} with the token`).not.toBe(401);
    }
    // Health, which createServer registers before any hook here could see it, stays open.
    expect((await app.inject({ method: 'GET', url: '/v0/health', headers: { host: '127.0.0.1:7810' } })).statusCode).toBe(200);
  });
});

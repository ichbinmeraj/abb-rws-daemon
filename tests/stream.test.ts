import { describe, it, expect, vi, afterEach } from 'vitest';
import { SnapshotStream, type StreamSource } from '../src/stream.js';
import { SocketHub } from '../src/wsHub.js';
import net, { type AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { STREAM_PROTOCOL, TOKEN_HEADER, TOKEN_PROTOCOL_PREFIX, type ControllerSnapshot, type EventsGroup } from '../src/schema/v0.js';
import { FakeSocket } from './wsHub.test.js';

// Every test here stands up a real Fastify server and does a real WebSocket
// upgrade; the first in the file also pays the dynamic-import + ready cost, which
// is legitimately slow (~4.6s observed). Keep this file clear of the 5s default so
// full-suite load cannot flake it. Scoped here; fast unit tests keep the strict default.
vi.setConfig({ testTimeout: 15000 });

/** The daemon's access token in these tests, and the upgrade headers of a native consumer that holds it. */
const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const LOCAL = { host: '127.0.0.1:7810', [TOKEN_HEADER]: TOKEN };

function snap(id: string, over: { quality?: string; speed?: number; asOf?: string | null; j1?: number } = {}): ControllerSnapshot {
  return {
    id, name: id.toUpperCase(), identity: null,
    link: {
      connected: true, quality: (over.quality ?? 'live') as ControllerSnapshot['link']['quality'],
      qualityReason: 'x', since: '2026-09-23T20:00:00.000Z', host: '127.0.0.1', port: 1, useHttps: true,
      subscriptions: { active: true }, identityCheck: { status: 'confirmed', expected: 'a', actual: 'a' }, reconnect: null,
    },
    panel: { ctrlState: 'motoron', opMode: 'AUTO', speedRatio: over.speed ?? 100, collisionDetection: null,
      asOf: over.asOf === undefined ? '2026-09-23T20:00:00.000Z' : over.asOf },
    rapid: { execState: null, cycle: null, tasks: [], asOf: null },
    motion: {
      watching: over.j1 !== undefined,
      units: over.j1 === undefined ? [] : [{ name: 'ROB_1', kind: 'robot', typeRaw: 'TCPRobot', task: 'T_ROB1',
        joints: [{ name: 'J1', value: over.j1, unit: 'deg', min: null, max: null }], pose: null, error: null }],
      rate: { targetHz: over.j1 === undefined ? null : 8, achievedHz: null, via: over.j1 === undefined ? null : 'poll' },
      asOf: over.j1 === undefined ? null : over.asOf ?? null,
    },
  };
}

/** A fleet stand-in whose controllers the test edits, then announces. */
function makeSource(initial: ControllerSnapshot[]) {
  const map = new Map(initial.map(c => [c.id, c]));
  let handler: (id: string) => void = () => {};
  const source: StreamSource & { set(c: ControllerSnapshot): void; drop(id: string): void } = {
    list: () => [...map.values()],
    get: id => map.get(id) ?? null,
    onChanged: cb => { handler = cb; },
    set: c => { map.set(c.id, c); handler(c.id); },
    drop: id => { map.delete(id); handler(id); },
  };
  return source;
}

afterEach(() => { vi.useRealTimers(); });

function setup(initial = [snap('rw6')]) {
  vi.useFakeTimers();
  const source = makeSource(initial);
  const stream = new SnapshotStream(source, new SocketHub({ heartbeatMs: 0 }), { debounceMs: 250 });
  const sock = new FakeSocket();
  stream.attach(sock);
  return { source, stream, sock };
}

describe('SnapshotStream', () => {
  it('opens with a full snapshot', () => {
    const { sock } = setup([snap('rw6'), snap('rw8')]);
    const [first] = sock.frames();
    expect(first.type).toBe('snapshot');
    expect(first.schemaVersion).toBe('0.15');
    expect((first.controllers as unknown[]).length).toBe(2);
  });

  it('sends a link change immediately, carrying only the link group', async () => {
    const { source, sock } = setup();
    source.set(snap('rw6'));                       // first change: establishes what was sent
    await vi.advanceTimersByTimeAsync(300);
    sock.sent.length = 0;

    source.set(snap('rw6', { quality: 'reconnecting' }));
    const frames = sock.frames();                  // no timer advanced
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'delta', id: 'rw6' });
    expect(Object.keys(frames[0].groups as object)).toEqual(['link']);
  });

  it('sends every link transition, even back-to-back ones', async () => {
    const { source, sock } = setup();
    source.set(snap('rw6'));
    await vi.advanceTimersByTimeAsync(300);
    sock.sent.length = 0;

    source.set(snap('rw6', { quality: 'reconnecting' }));
    source.set(snap('rw6', { quality: 'live' }));
    const qualities = sock.frames().map(f => (f.groups as { link: { quality: string } }).link.quality);
    expect(qualities).toEqual(['reconnecting', 'live']);
  });

  it('coalesces value changes inside the window and sends the latest', async () => {
    const { source, sock } = setup();
    source.set(snap('rw6'));                       // first frame goes out at t=0
    await vi.advanceTimersByTimeAsync(50);         // still inside its window
    sock.sent.length = 0;

    source.set(snap('rw6', { speed: 50 }));
    source.set(snap('rw6', { speed: 25 }));
    expect(sock.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(210);        // t=260: the window has closed
    const frames = sock.frames();
    expect(frames).toHaveLength(1);
    expect((frames[0].groups as { panel: { speedRatio: number } }).panel.speedRatio).toBe(25);
  });

  it('sends new events as the events group alone, coalesced like values; the list staying current is not news', async () => {
    const events = (lastSeq: number, asOf: string | null): EventsGroup => ({
      feed: 'feed-1', lastSeq, via: 'subscription', asOf, error: null,
      clock: { offsetMs: -7_203_000, measuredAt: '2026-09-23T19:59:00.000Z', problem: null },
      recent: Array.from({ length: lastSeq }, (_, i) => ({
        seq: i + 1, seqnum: i + 1, code: 10011, severity: 'info' as const, title: 'Motors ON state', titleFromCode: false,
        description: null, causes: null, consequences: null, actions: null, args: [], source: 'MC0',
        time: { raw: '2026-09-23 T 22:00:03', utc: '2026-09-23T20:00:00.000Z', corrected: true },
        receivedAt: '2026-09-23T20:00:00.000Z', backlog: false,
      })),
    });
    const { source, sock } = setup();
    source.set({ ...snap('rw6'), events: events(1, '2026-09-23T20:00:00.000Z') });
    await vi.advanceTimersByTimeAsync(1000);
    sock.sent.length = 0;

    source.set({ ...snap('rw6'), events: events(1, '2026-09-23T20:00:05.000Z') });   // asOf moved on: nothing to send
    expect(sock.frames()).toHaveLength(0);
    source.set({ ...snap('rw6'), events: events(2, '2026-09-23T20:00:05.000Z') });
    source.set({ ...snap('rw6'), events: events(3, '2026-09-23T20:00:05.000Z') });
    await vi.advanceTimersByTimeAsync(260);
    const frames = sock.frames();
    expect(frames).toHaveLength(2);
    expect(frames.map(f => Object.keys(f.groups as object))).toEqual([['events'], ['events']]);
    expect(frames.map(f => (f.groups as { events: EventsGroup }).events.lastSeq)).toEqual([2, 3]);
  });

  it('sends a value change after a quiet spell at once', async () => {
    const { source, sock } = setup();
    source.set(snap('rw6'));
    await vi.advanceTimersByTimeAsync(1000);
    sock.sent.length = 0;

    source.set(snap('rw6', { speed: 37 }));
    const frames = sock.frames();                  // no timer advanced
    expect(frames).toHaveLength(1);
    expect((frames[0].groups as { panel: { speedRatio: number } }).panel.speedRatio).toBe(37);
  });

  it('a burst: the first change at once, the rest as one trailing frame a window later', async () => {
    const { source, sock } = setup();
    source.set(snap('rw6'));
    await vi.advanceTimersByTimeAsync(1000);
    sock.sent.length = 0;

    source.set(snap('rw6', { speed: 10 }));        // t=0: sent
    await vi.advanceTimersByTimeAsync(40);
    source.set(snap('rw6', { speed: 20 }));        // t=40: booked for t=250
    await vi.advanceTimersByTimeAsync(40);
    source.set(snap('rw6', { speed: 30 }));        // t=80: rides the same booking
    expect(sock.frames()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(160);        // t=240: not yet
    expect(sock.frames()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);         // t=260
    const speeds = sock.frames().map(f => (f.groups as { panel: { speedRatio: number } }).panel.speedRatio);
    expect(speeds).toEqual([10, 30]);
  });

  it('never sends more than one value frame per window per controller', async () => {
    const { source, sock } = setup();
    source.set(snap('rw6'));
    await vi.advanceTimersByTimeAsync(1000);
    sock.sent.length = 0;

    for (let i = 1; i <= 40; i++) {                // a change every 25 ms for 1 s
      source.set(snap('rw6', { speed: i }));
      await vi.advanceTimersByTimeAsync(25);
    }
    await vi.advanceTimersByTimeAsync(300);
    const frames = sock.frames();
    expect(frames.length).toBeLessThanOrEqual(5);  // 1000 ms / 250 ms, plus the trailing one
    expect((frames.at(-1)!.groups as { panel: { speedRatio: number } }).panel.speedRatio).toBe(40);
  });

  it('coalesces motion like panel: at most one frame per window, carrying the latest joints', async () => {
    const { source, sock } = setup();
    source.set(snap('rw6'));
    await vi.advanceTimersByTimeAsync(1000);
    sock.sent.length = 0;

    for (let i = 1; i <= 16; i++) {                // sampled at 8 Hz for 2 s
      source.set(snap('rw6', { j1: i }));
      await vi.advanceTimersByTimeAsync(125);
    }
    await vi.advanceTimersByTimeAsync(300);
    const frames = sock.frames();
    expect(frames.length).toBeLessThanOrEqual(9);  // 2000 ms / 250 ms, plus the trailing one
    expect(frames.every(f => Object.keys(f.groups as object).join() === 'motion')).toBe(true);
    const last = frames.at(-1)!.groups as { motion: { units: Array<{ joints: Array<{ value: number }> }> } };
    expect(last.motion.units[0].joints[0].value).toBe(16);
  });

  it('does not send a frame when only a freshness stamp moved', async () => {
    const { source, sock } = setup();
    source.set(snap('rw6'));
    await vi.advanceTimersByTimeAsync(300);
    sock.sent.length = 0;

    source.set(snap('rw6', { asOf: '2026-09-23T20:00:05.000Z' }));
    await vi.advanceTimersByTimeAsync(300);
    expect(sock.sent).toHaveLength(0);
  });

  it('sends a group whose freshness stamp is set for the first time, though nothing else changed', async () => {
    // What a consumer sees when the daemon restarts under it: the values
    // arrive before the link is healthy, and the stamp only after.
    const { source, sock } = setup();
    source.set(snap('rw6', { asOf: null }));
    await vi.advanceTimersByTimeAsync(300);
    sock.sent.length = 0;

    source.set(snap('rw6', { asOf: '2026-09-23T20:00:05.000Z' }));
    const frames = sock.frames();                  // no timer advanced
    expect(frames).toHaveLength(1);
    expect(frames[0].groups).toEqual({ panel: expect.objectContaining({ asOf: '2026-09-23T20:00:05.000Z' }) });
  });

  it('a watched signal\'s stamp likewise: set or cleared is news, moving on is not', async () => {
    const io = (asOf: string | null) =>
      ({ watching: true, asOf, signals: [{ name: 'do1', type: 'DO', value: '1', via: 'poll', asOf, error: null }] });
    const { source, sock } = setup();
    source.set({ ...snap('rw6'), io: io(null) });  // watched, not read yet
    await vi.advanceTimersByTimeAsync(300);
    sock.sent.length = 0;

    source.set({ ...snap('rw6'), io: io('2026-09-23T20:00:01.000Z') });   // the first read
    await vi.advanceTimersByTimeAsync(300);
    source.set({ ...snap('rw6'), io: io('2026-09-23T20:00:02.000Z') });   // a later read, same value
    await vi.advanceTimersByTimeAsync(300);
    source.set({ ...snap('rw6'), io: io(null) });                        // unconfirmed again
    await vi.advanceTimersByTimeAsync(300);
    const frames = sock.frames();
    expect(frames.every(f => Object.keys(f.groups as object).join() === 'io')).toBe(true);
    expect(frames.map(f => (f.groups as { io: { signals: Array<{ asOf: string | null }> } }).io.signals[0].asOf))
      .toEqual(['2026-09-23T20:00:01.000Z', null]);
  });

  /** The three groups of schema 0.13 as one access round leaves them: unread (`asOf` null) or read, the edit lock free or held. */
  const accessGroups = (asOf: string | null, holder: string | null = null): Pick<ControllerSnapshot, 'access' | 'capabilities' | 'freshness'> => ({
    access: {
      generation: 'rw7', model: 'mastership',
      locks: [{
        lock: 'edit', held: asOf === null ? null : holder !== null,
        holder: holder === null ? null : { kind: 'remote', name: null, application: holder, flexPendant: false },
        heldByDaemon: false, reported: asOf === null ? null : holder === null ? 'nomaster' : 'remote', asOf, error: null,
      }],
      remoteAccessEnabled: null, rmmp: { supported: asOf === null ? null : true, privilege: asOf === null ? null : 'none', asOf, error: null },
      via: 'poll', problem: null, asOf,
    },
    capabilities: {
      protocol: 'rws2', generation: 'rw7', robotWare: null, tested: null,
      entries: [{ id: 'mastership', state: asOf === null ? 'unknown' : 'available', reason: asOf === null ? 'not read yet on this connection' : null }],
      asOf: '2026-09-23T20:00:00.000Z',
    },
    freshness: {
      level: 'current', reasons: [],
      groups: [{ group: 'access', state: asOf === null ? 'unread' : 'current', asOf, reason: asOf === null ? 'not read on this connection yet' : null }],
    },
  });

  it('carries access, capabilities and freshness like the value groups: content is news, a stamp moving on is not', async () => {
    const { source, sock } = setup();
    source.set({ ...snap('rw6'), ...accessGroups(null) });           // a controller's first delta: every group it has
    expect(Object.keys(sock.frames().at(-1)!.groups as object)).toEqual(['identity', 'link', 'panel', 'rapid', 'motion', 'access', 'capabilities', 'freshness']);
    await vi.advanceTimersByTimeAsync(300);
    sock.sent.length = 0;

    source.set({ ...snap('rw6'), ...accessGroups('2026-09-23T20:00:01.000Z') });                  // the first round landed
    await vi.advanceTimersByTimeAsync(300);
    source.set({ ...snap('rw6'), ...accessGroups('2026-09-23T20:00:06.000Z') });                  // read again, the same answer
    await vi.advanceTimersByTimeAsync(300);
    source.set({ ...snap('rw6'), ...accessGroups('2026-09-23T20:00:11.000Z', 'RobotStudio') });   // someone took the lock
    await vi.advanceTimersByTimeAsync(300);
    const frames = sock.frames();
    expect(frames.map(f => Object.keys(f.groups as object))).toEqual([['access', 'capabilities', 'freshness'], ['access']]);
    const last = frames[1].groups as { access: { asOf: string; locks: Array<{ held: boolean; holder: { application: string } }> } };
    expect(last.access.locks[0]).toMatchObject({ held: true, holder: { kind: 'remote', application: 'RobotStudio' } });
    expect(last.access.asOf).toBe('2026-09-23T20:00:11.000Z');     // each group is sent whole, with its newest stamps
  });

  it('coalesces a burst of access changes into the window, and sends freshness at once when it changed with the link', async () => {
    const { source, sock } = setup();
    source.set({ ...snap('rw6'), ...accessGroups('2026-09-23T20:00:01.000Z') });
    await vi.advanceTimersByTimeAsync(50);                          // still inside the first frame's window
    sock.sent.length = 0;

    source.set({ ...snap('rw6'), ...accessGroups('2026-09-23T20:00:02.000Z', 'RobotStudio') });
    source.set({ ...snap('rw6'), ...accessGroups('2026-09-23T20:00:03.000Z', 'FlexPendant') });
    expect(sock.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(210);
    expect(sock.frames()).toHaveLength(1);
    expect((sock.frames()[0].groups as { access: { locks: Array<{ holder: { application: string } }> } }).access.locks[0].holder.application).toBe('FlexPendant');
    sock.sent.length = 0;

    const down = { ...accessGroups('2026-09-23T20:00:03.000Z', 'FlexPendant') };
    down.access.via = null;
    down.freshness = { level: 'down', reasons: ['link: x'], groups: [{ group: 'access', state: 'stale', asOf: '2026-09-23T20:00:03.000Z', reason: 'x' }] };
    source.set({ ...snap('rw6', { quality: 'reconnecting' }), ...down });
    const frames = sock.frames();                                   // no timer advanced
    expect(frames).toHaveLength(1);
    expect(Object.keys(frames[0].groups as object)).toEqual(['link', 'access', 'freshness']);
  });

  it('announces a removal, even for a controller only ever seen in the snapshot', () => {
    const { source, sock } = setup();
    source.drop('rw6');
    expect(sock.frames().at(-1)).toMatchObject({ type: 'removed', id: 'rw6' });
  });

  it('a consumer attaching mid-debounce does not swallow the change for the others', async () => {
    const { source, stream, sock } = setup();
    source.set(snap('rw6'));
    await vi.advanceTimersByTimeAsync(50);         // inside the window: the next change is booked
    sock.sent.length = 0;

    source.set(snap('rw6', { speed: 10 }));        // pending until t=250
    stream.attach(new FakeSocket());               // a newcomer arrives meanwhile
    await vi.advanceTimersByTimeAsync(260);
    const deltas = sock.frames().filter(f => f.type === 'delta');
    expect(deltas).toHaveLength(1);
    expect((deltas[0].groups as { panel: { speedRatio: number } }).panel.speedRatio).toBe(10);
  });

  it('close() cancels pending sends', async () => {
    const { source, stream, sock } = setup();
    source.set(snap('rw6'));
    await vi.advanceTimersByTimeAsync(50);         // inside the window: the next change is booked
    sock.sent.length = 0;
    source.set(snap('rw6', { speed: 1 }));
    stream.close();
    await vi.advanceTimersByTimeAsync(300);
    expect(sock.sent).toHaveLength(0);
  });
});

describe('GET /v0/stream', () => {
  it('opens with a snapshot over a real WebSocket upgrade', async () => {
    vi.useRealTimers();
    const { createServer } = await import('../src/server.js');
    const { registerStreamRoute } = await import('../src/stream.js');
    const app = createServer({ accessToken: TOKEN });
    const stream = new SnapshotStream(makeSource([snap('rw6')]), new SocketHub({ heartbeatMs: 0 }));
    await registerStreamRoute(app, stream);
    await app.ready();
    // The server sends the snapshot the moment the socket opens, so the
    // listener must exist before the upgrade completes.
    let resolveFirst!: (s: string) => void;
    const firstMessage = new Promise<string>(r => { resolveFirst = r; });
    const ws = await app.injectWS('/v0/stream', { headers: LOCAL },
      { onInit: sock => sock.once('message', d => resolveFirst(String(d))) });
    const first = await firstMessage;
    expect(JSON.parse(first)).toMatchObject({ type: 'snapshot', controllers: [{ id: 'rw6' }] });
    ws.terminate();
    stream.close();
    await app.close();
  });

  it('refuses the upgrade from a cross-site page', async () => {
    vi.useRealTimers();
    const { createServer } = await import('../src/server.js');
    const { registerStreamRoute } = await import('../src/stream.js');
    const app = createServer({ accessToken: TOKEN });
    const stream = new SnapshotStream(makeSource([]), new SocketHub({ heartbeatMs: 0 }));
    await registerStreamRoute(app, stream);
    await app.ready();
    await expect(app.injectWS('/v0/stream', { headers: { ...LOCAL, origin: 'https://evil.example' } }))
      .rejects.toThrow();
    stream.close();
    await app.close();
  });

  /** A real stream route over injectWS; `ws` opens it and resolves with the client socket and its close. */
  async function streamApp(hub = new SocketHub({ heartbeatMs: 0 })) {
    vi.useRealTimers();
    const { createServer } = await import('../src/server.js');
    const { registerStreamRoute } = await import('../src/stream.js');
    const app = createServer({ accessToken: TOKEN });
    const stream = new SnapshotStream(makeSource([snap('rw6')]), hub);
    await registerStreamRoute(app, stream);
    await app.ready();
    const open = async () => {
      let closedWith!: (c: { code: number; reason: string }) => void;
      const closed = new Promise<{ code: number; reason: string }>(r => { closedWith = r; });
      const ws = await app.injectWS('/v0/stream', { headers: LOCAL },
        { onInit: sock => sock.on('close', (code, reason) => closedWith({ code, reason: String(reason) })) });
      return { ws, closed };
    };
    return { open, done: async () => { stream.close(); await app.close(); } };
  }

  it('closes a consumer that sends a message: the stream only sends', async () => {
    const { open, done } = await streamApp();
    const { ws, closed } = await open();
    ws.send('{"subscribe":"everything"}');
    expect(await closed).toEqual({ code: 1008, reason: 'the stream accepts no messages' });
    await done();
  });

  it('does not read a message over STREAM_MAX_PAYLOAD: the consumer is cut off', async () => {
    const { STREAM_MAX_PAYLOAD } = await import('../src/stream.js');
    expect(STREAM_MAX_PAYLOAD).toBe(4096);
    const { open, done } = await streamApp();
    const { ws, closed } = await open();
    ws.send('x'.repeat(STREAM_MAX_PAYLOAD + 1));
    expect([1009, 1006]).toContain((await closed).code);   // "message too big", or cut before that frame arrived
    await done();
  });

  it('closes a consumer over the cap with a reason it can show, keeps the others', async () => {
    const { open, done } = await streamApp(new SocketHub({ heartbeatMs: 0, maxClients: 1 }));
    const first = await open();
    const second = await open();
    expect(await second.closed).toEqual({ code: 1013, reason: 'too many stream consumers (at most 1); retry later' });
    expect(first.ws.readyState).toBe(1);
    first.ws.terminate();
    await done();
  });

  it('refuses the upgrade from a page on another loopback port, opens it for the panel', async () => {
    vi.useRealTimers();
    const { createServer } = await import('../src/server.js');
    const { registerStreamRoute } = await import('../src/stream.js');
    const app = createServer({ accessToken: TOKEN });
    const stream = new SnapshotStream(makeSource([]), new SocketHub({ heartbeatMs: 0 }));
    await registerStreamRoute(app, stream);
    await app.ready();
    await expect(app.injectWS('/v0/stream', { headers: { ...LOCAL, origin: 'http://localhost:31337' } }))
      .rejects.toThrow(/403/);
    const ws = await app.injectWS('/v0/stream', { headers: { ...LOCAL, origin: 'http://localhost:5173' } });
    ws.terminate();
    stream.close();
    await app.close();
  });
});

describe('GET /v0/stream and the access token, over real sockets', () => {
  const WRONG = 'wrong-token-wrong-token-wrong-token-12345';

  async function listening() {
    vi.useRealTimers();
    const { createServer } = await import('../src/server.js');
    const { registerStreamRoute } = await import('../src/stream.js');
    const app = createServer({ accessToken: TOKEN });
    const stream = new SnapshotStream(makeSource([snap('rw6')]), new SocketHub({ heartbeatMs: 0 }));
    await registerStreamRoute(app, stream);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/v0/stream`;
    return { url, done: async () => { stream.close(); await app.close(); } };
  }

  interface Outcome {
    /** 101 when the stream opened, otherwise the status the upgrade was refused with. */
    status: number;
    /** The subprotocol the handshake answered with (the response header, as sent). */
    selected?: string;
    first?: { type?: string };
    body?: string;
  }

  /** Open a real WebSocket as a native consumer does; resolves on the first frame or on the refusal. */
  function connect(url: string, protocols: string[], headers: Record<string, string> = {}): Promise<Outcome> {
    return new Promise(resolve => {
      const ws = new WebSocket(url, protocols, { headers });
      let selected: string | undefined;
      ws.on('error', () => { /* a refused handshake also ends here; the outcome is already known */ });
      ws.on('upgrade', res => { selected = res.headers['sec-websocket-protocol'] as string | undefined; });
      ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += String(c); });
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }); ws.terminate(); });
      });
      ws.on('message', d => { resolve({ status: 101, selected, first: JSON.parse(String(d)) }); ws.terminate(); });
    });
  }

  it('opens for the token in its header', async () => {
    const { url, done } = await listening();
    expect(await connect(url, [], { [TOKEN_HEADER]: TOKEN })).toMatchObject({ status: 101, selected: undefined, first: { type: 'snapshot' } });
    expect(await connect(url, [STREAM_PROTOCOL], { [TOKEN_HEADER]: TOKEN })).toMatchObject({ status: 101, selected: STREAM_PROTOCOL });
    await done();
  });

  it('opens for the token offered as a subprotocol next to the stream`s, and never echoes it', async () => {
    const { url, done } = await listening();
    for (const offer of [[STREAM_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${TOKEN}`], [`${TOKEN_PROTOCOL_PREFIX}${TOKEN}`, STREAM_PROTOCOL]]) {
      const out = await connect(url, offer);
      expect(out, offer.join()).toMatchObject({ status: 101, selected: STREAM_PROTOCOL, first: { type: 'snapshot' } });
    }
    await done();
  });

  it('refuses the upgrade without the token, or with another, and quotes neither', async () => {
    const { url, done } = await listening();
    const none = await connect(url, [STREAM_PROTOCOL]);
    expect(none.status).toBe(401);
    expect(JSON.parse(none.body!).code).toBe('TOKEN_MISSING');
    for (const out of [await connect(url, [], { [TOKEN_HEADER]: WRONG }), await connect(url, [STREAM_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${WRONG}`])]) {
      expect(out.status).toBe(401);
      expect(JSON.parse(out.body!).code).toBe('TOKEN_INVALID');
      expect(out.body).not.toContain(WRONG.slice(0, 12));
      expect(out.body).not.toContain(TOKEN.slice(0, 12));
    }
    await done();
  });

  it('refuses a token subprotocol offered without the stream`s with a reason, not a failed handshake', async () => {
    const { url, done } = await listening();
    const out = await connect(url, [`${TOKEN_PROTOCOL_PREFIX}${TOKEN}`]);
    expect(out.status).toBe(400);
    expect(JSON.parse(out.body!)).toMatchObject({ code: 'BAD_REQUEST', error: expect.stringContaining(STREAM_PROTOCOL) });
    expect(out.body).not.toContain(TOKEN.slice(0, 12));
    await done();
  });

  it('closes a refused upgrade`s socket once the answer is out: a peer that stays never holds up shutdown', async () => {
    const { url, done } = await listening();
    const { port } = new URL(url);
    // A peer that asks for the stream and then just sits on its connection.
    const ask = (extra: string) => new Promise<{ answer: string; closedByDaemon: boolean }>(resolve => {
      const peer = net.connect(Number(port), '127.0.0.1');
      let answer = '';
      peer.on('data', d => { answer += String(d); });
      peer.on('error', () => {});
      peer.on('end', () => { resolve({ answer, closedByDaemon: true }); peer.destroy(); });
      setTimeout(() => { resolve({ answer, closedByDaemon: false }); peer.destroy(); }, 2_000);
      peer.write(`GET /v0/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
        + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`);
    });
    const tokenless = await ask('');
    expect(tokenless.closedByDaemon).toBe(true);
    expect(tokenless.answer).toMatch(/^HTTP\/1\.1 401 [\s\S]*"code":"TOKEN_MISSING"\}$/);
    const foreign = await ask(`Origin: http://localhost:31337\r\n${TOKEN_HEADER}: ${TOKEN}\r\n`);
    expect(foreign.closedByDaemon).toBe(true);
    expect(foreign.answer).toMatch(/^HTTP\/1\.1 403 [\s\S]*"code":"ORIGIN_NOT_ALLOWED"\}$/);

    // One more that never hangs up: shutting down does not wait for it.
    const peer = net.connect(Number(port), '127.0.0.1');
    peer.on('error', () => {});
    await new Promise<void>(r => peer.once('connect', () => r()));
    peer.write(`GET /v0/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
      + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    await new Promise<void>(r => peer.once('data', () => r()));
    const t0 = Date.now();
    await done();
    expect(Date.now() - t0).toBeLessThan(1_000);
    peer.destroy();
  });
});

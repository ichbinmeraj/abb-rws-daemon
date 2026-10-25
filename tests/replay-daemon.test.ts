import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { MultiRobotManager, RobotManager } from 'abb-rws-client';
import type { ControllerEvent, ControllerSnapshot } from '../src/schema/v0.js';
import { snapshotOf } from './helpers/recording-fakes.js';

/**
 * A replaying daemon, driven through every route, while everything that could
 * reach a controller is watched at the prototype level - however a module
 * imports it: a TCP or TLS connection (HTTP goes through it too), a UDP socket
 * (mDNS), a child process (netstat, ss) and every client method that could
 * open a session. None may be used, the daemon's own import included.
 */

vi.setConfig({ testTimeout: 20_000 });

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const LOCAL = { host: '127.0.0.1:7810', 'x-abb-rws-token': TOKEN };
const STARTED = '2026-10-04T15:30:12.345Z';
const STARTED_MS = Date.parse(STARTED);
const SESSION = 'rec-20261004T153012Z-replay-test';
const PART = `${SESSION}-p0001.jsonl`;

// --- the watch -----------------------------------------------------------------

const watched: Array<{ name: string; spy: MockInstance }> = [];
function watch(target: object, method: string, name: string): void {
  const spy = vi.spyOn(target as Record<string, (...a: unknown[]) => unknown>, method).mockImplementation(() => {
    throw new Error(`${name} was called by a replaying daemon`);
  });
  watched.push({ name, spy });
}
watch(net.Socket.prototype, 'connect', 'net.Socket.prototype.connect');
watch(dgram.Socket.prototype, 'bind', 'dgram.Socket.prototype.bind');
watch(dgram.Socket.prototype, 'send', 'dgram.Socket.prototype.send');
watch(ChildProcess.prototype, 'spawn', 'ChildProcess.prototype.spawn');
watch(MultiRobotManager.prototype, 'addRobot', 'MultiRobotManager.prototype.addRobot');
watch(MultiRobotManager.prototype, 'connectRobot', 'MultiRobotManager.prototype.connectRobot');
for (const name of Object.getOwnPropertyNames(RobotManager.prototype)) {
  const d = Object.getOwnPropertyDescriptor(RobotManager.prototype, name);
  if (name !== 'constructor' && typeof d?.value === 'function') { watch(RobotManager.prototype, name, `RobotManager.prototype.${name}`); }
}

// --- the recording -------------------------------------------------------------

const event = (seq: number, title: string): ControllerEvent => ({
  seq, seqnum: 2025 + seq, code: 10010 + seq, severity: 'info', title, titleFromCode: false, description: null,
  causes: null, consequences: null, actions: null, args: [], source: null,
  time: { raw: '2026-10-04 15:30:00', utc: '2026-10-04T15:30:00.000Z', corrected: false }, receivedAt: STARTED, backlog: false,
});

function rw7(): ControllerSnapshot {
  const c = snapshotOf('rw7', { sysId: 'sys-rw7', check: 'confirmed' });
  c.io = {
    watching: true, asOf: STARTED,
    signals: [{ name: 'do_a', type: 'DO', value: '0', via: 'poll', asOf: STARTED, error: null }],
  };
  return c;
}
const rw6 = (): ControllerSnapshot => snapshotOf('rw6', { sysId: 'sys-rw6', robotWare: '6.16.3', generation: 'rws1', check: 'confirmed' });

const snapshot = { type: 'snapshot', schemaVersion: '0.12', observedAt: STARTED, controllers: [rw7(), rw6()] };
const speedDelta = {
  type: 'delta', observedAt: '2026-10-04T15:30:12.445Z', id: 'rw7', name: 'RW7',
  groups: { panel: { ...rw7().panel, speedRatio: 50 } },
};
const eventsDelta = {
  type: 'delta', observedAt: '2026-10-04T15:30:12.545Z', id: 'rw7', name: 'RW7',
  groups: { events: { ...rw7().events!, lastSeq: 2, recent: [...rw7().events!.recent, event(2, 'Program started')] } },
};
const rw6Gone = { type: 'removed', observedAt: '2026-10-04T15:30:12.645Z', id: 'rw6' };

const header = (schemaVersion = '0.12') => ({
  kind: 'header', format: 'abb-rws-recording', formatVersion: 1, schemaVersion, source: 'daemon', session: SESSION, part: 1,
  previous: null, startedAt: STARTED, sessionStartedAt: STARTED, label: 'replay-test', content: ['frames', 'calls', 'state'],
  daemon: { version: '0.1.0-test' }, client: { version: '1.4.0-test' },
  controllers: [{ id: 'rw7', systemId: null, generation: null, robotWare: null }],
  limits: {
    maxFileBytes: 67108864, maxTotalBytes: 268435456, maxDirBytes: 4294967296, maxRecordBytes: 1048576,
    minFreeBytes: 2147483648, durationS: 3600,
  },
  masking: { rules: ['keys', 'args', 'text', 'rapid', 'values', 'final'], values: 1, derived: 3, weakValues: 0 },
});

const call = (t: number, method: string, args: unknown[], result: unknown) =>
  ({ kind: 'call', t, target: 'manager', id: 'rw7', gen: 'rws2', seq: t, method, args, ms: 3, ok: true, result });

const MODULE_TEXT = 'MODULE MainModule\n  PROC main()\n  ENDPROC\nENDMODULE';
const TABLE = [{ name: 'do_a', type: 'DO', value: '0', lvalue: '0' }, { name: 'di_b', type: 'DI', value: '1', lvalue: '1' }];

function recordingText(schemaVersion = '0.12'): string {
  const lines: unknown[] = [
    header(schemaVersion),
    { kind: 'frame', t: 0, frame: { ...snapshot, schemaVersion } },
    { kind: 'controller', t: 0, id: 'rw7', systemId: 'sys-rw7', generation: 'rws2', robotWare: '7.21.4+417', identityCheck: 'confirmed' },
    { kind: 'state', t: 10, id: 'rw7', full: true, changed: { connected: true, ioSignalsLoaded: true }, ioSignals: { chunk: 1, chunks: 1, full: TABLE } },
    { kind: 'state', t: 12, id: 'rw6', full: true, changed: { connected: true, ioSignalsLoaded: false } },
    call(20, 'getModuleText', ['T_ROB1', 'MainModule'], { text: MODULE_TEXT, changeCount: 3 }),
    call(21, 'listModulesDetailed', ['T_ROB1'], [{ name: 'BASE', type: 'SysMod' }, { name: 'MainModule', type: 'ProgMod' }]),
    call(22, 'searchSignals', [{ name: 'do' }], [{ name: 'do_a', type: 'DO', value: '1', lvalue: '1' }]),
    { kind: 'frame', t: 100, frame: speedDelta },
    { kind: 'frame', t: 200, frame: eventsDelta },
    { kind: 'frame', t: 300, frame: rw6Gone },
    { kind: 'end', t: 301, reason: 'stopped', records: 10, bytes: 1, dropped: { call: 0, state: 0, sub: 0 }, next: null },
  ];
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

// --- the daemon ----------------------------------------------------------------

type Daemon = Awaited<ReturnType<typeof import('../src/replayDaemon.js')['createReplayDaemon']>>;
let folder: string;
let daemon: Daemon;
const exits: number[] = [];

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'replay-daemon-'));
  await writeFile(join(folder, PART), recordingText());
  // The daemon's modules load only now, with every watch in place.
  vi.resetModules();
  const { createReplayDaemon } = await import('../src/replayDaemon.js');
  daemon = await createReplayDaemon({
    target: join(folder, PART), paused: true, time: 'recorded',
    server: { accessToken: TOKEN, logger: false }, exit: code => { exits.push(code); },
  });
  await daemon.app.ready();
});

afterAll(async () => {
  await daemon?.app.close();
  await rm(folder, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = LOCAL) => daemon.app.inject({ method: 'GET', url, headers });
const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = LOCAL) =>
  daemon.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** Wait (bounded) until `check` holds: frames cross the in-memory socket asynchronously. */
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) { throw new Error('timed out'); }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

let consumer: { ws: WebSocket; messages: string[]; closed: Promise<{ code: number; reason: string }> };

describe('a replaying daemon, route by route', () => {
  it('health: mode replay, no recording, the replay paused at the start; GET /v0/replay says what is replayed', async () => {
    const health = (await get('/v0/health', { host: LOCAL.host })).json();
    expect(health).toMatchObject({
      status: 'ok', mode: 'replay', recording: { active: false, since: null },
      replay: { state: 'paused', positionMs: 0, durationMs: 300, speed: 1, loop: false, loops: 0, recordedAt: STARTED, time: 'recorded' },
    });
    const res = await get('/v0/replay');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      files: [PART], session: SESSION, label: 'replay-test', source: 'daemon', recordedSchemaVersion: '0.12',
      daemonVersion: '0.1.0-test', clientVersion: '1.4.0-test', gaps: 0, state: 'paused',
    });
    expect((await get('/v0/replay', { host: LOCAL.host })).statusCode).toBe(401);
  });

  it('controllers: the replay`s state at the position, as recorded', async () => {
    const list = await get('/v0/controllers');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ schemaVersion: '0.12', observedAt: STARTED });
    expect(list.json().controllers.map((c: { id: string }) => c.id)).toEqual(['rw7', 'rw6']);
    const one = await get('/v0/controllers/rw7');
    expect(one.json()).toEqual(rw7());
    expect((await get('/v0/controllers/nope')).json().code).toBe('NO_CONTROLLER');
  });

  it('before the recording read them: module source and the signal table are 404 NOT_RECORDED, never made up', async () => {
    const mod = await get('/v0/controllers/rw7/rapid/tasks/T_ROB1/modules/MainModule');
    expect(mod.statusCode).toBe(404);
    expect(mod.json().code).toBe('NOT_RECORDED');
    const table = await get('/v0/controllers/rw7/io/signals');
    expect(table.statusCode).toBe(404);
    expect(table.json().code).toBe('NOT_RECORDED');
  });

  it('the stream: a snapshot on attach, then each recorded frame on step, byte for byte', async () => {
    const messages: string[] = [];
    let closedWith!: (c: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>(r => { closedWith = r; });
    const ws = await daemon.app.injectWS('/v0/stream', { headers: LOCAL }, {
      onInit: sock => {
        sock.on('message', d => messages.push(String(d)));
        sock.on('close', (code, reason) => closedWith({ code, reason: String(reason) }));
      },
    });
    consumer = { ws, messages, closed };
    await until(() => messages.length === 1);
    expect(JSON.parse(messages[0])).toEqual({ ...snapshot, observedAt: STARTED });

    const stepped = await send('POST', '/v0/replay/control', { action: 'step' });
    expect(stepped.statusCode).toBe(200);
    expect(stepped.json()).toMatchObject({ state: 'paused', positionMs: 100 });
    await until(() => messages.length === 2);
    expect(messages[1]).toBe(JSON.stringify(speedDelta));
  });

  it('the stream keeps its checks: no token, or a page from another site, is refused', async () => {
    await expect(daemon.app.injectWS('/v0/stream', { headers: { host: LOCAL.host } })).rejects.toThrow(/401/);
    await expect(daemon.app.injectWS('/v0/stream', { headers: { ...LOCAL, origin: 'https://elsewhere.example' } }))
      .rejects.toThrow(/403/);
  });

  it('after the reads: module source, the table and a search answered from the recording at the position', async () => {
    const mod = await get('/v0/controllers/rw7/rapid/tasks/T_ROB1/modules/MainModule');
    expect(mod.statusCode).toBe(200);
    expect(mod.json()).toEqual({ task: 'T_ROB1', module: 'MainModule', kind: 'program', text: MODULE_TEXT, changeCount: 3 });
    expect((await get('/v0/controllers/rw7/rapid/tasks/T_ROB1/modules/Other')).json().code).toBe('NOT_RECORDED');

    const table = await get('/v0/controllers/rw7/io/signals');
    expect(table.statusCode).toBe(200);
    expect(table.json()).toEqual({ signals: [{ name: 'do_a', type: 'DO', value: '0' }, { name: 'di_b', type: 'DI', value: '1' }] });
    const search = await get('/v0/controllers/rw7/io/signals?name=do');
    expect(search.json()).toEqual({ signals: [{ name: 'do_a', type: 'DO', value: '1' }] });
    const other = await get('/v0/controllers/rw7/io/signals?name=zz');
    expect(other.statusCode).toBe(404);
    expect(other.json().code).toBe('NOT_RECORDED');

    // rw6's client had not loaded its table: 503 NOT_READY, as live.
    const notReady = await get('/v0/controllers/rw6/io/signals');
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json().code).toBe('NOT_READY');
  });

  it('watches are granted as live and change nothing; an I/O watch takes only signals the recording carries', async () => {
    const motion = await send('POST', '/v0/controllers/rw7/motion/watch', { leaseId: 'new' });
    expect(motion.statusCode).toBe(200);
    expect(motion.json()).toMatchObject({ leaseMs: expect.any(Number), targetHz: expect.any(Number), leaseId: expect.any(String) });
    const io = await send('POST', '/v0/controllers/rw7/io/watch', { signals: ['do_a', 'nope'] });
    expect(io.statusCode).toBe(200);
    expect(io.json()).toMatchObject({ accepted: ['do_a'], rejected: [{ name: 'nope', reason: 'not in this recording' }] });
  });

  it('events: every event the recording carried, by seq', async () => {
    await send('POST', '/v0/replay/control', { action: 'step' });   // the events delta, t 200
    const page = await get('/v0/controllers/rw7/events');
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ feed: 'rw7-feed', firstSeq: 1, lastSeq: 2, gap: false, more: false });
    expect(page.json().events.map((e: ControllerEvent) => e.seq)).toEqual([1, 2]);
    expect((await get('/v0/controllers/rw7/events?since=1')).json().events.map((e: ControllerEvent) => e.title))
      .toEqual(['Program started']);
  });

  const REFUSED: Array<['POST' | 'PUT' | 'DELETE', string, unknown?]> = [
    ['POST', '/v0/setup/discover', {}],
    ['POST', '/v0/setup/discover', { ranges: ['10.0.0.1-10.0.0.2'] }],
    ['POST', '/v0/setup/passport', { host: '127.0.0.1', port: 9403, useHttps: true, username: 'user', password: 'replay-pass-1' }],
    ['POST', '/v0/controllers', { host: '127.0.0.1', port: 9403, useHttps: true, username: 'user', password: 'replay-pass-1' }],
    ['POST', '/v0/controllers', { id: 'rw7', host: '127.0.0.1', port: 9403, useHttps: true, username: 'user', password: 'replay-pass-1' }],
    ['PUT', '/v0/setup/discover/saved', { manual: [{ host: 'cell-1' }] }],
    ['DELETE', '/v0/setup/discover/saved'],
    ['DELETE', '/v0/setup/discover/saved/manual?host=cell-1'],
    ['DELETE', '/v0/setup/discover/saved/ranges?range=10.0.0.0/30'],
    ['DELETE', '/v0/setup/discover/saved/ports?port=8080'],
    ['DELETE', '/v0/controllers/rw7'],
    ['POST', '/v0/recording/start', {}],
  ];
  for (const [method, url, payload] of REFUSED) {
    it(`${method} ${url}${payload ? ` ${JSON.stringify(payload).slice(0, 40)}` : ''}: 409 REPLAY_MODE`, async () => {
      const res = await send(method, url, payload);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: 'REPLAY_MODE', error: expect.stringMatching(/replaying a recording/) });
      expect(res.body).not.toContain('replay-pass-1');
      // The token still comes first.
      expect((await send(method, url, payload, { host: LOCAL.host })).statusCode).toBe(401);
    });
  }

  it('what stays as live: DELETE of an unknown controller is 404; saved inputs are empty; the recording is inactive', async () => {
    const del = await send('DELETE', '/v0/controllers/nope');
    expect(del.statusCode).toBe(404);
    expect(del.json().code).toBe('NO_CONTROLLER');
    expect((await get('/v0/setup/discover/saved')).json()).toEqual({ manual: [], ranges: [], ports: [] });
    expect((await get('/v0/recording')).json()).toMatchObject({ active: false, session: null, folder: null });
    expect((await send('POST', '/v0/recording/stop')).json()).toMatchObject({ active: false });
  });

  it('control: bad requests are 400; speed, play and pause apply', async () => {
    for (const body of [{ action: 'jump' }, { action: 'play', speed: 100 }, { action: 'play', speed: 0.01 }, {}]) {
      const res = await send('POST', '/v0/replay/control', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
    }
    expect((await send('POST', '/v0/replay/control', { action: 'pause', speed: 2 })).json())
      .toMatchObject({ state: 'paused', speed: 2 });
    expect((await send('POST', '/v0/replay/control', { action: 'play' })).json().state).toBe('playing');
    expect((await send('POST', '/v0/replay/control', { action: 'pause' })).json().state).toBe('paused');
  });

  it('restart: every stream consumer is closed with 1012, and the event feed starts over under a new name', async () => {
    const res = await send('POST', '/v0/replay/control', { action: 'restart' });
    expect(res.json()).toMatchObject({ loops: 1, positionMs: 0, state: 'paused' });
    expect(await consumer.closed).toEqual({ code: 1012, reason: 'the recording starts over' });
    const page = (await get('/v0/controllers/rw7/events')).json();
    expect(page.feed).toBe('rw7-feed~loop1');
    expect((await get('/v0/controllers')).json().controllers.map((c: { id: string }) => c.id)).toEqual(['rw7', 'rw6']);
  });

  it('shutdown as live: 202, then the stop runs, with no session to log out of, and exits 0', async () => {
    const res = await send('POST', '/v0/admin/shutdown');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ stopping: true, alreadyStopping: false });
    await until(() => exits.length > 0, 5_000);
    expect(exits).toEqual([0]);
  });

  it('reached nothing: no connection, no UDP socket, no child process, no client method, from import to stop', () => {
    const used = watched.filter(w => w.spy.mock.calls.length > 0).map(w => `${w.name} (${w.spy.mock.calls.length})`);
    expect(used).toEqual([]);
    expect(watched.length).toBeGreaterThan(20);
  });
});

describe('replaying another recording', () => {
  it('a recording made with another snapshot schema version is served as recorded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'replay-daemon-old-'));
    try {
      await writeFile(join(dir, PART), recordingText('0.11'));
      const { createReplayDaemon } = await import('../src/replayDaemon.js');
      const old = await createReplayDaemon({
        target: dir, paused: true, server: { accessToken: TOKEN, logger: false }, exit: () => {},
      });
      try {
        expect((await old.app.inject({ method: 'GET', url: '/v0/controllers', headers: LOCAL })).json().schemaVersion).toBe('0.11');
        expect((await old.app.inject({ method: 'GET', url: '/v0/replay', headers: LOCAL })).json().recordedSchemaVersion).toBe('0.11');
      } finally {
        old.stream.close();
        await old.app.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a 0.13 recording: every link it serves says mode replay and when the recording began, the stream included', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'replay-daemon-mode-'));
    // As a live daemon of 0.13 records them: every link says live.
    const live = rw7();
    expect(live.link).toMatchObject({ mode: 'live', recordedAt: null });
    const linkDelta = {
      type: 'delta', observedAt: '2026-10-04T15:30:12.445Z', id: 'rw7', name: 'RW7',
      groups: { link: { ...live.link, quality: 'polling', qualityReason: 'polling' } },
    };
    const lines = [
      header('0.13'),
      { kind: 'frame', t: 0, frame: { ...snapshot, schemaVersion: '0.13' } },
      { kind: 'frame', t: 100, frame: linkDelta },
      { kind: 'frame', t: 200, frame: speedDelta },
      { kind: 'end', t: 201, reason: 'stopped', records: 4, bytes: 1, dropped: { call: 0, state: 0, sub: 0 }, next: null },
    ];
    try {
      await writeFile(join(dir, PART), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
      const { createReplayDaemon } = await import('../src/replayDaemon.js');
      for (const time of ['recorded', 'shifted'] as const) {
        const d = await createReplayDaemon({
          target: dir, paused: true, time, server: { accessToken: TOKEN, logger: false }, exit: () => {},
        });
        try {
          const replayed = { mode: 'replay', recordedAt: STARTED };
          const list = (await d.app.inject({ method: 'GET', url: '/v0/controllers', headers: LOCAL })).json();
          expect(list.controllers.map((c: ControllerSnapshot) => c.link)).toEqual([expect.objectContaining(replayed), expect.objectContaining(replayed)]);
          expect((await d.app.inject({ method: 'GET', url: '/v0/controllers/rw7', headers: LOCAL })).json().link).toMatchObject(replayed);

          const messages: string[] = [];
          const ws = await d.app.injectWS('/v0/stream', { headers: LOCAL }, { onInit: sock => { sock.on('message', m => messages.push(String(m))); } });
          await until(() => messages.length === 1);
          for (const c of JSON.parse(messages[0]).controllers) { expect(c.link).toMatchObject(replayed); }
          await d.app.inject({ method: 'POST', url: '/v0/replay/control', headers: LOCAL, payload: { action: 'step' } });
          await until(() => messages.length === 2);
          expect(JSON.parse(messages[1]).groups.link).toMatchObject({ ...replayed, quality: 'polling' });
          await d.app.inject({ method: 'POST', url: '/v0/replay/control', headers: LOCAL, payload: { action: 'step' } });
          await until(() => messages.length === 3);
          // A frame without a link goes out as recorded.
          if (time === 'recorded') { expect(messages[2]).toBe(JSON.stringify(speedDelta)); }
          expect((await d.app.inject({ method: 'GET', url: '/v0/controllers/rw7', headers: LOCAL })).json().link)
            .toMatchObject({ ...replayed, quality: 'polling' });
          ws.terminate();
        } finally {
          d.stream.close();
          await d.app.close();
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the start line of the log keeps its own timestamp and names the time mode replayTime', async () => {
    const lines: string[] = [];
    const { createReplayDaemon } = await import('../src/replayDaemon.js');
    const logged = await createReplayDaemon({
      target: join(folder, PART), paused: true, time: 'recorded', exit: () => {},
      server: { accessToken: TOKEN, logger: { level: 'info', stream: { write: (l: string) => { lines.push(l); } } } },
    });
    try {
      const start = lines.find(l => l.includes('replaying a recording'));
      expect(start).toBeDefined();
      // Exactly one "time" member, the timestamp: JSON.parse keeps the last of duplicate keys.
      expect(start!.match(/"time":/g)).toHaveLength(1);
      expect(JSON.parse(start!)).toMatchObject({ time: expect.any(Number), replayTime: 'recorded', paused: true });
    } finally {
      logged.stream.close();
      await logged.app.close();
    }
  });

  it('a recording that cannot be replayed is refused by name, and nothing is left open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'replay-daemon-bad-'));
    try {
      await writeFile(join(dir, PART), `${JSON.stringify(header())}\n${JSON.stringify({ kind: 'note', t: 1, text: 'no frames' })}\n`);
      const { createReplayDaemon } = await import('../src/replayDaemon.js');
      await expect(createReplayDaemon({ target: join(dir, PART), server: { accessToken: TOKEN, logger: false }, exit: () => {} }))
        .rejects.toThrow(/no frames/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

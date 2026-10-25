import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { RobotState } from 'abb-rws-client';
import type { ControllerConfig } from '../src/config.js';
import { ControllerFleet, DISCONNECT_ALL_WAIT_MS, type ControllerLogout } from '../src/fleet.js';
import { registerAdminRoutes, SHUTDOWN_PATH, type AdminDeps } from '../src/routes.js';
import { STOP_WAIT_MS, TOKEN_HEADER, type ShutdownAnswer } from '../src/schema/v0.js';
import { createServer } from '../src/server.js';
import { DaemonStop, STOP_RESERVE_MS, logLogouts, onStopSignals, stopSignals, type StopParts } from '../src/stop.js';
import { SnapshotStream, registerStreamRoute } from '../src/stream.js';
import { CLOSE_GOING_AWAY, SocketHub } from '../src/wsHub.js';
import { FakeSocket } from './wsHub.test.js';

/** The daemon's access token in these tests, and the headers of a native consumer that holds it. */
const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const LOCAL = { host: '127.0.0.1:7810', [TOKEN_HEADER]: TOKEN };
const SECRET = 'hunter2-not-robotics';

/** A log that keeps every line. */
function recordingLog() {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg?: string }> = [];
  const at = (level: string) => (obj: object, msg?: string) => { lines.push({ level, obj: obj as Record<string, unknown>, msg }); };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

afterEach(() => { vi.useRealTimers(); });

describe('stop signals', () => {
  it('on Windows: Ctrl+C, SIGTERM, Ctrl+Break and closing the console window', () => {
    expect(stopSignals('win32')).toEqual(['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
  });

  it('elsewhere SIGINT and SIGTERM only: SIGHUP stays with the terminal (nohup keeps working)', () => {
    expect(stopSignals('linux')).toEqual(['SIGINT', 'SIGTERM']);
    expect(stopSignals('darwin')).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('each stop signal starts the stop with its own name; nothing is killed, the process is a fake', () => {
    const proc = new EventEmitter();
    const stops: string[] = [];
    const handled = onStopSignals(s => stops.push(s), proc, 'win32');
    expect(handled).toEqual(['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
    for (const s of handled) { proc.emit(s); }
    expect(stops).toEqual(['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
  });

  it('on Linux no listener is added for SIGBREAK or SIGHUP', () => {
    const proc = new EventEmitter();
    const stops: string[] = [];
    onStopSignals(s => stops.push(s), proc, 'linux');
    proc.emit('SIGBREAK');
    proc.emit('SIGHUP');
    proc.emit('SIGTERM');
    expect(stops).toEqual(['SIGTERM']);
    expect(proc.listenerCount('SIGHUP')).toBe(0);
  });
});

/** The parts a stop closes, as fakes that record the order they were used in. */
function fakeParts(report: ControllerLogout[] = []) {
  const order: string[] = [];
  const exits: number[] = [];
  const log = recordingLog();
  const waits: number[] = [];
  const parts = {
    log,
    stream: { close: () => { order.push('stream'); } },
    fleet: {
      disconnectAll: vi.fn(async (opts: { waitMs: number }) => { waits.push(opts.waitMs); order.push('logout'); return report; }),
    },
    server: { close: vi.fn(async () => { order.push('server'); }) },
    writes: async () => { order.push('writes'); },
    exit: (code: number) => { order.push(`exit ${code}`); exits.push(code); },
  } satisfies StopParts;
  return { parts, order, exits, log, waits };
}

const logout = (id: string, outcome: ControllerLogout['outcome'], extra: Partial<ControllerLogout> = {}): ControllerLogout => ({
  id, name: id.toUpperCase(), host: '127.0.0.1', port: 9403, outcome, ...extra,
});

describe('DaemonStop', () => {
  it('closes the stream, logs out, closes the server, saves the config, then exits 0', async () => {
    const { parts, order, log } = fakeParts([logout('rw7', 'logged-out')]);
    await new DaemonStop(parts).stop('SIGTERM');
    expect(order).toEqual(['stream', 'logout', 'server', 'writes', 'exit 0']);
    expect(log.lines[0]).toMatchObject({ level: 'info', obj: { reason: 'SIGTERM' }, msg: 'stopping: logging out of every controller' });
    expect(log.lines.at(-1)).toMatchObject({ level: 'info', obj: { reason: 'SIGTERM' }, msg: 'stopped' });
  });

  it('replaying a recording: says there is no session to log out of, and has no logout step', async () => {
    const { parts, order, log } = fakeParts();
    await new DaemonStop({ ...parts, mode: 'replay' }).stop('SIGINT');
    expect(order).toEqual(['stream', 'server', 'writes', 'exit 0']);
    expect(parts.fleet.disconnectAll).not.toHaveBeenCalled();
    expect(log.lines[0]).toMatchObject({
      level: 'info', obj: { reason: 'SIGINT' }, msg: 'stopping: replaying a recording, no controller session to log out of',
    });
    expect(log.lines.map(l => l.msg)).not.toContain('no controllers configured; nothing to log out');
  });

  it('gives the logouts the whole wait but the reserve for closing', async () => {
    const { parts, waits } = fakeParts();
    await new DaemonStop(parts).stop('SIGINT');
    expect(waits).toEqual([STOP_WAIT_MS - STOP_RESERVE_MS]);
  });

  it('runs once: a second signal while stopping is logged and joins the stop under way', async () => {
    const { parts, exits, log } = fakeParts();
    const stop = new DaemonStop(parts);
    expect(stop.stopping).toBe(false);
    const first = stop.stop('SIGINT');
    const second = stop.stop('SIGBREAK');
    expect(stop.stopping).toBe(true);
    await Promise.all([first, second]);
    expect(parts.fleet.disconnectAll).toHaveBeenCalledTimes(1);
    expect(parts.server.close).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
    expect(log.lines.find(l => l.msg === 'already stopping')?.obj).toMatchObject({ reason: 'SIGBREAK' });
  });

  it('a logout that hangs cannot hold the process: it exits 1 when the wait is over, naming the step', async () => {
    vi.useFakeTimers();
    const { parts, exits, log } = fakeParts();
    parts.fleet.disconnectAll.mockImplementation(() => new Promise(() => {}));
    const stop = new DaemonStop(parts);
    void stop.stop('SIGHUP');
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS - 1);
    expect(exits).toEqual([]);
    expect(stop.exitWithinMs()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual([1]);
    expect(log.lines.find(l => l.level === 'error')).toMatchObject({
      obj: { reason: 'SIGHUP', step: 'logging out of the controllers' },
      msg: expect.stringContaining(`within ${STOP_WAIT_MS / 1000} s`),
    });
  });

  it('a server close that hangs is cut off the same way, and exits only once', async () => {
    vi.useFakeTimers();
    const { parts, exits, log } = fakeParts();
    parts.server.close.mockImplementation(() => new Promise(() => {}));
    void new DaemonStop(parts, { waitMs: 2_000 }).stop('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exits).toEqual([1]);
    expect(log.lines.find(l => l.level === 'error')?.obj).toMatchObject({ step: 'closing the server' });
  });

  it('a step that fails is logged and the stop goes on to the end', async () => {
    const { parts, order, exits, log } = fakeParts();
    parts.stream.close = () => { throw new Error('stream gone'); };
    parts.fleet.disconnectAll.mockImplementation(async () => { order.push('logout'); throw new Error('manager broke'); });
    parts.server.close.mockImplementation(async () => { order.push('server'); throw new Error('already closed'); });
    await new DaemonStop(parts).stop('SIGINT');
    expect(order).toEqual(['logout', 'server', 'writes', 'exit 0']);
    expect(exits).toEqual([0]);
    expect(log.lines.filter(l => l.level !== 'info').map(l => l.msg)).toEqual([
      'closing the stream failed', 'logging out of the controllers failed', 'closing the server failed',
    ]);
  });

  it('says how long until exit: the whole wait before the stop, what is left of it after', async () => {
    let t = 1_000;
    const { parts } = fakeParts();
    parts.fleet.disconnectAll.mockImplementation(() => new Promise(() => {}));
    const stop = new DaemonStop(parts, { now: () => t });
    expect(stop.exitWithinMs()).toBe(STOP_WAIT_MS);
    void stop.stop('SIGINT');
    t += 3_000;
    expect(stop.exitWithinMs()).toBe(STOP_WAIT_MS - 3_000);
  });
});

describe('logLogouts', () => {
  it('names each controller and what became of its session, then all of them by outcome', () => {
    const log = recordingLog();
    logLogouts(log, [
      logout('rw7', 'logged-out', { port: 9403 }),
      logout('rw6', 'logged-out', { port: 9404 }),
      logout('rw8', 'connect-cancelled'),
      logout('cell-2', 'not-connected'),
      logout('cell-3', 'timed-out'),
      logout('cell-4', 'failed', { error: 'socket hang up' }),
    ]);
    expect(log.lines.slice(0, 6).map(l => [l.level, l.obj.controller, l.msg])).toEqual([
      ['info', 'rw7', 'logged out'],
      ['info', 'rw6', 'logged out'],
      ['info', 'rw8', 'connect in progress cancelled; any session it had opened was logged out'],
      ['info', 'cell-2', 'not connected; no session to log out'],
      ['warn', 'cell-3', 'logout did not finish in time; the controller ends the session when it times out'],
      ['warn', 'cell-4', 'logout failed; the controller ends the session when it times out'],
    ]);
    expect(log.lines[1].obj).toEqual({ controller: 'rw6', host: '127.0.0.1', port: 9404 });
    expect(log.lines[5].obj.err).toBe('socket hang up');
    const summary = log.lines[6];
    expect(summary.level).toBe('warn');
    expect(summary.obj).toEqual({
      loggedOut: ['rw7', 'rw6'], connectCancelled: ['rw8'], notConnected: ['cell-2'], unfinished: ['cell-3', 'cell-4'],
    });
    expect(summary.msg).toBe('logged out of 2 of 6 controller(s), 1 connect(s) cancelled, 1 not connected;'
      + ' 2 logout(s) not confirmed: cell-3, cell-4');
  });

  it('an all-clean stop is one info line more; no controllers is said plainly', () => {
    const log = recordingLog();
    logLogouts(log, [logout('rw7', 'logged-out')]);
    expect(log.lines.at(-1)).toMatchObject({ level: 'info', msg: 'logged out of 1 of 1 controller(s)' });
    const empty = recordingLog();
    logLogouts(empty, []);
    expect(empty.lines).toMatchObject([{ level: 'info', msg: 'no controllers configured; nothing to log out' }]);
  });
});

// ── The fleet's side: disconnectAll reports each controller, within its wait ──

const cfgs: ControllerConfig[] = ['up-a', 'up-slow', 'down', 'connecting', 'broken'].map((id, i) => ({
  id, name: id.toUpperCase(), host: `10.0.0.${i + 1}`, port: 443, useHttps: true, username: 'Default User', password: SECRET,
}));

/** A fleet over fake managers: `up` says which links are connected; the logouts are the test's. */
function fleetOf(up: Set<string>, logoutOf: (id: string) => Promise<void>) {
  const f = new ControllerFleet(cfgs, recordingLog());
  const views = new Map(cfgs.map(c => [c.id, {
    currentPort: c.id === 'up-a' ? 9403 : c.port, currentUseHttps: true,
    state: { connected: up.has(c.id), quality: up.has(c.id) ? 'live' : 'disconnected', qualityReason: 'x' } as unknown as RobotState,
  }]));
  const inner = f as unknown as {
    managerOf: (id: string) => unknown;
    connecting: Set<string>;
    multi: { disconnectRobot: (id: string) => Promise<void>; connectRobot: (id: string) => Promise<void> };
  };
  inner.managerOf = id => views.get(id) ?? null;
  const loggedOut: string[] = [];
  inner.multi.disconnectRobot = async id => { loggedOut.push(id); return logoutOf(id); };
  const connects: string[] = [];
  inner.multi.connectRobot = async id => { connects.push(id); };
  return { f, loggedOut, connects, connecting: inner.connecting };
}

describe('ControllerFleet.disconnectAll', () => {
  it('logs out of every controller at once and reports each one; one that hangs is given up when the wait is over', async () => {
    vi.useFakeTimers();
    const { f, loggedOut, connecting } = fleetOf(new Set(['up-a', 'up-slow', 'broken']), async id => {
      if (id === 'up-slow') { return new Promise<void>(() => {}); }
      if (id === 'broken') { throw new Error(`logout refused; sent Authorization: Basic ${Buffer.from(`Default User:${SECRET}`).toString('base64')}`); }
    });
    connecting.add('connecting');
    const report = f.disconnectAll({ waitMs: 4_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(loggedOut).toEqual(['up-a', 'up-slow', 'down', 'connecting', 'broken']);   // side by side, not one after another
    await vi.advanceTimersByTimeAsync(4_000);
    const r = await report;
    expect(r.map(x => [x.id, x.outcome])).toEqual([
      ['up-a', 'logged-out'], ['up-slow', 'timed-out'], ['down', 'not-connected'], ['connecting', 'connect-cancelled'], ['broken', 'failed'],
    ]);
    expect(r[0]).toEqual({ id: 'up-a', name: 'UP-A', host: '10.0.0.1', port: 9403, outcome: 'logged-out' });   // the port the link was on
    expect(r[4].error).toBe('logout refused; sent Authorization: ***');   // credentials masked
  });

  it(`waits ${DISCONNECT_ALL_WAIT_MS / 1000} s at most by default`, async () => {
    vi.useFakeTimers();
    const { f } = fleetOf(new Set(['up-a']), () => new Promise<void>(() => {}));
    let done = false;
    const report = f.disconnectAll().then(r => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(DISCONNECT_ALL_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect((await report).every(x => x.outcome === 'timed-out')).toBe(true);
  });

  it('starts no connect afterwards: a controller added while stopping opens no session nobody would log out', async () => {
    const { f, connects } = fleetOf(new Set(), async () => {});
    await f.disconnectAll({ waitMs: 100 });
    f.add({ id: 'late', name: 'LATE', host: '10.0.0.9', port: 443, useHttps: true, username: 'u', password: SECRET });
    await f.connectAll();
    expect(connects).toEqual([]);
    expect(f.has('late')).toBe(true);   // kept in the config, connected on the next start
  });
});

// ── POST /v0/admin/shutdown ──

describe(`POST ${SHUTDOWN_PATH}`, () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  /** A stop that only records when it was asked, and whether the answer had left by then. */
  function fakeStop(raw: () => ServerResponse | null) {
    const calls: Array<{ reason: string; answered: boolean }> = [];
    let stopping = false;
    const stop: AdminDeps['stop'] & { calls: typeof calls } = {
      calls,
      get stopping() { return stopping; },
      exitWithinMs: () => (stopping ? 5_000 : STOP_WAIT_MS),
      stop: async reason => { stopping = true; calls.push({ reason, answered: raw()?.writableEnded ?? false }); },
    };
    return stop;
  }

  async function adminApp(accessToken: string | null) {
    const a = createServer({ accessToken });
    let raw: ServerResponse | null = null;
    a.addHook('onRequest', async (_req, reply) => { raw = reply.raw; });
    const stop = fakeStop(() => raw);
    await registerAdminRoutes(a, { stop });
    app = a;
    return { app: a, stop };
  }

  const nextTurn = () => new Promise(resolve => setImmediate(resolve));

  it('answers 202 first, and the stop begins once the answer has left', async () => {
    const { app: a, stop } = await adminApp(TOKEN);
    const res = await a.inject({ method: 'POST', url: SHUTDOWN_PATH, headers: LOCAL });
    expect(res.statusCode).toBe(202);
    expect(res.json<ShutdownAnswer>()).toEqual({ stopping: true, alreadyStopping: false, exitWithinMs: STOP_WAIT_MS });
    await nextTurn();
    expect(stop.calls).toEqual([{ reason: `POST ${SHUTDOWN_PATH}`, answered: true }]);
  });

  it('a second request while stopping says so and starts nothing new', async () => {
    const { app: a, stop } = await adminApp(TOKEN);
    await a.inject({ method: 'POST', url: SHUTDOWN_PATH, headers: LOCAL });
    await nextTurn();
    expect(stop.calls).toHaveLength(1);
    const again = await a.inject({ method: 'POST', url: SHUTDOWN_PATH, headers: LOCAL });
    expect(again.json<ShutdownAnswer>()).toEqual({ stopping: true, alreadyStopping: true, exitWithinMs: 5_000 });
  });

  it('needs the access token: without it, or with another, nothing stops', async () => {
    const { app: a, stop } = await adminApp(TOKEN);
    const missing = await a.inject({ method: 'POST', url: SHUTDOWN_PATH, headers: { host: '127.0.0.1:7810' } });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().code).toBe('TOKEN_MISSING');
    const wrong = await a.inject({ method: 'POST', url: SHUTDOWN_PATH, headers: { ...LOCAL, [TOKEN_HEADER]: 'x'.repeat(43) } });
    expect(wrong.json().code).toBe('TOKEN_INVALID');
    await nextTurn();
    expect(stop.calls).toEqual([]);
  });

  it('a page from another origin cannot stop it, token or not', async () => {
    const { app: a, stop } = await adminApp(TOKEN);
    const res = await a.inject({ method: 'POST', url: SHUTDOWN_PATH, headers: { ...LOCAL, origin: 'http://localhost:31337' } });
    expect(res.statusCode).toBe(403);
    await nextTurn();
    expect(stop.calls).toEqual([]);
  });

  it('a browser page cannot stop it, not even the panel`s or the daemon`s own: admin routes are for native clients', async () => {
    const { app: a, stop } = await adminApp(TOKEN);
    const browser = [
      { origin: 'http://127.0.0.1:5173' }, { origin: 'http://localhost:5173' }, { origin: 'http://127.0.0.1:7810' },
      { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' },
    ];
    for (const extra of browser) {
      const res = await a.inject({ method: 'POST', url: SHUTDOWN_PATH, headers: { ...LOCAL, ...extra } });
      expect(res.statusCode, JSON.stringify(extra)).toBe(403);
      expect(res.json(), JSON.stringify(extra)).toEqual({ error: expect.stringContaining('native'), code: 'ORIGIN_NOT_ALLOWED' });
    }
    // The panel's origin still reads everything else.
    expect((await a.inject({ method: 'GET', url: '/v0/health', headers: { ...LOCAL, origin: 'http://127.0.0.1:5173' } })).statusCode).toBe(200);
    await nextTurn();
    expect(stop.calls).toEqual([]);
  });

  it('a daemon built without a token refuses it outright rather than let anyone on loopback stop it', async () => {
    const { app: a, stop } = await adminApp(null);
    const res = await a.inject({ method: 'POST', url: SHUTDOWN_PATH, headers: { host: '127.0.0.1:7810' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: expect.stringContaining('access token'), code: 'TOKEN_REQUIRED' });
    // Routes without the flag stay open on such a server, as before.
    expect((await a.inject({ method: 'GET', url: '/v0/health', headers: { host: '127.0.0.1:7810' } })).statusCode).toBe(200);
    await nextTurn();
    expect(stop.calls).toEqual([]);
  });
});

// ── The whole path, over a real socket: request, answer, logouts, exit ──

describe('stop over HTTP, end to end', () => {
  it('the caller gets its answer, stream consumers are told, every controller is logged out and named, then exit 0', async () => {
    const { f, loggedOut } = fleetOf(new Set(['up-a', 'up-slow']), async () => {});
    const log = recordingLog();
    const hub = new SocketHub({ heartbeatMs: 0 });
    const stream = new SnapshotStream(f, hub);
    const consumer = new FakeSocket();
    hub.attach(consumer, '"snapshot"');
    const app = createServer({ accessToken: TOKEN });
    await registerStreamRoute(app, stream);
    let exitCode: number | null = null;
    const stopper = new DaemonStop({ log, stream, fleet: f, server: app, writes: async () => {}, exit: code => { exitCode = code; } });
    await registerAdminRoutes(app, { stop: stopper });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}${SHUTDOWN_PATH}`, { method: 'POST', headers: { [TOKEN_HEADER]: TOKEN } });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ stopping: true, alreadyStopping: false });

    await vi.waitFor(() => { expect(exitCode).toBe(0); }, { timeout: 5_000 });
    expect(consumer.closed).toEqual({ code: CLOSE_GOING_AWAY, reason: 'the daemon is stopping' });
    expect(loggedOut.sort()).toEqual(cfgs.map(c => c.id).sort());
    expect(log.lines.filter(l => l.msg === 'logged out').map(l => l.obj.controller)).toEqual(['up-a', 'up-slow']);
    expect(log.lines.find(l => l.obj.loggedOut)?.obj).toMatchObject({ loggedOut: ['up-a', 'up-slow'], unfinished: [] });
    expect(log.lines[0].obj).toMatchObject({ reason: `POST ${SHUTDOWN_PATH}` });
    expect(app.server.listening).toBe(false);
  });
});

describe('SocketHub.close (the stop)', () => {
  it('closes every consumer as going away, and any that arrives afterwards', () => {
    const hub = new SocketHub({ heartbeatMs: 0 });
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.attach(a, '"x"');
    hub.attach(b, '"x"');
    hub.close();
    expect([a.closed, b.closed]).toEqual([
      { code: CLOSE_GOING_AWAY, reason: 'the daemon is stopping' }, { code: CLOSE_GOING_AWAY, reason: 'the daemon is stopping' },
    ]);
    expect(hub.size).toBe(0);
    const late = new FakeSocket();
    expect(hub.attach(late, '"x"')).toBe(false);
    expect(late.sent).toEqual([]);
    expect(late.closed?.code).toBe(CLOSE_GOING_AWAY);
  });
});

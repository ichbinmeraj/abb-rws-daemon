import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createReplayDaemon, type ReplayDaemon, type ReplayDaemonOptions } from '../src/replayDaemon.js';
import { stopSignals } from '../src/stop.js';
import { RecordingBuilder } from './helpers/recording.js';
import { snapshotOf } from './helpers/recording-fakes.js';

/**
 * Allowed hosts in replay mode. A replaying daemon is built by
 * createReplayDaemon around the same server as a live one, so the extra host
 * names must reach it the same way: through its `server` options, and from the
 * command line (src/cli.ts) into those options.
 */

// Each case builds a daemon, and the command-line ones load the whole daemon anew; keep clear of the 5 s default under full-suite load.
vi.setConfig({ testTimeout: 60_000 });

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
/** How a container reaches a daemon on the host's loopback: under the name its runtime gives the host. */
const NAMED = 'host.docker.internal:7810';
const VARIABLE = 'ABB_RWS_DAEMON_ALLOWED_HOSTS';

let folder: string;
let recording: string;
let tokenFile: string;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'replay-allowed-hosts-'));
  tokenFile = join(folder, 'token');
  // A frames-only recording: one snapshot, one change, its end.
  const rw7 = (speed = 100) => snapshotOf('rw7', { sysId: 'sys-rw7', robotWare: '7.21.4+417', generation: 'rws2', check: 'confirmed', speed });
  const built = new RecordingBuilder({ label: 'hosts', content: ['frames'] })
    .snapshot(0, [rw7()]).delta(100, 'rw7', { panel: rw7(50).panel }).end(200);
  [recording] = await built.writeTo(join(folder, 'recordings'));
});
afterAll(async () => { await rm(folder, { recursive: true, force: true }); });

const open: ReplayDaemon[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) {
    d.stream.close();
    await d.app.close();
  }
});

/** A replaying daemon, built and not listening; closed after the test. */
async function replayDaemon(create: typeof createReplayDaemon, opts: Partial<ReplayDaemonOptions> & Pick<ReplayDaemonOptions, 'server'>): Promise<ReplayDaemon> {
  const daemon = await create({ target: recording, paused: true, exit: () => {}, ...opts });
  open.push(daemon);
  await daemon.app.ready();
  return daemon;
}

const get = (d: ReplayDaemon, url: string, headers: Record<string, string>) => d.app.inject({ method: 'GET', url, headers });

describe('a replaying daemon and the extra host names', () => {
  it('without server.allowedHosts the named Host is refused 421, as on a live daemon', async () => {
    const d = await replayDaemon(createReplayDaemon, { server: { accessToken: TOKEN, logger: false } });
    for (const url of ['/v0/health', '/v0/controllers', '/v0/replay']) {
      const res = await get(d, url, { host: NAMED, 'x-abb-rws-token': TOKEN });
      expect(res.statusCode, url).toBe(421);
      expect(res.json()).toEqual({ error: 'host not allowed', code: 'HOST_NOT_ALLOWED' });
    }
    expect((await get(d, '/v0/health', { host: '127.0.0.1:7810' })).statusCode).toBe(200);
  });

  it('with server.allowedHosts the named Host gets health 200, and the recording with the token only', async () => {
    const d = await replayDaemon(createReplayDaemon, { server: { accessToken: TOKEN, logger: false, allowedHosts: ['host.docker.internal'] } });
    const health = await get(d, '/v0/health', { host: NAMED });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', mode: 'replay', replay: { state: 'paused' } });

    for (const url of ['/v0/controllers', '/v0/replay']) {
      expect((await get(d, url, { host: NAMED })).statusCode, url).toBe(401);
      expect((await get(d, url, { host: NAMED, 'x-abb-rws-token': TOKEN })).statusCode, url).toBe(200);
    }
    const list = (await get(d, '/v0/controllers', { host: NAMED, 'x-abb-rws-token': TOKEN })).json();
    expect(list.controllers.map((c: { id: string }) => c.id)).toEqual(['rw7']);

    // Nothing else widened: another name, and a page served under the allowed one.
    expect((await get(d, '/v0/health', { host: 'gateway.docker.internal:7810' })).statusCode).toBe(421);
    const page = await get(d, '/v0/health', { host: NAMED, origin: `http://${NAMED}` });
    expect(page.statusCode).toBe(403);
    expect(page.json().code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('the stream of a replaying daemon opens under the named Host, with the token', async () => {
    const d = await replayDaemon(createReplayDaemon, { server: { accessToken: TOKEN, logger: false, allowedHosts: ['host.docker.internal'] } });
    let first!: (frame: string) => void;
    const snapshot = new Promise<string>(done => { first = done; });
    const ws = await d.app.injectWS('/v0/stream', { headers: { host: NAMED, 'x-abb-rws-token': TOKEN } },
      { onInit: sock => sock.once('message', m => first(String(m))) });
    expect(JSON.parse(await snapshot)).toMatchObject({ type: 'snapshot', controllers: [{ id: 'rw7' }] });
    ws.terminate();
    await expect(d.app.injectWS('/v0/stream', { headers: { host: NAMED } })).rejects.toThrow(/401/);
  });

  it('a name that is not a host name stops the replaying daemon as it is built, and leaves nothing open', async () => {
    for (const [bad, message] of [['192.0.2.5', /is an IP address/], ['0x7f000001', /ends in a number/], ['*', /is a wildcard/]] as Array<[string, RegExp]>) {
      await expect(createReplayDaemon({
        target: recording, exit: () => {}, server: { accessToken: TOKEN, logger: false, allowedHosts: [bad] },
      }), bad).rejects.toThrow(message);
    }
  });
});

class Exit extends Error {
  constructor(readonly code: number | undefined) { super(`exit ${String(code)}`); }
}

/** One line of the daemon's log, as the stand-in server below takes it. */
interface Line { level: string; obj: Record<string, unknown>; msg: string }

describe('the command line in replay mode hands the extra host names on', () => {
  const VARS = [
    VARIABLE, 'ABB_RWS_DAEMON_PANEL_ORIGINS', 'ABB_RWS_DAEMON_LOG', 'ABB_RWS_DAEMON_RECORD', 'ABB_RWS_DAEMON_RECORD_DIR',
    'ABB_RWS_DAEMON_REPLAY', 'ABB_RWS_DAEMON_REPLAY_SPEED', 'ABB_RWS_DAEMON_REPLAY_LOOP', 'ABB_RWS_DAEMON_REPLAY_PARTS',
    'ABB_RWS_DAEMON_CONFIG', 'ABB_RWS_DAEMON_PORT', 'ABB_RWS_DAEMON_TOKEN_FILE',
  ];
  const savedArgv = process.argv;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const v of VARS) { savedEnv.set(v, process.env[v]); delete process.env[v]; }
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as typeof process.exit);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    // Belt and braces: nothing in this file listens anywhere.
    vi.spyOn(net.Server.prototype, 'listen').mockImplementation(() => { throw new Error('the daemon must not listen in this test'); });
  });

  afterEach(() => {
    process.argv = savedArgv;
    for (const [v, value] of savedEnv) { if (value === undefined) { delete process.env[v]; } else { process.env[v] = value; } }
    vi.doUnmock('../src/token.js');
    vi.doUnmock('../src/replayDaemon.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /**
   * Run the command line with `--replay` and `args`. createReplayDaemon is
   * replaced by one that keeps the options it is called with and hands back a
   * daemon that cannot listen, so the command line logs its start lines and
   * exits 1; the token is handed over without a file.
   */
  async function launch(args: string[], env: Record<string, string> = {}): Promise<{ code: number | undefined; calls: ReplayDaemonOptions[]; lines: Line[] }> {
    const calls: ReplayDaemonOptions[] = [];
    const lines: Line[] = [];
    const log = Object.fromEntries(['fatal', 'error', 'warn', 'info', 'debug', 'trace'].map(level => [level, (a: unknown, b?: string) => {
      lines.push(typeof a === 'string' ? { level, obj: {}, msg: a } : { level, obj: a as Record<string, unknown>, msg: b ?? '' });
    }]));
    vi.resetModules();
    vi.doMock('../src/token.js', async () => ({
      ...await vi.importActual<typeof import('../src/token.js')>('../src/token.js'),
      loadOrCreateToken: async () => ({ token: TOKEN, created: false }),
    }));
    vi.doMock('../src/replayDaemon.js', async () => ({
      ...await vi.importActual<typeof import('../src/replayDaemon.js')>('../src/replayDaemon.js'),
      createReplayDaemon: async (opts: ReplayDaemonOptions) => {
        calls.push(opts);
        return { app: { log, listen: async () => { throw new Error('no listening in this test'); } }, stop: { stop: async () => {} } };
      },
    }));
    // The command line hooks the stop signals and the process's last errors; those listeners are this test's to remove.
    const hooked = [...stopSignals(), 'uncaughtExceptionMonitor'] as const;
    const before = new Map(hooked.map(name => [name, new Set(process.listeners(name as NodeJS.Signals))]));
    for (const [k, v] of Object.entries(env)) { process.env[k] = v; }
    process.argv = [process.execPath, 'abb-rws-daemon', '--token-file', tokenFile, ...args];
    try {
      await import('../src/cli.js');
    } catch (e) {
      if (e instanceof Exit) {
        expect(existsSync(tokenFile), 'the token is handed over, never written').toBe(false);
        return { code: e.code, calls, lines };
      }
      throw e;
    } finally {
      for (const k of Object.keys(env)) { delete process.env[k]; }
      for (const name of hooked) {
        for (const l of process.listeners(name as NodeJS.Signals)) {
          if (!before.get(name)!.has(l)) { process.removeListener(name, l); }
        }
      }
    }
    throw new Error(`the daemon started with ${args.join(' ')}`);
  }

  const hostLines = (lines: Line[]) => lines.filter(l => /Host header/.test(l.msg));

  it('--replay with --allowed-hosts: createReplayDaemon is called with the names in its server options, and one WARN line names them', async () => {
    const r = await launch(['--replay', recording, '--allowed-hosts', 'Host.Docker.Internal']);
    expect(r.code).toBe(1);
    expect(r.lines.filter(l => l.level === 'error').map(l => l.msg)).toEqual(['no listening in this test']);

    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].target).toBe(resolve(recording));
    expect(r.calls[0].server.allowedHosts).toEqual(['host.docker.internal']);
    expect(r.calls[0].server.accessToken).toBe(TOKEN);

    const said = hostLines(r.lines);
    expect(said).toHaveLength(1);
    expect(said[0].level).toBe('warn');
    expect(said[0].obj).toEqual({ allowedHosts: ['host.docker.internal'], source: '--allowed-hosts' });
    expect(said[0].msg).toBe('extra host names accepted in the Host header (--allowed-hosts): host.docker.internal; '
      + 'the access token is still required, and the daemon still listens on 127.0.0.1 only');
    expect(JSON.stringify(r.lines)).not.toContain(TOKEN);

    // The very options the command line built, given to the real createReplayDaemon: the named Host is served.
    const actual = await vi.importActual<typeof import('../src/replayDaemon.js')>('../src/replayDaemon.js');
    const d = await replayDaemon(actual.createReplayDaemon, { ...r.calls[0], server: { ...r.calls[0].server, logger: false }, exit: () => {} });
    expect((await get(d, '/v0/health', { host: NAMED })).json()).toMatchObject({ status: 'ok', mode: 'replay' });
    expect((await get(d, '/v0/controllers', { host: NAMED })).statusCode).toBe(401);
    expect((await get(d, '/v0/controllers', { host: NAMED, 'x-abb-rws-token': TOKEN })).statusCode).toBe(200);
    expect((await get(d, '/v0/health', { host: 'other.docker.internal:7810' })).statusCode).toBe(421);
  });

  it('the variables alone: ABB_RWS_DAEMON_REPLAY with ABB_RWS_DAEMON_ALLOWED_HOSTS hands the names on, and the line names the variable', async () => {
    const r = await launch([], { ABB_RWS_DAEMON_REPLAY: recording, [VARIABLE]: 'host.docker.internal, gateway.docker.internal' });
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].server.allowedHosts).toEqual(['host.docker.internal', 'gateway.docker.internal']);
    const said = hostLines(r.lines);
    expect(said).toHaveLength(1);
    expect(said[0].level).toBe('warn');
    expect(said[0].obj).toEqual({ allowedHosts: ['host.docker.internal', 'gateway.docker.internal'], source: 'ABB_RWS_DAEMON_ALLOWED_HOSTS' });
    expect(said[0].msg).toMatch(/\(ABB_RWS_DAEMON_ALLOWED_HOSTS\): host\.docker\.internal, gateway\.docker\.internal; the access token is still required/);
  });

  it('--replay alone: no name is handed on and no line is logged; the named Host stays refused', async () => {
    const r = await launch(['--replay', recording]);
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].server.allowedHosts).toBeUndefined();
    expect(hostLines(r.lines)).toEqual([]);

    const actual = await vi.importActual<typeof import('../src/replayDaemon.js')>('../src/replayDaemon.js');
    const d = await replayDaemon(actual.createReplayDaemon, { ...r.calls[0], server: { ...r.calls[0].server, logger: false }, exit: () => {} });
    expect((await get(d, '/v0/health', { host: NAMED })).statusCode).toBe(421);
    expect((await get(d, '/v0/health', { host: '127.0.0.1:7810' })).statusCode).toBe(200);
  });
});

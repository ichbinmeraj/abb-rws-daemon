import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerOptions } from '../src/server.js';

/**
 * --allowed-hosts and ABB_RWS_DAEMON_ALLOWED_HOSTS at launch. Each case runs
 * the command line itself (src/cli.ts) in this process, with the process's
 * exit and its error output caught. A bad value must be refused before
 * anything is read or made - no token file, no config, no server. A good one
 * must reach the server's options and be named in one warning.
 */

// Every launch loads the whole daemon anew, and a case makes many; keep well clear of the 5 s default under full-suite load.
vi.setConfig({ testTimeout: 120_000 });

class Exit extends Error {
  constructor(readonly code: number | undefined) { super(`exit ${String(code)}`); }
}

const VARS = [
  'ABB_RWS_DAEMON_ALLOWED_HOSTS', 'ABB_RWS_DAEMON_PANEL_ORIGINS', 'ABB_RWS_DAEMON_LOG',
  'ABB_RWS_DAEMON_RECORD', 'ABB_RWS_DAEMON_RECORD_DIR', 'ABB_RWS_DAEMON_REPLAY', 'ABB_RWS_DAEMON_REPLAY_SPEED',
  'ABB_RWS_DAEMON_REPLAY_LOOP', 'ABB_RWS_DAEMON_REPLAY_PARTS', 'ABB_RWS_DAEMON_CONFIG', 'ABB_RWS_DAEMON_PORT',
  'ABB_RWS_DAEMON_TOKEN_FILE',
];

/** The access token of the cases that get as far as a server; never written to a file. */
const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const VARIABLE = 'ABB_RWS_DAEMON_ALLOWED_HOSTS';

let scratch: string;
let tokenFile: string;
let configFile: string;
let brokenConfig: string;
let recording: string;
const savedArgv = process.argv;
const savedEnv = new Map<string, string | undefined>();
let errors: string[] = [];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cli-allowed-hosts-'));
  tokenFile = join(scratch, 'token');
  configFile = join(scratch, 'none.config.json');
  brokenConfig = join(scratch, 'broken.config.json');
  recording = join(scratch, 'rec-20261004T153012Z-p0001.jsonl');
  await writeFile(brokenConfig, 'not a config');
  await writeFile(recording, '');
});
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

beforeEach(() => {
  for (const v of VARS) { savedEnv.set(v, process.env[v]); delete process.env[v]; }
  errors = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as typeof process.exit);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write);
  // Belt and braces: a daemon that got past its checks must not listen anywhere.
  vi.spyOn(net.Server.prototype, 'listen').mockImplementation(() => { throw new Error('the daemon must not start in this test'); });
});

afterEach(() => {
  process.argv = savedArgv;
  for (const [v, value] of savedEnv) { if (value === undefined) { delete process.env[v]; } else { process.env[v] = value; } }
  vi.doUnmock('../src/token.js');
  vi.doUnmock('../src/server.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

/** Start the daemon with `args` (and `env`); resolves with the exit code and what it wrote, or throws when it started. */
async function launch(args: string[], env: Record<string, string> = {}): Promise<{ code: number | undefined; message: string }> {
  errors = [];
  for (const [k, v] of Object.entries(env)) { process.env[k] = v; }
  process.argv = [process.execPath, 'abb-rws-daemon', '--token-file', tokenFile, ...args];
  vi.resetModules();
  try {
    await import('../src/cli.js');
  } catch (e) {
    if (e instanceof Exit) {
      expect(existsSync(tokenFile), 'nothing may be made before the checks').toBe(false);
      expect(existsSync(configFile), 'nothing may be made before the checks').toBe(false);
      return { code: e.code, message: errors.join('') };
    }
    throw e;
  } finally {
    for (const k of Object.keys(env)) { delete process.env[k]; }
  }
  throw new Error(`the daemon started with ${args.join(' ')}`);
}

const live = (...args: string[]) => ['--config', configFile, ...args];
const replaying = (...args: string[]) => ['--replay', recording, ...args];

/** Every kind of value that is no list of host names, and what the daemon says about it. */
const BAD: Array<[string, RegExp]> = [
  ['127.0.0.2', /allowed host "127\.0\.0\.2" is an IP address/],
  ['2130706433', /allowed host "2130706433" ends in a number/],
  ['0x7f.1', /ends in a number/],
  ['0x7f000001', /ends in a number/],
  ['[::1]', /is a loopback name, which is always accepted/],
  ['host.docker.internal:7810', /carries a port/],
  ['http://host.docker.internal', /carries a scheme/],
  ['host.docker.internal/v0', /carries a path/],
  ['*.docker.internal', /is a wildcard/],
  ['host.docker.internal.', /ends in a dot/],
  ['host_docker_internal', /is not a DNS host name/],
  ['host.docker.internal,', /an allowed host is empty/],
  ['host.docker.internal,192.0.2.5', /allowed host "192\.0\.2\.5" is an IP address/],
  [Array.from({ length: 9 }, (_, i) => `host-${i}.example`).join(','), /at most 8 allowed hosts are taken, not 9/],
];

describe('a bad --allowed-hosts value stops the launch, before anything is read or made', () => {
  it('from the option: exit 1, naming the option and what is wrong with the entry', async () => {
    for (const [value, message] of BAD) {
      const r = await launch(live('--allowed-hosts', value));
      expect(r.code, value).toBe(1);
      expect(r.message, value).toMatch(/^abb-rws-daemon: --allowed-hosts: /);
      expect(r.message, value).toMatch(message);
    }
  });

  it('from the variable: exit 1, naming the variable and what is wrong with the entry', async () => {
    for (const [value, message] of BAD) {
      const r = await launch(live(), { [VARIABLE]: value });
      expect(r.code, value).toBe(1);
      expect(r.message, value).toMatch(/^abb-rws-daemon: ABB_RWS_DAEMON_ALLOWED_HOSTS: /);
      expect(r.message, value).toMatch(message);
    }
  });

  it('a replaying daemon is stopped the same way, before it reads the recording', async () => {
    const some = ['127.0.0.2', '2130706433', 'host.docker.internal:7810', '*.docker.internal'];
    for (const [value, message] of BAD.filter(([v]) => some.includes(v))) {
      const byOption = await launch(replaying('--allowed-hosts', value));
      expect(byOption.code, value).toBe(1);
      expect(byOption.message, value).toMatch(/--allowed-hosts: /);
      expect(byOption.message, value).toMatch(message);
      const byVariable = await launch(replaying(), { [VARIABLE]: value });
      expect(byVariable.code, value).toBe(1);
      expect(byVariable.message, value).toMatch(/ABB_RWS_DAEMON_ALLOWED_HOSTS: /);
      expect(byVariable.message, value).toMatch(message);
    }
    const allByVariables = await launch([], { ABB_RWS_DAEMON_REPLAY: recording, [VARIABLE]: '198.51.100.20' });
    expect(allByVariables.code).toBe(1);
    expect(allByVariables.message).toMatch(/ABB_RWS_DAEMON_ALLOWED_HOSTS: allowed host "198\.51\.100\.20" is an IP address/);
  });

  it('the option without its value is refused, not read as "no extra hosts"', async () => {
    const cases: string[][] = [
      live('--allowed-hosts'), live('--allowed-hosts', ''), live('--allowed-hosts', '   '),
      ['--allowed-hosts', '--config', configFile], replaying('--allowed-hosts'), ['--allowed-hosts', '--replay', recording],
    ];
    for (const args of cases) {
      const r = await launch(args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.message, args.join(' ')).toMatch(/--allowed-hosts needs a value/);
    }
  });

  it('the option is the one read when both are given: a bad option is refused though the variable is good', async () => {
    const r = await launch(live('--allowed-hosts', '192.0.2.5'), { [VARIABLE]: 'host.docker.internal' });
    expect(r.code).toBe(1);
    expect(r.message).toMatch(/--allowed-hosts: allowed host "192\.0\.2\.5" is an IP address/);
    expect(r.message).not.toMatch(/ABB_RWS_DAEMON_ALLOWED_HOSTS/);
  });
});

/** One line of the daemon's log, as the fake server below takes it. */
interface Line { level: string; obj: Record<string, unknown>; msg: string }

/**
 * Start a live daemon whose config file cannot be read: it gets as far as its
 * server and its first log lines, then stops (exit 1) before it builds a
 * fleet. The server is a stand-in that keeps the options it was built with
 * and the lines logged to it; the token is handed over without a file.
 */
async function startLive(args: string[], env: Record<string, string> = {}): Promise<{ code: number | undefined; options: ServerOptions[]; lines: Line[] }> {
  const options: ServerOptions[] = [];
  const lines: Line[] = [];
  const log = Object.fromEntries(['fatal', 'error', 'warn', 'info', 'debug', 'trace'].map(level => [level, (a: unknown, b?: string) => {
    lines.push(typeof a === 'string' ? { level, obj: {}, msg: a } : { level, obj: a as Record<string, unknown>, msg: b ?? '' });
  }]));
  vi.resetModules();
  vi.doMock('../src/token.js', async () => ({
    ...await vi.importActual<typeof import('../src/token.js')>('../src/token.js'),
    loadOrCreateToken: async () => ({ token: TOKEN, created: false }),
  }));
  vi.doMock('../src/server.js', async () => ({
    ...await vi.importActual<typeof import('../src/server.js')>('../src/server.js'),
    createServer: (opts: ServerOptions) => { options.push(opts); return { log }; },
  }));
  // The daemon hands its log every error that would end the process; that listener is this test's to remove.
  const before = new Set(process.listeners('uncaughtExceptionMonitor'));
  for (const [k, v] of Object.entries(env)) { process.env[k] = v; }
  process.argv = [process.execPath, 'abb-rws-daemon', '--token-file', tokenFile, '--config', brokenConfig, ...args];
  try {
    await import('../src/cli.js');
  } catch (e) {
    if (e instanceof Exit) {
      expect(existsSync(tokenFile), 'the token is handed over, never written').toBe(false);
      return { code: e.code, options, lines };
    }
    throw e;
  } finally {
    for (const k of Object.keys(env)) { delete process.env[k]; }
    for (const l of process.listeners('uncaughtExceptionMonitor')) {
      if (!before.has(l)) { process.removeListener('uncaughtExceptionMonitor', l); }
    }
  }
  throw new Error(`the daemon started with ${args.join(' ')}`);
}

const hostLines = (lines: Line[]) => lines.filter(l => /Host header/.test(l.msg));

describe('a good --allowed-hosts value reaches the live server and is logged once', () => {
  it('from the option: the names, trimmed and in lower case, are the server`s allowedHosts, and one WARN line names them', async () => {
    const r = await startLive(['--allowed-hosts', ' Host.Docker.Internal , gateway.docker.internal']);
    // It stopped where this test makes it stop: at the config file, after the server was built.
    expect(r.code).toBe(1);
    expect(r.lines.filter(l => l.level === 'error').map(l => l.msg)).toEqual([expect.stringMatching(/is not valid JSON/)]);

    expect(r.options).toHaveLength(1);
    expect(r.options[0].allowedHosts).toEqual(['host.docker.internal', 'gateway.docker.internal']);
    expect(r.options[0].accessToken).toBe(TOKEN);

    const said = hostLines(r.lines);
    expect(said).toHaveLength(1);
    expect(said[0].level).toBe('warn');
    expect(said[0].obj).toEqual({ allowedHosts: ['host.docker.internal', 'gateway.docker.internal'], source: '--allowed-hosts' });
    expect(said[0].msg).toBe('extra host names accepted in the Host header (--allowed-hosts): host.docker.internal, gateway.docker.internal; '
      + 'the access token is still required, and the daemon still listens on 127.0.0.1 only');
    expect(JSON.stringify(r.lines)).not.toContain(TOKEN);

    // The options the command line built, given to the real server: the names pass the Host check and nothing more.
    const { createServer } = await vi.importActual<typeof import('../src/server.js')>('../src/server.js');
    const app = createServer({ ...r.options[0], logger: false });
    try {
      app.get('/v0/controllers', async () => ({ controllers: [] }));
      const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });
      expect((await get('/v0/health', { host: 'host.docker.internal:7810' })).statusCode).toBe(200);
      expect((await get('/v0/health', { host: 'gateway.docker.internal:7810' })).statusCode).toBe(200);
      expect((await get('/v0/controllers', { host: 'host.docker.internal:7810' })).statusCode).toBe(401);
      expect((await get('/v0/controllers', { host: 'host.docker.internal:7810', 'x-abb-rws-token': TOKEN })).statusCode).toBe(200);
      expect((await get('/v0/health', { host: 'other.docker.internal:7810' })).statusCode).toBe(421);
      expect((await get('/v0/health', { host: 'host.docker.internal:7810', origin: 'http://host.docker.internal:7810' })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('from the variable: the same, and the line names the variable', async () => {
    const r = await startLive([], { [VARIABLE]: 'host.docker.internal' });
    expect(r.code).toBe(1);
    expect(r.options).toHaveLength(1);
    expect(r.options[0].allowedHosts).toEqual(['host.docker.internal']);
    const said = hostLines(r.lines);
    expect(said).toHaveLength(1);
    expect(said[0].level).toBe('warn');
    expect(said[0].obj).toEqual({ allowedHosts: ['host.docker.internal'], source: 'ABB_RWS_DAEMON_ALLOWED_HOSTS' });
    expect(said[0].msg).toMatch(/\(ABB_RWS_DAEMON_ALLOWED_HOSTS\): host\.docker\.internal; the access token is still required/);
    expect(said[0].msg).toMatch(/still listens on 127\.0\.0\.1 only$/);
  });

  it('the option wins over the variable', async () => {
    const r = await startLive(['--allowed-hosts', 'host.docker.internal'], { [VARIABLE]: 'gateway.docker.internal' });
    expect(r.options[0].allowedHosts).toEqual(['host.docker.internal']);
    expect(hostLines(r.lines).map(l => l.obj.source)).toEqual(['--allowed-hosts']);
  });

  it('off by default: without the option and the variable, and with an empty variable, no name is added and no line is logged', async () => {
    const plain = await startLive([]);
    expect(plain.code).toBe(1);
    expect(plain.options).toHaveLength(1);
    expect(plain.options[0].allowedHosts).toBeUndefined();
    expect(hostLines(plain.lines)).toEqual([]);

    const empty = await startLive([], { [VARIABLE]: '' });
    expect(empty.options[0].allowedHosts).toBeUndefined();
    expect(hostLines(empty.lines)).toEqual([]);
  });
});

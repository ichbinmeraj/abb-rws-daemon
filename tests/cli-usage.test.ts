import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helpText } from '../src/cliOptions.js';
import { SCHEMA_VERSION } from '../src/schema/v0.js';

/**
 * --help, --version and a command line the daemon does not understand. Each
 * case runs the command line itself (src/cli.ts) in this process, with the
 * process's exit and its output caught. Every case must end before anything
 * is read or made: no token file, no config, no recording, no server.
 */

// The first case compiles the whole daemon; keep clear of the 5 s default under full-suite load.
vi.setConfig({ testTimeout: 60_000 });

class Exit extends Error {
  constructor(readonly code: number | undefined) { super(`exit ${String(code)}`); }
}

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const UNKNOWN_TAIL = '; abb-rws-daemon --help lists the options';

let scratch: string;
let tokenFile: string;
let configFile: string;
const savedArgv = process.argv;
const savedEnv = new Map<string, string | undefined>();
let out: string[] = [];
let errors: string[] = [];
let listen: MockInstance;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cli-usage-'));
  tokenFile = join(scratch, 'token');
  configFile = join(scratch, 'none.config.json');
});
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

beforeEach(() => {
  // Nothing of the machine's own daemon settings reaches a case.
  for (const v of Object.keys(process.env).filter(k => k.startsWith('ABB_RWS_DAEMON_'))) {
    savedEnv.set(v, process.env[v]);
    delete process.env[v];
  }
  out = [];
  errors = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as typeof process.exit);
  // The command line waits for its help or version text to be written before it exits: the write is told done.
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out.push(String(chunk));
    const done = rest.find(r => typeof r === 'function') as (() => void) | undefined;
    done?.();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write);
  // Belt and braces: a daemon that got past its checks must not listen anywhere.
  listen = vi.spyOn(net.Server.prototype, 'listen').mockImplementation(() => { throw new Error('the daemon must not start in this test'); });
});

afterEach(() => {
  process.argv = savedArgv;
  for (const k of Object.keys(process.env).filter(v => v.startsWith('ABB_RWS_DAEMON_'))) { delete process.env[k]; }
  for (const [v, value] of savedEnv) { if (value !== undefined) { process.env[v] = value; } }
  savedEnv.clear();
  vi.restoreAllMocks();
});

interface Outcome { code: number | undefined; out: string; err: string }

/**
 * Start the daemon with exactly `args` (and `env`). The token file and the
 * config are named through the environment, in a folder that must stay
 * empty. Resolves with the exit code and what was written; throws when the
 * daemon started.
 */
async function launch(args: string[], env: Record<string, string> = {}): Promise<Outcome> {
  process.env.ABB_RWS_DAEMON_TOKEN_FILE = tokenFile;
  process.env.ABB_RWS_DAEMON_CONFIG = configFile;
  for (const [k, v] of Object.entries(env)) { process.env[k] = v; }
  process.argv = [process.execPath, 'abb-rws-daemon', ...args];
  out = [];
  errors = [];
  vi.resetModules();
  try {
    await import('../src/cli.js');
  } catch (e) {
    if (e instanceof Exit) {
      expect(existsSync(tokenFile), 'no token file may be made').toBe(false);
      expect(await readdir(scratch), 'nothing may be made').toEqual([]);
      expect(listen, 'the daemon must not listen').not.toHaveBeenCalled();
      return { code: e.code, out: out.join(''), err: errors.join('') };
    }
    throw e;
  } finally {
    for (const k of Object.keys(env)) { delete process.env[k]; }
  }
  throw new Error(`the daemon started with ${args.join(' ')}`);
}

/** The daemon refused `args` with exactly `message`, on the error output, with exit code 1. */
async function refused(args: string[], message: string, env: Record<string, string> = {}): Promise<void> {
  const r = await launch(args, env);
  expect(r.err, args.join(' ')).toBe(`abb-rws-daemon: ${message}\n`);
  expect(r.code, args.join(' ')).toBe(1);
  expect(r.out, args.join(' ')).toBe('');
}

describe('--help', () => {
  it('prints the help text and exits 0, as --help and as -h', async () => {
    for (const flag of ['--help', '-h']) {
      const r = await launch([flag]);
      expect(r.code, flag).toBe(0);
      expect(r.out, flag).toBe(helpText(VERSION));
      expect(r.err, flag).toBe('');
    }
  });

  it('wins over everything else on the command line', async () => {
    for (const args of [
      ['--bogus', '--help'], ['--help', '--bogus'], ['start', '-h'], ['--port', '1', '--port', '2', '--help'],
      ['--record=1', '--help'], ['--config', '--help'], ['--help', '--version'], ['--replay', '--help'],
    ]) {
      const r = await launch(args);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.out, args.join(' ')).toBe(helpText(VERSION));
      expect(r.err, args.join(' ')).toBe('');
    }
  });

  it('works whatever the environment holds', async () => {
    for (const env of [
      { ABB_RWS_DAEMON_RECORD: '1' }, { ABB_RWS_DAEMON_PORT: 'eighty' }, { ABB_RWS_DAEMON_REPLAY_LOOP: 'maybe' },
      { ABB_RWS_DAEMON_REPLAY: join(tmpdir(), 'no-such-recording') },
    ]) {
      const r = await launch(['--help'], env);
      expect(r.code, Object.keys(env).join(' ')).toBe(0);
      expect(r.out).toBe(helpText(VERSION));
    }
  });
});

describe('--version', () => {
  it('prints two lines and exits 0, as --version and as -v', async () => {
    for (const flag of ['--version', '-v']) {
      const r = await launch([flag]);
      expect(r.code, flag).toBe(0);
      expect(r.err, flag).toBe('');
      const lines = r.out.split('\n');
      expect(lines.length, flag).toBe(3);
      expect(lines[0]).toBe(`abb-rws-daemon ${VERSION}`);
      expect(lines[1]).toMatch(/^snapshot schema \d+\.\d+, abb-rws-client \d+\.\d+\.\d+\S*, Node\.js v\d+\.\d+\.\d+$/);
      expect(lines[1]).toContain(`snapshot schema ${SCHEMA_VERSION},`);
      expect(lines[1]).toContain(`Node.js ${process.version}`);
      expect(lines[2]).toBe('');
    }
  });

  it('wins over a command line that would be refused, and over the environment', async () => {
    for (const args of [['--bogus', '--version'], ['-v', 'start'], ['--port', '--version'], ['--record=1', '-v']]) {
      const r = await launch(args);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.out, args.join(' ')).toMatch(new RegExp(`^abb-rws-daemon ${VERSION.replace(/[.+]/g, '\\$&')}\n`));
    }
    const r = await launch(['--version'], { ABB_RWS_DAEMON_RECORD: '1' });
    expect(r.code).toBe(0);
  });
});

describe('a command line the daemon does not understand', () => {
  it('an unknown option is refused, whatever its name', async () => {
    await refused(['--bogus'], `unknown option --bogus${UNKNOWN_TAIL}`);
    await refused(['--prot', '7811'], `unknown option --prot${UNKNOWN_TAIL}`);
    await refused(['--verbose'], `unknown option --verbose${UNKNOWN_TAIL}`);
    await refused(['-p', '7811'], `unknown option -p${UNKNOWN_TAIL}`);
    await refused(['--bogus=1'], `unknown option --bogus${UNKNOWN_TAIL}`);
    await refused(['-help'], `unknown option -help${UNKNOWN_TAIL}`);
  });

  it('an option without its value is refused, whatever the option', async () => {
    await refused(['--port'], '--port needs a value');
    await refused(['--port='], '--port needs a value');
    await refused(['--config', '--port', '7811'], '--config needs a value');
    await refused(['--token-file'], '--token-file needs a value');
    await refused(['--panel-origins', ''], '--panel-origins needs a value');
  });

  it('--record=1 is refused: --record takes no value', async () => {
    await refused(['--record=1'], '--record takes no value');
    await refused(['--replay-loop=1'], '--replay-loop takes no value');
  });

  it('an option given twice is refused', async () => {
    await refused(['--port', '1', '--port', '2'], '--port is given twice');
    await refused(['--port=7811', '--port', '7811'], '--port is given twice');
    await refused(['--record', '--record'], '--record is given twice');
  });

  it('a bare word is refused', async () => {
    await refused(['start'], 'unexpected argument "start"; options start with --');
    await refused(['--record', 'on'], 'unexpected argument "on"; options start with --');
    await refused(['help'], 'unexpected argument "help"; options start with --');
  });

  it('the first problem on the command line is the one named', async () => {
    await refused(['--bogus', '--port'], `unknown option --bogus${UNKNOWN_TAIL}`);
    await refused(['--port', '--bogus'], '--port needs a value');
  });

  it('a variable that would start a recording is still refused first', async () => {
    const r = await launch(['--bogus'], { ABB_RWS_DAEMON_RECORD: '1' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^abb-rws-daemon: ABB_RWS_DAEMON_RECORD is set/);
  });
});

describe('--option=value', () => {
  it('--port=7811 is accepted as far as the next check', async () => {
    await refused(['--port=7811', '--replay-loop'], '--replay-loop needs --replay');
  });

  it('the value after = is the option`s value', async () => {
    await refused(['--port=99999'], 'invalid port: 99999');
    await refused(['--port=-1'], 'invalid port: -1');
    await refused(['--record', '--record-label=Not-A-Label'],
      '--record-label takes 1 to 32 lowercase letters, digits or hyphens, not "Not-A-Label"');
    await refused([`--replay=${join(tmpdir(), 'no-such-recording')}`, '--record'],
      '--record cannot be used with --replay: a replaying daemon reaches no controller and records nothing');
  });

  it('--port -1 takes -1 as the value, and the port check refuses it', async () => {
    await refused(['--port', '-1'], 'invalid port: -1');
  });
});

describe('a value that only looks like a number', () => {
  it('a port is plain digits: no other spelling of a number names one', async () => {
    for (const odd of ['0x1F91', '1e4', '7848.0', '+7850', '0b1111010101000', '78 49', '7811abc']) {
      await refused(['--port', odd], `invalid port: ${odd}`);
      await refused([], `invalid port: ${odd}`, { ABB_RWS_DAEMON_PORT: odd });
    }
    await refused(['--port', '0'], 'invalid port: 0');
    await refused(['--port', '65536'], 'invalid port: 65536');
  });

  it('a replay speed is a plain decimal number', async () => {
    const recording = join(tmpdir(), 'no-such-recording');
    for (const odd of ['0x2', '1e1', '+2', '2x', 'Infinity']) {
      await refused(['--replay', recording, '--replay-speed', odd], `the replay speed must be a number from 0.1 to 50, not "${odd}"`);
    }
  });
});

describe('ABB_RWS_DAEMON_LOG', () => {
  it('a word that is no log level stops the daemon at launch, before anything is made', async () => {
    const levels = 'fatal, error, warn, info, debug, trace, silent';
    await refused([], `ABB_RWS_DAEMON_LOG must be one of ${levels}, not "loud"`, { ABB_RWS_DAEMON_LOG: 'loud' });
    await refused([], `ABB_RWS_DAEMON_LOG must be one of ${levels}, not "INFO"`, { ABB_RWS_DAEMON_LOG: 'INFO' });
  });

  it('a level, and an empty value, are taken: the launch goes on to its next check', async () => {
    for (const level of ['debug', 'silent', '']) {
      await refused(['--replay-loop'], '--replay-loop needs --replay', { ABB_RWS_DAEMON_LOG: level });
    }
  });
});

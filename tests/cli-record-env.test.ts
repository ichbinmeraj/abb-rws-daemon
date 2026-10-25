import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * How the daemon may be started. Each case runs the command line itself
 * (src/cli.ts) in this process, with the process's exit and its error output
 * caught: every case here must be refused before anything is read or made -
 * no token file, no config, no recording, no server.
 */

// The first case compiles the whole daemon; keep clear of the 5 s default under full-suite load.
vi.setConfig({ testTimeout: 30_000 });

class Exit extends Error {
  constructor(readonly code: number | undefined) { super(`exit ${String(code)}`); }
}

const VARS = [
  'ABB_RWS_DAEMON_RECORD', 'ABB_RWS_DAEMON_RECORD_DIR', 'ABB_RWS_DAEMON_REPLAY', 'ABB_RWS_DAEMON_REPLAY_SPEED',
  'ABB_RWS_DAEMON_REPLAY_LOOP', 'ABB_RWS_DAEMON_REPLAY_PARTS', 'ABB_RWS_DAEMON_CONFIG', 'ABB_RWS_DAEMON_PORT',
  'ABB_RWS_DAEMON_TOKEN_FILE',
];

let scratch: string;
let tokenFile: string;
let configFile: string;
let recording: string;
const savedArgv = process.argv;
const savedEnv = new Map<string, string | undefined>();
let errors: string[] = [];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cli-record-env-'));
  tokenFile = join(scratch, 'token');
  configFile = join(scratch, 'none.config.json');
  recording = join(scratch, 'rec-20261004T153012Z-p0001.jsonl');
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
  vi.restoreAllMocks();
});

/** Start the daemon with `args` (and `env`); resolves with the exit code and what it wrote, or throws when it started. */
async function launch(args: string[], env: Record<string, string> = {}): Promise<{ code: number | undefined; message: string }> {
  for (const [k, v] of Object.entries(env)) { process.env[k] = v; }
  process.argv = [process.execPath, 'abb-rws-daemon', '--token-file', tokenFile, ...args];
  vi.resetModules();
  try {
    await import('../src/cli.js');
  } catch (e) {
    if (e instanceof Exit) {
      expect(existsSync(tokenFile), 'nothing may be made before the checks').toBe(false);
      return { code: e.code, message: errors.join('') };
    }
    throw e;
  } finally {
    for (const k of Object.keys(env)) { delete process.env[k]; }
  }
  throw new Error(`the daemon started with ${args.join(' ')}`);
}

const live = (...args: string[]) => ['--config', configFile, ...args];

describe('no environment variable starts a recording', () => {
  it('ABB_RWS_DAEMON_RECORD set: a live daemon does not start, and says how a recording starts', async () => {
    for (const value of ['1', 'true', '0', '']) {
      const r = await launch(live(), { ABB_RWS_DAEMON_RECORD: value });
      expect(r.code).toBe(1);
      expect(r.message).toMatch(/ABB_RWS_DAEMON_RECORD is set/);
      expect(r.message).toMatch(/--record or POST \/v0\/recording\/start/);
      errors = [];
    }
  });

  it('ABB_RWS_DAEMON_RECORD set: a replaying daemon does not start either, before it reads anything', async () => {
    const r = await launch(['--replay', join(scratch, 'no-such-recording')], { ABB_RWS_DAEMON_RECORD: '1' });
    expect(r.code).toBe(1);
    expect(r.message).toMatch(/ABB_RWS_DAEMON_RECORD is set/);
    const viaEnv = await launch([], { ABB_RWS_DAEMON_RECORD: 'yes', ABB_RWS_DAEMON_REPLAY: recording });
    expect(viaEnv.message).toMatch(/ABB_RWS_DAEMON_RECORD is set/);
  });
});

describe('an empty environment variable counts as unset', () => {
  it('ABB_RWS_DAEMON_PORT, _PANEL_ORIGINS, _CONFIG and _TOKEN_FILE set empty are passed over, not taken as values', async () => {
    // A bad log level stops the start after these four are read: what it says shows that none of them was refused first.
    const r = await launch([], {
      ABB_RWS_DAEMON_PORT: '', ABB_RWS_DAEMON_PANEL_ORIGINS: '', ABB_RWS_DAEMON_CONFIG: '', ABB_RWS_DAEMON_TOKEN_FILE: '',
      ABB_RWS_DAEMON_LOG: 'loud',
    });
    expect(r.code).toBe(1);
    expect(r.message).toMatch(/ABB_RWS_DAEMON_LOG must be one of/);
    expect(r.message).not.toMatch(/invalid port/);
  });
});

describe('--replay records nothing and reads no config', () => {
  it('--replay with --record is refused', async () => {
    const r = await launch(['--replay', recording, '--record']);
    expect(r.code).toBe(1);
    expect(r.message).toMatch(/--record cannot be used with --replay/);
  });

  it('ABB_RWS_DAEMON_REPLAY with --record is refused the same way', async () => {
    const r = await launch(['--record'], { ABB_RWS_DAEMON_REPLAY: recording });
    expect(r.message).toMatch(/--record cannot be used with --replay/);
  });

  it('every recorder option and --config are refused with --replay', async () => {
    for (const [flag, value] of [
      ['--record-dir', scratch], ['--record-label', 'x'], ['--record-content', 'frames'], ['--record-for', '60'],
      ['--record-max-file-mb', '8'], ['--record-max-total-mb', '64'], ['--record-max-dir-mb', '512'], ['--config', configFile],
    ]) {
      errors = [];
      const r = await launch(['--replay', recording, flag, value]);
      expect(r.code, flag).toBe(1);
      expect(r.message).toMatch(new RegExp(`${flag} cannot be used with --replay`));
    }
  });

  it('replay settings out of bounds are refused', async () => {
    const cases: Array<[string[], Record<string, string>, RegExp]> = [
      [['--replay-speed', '100'], {}, /replay speed must be a number from 0.1 to 50/],
      [['--replay-speed', 'fast'], {}, /replay speed/],
      [[], { ABB_RWS_DAEMON_REPLAY_SPEED: '0' }, /replay speed/],
      [['--replay-time', 'later'], {}, /--replay-time takes shifted or recorded/],
      [['--replay-parts', '0'], {}, /--replay-parts takes a part or a range/],
      [[], { ABB_RWS_DAEMON_REPLAY_PARTS: '4-2' }, /--replay-parts takes a part or a range/],
      [[], { ABB_RWS_DAEMON_REPLAY_LOOP: 'maybe' }, /ABB_RWS_DAEMON_REPLAY_LOOP must be/],
    ];
    for (const [args, env, message] of cases) {
      errors = [];
      const r = await launch(['--replay', recording, ...args], env);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.message).toMatch(message);
    }
  });
});

describe('the recorder`s options at launch', () => {
  it('limits outside the bounds stop the daemon at launch, with a message', async () => {
    const cases: Array<[string[], RegExp]> = [
      [['--record-for', '0'], /--record-for takes a whole number of seconds from 1 to 86400/],
      [['--record-for', '86401'], /--record-for/],
      [['--record-for', '1.5'], /--record-for/],
      [['--record-max-file-mb', '0'], /--record-max-file-mb takes a whole number of MiB from 1 to 256/],
      [['--record-max-file-mb', '257'], /--record-max-file-mb/],
      [['--record-max-total-mb', '8193'], /--record-max-total-mb takes a whole number of MiB from 1 to 8192/],
      [['--record-max-dir-mb', '65537'], /--record-max-dir-mb takes a whole number of MiB from 1 to 65536/],
      [['--record', '--record-label', 'Not A Label'], /--record-label takes 1 to 32 lowercase letters/],
      [['--record', '--record-content', 'frames,video'], /--record-content takes frames, calls and state/],
      [['--record', '--record-content', ','], /--record-content/],
    ];
    for (const [args, message] of cases) {
      errors = [];
      const r = await launch(live(...args));
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.message).toMatch(message);
    }
  });

  it('a label or content without --record, a replay setting without --replay, a misspelt or valueless option', async () => {
    const cases: Array<[string[], RegExp]> = [
      [['--record-label', 'x'], /--record-label applies only to the recording --record starts/],
      [['--record-content', 'frames'], /--record-content applies only/],
      [['--replay-speed', '2'], /--replay-speed needs --replay/],
      [['--replay-loop'], /--replay-loop needs --replay/],
      [['--record-forr', '60'], /unknown option --record-forr/],
      [['--replay-speeds', '2'], /unknown option --replay-speeds/],
      [['--record', '--record-for'], /--record-for needs a value/],
      [['--replay'], /--replay needs a value/],
      [['--replay', '--record'], /--replay needs a value/],
    ];
    for (const [args, message] of cases) {
      errors = [];
      const r = await launch(live(...args));
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.message).toMatch(message);
    }
  });
});

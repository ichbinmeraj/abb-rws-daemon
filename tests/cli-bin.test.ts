import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The built command (dist/cli.js, what `abb-rws-daemon` runs once the
 * package is installed) as a real process: --help, --version and a refused
 * command line. No case starts a daemon: each process is given a port no
 * daemon can listen on, so even one that got past its checks would stop.
 */

vi.setConfig({ testTimeout: 90_000 });

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

let scratch: string;
let tokenFile: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cli-bin-'));
  tokenFile = join(scratch, 'token');
});
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

/** Run the built command with exactly `args`, in an empty folder, with none of the machine's own daemon settings. */
function run(...args: string[]): { code: number | null; out: string; err: string } {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toUpperCase().startsWith('ABB_RWS_DAEMON_')) { env[k] = v; }
  }
  env.ABB_RWS_DAEMON_TOKEN_FILE = tokenFile;
  env.ABB_RWS_DAEMON_CONFIG = join(scratch, 'none.config.json');
  env.ABB_RWS_DAEMON_PORT = '0';   // not a port: a daemon that got this far stops here
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: scratch, env, encoding: 'utf8', timeout: 30_000 });
  if (r.error) { throw r.error; }
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function nothingMade(): Promise<void> {
  expect(existsSync(tokenFile), 'no token file may be made').toBe(false);
  expect(await readdir(scratch), 'nothing may be made').toEqual([]);
}

describe('dist/cli.js as a process', () => {
  it('starts with the line that makes it a command, ending in LF', () => {
    const built = readFileSync(CLI);
    const firstLineEnd = built.indexOf(0x0a);
    expect(built.subarray(0, firstLineEnd + 1).toString('latin1')).toBe('#!/usr/bin/env node\n');
  });

  it('--help prints the help text and exits 0', async () => {
    for (const flag of ['--help', '-h']) {
      const r = run(flag);
      expect(r.err, flag).toBe('');
      expect(r.code, flag).toBe(0);
      expect(r.out, flag).toMatch(new RegExp(`^abb-rws-daemon ${VERSION.replace(/[.+]/g, '\\$&')}\n`));
      expect(r.out, flag).toContain('\nUsage:\n');
      expect(r.out, flag).toContain('\nExit codes: 0 after --help');
      expect(r.out.endsWith('cut short.\n'), 'the whole text arrives').toBe(true);
      expect(r.out, flag).not.toContain('\r');
    }
    await nothingMade();
  });

  it('--version prints the versions and exits 0', async () => {
    for (const flag of ['--version', '-v']) {
      const r = run(flag);
      expect(r.err, flag).toBe('');
      expect(r.code, flag).toBe(0);
      const lines = r.out.split('\n');
      expect(lines[0], flag).toBe(`abb-rws-daemon ${VERSION}`);
      expect(lines[1], flag).toMatch(/^snapshot schema \d+\.\d+, abb-rws-client \d+\.\d+\.\d+\S*, Node\.js v\d+\.\d+\.\d+$/);
      expect(lines.slice(2), flag).toEqual(['']);
    }
    await nothingMade();
  });

  it('--bogus is refused with exit code 1', async () => {
    const r = run('--bogus');
    expect(r.err).toBe('abb-rws-daemon: unknown option --bogus; abb-rws-daemon --help lists the options\n');
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    await nothingMade();
  });

  it('--record=1 is refused with exit code 1: --record takes no value', async () => {
    const r = run('--record=1');
    expect(r.err).toBe('abb-rws-daemon: --record takes no value\n');
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    await nothingMade();
  });
});

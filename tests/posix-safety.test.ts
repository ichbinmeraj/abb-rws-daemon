/**
 * What has to hold for the daemon to run on Linux and macOS, checked on any
 * platform: the home folder is looked up only when a default path needs it;
 * an existing token file is judged by mode, owner and folder; no Windows tool
 * runs outside a Windows branch; every relative import names its file in the
 * case it has on disk; the built command line starts with a "#!" line that
 * ends in LF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type * as ChildProcess from 'node:child_process';
import type * as Os from 'node:os';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  configAccessProblem, createOwnerOnlyAppend, loadConfig, makeOwnerOnlyDir, ownerOnlyDirProblem, ownerOnlyProblem, saveConfig,
  type OwnerOnlyFsOptions, type OwnerOnlyHandle,
} from '../src/config.js';
import { defaultRecordingDir } from '../src/recording/recorder.js';
import { defaultTokenPath, loadOrCreateToken, userConfigDir, type TokenFileOptions } from '../src/token.js';

// The Windows tools run through execFile, the account lookups through node:os:
// every test here decides what they answer, and sees whether they were asked.
const { execFileMock, homedirMock, userInfoMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(), homedirMock: vi.fn(), userInfoMock: vi.fn(),
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof ChildProcess>(),
  execFile: execFileMock,
}));
vi.mock('node:os', async importOriginal => {
  const real = await importOriginal<typeof Os>();
  // A module that looks the home folder up while it loads gets the real one; each test then sets its own answer.
  homedirMock.mockImplementation(real.homedir);
  return { ...real, homedir: homedirMock, userInfo: userInfoMock };
});

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The source checks read and parse every file under src/, scripts/ and tests/,
// which alone can take seconds when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

beforeEach(() => {
  execFileMock.mockReset();
  userInfoMock.mockReset();
  homedirMock.mockReset();
  homedirMock.mockImplementation(() => { throw new Error('the home folder was looked up'); });
});

describe('the home folder is looked up only when a default path needs it', () => {
  const NO_HOME = 'no home folder for this account: set HOME or XDG_CONFIG_HOME, or name the files with --token-file and --record-dir';
  const APPDATA = 'C:\\Users\\jane\\AppData\\Roaming';
  const defaults = [userConfigDir, defaultTokenPath, defaultRecordingDir];
  const messageOf = (run: () => unknown): string | null => {
    try { run(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
  };
  /** The system has no home folder for the account, and says so the way os.homedir() does. */
  const noHome = (): void => {
    homedirMock.mockImplementation(() => {
      throw Object.assign(new Error('A system error occurred: uv_os_homedir returned ENOENT (no such file or directory)'), { code: 'ERR_SYSTEM_ERROR' });
    });
  };

  it('not at all when the environment names the folder: an account without a home folder still gets its paths', () => {
    noHome();
    const xdg = { XDG_CONFIG_HOME: '/srv/cfg' };
    expect(userConfigDir(xdg, 'linux')).toBe('/srv/cfg/abb-rws-daemon');
    expect(defaultTokenPath(xdg, 'linux')).toBe('/srv/cfg/abb-rws-daemon/token');
    expect(defaultRecordingDir(xdg, 'linux')).toBe('/srv/cfg/abb-rws-daemon/recordings');
    expect(defaultTokenPath(xdg, 'darwin')).toBe('/srv/cfg/abb-rws-daemon/token');
    expect(userConfigDir({ APPDATA }, 'win32')).toBe(`${APPDATA}\\abb-rws-daemon`);
    expect(defaultTokenPath({ APPDATA }, 'win32')).toBe(`${APPDATA}\\abb-rws-daemon\\token`);
    expect(defaultRecordingDir({ APPDATA }, 'win32')).toBe(`${APPDATA}\\abb-rws-daemon\\recordings`);
    expect(homedirMock).not.toHaveBeenCalled();
  });

  it('not at all with the process`s own environment, as the command line asks', () => {
    noHome();
    vi.stubEnv('APPDATA', APPDATA);
    vi.stubEnv('XDG_CONFIG_HOME', '/srv/cfg');
    try {
      expect(defaultTokenPath()).toMatch(/[\\/]abb-rws-daemon[\\/]token$/);
      expect(defaultRecordingDir()).toMatch(/[\\/]abb-rws-daemon[\\/]recordings$/);
      expect(homedirMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('not at all when a home folder is given', () => {
    noHome();
    expect(defaultTokenPath({}, 'linux', '/home/jane')).toBe('/home/jane/.config/abb-rws-daemon/token');
    expect(defaultRecordingDir({}, 'linux', '/home/jane')).toBe('/home/jane/.config/abb-rws-daemon/recordings');
    expect(defaultTokenPath({}, 'win32', 'C:\\Users\\jane')).toBe(`${APPDATA}\\abb-rws-daemon\\token`);
    expect(homedirMock).not.toHaveBeenCalled();
  });

  it('once, when the environment does not name the folder', () => {
    homedirMock.mockImplementation(() => '/home/jane');
    for (const env of [{}, { XDG_CONFIG_HOME: '' }, { XDG_CONFIG_HOME: 'cfg' }]) {
      homedirMock.mockClear();
      expect(defaultTokenPath(env, 'linux')).toBe('/home/jane/.config/abb-rws-daemon/token');
      expect(homedirMock).toHaveBeenCalledTimes(1);
    }
    homedirMock.mockClear();
    expect(defaultRecordingDir({}, 'linux')).toBe('/home/jane/.config/abb-rws-daemon/recordings');
    expect(homedirMock).toHaveBeenCalledTimes(1);
    homedirMock.mockImplementation(() => 'C:\\Users\\jane');
    for (const env of [{}, { APPDATA: '' }, { APPDATA: 'AppData' }]) {
      expect(defaultRecordingDir(env, 'win32')).toBe(`${APPDATA}\\abb-rws-daemon\\recordings`);
    }
  });

  it('an account without a home folder is told what to set, in one plain message', () => {
    noHome();
    const cases: Array<[NodeJS.ProcessEnv, NodeJS.Platform]> = [
      [{}, 'linux'], [{ XDG_CONFIG_HOME: '' }, 'linux'], [{ XDG_CONFIG_HOME: 'relative/cfg' }, 'linux'], [{}, 'darwin'],
      [{}, 'win32'], [{ APPDATA: 'AppData' }, 'win32'],
    ];
    for (const [env, platform] of cases) {
      for (const path of defaults) { expect(messageOf(() => path(env, platform)), `${path.name} ${platform}`).toBe(NO_HOME); }
    }
    // An empty answer is no home folder either: it would put the files in the folder the daemon was started in.
    homedirMock.mockImplementation(() => '');
    for (const path of defaults) { expect(messageOf(() => path({}, 'linux')), path.name).toBe(NO_HOME); }
    expect(messageOf(() => defaultTokenPath({}, 'linux', ''))).toBe(NO_HOME);
  });
});

const ME = 1000;
const OTHER = 1001;
const fileStat = (mode = 0o600, uid = ME) => ({ mode: 0o100000 | mode, uid });
const dirStat = (mode = 0o700, uid = ME) => ({ mode: 0o040000 | mode, uid });
/** A token file's path in a folder that does not exist yet. */
const tokenPath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), 'daemon-posix-')), 'abb-rws-daemon', 'token');

describe('an existing token file on POSIX: mode, owner and folder (injected, so the rules run on any platform)', () => {
  /**
   * Load the token file at `path` as the account `uid` on Linux, the file
   * system answering `file` for it and `folder` for its folder: what was
   * loaded, what was reported, and what the file system was asked.
   */
  async function load(
    path: string,
    file: { mode: number; uid: number } | Error = fileStat(),
    folder: { mode: number; uid: number } | Error = dirStat(),
    over: Partial<TokenFileOptions> = {},
  ) {
    const warned: string[] = [];
    const asked: string[] = [];
    const result = await loadOrCreateToken(path, {
      platform: 'linux',
      uid: () => ME,
      warn: m => warned.push(m),
      stat: async p => {
        asked.push(p);
        const answer = p === path ? file : p === dirname(path) ? folder : new Error(`ENOENT: no such file or directory, stat '${p}'`);
        if (answer instanceof Error) { throw answer; }
        return answer;
      },
      ...over,
    });
    return { result, warned, asked };
  }
  /** A token file made as the daemon makes it, and its token. */
  async function made(): Promise<{ path: string; token: string }> {
    const path = await tokenPath();
    const { token } = await loadOrCreateToken(path, { platform: 'linux' });
    return { path, token };
  }
  const NEW_FILE = /Anyone who read it keeps that access until the token changes: delete the file and restart the daemon to have a new one made that only you can open$/;

  it('says nothing about a 0600 file of the daemon`s account in a folder nobody else can write to', async () => {
    const { path, token } = await made();
    for (const folder of [0o700, 0o750, 0o755, 0o1777, 0o1775]) {
      const r = await load(path, fileStat(0o600), dirStat(folder));
      expect(r.warned, folder.toString(8)).toEqual([]);
      expect(r.result).toEqual({ token, created: false });
      expect(r.asked).toEqual([path, dirname(path)]);
    }
  });

  it('a file other accounts can read is reported with its mode, and still used', async () => {
    const { path, token } = await made();
    for (const [mode, shown] of [[0o640, '640'], [0o604, '604'], [0o666, '666'], [0o660, '660']] as const) {
      const r = await load(path, fileStat(mode));
      expect(r.result).toEqual({ token, created: false });
      expect(r.warned).toHaveLength(1);
      expect(r.warned[0]!.startsWith(`token file ${path} lets whoever reads it use the daemon, but its mode ${shown} gives other accounts access; chmod 600 it. `)).toBe(true);
      expect(r.warned[0]).toMatch(NEW_FILE);
      expect(r.warned[0]).not.toContain(token);
    }
  });

  it('a file that belongs to another account is reported whatever its mode, without advice only its owner could follow', async () => {
    const { path, token } = await made();
    const closed = await load(path, fileStat(0o600, OTHER));
    expect(closed.result).toEqual({ token, created: false });
    expect(closed.warned).toHaveLength(1);
    expect(closed.warned[0]).toContain('lets whoever reads it use the daemon, but it belongs to another account, which can read and change it. Anyone who read it');
    const open = await load(path, fileStat(0o644, OTHER));
    expect(open.result).toEqual({ token, created: false });
    expect(open.warned).toHaveLength(1);
    expect(open.warned[0]).toContain('but it belongs to another account, which can read and change it, and its mode 644 gives other accounts access. Anyone who read it');
    for (const w of [...closed.warned, ...open.warned]) {
      expect(w).not.toMatch(/chmod/);
      expect(w).toMatch(NEW_FILE);
      expect(w).not.toContain(token);
    }
    // root owns it and root runs the daemon: its own file.
    expect((await load(path, fileStat(0o600, 0), dirStat(0o700, 0), { uid: () => 0 })).warned).toEqual([]);
  });

  it('a folder that lets other accounts put another file in its place is reported; a sticky folder is not', async () => {
    const { path, token } = await made();
    for (const [mode, shown] of [[0o775, '775'], [0o777, '777'], [0o730, '730'], [0o702, '702'], [0o2775, '2775']] as const) {
      const r = await load(path, fileStat(), dirStat(mode));
      expect(r.result).toEqual({ token, created: false });
      expect(r.warned, shown).toEqual([
        `token file ${path} decides who can use the daemon, but its folder (mode ${shown}) lets other accounts put a file of their own in its place.`
        + ' Take write access to the folder away from them (chmod go-w), or keep the token in a folder of your own (--token-file)',
      ]);
    }
    for (const sticky of [0o1777, 0o1775, 0o1730]) {
      expect((await load(path, fileStat(), dirStat(sticky))).warned, sticky.toString(8)).toEqual([]);
    }
  });

  it('a shared file in a shared folder is two reports, each with its own remedy', async () => {
    const { path, token } = await made();
    const r = await load(path, fileStat(0o644), dirStat(0o777));
    expect(r.result).toEqual({ token, created: false });
    expect(r.warned).toHaveLength(2);
    expect(r.warned[0]).toMatch(/its mode 644 gives other accounts access; chmod 600 it\./);
    expect(r.warned[1]).toMatch(/its folder \(mode 777\) lets other accounts put a file of their own in its place\./);
  });

  it('a check that cannot be made is reported as that, never as a pass, and the token is still used', async () => {
    const { path, token } = await made();
    const denied = Object.assign(new Error('EACCES: permission denied, stat'), { code: 'EACCES' });
    const file = await load(path, denied, dirStat());
    expect(file.result).toEqual({ token, created: false });
    expect(file.warned).toHaveLength(1);
    expect(file.warned[0]).toContain('but who can open it could not be checked (EACCES: permission denied, stat).');
    const folder = await load(path, fileStat(), denied);
    expect(folder.result).toEqual({ token, created: false });
    expect(folder.warned).toEqual([
      `token file ${path} decides who can use the daemon, but who can write to its folder could not be checked (EACCES: permission denied, stat)`,
    ]);
    const account = await load(path, fileStat(), dirStat(), { uid: () => { throw new Error('no user id'); } });
    expect(account.result).toEqual({ token, created: false });
    expect(account.warned).toHaveLength(1);
    expect(account.warned[0]).toContain('who can open it could not be checked (no user id)');
  });

  it('where the account is not known the owner is not judged; the mode and the folder still are', async () => {
    const { path } = await made();
    const unknown = { uid: () => -1 };
    expect((await load(path, fileStat(0o600, 0), dirStat(), unknown)).warned).toEqual([]);
    expect((await load(path, fileStat(0o644, 0), dirStat(), unknown)).warned).toHaveLength(1);
    expect((await load(path, fileStat(0o600, 0), dirStat(0o777), unknown)).warned).toHaveLength(1);
  });

  it('asks the file system nothing when nobody listens, and nothing about a token it has just made', async () => {
    const { path, token } = await made();
    const quiet = await load(path, fileStat(0o666, OTHER), dirStat(0o777), { warn: undefined });
    expect(quiet).toEqual({ result: { token, created: false }, warned: [], asked: [] });
    const fresh = await load(await tokenPath(), fileStat(0o666, OTHER), dirStat(0o777));
    expect(fresh.result.created).toBe(true);
    expect(fresh).toMatchObject({ warned: [], asked: [] });
  });

  it('Windows keeps its own check: the permission list, not the mode, the owner or the folder', async () => {
    const me = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
    type Done = (err: Error | null, stdout: string, stderr: string) => void;
    execFileMock.mockImplementation((file: string, args: string[], _o: object, done: Done) => {
      void (async () => {
        if (/whoami\.exe$/i.test(file)) { done(null, `"desktop-1\\user","${me}"\r\n`, ''); return; }
        if (args[1] === '/save') { await writeFile(args[2]!, `${basename(args[0]!)}\r\nD:P(A;;FA;;;${me})(A;;FA;;;SY)\r\n`, 'utf16le'); }
        done(null, '', '');
      })();
    });
    const { path, token } = await made();
    const r = await load(path, fileStat(0o666, OTHER), dirStat(0o777), { platform: 'win32' });
    expect(r).toEqual({ result: { token, created: false }, warned: [], asked: [] });
    expect(execFileMock).toHaveBeenCalled();
  });
});

describe('an existing config file on POSIX: mode, owner and folder (injected, so the rules run on any platform)', () => {
  /** Load a saved config as the account `ME` on Linux, the file system answering `file` for it and `folder` for its folder. */
  async function load(file: { mode: number; uid: number }, folder: { mode: number; uid: number }) {
    const root = await mkdtemp(join(tmpdir(), 'daemon-config-'));
    const path = join(root, 'abb-rws-daemon.config.json');
    try {
      await saveConfig(path, [], { platform: 'linux' });
      const warned: string[] = [];
      const controllers = await loadConfig(path, {
        platform: 'linux', uid: () => ME, warn: m => warned.push(m),
        stat: async p => (p === path ? file : p === dirname(path) ? folder : Promise.reject(new Error(`ENOENT: ${p}`))),
      });
      return { path, warned, controllers };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it('says nothing about a 0600 file of the daemon`s account in a folder nobody else can write to', async () => {
    for (const folder of [0o700, 0o755, 0o1777]) {
      const r = await load(fileStat(0o600), dirStat(folder));
      expect(r.warned, folder.toString(8)).toEqual([]);
      expect(r.controllers).toEqual([]);
    }
  });

  it('a file other accounts can read is reported with its mode, and still loaded', async () => {
    const r = await load(fileStat(0o644), dirStat());
    expect(r.controllers).toEqual([]);
    expect(r.warned).toEqual([`config ${r.path} holds controller passwords, but its mode 644 gives other accounts access; chmod 600 it`]);
  });

  it('a file that belongs to another account is reported whatever its mode', async () => {
    for (const mode of [0o600, 0o640]) {
      const r = await load(fileStat(mode, OTHER), dirStat());
      expect(r.warned).toHaveLength(1);
      expect(r.warned[0]).toMatch(new RegExp(`^config ${r.path.replace(/[\\.]/g, '\\$&')} holds controller passwords, but it belongs to another account, which can read and change it`));
      expect(r.warned[0]).not.toMatch(/chmod 600/);
    }
  });

  it('a folder other accounts can write to is reported on its own, with its own remedy', async () => {
    for (const folder of [0o777, 0o775, 0o757]) {
      const r = await load(fileStat(0o600), dirStat(folder));
      expect(r.warned, folder.toString(8)).toHaveLength(1);
      expect(r.warned[0]).toContain(`config ${r.path} holds controller passwords, but its folder (mode ${folder.toString(8)}) lets other accounts put a file of their own in its place.`);
      expect(r.warned[0]).toMatch(/chmod go-w.*--config/);
    }
  });
});

describe('on a POSIX platform no Windows tool runs', () => {
  it('making, reading and judging the token, the config and a recording never start icacls or whoami, or ask for the account`s name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daemon-posix-'));
    // The token: made, read again, judged.
    const token = join(root, 'abb-rws-daemon', 'token');
    await loadOrCreateToken(token, { platform: 'linux' });
    await loadOrCreateToken(token, { platform: 'linux', warn: () => {}, uid: () => ME, stat: async p => (p === token ? fileStat(0o644, OTHER) : dirStat(0o777)) });
    // The config: saved, loaded with its check.
    const config = join(root, 'config.json');
    await saveConfig(config, [], { platform: 'linux' });
    expect(await loadConfig(config, { platform: 'linux', warn: () => {} })).toEqual([]);
    await ownerOnlyProblem(config, 'linux');
    await configAccessProblem(config, 'linux');
    // The recordings folder and a part, on an in-memory POSIX file system.
    const entries = new Map<string, { dev: number; ino: number; mode: number; uid: number; isDirectory(): boolean }>([
      ['/home/u', { dev: 1, ino: 1, mode: 0o040700, uid: ME, isDirectory: () => true }],
    ]);
    const part = { dev: 1, ino: 7, mode: 0o100600, uid: ME, isDirectory: () => false };
    const handle: OwnerOnlyHandle = { chmod: async () => {}, stat: async () => part, write: async () => {}, close: async () => {} };
    const fs: OwnerOnlyFsOptions = {
      platform: 'linux',
      uid: () => ME,
      stat: async p => {
        const s = entries.get(p);
        if (!s) { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
        return s;
      },
      mkdir: async (p, mode) => { entries.set(p, { dev: 1, ino: 2, mode: 0o040000 | mode, uid: ME, isDirectory: () => true }); },
      chmod: async (p, mode) => { entries.set(p, { ...entries.get(p)!, mode: 0o040000 | mode }); },
      open: async () => handle,
      link: async (_tmp, p) => { entries.set(p, part); },
      rm: async () => {},
      ownerOnlyProblem: async () => null,
    };
    expect(await makeOwnerOnlyDir('/home/u/rec', fs)).toBe(true);
    expect(await ownerOnlyDirProblem('/home/u/rec', fs)).toBeNull();
    expect(await createOwnerOnlyAppend('/home/u/rec/rec-p0001.jsonl', '{"kind":"header"}\n', fs)).toBe(handle);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(userInfoMock).not.toHaveBeenCalled();
    expect(homedirMock).not.toHaveBeenCalled();
    expect(await readFile(token, 'utf8')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

// --- the source, read as text -----------------------------------------------------

/** Every file under `dir` (of ROOT) with one of the extensions, as an absolute path. */
function filesUnder(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') { visit(path); }
      } else if (extensions.some(x => entry.name.endsWith(x))) {
        out.push(path);
      }
    }
  };
  visit(join(ROOT, dir));
  return out.sort();
}

const shown = (file: string): string => relative(ROOT, file).split(sep).join('/');
const parsed = new Map<string, ts.SourceFile>();
/** A source file as a syntax tree (comments are not part of it); each file is read once. */
function parse(file: string): ts.SourceFile {
  let sf = parsed.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    parsed.set(file, sf);
  }
  return sf;
}
const lineOf = (sf: ts.SourceFile, node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

/** The name of the top-level function, class or constant a node is in; '' for anything else at the top level. */
function topLevelName(node: ts.Node): string {
  let n = node;
  while (n.parent && !ts.isSourceFile(n.parent)) { n = n.parent; }
  if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) { return n.name?.text ?? ''; }
  if (ts.isVariableStatement(n)) {
    const first = n.declarationList.declarations[0];
    return first && ts.isIdentifier(first.name) ? first.name.text : '';
  }
  return '';
}

/** Whether a statement always leaves its function. */
function leaves(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) { return true; }
  const last = ts.isBlock(statement) ? statement.statements.at(-1) : undefined;
  return last !== undefined && leaves(last);
}

/**
 * Whether a node runs on Windows only: it is in the branch an `=== 'win32'`
 * test selects (or the other branch of a `!== 'win32'` one), or an earlier
 * statement of a block around it leaves the function on every other platform.
 */
function onWindowsOnly(sf: ts.SourceFile, node: ts.Node): boolean {
  const isWindows = (e: ts.Expression): boolean => /===\s*'win32'/.test(e.getText(sf));
  const isNotWindows = (e: ts.Expression): boolean => /!==\s*'win32'/.test(e.getText(sf));
  for (let n = node; n.parent; n = n.parent) {
    const p = n.parent;
    if (ts.isIfStatement(p)) {
      if (p.thenStatement === n && isWindows(p.expression)) { return true; }
      if (p.elseStatement === n && isNotWindows(p.expression)) { return true; }
    }
    if (ts.isConditionalExpression(p)) {
      if (p.whenTrue === n && isWindows(p.condition)) { return true; }
      if (p.whenFalse === n && isNotWindows(p.condition)) { return true; }
    }
    if (ts.isBlock(p)) {
      for (const earlier of p.statements) {
        if (earlier === n) { break; }
        if (ts.isIfStatement(earlier) && isNotWindows(earlier.expression) && leaves(earlier.thenStatement)) { return true; }
      }
    }
  }
  return false;
}

/** Whether a node is inside the `try` block of a try statement. */
function insideTry(node: ts.Node): boolean {
  for (let n = node; n.parent; n = n.parent) {
    if (ts.isTryStatement(n.parent) && n.parent.tryBlock === n) { return true; }
  }
  return false;
}

/** Whether a node is inside the value of an object property called `name`. */
function insideProperty(node: ts.Node, name: string): boolean {
  for (let n = node; n.parent; n = n.parent) {
    const p = n.parent;
    if (ts.isPropertyAssignment(p) && p.initializer === n && ts.isIdentifier(p.name) && p.name.text === name) { return true; }
  }
  return false;
}

/** The text of a string or template part, or null for any other node. */
function literalText(n: ts.Node): string | null {
  if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) { return n.text; }
  return null;
}

/** What a call calls, when that is a plain or dotted name: `f()` and `x.f()` are both `f`. */
function calledName(n: ts.Node): string | null {
  if (!ts.isCallExpression(n)) { return null; }
  if (ts.isIdentifier(n.expression)) { return n.expression.text; }
  if (ts.isPropertyAccessExpression(n.expression)) { return n.expression.name.text; }
  return null;
}

describe('the Windows tools stay behind Windows branches (src/, read as source)', () => {
  const sourceFiles = (): ts.SourceFile[] => filesUnder('src', ['.ts']).map(parse);
  /** The functions that run a Windows tool or ask for the account's name: none of them may run elsewhere. */
  const WINDOWS_ONLY = ['icacls', 'savedDacl', 'currentUserSid', 'restrictToOwner', 'currentWindowsUser'];
  /** Where each tool may be named in code (comments are not code). */
  const NAMED_IN: Record<string, string[]> = {
    icacls: ['icacls', 'savedDacl', 'restrictToOwner'],
    whoami: ['currentUserSid'],
    userInfo: ['currentWindowsUser'],
  };

  it('icacls, whoami and userInfo are named only in src/config.ts, inside the functions that run them', () => {
    const seen: Record<string, Set<string>> = { icacls: new Set(), whoami: new Set(), userInfo: new Set() };
    const elsewhere: string[] = [];
    for (const sf of sourceFiles()) {
      walk(sf, n => {
        if (n.parent && ts.isImportSpecifier(n.parent)) { return; }
        const text = ts.isIdentifier(n) ? n.text : literalText(n);
        if (text === null) { return; }
        for (const tool of Object.keys(NAMED_IN)) {
          const named = tool === 'userInfo' ? text === tool : text.toLowerCase().includes(tool);
          if (!named) { continue; }
          const inside = topLevelName(n);
          seen[tool]!.add(inside);
          if (shown(sf.fileName) !== 'src/config.ts' || !NAMED_IN[tool]!.includes(inside)) {
            elsewhere.push(`${shown(sf.fileName)}:${lineOf(sf, n)} names ${tool} in ${inside || 'top-level code'}`);
          }
        }
      });
    }
    expect(elsewhere).toEqual([]);
    // The check looked at something: each tool is named where it is expected.
    for (const [tool, where] of Object.entries(NAMED_IN)) { expect([...seen[tool]!].sort(), tool).toEqual([...where].sort()); }
  });

  it('the functions that run them are reached only from a Windows branch: ownerOnlyProblem, writeOwnerOnly, and restrict where it is called', () => {
    const unguarded: string[] = [];
    const callers = new Set<string>();
    const restrictCalls = new Set<string>();
    for (const sf of sourceFiles()) {
      walk(sf, n => {
        const at = `${shown(sf.fileName)}:${lineOf(sf, n)}`;
        if (ts.isIdentifier(n) && WINDOWS_ONLY.includes(n.text) && !(n.parent && ts.isImportSpecifier(n.parent))) {
          const inside = topLevelName(n);
          if (WINDOWS_ONLY.includes(inside)) { return; }
          callers.add(inside);
          // fsOps hands restrict out as a function; whoever calls it is checked below.
          const deferred = inside === 'fsOps' && insideProperty(n, 'restrict');
          if (!deferred && !onWindowsOnly(sf, n)) { unguarded.push(`${at} ${n.text} in ${inside || 'top-level code'}`); }
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'restrict') {
          restrictCalls.add(topLevelName(n));
          if (!onWindowsOnly(sf, n)) { unguarded.push(`${at} .restrict() in ${topLevelName(n) || 'top-level code'}`); }
        }
      });
    }
    expect(unguarded).toEqual([]);
    expect([...callers].sort()).toEqual(['fsOps', 'ownerOnlyProblem', 'writeOwnerOnly']);
    expect([...restrictCalls].sort()).toEqual(['createOwnerOnlyAppend', 'makeOwnerOnlyDir']);
  });

  it('the check itself tells a Windows branch from any other', () => {
    const sf = ts.createSourceFile('sample.ts', [
      'function a(platform: string) { if (platform === \'win32\') { tool(); } else { other(); } }',
      'function b(platform: string) { if (platform !== \'win32\') { return 1; } tool(); return 2; }',
      'function c(platform: string) { if (platform !== \'win32\') { other(); } tool(); }',
      'function d(platform: string) { return platform === \'win32\' ? tool() : other(); }',
      'function e(platform: string) { if (platform !== \'win32\') { other(); } else { tool(); } }',
      'function f() { tool(); }',
    ].join('\n'), ts.ScriptTarget.ES2022, true);
    const verdicts: Record<string, boolean[]> = {};
    walk(sf, n => {
      const name = calledName(n);
      if (name === 'tool' || name === 'other') { (verdicts[`${topLevelName(n)}.${name}`] ??= []).push(onWindowsOnly(sf, n)); }
    });
    expect(verdicts).toEqual({
      'a.tool': [true], 'a.other': [false], 'b.tool': [true], 'c.other': [false], 'c.tool': [false],
      'd.tool': [true], 'd.other': [false], 'e.other': [false], 'e.tool': [true], 'f.tool': [false],
    });
  });

  it('a lookup that fails for an account without a home entry is never left to throw: homedir() and userInfo() off Windows sit in a try', () => {
    const calls: string[] = [];
    const loose: string[] = [];
    for (const file of [...filesUnder('src', ['.ts']), ...filesUnder('scripts', ['.mjs', '.js', '.ts'])]) {
      const sf = parse(file);
      walk(sf, n => {
        const name = calledName(n);
        if (name !== 'homedir' && name !== 'userInfo') { return; }
        const inside = topLevelName(n);
        calls.push(`${shown(file)} ${name} in ${inside}`);
        // currentWindowsUser runs on Windows only (the test above), where the account always has a name.
        if (!insideTry(n) && inside !== 'currentWindowsUser') { loose.push(`${shown(file)}:${lineOf(sf, n)} ${name}() outside a try`); }
      });
    }
    expect(loose).toEqual([]);
    expect(calls).toContain('src/token.ts homedir in homeFolder');
    expect(calls.filter(c => c.includes(' homedir '))).toEqual(['src/token.ts homedir in homeFolder']);
    expect(calls.filter(c => c.startsWith('src/') && c.includes(' userInfo '))).toEqual(['src/config.ts userInfo in currentWindowsUser']);
  });
});

describe('file names are written in the case they have on disk (Linux tells Token.js from token.js)', () => {
  const listings = new Map<string, string[]>();
  const listing = (dir: string): string[] => {
    let names = listings.get(dir);
    if (!names) {
      try { names = readdirSync(dir); } catch { names = []; }
      listings.set(dir, names);
    }
    return names;
  };
  /** Whether `path` (inside ROOT) exists with exactly these names, letter case included. */
  function onDiskExactly(path: string): boolean {
    const parts = relative(ROOT, path).split(sep).filter(p => p.length > 0);
    if (parts[0] === '..') { return existsSync(path); }   // outside the checkout: only whether it is there
    let dir = ROOT;
    for (const part of parts) {
      if (!listing(dir).includes(part)) { return false; }
      dir = join(dir, part);
    }
    return true;
  }
  /**
   * The files a specifier written in `from` can mean: itself, or the
   * TypeScript source a `.js` or `.d.ts` name stands for. `dist/` is build
   * output named after `src/`, so a name under it is checked against its source.
   */
  function candidates(from: string, specifier: string): string[] {
    let target = resolve(dirname(from), specifier);
    const inRoot = relative(ROOT, target).split(sep);
    if (inRoot[0] === 'dist' && inRoot.length > 1) { target = join(ROOT, 'src', ...inRoot.slice(1)); }
    return [target, target.replace(/\.js$/, '.ts'), target.replace(/\.d\.ts$/, '.ts'), target.replace(/\.mjs$/, '.mts')];
  }
  /** A string argument, through `as` casts and brackets. */
  function stringArgument(e: ts.Expression | undefined): string | null {
    let x = e;
    while (x && (ts.isAsExpression(x) || ts.isParenthesizedExpression(x) || ts.isSatisfiesExpression(x))) { x = x.expression; }
    return x && ts.isStringLiteralLike(x) ? x.text : null;
  }
  /** Every relative file a source file names: what it imports (`import`), and what it reads next to itself (`file`). */
  function namedFiles(sf: ts.SourceFile): Array<{ specifier: string; line: number; kind: 'import' | 'file' }> {
    const out: Array<{ specifier: string; line: number; kind: 'import' | 'file' }> = [];
    const add = (specifier: string | null, node: ts.Node, kind: 'import' | 'file'): void => {
      if (specifier !== null && /^\.\.?(\/|$)/.test(specifier)) { out.push({ specifier, line: lineOf(sf, node), kind }); }
    };
    walk(sf, n => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) { add(stringArgument(n.moduleSpecifier), n, 'import'); }
      if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) { add(stringArgument(n.argument.literal as ts.Expression), n, 'import'); }
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const mock = ts.isPropertyAccessExpression(callee) && callee.expression.getText(sf) === 'vi'
          && ['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock'].includes(callee.name.text);
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require') || mock) {
          add(stringArgument(n.arguments[0]), n, 'import');
        }
      }
      if (ts.isNewExpression(n) && n.expression.getText(sf) === 'URL' && n.arguments?.[1]?.getText(sf) === 'import.meta.url') {
        add(stringArgument(n.arguments[0]), n, 'file');
      }
    });
    return out;
  }

  it('the check tells one case from another', () => {
    expect(onDiskExactly(join(ROOT, 'src', 'token.ts'))).toBe(true);
    expect(onDiskExactly(join(ROOT, 'src', 'Token.ts'))).toBe(false);
    expect(onDiskExactly(join(ROOT, 'SRC', 'token.ts'))).toBe(false);
    expect(onDiskExactly(join(ROOT, 'src', 'recording', 'Recorder.ts'))).toBe(false);
    expect(onDiskExactly(join(ROOT, 'src', 'nothing-here.ts'))).toBe(false);
    expect(onDiskExactly(ROOT)).toBe(true);
    const sample = ts.createSourceFile('sample.ts', [
      'import a from \'./a.js\';', 'export * from \'../b.js\';', 'import \'node:fs\';', 'import c from \'pkg\';',
      'type T = typeof import(\'./t.js\');', 'const d = await import(\'./d.mjs\' as string);', 'vi.mock(\'../m.js\');',
      'const u = new URL(\'../package.json\', import.meta.url);', 'const v = new URL(\'./x\', other);', 'const w = new URL(\'..\', import.meta.url);',
    ].join('\n'), ts.ScriptTarget.ES2022, true);
    expect(namedFiles(sample).map(f => `${f.kind} ${f.specifier}`)).toEqual([
      'import ./a.js', 'import ../b.js', 'import ./t.js', 'import ./d.mjs', 'import ../m.js', 'file ../package.json', 'file ..',
    ]);
  });

  it('every relative import under src/, scripts/ and tests/ names its file exactly', () => {
    const wrong: string[] = [];
    let imports = 0;
    const files = [...filesUnder('src', ['.ts']), ...filesUnder('scripts', ['.mjs', '.js', '.ts']), ...filesUnder('tests', ['.ts', '.mjs', '.js'])];
    for (const file of files) {
      for (const named of namedFiles(parse(file))) {
        const found = candidates(file, named.specifier);
        if (named.kind === 'import') { imports++; }
        // A file read next to the source may be made at run time: judged only when something of that name is there.
        if (named.kind === 'file' && !found.some(existsSync)) { continue; }
        if (!found.some(onDiskExactly)) { wrong.push(`${shown(file)}:${named.line} '${named.specifier}' is not a file name as written on disk`); }
      }
    }
    expect(wrong).toEqual([]);
    expect(files.length).toBeGreaterThan(60);
    expect(imports).toBeGreaterThan(200);
  });

  it('a path written out from the top of the checkout (a fixture, a schema file, a script) names its file exactly too', () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const file of [...filesUnder('src', ['.ts']), ...filesUnder('scripts', ['.mjs', '.js', '.ts']), ...filesUnder('tests', ['.ts', '.mjs', '.js'])]) {
      const sf = parse(file);
      walk(sf, n => {
        const text = literalText(n);
        if (text === null || !/^(?:\.\/)?(?:src|scripts|tests|schema)\/[A-Za-z0-9_./-]+$/.test(text)) { return; }
        const target = join(ROOT, text);
        // An example, or a file made at run time: nothing on disk to compare the name with.
        if (!existsSync(target)) { return; }
        checked++;
        if (!onDiskExactly(target)) { wrong.push(`${shown(file)}:${lineOf(sf, n)} '${text}' is not a file name as written on disk`); }
      });
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(20);
  });

  it('the package names its entry points exactly', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { main?: string; types?: string; bin?: Record<string, string> | string };
    const entries = [pkg.main, pkg.types, ...(typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {}))]
      .filter((e): e is string => typeof e === 'string');
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) { expect(candidates(join(ROOT, 'package.json'), `./${entry}`).some(onDiskExactly), entry).toBe(true); }
  });
});

describe('the built command line', () => {
  it('is built with LF line ends whatever the platform, so its "#!" line works where it is installed', () => {
    const tsconfig = ts.parseConfigFileTextToJson('tsconfig.json', readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')).config as
      { compilerOptions?: { newLine?: string } };
    expect(tsconfig.compilerOptions?.newLine).toBe('lf');
    expect(readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8').split(/\r?\n/)[0]).toBe('#!/usr/bin/env node');
    // tests/global-setup.ts built dist/ before any test ran.
    const built = readFileSync(join(ROOT, 'dist', 'cli.js'), 'utf8');
    expect(built.split('\n')[0]).toBe('#!/usr/bin/env node');
    expect(built.includes('\r')).toBe(false);
  });
});

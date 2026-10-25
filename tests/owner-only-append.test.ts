import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createOwnerOnlyAppend, makeOwnerOnlyDir, ownerOnlyAclArgs, ownerOnlyDirProblem, ownerOnlyProblem,
  type OwnerOnlyFsOptions, type OwnerOnlyHandle,
} from '../src/config.js';
import { RecordingFailedError } from '../src/recording/contract.js';
import { RECORDING_MARKERS, prepareRecordingFolder } from '../src/recording/recorder.js';

// The real-machine cases run icacls several times each on Windows, which
// alone can take seconds when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

const ME = 1000;
const OTHER = 1001;
/** A temp name made by createOwnerOnlyAppend, shown without its random part. */
const show = (p: string): string => (p.split(/[\\/]/).pop() ?? p).replace(/\.[0-9a-f]{16}\.tmp$/, '.TMP');
const dirStat = (mode: number, uid = ME) => ({ dev: 1, ino: 2, mode: 0o040000 | mode, uid, isDirectory: () => true });
const fileStat = (mode = 0o600, uid = ME, ino = 7) => ({ dev: 1, ino, mode: 0o100000 | mode, uid, isDirectory: () => false });

/**
 * The POSIX file system as createOwnerOnlyAppend sees it, in memory: every
 * call is logged; `over` replaces any operation, `handle` any handle method.
 */
function posixFs(over: Partial<OwnerOnlyFsOptions> = {}, handleOver: Partial<OwnerOnlyHandle> = {}) {
  const log: string[] = [];
  const handle: OwnerOnlyHandle = {
    chmod: async mode => { log.push(`fchmod ${mode.toString(8)}`); },
    stat: async () => fileStat(),
    write: async data => { log.push(`write ${JSON.stringify(data)}`); },
    close: async () => { log.push('close'); },
    ...handleOver,
  };
  const opts: OwnerOnlyFsOptions = {
    platform: 'linux',
    uid: () => ME,
    open: async (p, flags, mode) => { log.push(`open ${show(p)} ${flags} ${mode.toString(8)}`); return handle; },
    link: async (a, b) => { log.push(`link ${show(a)} ${show(b)}`); },
    rm: async p => { log.push(`rm ${show(p)}`); },
    stat: async () => fileStat(),
    ownerOnlyProblem: async () => null,
    ...over,
  };
  return { log, opts, handle };
}

describe('createOwnerOnlyAppend (POSIX rules, any platform)', () => {
  it('opens a temp exclusively, restricts it through the handle, writes the first line, links, removes the temp, verifies', async () => {
    const fs = posixFs();
    const h = await createOwnerOnlyAppend('/data/rec-p0001.jsonl', '{"kind":"header"}\n', fs.opts);
    expect(h).toBe(fs.handle);
    expect(fs.log).toEqual([
      'open rec-p0001.jsonl.TMP wx 600',
      'fchmod 600',
      'write "{\\"kind\\":\\"header\\"}\\n"',
      'link rec-p0001.jsonl.TMP rec-p0001.jsonl',
      'rm rec-p0001.jsonl.TMP',
    ]);
  });

  it('a failed fchmod is a failure: nothing is linked, the temp goes, the handle is closed', async () => {
    const fs = posixFs({}, { chmod: async () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); } });
    await expect(createOwnerOnlyAppend('/data/p.jsonl', 'h\n', fs.opts)).rejects.toThrow(/EPERM/);
    expect(fs.log).toEqual(['open p.jsonl.TMP wx 600', 'close', 'rm p.jsonl.TMP']);
  });

  it('refuses a file the file system left open to others, or owned by another account', async () => {
    const loose = posixFs({}, { stat: async () => fileStat(0o644) });
    await expect(createOwnerOnlyAppend('/data/p.jsonl', 'h\n', loose.opts)).rejects.toThrow(/kept mode 644/);
    expect(loose.log).not.toContain('link p.jsonl.TMP p.jsonl');
    const foreign = posixFs({}, { stat: async () => fileStat(0o600, OTHER) });
    await expect(createOwnerOnlyAppend('/data/p.jsonl', 'h\n', foreign.opts)).rejects.toThrow(/does not belong to the current account/);
  });

  it('a name that exists already (planted in advance) fails it with EEXIST', async () => {
    const fs = posixFs({ link: async () => { throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }); } });
    await expect(createOwnerOnlyAppend('/data/p.jsonl', 'h\n', fs.opts)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.log.slice(-2)).toEqual(['close', 'rm p.jsonl.TMP']);
    expect(fs.log).not.toContain('rm p.jsonl');
  });

  it('a file system without hard links is refused: there is no rename fallback', async () => {
    const fs = posixFs({ link: async () => { throw Object.assign(new Error('EPERM: link'), { code: 'EPERM' }); } });
    await expect(createOwnerOnlyAppend('/data/p.jsonl', 'h\n', fs.opts)).rejects.toThrow(/hard link \(EPERM\); recordings need one/);
    expect(fs.log.some(l => l.startsWith('rename'))).toBe(false);
  });

  it('refuses when the name no longer points at the open file, or others can open it; what was made is removed', async () => {
    const swapped = posixFs({ stat: async () => fileStat(0o600, ME, 99) });
    await expect(createOwnerOnlyAppend('/data/p.jsonl', 'h\n', swapped.opts)).rejects.toThrow(/replaced/);
    expect(swapped.log.slice(-3)).toEqual(['close', 'rm p.jsonl.TMP', 'rm p.jsonl']);
    const shared = posixFs({ ownerOnlyProblem: async () => 'its mode 644 gives other accounts access' });
    await expect(createOwnerOnlyAppend('/data/p.jsonl', 'h\n', shared.opts)).rejects.toThrow(/644/);
    expect(shared.log.at(-1)).toBe('rm p.jsonl');
  });

  it('on Windows restricts the temp by its permission list (read back) instead of a mode', async () => {
    const restricted: Array<[string, boolean]> = [];
    const fs = posixFs({ platform: 'win32', restrict: async (p, inherit) => { restricted.push([show(p), inherit]); } });
    await createOwnerOnlyAppend('C:\\data\\p.jsonl', 'h\n', fs.opts);
    expect(restricted).toEqual([['p.jsonl.TMP', false]]);
    expect(fs.log).not.toContain('fchmod 600');
    const failing = posixFs({ platform: 'win32', restrict: async () => { throw new Error('other accounts could still open it'); } });
    await expect(createOwnerOnlyAppend('C:\\data\\p.jsonl', 'h\n', failing.opts)).rejects.toThrow(/other accounts/);
    expect(failing.log).toEqual(['open p.jsonl.TMP wx 600', 'close', 'rm p.jsonl.TMP']);
  });
});

describe('the recordings folder rules (POSIX rules, any platform)', () => {
  const statOf = (entries: Record<string, ReturnType<typeof dirStat>>) =>
    async (p: string) => {
      const s = entries[p];
      if (!s) { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
      return s;
    };

  it('refuses an existing 0755 folder, one owned by another account, and one whose parent others can write to', async () => {
    const base = { platform: 'linux' as const, uid: () => ME };
    expect(await ownerOnlyDirProblem('/home/u/rec', { ...base, stat: statOf({ '/home/u/rec': dirStat(0o755), '/home/u': dirStat(0o700) }) }))
      .toMatch(/mode 755/);
    expect(await ownerOnlyDirProblem('/home/u/rec', { ...base, stat: statOf({ '/home/u/rec': dirStat(0o700, OTHER), '/home/u': dirStat(0o700) }) }))
      .toMatch(/another account/);
    expect(await ownerOnlyDirProblem('/srv/rec', { ...base, stat: statOf({ '/srv/rec': dirStat(0o700), '/srv': dirStat(0o777) }) }))
      .toMatch(/parent folder/);
    expect(await ownerOnlyDirProblem('/tmp/rec', { ...base, stat: statOf({ '/tmp/rec': dirStat(0o700), '/tmp': dirStat(0o1777) }) }))
      .toBeNull();
    expect(await ownerOnlyDirProblem('/home/u/rec', { ...base, stat: statOf({ '/home/u/rec': dirStat(0o700), '/home/u': dirStat(0o755) }) }))
      .toBeNull();
    expect(await ownerOnlyDirProblem('/home/u/f', { ...base, stat: async () => fileStat() })).toMatch(/not a folder/);
  });

  it('prepareRecordingFolder refuses an existing shared folder and never re-permissions it', async () => {
    const changed: string[] = [];
    const opts: OwnerOnlyFsOptions = {
      platform: 'linux', uid: () => ME,
      stat: statOf({ '/home/u/rec': dirStat(0o755), '/home/u': dirStat(0o700) }),
      chmod: async p => { changed.push(p); },
      mkdir: async p => { changed.push(p); },
    };
    await expect(prepareRecordingFolder('/home/u/rec', opts)).rejects.toBeInstanceOf(RecordingFailedError);
    await expect(prepareRecordingFolder('/home/u/rec', opts)).rejects.toThrow(/not this account's alone: its mode 755/);
    expect(changed).toEqual([]);
  });

  it('makes a missing folder 0700 and checks it; a failed chmod removes it again', async () => {
    const made: string[] = [];
    const removed: string[] = [];
    const entries: Record<string, ReturnType<typeof dirStat>> = { '/home/u': dirStat(0o700) };
    const opts: OwnerOnlyFsOptions = {
      platform: 'linux', uid: () => ME, stat: statOf(entries),
      mkdir: async (p, mode) => { made.push(`${p} ${mode.toString(8)}`); entries[p] = dirStat(0o755); },
      chmod: async (p, mode) => { entries[p] = dirStat(mode); },
      rmdir: async p => { removed.push(p); delete entries[p]; },
    };
    expect(await makeOwnerOnlyDir('/home/u/rec', opts)).toBe(true);
    expect(made).toEqual(['/home/u/rec 700']);
    expect(entries['/home/u/rec']!.mode & 0o777).toBe(0o700);
    expect(await makeOwnerOnlyDir('/home/u/rec', opts)).toBe(false);   // exists: left as it is
    const failing: OwnerOnlyFsOptions = { ...opts, chmod: async () => { throw new Error('EPERM'); } };
    await expect(makeOwnerOnlyDir('/home/u/rec2', failing)).rejects.toThrow(/could not be made owner-only \(EPERM\)/);
    expect(removed).toEqual(['/home/u/rec2']);
  });

  it('on Windows restricts a new folder with inheritance, so what is made in it is owner-only from the start', async () => {
    const restricted: Array<[string, boolean]> = [];
    const opts: OwnerOnlyFsOptions = {
      platform: 'win32', stat: statOf({}), mkdir: async () => {},
      restrict: async (p, inherit) => { restricted.push([p, inherit]); },
    };
    expect(await makeOwnerOnlyDir('C:\\rec', opts)).toBe(true);
    expect(restricted).toEqual([['C:\\rec', true]]);
    expect(ownerOnlyAclArgs('C:\\rec', 'PC\\user', { inherit: true })).toEqual([
      'C:\\rec', '/inheritance:r', '/grant:r', 'PC\\user:(OI)(CI)F', '/grant:r', '*S-1-5-18:(OI)(CI)F',
      '/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545', '*S-1-5-32-544',
    ]);
    expect(ownerOnlyAclArgs('C:\\f', 'PC\\user')).toContain('PC\\user:F');
  });
});

describe('on this machine, for real', () => {
  const fresh = async () => join(await mkdtemp(join(tmpdir(), 'daemon-owner-')), 'recordings');

  it('makes the folder and a part owner-only; the open temp is linked, its name gone, appends go to the part', async () => {
    const dir = await fresh();
    expect(await makeOwnerOnlyDir(dir)).toBe(true);
    expect(await ownerOnlyDirProblem(dir)).toBeNull();
    const path = join(dir, 'rec-20261004T153012Z-p0001.jsonl');
    const h = await createOwnerOnlyAppend(path, '{"kind":"header"}\n');
    expect(await readdir(dir)).toEqual(['rec-20261004T153012Z-p0001.jsonl']);
    await h.write('{"kind":"note","t":1,"text":"x"}\n');
    await h.write('{"kind":"end","t":2}\n');
    await h.close();
    expect(await readFile(path, 'utf8')).toBe('{"kind":"header"}\n{"kind":"note","t":1,"text":"x"}\n{"kind":"end","t":2}\n');
    expect(await ownerOnlyProblem(path)).toBeNull();
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
  });

  it('a part name created in advance fails, and the file there is left as it was', async () => {
    const dir = await fresh();
    await makeOwnerOnlyDir(dir);
    const path = join(dir, 'rec-20261004T153012Z-p0001.jsonl');
    await writeFile(path, 'planted\n');
    await expect(createOwnerOnlyAppend(path, '{"kind":"header"}\n')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe('planted\n');
    expect(await readdir(dir)).toEqual(['rec-20261004T153012Z-p0001.jsonl']);
  });

  it('leaves its markers once, owner-only, and never overwrites one', async () => {
    const dir = await fresh();
    await prepareRecordingFolder(dir);
    expect((await readdir(dir)).sort()).toEqual(['.gitignore', 'README.txt']);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('*\n');
    expect(await readFile(join(dir, 'README.txt'), 'utf8')).toBe(RECORDING_MARKERS['README.txt']);
    expect(await ownerOnlyProblem(join(dir, '.gitignore'))).toBeNull();
    await writeFile(join(dir, '.gitignore'), '# mine\n*\n');
    await unlink(join(dir, 'README.txt'));
    await prepareRecordingFolder(dir);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('# mine\n*\n');
    expect(await readFile(join(dir, 'README.txt'), 'utf8')).toBe(RECORDING_MARKERS['README.txt']);
    expect((await readdir(dir)).sort()).toEqual(['.gitignore', 'README.txt']);
  });

  it.skipIf(process.platform === 'win32')('POSIX: an existing 0755 folder is refused and left 0755', async () => {
    const dir = await fresh();
    await mkdir(dir);
    await chmod(dir, 0o755);
    expect(await ownerOnlyDirProblem(dir)).toMatch(/mode 755/);
    await expect(prepareRecordingFolder(dir)).rejects.toBeInstanceOf(RecordingFailedError);
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
  });

  it.runIf(process.platform === 'win32')('Windows: an existing folder other accounts can open is refused and left as it was', async () => {
    const dir = await fresh();
    await mkdir(dir);
    await promisify(execFile)('icacls', [dir, '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide: true });
    expect(await ownerOnlyDirProblem(dir)).toMatch(/Everyone/);
    await expect(prepareRecordingFolder(dir)).rejects.toThrow(/not this account's alone/);
    expect(await ownerOnlyDirProblem(dir)).toMatch(/Everyone/);
    expect(await readdir(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

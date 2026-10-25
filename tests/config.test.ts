import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type * as ChildProcess from 'node:child_process';
import {
  daclOthers, loadConfig, loadConfigFile, modeProblem, ownerOnlyAclArgs, saveConfig, saveDiscoverySettings, validateDiscovery,
  DISCOVERY_MANUAL_MAX, DISCOVERY_PORTS_MAX, DISCOVERY_RANGES_MAX, DISCOVERY_RANGE_TEXT_MAX, type ControllerConfig,
} from '../src/config.js';

// icacls runs through execFile; every test here decides what it answers.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof ChildProcess>(),
  execFile: execFileMock,
}));
type Done = (err: Error | null, stdout: string, stderr: string) => void;

const SECRET = 'hunter2-not-robotics';
const rw7: ControllerConfig = {
  id: 'rw7', name: 'RW7', host: '127.0.0.1', port: 9403, useHttps: true, username: 'Default User', password: SECRET,
};
/** Everyone, Authenticated Users, Users, Administrators - by SID. */
const REMOVE_BROAD = ['/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545', '*S-1-5-32-544'];
const tempPath = async () => join(await mkdtemp(join(tmpdir(), 'daemon-cfg-')), 'c.json');

/** The current user's SID, as the mocked whoami reports it. */
const ME = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
/** A permission list as saveConfig leaves it: the current user and SYSTEM, inheritance removed. */
const OWNER_ONLY = `D:P(A;;FA;;;${ME})(A;;FA;;;SY)`;

/**
 * Answer the Windows tools the way they do: `icacls <file> /save <out>` writes
 * the file's name and permission list (`dacl`) to `out` in UTF-16, whoami
 * names the current user and ME, any other icacls call succeeds. `seen` gets
 * every call first.
 */
function windowsTools(
  dacl: (file: string) => string = () => OWNER_ONLY,
  seen: (file: string, args: string[]) => Promise<void> | void = () => {},
): void {
  execFileMock.mockImplementation((file: string, args: string[], _o: object, done: Done) => {
    void (async () => {
      await seen(file, args);
      if (/whoami\.exe$/i.test(file)) { done(null, `"desktop-1\\user","${ME}"\r\n`, ''); return; }
      if (args[1] === '/save') { await writeFile(args[2], `${basename(args[0])}\r\n${dacl(args[0])}\r\n`, 'utf16le'); }
      done(null, '', '');
    })();
  });
}

/** Everything left in the folder of `path` but the config file itself. */
const leftovers = async (path: string) => (await readdir(dirname(path))).filter(n => n !== basename(path));

beforeEach(() => { execFileMock.mockReset(); });

describe('saveConfig on Windows', () => {
  it('locks a new temp file to the current user and SYSTEM, inheritance removed, before the passwords are in it', async () => {
    const path = await tempPath();
    const locks: Array<{ args: string[]; contentThen: string }> = [];
    windowsTools(undefined, async (file, args) => {
      if (file === 'icacls' && args[1] !== '/save') { locks.push({ args, contentThen: await readFile(args[0], 'utf8') }); }
    });
    await saveConfig(path, [rw7], { platform: 'win32', user: 'DESKTOP-1\\user' });

    expect(locks).toHaveLength(1);
    const [tmp, ...lock] = locks[0].args;
    expect(tmp).toMatch(/\.[0-9a-f]{16}\.tmp$/);
    expect(tmp.startsWith(`${path}.`)).toBe(true);
    expect(lock).toEqual(['/inheritance:r', '/grant:r', 'DESKTOP-1\\user:F', '/grant:r', '*S-1-5-18:F', ...REMOVE_BROAD]);
    expect(locks[0].contentThen).toBe('');
    expect(await loadConfig(path)).toEqual([rw7]);
    expect(await leftovers(path)).toEqual([]);
  });

  it('reads the locked temp file`s permissions back by SID before the passwords are in it', async () => {
    const path = await tempPath();
    const checks: Array<{ file: string; contentThen: string }> = [];
    windowsTools(undefined, async (file, args) => {
      if (args[1] === '/save') { checks.push({ file: args[0], contentThen: await readFile(args[0], 'utf8') }); }
    });
    await saveConfig(path, [rw7], { platform: 'win32', user: 'DESKTOP-1\\user' });
    expect(checks).toHaveLength(1);
    expect(checks[0].file).toMatch(/\.[0-9a-f]{16}\.tmp$/);
    expect(checks[0].contentThen).toBe('');
    // whoami comes from the system folder, never from whatever PATH finds first.
    const whoami = execFileMock.mock.calls.map(c => c[0] as string).find(f => /whoami/i.test(f));
    expect(whoami).toMatch(/[\\/]System32[\\/]whoami\.exe$/i);
  });

  it('never writes into a temp file found in place: another account`s file keeps its owner and its permissions', async () => {
    const path = await tempPath();
    await writeFile(`${path}.tmp`, 'planted');
    windowsTools();
    await saveConfig(path, [rw7], { platform: 'win32', user: 'DESKTOP-1\\user' });
    expect(await readFile(`${path}.tmp`, 'utf8')).toBe('planted');
    expect(await loadConfig(path)).toEqual([rw7]);
  });

  it('refuses to write the passwords when another account can still open the locked temp file', async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ controllers: [] }));
    windowsTools(() => `D:P(A;;FA;;;${ME})(A;;FA;;;SY)(A;;0x1200a9;;;S-1-5-21-9-9-9-1002)(A;;FR;;;BG)`);
    await expect(saveConfig(path, [rw7], { platform: 'win32', user: 'DESKTOP-1\\user' }))
      .rejects.toThrow(/not saved: other accounts could still open it after it was restricted \(S-1-5-21-9-9-9-1002, Guests\)/);
    expect(await readFile(path, 'utf8')).not.toContain(SECRET);   // the previous file stands
    expect(await leftovers(path)).toEqual([]);                    // and no temp file is left
  });

  it('refuses to write the passwords when who can open the temp file cannot be checked', async () => {
    const path = await tempPath();
    windowsTools();
    const answer = execFileMock.getMockImplementation()!;
    execFileMock.mockImplementation((file: string, args: string[], o: object, done: Done) => {
      if (/whoami/i.test(file)) { done(new Error('spawn whoami ENOENT'), '', ''); return; }
      answer(file, args, o, done);
    });
    await expect(saveConfig(path, [rw7], { platform: 'win32', user: 'DESKTOP-1\\user' }))
      .rejects.toThrow(/not saved: who can open it could not be checked/);
    await expect(stat(path)).rejects.toThrow();
    expect(await leftovers(path)).toEqual([]);
  });

  it('names an account with spaces as one argument (no shell)', () => {
    expect(ownerOnlyAclArgs('C:\\cfg dir\\c.json.tmp', 'CORP\\Jane Doe'))
      .toEqual(['C:\\cfg dir\\c.json.tmp', '/inheritance:r', '/grant:r', 'CORP\\Jane Doe:F', '/grant:r', '*S-1-5-18:F', ...REMOVE_BROAD]);
  });

  it('fails the save loudly when the lock fails, and writes the passwords nowhere', async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ controllers: [] }));
    execFileMock.mockImplementation((_f: string, _a: string[], _o: object, done: Done) => {
      done(Object.assign(new Error('Command failed'), { code: 5 }), '', 'Access is denied.');
    });
    await expect(saveConfig(path, [rw7], { platform: 'win32', user: 'DESKTOP-1\\user' }))
      .rejects.toThrow(/not saved: it could not be restricted to the current user \(icacls failed: Access is denied\.\)/);
    expect(await readFile(path, 'utf8')).not.toContain(SECRET);   // the previous file stands
    expect(await leftovers(path)).toEqual([]);                    // and no temp file is left
  });
});

describe('saveConfig on POSIX', () => {
  it('never runs icacls', async () => {
    const path = await tempPath();
    await saveConfig(path, [rw7], { platform: 'linux' });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(await loadConfig(path)).toEqual([rw7]);
    expect(await leftovers(path)).toEqual([]);
  });

  it('never writes into a temp file found in place', async () => {
    const path = await tempPath();
    await writeFile(`${path}.tmp`, 'planted');
    await saveConfig(path, [rw7], { platform: 'linux' });
    expect(await readFile(`${path}.tmp`, 'utf8')).toBe('planted');
    expect(await loadConfig(path)).toEqual([rw7]);
  });

  it.skipIf(process.platform === 'win32')('writes the file owner-only (0600)', async () => {
    const path = await tempPath();
    await saveConfig(path, [rw7]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe('the load check: warned, never refused', () => {
  it('modeProblem: any group or other bit is a problem, owner bits and the file type are not', () => {
    expect(modeProblem(0o600)).toBeNull();
    expect(modeProblem(0o100600)).toBeNull();
    expect(modeProblem(0o400)).toBeNull();
    expect(modeProblem(0o644)).toBe('its mode 644 gives other accounts access; chmod 600 it');
    expect(modeProblem(0o100620)).toBe('its mode 620 gives other accounts access; chmod 600 it');
    expect(modeProblem(0o601)).not.toBeNull();
  });

  it.skipIf(process.platform === 'win32')('POSIX: a file others can read loads, with a warning', async () => {
    const path = await tempPath();
    await saveConfig(path, [rw7]);
    const warned: string[] = [];
    expect(await loadConfig(path, { warn: m => warned.push(m) })).toEqual([rw7]);
    expect(warned).toEqual([]);
    await chmod(path, 0o644);
    expect(await loadConfig(path, { warn: m => warned.push(m) })).toEqual([rw7]);
    expect(warned).toEqual([`config ${path} holds controller passwords, but its mode 644 gives other accounts access; chmod 600 it`]);
  });

  it('Windows: a file that still inherits its folder`s permissions loads, with a warning', async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ controllers: [rw7] }));
    let dacl = 'D:AI(A;ID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)(A;ID;FA;;;SY)';
    windowsTools(() => dacl);
    const warned: string[] = [];

    expect(await loadConfig(path, { platform: 'win32', warn: m => warned.push(m) })).toEqual([rw7]);
    expect(warned).toEqual([`config ${path} holds controller passwords, but it inherits its folder's permissions, which let`
      + ' other accounts on this PC open it (Users, Authenticated Users); the daemon restricts it to you and SYSTEM the next'
      + ' time it saves the config']);
    expect(execFileMock.mock.calls[0].slice(0, 2)).toEqual(['icacls', [path, '/save', expect.any(String)]]);

    dacl = OWNER_ONLY;   // as saveConfig leaves it
    await loadConfig(path, { platform: 'win32', warn: m => warned.push(m) });
    expect(warned).toHaveLength(1);
  });

  it('Windows: an entry set on the file itself for another account is reported too, not only an inherited one', async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ controllers: [rw7] }));
    windowsTools(() => `${OWNER_ONLY}(A;;FR;;;BG)`);
    const warned: string[] = [];
    expect(await loadConfig(path, { platform: 'win32', warn: m => warned.push(m) })).toEqual([rw7]);
    expect(warned).toEqual([`config ${path} holds controller passwords, but its permissions let other accounts on this PC`
      + ' open it (Guests); the daemon restricts it to you and SYSTEM the next time it saves the config']);
  });

  it('a check that cannot run is a warning too, and the fleet still loads', async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ controllers: [rw7] }));
    execFileMock.mockImplementation((_f: string, _a: string[], _o: object, done: Done) => { done(new Error('spawn icacls ENOENT'), '', ''); });
    const warned: string[] = [];
    expect(await loadConfig(path, { platform: 'win32', warn: m => warned.push(m) })).toEqual([rw7]);
    expect(warned[0]).toMatch(/could not be checked/);
  });

  it('without a warn sink nothing is checked', async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ controllers: [rw7] }));
    await loadConfig(path, { platform: 'win32' });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('daclOthers - who else a permission list lets in, by SID', () => {
  it('counts neither the current user, SYSTEM nor Administrators, by SID or alias', () => {
    expect(daclOthers(`D:PAI(A;;FA;;;${ME})(A;;FA;;;SY)(A;;FA;;;S-1-5-18)(A;ID;FA;;;BA)(A;;FA;;;S-1-5-32-544)`, ME))
      .toEqual({ accounts: [], inherited: false });
  });

  it('names the broad groups, keeps any other SID as it is, and says whether an entry came from the folder', () => {
    expect(daclOthers('D:(A;;FA;;;WD)(A;;FA;;;S-1-5-21-9-9-9-1002)(A;;FR;;;BG)', ME))
      .toEqual({ accounts: ['Everyone', 'S-1-5-21-9-9-9-1002', 'Guests'], inherited: false });
    expect(daclOthers('D:AI(A;ID;0x1301bf;;;AU)(A;;FA;;;SY)', ME)).toEqual({ accounts: ['Authenticated Users'], inherited: true });
  });

  it('deny entries and inherit-only ones grant nothing; no list at all lets everyone in', () => {
    expect(daclOthers(`D:P(D;;FA;;;WD)(A;OICIIO;FA;;;CO)(A;;FA;;;${ME})`, ME)).toEqual({ accounts: [], inherited: false });
    expect(daclOthers('D:NO_ACCESS_CONTROL', ME)).toEqual({ accounts: ['Everyone'], inherited: false });
  });
});

// The real tool is a process per call, several per test: seconds on a busy machine, so these are not held to the 5 s default.
describe.runIf(process.platform === 'win32')('on this Windows machine, with the real icacls', { timeout: 30_000 }, () => {
  const useRealTools = async () => {
    const real = await vi.importActual<typeof ChildProcess>('node:child_process');
    execFileMock.mockImplementation(real.execFile as never);
    return (args: string[]) => new Promise<string>((resolve, reject) =>
      real.execFile('icacls', args, (err, out) => (err ? reject(err) : resolve(String(out)))));
  };
  /** The permission entries icacls lists for a file (names are localised, so they are counted, not read). */
  const entries = (acl: string) => acl.split(/\r?\n/).filter(l => /:\(/.test(l));

  it('a saved config inherits nothing, and loads without a warning', async () => {
    const icacls = await useRealTools();
    const path = await tempPath();
    await saveConfig(path, [rw7]);
    const acl = await icacls([path]);
    expect(acl).not.toMatch(/\(I\)/);
    // Two entries, both full control: the current user and SYSTEM.
    expect(entries(acl)).toHaveLength(2);
    for (const e of entries(acl)) { expect(e).toMatch(/:\(F\)\s*$/); }
    const warned: string[] = [];
    expect(await loadConfig(path, { warn: m => warned.push(m) })).toEqual([rw7]);
    expect(warned).toEqual([]);
  });

  it('a temp file planted with a grant for another account is left alone, and the config never carries that grant', async () => {
    const icacls = await useRealTools();
    const path = await tempPath();
    await writeFile(`${path}.tmp`, '');
    await icacls([`${path}.tmp`, '/grant', '*S-1-5-32-546:R']);   // Guests may read it
    await saveConfig(path, [rw7]);
    expect(entries(await icacls([path]))).toHaveLength(2);
    expect(await readFile(`${path}.tmp`, 'utf8')).toBe('');
  });

  it('a grant set on the config itself for another account is reported at load', async () => {
    const icacls = await useRealTools();
    const path = await tempPath();
    await saveConfig(path, [rw7]);
    await icacls([path, '/grant', '*S-1-5-32-546:R']);
    const warned: string[] = [];
    expect(await loadConfig(path, { warn: m => warned.push(m) })).toEqual([rw7]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/its permissions let other accounts on this PC open it \(Guests\)/);
  });
});

describe('saved discovery inputs in the config file', () => {
  const posix = { platform: 'linux' as const };
  const saved = { manual: [{ host: '192.0.2.10', port: 5466 }, { host: 'cell-7', https: false }], ranges: ['10.0.5.0/28'], ports: [8443] };
  const onDisk = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

  it('adding a controller keeps the saved inputs and every other key it does not own', async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ controllers: [], discovery: saved, note: 'kept' }));
    await saveConfig(path, [rw7], posix);
    expect(await onDisk(path)).toEqual({ controllers: [rw7], discovery: saved, note: 'kept' });
    expect(await loadConfigFile(path)).toEqual({ controllers: [rw7], discovery: saved });
  });

  it('saving inputs keeps the controllers and every other key; saving nothing removes the key', async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ controllers: [rw7], note: 'kept' }));
    expect(await saveDiscoverySettings(path, saved, posix)).toEqual(saved);
    expect(await onDisk(path)).toEqual({ controllers: [rw7], note: 'kept', discovery: saved });
    await saveDiscoverySettings(path, { manual: [], ranges: ['10.0.6.0/28'], ports: [] }, posix);
    expect((await onDisk(path)).discovery).toEqual({ ranges: ['10.0.6.0/28'] });
    await saveDiscoverySettings(path, { manual: [], ranges: [], ports: [] }, posix);
    expect(await onDisk(path)).toEqual({ controllers: [rw7], note: 'kept' });
  });

  it('a missing file has nothing saved; saving inputs first writes an empty fleet the daemon loads', async () => {
    const path = await tempPath();
    expect(await loadConfigFile(path)).toEqual({ controllers: [], discovery: { manual: [], ranges: [], ports: [] } });
    await saveDiscoverySettings(path, saved, posix);
    expect(await loadConfig(path)).toEqual([]);
    expect((await loadConfigFile(path)).discovery).toEqual(saved);
  });

  it('a file deleted mid-run is written back with the fleet the caller runs, not an empty one', async () => {
    const path = await tempPath();
    await saveDiscoverySettings(path, saved, { ...posix, controllers: [rw7] });
    expect(await loadConfigFile(path)).toEqual({ controllers: [rw7], discovery: saved });
  });

  it('a file on disk that is not a config is left as it is, and the save rejects without echoing it', async () => {
    const path = await tempPath();
    for (const text of [`{ "controllers": [ { "password": "${SECRET}" `, '[1, 2]', 'null', JSON.stringify({ note: SECRET }),
      JSON.stringify({ controllers: { password: SECRET } })]) {
      await writeFile(path, text);
      const err = await saveDiscoverySettings(path, saved, { ...posix, controllers: [rw7] }).then(() => null, (e: unknown) => e as Error);
      expect(err, text).toBeInstanceOf(Error);
      expect(err?.message, text).toBe(`config ${path} not saved: the file on disk has no "controllers" array; fix or remove it first`);
      expect(await readFile(path, 'utf8'), text).toBe(text);
    }
  });

  it('a file without inputs loads as nothing saved', async () => {
    const path = await tempPath();
    await saveConfig(path, [rw7], posix);
    expect((await loadConfigFile(path)).discovery).toEqual({ manual: [], ranges: [], ports: [] });
  });

  it('an invalid input fails the load naming the field, never the file`s text', async () => {
    const path = await tempPath();
    for (const [discovery, field] of [
      [[], 'discovery'],
      [{ ranges: '10.0.6.0/24' }, 'discovery.ranges'],
      [{ ranges: [''] }, 'discovery.ranges[0]'],
      [{ ranges: Array.from({ length: 17 }, (_, i) => `10.0.${i}.0/30`) }, 'discovery.ranges'],
      [{ manual: [{ host: 'bad host' }] }, 'discovery.manual[0].host'],
      [{ manual: [{ host: '192.0.2.1', port: 0 }] }, 'discovery.manual[0].port'],
      [{ manual: [{ host: '192.0.2.1', https: 'yes' }] }, 'discovery.manual[0].https'],
      [{ ports: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, 'discovery.ports'],
      [{ ports: [70000] }, 'discovery.ports[0]'],
    ] as const) {
      await writeFile(path, JSON.stringify({ controllers: [rw7], discovery }));
      const err = await loadConfigFile(path).then(() => null, (e: unknown) => e as Error);
      expect(err, field).toBeInstanceOf(Error);
      if (!err) { continue; }
      expect(err.message, field).toBe(`config ${path}: ${field} is missing or invalid`);
      expect(err.message).not.toContain(SECRET);
    }
  });

  it('an invalid input is refused before anything is written', async () => {
    const path = await tempPath();
    await saveConfig(path, [rw7], posix);
    const before = await readFile(path, 'utf8');
    await expect(saveDiscoverySettings(path, { manual: [], ranges: ['x'.repeat(65)], ports: [] }, posix)).rejects.toThrow(/discovery\.ranges\[0\]/);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('the checks hold the same caps as a scan request', () => {
    expect([DISCOVERY_MANUAL_MAX, DISCOVERY_RANGES_MAX, DISCOVERY_PORTS_MAX, DISCOVERY_RANGE_TEXT_MAX]).toEqual([16, 16, 8, 64]);
    expect(validateDiscovery(undefined)).toEqual({ manual: [], ranges: [], ports: [] });
    expect(validateDiscovery({ manual: [{ host: '192.0.2.1', port: 443, https: true, extra: 1 }] }).manual).toEqual([{ host: '192.0.2.1', port: 443, https: true }]);
  });
});

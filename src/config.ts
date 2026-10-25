import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, chmod, rm, rmdir, stat, mkdtemp, link, mkdir, open } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

/** One configured controller. The password lives only here and in memory. */
export interface ControllerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  useHttps: boolean;
  username: string;
  password: string;
  /** System id (GUID) of the controller this entry is for - set at setup, or learned on first read. */
  systemId?: string;
}

/** At most this many saved or requested discovery addresses (`manual` and `hosts` together). */
export const DISCOVERY_MANUAL_MAX = 16;
/** At most this many saved or requested discovery ranges. */
export const DISCOVERY_RANGES_MAX = 16;
/** At most this many extra discovery ports. */
export const DISCOVERY_PORTS_MAX = 8;
/** The longest range text accepted ('255.255.255.255-255.255.255.255' is 31 characters). */
export const DISCOVERY_RANGE_TEXT_MAX = 64;

/** A saved discovery address: a host name or IPv4 address, optionally with a port and a scheme. */
export interface SavedDiscoveryTarget {
  host: string;
  port?: number;
  https?: boolean;
}

/**
 * Discovery inputs kept in the config file under `discovery`. They only
 * pre-fill a setup scan; the daemon never scans them on its own.
 */
export interface DiscoverySettings {
  manual: SavedDiscoveryTarget[];
  ranges: string[];
  ports: number[];
}

/** Everything the daemon reads from its config file. */
export interface ConfigContents {
  controllers: ControllerConfig[];
  discovery: DiscoverySettings;
}

/** No saved discovery inputs. */
export const emptyDiscoverySettings = (): DiscoverySettings => ({ manual: [], ranges: [], ports: [] });

/** Who may open the config file, and how that is checked; the defaults are the running process's. */
export interface ConfigAccessOptions {
  platform?: NodeJS.Platform;
  /** Windows: the account the file is restricted to (DOMAIN\user); default the current user. */
  user?: string;
}

/**
 * Read the config file. A missing file is an empty fleet, not an error. With
 * `warn`, a file other accounts on this machine can open is reported through
 * it (configAccessProblem) - reported, not refused: the file is still the
 * owner's fleet, and refusing it would take every controller offline.
 */
export async function loadConfig(
  path: string,
  opts: ConfigAccessOptions & PosixCheckOptions & { warn?: (message: string) => void } = {},
): Promise<ControllerConfig[]> {
  return (await loadConfigFile(path, opts)).controllers;
}

/**
 * Read the whole config file: the controllers and the saved discovery inputs.
 * As loadConfig: a missing file is an empty fleet with nothing saved, and an
 * invalid entry fails the load, naming the field and never the file's text.
 */
export async function loadConfigFile(
  path: string,
  opts: ConfigAccessOptions & PosixCheckOptions & { warn?: (message: string) => void } = {},
): Promise<ConfigContents> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { return { controllers: [], discovery: emptyDiscoverySettings() }; }
    throw e;
  }

  let parsed: unknown;
  // Never echo the parser message or the text: either can contain password characters.
  try { parsed = JSON.parse(text); } catch { throw new Error(`config ${path} is not valid JSON`); }
  const file = parsed as { controllers?: unknown; discovery?: unknown } | null;
  const list = file?.controllers;
  if (!Array.isArray(list)) { throw new Error(`config ${path} has no "controllers" array`); }
  const controllers = list.map((c, i) => validateEntry(c, i, path));
  const discovery = validateDiscovery(file?.discovery, `config ${path}: discovery`);
  if (opts.warn) {
    const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    const problem = await configAccessProblem(path, opts.platform, opts)
      .catch(e => `who can open it could not be checked (${why(e)})`);
    if (problem) { opts.warn(`config ${path} holds controller passwords, but ${problem}`); }
    if ((opts.platform ?? process.platform) !== 'win32') {
      const read = opts.stat ?? ((p: string) => stat(p));
      const folder = await read(dirname(path)).then(st => posixFolderProblem(st, 'config', '--config'))
        .catch(e => `who can write to its folder could not be checked (${why(e)})`);
      if (folder) { opts.warn(`config ${path} holds controller passwords, but ${folder}`); }
    }
  }
  return { controllers, discovery };
}

/** How the POSIX owner and folder checks of a file read the file system; the defaults are the running process's. */
export interface PosixCheckOptions {
  /** The account the daemon runs as; default process.getuid(). */
  uid?: () => number;
  stat?: (path: string) => Promise<{ mode: number; uid: number }>;
}

/**
 * Why a POSIX file is not the account's alone (`me`, its user id; below zero
 * when unknown, and then the owner is not judged), or null. A group or other
 * permission bit (modeProblem, which says how to mend it); or an owner that
 * is another account, who can read the file and open it to others whatever
 * its mode says - there the mode is not this account's to change.
 */
export function posixFileProblem(st: { mode: number; uid: number }, me: number): string | null {
  if (me < 0 || st.uid === me) { return modeProblem(st.mode); }
  return 'it belongs to another account, which can read and change it'
    + ((st.mode & 0o077) !== 0 ? `, and its mode ${octal(st.mode & 0o777)} gives other accounts access` : '');
}

/**
 * Why a POSIX folder lets accounts other than a file's owner put another
 * file in its place, or null: a group or other write bit, unless the folder
 * is sticky (as /tmp is), where only a file's owner may rename or remove it.
 * `what` names the file; `option` is the one that puts it in a folder of the user's own.
 */
export function posixFolderProblem(st: { mode: number }, what: string, option: string): string | null {
  if ((st.mode & 0o022) === 0 || (st.mode & 0o1000) !== 0) { return null; }
  return `its folder (mode ${octal(st.mode)}) lets other accounts put a file of their own in its place.`
    + ` Take write access to the folder away from them (chmod go-w), or keep the ${what} in a folder of your own (${option})`;
}

const octal = (mode: number): string => (mode & 0o7777).toString(8).padStart(3, '0');

/** The account this process runs as; -1 where there are no user ids (Windows). */
const processUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

/**
 * Saved discovery inputs, checked: `undefined` is nothing saved; anything
 * else must be an object whose `manual`, `ranges` and `ports` (each
 * optional) hold valid entries within the caps. Only syntax and caps are
 * checked here; whether a range is one the client scans is decided when a
 * scan asks for it. Throws naming the field, prefixed with `where`.
 */
export function validateDiscovery(raw: unknown, where = 'discovery'): DiscoverySettings {
  if (raw === undefined) { return emptyDiscoverySettings(); }
  const bad = (field: string): Error => new Error(`${where}${field} is missing or invalid`);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { throw bad(''); }
  const o = raw as { manual?: unknown; ranges?: unknown; ports?: unknown };
  const list = (v: unknown, field: string, max: number): unknown[] => {
    if (v === undefined) { return []; }
    if (!Array.isArray(v) || v.length > max) { throw bad(`.${field}`); }
    return v;
  };
  const isPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535;
  const manual = list(o.manual, 'manual', DISCOVERY_MANUAL_MAX).map((t, i) => {
    const e = t as Partial<SavedDiscoveryTarget> | null;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) { throw bad(`.manual[${i}]`); }
    if (typeof e.host !== 'string' || !HOST_PATTERN.test(e.host)) { throw bad(`.manual[${i}].host`); }
    if (e.port !== undefined && !isPort(e.port)) { throw bad(`.manual[${i}].port`); }
    if (e.https !== undefined && typeof e.https !== 'boolean') { throw bad(`.manual[${i}].https`); }
    return { host: e.host, ...(e.port !== undefined ? { port: e.port } : {}), ...(e.https !== undefined ? { https: e.https } : {}) };
  });
  const ranges = list(o.ranges, 'ranges', DISCOVERY_RANGES_MAX).map((r, i) => {
    if (typeof r !== 'string' || r.length === 0 || r.length > DISCOVERY_RANGE_TEXT_MAX) { throw bad(`.ranges[${i}]`); }
    return r;
  });
  const ports = list(o.ports, 'ports', DISCOVERY_PORTS_MAX).map((p, i) => {
    if (!isPort(p)) { throw bad(`.ports[${i}]`); }
    return p;
  });
  return { manual, ranges, ports };
}

/** A host name or an IPv4 literal: letters, digits, dots and hyphens, 1-253 characters. */
export const HOST_PATTERN = /^[A-Za-z0-9.-]{1,253}$/;

/**
 * Why other accounts on this machine may be able to open the config file, or
 * null when only the daemon's account can. Windows: ownerOnlyProblem, and
 * that the next save fixes it. POSIX: posixFileProblem, a group or other
 * permission bit or an owner that is another account. Its folder is judged
 * on its own when the config is loaded (posixFolderProblem).
 */
export async function configAccessProblem(
  path: string, platform: NodeJS.Platform = process.platform, opts: PosixCheckOptions = {},
): Promise<string | null> {
  if (platform !== 'win32') {
    const st = await (opts.stat ?? ((p: string) => stat(p)))(path);
    return posixFileProblem(st, (opts.uid ?? processUid)());
  }
  const problem = await ownerOnlyProblem(path, platform);
  return problem ? `${problem}; the daemon restricts it to you and SYSTEM the next time it saves the config` : null;
}

/**
 * Why other accounts on this machine may be able to open a file, or null when
 * only its owner can. POSIX: any group or other permission bit. Windows: a
 * permission entry for any account but the current user, SYSTEM and
 * Administrators (daclOthers) - inherited from the folder, which on a shared
 * drive includes every account that signs in, or set on the file itself.
 */
export async function ownerOnlyProblem(path: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform !== 'win32') { return modeProblem((await stat(path)).mode); }
  const { accounts, inherited } = daclOthers(await savedDacl(path), await currentUserSid());
  if (accounts.length === 0) { return null; }
  return inherited
    ? `it inherits its folder's permissions, which let other accounts on this PC open it (${accounts.join(', ')})`
    : `its permissions let other accounts on this PC open it (${accounts.join(', ')})`;
}

/** SYSTEM and Administrators (who can take any file anyway), as SDDL names them: alias or SID. */
const TRUSTED_SIDS = new Set(['SY', 'S-1-5-18', 'BA', 'S-1-5-32-544']);

/** The broad groups by SDDL alias and SID, for messages. */
const GROUP_NAMES: Record<string, string> = {
  WD: 'Everyone', 'S-1-1-0': 'Everyone',
  AU: 'Authenticated Users', 'S-1-5-11': 'Authenticated Users',
  BU: 'Users', 'S-1-5-32-545': 'Users',
  BG: 'Guests', 'S-1-5-32-546': 'Guests',
  IU: 'INTERACTIVE', 'S-1-5-4': 'INTERACTIVE',
};

/**
 * The accounts other than `me` (a SID), SYSTEM and Administrators that a
 * permission list lets open its file, and whether any of those entries is
 * inherited from the folder. `sddl` is the list as `icacls /save` writes it,
 * every account named by SID or a fixed alias, whatever the Windows language.
 * Deny entries and inherit-only ones (for what a folder holds, not the folder
 * itself) grant nothing; no list at all (NO_ACCESS_CONTROL) lets everyone in.
 */
export function daclOthers(sddl: string, me: string): { accounts: string[]; inherited: boolean } {
  const dacl = sddl.trim().replace(/^D:/, '');
  if (dacl.startsWith('NO_ACCESS_CONTROL')) { return { accounts: ['Everyone'], inherited: false }; }
  const accounts = new Set<string>();
  let inherited = false;
  for (const [, ace] of dacl.matchAll(/\(([^()]*)\)/g)) {
    const [type = '', flags = '', , , , sid = ''] = ace.split(';');
    const flagList: string[] = flags.match(/../g) ?? [];
    if (type.endsWith('D') || flagList.includes('IO')) { continue; }
    if (sid === me || TRUSTED_SIDS.has(sid)) { continue; }
    accounts.add(GROUP_NAMES[sid] ?? sid);
    inherited ||= flagList.includes('ID');
  }
  return { accounts: [...accounts], inherited };
}

/**
 * A file's permission list as SDDL (`icacls /save`), which - unlike icacls'
 * own listing - names accounts the same in every Windows language. icacls
 * writes it to a file, in UTF-16: one made in this user's temp folder and
 * removed again.
 */
async function savedDacl(path: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'abb-rws-daemon-acl-'));
  try {
    const out = join(dir, 'acl');
    await icacls([path, '/save', out]);
    const [, dacl = ''] = (await readFile(out, 'utf16le')).replace(/^\uFEFF/, '').split(/\r?\n/);
    if (!dacl.startsWith('D:')) { throw new Error('icacls saved no permission list'); }
    return dacl;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The SID of the account this process runs as. whoami from the system folder: Git for Windows puts a GNU whoami ahead of it on PATH. */
function currentUserSid(): Promise<string> {
  const whoami = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
  return new Promise((resolve, reject) => {
    execFile(whoami, ['/user', '/fo', 'csv', '/nh'], { windowsHide: true }, (err, stdout, stderr) => {
      const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(String(stdout))?.[1];
      if (err || !sid) { reject(new Error(`whoami failed: ${String(stderr || stdout || err?.message).trim()}`)); return; }
      resolve(sid);
    });
  });
}

/** Why a POSIX file mode lets accounts other than the owner in, or null. */
export function modeProblem(mode: number): string | null {
  if ((mode & 0o077) === 0) { return null; }
  return `its mode ${(mode & 0o777).toString(8).padStart(3, '0')} gives other accounts access; chmod 600 it`;
}

/** The well-known SID of the LocalSystem account, as icacls takes it. */
const SYSTEM_SID = '*S-1-5-18';
/**
 * Everyone, Authenticated Users, Users, Administrators: the broad groups a
 * folder hands down. Named by SID, which no Windows language translates. A
 * folder with an old-style ACL passes its entries down unmarked as inherited,
 * and removing inheritance leaves those behind; these removals do not.
 */
const BROAD_GROUP_SIDS = ['*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545', '*S-1-5-32-544'];

/**
 * icacls arguments that leave `path` to `user` and SYSTEM alone: inheritance
 * removed, both given full control, the broad groups removed. With `inherit`
 * (a folder), both grants are handed down to every file and folder made in
 * it (`(OI)(CI)`), so what is made there later is owner-only from the start.
 */
export function ownerOnlyAclArgs(path: string, user: string, opts: { inherit?: boolean } = {}): string[] {
  const flags = opts.inherit ? '(OI)(CI)' : '';
  return [path, '/inheritance:r', '/grant:r', `${user}:${flags}F`, '/grant:r', `${SYSTEM_SID}:${flags}F`, '/remove:g', ...BROAD_GROUP_SIDS];
}

/** The account this process runs as, the way icacls names it. */
function currentWindowsUser(): string {
  const name = process.env.USERNAME || userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
}

/** Run icacls (no shell) and resolve with what it printed. */
function icacls(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('icacls', args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`icacls failed: ${String(stderr || stdout || err.message).trim()}`)); return; }
      resolve(String(stdout));
    });
  });
}

function validateEntry(c: unknown, i: number, path: string): ControllerConfig {
  const o = c as Partial<ControllerConfig>;
  const bad = (field: string) => new Error(`config ${path}: controllers[${i}].${field} is missing or invalid`);
  if (typeof o?.id !== 'string' || !ID_PATTERN.test(o.id)) { throw bad('id'); }
  if (typeof o.host !== 'string' || !o.host) { throw bad('host'); }
  if (!Number.isInteger(o.port) || o.port! < 1 || o.port! > 65535) { throw bad('port'); }
  if (typeof o.useHttps !== 'boolean') { throw bad('useHttps'); }
  if (typeof o.username !== 'string') { throw bad('username'); }
  if (typeof o.password !== 'string') { throw bad('password'); }
  if (o.systemId !== undefined && typeof o.systemId !== 'string') { throw bad('systemId'); }
  return {
    id: o.id, name: typeof o.name === 'string' && o.name ? o.name : o.id,
    host: o.host, port: o.port!, useHttps: o.useHttps, username: o.username, password: o.password,
    ...(o.systemId ? { systemId: o.systemId } : {}),
  };
}

/** Controller ids: lowercase, digits and hyphens - safe in URLs and file names. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Write the config atomically and owner-only (writeOwnerOnly), so a crash
 * mid-write never leaves a truncated file that loses every controller, and no
 * other account can read the passwords in it. Only `controllers` is
 * replaced: every other top-level key of the file on disk (the saved
 * discovery inputs among them) is kept as it is (updateConfigFile).
 */
export async function saveConfig(path: string, controllers: ControllerConfig[], opts: ConfigAccessOptions = {}): Promise<void> {
  await updateConfigFile(path, file => { file.controllers = controllers; }, opts);
}

/**
 * Save the discovery inputs that pre-fill a setup scan, under `discovery`,
 * keeping every other top-level key of the file (the controllers among them).
 * Nothing saved removes the key. The settings are checked first
 * (validateDiscovery) and an invalid one saves nothing.
 *
 * Saving inputs never replaces the controller list. A file on disk that is
 * not a config with a `controllers` array (hand-edited mid-run, say) is left
 * as it is and the save rejects; a missing file is written with
 * `opts.controllers` (the fleet the caller runs), else an empty list.
 */
export async function saveDiscoverySettings(
  path: string, settings: DiscoverySettings, opts: ConfigAccessOptions & { controllers?: ControllerConfig[] } = {},
): Promise<DiscoverySettings> {
  const clean = validateDiscovery(settings);
  const { controllers, ...access } = opts;
  await updateConfigFile(path, (file, onDisk) => {
    if (!Array.isArray(file.controllers)) {
      if (onDisk !== 'missing') {
        throw new Error(`config ${path} not saved: the file on disk has no "controllers" array; fix or remove it first`);
      }
      file.controllers = controllers ?? [];
    }
    const discovery = {
      ...(clean.manual.length > 0 ? { manual: clean.manual } : {}),
      ...(clean.ranges.length > 0 ? { ranges: clean.ranges } : {}),
      ...(clean.ports.length > 0 ? { ports: clean.ports } : {}),
    };
    if (Object.keys(discovery).length > 0) { file.discovery = discovery; } else { delete file.discovery; }
  }, access);
  return clean;
}

/**
 * Read the config file, change it, write it back owner-only. Keys the change
 * does not touch stay as they were, so one writer never erases what another
 * saved. A missing file, or one that is not a JSON object (a file the daemon
 * could not have loaded), starts from an empty object, as a first save does;
 * `change` is told which (`onDisk`) and may throw to write nothing.
 */
async function updateConfigFile(
  path: string,
  change: (file: Record<string, unknown>, onDisk: 'missing' | 'object' | 'not-an-object') => void,
  opts: ConfigAccessOptions,
): Promise<void> {
  let file: Record<string, unknown> = {};
  let onDisk: 'missing' | 'object' | 'not-an-object' = 'missing';
  let text: string | null = null;
  try { text = await readFile(path, 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`config ${path} not saved: it could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
  if (text !== null) {
    onDisk = 'not-an-object';
    // Never echo the parser message or the text: either can contain password characters.
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        file = parsed as Record<string, unknown>;
        onDisk = 'object';
      }
    } catch { /* not JSON: start over, as a first save */ }
  }
  change(file, onDisk);
  await writeOwnerOnly(path, JSON.stringify(file, null, 2) + '\n', { ...opts, label: 'config' });
}

/** writeOwnerOnly's options. */
export interface OwnerOnlyWriteOptions extends ConfigAccessOptions {
  /** What the file is, for error messages ("config", "token file"). Default "file". */
  label?: string;
  /**
   * Publish the file only if `path` does not exist yet; an existing file is
   * left as it is and the write fails with code EEXIST. Default false: the
   * file is replaced.
   */
  exclusive?: boolean;
}

/**
 * Write `text` to `path` so that only the current account can open it, in
 * one step: a crash mid-write never leaves a truncated file. The text goes
 * into a temp file next to `path`, which then takes its name. The temp file
 * is always a new one - a name nobody can guess, created exclusively - never
 * a file found in place: one another account made there would keep its owner
 * and its permissions however it is written to.
 *   - POSIX: mode 0600.
 *   - Windows ignores the mode, and the file would inherit its folder's
 *     permissions - on a shared drive, read or even write access for every
 *     account that signs in. The temp file is locked down while still empty
 *     (ownerOnlyAclArgs: the current user and SYSTEM, nobody else), its
 *     permissions are read back by SID (daclOthers), and only then is the
 *     text written; the rename keeps that lock. A lock that fails, or leaves
 *     any other account in, fails the write, and nothing is written.
 * With `exclusive`, the temp file is hard-linked to `path` instead of renamed
 * over it, which fails when `path` exists: of two processes creating the same
 * file at once, exactly one wins, and the other can read what the winner
 * wrote.
 */
export async function writeOwnerOnly(path: string, text: string, opts: OwnerOnlyWriteOptions = {}): Promise<void> {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const label = opts.label ?? 'file';
  if ((opts.platform ?? process.platform) === 'win32') {
    await writeFile(tmp, '', { encoding: 'utf8', flag: 'wx' });
    try {
      await restrictToOwner(tmp, opts.user ?? currentWindowsUser());
    } catch (e) {
      await rm(tmp, { force: true });
      throw new Error(`${label} ${path} not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
    await publish(tmp, path, opts.exclusive, () => writeFile(tmp, text, 'utf8'));
  } else {
    await writeFile(tmp, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // A filesystem without POSIX modes may not keep the mode above; it
    // refuses this too, and the load check reports it.
    await chmod(tmp, 0o600).catch(() => {});
    await publish(tmp, path, opts.exclusive, () => writeFile(tmp, text, 'utf8'));
  }
}

/** Fill the temp file, then give it its name; the temp file never outlives this, whatever fails. */
async function publish(tmp: string, path: string, exclusive: boolean | undefined, fill: () => Promise<void>): Promise<void> {
  try {
    await fill();
    if (!exclusive) { await rename(tmp, path); return; }
    try {
      await link(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') { throw e; }
      // A filesystem without hard links: the rename, unless the file appeared meanwhile.
      if (await stat(path).then(() => true, () => false)) {
        throw Object.assign(new Error(`EEXIST: file already exists, ${path}`), { code: 'EEXIST' });
      }
      await rename(tmp, path);
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Lock a file (or, with `inherit`, a folder) down to `user` and SYSTEM, then read its permissions back: any other account still in them fails it. Throws why. */
async function restrictToOwner(file: string, user: string, inherit = false): Promise<void> {
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
  try {
    await icacls(ownerOnlyAclArgs(file, user, { inherit }));
  } catch (e) {
    throw new Error(`it could not be restricted to the current user (${why(e)})`);
  }
  let others: string[];
  try {
    others = daclOthers(await savedDacl(file), await currentUserSid()).accounts;
  } catch (e) {
    throw new Error(`who can open it could not be checked (${why(e)})`);
  }
  // An entry the lock does not remove: a folder with an old-style permission
  // list hands its entries down unmarked, and only the broad groups go.
  if (others.length > 0) {
    throw new Error(`other accounts could still open it after it was restricted (${others.join(', ')})`);
  }
}

/** What createOwnerOnlyAppend and the folder checks need of a file handle: fs/promises' FileHandle, or a fake in tests. */
export interface OwnerOnlyHandle {
  chmod(mode: number): Promise<void>;
  stat(): Promise<{ dev: number; ino: number; mode: number; uid: number }>;
  write(data: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * The file-system operations behind the owner-only folder and append
 * helpers. Each defaults to the real one; tests swap some to run the POSIX
 * rules on any platform.
 */
export interface OwnerOnlyFsOptions extends ConfigAccessOptions {
  /** The current POSIX account; default process.getuid(). */
  uid?: () => number;
  stat?: (path: string) => Promise<{ dev: number; ino: number; mode: number; uid: number; isDirectory(): boolean }>;
  open?: (path: string, flags: string, mode: number) => Promise<OwnerOnlyHandle>;
  link?: (existing: string, path: string) => Promise<void>;
  rm?: (path: string) => Promise<void>;
  mkdir?: (path: string, mode: number) => Promise<void>;
  /** Remove an empty folder (a folder made here that failed its check). */
  rmdir?: (path: string) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
  /** Who else can open a file (default ownerOnlyProblem). */
  ownerOnlyProblem?: (path: string) => Promise<string | null>;
  /** Windows: lock a file or (with `inherit`) a folder to the current user and SYSTEM, verified (default: icacls, read back by SID). */
  restrict?: (path: string, inherit: boolean) => Promise<void>;
}

const currentUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

/** The real operations, with the overrides given. */
function fsOps(opts: OwnerOnlyFsOptions) {
  const platform = opts.platform ?? process.platform;
  return {
    platform,
    uid: opts.uid ?? currentUid,
    stat: opts.stat ?? ((p: string) => stat(p)),
    open: opts.open ?? ((p: string, flags: string, mode: number) => open(p, flags, mode) as Promise<OwnerOnlyHandle>),
    link: opts.link ?? ((a: string, b: string) => link(a, b)),
    rm: opts.rm ?? ((p: string) => rm(p, { force: true, recursive: false })),
    mkdir: opts.mkdir ?? (async (p: string, mode: number) => { await mkdir(p, { mode }); }),
    rmdir: opts.rmdir ?? ((p: string) => rmdir(p)),
    chmod: opts.chmod ?? ((p: string, mode: number) => chmod(p, mode)),
    ownerOnlyProblem: opts.ownerOnlyProblem ?? ((p: string) => ownerOnlyProblem(p, platform)),
    restrict: opts.restrict ?? ((p: string, inherit: boolean) => restrictToOwner(p, opts.user ?? currentWindowsUser(), inherit)),
  };
}

/**
 * Why a folder is not the current account's alone, or null when it is.
 * POSIX: it must be a folder owned by the current account with no group or
 * other permission bits, and its parent must not let other accounts rename or
 * replace it (no group or other write bit, unless the parent is sticky, as
 * /tmp is). Windows: ownerOnlyProblem (a permission entry for any account but
 * the current user, SYSTEM and Administrators). Never changes anything.
 */
export async function ownerOnlyDirProblem(dir: string, opts: OwnerOnlyFsOptions = {}): Promise<string | null> {
  const ops = fsOps(opts);
  const st = await ops.stat(dir);
  if (!st.isDirectory()) { return 'it is not a folder'; }
  if (ops.platform === 'win32') { return ops.ownerOnlyProblem(dir); }
  if (st.uid !== ops.uid()) { return 'it belongs to another account'; }
  if ((st.mode & 0o077) !== 0) {
    return `its mode ${(st.mode & 0o777).toString(8).padStart(3, '0')} gives other accounts access; chmod 700 it`;
  }
  const parent = await ops.stat(dirname(dir));
  if ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0) {
    return 'its parent folder lets other accounts change what it holds';
  }
  return null;
}

/**
 * Make `dir` owner-only, unless it exists: its parents are made as needed
 * (POSIX mode 0700), and the folder itself is restricted and checked - POSIX
 * mode 0700, a chmod that fails failing it; on Windows the current user and
 * SYSTEM only, handed down to what is made in it (ownerOnlyAclArgs with
 * `inherit`), read back by SID. A folder that fails the check is removed
 * again and the call throws why. An existing folder is never changed: the
 * caller checks it (ownerOnlyDirProblem) and refuses it if need be, because
 * quietly re-permissioning a folder someone chose is a surprise and refusing
 * is not. Returns whether it made the folder.
 */
export async function makeOwnerOnlyDir(dir: string, opts: OwnerOnlyFsOptions = {}): Promise<boolean> {
  const ops = fsOps(opts);
  const exists = await ops.stat(dir).then(() => true, (e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') { return false; }
    throw e;
  });
  if (exists) { return false; }
  if (!opts.mkdir) { await mkdir(dirname(dir), { recursive: true, mode: 0o700 }); }
  try {
    await ops.mkdir(dir, 0o700);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') { return false; }   // made meanwhile: checked like any existing one
    throw e;
  }
  try {
    if (ops.platform === 'win32') {
      await ops.restrict(dir, true);
    } else {
      await ops.chmod(dir, 0o700);
      const problem = await ownerOnlyDirProblem(dir, opts);
      if (problem) { throw new Error(problem); }
    }
  } catch (e) {
    await ops.rmdir(dir).catch(() => {});
    throw new Error(`the folder could not be made owner-only (${e instanceof Error ? e.message : String(e)})`);
  }
  return true;
}

/**
 * Create the file `path`, owner-only, with `firstLine` in it, and return the
 * open handle every later append goes through; the file is never reopened by
 * name. In order: a temp file with a name nobody can guess is created
 * exclusively next to `path` and kept open; it is restricted (POSIX: chmod
 * 0600 on the handle, and the handle's stat must show the current account and
 * no group or other bits - a failed chmod fails it; Windows: the current user
 * and SYSTEM only, read back by SID); `firstLine` is written through the
 * handle; the temp file is hard-linked to `path`, which fails when `path`
 * exists (a name planted in advance included) - a file system without hard
 * links is refused, there is no rename fallback; the temp name is removed;
 * and `path` must then be owner-only (ownerOnlyProblem) and still be the
 * open file (same device and inode). Any failure closes the handle, removes
 * what was made, and throws why.
 */
export async function createOwnerOnlyAppend(
  path: string, firstLine: string, opts: OwnerOnlyFsOptions = {},
): Promise<OwnerOnlyHandle> {
  const ops = fsOps(opts);
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let handle: OwnerOnlyHandle | null = null;
  let linked = false;
  try {
    handle = await ops.open(tmp, 'wx', 0o600);
    if (ops.platform === 'win32') {
      await ops.restrict(tmp, false);
    } else {
      await handle.chmod(0o600);
      const st = await handle.stat();
      if (st.uid !== ops.uid()) { throw new Error('the new file does not belong to the current account'); }
      if ((st.mode & 0o077) !== 0) { throw new Error(`the new file kept mode ${(st.mode & 0o777).toString(8)}`); }
    }
    await handle.write(firstLine);
    try {
      await ops.link(tmp, path);
      linked = true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') { throw Object.assign(new Error('a file of that name already exists'), { code: 'EEXIST' }); }
      throw new Error(`the file system did not make a hard link (${code ?? 'error'}); recordings need one`);
    }
    await ops.rm(tmp);
    const problem = await ops.ownerOnlyProblem(path);
    if (problem) { throw new Error(problem); }
    const [named, open_] = await Promise.all([ops.stat(path), handle.stat()]);
    if (named.dev !== open_.dev || named.ino !== open_.ino) { throw new Error('the file was replaced while it was being made'); }
    return handle;
  } catch (e) {
    await handle?.close().catch(() => {});
    await ops.rm(tmp).catch(() => {});
    if (linked) { await ops.rm(path).catch(() => {}); }
    throw e;
  }
}

/** A config id from a system name: "IRB1600_6_120_1" -> "irb1600-6-120-1", unique against `taken`. */
export function idFromName(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'controller';
  let id = base;
  for (let n = 2; taken.has(id); n++) { id = `${base}-${n}`; }
  return id;
}

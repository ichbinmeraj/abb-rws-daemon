import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type * as ChildProcess from 'node:child_process';
import {
  TOKEN_PATTERN, defaultTokenPath, loadOrCreateToken, newToken, presentedToken, selectStreamProtocol, tokenMatcher,
  tokenRefusal, userConfigDir,
} from '../src/token.js';
import { STREAM_PROTOCOL, TOKEN_HEADER, TOKEN_PROTOCOL_PREFIX } from '../src/schema/v0.js';

// icacls and whoami run through execFile; every test here decides what they answer.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof ChildProcess>(),
  execFile: execFileMock,
}));
type Done = (err: Error | null, stdout: string, stderr: string) => void;

/** The current user's SID, as the mocked whoami reports it. */
const ME = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
/** A permission list for the current user and SYSTEM alone, inheritance removed. */
const OWNER_ONLY = `D:P(A;;FA;;;${ME})(A;;FA;;;SY)`;

/**
 * Answer the Windows tools the way they do: `icacls <file> /save <out>`
 * writes the file's permission list (`dacl`) to `out` in UTF-16, whoami names
 * the current user, any other icacls call succeeds. `seen` gets every call first.
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

/** A token file's path in a folder that does not exist yet. */
const tokenPath = async () => join(await mkdtemp(join(tmpdir(), 'daemon-token-')), 'abb-rws-daemon', 'token');
/** Everything in the token file's folder but the token file itself. */
const leftovers = async (path: string) => (await readdir(dirname(path))).filter(n => n !== basename(path));

beforeEach(() => { execFileMock.mockReset(); });

describe('where the token file lives', () => {
  it('Windows: in the roaming application data folder', () => {
    const env = { APPDATA: 'C:\\Users\\jane\\AppData\\Roaming' };
    expect(userConfigDir(env, 'win32', 'C:\\Users\\jane')).toBe('C:\\Users\\jane\\AppData\\Roaming\\abb-rws-daemon');
    expect(defaultTokenPath(env, 'win32', 'C:\\Users\\jane')).toBe('C:\\Users\\jane\\AppData\\Roaming\\abb-rws-daemon\\token');
    // No APPDATA (a stripped environment), or one that is no absolute path: the profile's own folder.
    for (const bad of [{}, { APPDATA: '' }, { APPDATA: 'AppData' }]) {
      expect(defaultTokenPath(bad, 'win32', 'C:\\Users\\jane')).toBe('C:\\Users\\jane\\AppData\\Roaming\\abb-rws-daemon\\token');
    }
  });

  it('elsewhere: $XDG_CONFIG_HOME, or ~/.config when it is unset, empty or relative', () => {
    expect(defaultTokenPath({ XDG_CONFIG_HOME: '/srv/cfg' }, 'linux', '/home/jane')).toBe('/srv/cfg/abb-rws-daemon/token');
    for (const env of [{}, { XDG_CONFIG_HOME: '' }, { XDG_CONFIG_HOME: 'cfg' }]) {
      expect(defaultTokenPath(env, 'linux', '/home/jane')).toBe('/home/jane/.config/abb-rws-daemon/token');
    }
    expect(defaultTokenPath({}, 'darwin', '/Users/jane')).toBe('/Users/jane/.config/abb-rws-daemon/token');
  });

  it('without a home folder given, the account`s own is used, and only where the environment names none', () => {
    // On whatever machine this runs: an environment that names the folder decides alone.
    expect(defaultTokenPath({ XDG_CONFIG_HOME: '/srv/cfg' }, 'linux')).toBe('/srv/cfg/abb-rws-daemon/token');
    expect(userConfigDir({ APPDATA: 'D:\\Profiles\\jane\\Roaming' }, 'win32')).toBe('D:\\Profiles\\jane\\Roaming\\abb-rws-daemon');
    expect(defaultTokenPath()).toBe(join(userConfigDir(), 'token'));
    expect(userConfigDir({}, process.platform)).toBe(userConfigDir({}, process.platform, homedir()));
  });
});

describe('newToken', () => {
  it('is 32 random bytes, base64url: fit for a header and a subprotocol alike', () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).toMatch(TOKEN_PATTERN);
    expect(newToken()).not.toBe(a);
  });
});

describe('loadOrCreateToken', () => {
  it('makes the token once, folder included, and reads the same one on every later start', async () => {
    const path = await tokenPath();
    const first = await loadOrCreateToken(path, { platform: 'linux' });
    expect(first.created).toBe(true);
    expect(first.token).toMatch(TOKEN_PATTERN);
    expect(await readFile(path, 'utf8')).toBe(first.token);
    expect(await loadOrCreateToken(path, { platform: 'linux' })).toEqual({ token: first.token, created: false });
    expect(await leftovers(path)).toEqual([]);
  });

  it('two daemons starting at once agree on one token', async () => {
    const path = await tokenPath();
    const [a, b] = await Promise.all([loadOrCreateToken(path, { platform: 'linux' }), loadOrCreateToken(path, { platform: 'linux' })]);
    expect(a.token).toBe(b.token);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await readFile(path, 'utf8')).toBe(a.token);
    expect(await leftovers(path)).toEqual([]);
  });

  it('reads a token written by hand with surrounding whitespace or a byte-order mark', async () => {
    const path = await tokenPath();
    await loadOrCreateToken(path, { platform: 'linux' });
    const token = 'hand-written-token-0123456789abcdefghijklmnop';
    await writeFile(path, `\uFEFF${token}\r\n`);
    expect(await loadOrCreateToken(path, { platform: 'linux' })).toEqual({ token, created: false });
  });

  it('refuses a file that holds no token, and never quotes it', async () => {
    const path = await tokenPath();
    await loadOrCreateToken(path, { platform: 'linux' });
    for (const text of ['', 'short', 'hunter2 has spaces and is long enough to count ok', 'x'.repeat(300)]) {
      await writeFile(path, text);
      const err = await loadOrCreateToken(path, { platform: 'linux' }).then(() => null, (e: Error) => e);
      expect(err?.message, text).toMatch(/holds no access token .*delete it and the daemon makes a new one/);
      if (text) { expect(err?.message).not.toContain(text.slice(0, 10)); }
    }
  });

  it('POSIX: never runs icacls', async () => {
    const path = await tokenPath();
    await loadOrCreateToken(path, { platform: 'linux' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('POSIX: the file is owner-only (0600), its new folder 0700', async () => {
    const path = await tokenPath();
    await loadOrCreateToken(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o077).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('POSIX: a token file other accounts can read is reported, and still used', async () => {
    const path = await tokenPath();
    const { token } = await loadOrCreateToken(path);
    await chmod(path, 0o644);
    const warned: string[] = [];
    expect(await loadOrCreateToken(path, { warn: m => warned.push(m) })).toEqual({ token, created: false });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/lets whoever reads it use the daemon, but its mode 644 gives other accounts access/);
    expect(warned[0]).not.toContain(token);
  });

  it.skipIf(process.platform === 'win32')('POSIX: a folder other accounts can write to is reported, unless it is sticky; the token is still used', async () => {
    const path = await tokenPath();
    const { token } = await loadOrCreateToken(path);
    const warned: string[] = [];
    const load = () => loadOrCreateToken(path, { warn: m => warned.push(m) });
    // As the daemon made them: a 0600 file of this account in a 0700 folder.
    expect(await load()).toEqual({ token, created: false });
    expect(warned).toEqual([]);
    await chmod(dirname(path), 0o777);
    expect(await load()).toEqual({ token, created: false });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/decides who can use the daemon, but its folder \(mode 777\) lets other accounts put a file of their own in its place/);
    expect(warned[0]).not.toContain(token);
    await chmod(dirname(path), 0o1777);
    warned.length = 0;
    expect(await load()).toEqual({ token, created: false });
    expect(warned).toEqual([]);
  });

  it('Windows: the temp file is locked to the current user and SYSTEM before the token is in it', async () => {
    const path = await tokenPath();
    const locks: Array<{ args: string[]; contentThen: string }> = [];
    windowsTools(undefined, async (file, args) => {
      if (file === 'icacls' && args[1] !== '/save') { locks.push({ args, contentThen: await readFile(args[0], 'utf8') }); }
    });
    const { token, created } = await loadOrCreateToken(path, { platform: 'win32', user: 'DESKTOP-1\\user' });
    expect(created).toBe(true);
    expect(locks).toHaveLength(1);
    expect(locks[0].args[0].startsWith(`${path}.`)).toBe(true);
    expect(locks[0].args.slice(1, 4)).toEqual(['/inheritance:r', '/grant:r', 'DESKTOP-1\\user:F']);
    expect(locks[0].contentThen).toBe('');
    expect(await readFile(path, 'utf8')).toBe(token);
    expect(await leftovers(path)).toEqual([]);
  });

  it('Windows: a lock that fails makes no token file, and says why', async () => {
    const path = await tokenPath();
    execFileMock.mockImplementation((_f: string, _a: string[], _o: object, done: Done) => {
      done(Object.assign(new Error('Command failed'), { code: 5 }), '', 'Access is denied.');
    });
    await expect(loadOrCreateToken(path, { platform: 'win32', user: 'DESKTOP-1\\user' }))
      .rejects.toThrow(/token file .* not saved: it could not be restricted to the current user/);
    await expect(stat(path)).rejects.toThrow();
    expect(await leftovers(path)).toEqual([]);
  });

  it('Windows: an existing token file other accounts can open is reported, and still used', async () => {
    const path = await tokenPath();
    windowsTools();
    const { token } = await loadOrCreateToken(path, { platform: 'win32', user: 'DESKTOP-1\\user' });
    windowsTools(() => `D:AI(A;ID;FA;;;${ME})(A;ID;FA;;;SY)(A;ID;0x1200a9;;;BU)`);
    const warned: string[] = [];
    expect(await loadOrCreateToken(path, { platform: 'win32', warn: m => warned.push(m) })).toEqual({ token, created: false });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/lets whoever reads it use the daemon, but it inherits its folder's permissions, which let other accounts on this PC open it \(Users\)/);
    expect(warned[0]).toMatch(/delete the file and restart the daemon/);
    expect(warned[0]).not.toContain(token);
  });
});

describe('tokenMatcher', () => {
  it('matches the token exactly: no prefix, no extension, no other case', () => {
    const token = newToken();
    const matches = tokenMatcher(token);
    expect(matches(token)).toBe(true);
    for (const other of ['', token.slice(0, -1), `${token}x`, token.toUpperCase() === token ? token.toLowerCase() : token.toUpperCase(), newToken()]) {
      expect(matches(other), other).toBe(false);
    }
  });
});

describe('presentedToken and tokenRefusal', () => {
  const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
  const matches = tokenMatcher(TOKEN);
  const upgrade = (protocols: string, more: Record<string, string> = {}) =>
    ({ upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-protocol': protocols, ...more });

  it('takes the token from its header', () => {
    expect(presentedToken({ [TOKEN_HEADER]: TOKEN })).toMatchObject({ token: TOKEN, via: 'header' });
    expect(tokenRefusal({ [TOKEN_HEADER]: TOKEN }, matches)).toBeNull();
  });

  it('takes it from a subprotocol only on a WebSocket upgrade', () => {
    const offer = `${STREAM_PROTOCOL}, ${TOKEN_PROTOCOL_PREFIX}${TOKEN}`;
    expect(presentedToken(upgrade(offer))).toEqual({ token: TOKEN, via: 'protocol', tokenOffered: true, protocols: [STREAM_PROTOCOL] });
    expect(tokenRefusal(upgrade(offer), matches)).toBeNull();
    // A plain request with the same header is not an upgrade: nothing presented.
    expect(presentedToken({ 'sec-websocket-protocol': offer }).token).toBeNull();
    expect(tokenRefusal({ 'sec-websocket-protocol': offer }, matches)?.body.code).toBe('TOKEN_MISSING');
  });

  it('the header wins over a subprotocol', () => {
    const p = presentedToken(upgrade(`${STREAM_PROTOCOL}, ${TOKEN_PROTOCOL_PREFIX}wrong-token-wrong-token-wrong-token-1`, { [TOKEN_HEADER]: TOKEN }));
    expect(p).toMatchObject({ token: TOKEN, via: 'header' });
  });

  it('401 TOKEN_MISSING without a token, 401 TOKEN_INVALID with another, neither quoting it', () => {
    const missing = tokenRefusal({}, matches);
    expect(missing).toMatchObject({ status: 401, body: { code: 'TOKEN_MISSING' } });
    expect(missing!.body.error).toContain(TOKEN_HEADER);
    const wrong = 'wrong-token-wrong-token-wrong-token-12345';
    for (const headers of [{ [TOKEN_HEADER]: wrong }, upgrade(`${STREAM_PROTOCOL}, ${TOKEN_PROTOCOL_PREFIX}${wrong}`)]) {
      const refused = tokenRefusal(headers, matches);
      expect(refused).toMatchObject({ status: 401, body: { code: 'TOKEN_INVALID' } });
      expect(JSON.stringify(refused)).not.toContain(wrong);
    }
  });

  it('400 for a token subprotocol offered without the stream`s: the handshake could select none', () => {
    const refused = tokenRefusal(upgrade(`${TOKEN_PROTOCOL_PREFIX}${TOKEN}`), matches);
    expect(refused).toMatchObject({ status: 400, body: { code: 'BAD_REQUEST' } });
    expect(JSON.stringify(refused)).not.toContain(TOKEN);
    // Even when the header carries the token.
    expect(tokenRefusal(upgrade(`${TOKEN_PROTOCOL_PREFIX}${TOKEN}`, { [TOKEN_HEADER]: TOKEN }), matches)?.status).toBe(400);
    // A wrong token is still a 401 first: nothing tells a guesser more.
    expect(tokenRefusal(upgrade(`${TOKEN_PROTOCOL_PREFIX}wrong-token-wrong-token-wrong-token-12345`), matches)?.status).toBe(401);
  });

  it('the stream selects its own subprotocol, never the token`s', () => {
    expect(selectStreamProtocol(new Set([`${TOKEN_PROTOCOL_PREFIX}${TOKEN}`, STREAM_PROTOCOL]))).toBe(STREAM_PROTOCOL);
    expect(selectStreamProtocol(new Set([`${TOKEN_PROTOCOL_PREFIX}${TOKEN}`]))).toBe(false);
    expect(selectStreamProtocol(new Set(['chat']))).toBe(false);
  });
});

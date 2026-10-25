import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';
import { ownerOnlyProblem, posixFileProblem, posixFolderProblem, writeOwnerOnly, type ConfigAccessOptions } from './config.js';
import { STREAM_PROTOCOL, TOKEN_HEADER, TOKEN_PROTOCOL_PREFIX } from './schema/v0.js';

/**
 * The daemon's access token. The daemon listens on loopback only, but every
 * account signed in to the PC shares loopback: on an engineering PC used over
 * RDP, or a shop-floor PC with several accounts, any process of any of them
 * can reach 127.0.0.1. With the token, only whoever can read the token file
 * gets in: the account that runs the daemon (and SYSTEM and administrators,
 * who can read any file). The file is made once per install, owner-only, and
 * a consumer reads the token from it; nothing ever puts it in a page.
 */

/**
 * What a token looks like: letters, digits, '-' and '_' (base64url), 32 to
 * 256 characters - fit for a header and a WebSocket subprotocol alike.
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

/** The token file's name inside userConfigDir. */
export const TOKEN_FILE_NAME = 'token';

/**
 * The folder the daemon keeps its per-user files in: `%APPDATA%\abb-rws-daemon`
 * on Windows, `$XDG_CONFIG_HOME/abb-rws-daemon` elsewhere (`~/.config` when
 * XDG_CONFIG_HOME is unset, empty or relative, as the XDG spec has it).
 *
 * The home folder (`home`, by default the account's own) is looked up only
 * when the environment does not name the folder: an account without one (a
 * container run under an arbitrary user id) still works with XDG_CONFIG_HOME
 * set, and fails with a message that says what to set when nothing is.
 */
export function userConfigDir(
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home?: string,
): string {
  if (platform === 'win32') {
    const appData = env.APPDATA && win32.isAbsolute(env.APPDATA) ? env.APPDATA : win32.join(homeFolder(home), 'AppData', 'Roaming');
    return win32.join(appData, 'abb-rws-daemon');
  }
  const xdg = env.XDG_CONFIG_HOME && posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : posix.join(homeFolder(home), '.config');
  return posix.join(xdg, 'abb-rws-daemon');
}

/**
 * The home folder: the one given, else the account's own. The system has
 * none for an account with no home entry and no HOME, and says so by
 * throwing; that, and an empty answer, become one plain error.
 */
function homeFolder(given: string | undefined): string {
  let home = given;
  if (home === undefined) {
    try { home = homedir(); } catch { home = ''; }
  }
  if (!home) {
    throw new Error('no home folder for this account: set HOME or XDG_CONFIG_HOME, or name the files with --token-file and --record-dir');
  }
  return home;
}

/** Where the token file is unless the daemon is told otherwise (`--token-file`). */
export function defaultTokenPath(
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home?: string,
): string {
  return (platform === 'win32' ? win32 : posix).join(userConfigDir(env, platform, home), TOKEN_FILE_NAME);
}

/** A new token: 32 random bytes, base64url (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface TokenFileOptions extends ConfigAccessOptions {
  /**
   * Told when other accounts may be able to open an existing token file, or
   * (POSIX) to put another in its place - reported, not refused, like the
   * config: refusing would lock the owner out of their own daemon.
   */
  warn?: (message: string) => void;
  /** POSIX: the account the daemon runs as; default process.getuid(). */
  uid?: () => number;
  /** POSIX: the mode and owner of the token file and of its folder; default fs.stat. */
  stat?: (path: string) => Promise<{ mode: number; uid: number }>;
}

/**
 * The daemon's access token from the file at `path`. When there is no file
 * yet, a new token is made and written there owner-only (writeOwnerOnly), its
 * folder created as needed. Two daemons starting at once agree on one token:
 * the file is published only if it does not exist, and the one that finds it
 * made meanwhile reads it instead. A file that holds no token fails, and its
 * content is never quoted.
 */
export async function loadOrCreateToken(path: string, opts: TokenFileOptions = {}): Promise<{ token: string; created: boolean }> {
  const existing = await readToken(path);
  if (existing !== null) {
    await warnIfShared(path, opts);
    return { token: existing, created: false };
  }
  const token = newToken();
  // A new folder is the owner's alone on POSIX; on Windows it inherits the
  // profile's permissions, and the file is locked down on its own.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeOwnerOnly(path, token, { ...opts, label: 'token file', exclusive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { throw e; }
    const theirs = await readToken(path);
    if (theirs === null) { throw new Error(`token file ${path} appeared and went again while it was being made`); }
    await warnIfShared(path, opts);
    return { token: theirs, created: false };
  }
  return { token, created: true };
}

/** The token in the file at `path`; null when there is no file. */
async function readToken(path: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') { return null; }
    throw new Error(`token file ${path} could not be read (${code ?? (e instanceof Error ? e.message : String(e))})`);
  }
  const token = text.trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`token file ${path} holds no access token (32 to 256 letters, digits, '-' or '_');`
      + ' delete it and the daemon makes a new one');
  }
  return token;
}

/**
 * Report an existing token file that is not the daemon account's alone.
 * Windows: a permission entry for another account (ownerOnlyProblem). POSIX:
 * a group or other permission bit, an owner that is not the account the
 * daemon runs as, and - on its own, because the remedy is another - a folder
 * that lets other accounts put a file of theirs in the token's place.
 */
async function warnIfShared(path: string, opts: TokenFileOptions): Promise<void> {
  const { warn } = opts;
  if (!warn) { return; }
  const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const shared = (problem: string | null): void => {
    if (!problem) { return; }
    warn(`token file ${path} lets whoever reads it use the daemon, but ${problem}.`
      + ' Anyone who read it keeps that access until the token changes: delete the file and restart the daemon'
      + ' to have a new one made that only you can open');
  };
  if ((opts.platform ?? process.platform) === 'win32') {
    shared(await ownerOnlyProblem(path, 'win32').catch(e => `who can open it could not be checked (${why(e)})`));
    return;
  }
  const read = opts.stat ?? ((p: string) => stat(p));
  shared(await read(path).then(st => posixFileProblem(st, (opts.uid ?? currentUid)()))
    .catch(e => `who can open it could not be checked (${why(e)})`));
  const folder = await read(dirname(path)).then(st => posixFolderProblem(st, 'token', '--token-file'))
    .catch(e => `who can write to its folder could not be checked (${why(e)})`);
  if (folder) { warn(`token file ${path} decides who can use the daemon, but ${folder}`); }
}

/** The account this process runs as; -1 where there are no user ids (Windows). */
const currentUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

/**
 * A comparison against the expected token that takes the same time however
 * much of a presented one matches: both are hashed first, so neither the
 * content nor the length of the expected one shows.
 */
export function tokenMatcher(expected: string): (presented: string) => boolean {
  const want = sha256(expected);
  return presented => timingSafeEqual(sha256(presented), want);
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** What a request presented. */
export interface PresentedToken {
  /** The token; null when the request carried none. */
  token: string | null;
  /** Where it came from: the header, or a subprotocol on a WebSocket upgrade. */
  via: 'header' | 'protocol' | null;
  /** A WebSocket upgrade offered a token subprotocol, whether or not the header won. */
  tokenOffered: boolean;
  /** The subprotocols a WebSocket upgrade offered besides the token's. */
  protocols: string[];
}

/**
 * The token a request presents: the TOKEN_HEADER header, or on a WebSocket
 * upgrade only, a subprotocol `${TOKEN_PROTOCOL_PREFIX}<token>`. The header
 * wins when both are there.
 */
export function presentedToken(headers: IncomingHttpHeaders): PresentedToken {
  const upgrade = /^websocket$/i.test(String(headers.upgrade ?? '').trim());
  const offered = upgrade
    ? String(headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim()).filter(p => p.length > 0)
    : [];
  const protocols = offered.filter(p => !p.startsWith(TOKEN_PROTOCOL_PREFIX));
  const tokenOffered = protocols.length < offered.length;
  const header = headers[TOKEN_HEADER];
  const fromHeader = Array.isArray(header) ? header.join(',') : header;
  if (fromHeader) { return { token: fromHeader, via: 'header', tokenOffered, protocols }; }
  const fromProtocol = offered.find(p => p.startsWith(TOKEN_PROTOCOL_PREFIX))?.slice(TOKEN_PROTOCOL_PREFIX.length);
  if (fromProtocol) { return { token: fromProtocol, via: 'protocol', tokenOffered, protocols }; }
  return { token: null, via: null, tokenOffered, protocols };
}

/** How a request without a good token is answered. */
export interface TokenRefusal {
  status: 400 | 401;
  body: { error: string; code: 'TOKEN_MISSING' | 'TOKEN_INVALID' | 'BAD_REQUEST' };
}

/**
 * Why a request is refused for its token, or null when it may pass: 401
 * TOKEN_MISSING without one, 401 TOKEN_INVALID with another, and 400 when a
 * token subprotocol was offered without STREAM_PROTOCOL next to it (the
 * stream could select no subprotocol, and the consumer's WebSocket would
 * fail the handshake with no reason it can show). No answer quotes what was
 * presented.
 */
export function tokenRefusal(headers: IncomingHttpHeaders, matches: (presented: string) => boolean): TokenRefusal | null {
  const p = presentedToken(headers);
  if (p.token === null) {
    return { status: 401, body: {
      error: `this request needs the daemon's access token in the ${TOKEN_HEADER} header;`
        + ' the daemon names the file that holds it when it starts',
      code: 'TOKEN_MISSING',
    } };
  }
  if (!matches(p.token)) {
    return { status: 401, body: {
      error: "the access token is not this daemon's; read it again from the daemon's token file",
      code: 'TOKEN_INVALID',
    } };
  }
  if (p.tokenOffered && !p.protocols.includes(STREAM_PROTOCOL)) {
    return { status: 400, body: {
      error: `a token offered as a subprotocol needs the subprotocol ${STREAM_PROTOCOL} offered next to it`,
      code: 'BAD_REQUEST',
    } };
  }
  return null;
}

/**
 * The stream's subprotocol choice (the WebSocket server's handleProtocols):
 * STREAM_PROTOCOL when offered, and never the token's, which would echo the
 * token back in the handshake.
 */
export function selectStreamProtocol(protocols: Set<string>): string | false {
  return protocols.has(STREAM_PROTOCOL) ? STREAM_PROTOCOL : false;
}

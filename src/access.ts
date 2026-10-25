import { groupError, redactSecrets } from './errorMap.js';
import type {
  AccessGeneration, AccessGroup, AccessHolder, AccessLockInfo, AccessLockName, AccessModel, GroupError, LinkQuality, RmmpInfo,
  RmmpPrivilege,
} from './schema/v0.js';

/**
 * Access: the pure half - what the reader's status reads become in
 * the snapshot. The reader itself lives in the fleet (`ControllerFleet`), like
 * the motion sampler, the I/O watcher and the event reader.
 *
 * Reporting only: nothing here, and nothing in the reader, requests, releases
 * or changes mastership, write access, RMMP or a control-station
 * registration.
 *
 * One rule for every part (a part is one lock, or RMMP). A good read is an
 * answer the daemon understood: it sets the part's values and its time, and
 * clears its error. Every other read - the client threw, answered nothing,
 * answered in another form or with a word not known here - is a failed read:
 * the part keeps its values and its time exactly as they were and carries an
 * error. No mapper produces "not held" or "nobody" as a default.
 */

/**
 * Why the lock of a RobotWare 8 controller is not read: the daemon takes every
 * status from the client's RobotManager, and the manager it drives has no
 * write-access status read (the lookup is by name, so a manager that gains one
 * is read). Not the client's gap to name: the text says what this release does.
 */
export const NO_WRITE_ACCESS_READER = 'this abb-rws-client cannot read the write-access status';

/** Why nothing can be read on a healthy link whose access generation the client could not determine. */
export const NO_GENERATION = 'the controller did not report a RobotWare version the client could use';

/** The longest controller text an access part carries (a status word, an application, a station name). */
export const ACCESS_TEXT_MAX = 128;

/** Delay (ms) before the status is read again after a round in which every part failed, after n such rounds: 5, 10, 20, 40, then every 60 s. */
export function accessRetryMs(failures: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * Controller text as an access part carries it: anything credential-like
 * masked, on one line, at most ACCESS_TEXT_MAX characters (longer text is cut
 * and ends in "..."). null for anything that is not a text, and for an empty
 * one.
 */
export function accessText(text: unknown, max: number = ACCESS_TEXT_MAX): string | null {
  if (typeof text !== 'string') { return null; }
  const one = redactSecrets(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (one.length === 0) { return null; }
  return one.length > max ? `${one.slice(0, Math.max(0, max - 3))}...` : one;
}

/** The locks of a generation, in wire order; none while the generation is not known. */
export function locksOf(generation: AccessGeneration | null): AccessLockName[] {
  switch (generation) {
    case 'rw6': return ['cfg', 'motion', 'rapid'];
    case 'rw7': return ['edit', 'motion'];
    case 'rw8': return ['writeaccess'];
    default: return [];
  }
}

/**
 * The mastership domain whose status is read for a lock: the client takes
 * `rapid` for the RobotWare 7 `edit` lock too. null for `writeaccess`, which
 * has no domain.
 */
export function domainOf(lock: AccessLockName): 'cfg' | 'motion' | 'rapid' | null {
  switch (lock) {
    case 'cfg': return 'cfg';
    case 'motion': return 'motion';
    case 'rapid':
    case 'edit': return 'rapid';
    default: return null;
  }
}

/** What a generation arbitrates writes with. */
export function modelOf(generation: AccessGeneration | null): AccessModel | null {
  if (generation === null) { return null; }
  return generation === 'rw8' ? 'writeaccess' : 'mastership';
}

/**
 * The access generation the client reports in its state (`state.access`), or
 * null when it reports none - or a word this daemon does not know.
 */
export function clientGeneration(access: unknown): AccessGeneration | null {
  const g = pick(access, 'generation');
  return g === 'rw6' || g === 'rw7' || g === 'rw8' ? g : null;
}

/** One lock as the fleet keeps it between reads (times in ms). */
export interface LockView {
  lock: AccessLockName;
  held: boolean | null;
  holder: AccessHolder | null;
  reported: string | null;
  /**
   * RobotWare 8: whether the last good read said the holder is the client's
   * own control station. Only ever a cross-check on `heldByDaemon` (accessGroup);
   * null on RobotWare 6 and 7 and until a good read carried it.
   */
  claimed: boolean | null;
  /** When the status was last read and understood (ms); null until then. */
  asOf: number | null;
  error: GroupError | null;
}

/** RMMP as the fleet keeps it between reads (time in ms). */
export interface RmmpView {
  supported: boolean | null;
  privilege: RmmpPrivilege | null;
  asOf: number | null;
  error: GroupError | null;
}

/** What the fleet holds per controller for its access status - all a snapshot needs. */
export interface AccessView {
  /** The generation these values were read under; null when the view keeps none. */
  generation: AccessGeneration | null;
  locks: LockView[];
  /** RobotWare 8: the controller's "external control enabled" flag as the last good read of the lock carried it. */
  remoteAccessEnabled: boolean | null;
  rmmp: RmmpView;
}

/** What one status read came to: what the client answered, or what it threw. */
export type AccessRead = { answer: unknown } | { thrown: unknown };

/**
 * The status word an answer carried, for a log line about a read that was not
 * understood: cleaned and cut like every served text. `field`: where the word
 * sits in the answer (the answer itself when left out). null for a thrown
 * read and for an answer without a word.
 */
export function answeredWord(read: AccessRead, field?: string): string | null {
  if ('thrown' in read) { return null; }
  return accessText(field === undefined ? read.answer : pick(read.answer, field));
}

/** A lock nothing has been read of. */
function unreadLock(lock: AccessLockName): LockView {
  return { lock, held: null, holder: null, reported: null, claimed: null, asOf: null, error: null };
}

/**
 * Every part of a generation as before its first read on a connection: each
 * lock without a value, a time or an error; RMMP not determined on RobotWare
 * 6 and 7, and not offered on RobotWare 8 (which has none: nothing is read).
 * Without a generation there is no lock at all.
 */
export function unreadView(generation: AccessGeneration | null): AccessView {
  return {
    generation,
    locks: locksOf(generation).map(unreadLock),
    remoteAccessEnabled: null,
    rmmp: { supported: generation === 'rw8' ? false : null, privilege: null, asOf: null, error: null },
  };
}

/** A property of an answer, read without trusting the answer: undefined for anything that is no object, or that refuses the read. */
function pick(from: unknown, key: string): unknown {
  if (from === null || typeof from !== 'object') { return undefined; }
  try { return (from as Record<string, unknown>)[key]; } catch { return undefined; }
}

/** An id as the controllers write one: a GUID, with or without its braces. */
const ID_SHAPED = /\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?/gi;

/**
 * A status read the client threw, as its part carries it. The text of the
 * error is the client's, so on top of the usual masking anything shaped like
 * an id is masked too: a holder is named, never identified, also should a
 * client ever put a piece of a status answer into its error.
 */
function thrownRead(thrown: unknown): GroupError {
  const error = groupError(thrown);
  const mask = (text: string): string => text.replace(ID_SHAPED, '***');
  return {
    ...error,
    message: mask(error.message),
    ...(error.controller
      ? { controller: { ...error.controller, message: error.controller.message === null ? null : mask(error.controller.message) } }
      : {}),
  };
}

/**
 * The name the controllers give the FlexPendant as a holder, in lower case, per
 * kind of holder: RobotWare 7's `local` mastership holder with the application
 * `TPU` (RW 7.21.4), RobotWare 8's write-access station `FlexPendant` (RW
 * 8.2.1), both seen 2026-10-18.
 */
const FLEXPENDANT_NAME: Readonly<Partial<Record<AccessHolder['kind'], string>>> = { local: 'tpu', station: 'flexpendant' };

/**
 * A holder as the snapshot serves it, `name` and `application` as the
 * controller gave them. The one place that tells the FlexPendant by its name,
 * in the two forms seen: a `local` holder whose application is `TPU`
 * (RobotWare 7) and a station named `FlexPendant` (RobotWare 8), in any case.
 * No other form counts: not a station named `TPU`, not a `local` holder with
 * the application `FlexPendant` (neither has been seen; the client's
 * isPendant, RAPID Live and the panel use the same rule). A `remote` or
 * `internal` holder is never the FlexPendant; a holder the controller gives no
 * name is not known to be one (null).
 */
export function accessHolder(kind: AccessHolder['kind'], name: string | null, application: string | null): AccessHolder {
  const named = kind === 'station' ? name : kind === 'local' ? application : null;
  const flexPendant = kind === 'remote' || kind === 'internal' ? false
    : named === null ? null : named.trim().toLowerCase() === FLEXPENDANT_NAME[kind];
  return { kind, name, application, flexPendant };
}

/** The status words that name a mastership holder. */
const MASTERSHIP_HOLDER: Readonly<Record<string, AccessHolder['kind']>> = { local: 'local', remote: 'remote', internal: 'internal' };

/**
 * A lock of RobotWare 6 or 7 after one read of its mastership status (the
 * client's `{ mastership, uid?, application? }`, or null).
 *
 * `nomaster`: nobody holds it. `local`, `remote`, `internal`: held, by that
 * kind of client. Everything else is a failed read that leaves `held`,
 * `holder` and `asOf` as they were: `unknown` (the client's own word for an
 * answer it could not read) and any other word, with that word in
 * `reported`; an empty or missing word, or an answer that is no object; null
 * (the client could not read the status); a thrown error.
 *
 * Only `mastership` and `application` are read from the answer: the holder's
 * user id it also carries goes nowhere.
 */
export function lockFromMastership(prev: LockView, read: AccessRead, now: number): LockView {
  if ('thrown' in read) { return { ...prev, error: thrownRead(read.thrown) }; }
  const answer = read.answer;
  if (answer === null) {
    return { ...prev, error: { code: 'UNKNOWN', message: `the mastership status of ${prev.lock} could not be read` } };
  }
  const notUnderstood: GroupError = { code: 'PARSE_ERROR', message: `the mastership status of ${prev.lock} was not understood` };
  const reported = accessText(pick(answer, 'mastership'));
  if (reported === null) { return { ...prev, error: notUnderstood }; }
  const word = reported.toLowerCase();
  if (word === 'nomaster') {
    return { ...prev, held: false, holder: null, reported, claimed: null, asOf: now, error: null };
  }
  const kind = Object.hasOwn(MASTERSHIP_HOLDER, word) ? MASTERSHIP_HOLDER[word] : undefined;
  if (kind === undefined) { return { ...prev, reported, error: notUnderstood }; }
  return {
    ...prev, held: true, holder: accessHolder(kind, null, accessText(pick(answer, 'application'))),
    reported, claimed: null, asOf: now, error: null,
  };
}

/**
 * The RobotWare 8 lock, and the controller's "external control enabled" flag,
 * after one read of the write-access status. The answer is held to this
 * contract at run time, whatever the client's types say:
 *
 *   { held: boolean | null, heldByMe: boolean | null, heldByName: string | null, externalControlEnabled: boolean | null }
 *
 * Only an answer whose `held` is a boolean is a good read. `held` null,
 * missing or of any other type (the text "true" included), an answer that is
 * no object, and a thrown error are failed reads: the lock and the flag stay
 * as they were. Those four fields are read and nothing else: a holder's
 * station id, should an answer carry one, goes nowhere.
 */
export function lockFromWriteAccess(
  prev: { lock: LockView; remoteAccessEnabled: boolean | null }, read: AccessRead, now: number,
): { lock: LockView; remoteAccessEnabled: boolean | null } {
  if ('thrown' in read) { return { ...prev, lock: { ...prev.lock, error: thrownRead(read.thrown) } }; }
  const held = pick(read.answer, 'held');
  if (typeof held !== 'boolean') {
    return { ...prev, lock: { ...prev.lock, error: { code: 'PARSE_ERROR', message: 'the write-access status was not understood' } } };
  }
  const name = accessText(pick(read.answer, 'heldByName'));
  const byMe = pick(read.answer, 'heldByMe');
  const flag = pick(read.answer, 'externalControlEnabled');
  return {
    lock: {
      ...prev.lock,
      held,
      holder: held ? accessHolder('station', name !== null && name.toLowerCase() !== 'none' ? name : null, null) : null,
      reported: null,
      claimed: typeof byMe === 'boolean' ? byMe : null,
      asOf: now,
      error: null,
    },
    remoteAccessEnabled: typeof flag === 'boolean' ? flag : null,
  };
}

/** The RMMP privilege words this daemon knows (RmmpPrivilege). */
const RMMP_WORDS: readonly RmmpPrivilege[] = ['none', 'pending modify', 'pending exec', 'modify', 'exec'];

/**
 * RMMP on RobotWare 6 and 7 after one read of the session's privilege. One of
 * the known words is a good read. `unsupported` settles it: the controller
 * does not offer RMMP (or the client has no read for it), and the reader
 * stops asking until the link is next usable anew. Any other word, an empty
 * one, an answer that is no text and a thrown error are failed reads that
 * keep what was there.
 */
export function rmmpFromPrivilege(prev: RmmpView, read: AccessRead, now: number): RmmpView {
  if ('thrown' in read) { return { ...prev, error: thrownRead(read.thrown) }; }
  const word = typeof read.answer === 'string' ? read.answer.trim().replace(/\s+/g, ' ').toLowerCase() : null;
  if (word === 'unsupported') { return { supported: false, privilege: null, asOf: null, error: null }; }
  const privilege = RMMP_WORDS.find(w => w === word);
  if (privilege === undefined) {
    return { ...prev, error: { code: 'PARSE_ERROR', message: 'the RMMP privilege was not understood' } };
  }
  return { supported: true, privilege, asOf: now, error: null };
}

/**
 * Whether the daemon's own session holds a lock, from the client's own record
 * of what the session requested (`state.access.locks`, no request): `held` is
 * true, `idle` and `lost` are false, `uncertain` - and a lock the client
 * lists no entry for - is null. Never taken from a controller status.
 */
export function ownHold(access: unknown, lock: AccessLockName): boolean | null {
  const locks = pick(access, 'locks');
  if (!Array.isArray(locks)) { return null; }
  const state = pick(locks.find(l => pick(l, 'lock') === lock), 'state');
  if (state === 'held') { return true; }
  if (state === 'idle' || state === 'lost') { return false; }
  return null;
}

const isHealthy = (q: LinkQuality | undefined) => q === 'live' || q === 'polling';
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** The group of a link that carries nothing: on the wrong controller. */
function emptyGroup(): AccessGroup {
  return {
    generation: null, model: null, locks: [], remoteAccessEnabled: null,
    rmmp: { supported: null, privilege: null, asOf: null, error: null }, via: null, problem: null, asOf: null,
  };
}

/**
 * The access group.
 *
 * `view`: what the reader keeps (null before its first look). `link`: the
 * link as the client reports it. `client`: the client's own record
 * (`state.access`: its generation and this session's lock states), read
 * without a request. `canReadWriteAccess`: the client has the RobotWare 8
 * status read. `trusted` false: the link is on the wrong controller and the
 * group carries nothing.
 *
 * The generation is the client's while the link is connected; the client
 * forgets it on a disconnect, so a link that is down shows the one its kept
 * values were read under. Kept values are shown only under the generation
 * they were read under. `via` is `poll` where the fleet's reader sends
 * reads: a connected, healthy link with a known generation and no `problem`.
 * It is worked out from the link alone, so it says the same for a fleet
 * whose reader was never started.
 */
export function accessGroup(
  view: AccessView | null,
  link: { connected: boolean; quality: LinkQuality | undefined },
  client: unknown,
  canReadWriteAccess: boolean,
  trusted: boolean,
): AccessGroup {
  if (!trusted) { return emptyGroup(); }
  const healthy = link.connected && isHealthy(link.quality);
  const generation = link.connected ? clientGeneration(client) : view?.generation ?? null;
  const kept = view !== null && view.generation === generation ? view : unreadView(generation);
  const problem = generation === 'rw8' && !canReadWriteAccess ? NO_WRITE_ACCESS_READER
    : healthy && generation === null ? NO_GENERATION
    : null;
  const locks = kept.locks.map((l): AccessLockInfo => {
    const own = ownHold(client, l.lock);
    return {
      lock: l.lock,
      held: l.held,
      holder: l.holder,
      // The controller naming this client's station as holder while the client's own record does not say `held`: the two disagree.
      heldByDaemon: l.claimed === true && own !== true ? null : own,
      reported: l.reported,
      asOf: iso(l.asOf),
      error: l.error,
    };
  });
  const rmmp: RmmpInfo = { supported: kept.rmmp.supported, privilege: kept.rmmp.privilege, asOf: iso(kept.rmmp.asOf), error: kept.rmmp.error };
  const times = [...kept.locks.map(l => l.asOf), ...(kept.rmmp.supported === false ? [] : [kept.rmmp.asOf])];
  const oldest = times.length > 0 && times.every((t): t is number => t !== null) ? Math.min(...times) : null;
  return {
    generation,
    model: modelOf(generation),
    locks,
    remoteAccessEnabled: kept.remoteAccessEnabled,
    rmmp,
    via: healthy && generation !== null && problem === null ? 'poll' : null,
    problem,
    asOf: iso(oldest),
  };
}

/** One part of the access status, as the capability table and the freshness rules look at it. */
export interface AccessPart {
  /** The lock's name, or `RMMP`. */
  name: string;
  asOf: string | null;
  error: GroupError | null;
  /** Read and understood on this connection, and its last read did not fail (partGood). */
  good: boolean;
}

/**
 * Whether a part is good: read and understood on this connection, and its
 * last read did not fail. A lock: it carries a value and no error. RMMP: it
 * is offered, a privilege was read, and no error.
 */
export function partGood(part: AccessLockInfo | RmmpInfo): boolean {
  return 'lock' in part
    ? part.held !== null && part.error === null
    : part.supported === true && part.privilege !== null && part.error === null;
}

/** The parts of a group: each lock, and RMMP unless the controller does not offer it. */
export function accessParts(g: Pick<AccessGroup, 'locks' | 'rmmp'>): AccessPart[] {
  const parts: AccessPart[] = g.locks.map(l => ({ name: l.lock, asOf: l.asOf, error: l.error, good: partGood(l) }));
  if (g.rmmp.supported !== false) { parts.push({ name: 'RMMP', asOf: g.rmmp.asOf, error: g.rmmp.error, good: partGood(g.rmmp) }); }
  return parts;
}

/**
 * What counts as an access change worth announcing: everything but the
 * moving of an `asOf` (each compares as set or unset, as in the stream).
 */
export function accessSignature(g: AccessGroup): string {
  return JSON.stringify(g, (key, value) => (key === 'asOf' ? value !== null : value));
}

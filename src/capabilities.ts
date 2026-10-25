import { NO_GENERATION, NO_WRITE_ACCESS_READER } from './access.js';
import { ioTableComplete, ioTableLoaded } from './io.js';
import { TESTED_VERSIONS } from './passport.js';
import type {
  AccessGroup, CapabilitiesGroup, Capability, CapabilityId, CapabilityState, ControllerSnapshot, EventsGroup, Generation, LinkGroup,
  MotionGroup,
} from './schema/v0.js';

/**
 * Capabilities: the pure half - what the daemon can read on a
 * controller and how it arrives, as one table. Every row is derived from the
 * other groups of the same snapshot and from what the client offers
 * (`ClientFacts`); nothing here reaches a controller.
 *
 * The three states that are not `available` mean different things, and the
 * table keeps them apart. `unavailable` is fixed for the connection: the
 * protocol, the other generation's access model, a client release without
 * the read, a controller that does not offer the service. `degraded` should
 * work and does not at the moment, and may come back without a reconnect.
 * `unknown` is not determined yet.
 */

/** Why a controller's event times cannot be corrected when the client has no clock read. */
export const NO_CLOCK_READER = 'this abb-rws-client cannot read the controller clock';

/** The rows of a capability table, in wire order (CapabilityId). */
export const CAPABILITY_IDS: readonly CapabilityId[] = [
  'status-push', 'events-push', 'event-times', 'io-push', 'io-table', 'joint-limits', 'mastership', 'write-access', 'rmmp',
];

/** What the client offers, as far as the fleet can tell from its manager without a request. */
export interface ClientFacts {
  /** The client can read the controller clock. */
  clock: boolean;
  /** The client hands out raw subscription events and lets the daemon edit its subscription group. */
  ioEvents: boolean;
  /** The client can read the RobotWare 8 write-access status. */
  writeAccessStatus: boolean;
  /** The manager owns a subscription group now (RWS 2.0 with its event stream up). */
  subscriptionGroup: boolean;
  /** The signal table was read on the current connection. */
  ioTableLoaded: boolean;
  /** How many signals that table lists. */
  ioTableRows: number;
}

/** A property of an object the daemon did not make, read without trusting it. */
function pick(from: unknown, key: string): unknown {
  if (from === null || typeof from !== 'object') { return undefined; }
  try { return (from as Record<string, unknown>)[key]; } catch { return undefined; }
}

/** The client facts of a controller's manager; everything false for none. */
export function clientFacts(manager: unknown): ClientFacts {
  const has = (method: string): boolean => typeof pick(manager, method) === 'function';
  const state = pick(manager, 'state');
  const signals = pick(state, 'ioSignals');
  const rows: readonly unknown[] = Array.isArray(signals) ? signals : [];
  const loadedFlag = pick(state, 'ioSignalsLoaded');
  return {
    clock: has('getControllerClock'),
    ioEvents: has('onSubscriptionEvent') && has('updateSubscriptionGroup'),
    writeAccessStatus: has('getWriteAccessStatus'),
    subscriptionGroup: pick(manager, 'subscriptionGroupPath') !== undefined,
    ioTableLoaded: ioTableLoaded({
      connected: pick(state, 'connected') === true, ioSignals: rows,
      ...(typeof loadedFlag === 'boolean' ? { ioSignalsLoaded: loadedFlag } : {}),
    }),
    ioTableRows: rows.length,
  };
}

const NO_FACTS: ClientFacts = { clock: false, ioEvents: false, writeAccessStatus: false, subscriptionGroup: false, ioTableLoaded: false, ioTableRows: 0 };

/** Said for a part of the access status, a clock or a table the daemon has not read on this connection so far. */
const NOT_READ_YET = 'not read on this connection yet';

const row = (id: CapabilityId, state: CapabilityState, reason: string | null): Capability => ({ id, state, reason: state === 'available' ? null : reason });

/** `events-push`: new event-log messages are announced by the controller. */
function eventsPush(link: LinkGroup, events: EventsGroup): Capability {
  const id = 'events-push';
  if (events.error) { return row(id, 'degraded', events.error.message); }
  if (events.via === 'poll') {
    return row(id, 'degraded', link.qualityReason || 'no event subscription delivers; the log is read every few seconds');
  }
  if (events.via === 'subscription') { return row(id, 'available', null); }
  return row(id, 'unknown', 'the controller is not yet confirmed to be the one that was added');
}

/** `event-times`: event times are corrected to UTC. */
function eventTimes(events: EventsGroup, facts: ClientFacts | null): Capability {
  const id = 'event-times';
  const problem = events.clock.problem;
  if (problem === NO_CLOCK_READER || (facts !== null && !facts.clock)) { return row(id, 'unavailable', NO_CLOCK_READER); }
  if (problem !== null) { return row(id, 'degraded', problem); }
  if (events.clock.offsetMs !== null) { return row(id, 'available', null); }
  return row(id, 'unknown', 'the controller clock is not measured yet');
}

/** `io-push`: watched I/O signals arrive by subscription. */
function ioPush(link: LinkGroup, protocol: Generation | null, facts: ClientFacts): Capability {
  const id = 'io-push';
  if (protocol === 'rws1') { return row(id, 'unavailable', 'watched signals are read by polling on RWS 1.0'); }
  if (protocol === null) { return row(id, 'unknown', link.qualityReason); }
  if (!facts.ioEvents) { return row(id, 'unavailable', 'this abb-rws-client cannot deliver signal changes'); }
  if (link.quality !== 'live' || !facts.subscriptionGroup) { return row(id, 'degraded', link.qualityReason); }
  return row(id, 'available', null);
}

/** `io-table`: the signal table lists every signal. */
function ioTable(protocol: Generation | null, facts: ClientFacts): Capability {
  const id = 'io-table';
  if (!facts.ioTableLoaded) { return row(id, 'unknown', 'the signal table is not loaded yet'); }
  if (!ioTableComplete(protocol, facts.ioTableRows)) {
    return row(id, 'degraded', 'the table may list only the first 100 signals; search by name finds the rest');
  }
  return row(id, 'available', null);
}

/** `joint-limits`: joints carry their unit and limits. */
function jointLimits(motion: MotionGroup): Capability {
  const id = 'joint-limits';
  if (motion.units.length === 0) {
    return row(id, 'unknown', 'no mechanical unit was sampled yet; joints are read while a consumer watches motion');
  }
  // A unit without joints is a unit whose joints were not read (its own error says why), not a limits gap.
  const unread = motion.units.find(u => u.joints.length === 0);
  if (unread) {
    return row(id, 'degraded', unread.error?.message ?? `no joint of ${unread.name} was read yet`);
  }
  const lacking = motion.units.find(u => u.joints.some(j => j.unit === null || j.min === null || j.max === null));
  if (lacking) {
    return row(id, 'degraded', `the axis configuration of ${lacking.name} was not read, or the controller gives none for an axis`);
  }
  return row(id, 'available', null);
}

/** `mastership`: the mastership part of `access` can be read (RobotWare 6 and 7). */
function mastership(access: AccessGroup): Capability {
  const id = 'mastership';
  if (access.generation === 'rw8') { return row(id, 'unavailable', 'RobotWare 8 has no mastership; see write-access'); }
  if (access.problem === NO_GENERATION) { return row(id, 'unavailable', NO_GENERATION); }
  if (access.generation === null) { return row(id, 'unknown', NOT_READ_YET); }
  const failing = access.locks.find(l => l.error !== null);
  if (failing) { return row(id, 'degraded', failing.error!.message); }
  if (access.locks.length > 0 && access.locks.every(l => l.held !== null)) { return row(id, 'available', null); }
  return row(id, 'unknown', NOT_READ_YET);
}

/** `write-access`: the write-access part of `access` can be read (RobotWare 8). */
function writeAccess(access: AccessGroup): Capability {
  const id = 'write-access';
  if (access.generation === 'rw6' || access.generation === 'rw7') { return row(id, 'unavailable', 'RobotWare 6 and 7 use mastership'); }
  if (access.problem === NO_WRITE_ACCESS_READER) { return row(id, 'unavailable', NO_WRITE_ACCESS_READER); }
  if (access.problem === NO_GENERATION) { return row(id, 'unavailable', NO_GENERATION); }
  const lock = access.locks.find(l => l.lock === 'writeaccess');
  if (lock?.error) { return row(id, 'degraded', lock.error.message); }
  if (lock && lock.held !== null) { return row(id, 'available', null); }
  return row(id, 'unknown', NOT_READ_YET);
}

/** `rmmp`: the RMMP part of `access` can be read (RobotWare 6 and 7). */
function rmmp(access: AccessGroup): Capability {
  const id = 'rmmp';
  if (access.generation === 'rw8') { return row(id, 'unavailable', 'RobotWare 8 has no RMMP'); }
  if (access.problem === NO_GENERATION) { return row(id, 'unavailable', NO_GENERATION); }
  if (access.generation !== null && access.rmmp.supported === false) { return row(id, 'unavailable', 'this controller does not offer RMMP'); }
  if (access.rmmp.error) { return row(id, 'degraded', access.rmmp.error.message); }
  if (access.generation !== null && access.rmmp.supported === true && access.rmmp.privilege !== null) { return row(id, 'available', null); }
  return row(id, 'unknown', NOT_READ_YET);
}

/** Whether a RobotWare major.minor is one this daemon was tested against; null while the version is not known. */
function testedVersion(major: number | null, minor: number | null): boolean | null {
  if (major === null || minor === null) { return null; }
  return (TESTED_VERSIONS as readonly string[]).includes(`${major}.${minor}`);
}

/**
 * The capabilities group, from the other groups of the same snapshot.
 * `protocol`: the protocol the link speaks (null while not connected).
 * `facts`: what the client offers (null: nothing is known of it, and nothing
 * it would have to offer counts as offered).
 *
 * A link on the wrong controller has no table: no row, and nothing else. A
 * link that is not healthy (not connected, or neither `live` nor `polling`)
 * has no table to speak of either: every row is `unknown` with the link's
 * reason, whatever values the groups keep from before - a lock read before
 * an outage, a measured clock offset, the last joints - or rows would read
 * `available` on a controller nobody can reach.
 *
 * On a healthy link each row is decided in this order: `unavailable`, then
 * `degraded`, then `available`, then `unknown`.
 */
export function capabilitiesGroup(
  groups: Pick<ControllerSnapshot, 'identity' | 'link' | 'panel' | 'motion' | 'events' | 'access'>,
  protocol: Generation | null,
  facts: ClientFacts | null,
): CapabilitiesGroup {
  const { identity, link, panel, motion, events, access } = groups;
  if (link.identityCheck.status === 'mismatch') {
    return { protocol: null, generation: null, robotWare: null, tested: null, entries: [], asOf: null };
  }
  const head = {
    protocol: link.connected ? protocol : null,   // a client may remember the protocol of a link that is gone
    generation: access.generation,
    robotWare: identity?.robotWare.raw ?? null,
    tested: identity ? testedVersion(identity.robotWare.major, identity.robotWare.minor) : null,
  };
  const healthy = link.connected && (link.quality === 'live' || link.quality === 'polling');
  if (!healthy) {
    return { ...head, entries: CAPABILITY_IDS.map(id => row(id, 'unknown', link.qualityReason)), asOf: panel.asOf };
  }
  const known = facts ?? NO_FACTS;
  const entries: Capability[] = [
    link.quality === 'live' ? row('status-push', 'available', null) : row('status-push', 'degraded', link.qualityReason),
    eventsPush(link, events),
    eventTimes(events, facts),
    ioPush(link, protocol, known),
    ioTable(protocol, known),
    jointLimits(motion),
    mastership(access),
    writeAccess(access),
    rmmp(access),
  ];
  return { ...head, entries, asOf: panel.asOf };
}

import { accessParts } from './access.js';
import type {
  AccessGroup, ControllerSnapshot, EventsGroup, FreshGroupName, FreshnessGroup, FreshnessLevel, GroupFreshness, GroupFreshnessState,
  IoGroup, MotionGroup,
} from './schema/v0.js';

/**
 * Freshness: the pure half - whether what a snapshot shows is
 * current, said once for the controller and once per group. A function of
 * the snapshot's other groups and of nothing else: it changes only when one
 * of them does, so the stream needs no clock of its own. No reason holds a
 * time or a running count (the stream compares content, and a reason that
 * moved would send a frame per tick).
 */

/** Said for every group of a link that answers as a different controller. */
export const WITHHELD_REASON = 'the link is on a different controller';

/** Said for a group a healthy link has not delivered yet. */
const NOT_READ_YET = 'not read yet';

/** Why a healthy link is not read for a group that outlives it (the event log). */
const NOT_CONFIRMED = 'the controller is not yet confirmed to be the one that was added';

/** The groups freshness reports on, in wire order (FreshGroupName). */
export const FRESH_GROUPS: readonly FreshGroupName[] = ['identity', 'panel', 'rapid', 'motion', 'io', 'events', 'access'];

/**
 * How a group stands, and why. `waiting`: the group is `partial` only because
 * some of its parts have not been read yet, and none of them is failing.
 */
type Verdict = [state: GroupFreshnessState, reason: string | null, waiting?: boolean];

const current: Verdict = ['current', null];

/** identity, panel, rapid: they ride the link itself. `read`: the group holds something. */
function linkBorne(read: boolean, healthy: boolean, linkReason: string): Verdict {
  if (!read) { return ['unread', healthy ? NOT_READ_YET : linkReason]; }
  return healthy ? current : ['stale', linkReason];
}

function motionVerdict(motion: MotionGroup, healthy: boolean, linkReason: string): Verdict {
  if (!motion.watching) { return ['idle', 'no consumer is watching']; }
  if (!healthy) { return ['stale', linkReason]; }
  if (motion.units.length === 0 || motion.asOf === null) { return ['unread', 'not sampled yet']; }
  const failing = motion.units.filter(u => u.error !== null);
  if (failing.length === motion.units.length) { return ['stale', failing[0].error!.message]; }
  if (failing.length > 0) { return ['partial', `${failing.length} of ${motion.units.length} mechanical units could not be read`]; }
  return current;
}

function ioVerdict(io: IoGroup, healthy: boolean, linkReason: string): Verdict {
  if (!io.watching) { return ['idle', 'no consumer is watching']; }
  if (io.signals.length === 0) { return ['idle', 'no signal is watched']; }
  if (!healthy) { return ['stale', linkReason]; }
  const n = io.signals.length;
  const failing = io.signals.filter(s => s.error !== null);
  if (failing.length === n) { return ['stale', failing[0].error!.message]; }
  if (failing.length > 0) { return ['partial', `${failing.length} of ${n} watched signals could not be read`]; }
  const unread = io.signals.filter(s => s.asOf === null).length;
  if (unread === n) { return ['unread', NOT_READ_YET]; }
  if (unread > 0) { return ['partial', `${unread} of ${n} watched signals not read yet`, true]; }
  return current;
}

function eventsVerdict(events: EventsGroup, healthy: boolean, linkReason: string): Verdict {
  if (events.feed === null) { return ['unread', healthy ? NOT_READ_YET : linkReason]; }
  if (events.via === null) { return [events.asOf === null ? 'unread' : 'stale', healthy ? NOT_CONFIRMED : linkReason]; }
  if (events.error) { return ['stale', events.error.message]; }
  // Readable, no failure, and no listing taken so far: the first read is on its way.
  if (events.asOf === null) { return ['unread', NOT_READ_YET]; }
  if (events.clock.problem !== null) {
    // With an offset measured earlier the times are still corrected, by that one.
    return ['partial', events.clock.offsetMs === null
      ? `event times are not corrected: ${events.clock.problem}`
      : `event times are corrected with an earlier clock reading: ${events.clock.problem}`];
  }
  return current;
}

/**
 * The access group, in seven rules, the first that applies:
 * 1. a `problem`: `unavailable` (no read will come with this client on this controller);
 * 2. no generation: `unread`;
 * 3. nothing is being read (`via` null): `stale` when a part holds a reading, else `unread`;
 * 4. every part's last read failed: `stale`;
 * 5. no part failing and none good: `unread` (the first round of the connection is on its way);
 * 6. some part failing, or some part not good: `partial`, naming those parts;
 * 7. `current`: every part carries a value read on this connection and no read is failing.
 * A status that was not understood can therefore never be `current`. Under
 * rule 6 the group is only waiting while no part is failing: the first round
 * of a connection is half-way.
 */
function accessVerdict(access: AccessGroup, linkReason: string): Verdict {
  if (access.problem !== null) { return ['unavailable', access.problem]; }
  if (access.generation === null) { return ['unread', linkReason]; }
  const parts = accessParts(access);
  if (access.via === null) { return [parts.some(p => p.asOf !== null) ? 'stale' : 'unread', linkReason]; }
  const failing = parts.filter(p => p.error !== null);
  if (parts.length > 0 && failing.length === parts.length) { return ['stale', failing[0].error!.message]; }
  if (failing.length === 0 && !parts.some(p => p.good)) { return ['unread', 'not read on this connection yet']; }
  const wanting = parts.filter(p => !p.good);
  if (wanting.length > 0) {
    return ['partial', wanting.map(p => `${p.name}: ${p.error !== null ? p.error.message : 'not read yet'}`).join('; '), failing.length === 0];
  }
  return current;
}

/**
 * The freshness group, from the other groups of the same snapshot.
 *
 * Level: a link on a different controller is `wrong-controller`; no link
 * (not connected, `disconnected` or `reconnecting`) is `down`; a `stale`
 * link, or any group that is `stale` or failing in part, is `degraded`; else
 * `current`. `idle`, `unread` and `unavailable` never lower the level, and
 * neither does a group that is `partial` only because some of its parts have
 * not been read yet (a signal just added to a watch, the first round of
 * status reads half-way): a read that is on its way is no fault.
 *
 * Reasons: none when `current`; the link's own reason for
 * `wrong-controller`; `link: <reason>` alone for `down` and for a `stale`
 * link (the groups would only repeat it); otherwise one `<group>: <reason>`
 * per group that lowers the level.
 */
export function freshnessGroup(
  groups: Pick<ControllerSnapshot, 'identity' | 'link' | 'panel' | 'rapid' | 'motion' | 'io' | 'events' | 'access'>,
): FreshnessGroup {
  const { identity, link, panel, rapid, motion, io, events, access } = groups;
  const mismatch = link.identityCheck.status === 'mismatch';
  const healthy = link.connected && (link.quality === 'live' || link.quality === 'polling');
  const linkReason = link.qualityReason;
  const asOf: Record<FreshGroupName, string | null> = {
    identity: identity?.asOf ?? null, panel: panel.asOf, rapid: rapid.asOf, motion: motion.asOf, io: io.asOf, events: events.asOf,
    access: access.asOf,
  };
  const verdict = (group: FreshGroupName): Verdict => {
    if (mismatch) { return ['withheld', WITHHELD_REASON]; }
    switch (group) {
      case 'identity': return linkBorne(identity !== null, healthy, linkReason);
      case 'panel': return linkBorne(panel.asOf !== null, healthy, linkReason);
      case 'rapid': return linkBorne(rapid.asOf !== null, healthy, linkReason);
      case 'motion': return motionVerdict(motion, healthy, linkReason);
      case 'io': return ioVerdict(io, healthy, linkReason);
      case 'events': return eventsVerdict(events, healthy, linkReason);
      case 'access': return accessVerdict(access, linkReason);
    }
  };
  const waiting = new Set<FreshGroupName>();
  const entries = FRESH_GROUPS.map((group): GroupFreshness => {
    const [state, reason, onlyWaiting] = verdict(group);
    if (state === 'partial' && onlyWaiting) { waiting.add(group); }
    return { group, state, asOf: asOf[group], reason: state === 'current' ? null : reason };
  });
  const down = !link.connected || link.quality === 'disconnected' || link.quality === 'reconnecting';
  const lowered = entries.filter(e => e.state === 'stale' || (e.state === 'partial' && !waiting.has(e.group)));
  const level: FreshnessLevel = mismatch ? 'wrong-controller'
    : down ? 'down'
    : link.quality === 'stale' || lowered.length > 0 ? 'degraded'
    : 'current';
  const reasons = level === 'current' ? []
    : level === 'wrong-controller' ? [linkReason]
    : level === 'down' || link.quality === 'stale' ? [`link: ${linkReason}`]
    : lowered.map(e => `${e.group}: ${e.reason}`);
  return { level, reasons, groups: entries };
}

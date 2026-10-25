import { POSE_EVERY_TICKS, motionTargetHz } from './motion.js';
import { IO_WATCH_MAX, type Generation, type IoGroup, type IoWatchedSignal, type LinkQuality } from './schema/v0.js';

/**
 * I/O: the pure half - what the watcher's reads and events become in
 * the snapshot. The watcher itself lives in the fleet (`ControllerFleet`),
 * exactly as the motion sampler does.
 */

/** A watch lease lasts this long; a consumer renews it at least every half. */
export const IO_LEASE_MS = 15_000;

/**
 * The most signals watched on one controller, every consumer's lease together
 * (the union the watcher serves); defined with the wire types, which cap
 * `IoGroup.signals` by it, and re-exported here. RW 7.19/7.20 regressed subscription
 * bodies over ~12 signal resources (~1.4 KB, tech-community 12130; 7.21 not
 * yet re-probed), and every polled signal is one request against the
 * controller's <20 req/s ceiling - a watch is a working set, not a mirror of
 * the whole I/O table (search serves that). The anonymous lease has no cap of
 * its own beyond this one, as when it was the only set.
 */
export { IO_WATCH_MAX };

/**
 * The most signals one consumer's lease (a lease with an id) may hold, so no
 * single consumer can take the whole of IO_WATCH_MAX: at least 8 stay for
 * the others.
 */
export const IO_WATCH_LEASE_MAX = 16;

/** Why a requested signal was refused for a cap (IoWatch.rejected). */
export const IO_CAP_REASON = {
  lease: `lease cap reached (at most ${IO_WATCH_LEASE_MAX} signals per consumer lease)`,
  controller: `controller cap reached (at most ${IO_WATCH_MAX} signals watched on this controller, all consumers together)`,
} as const;

/**
 * Signal resources are added to a live RWS 2.0 subscription group at most this
 * many per `updateSubscriptionGroup` PUT, so no single body approaches the
 * 7.19/7.20 regression ceiling (~12); adds are additive, so chunking is safe.
 */
export const IO_SUBSCRIBE_CHUNK = 6;

/**
 * Delay before a signal whose group add failed is tried again, after n
 * failures: 1, 2, 4, 8 ... then every 60 s. A signal that failed once is
 * retried in an edit of its own, so a name the controller refuses cannot hold
 * back the others in its chunk; it stays on the poll path meanwhile.
 */
export function ioEditRetryMs(failures: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * A signal's removal from the group is tried this many times in all (the
 * retries ioEditRetryMs apart: 1, 2, 4, 8 s); after that it is left to the
 * group, which takes it along when it ends. Until then it keeps delivering
 * events, which the watcher ignores once the signal is no longer watched.
 */
export const IO_DROP_TRIES = 5;

/**
 * An I/O signal name as the controller forms it: letters, digits and
 * underscores, alone or as `network/device/signal`. The name goes into a
 * subscription body and a request path as it is, so anything else - a '&' or
 * '=' that would add form fields, a '?', '#' or '..' that would aim the
 * request at another resource - is refused before it reaches the controller.
 */
export const IO_SIGNAL_NAME = /^(?:[A-Za-z0-9_]+\/[A-Za-z0-9_]+\/)?[A-Za-z0-9_]+$/;

/**
 * Why a watch request's signal name cannot be watched, or null when it can.
 * `table`: the controller's signal names (as its signal table spells them)
 * once the table is loaded on the current connection, null before - a name is
 * then checked for its form only. A `network/device/signal` name is looked up
 * by its signal part, the way the table lists it.
 */
export function ioNameProblem(name: string, table: ReadonlySet<string> | null): string | null {
  if (!IO_SIGNAL_NAME.test(name)) {
    return 'not an I/O signal name (letters, digits and underscores, optionally as network/device/signal)';
  }
  if (table && !table.has(name.slice(name.lastIndexOf('/') + 1))) {
    return 'no such signal on this controller';
  }
  return null;
}

/**
 * Whether a manager's cached signal table was read on its current connection.
 * The client says so in `ioSignalsLoaded`; a client without that flag empties
 * the table on disconnect, so a connected link with a non-empty table is the
 * best sign it has. Until then an empty table means "not read yet", not "no
 * signals".
 */
export function ioTableLoaded(state: { connected: boolean; ioSignals: readonly unknown[]; ioSignalsLoaded?: boolean }): boolean {
  if (typeof state.ioSignalsLoaded === 'boolean') { return state.ioSignalsLoaded; }
  return state.connected && state.ioSignals.length > 0;
}

/**
 * The most rows one RWS 1.0 signal-table read returns: the client reads a
 * single page of this size there and does not follow its next-page link, so
 * a table this long may be only the first page. RWS 2.0 walks every page.
 */
export const IO_RWS1_TABLE_PAGE = 100;

/**
 * Whether a loaded signal table lists every signal on the controller - only
 * then is a name missing from it refused. A table that may be cut short
 * checks names for their form only; a name the controller does not have then
 * fails on its first read, with the controller's own error on the signal.
 */
export function ioTableComplete(generation: Generation | null, rows: number): boolean {
  return generation === 'rws2' || rows < IO_RWS1_TABLE_PAGE;
}

/**
 * Seconds a consumer is told to wait (Retry-After) before asking again for a
 * signal table that is not loaded yet. The client reads the table on the first
 * poll of every connection, and the answer comes from the daemon's memory, so
 * asking again costs the controller nothing.
 */
export const IO_TABLE_RETRY_AFTER_S = 2;

/**
 * The requests per second one controller's session is budgeted at, all
 * spenders together. Every request rides one FIFO queue that the client
 * spaces 55 ms apart - 18.2 req/s at best, about 16 measured on a VC - with
 * no priorities. Budgeting 14 keeps that queue from backing up and leaves
 * room for what nobody reserves: the pointer poller's idle reads (one per
 * active task every 5 s), the event reader's reads of the log (about a
 * request a second at most, and only while no subscription delivers;
 * eventsReadIntervalMs, events.ts), the access reader's status reads (at
 * most 0.8 requests a second; startAccessReader, fleet.ts) and reads on
 * demand such as a module's source or a signal search, which their own
 * budget holds to a few requests a second (READ_RATE_PER_S, readBudget.ts).
 */
export const IO_CEILING_REQ_S = 14;

/** What else spends a controller's request budget, as far as the fleet can see it. */
export interface IoLoad {
  /** Mechanical units the motion sampler reads while a motion watch is live; 0 without one. */
  motionUnits: number;
  /** Tasks whose program and motion pointers are read every second (the active tasks while RAPID runs); 0 when stopped. */
  runningTasks: number;
}

/**
 * The requests per second the I/O watcher may START on one controller -
 * signal reads and subscription-group edits (adds and removals) together, on
 * one clock. Out of IO_CEILING_REQ_S it first reserves:
 *   - the manager's own polling: ~2 req/s while the link is `live` (slow
 *     cadence), ~12 while it is `polling` (fast cadence - exactly when the
 *     I/O poller is needed most);
 *   - the motion sampler, per mechanical unit while a motion watch is live:
 *     its joint rate plus a pose read every POSE_EVERY_TICKS-th round
 *     (10 req/s per unit on a live link, 2.5 while polling);
 *   - the RAPID pointer poller: 2 reads/s per task while a program runs.
 * The rest is the I/O share, at most 8 req/s. It never starves to zero: one
 * request a second keeps `asOf` honest on a crowded link - the one accepted
 * overrun. Overspending does not break the controller; it starves the other
 * samplers. Underspending makes lamps visibly laggy.
 */
export function ioBudgetHz(quality: LinkQuality | undefined, load: IoLoad): number {
  const managerSpend = quality === 'polling' ? 12 : 2;
  const motionSpend = load.motionUnits * motionTargetHz(quality) * (1 + 1 / POSE_EVERY_TICKS);
  const pointerSpend = 2 * load.runningTasks;
  return Math.min(8, Math.max(1, IO_CEILING_REQ_S - managerSpend - motionSpend - pointerSpend));
}

/**
 * Signal reads per second while the watcher is POLLING `watchedCount` signals
 * (RWS 1.0 always; RWS 2.0 while its stream is down, or for a signal's
 * confirming read): the I/O budget, but at most 2 Hz per lamp. Each read is
 * one request, so the per-signal refresh rate is `ioPollHz(...) /
 * watchedCount` - 12 polled signals at 6 reads/s refresh every 2 s.
 */
export function ioPollHz(watchedCount: number, quality: LinkQuality | undefined, load: IoLoad): number {
  if (watchedCount <= 0) { return 0; }
  return Math.min(ioBudgetHz(quality, load), watchedCount * 2);
}

/** What the fleet keeps per watched signal. */
export interface WatchedSignal {
  name: string;
  type: string | null;
  value: string | null;
  via: IoWatchedSignal['via'];
  /** When the value was last confirmed (ms); null before the first read. */
  asOf: number | null;
  error: IoWatchedSignal['error'];
}

/** What the fleet holds per watched controller - all a snapshot needs. */
export interface IoView {
  /** The last of the watch leases runs until this time (ms); 0 when never watched. */
  leaseUntil: number;
  /** The union of every lease's signals. */
  signals: WatchedSignal[];
}

/** One consumer's I/O lease: when it runs out (ms), and the signals it holds, in the order it asked for them. */
export interface IoLease {
  until: number;
  names: string[];
}

/**
 * The signals a controller watches for its leases: every lease's names, each
 * once, the leases in the order they were opened and each lease's names in
 * its own order - so a single consumer's set comes back as it asked for it.
 */
export function ioLeaseUnion(leases: Iterable<IoLease>): string[] {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const l of leases) {
    for (const n of l.names) {
      if (!seen.has(n)) { seen.add(n); union.push(n); }
    }
  }
  return union;
}

/**
 * Which of the requested names a lease may hold, and why the rest may not, in
 * the order they were asked for. Names are trimmed; a blank one or a repeat
 * is skipped. `problemOf` refuses a name for what it is (ioNameProblem).
 * `others` is what every other running lease holds. The lease's own cap
 * (`ownCap`: IO_WATCH_LEASE_MAX for a lease with an id, null for the
 * anonymous lease) counts every name it holds; the controller's cap
 * (IO_WATCH_MAX) counts only names no other lease holds, since the union
 * already has the rest.
 */
export function ioLeaseGrant(
  requested: readonly string[],
  problemOf: (name: string) => string | null,
  others: ReadonlySet<string>,
  ownCap: number | null,
): { accepted: string[]; rejected: Array<{ name: string; reason: string }> } {
  const union = new Set(others);
  const seen = new Set<string>();
  const accepted: string[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  for (const raw of requested) {
    const name = raw.trim();
    if (name.length === 0 || seen.has(name)) { continue; }
    seen.add(name);
    const problem = problemOf(name);
    if (problem) {
      rejected.push({ name, reason: problem });
    } else if (ownCap !== null && accepted.length >= ownCap) {
      rejected.push({ name, reason: IO_CAP_REASON.lease });
    } else if (!union.has(name) && union.size >= IO_WATCH_MAX) {
      rejected.push({ name, reason: IO_CAP_REASON.controller });
    } else {
      accepted.push(name);
      union.add(name);
    }
  }
  return { accepted, rejected };
}

/**
 * The signal a subscription event names, or null when the event is not a
 * signal event. Shapes per generation (RWS 1.0 reports the raw path; RWS 2.0
 * normalises the six panel names but passes signal paths through):
 *   /rw/iosystem/signals/Local/DRV_1/do_x;state
 *   /rw/iosystem/signals/do_x;lvalue
 * Returns the path segment between `signals/` and `;` ('Local/DRV_1/do_x').
 * Captured 2026-09-27 on all three VCs, in the response bodies of
 * `POST /subscription` and `PUT /subscription/{group}` (the group's initial
 * state, one `li.ios-signalstate-ev` per signal - the same shape the socket
 * pushes, though no pushed frame is on record raw for any generation): the
 * signal is named FLAT, `/rw/iosystem/signals/SafetyEnable;state`, with no
 * network/device in front, and the first span is `lvalue` on every
 * generation. The spans after it differ: RWS 2.0 (RW 7.21, RW 8.1.1) sends
 * `lvalue`, `lstate`, `quality`, `time`; RWS 1.0 (RW 6.16.03) sends `lvalue`,
 * `lstate` only, no quality and no time. On RW 8.1.1, four 200 PUT bodies
 * of six IIO_* signals each carried that shape; on RW 6.16.03,
 * `POST /subscription` for MOTLMP answered 201 with
 * `<li class="ios-signalstate-ev" title="MOTLMP"><a href="/rw/iosystem/
 * signals/MOTLMP;state" rel="self"/><span class="lvalue">0</span><span
 * class="lstate">not simulated</span></li>`. For the pushed path, on
 * RW 8.1.1, an IIO_do8 flip written from another session reached the
 * daemon's watched value `via subscription` 217-291 ms after the write.
 * After its one bind-time read (fleet's `confirm` set on a successful
 * group add) a subscribed signal is read again only when a frame names it or
 * an event arrives without a value (fleet onIoEvent), and IIO_do8's `asOf`
 * was 00:11:58 and SafetyEnable's 00:06:30 before the 00:24 flips - so the
 * two updates could only have come from a frame, whose resource resolved to
 * the flat name end to end.
 */
export function signalNameFromResource(resource: string): string | null {
  const m = /\/iosystem\/signals\/([^;]+)/.exec(resource);
  if (!m) { return null; }
  const name = m[1].replace(/\/+$/, '');
  return name.length > 0 ? name : null;
}

/**
 * The watched signal a subscription event belongs to. Watch requests name a
 * signal the way `listAllSignals` spells it, but the event carries a path that
 * may carry network/device segments in front - so an exact match wins, and a
 * path-suffix match (`.../{name}`) is accepted second. Ambiguity (two watched
 * names both suffix-matching) returns null rather than guessing.
 */
export function watchedSignalFor(signals: readonly WatchedSignal[], eventName: string): WatchedSignal | null {
  const exact = signals.find(s => s.name === eventName);
  if (exact) { return exact; }
  const bySuffix = signals.filter(s => eventName.endsWith(`/${s.name}`) || s.name.endsWith(`/${eventName}`));
  return bySuffix.length === 1 ? bySuffix[0] : null;
}

const isHealthy = (q: LinkQuality | undefined) => q === 'live' || q === 'polling';

/**
 * The io group. `watching`: a consumer holds a lease. Values survive the end
 * of a lease or a degraded link, with `asOf` frozen at the last confirmation.
 * A link on the WRONG controller carries none of it (as every group).
 */
export function ioGroup(
  io: IoView | null,
  link: { quality: LinkQuality | undefined; connected: boolean },
  trusted: boolean,
  now: number,
): IoGroup {
  if (!trusted) {
    return { watching: false, signals: [], asOf: null };
  }
  const watching = io !== null && io.leaseUntil > now;
  const serving = watching && link.connected && isHealthy(link.quality);
  const newest = io ? io.signals.reduce<number | null>((n, s) => (s.asOf !== null && (n === null || s.asOf > n) ? s.asOf : n), null) : null;
  return {
    watching,
    signals: io ? io.signals.map(s => ({
      name: s.name,
      type: s.type,
      value: s.value,
      via: serving ? s.via : null,
      asOf: s.asOf !== null ? new Date(s.asOf).toISOString() : null,
      error: s.error,
    })) : [],
    asOf: newest !== null ? new Date(newest).toISOString() : null,
  };
}

/**
 * What counts as an io change worth announcing: everything but the timestamps
 * (a poll round that reconfirms the same values is not news).
 */
export function ioSignature(g: IoGroup): string {
  return JSON.stringify({
    watching: g.watching,
    signals: g.signals.map(s => ({ name: s.name, type: s.type, value: s.value, via: s.via, error: s.error })),
  });
}

import { MultiRobotManager, RobotManager, RwsError, setLogger } from 'abb-rws-client';
import type { ElogMessage, RobotState, Signal, SubscriptionEvent, SubscriptionResource } from 'abb-rws-client';
import {
  accessGroup, accessRetryMs, accessSignature, answeredWord, clientGeneration, domainOf, lockFromMastership, lockFromWriteAccess,
  rmmpFromPrivilege, unreadView,
  type AccessRead, type AccessView,
} from './access.js';
import { NO_CLOCK_READER, capabilitiesGroup, clientFacts, type ClientFacts } from './capabilities.js';
import type { ControllerConfig } from './config.js';
import { groupError, redactSecrets } from './errorMap.js';
import {
  EventFeed, clockOffsetMs, eventText, eventsGroup, eventsReadIntervalMs, eventsReadRequests, eventsRetryMs, eventsSignature,
  type EventsView,
} from './events.js';
import { freshnessGroup } from './freshness.js';
import { toIdentity } from './identity.js';
import {
  MOTION_LEASE_MS, POSE_EVERY_TICKS, RATE_WINDOW_MS, UNIT_INFO_RETRY_MS, axisConfigRetryMs,
  motionGroup, motionJoints, motionSignature, motionTargetHz, poseFrom, readAxisConfig, unitMetaFrom,
  type AxisConfig, type MotionView, type UnitMeta,
} from './motion.js';
import {
  IO_DROP_TRIES, IO_LEASE_MS, IO_SUBSCRIBE_CHUNK, IO_WATCH_LEASE_MAX,
  ioBudgetHz, ioEditRetryMs, ioGroup, ioLeaseGrant, ioLeaseUnion, ioNameProblem, ioPollHz, ioSignature, ioTableComplete, ioTableLoaded,
  signalNameFromResource, watchedSignalFor,
  type IoLease, type IoLoad, type IoView, type WatchedSignal,
} from './io.js';
import { ANONYMOUS_LEASE, leaseIdField, leaseKeyFor, leaseLimitReached } from './lease.js';
import { ReadBudget } from './readBudget.js';
import type { ClientTapSink, TapHost } from './recording/contract.js';
import { ClientTap } from './recording/tap.js';
import {
  ACCESS_READ_MS, ACCESS_READ_SLOW_MS, CLOCK_REFRESH_MS, RAPID_VALUE_MAX, RAPID_VALUE_RESOURCE, READ_CACHE_MS,
  type AccessGeneration, type ControllerSnapshot, type EventsPage, type Generation, type GroupError, type IoWatch, type LinkGroup,
  type LinkQuality, type MotionJoint, type MotionPose,
  type MotionUnitInfo, type MotionWatch, type RapidGroup, type RapidModuleSource, type RapidPointer, type RapidSymbolValue,
} from './schema/v0.js';

/** The minimum a log sink must accept. Fastify's logger satisfies it. */
export interface Log {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** What `summarize` needs from a manager - a plain object in tests. */
export interface ManagerView {
  state: RobotState;
  currentPort: number | undefined;
  currentUseHttps: boolean | undefined;
  /** The subscription group the manager owns now, where the client reports one. */
  subscriptionGroupPath?: string;
}

/**
 * The generation the client is actually speaking. The client exposes no
 * explicit getter; `currentUseHttps` is true exactly when it runs its RWS 2.0
 * adapter, and undefined while disconnected.
 */
function generationOf(view: ManagerView): Generation | null {
  if (view.currentUseHttps === undefined) { return null; }
  return view.currentUseHttps ? 'rws2' : 'rws1';
}

/** System ids are GUIDs; compare them without braces or case. */
const normaliseId = (id: string) => id.trim().replace(/^\{|\}$/g, '').toLowerCase();

/** True when two system ids name the same controller. */
export const sameSystemId = (a: string, b: string): boolean => normaliseId(a) === normaliseId(b);

/** Whether the controller behind a link is the one that was added. */
export function identityCheck(cfg: ControllerConfig, view: ManagerView | null): LinkGroup['identityCheck'] {
  const expected = cfg.systemId ?? null;
  const actual = view?.state.systemInfo?.sysid || null;
  const status = !expected || !actual ? 'unverified'
    : normaliseId(expected) === normaliseId(actual) ? 'confirmed' : 'mismatch';
  return { status, expected, actual };
}

/** Delay before reconnect attempt n+1 after n failures: 5, 10, 20, 40, then 60 s. */
export function reconnectDelayMs(failures: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * The times behind a snapshot's freshness fields, recorded by the fleet as
 * events arrive (ms since epoch).
 */
export interface Timing {
  /** When identity or system info was last actually re-read (the client replaces the object). */
  identityAt: number | null;
  /** When the current link quality began. */
  since: number;
  /** Last moment the link was `live` or `polling`; null if never. */
  healthyAt: number | null;
  /** When the fleet first observed the controller: the start of the outage of one never reached. */
  watchedSince?: number;
}

const isHealthy = (q: LinkQuality | undefined) => q === 'live' || q === 'polling';
/** Qualities a session has only after the controller answered on it (`stale`: it did, and has gone quiet). */
const ANSWERED_QUALITIES: ReadonlySet<LinkQuality | undefined> = new Set(['live', 'polling', 'stale']);
const iso = (ms: number) => new Date(ms).toISOString();

/** The program and motion pointer of each task, as the fleet last read them. */
export type TaskPointers = Record<string, { pp: RapidPointer | null; mp: RapidPointer | null }>;

const execOf = (v: string | null | undefined): 'running' | 'stopped' | null =>
  v === 'running' || v === 'stopped' ? v : null;

/**
 * The RAPID group from the client's state and the fleet's pointer
 * reads. A link found on the WRONG controller carries none of it (same rule
 * as the panel group): `trusted` false gives an empty group.
 */
export function rapidGroup(state: RobotState | null, pointers: TaskPointers | null, trusted: boolean, asOf: string | null): RapidGroup {
  if (!state || !trusted) { return { execState: null, cycle: null, tasks: [], asOf: trusted ? asOf : null }; }
  return {
    execState: execOf(state.execstate),
    cycle: state.execCycle ?? null,
    tasks: (state.tasks ?? []).map(t => ({
      name: t.name,
      type: t.type,
      taskState: t.taskstate || null,
      execState: execOf(t.excstate),
      active: t.active,
      motion: t.motiontask,
      modules: [...(state.modulesByTask?.[t.name] ?? [])],
      pp: pointers?.[t.name]?.pp ?? null,
      mp: pointers?.[t.name]?.mp ?? null,
    })),
    asOf,
  };
}

/** A pointer as the client returns it (`{module, routine, row, col}`, any of them missing) -> RapidPointer, or null when there is none. */
export function pointerFrom(raw: { module?: string; routine?: string; row?: number } | null | undefined): RapidPointer | null {
  if (!raw?.module) { return null; }
  return { module: raw.module, routine: raw.routine || null, line: typeof raw.row === 'number' && raw.row > 0 ? raw.row : null };
}

/**
 * Is RAPID running? The controller-level execution state is pushed by the
 * controller the moment it changes; the per-task state rides the client's
 * slow poll and lags by up to its 5 s interval. Live 2026-09-25 (RW7 VC): with
 * the per-task state alone, a running program's pointer was read every 5.2 s
 * instead of every second.
 */
export function executionRunning(state: Pick<RobotState, 'execstate' | 'tasks'>): boolean {
  return state.execstate === 'running' || (state.tasks ?? []).some(t => t.active && t.excstate === 'running');
}

/** How long until a controller's pointers are read again: 1 s while a task runs, 5 s otherwise. */
export function pointerDelayMs(running: boolean): number {
  return running ? 1_000 : 5_000;
}

/** A module's kind from the controller's type string (SysMod / ProgMod on both generations). */
export function moduleKind(type: string | null | undefined): 'program' | 'system' | null {
  if (!type) { return null; }
  if (/sys/i.test(type)) { return 'system'; }
  if (/prog/i.test(type)) { return 'program'; }
  return null;
}

/**
 * One controller's snapshot, from its config, its manager's view and the
 * fleet's timing. `access`: what the access reader keeps (null: nothing read).
 * `facts`: what the client offers; taken from `view` when left out.
 */
export function summarize(
  cfg: ControllerConfig,
  view: ManagerView | null,
  retry: { failures: number; next: number } | null = null,
  timing: Timing | null = null,
  now: number = Date.now(),
  pointers: TaskPointers | null = null,
  motion: MotionView | null = null,
  io: IoView | null = null,
  events: EventsView | null = null,
  access: AccessView | null = null,
  facts: ClientFacts | null = null,
): ControllerSnapshot {
  const state = view?.state ?? null;
  const generation = view ? generationOf(view) : null;
  const check = identityCheck(cfg, view);
  const identity = state ? toIdentity(state.identity, state.systemInfo, generation) : null;
  // Healthy as every group means it: a session, and a quality that reads.
  const healthy = !!state?.connected && isHealthy(state.quality);
  // A link on the WRONG controller carries none of its data: showing another
  // robot's status under this id would be worse than showing nothing.
  const trusted = check.status !== 'mismatch';
  const panelAt = healthy ? now : timing?.healthyAt ?? null;
  const client = facts ?? (view ? clientFacts(view) : null);
  const linkNow = { quality: state?.quality, connected: state?.connected ?? false };
  // Every group but the last two; those are worked out from these.
  const groups = {
    identity: identity && trusted ? { ...identity, asOf: iso(timing?.identityAt ?? now) } : null,
    link: {
      // The client holds a session from the moment it starts to make one;
      // `connected` waits for the controller's first answer on it.
      connected: !!state?.connected && ANSWERED_QUALITIES.has(state.quality),
      quality: state?.quality ?? 'disconnected',
      since: iso(timing?.since ?? now),
      // The start of the outage: the last healthy moment, or, for a controller never reached, when the fleet began to watch it.
      downSince: healthy ? null : iso(timing?.healthyAt ?? timing?.watchedSince ?? now),
      qualityReason: check.status === 'mismatch'
        ? `connected to a DIFFERENT controller (system id ${check.actual}, expected ${check.expected})`
        : state?.qualityReason ?? 'not connected',
      host: cfg.host,
      // Prefer the live values: a RobotStudio VC re-binds RWS to a new port on
      // restart and the client follows it, so the configured port goes stale.
      port: view?.currentPort ?? cfg.port,
      useHttps: view?.currentUseHttps ?? cfg.useHttps,
      subscriptions: { active: state?.quality === 'live' },
      identityCheck: check,
      reconnect: retry && !(state?.connected)
        ? { failures: retry.failures, nextAttemptAt: iso(retry.next) }
        : null,
      mode: 'live' as const,
      recordedAt: null,
    },
    panel: {
      ctrlState: trusted ? state?.ctrlstate ?? null : null,
      opMode: trusted ? state?.opmode ?? null : null,
      speedRatio: trusted ? state?.speedRatio ?? null : null,
      collisionDetection: trusted ? state?.coldetstate ?? null : null,
      asOf: trusted && panelAt !== null ? iso(panelAt) : null,
    },
    rapid: rapidGroup(state, pointers, trusted, panelAt !== null ? iso(panelAt) : null),
    motion: motionGroup(motion, linkNow, trusted, now),
    io: ioGroup(io, linkNow, trusted, now),
    events: eventsGroup(events, { quality: state?.quality, ready: healthy && !!state?.connected && eventsTrusted(check) }, trusted, now),
    access: accessGroup(access, linkNow, (state as { access?: unknown } | null)?.access, client?.writeAccessStatus ?? false, trusted),
  } satisfies Partial<ControllerSnapshot>;
  return {
    id: cfg.id,
    name: cfg.name,
    ...groups,
    capabilities: capabilitiesGroup(groups, generation, client),
    freshness: freshnessGroup(groups),
  };
}

/**
 * Whether what a link reads may go into a controller's event history: the
 * controller on it is confirmed by its system id, or there is no id to check
 * it against yet (the first read records it). Recorded events outlive the
 * link, so unlike the other groups - which show a link's values only while it
 * lasts - an unverified link to a controller whose id is known is not read
 * until the id is.
 */
export function eventsTrusted(check: LinkGroup['identityCheck']): boolean {
  return check.status === 'confirmed' || (check.status === 'unverified' && check.expected === null);
}

/** Whether a link can feed a controller's event log now: connected, healthy, and trusted for it (eventsTrusted). */
export function eventsLinkReady(cfg: ControllerConfig, view: ManagerView | null): boolean {
  return !!view?.state.connected && isHealthy(view.state.quality) && eventsTrusted(identityCheck(cfg, view));
}

/**
 * How a link delivers new event-log messages: its connection (link epoch),
 * whether the subscription is live, the subscription group it is on (RWS 2.0
 * makes a new one when its stream reconnects) and the reason the link gives
 * for its quality (it changes when a stream is lost or comes back). A change
 * in any of them may have let messages pass unannounced.
 */
export function eventsPeriod(epoch: number, manager: { state: RobotState; subscriptionGroupPath?: string }): string {
  const via = manager.state.quality === 'live' ? 'subscription' : 'poll';
  return `${epoch}|${via}|${manager.subscriptionGroupPath ?? ''}|${manager.state.qualityReason ?? ''}`;
}

/** Why a controller's event times cannot be corrected when the client has no clock read (defined with the capability table, which names it too). */
export { NO_CLOCK_READER };

/**
 * Refuse to run on a client whose port recovery does not check identity.
 * Older clients adopt the first controller of the same protocol when a saved
 * port stops answering - on a host with several controllers, a different
 * robot. They would also silently ignore the expected system id this fleet
 * passes, so a quiet fallback is not safe: fail loudly instead.
 */
export function assertIdentityCheckedRecovery(proto: object = RobotManager.prototype): void {
  if (typeof (proto as { setExpectedSystemId?: unknown }).setExpectedSystemId !== 'function') {
    throw new Error('abb-rws-client is too old: port recovery does not verify controller identity. '
      + 'Upgrade abb-rws-client to a release with RobotManager.setExpectedSystemId().');
  }
}

/** The part of the fleet the HTTP routes depend on - kept narrow so tests inject a fake. */
export interface FleetLike {
  has(id: string): boolean;
  all(): ControllerConfig[];
  list(): ControllerSnapshot[];
  get(id: string): ControllerSnapshot | null;
  add(cfg: ControllerConfig): void;
  remove(id: string): Promise<void>;
  /**
   * A module's RAPID source, on the controller's read budget (ReadBudget); null when there is no controller with that
   * id. Throws RwsError from the controller, ReadLimitError when the budget has no room for the read.
   */
  moduleSource(id: string, task: string, module: string): Promise<RapidModuleSource | null>;
  /**
   * A RAPID data symbol's current value, on the controller's read budget; null when there is no controller with that
   * id, 'no-value' when the controller answered with no value text. Throws RwsError from the controller,
   * ReadLimitError when the budget has no room for the read.
   */
  rapidSymbol(id: string, task: string, module: string, symbol: string): Promise<RapidSymbolValue | null | 'no-value'>;
  /**
   * Start or renew a motion watch lease: the anonymous one without `leaseId`, else the caller's own (NEW_LEASE opens
   * one). Null when there is no controller with that id; 'lease-limit' when the lease would be one more than the
   * controller may hold.
   */
  watchMotion(id: string, leaseId?: string): MotionWatch | null | 'lease-limit';
  /**
   * Start or renew an I/O watch lease over the named signals (replaces that lease's set; the daemon watches the union
   * of every lease's). Leases as for watchMotion. Null when there is no controller with that id; 'lease-limit' when the
   * lease would be one more than the controller may hold.
   */
  watchIo(id: string, signals: string[], leaseId?: string): IoWatch | null | 'lease-limit';
  /**
   * The controller's signal table: server-side search when criteria are given (on the controller's read budget), the
   * manager's cached table otherwise. Null when there is no controller with that id; 'not-loaded' when the cached table
   * has not been read on the current connection yet (an empty table then is not an answer). Throws RwsError from the
   * controller, ReadLimitError when the budget has no room for the search.
   */
  searchIoSignals(id: string, criteria: { name?: string; device?: string; network?: string; category?: string; type?: string }): Promise<Signal[] | null | 'not-loaded'>;
  /**
   * A page of the controller's event log, from memory (EventFeed.page): without `since` the newest `limit` events,
   * with it those after that seq, oldest first. Null when there is no controller with that id.
   */
  events(id: string, since: number | undefined, limit: number): EventsPage | null;
}

/** One unit as the sampler last read it. */
interface UnitSample {
  joints: MotionJoint[];
  pose: MotionPose | null;
  jointError: MotionUnitInfo['error'];
  poseError: MotionUnitInfo['error'];
}

/** A unit description read once per connection; `meta` null: the read failed, retried at `retryAt`. */
interface UnitInfoEntry {
  meta: UnitMeta | null;
  error: MotionUnitInfo['error'];
  retryAt: number;
}

/**
 * A unit's axis configuration (which logical axes it has, their units and
 * limits - read from the motion configuration), read once per connection;
 * `axes` null: not read yet or the walk failed `failures` times, retried at
 * `retryAt`.
 */
interface UnitAxesEntry {
  axes: AxisConfig[] | null;
  failures: number;
  retryAt: number;
}

/** The sampler's state for one watched controller. */
interface MotionRuntime extends MotionView {
  /** When each lease runs out (ms), by key (ANONYMOUS_LEASE for requests without an id); `leaseUntil` is the last of them. */
  leases: Map<string, number>;
  samples: number[];
  byUnit: Map<string, UnitSample>;
  /** Unit descriptions for the current connection; cleared when the link changes. */
  info: Map<string, UnitInfoEntry>;
  /** Axis configurations for the current connection; cleared with `info`. */
  axes: Map<string, UnitAxesEntry>;
  /** Joint rounds since sampling (re)started; the pose rides every POSE_EVERY_TICKS-th. */
  tick: number;
  nextAt: number;
  busy: boolean;
  /** Set by remove()/disconnectAll(): the round in flight issues no further read. */
  stopping: boolean;
  /** The round in flight (or the last one), so a teardown can wait for it. */
  inFlight: Promise<void> | null;
  /** Whether the lease was held at the sampler's last look (a lapse is announced once). */
  watchingSeen: boolean;
  /** The motion content last announced (motionSignature). */
  announced: string;
}

/** The I/O watcher's state for one watched controller. */
interface IoRuntime extends IoView {
  /**
   * Every lease on this controller's I/O, by key (ANONYMOUS_LEASE for requests
   * without an id), in the order they were opened. `signals` is their union
   * (ioLeaseUnion) and `leaseUntil` the last of their ends. A lease that has
   * run out stays here until another lease's request or the poller clears it
   * (settleIoLeases): after the last one runs out the set stays as it was.
   */
  leases: Map<string, IoLease>;
  /** Signals successfully added to the live subscription group of `subKey`. */
  subscribed: Set<string>;
  /**
   * The group the subscriptions belong to (`ioSubKey`: link epoch, the
   * manager's group path, whether its stream is live); another key means that
   * group is gone or no longer delivers.
   */
  subKey: string;
  /** A group edit - an add or a removal - is in flight; edits go one at a time per controller. */
  subBusy: boolean;
  /** Signals whose group add failed: how often in a row, and not before when it is tried again (alone). */
  editRetry: Map<string, { failures: number; retryAt: number }>;
  /**
   * Per watched signal, bumped by every event applied to it and by its bind
   * to the group. A poll read that started before a bump is older than what
   * the bump brought, so it is not written back.
   */
  eventSeq: Map<string, number>;
  /**
   * Subscribed signals owed one confirming read: just bound to the group (what
   * they showed before the add may be out of date), or announced changed by an
   * event that carried no value. Their value and asOf stay as last confirmed
   * until that read lands.
   */
  confirm: Set<string>;
  /**
   * Signals to remove from the group of `subKey`, one removal at a time: the
   * failed tries so far, and not before when the next one goes (Infinity
   * while one is out). A group that has gone took them with it.
   */
  drops: Map<string, { failures: number; retryAt: number }>;
  /** Round-robin position over the signals that need polling. */
  cursor: number;
  /** The watcher starts no request - read or edit - before this time: both are paid out of one budget (ioBudgetHz). */
  nextAt: number;
  /** A read is in flight. */
  busy: boolean;
  /** The last request slot went to an edit: the next goes to a read if one is due, so neither starves the other. */
  lastWasEdit: boolean;
  /** Set by remove()/disconnectAll(): the round in flight issues no further read. */
  stopping: boolean;
  /** The read in flight (or the last one), so a teardown can wait for it. */
  inFlight: Promise<void> | null;
  /** The group edit in flight (or the last one), likewise. */
  editInFlight: Promise<void> | null;
  /** Whether the lease was held at the poller's last look (a lapse is announced once). */
  watchingSeen: boolean;
  /** The io content last announced (ioSignature). */
  announced: string;
  /** Removes this watcher's tap on the manager's event stream. */
  untap: (() => void) | null;
}

/** A watched signal as the I/O watcher adds it to the subscription group and removes it again. */
const signalResource = (name: string): SubscriptionResource => ({ type: 'signal', name });

/**
 * The resource path a group edit names for `signalResource(name)`: the client
 * sends it as `/rw/iosystem/signals/{name};state`, and the controller lists a
 * bound signal under that path. Compared without the `;state` suffix
 * (resourcePathKey). A name listed under another spelling is not matched: it
 * is retried alone, and a re-add of a name already in the group answers 200.
 */
const signalResourcePath = (name: string): string => `/rw/iosystem/signals/${name}`;

/** A resource path without its `;param` suffix: the group's member list keeps it, a bound list need not. */
const resourcePathKey = (path: string): string => path.replace(/;[^/]*$/, '');

/**
 * The controller's code for "Invalid resource URI in Update Subscription
 * request". A group-add PUT that names an unknown signal among valid ones
 * answers 400 with it and still binds the valid ones: the 400's state div
 * lists them, and GET /subscription/{g} shows them as members (RW 7.21,
 * 8.1.1 and 8.2.1). A PUT naming only the unknown signal binds nothing.
 */
const UPDATE_SUBSCRIPTION_INVALID_URI = -1073445866;

/**
 * The resource paths a refused group add bound all the same, when the
 * client's error lists them (`bound`), else null. Read by shape, so the
 * daemon works with a client that does not list them.
 */
function boundPathsOf(e: unknown): string[] | null {
  const bound = (e as { bound?: unknown } | null | undefined)?.bound;
  return Array.isArray(bound) ? bound.filter((p): p is string => typeof p === 'string') : null;
}

/** Whether a failed group add is the controller's 400 for an unknown resource, which binds the edit's valid ones. */
function isPartialBindRefusal(e: unknown): boolean {
  const x = e as { httpStatus?: unknown; controllerCode?: unknown } | null | undefined;
  return x?.httpStatus === 400 && x.controllerCode === UPDATE_SUBSCRIPTION_INVALID_URI;
}

/** The event-log reader's state for one controller. */
interface EventsRuntime extends EventsView {
  /** The manager's listing last taken, by reference: the manager replaces the array on every read of the log. */
  taken: readonly ElogMessage[] | null;
  /**
   * How the link delivered new messages at the reader's last look
   * (eventsPeriod); '' after a look at a link it could not use. A new one
   * asks for a catch-up read.
   */
  period: string;
  /** When the reader reads the log itself next (ms). */
  nextReadAt: number;
  /** Failed reads of the log in a row. */
  failures: number;
  /** A read of the log is in flight. */
  busy: boolean;
  /** The read in flight (or the last one), so a teardown can wait for it. */
  inFlight: Promise<void> | null;
  /**
   * Measuring the controller's clock: the link epoch of the last attempt that
   * ran to its end (events on a new link wait for one), when the next is due,
   * the failures in a row, and the read in flight.
   */
  clockRead: { epoch: number | null; nextAt: number; failures: number; busy: boolean; inFlight: Promise<void> | null };
  /** Set by remove()/disconnectAll(), or when the controller is added again: nothing more is read or recorded. */
  stopping: boolean;
  /** The events content last announced (eventsSignature). */
  announced: string;
}

function newEventsRuntime(): EventsRuntime {
  return {
    feed: new EventFeed(), readAt: null, caughtUp: false, error: null,
    clock: { offsetMs: null, measuredAt: null, problem: null },
    taken: null, period: '', nextReadAt: 0, failures: 0, busy: false, inFlight: null,
    clockRead: { epoch: null, nextAt: 0, failures: 0, busy: false, inFlight: null },
    stopping: false, announced: '',
  };
}

/** The access reader's state for one controller. */
interface AccessRuntime {
  /** What the snapshot shows of the access status: the values last read, under the generation they were read under. */
  view: AccessView;
  /**
   * The run of usability the view's values were read in: the link epoch and
   * `gaps` as they stood at the reader's first look at that usable link; ''
   * before the first. A look at a usable link under another run clears the
   * view first, so nothing read before an outage is shown beside it.
   */
  run: string;
  /** Moves every time the reader finds the link not usable after it was. */
  gaps: number;
  /** The reader could use the link at its last look. */
  usable: boolean;
  /** When the next round starts (ms). */
  nextAt: number;
  /** When the last round began (ms), and the link epoch it began under: a second round on that connection waits ACCESS_READ_MS from then. */
  startedAt: number;
  startedEpoch: number | null;
  /** Rounds in a row in which every part failed. */
  failures: number;
  /** The operating mode at the reader's last look at a usable link: a change brings the next round forward. */
  opmode: string | null;
  /** The operating mode changed while a round was out: the next round is not booked a whole interval later. */
  again: boolean;
  /** A round is in flight. */
  busy: boolean;
  /** The round in flight (or the last one), so a teardown can wait for it. */
  inFlight: Promise<void> | null;
  /** Set by remove()/disconnectAll(), or when the controller is added again: nothing more is read or written back. */
  stopping: boolean;
  /** The access content last announced (accessSignature). */
  announced: string;
  /** The error code last logged per part: a failing part is logged when its code changes, not every round. */
  logged: Map<string, string>;
}

function newAccessRuntime(): AccessRuntime {
  return {
    view: unreadView(null), run: '', gaps: 0, usable: false, nextAt: 0, startedAt: 0, startedEpoch: null, failures: 0,
    opmode: null, again: false, busy: false, inFlight: null, stopping: false, announced: '', logged: new Map(),
  };
}

/** A failure as a group carries it: code and message, plus what the controller answered (groupError). */
const errorOf = (e: unknown): NonNullable<MotionUnitInfo['error']> => groupError(e);

/** Thrown inside a sampling round when it must not issue another read; the round is discarded, not reported. */
class RoundAbandoned extends Error {
  constructor() { super('sampling round abandoned'); }
}

/** How long a teardown waits for the reads in flight before it logs out anyway. */
const TEARDOWN_WAIT_MS = 3_000;

/**
 * How long disconnectAll waits at most by default, for the reads in flight
 * and the logouts together. The logouts run side by side, so the wait does
 * not grow with the number of controllers.
 *
 * The daemon's stop does not use this default: it passes what STOP_WAIT_MS
 * leaves after STOP_RESERVE_MS (6.5 s, stop.ts). Neither wait fits an RWS 1.0
 * subscription create the controller does not answer: abb-rws-client 1.5.1
 * waits 10 s for it (the session's 5 s timeout plus 5 s), and the session
 * sends one request at a time, so the logout goes out 10 s after the create
 * was sent (measured against a local server that never answers the create).
 * Fitting that case takes a longer STOP_WAIT_MS, which the schema publishes,
 * not a longer default here. Such a logout is reported `timed-out`, and the
 * controller ends the session when it times it out.
 */
export const DISCONNECT_ALL_WAIT_MS = 6_000;

/**
 * What became of one controller's session when the daemon logged out of
 * every controller (disconnectAll):
 * - `logged-out`: its link was up, and the logout ran to its end. The client
 *   sends the logout on the session and does not report the controller's
 *   answer, so this says the logout was sent and settled, not what the
 *   controller replied.
 * - `connect-cancelled`: a connect was in progress; it was cancelled, and
 *   any session it had opened was logged out.
 * - `not-connected`: there was no link, so no session to log out.
 * - `timed-out`: the logout had not finished when the wait ran out. The
 *   controller ends that session itself when it times out.
 * - `failed`: the logout failed; `error` says how.
 */
export type LogoutOutcome = 'logged-out' | 'connect-cancelled' | 'not-connected' | 'timed-out' | 'failed';

/** One controller in disconnectAll's report. */
export interface ControllerLogout {
  id: string;
  name: string;
  host: string;
  port: number;
  outcome: LogoutOutcome;
  /** Why the logout failed; only with outcome `failed`. */
  error?: string;
}

/**
 * How long a task's module listing (which module is a program, which a
 * system module) is kept for module source reads. It is also dropped at once
 * when the connection or the task's module list changes; the kind of a
 * loaded module does not change in between.
 */
export const MODULE_KINDS_CACHE_MS = 60_000;

/** A task's module listing as the manager reads it. */
type ModuleListing = Array<{ name: string; type: string }>;

/** Settle every promise given, or give up after `ms` - a read stuck in a network timeout must not hold a shutdown. */
async function settleWithin(promises: Array<Promise<unknown> | null | undefined>, ms: number): Promise<void> {
  const pending = promises.filter((p): p is Promise<unknown> => !!p);
  if (pending.length === 0) { return; }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cap = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); });
  try { await Promise.race([Promise.allSettled(pending), cap]); }
  finally { if (timer) { clearTimeout(timer); } }
}

/**
 * The daemon's single owner of controller sessions: one session per
 * controller, shared by every consumer. Read-only.
 *
 * Extracted from the panel gateway's Fleet (tag panel-v0-final), keeping the
 * three behaviours that were load-bearing there: a credential-scrubbing
 * logger, auto-reconnect after the client gives up, and following a VC's new
 * port. The third now also persists, so a daemon restart finds it.
 */
export class ControllerFleet implements FleetLike, TapHost {
  private readonly multi = new MultiRobotManager();
  private readonly configs = new Map<string, ControllerConfig>();
  private readonly changeHandlers: Array<(id: string) => void> = [];
  private readonly warnedMismatch = new Set<string>();
  /** Controllers with a connect in flight - the supervisor never starts a second. */
  private readonly connecting = new Set<string>();
  /** Consecutive failed connects per controller, and when the next may run. */
  private readonly retries = new Map<string, { failures: number; next: number }>();
  private supervisor: ReturnType<typeof setInterval> | null = null;
  private readonly dropping = new Set<string>();
  private readonly timing = new Map<string, Timing & { quality: LinkQuality; identityRef: unknown; systemRef: unknown }>();
  /** Program and motion pointers per controller, from the pointer poller. */
  private readonly pointers = new Map<string, TaskPointers>();
  /** When each controller's pointers are next read; 0 = now. */
  private readonly pointerNext = new Map<string, number>();
  private readonly pointerBusy = new Set<string>();
  /** The pointer read in flight (or the last one) per controller, so a teardown can wait for it. */
  private readonly pointerInFlight = new Map<string, Promise<void>>();
  /** Controllers being removed or shut down: no read of theirs is issued any more. */
  private readonly stopping = new Set<string>();
  /** The execution state last seen per controller: a change reads the pointers at once. */
  private readonly lastExec = new Map<string, string | null>();
  private pointerTimer: ReturnType<typeof setInterval> | null = null;
  /** Motion sampling per watched controller. */
  private readonly motion = new Map<string, MotionRuntime>();
  private motionTimer: ReturnType<typeof setInterval> | null = null;
  /** I/O watching per watched controller. */
  private readonly io = new Map<string, IoRuntime>();
  private ioTimer: ReturnType<typeof setInterval> | null = null;
  /** The event-log reader per controller; made when the controller is added. */
  private readonly eventLogs = new Map<string, EventsRuntime>();
  private eventsTimer: ReturnType<typeof setInterval> | null = null;
  /** The event reader's clock (startEventReader). */
  private eventsNow: () => number = Date.now;
  /** The access reader per controller; made on the reader's first look at it. */
  private readonly access = new Map<string, AccessRuntime>();
  private accessTimer: ReturnType<typeof setInterval> | null = null;
  /** The access reader's clock (startAccessReader). */
  private accessNow: () => number = Date.now;
  /** The connection each controller is on ("port|https"; null while disconnected) and a counter bumped when it changes. */
  private readonly linkKey = new Map<string, string | null>();
  private readonly linkEpoch = new Map<string, number>();
  /** Reads on demand (module source, signal search): in flight, answers kept, rate - per controller. */
  private readonly reads = new ReadBudget();
  /** Set by disconnectAll: the daemon is stopping, and no connect starts any more (not even for a controller added now). */
  private closed = false;
  /** Where a recording is told what crosses to the client (setTap); null while none runs. */
  private tapSink: ClientTapSink | null = null;
  /** The tapped views of the client, reporting to `tapSink` at each call (managerOf, multiCalls). */
  private readonly tap = new ClientTap(() => this.tapSink);

  constructor(
    initial: ControllerConfig[],
    private readonly log: Log,
    private readonly onConfigChange: (all: ControllerConfig[]) => void = () => {},
  ) {
    assertIdentityCheckedRecovery();
    // Client info lines include `as "<username>"`, half a credential: DEBUG only.
    setLogger({
      info: m => log.debug({ src: 'rws' }, m),
      warn: m => log.warn({ src: 'rws' }, m),
      error: (m, e) => log.error({ src: 'rws', err: e instanceof Error ? e.message : e }, m),
      show: () => { /* headless */ },
    });
    // The client makes ONE reconnect when it gives up on a controller, and none
    // if that fails - right for a UI where a person decides, wrong for a daemon
    // that holds sessions. Reconnecting is the supervisor's job alone, so the
    // client's own attempt is declined rather than left to race it.
    this.multi.onError(async () => undefined);
    this.multi.onRobotChanged(id => this.robotChanged(id));
    for (const c of initial) { this.addToManager(c); }
  }

  /** A controller's client state changed, or the controller was added or removed. */
  private robotChanged(id: string): void {
    this.tapState(id);
    this.observe(id);
    this.noteLink(id);
    // Before anything below can announce the change: a link that is usable
    // again must not go out with the access status read before its outage.
    this.followAccess(id);
    this.noteExecution(id);
    this.learnSystemId(id);
    this.dropIfWrongController(id);
    this.persistPortIfMoved(id);
    this.followEvents(id);
    for (const cb of this.changeHandlers) { cb(id); }
  }

  /**
   * Tap the client for a recording, or stop (null). While `sink` is set and
   * active it is told every client method the fleet calls - on a controller's
   * manager or on the MultiRobotManager - every client state change, and every
   * raw I/O subscription event the fleet consumes. Passive: the same requests
   * go out in the same order with or without it, and a sink that has ended
   * (`active` false) is the same as none. On install the sink is shown every
   * controller's state once, so a recording starts from all of it.
   */
  setTap(sink: ClientTapSink | null): void {
    this.tapSink = sink;
    if (!sink) { return; }
    for (const { id } of this.multi.entries) { this.tapState(id); }
  }

  /** Show the recording a controller's client state (null once the controller is gone). Never fails the fleet. */
  private tapState(id: string): void {
    const sink = this.tap.current();
    if (!sink) { return; }
    try { sink.state(id, this.clientManager(id)); } catch { /* the recording's own failure */ }
  }

  /** Show the recording a raw I/O subscription event the fleet consumed. Never fails the fleet. */
  private tapSub(id: string, event: SubscriptionEvent): void {
    const sink = this.tap.current();
    if (!sink) { return; }
    try { sink.sub(id, event); } catch { /* the recording's own failure */ }
  }

  has(id: string): boolean { return this.configs.has(id); }
  all(): ControllerConfig[] { return [...this.configs.values()]; }

  list(): ControllerSnapshot[] {
    return this.all().map(cfg => this.snapshot(cfg));
  }

  get(id: string): ControllerSnapshot | null {
    const cfg = this.configs.get(id);
    return cfg ? this.snapshot(cfg) : null;
  }

  private snapshot(cfg: ControllerConfig): ControllerSnapshot {
    const now = Date.now();
    this.observe(cfg.id, now);
    const view = this.view(cfg.id);
    return summarize(cfg, view, this.retries.get(cfg.id) ?? null, this.timing.get(cfg.id) ?? null, now,
      this.pointers.get(cfg.id) ?? null, this.motion.get(cfg.id) ?? null, this.io.get(cfg.id) ?? null,
      this.eventLogs.get(cfg.id) ?? null, this.accessShown(cfg.id), view ? clientFacts(view) : null);
  }

  /**
   * What a snapshot shows of a controller's access status: what the reader
   * keeps - except beside a link that is readable now while those values
   * were read in an earlier run of it (before an outage, or before a `stale`
   * spell): then every part is unread, as the reader's next look makes them.
   * So a snapshot taken between a link's recovery and that look never shows
   * a holder from before the outage as current.
   */
  private accessShown(id: string): AccessView | null {
    const r = this.access.get(id);
    if (!r) { return null; }
    this.noteLink(id);
    const generation = this.accessReadable(id);
    if (generation !== null && (!r.usable || this.accessRun(id, r) !== r.run)) { return unreadView(generation); }
    return r.view;
  }

  /**
   * Record the times behind the freshness fields. The client replaces its
   * identity and system-info objects each time it re-reads them, so a new
   * object means a real read, not a repeat of the last one.
   */
  private observe(id: string, now = Date.now()): void {
    const state = this.view(id)?.state;
    const quality = state?.quality ?? 'disconnected';
    let t = this.timing.get(id);
    if (!t) {
      t = { identityAt: null, since: now, healthyAt: null, watchedSince: now, quality, identityRef: null, systemRef: null };
      this.timing.set(id, t);
    }
    if (quality !== t.quality) { t.quality = quality; t.since = now; }
    if (state?.connected && isHealthy(quality)) { t.healthyAt = now; }
    const idRef = state?.identity ?? null;
    const sysRef = state?.systemInfo ?? null;
    if ((idRef && idRef !== t.identityRef) || (sysRef && sysRef !== t.systemRef)) {
      t.identityAt = now;
      t.identityRef = idRef;
      t.systemRef = sysRef;
    }
  }

  /**
   * Keep every configured controller connected: whatever is disconnected and
   * not already connecting is reconnected, backing off 5 s to 60 s per
   * controller. Covers a controller that was down when the daemon started, one
   * that stays down longer than the client's single reconnect, and one that
   * comes back on another port. The backoff also bounds how often recovery signs
   * in to candidate controllers to check their identity.
   */
  startSupervisor(tickMs = 2000, now: () => number = Date.now): void {
    if (this.supervisor) { return; }
    this.supervisor = setInterval(() => {
      for (const cfg of this.all()) {
        const id = cfg.id;
        if (this.connecting.has(id)) { continue; }
        if (this.view(id)?.state.connected) { this.retries.delete(id); continue; }
        const r = this.retries.get(id);
        if (r && now() < r.next) { continue; }
        void this.connect(id, now);
      }
    }, tickMs);
    (this.supervisor as { unref?: () => void }).unref?.();
  }

  stopSupervisor(): void {
    if (this.supervisor) { clearInterval(this.supervisor); this.supervisor = null; }
  }

  /**
   * Read the program and motion pointers of every connected, trusted
   * controller: every second while one of its tasks runs, every 5 s
   * otherwise, and at once when its execution state changes. Only active
   * tasks have pointers; the motion pointer is read only while the task runs.
   * At most two reads per active task per second - well inside a controller's
   * 20 req/s. A link on the wrong controller is never read.
   */
  startPointerPoller(tickMs = 250, now: () => number = Date.now): void {
    if (this.pointerTimer) { return; }
    this.pointerTimer = setInterval(() => {
      for (const cfg of this.all()) {
        const id = cfg.id;
        if (this.pointerBusy.has(id) || now() < (this.pointerNext.get(id) ?? 0)) { continue; }
        const view = this.view(id);
        if (!view?.state.connected || identityCheck(cfg, view).status === 'mismatch') { continue; }
        // Never an unhandled rejection: a throwing change handler would otherwise end the process.
        this.pointerInFlight.set(id, this.readPointers(id, now).catch(e => {
          this.log.error({ controller: id, err: e instanceof Error ? e.message : String(e) }, 'pointer read failed');
        }));
      }
    }, tickMs);
    (this.pointerTimer as { unref?: () => void }).unref?.();
  }

  stopPointerPoller(): void {
    if (this.pointerTimer) { clearInterval(this.pointerTimer); this.pointerTimer = null; }
  }

  private noteExecution(id: string): void {
    const exec = this.view(id)?.state.execstate ?? null;
    if (this.lastExec.has(id) && this.lastExec.get(id) !== exec) { this.pointerNext.set(id, 0); }
    this.lastExec.set(id, exec);
  }

  private async readPointers(id: string, now: () => number): Promise<void> {
    const manager = this.managerOf(id);
    const state = manager?.state;
    if (!manager || !state) { return; }
    this.pointerBusy.add(id);
    const running = executionRunning(state);
    try {
      const next: TaskPointers = {};
      // No read once a teardown has begun or the session is gone: nothing is
      // sent behind the /logout.
      const abandoned = () => this.stopping.has(id) || !manager.state.connected;
      for (const t of state.tasks.filter(x => x.active)) {
        if (abandoned()) { return; }
        const taskRunning = running || t.excstate === 'running';
        const pp = pointerFrom(await manager.getProgramPointer(t.name).catch(() => null));
        if (abandoned()) { return; }
        const mp = taskRunning ? pointerFrom(await manager.getMotionPointer(t.name).catch(() => null)) : null;
        next[t.name] = { pp, mp };
      }
      if (abandoned()) { return; }
      const before = JSON.stringify(this.pointers.get(id) ?? null);
      this.pointers.set(id, next);
      if (JSON.stringify(next) !== before) {
        for (const cb of this.changeHandlers) { cb(id); }
      }
    } finally {
      this.pointerBusy.delete(id);
      this.pointerNext.set(id, now() + pointerDelayMs(running));
    }
  }

  /**
   * A module's RAPID source and kind, on the controller's read
   * budget: the text, plus the task's module listing for the kind unless it
   * is kept from an earlier read - it is kept while the connection and the
   * task's module list stay the same (MODULE_KINDS_CACHE_MS at most), so a
   * module read after the first of its task costs one request, not two.
   * Identical requests in flight share one read, and an answer is served from
   * memory for READ_CACHE_MS; a reconnect or a module loaded or unloaded
   * starts afresh. Null for an unknown controller or one being removed.
   */
  async moduleSource(id: string, task: string, module: string): Promise<RapidModuleSource | null> {
    const manager = this.managerOf(id);
    if (!manager || !this.configs.has(id) || this.stopping.has(id)) { return null; }
    this.noteLink(id);   // a reconnect the fleet has not seen yet still starts afresh
    const scope = `${this.linkEpoch.get(id) ?? 0}|${task}|${(manager.state.modulesByTask?.[task] ?? []).join('/')}`;
    const kindsKey = `kinds|${scope}`;
    const cost = this.reads.peek(id, kindsKey) === undefined ? 2 : 1;
    const src = await this.reads.run(id, `source|${scope}|${module}`, async () => {
      const { text, changeCount } = await manager.getModuleText(task, module);
      let listing = this.reads.peek<ModuleListing>(id, kindsKey);
      // No second read once a teardown has begun: it would queue behind the /logout.
      if (!listing && !this.stopping.has(id)) {
        listing = await manager.listModulesDetailed(task).catch(() => undefined);
        if (listing) { this.reads.keep(id, kindsKey, listing, MODULE_KINDS_CACHE_MS); }
      }
      const kind = moduleKind(listing?.find(m => m.name === module)?.type);
      return { task, module, kind, text, changeCount: typeof changeCount === 'number' ? changeCount : null };
    }, { cost, cacheMs: READ_CACHE_MS });
    return { ...src };   // the kept answer is shared: never hand out the object itself
  }

  /**
   * A RAPID data symbol's current value, on the controller's read budget
   * (one request): identical requests in flight share one read, and an
   * answer is served from memory for READ_CACHE_MS; a reconnect starts
   * afresh. The value is the client's text as it came, cut at
   * RAPID_VALUE_MAX. An empty text is 'no-value', never a value: the client
   * hands one back where the controller sent no value (RW 8.2.1 for an array
   * over its read limit, RW 7.21.4 for a type with no printable value). Null
   * for an unknown controller or one being removed.
   */
  async rapidSymbol(id: string, task: string, module: string, symbol: string): Promise<RapidSymbolValue | null | 'no-value'> {
    const manager = this.managerOf(id);
    if (!manager || !this.configs.has(id) || this.stopping.has(id)) { return null; }
    this.noteLink(id);
    const read = await this.reads.run(id, `symbol|${this.linkEpoch.get(id) ?? 0}|${task}|${module}|${symbol}`, async () => {
      const value = await manager.getRapidVariable(task, module, symbol);
      const generation = generationOf(manager);
      // The answer names the resource of the generation that read it; a link gone in the meantime names none.
      if (!generation) { throw new RwsError('the link to the controller dropped during the read', 'NOT_CONNECTED'); }
      return { value, resource: RAPID_VALUE_RESOURCE[generation], readAt: new Date(Date.now()).toISOString() };
    }, { cacheMs: READ_CACHE_MS });
    if (read.value.length === 0) { return 'no-value'; }
    const truncated = read.value.length > RAPID_VALUE_MAX;
    return {
      task, module, symbol,
      value: truncated ? read.value.slice(0, RAPID_VALUE_MAX) : read.value,
      truncated, resource: read.resource, readAt: read.readAt,
    };
  }

  /**
   * The controller's signal table. With criteria, a server-side
   * search (`searchSignals`, both generations) on the controller's read
   * budget: identical searches in flight share one read, and an answer is
   * served from memory for READ_CACHE_MS. Without, the manager's cached full
   * table (refreshed on its slow poll) - no request at all for the common
   * "show me everything" case. That table is emptied on disconnect and read
   * again on the next connection's first poll; until then it is 'not-loaded'.
   * Null for an unknown controller or one being removed.
   */
  async searchIoSignals(id: string, criteria: { name?: string; device?: string; network?: string; category?: string; type?: string }): Promise<Signal[] | null | 'not-loaded'> {
    const manager = this.managerOf(id);
    if (!manager || !this.configs.has(id) || this.stopping.has(id)) { return null; }
    const some = Object.values(criteria).some(v => typeof v === 'string' && v.length > 0);
    if (!some) { return ioTableLoaded(manager.state) ? [...manager.state.ioSignals] : 'not-loaded'; }
    this.noteLink(id);
    // The criteria in a fixed order: the same search asked with its fields in another order is the same answer.
    const asked = Object.entries(criteria).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const found = await this.reads.run(id, `search|${this.linkEpoch.get(id) ?? 0}|${JSON.stringify(asked)}`,
      () => manager.searchSignals(criteria), { cacheMs: READ_CACHE_MS });
    return [...found];   // the kept answer is shared: never hand out the array itself
  }

  /**
   * A page of a controller's event log, from memory: no request
   * reaches the controller. Null for an unknown controller or one being
   * removed.
   */
  events(id: string, since: number | undefined, limit: number): EventsPage | null {
    const r = this.eventLogs.get(id);
    if (!r || !this.configs.has(id)) { return null; }
    return r.feed.page(since, limit);
  }

  /**
   * Start or renew a motion watch lease. Joint positions are not
   * subscribable on any generation (no subscription resource carries them),
   * so they are polled - but only while someone holds a lease. One sampler
   * per controller serves every consumer: it runs while any lease does. A
   * request without `leaseId` renews the one anonymous lease every such
   * request shares; with one, the caller's own (NEW_LEASE opens it, under a
   * fresh id). Each renewal extends that lease to MOTION_LEASE_MS from now.
   */
  watchMotion(id: string, leaseId?: string): MotionWatch | null | 'lease-limit' {
    if (!this.configs.has(id)) { return null; }
    let m = this.motion.get(id);
    if (!m) {
      m = {
        leaseUntil: 0, leases: new Map(), units: [], asOf: null, samples: [], sampledSince: null,
        byUnit: new Map(), info: new Map(), axes: new Map(), tick: 0, nextAt: 0, busy: false,
        stopping: false, inFlight: null, watchingSeen: false, announced: '',
      };
      this.motion.set(id, m);
    }
    const now = Date.now();
    for (const [key, until] of m.leases) { if (until <= now) { m.leases.delete(key); } }
    const key = leaseKeyFor(leaseId);
    if (leaseLimitReached(m.leases, key)) { return 'lease-limit'; }
    m.leases.set(key, now + MOTION_LEASE_MS);
    m.leaseUntil = Math.max(...m.leases.values());
    m.watchingSeen = true;
    this.announceMotion(id);   // watching may have just turned true
    return { leaseMs: MOTION_LEASE_MS, targetHz: motionTargetHz(this.view(id)?.state.quality), ...leaseIdField(key) };
  }

  /**
   * Start or renew an I/O watch lease. A request without `leaseId`
   * renews the one anonymous lease every such request shares; with one, the
   * caller's own (NEW_LEASE opens it, under a fresh id). The request REPLACES
   * that lease's set - renewing means sending the same list - and the watcher
   * serves the union of every lease's set, so consumers never overwrite each
   * other. Values arrive by subscription where the link offers one (RWS 2.0
   * with a live stream, added to the manager's own group in
   * IO_SUBSCRIBE_CHUNK-sized edits) and by polling everywhere else; polling is
   * the guarantee, the subscription the accelerator. Refused by name, with
   * the reason: a name that is not an I/O signal name, one missing from the
   * controller's signal table once that is loaded and complete, any over the
   * lease's own cap (IO_WATCH_LEASE_MAX, a lease with an id only) and any that
   * would take the union over IO_WATCH_MAX. A signal kept from a watch that
   * had lapsed - no lease was running - keeps its last value, but not as
   * current: nothing watched it meanwhile, so it waits for a confirming read.
   */
  watchIo(id: string, signals: string[], leaseId?: string): IoWatch | null | 'lease-limit' {
    if (!this.configs.has(id)) { return null; }
    // The table only counts once it is loaded on this connection (an empty
    // table before that means "not read yet", not "no signals"), and only
    // when it lists every signal (an RWS 1.0 table may be one page of more).
    const manager = this.managerOf(id);
    const state = manager?.state;
    const table = manager && state && ioTableLoaded(state) && ioTableComplete(generationOf(manager), state.ioSignals.length)
      ? new Set(state.ioSignals.map(s => s.name))
      : null;
    let r = this.io.get(id);
    if (!r) {
      r = {
        leaseUntil: 0, leases: new Map(), signals: [], subscribed: new Set(), subKey: '', subBusy: false, editRetry: new Map(), eventSeq: new Map(),
        confirm: new Set(), drops: new Map(), cursor: 0, nextAt: 0, busy: false, lastWasEdit: false, stopping: false, inFlight: null,
        editInFlight: null, watchingSeen: false, announced: '', untap: null,
      };
      this.io.set(id, r);
    }
    const now = Date.now();
    const lapsed = r.leaseUntil <= now;
    // Leases that have run out leave before this one is weighed against the caps.
    for (const [key, l] of r.leases) { if (l.until <= now) { r.leases.delete(key); } }
    const key = leaseKeyFor(leaseId);
    if (leaseLimitReached(r.leases, key)) {
      // Nothing granted, but the leases that ran out are gone: the set follows.
      this.applyIoLeases(id, r, lapsed);
      this.announceIo(id);
      return 'lease-limit';
    }
    const others = new Set<string>();
    for (const [k, l] of r.leases) {
      if (k !== key) { for (const n of l.names) { others.add(n); } }
    }
    const { accepted, rejected } = ioLeaseGrant(signals, name => ioNameProblem(name, table), others,
      key === ANONYMOUS_LEASE ? null : IO_WATCH_LEASE_MAX);
    const lease = r.leases.get(key);
    if (lease) { lease.until = now + IO_LEASE_MS; lease.names = accepted; }   // keeps its place in the union's order
    else { r.leases.set(key, { until: now + IO_LEASE_MS, names: accepted }); }
    this.applyIoLeases(id, r, lapsed);
    r.watchingSeen = true;
    this.announceIo(id);   // watching (or the set) may have just changed
    return { leaseMs: IO_LEASE_MS, accepted, rejected, ...leaseIdField(key) };
  }

  /**
   * Make the watched set the union of the leases held (`r.leases`), and
   * `leaseUntil` the last of their ends. A signal kept keeps its state - but
   * when `lapsed` (no lease was running until now) not as current. A signal
   * no lease holds any more leaves the watch and the subscription group; one
   * wanted again cancels a removal still queued.
   */
  private applyIoLeases(id: string, r: IoRuntime, lapsed: boolean): void {
    const union = ioLeaseUnion(r.leases.values());
    const keep = new Set(union);
    const old = new Map(r.signals.map(s => [s.name, s]));
    const removed = r.signals.filter(s => !keep.has(s.name)).map(s => s.name);
    r.signals = union.map(name => {
      const kept = old.get(name);
      if (!kept) { return { name, type: null, value: null, via: null, asOf: null, error: null }; }
      if (lapsed) { kept.asOf = null; kept.via = null; }
      return kept;
    });
    for (const name of removed) { r.editRetry.delete(name); r.eventSeq.delete(name); r.confirm.delete(name); }
    for (const name of union) { r.drops.delete(name); }   // wanted again: no removal to finish
    this.dropIoSubscriptions(id, r, removed);
    let until = 0;
    for (const l of r.leases.values()) { until = Math.max(until, l.until); }
    r.leaseUntil = until;
  }

  /**
   * A consumer's lease that has run out while another still runs takes its
   * signals out of the watch - only those no other lease holds. Once the last
   * lease has run out the watch as a whole has lapsed: its set stays as it
   * was, values frozen, until a lease is taken again (watchIo).
   */
  private settleIoLeases(id: string, r: IoRuntime, t: number): void {
    if (r.leaseUntil <= t) { return; }
    let ended = false;
    for (const [key, l] of r.leases) {
      if (l.until <= t) { r.leases.delete(key); ended = true; }
    }
    if (!ended) { return; }
    this.applyIoLeases(id, r, false);
    this.announceIo(id);
  }

  /**
   * Watch every leased controller's signals: keep the subscribed set in step
   * with the live group, and poll - one signal per read, round-robin - every
   * watched signal the subscription does not serve (all of them on RWS 1.0 or
   * a degraded stream, plus a subscribed signal's confirming read). Reads and
   * group edits start on one clock, paid out of one budget (ioBudgetHz) that
   * reserves the manager's own polls, a live motion watch per unit and the
   * pointer poller per running task, so the shared paced queue starves nobody.
   * A consumer's lease that runs out while another runs takes out only the
   * signals no other lease holds (settleIoLeases). When the last lease has run
   * out, polling stops, the subscribed resources are released one at a time
   * and every asOf freezes.
   */
  startIoPoller(tickMs = 50, now: () => number = Date.now): void {
    if (this.ioTimer) { return; }
    this.ioTimer = setInterval(() => {
      for (const [id, r] of this.io) {
        const cfg = this.configs.get(id);
        if (!cfg) { this.io.delete(id); continue; }
        const t = now();
        this.noteLink(id);   // also catches a link change that raised no event
        this.settleIoLeases(id, r, t);   // a consumer's lease that ran out takes its own signals along
        const view = this.view(id);
        const trusted = identityCheck(cfg, view).status !== 'mismatch';
        const watching = r.leaseUntil > t;
        const usable = trusted && !!view?.state.connected && isHealthy(view.state.quality);
        if (!watching || !usable) {
          // A lapsed lease releases the group resources; the last values stay.
          if (!watching && r.subscribed.size > 0) { this.dropIoSubscriptions(id, r, [...r.subscribed]); }
          if (watching !== r.watchingSeen) { r.watchingSeen = watching; this.announceIo(id); }
          // The removals still go out, on the budget, while the link can take them.
          if (usable) { this.stepIo(id, r, t, now, false); }
          continue;
        }
        r.watchingSeen = true;
        this.upkeepIoSubscriptions(id, r);
        this.stepIo(id, r, t, now, true);
      }
    }, tickMs);
    (this.ioTimer as { unref?: () => void }).unref?.();
  }

  stopIoPoller(): void {
    if (this.ioTimer) { clearInterval(this.ioTimer); this.ioTimer = null; }
  }

  /**
   * Which subscription group a controller's I/O subscriptions would belong to
   * now: the connection (link epoch), the manager's group path, and whether
   * its stream is live. The client deletes and re-creates its group on every
   * stream reconnect - same port, new path - and drops it after a terminal
   * stream loss (the link falls back to `polling`); either way, what was added
   * to the old group no longer delivers.
   */
  private ioSubKey(id: string, manager: RobotManager): string {
    return `${this.linkEpoch.get(id) ?? 0}|${manager.subscriptionGroupPath ?? ''}|${manager.state.quality === 'live'}`;
  }

  /**
   * Whether the manager is still on the group of `key` (an ioSubKey), live
   * stream or not. A link that is only `stale` (a failed poll) keeps its group
   * and its stream, and whatever was added to that group is still in it - so
   * what the group holds, and its removals, go by this; only an add needs the
   * stream live as well (the full key).
   */
  private sameIoGroup(id: string, manager: RobotManager, key: string): boolean {
    const cur = this.ioSubKey(id, manager);
    return cur.slice(0, cur.lastIndexOf('|')) === key.slice(0, key.lastIndexOf('|'));
  }

  /**
   * Keep the subscription side of an I/O watch in step: tap the manager's raw
   * event stream once, and forget subscriptions whose group is gone or silent
   * - every signal returns to the poll path until it is added to the current
   * group (nextIoEdit).
   */
  private upkeepIoSubscriptions(id: string, r: IoRuntime): void {
    const manager = this.managerOf(id);
    if (!manager) { return; }
    if (!r.untap && typeof manager.onSubscriptionEvent === 'function') {
      // Each event also goes to whichever recording runs when it arrives: a
      // watch begun before a recording is recorded, and one begun during it
      // keeps working after it.
      r.untap = manager.onSubscriptionEvent(e => { this.tapSub(id, e); this.onIoEvent(id, e); });
    }
    const key = this.ioSubKey(id, manager);
    if (r.subKey !== key) { this.forgetIoSubscriptions(id, r, key); }
  }

  /**
   * Start the watcher's next request if its budget has room for one now: a
   * group edit (nextIoEdit) and a read take turns while both are waiting.
   * Both start on one clock (`nextAt`), each advancing it by its own rate -
   * the budget's for an edit, ioPollHz's for a read - so the group edits are
   * paid for out of the same budget as the reads. At most one edit and one
   * read are out at a time, so a slow edit never holds the polling up.
   */
  private stepIo(id: string, r: IoRuntime, t: number, now: () => number, reading: boolean): void {
    if (t < r.nextAt) { return; }
    const manager = this.managerOf(id);
    if (!manager) { return; }
    const quality = manager.state.quality;
    const load = this.ioLoad(id, t);
    const edit = r.subBusy ? null : this.nextIoEdit(id, r, manager, t, now, reading);
    const due = reading && !r.busy
      ? r.signals.filter(s => !r.subscribed.has(s.name) || s.asOf === null || r.confirm.has(s.name))
      : [];
    // Never an unhandled rejection: a throwing change handler would end the process.
    const failed = (what: string) => (e: unknown): void => {
      this.log.error({ controller: id, err: e instanceof Error ? e.message : String(e) }, `io ${what} failed`);
    };
    // A start that comes late banks no burst: the next one just follows it.
    if (edit && (due.length === 0 || !r.lastWasEdit)) {
      r.lastWasEdit = true;
      r.nextAt = Math.max(r.nextAt + 1_000 / ioBudgetHz(quality, load), t);
      r.editInFlight = edit().catch(failed('group edit'));
    } else if (due.length > 0) {
      r.lastWasEdit = false;
      r.nextAt = Math.max(r.nextAt + 1_000 / ioPollHz(due.length, quality, load), t);
      r.inFlight = this.pollIoRound(id, r, due, now).catch(failed('poll round'));
    } else {
      r.nextAt = t;   // nothing to send; an idle stretch is not saved up either
    }
  }

  /** What else spends this controller's request budget now, as far as the fleet can see it. */
  private ioLoad(id: string, t: number): IoLoad {
    const state = this.view(id)?.state;
    const active = (state?.tasks ?? []).filter(x => x.active).length;
    return {
      // One unit is reserved while a live motion watch's unit list is still unread.
      motionUnits: this.motionWatchLive(id, t) ? Math.max(1, state?.mechunits?.length ?? 0) : 0,
      runningTasks: state && executionRunning(state) ? Math.max(1, active) : 0,
    };
  }

  /**
   * The group edit the watcher sends next, or null. A queued removal comes
   * first. Then, while the watch is served and the group is live, an add of
   * signals not in the group yet - at most IO_SUBSCRIBE_CHUNK per edit (RW
   * 7.19/7.20 regressed large subscription bodies). A signal whose add failed
   * waits out its backoff (ioEditRetryMs) and is retried in an edit of its
   * own, so one name the controller refuses cannot keep the rest of its chunk
   * out of the group. The names a refused add bound all the same are not
   * retried: they count as added (addIoSignals).
   */
  private nextIoEdit(
    id: string, r: IoRuntime, manager: RobotManager, t: number, now: () => number, adding: boolean,
  ): (() => Promise<void>) | null {
    const group = manager.subscriptionGroupPath;
    if (!group || !this.sameIoGroup(id, manager, r.subKey)) {
      r.drops.clear();   // the group they were in has gone and took them with it
      return null;
    }
    for (const [name, d] of r.drops) {
      if (d.retryAt <= t) { return () => this.releaseIoSignal(id, r, manager, group, name, now); }
    }
    if (!adding || manager.state.quality !== 'live' || this.ioSubKey(id, manager) !== r.subKey) { return null; }
    const ready = r.signals.filter(s => !r.subscribed.has(s.name) && (r.editRetry.get(s.name)?.retryAt ?? 0) <= t);
    if (ready.length === 0) { return null; }
    const names = r.editRetry.has(ready[0].name)
      ? [ready[0].name]
      : ready.filter(s => !r.editRetry.has(s.name)).slice(0, IO_SUBSCRIBE_CHUNK).map(s => s.name);
    return () => this.addIoSignals(id, r, manager, group, names, now);
  }

  /**
   * Add signals to the live group (see nextIoEdit). A failed add leaves them
   * on the poll path, backed off - all but the ones the controller bound all
   * the same (boundAfterRefusal), which count as added, as after a 200.
   */
  private async addIoSignals(
    id: string, r: IoRuntime, manager: RobotManager, group: string, names: string[], now: () => number,
  ): Promise<void> {
    const key = r.subKey;
    r.subBusy = true;
    let bound = names;
    let refusal: { err: unknown } | null = null;
    try {
      await manager.updateSubscriptionGroup(group, names.map(signalResource));
    } catch (e) {
      refusal = { err: e };
      bound = await this.boundAfterRefusal(id, r, manager, group, names, key, e);
    } finally {
      r.subBusy = false;
    }
    if (this.io.get(id) !== r) { return; }
    const refused = names.filter(n => !bound.includes(n));
    // A group that went away under the edit is not the signals' failure.
    if (refusal && refused.length > 0 && this.ioSubKey(id, manager) === key) {
      const failedAt = now();
      let failures = 0;
      for (const n of refused.filter(x => r.signals.some(s => s.name === x))) {
        failures = (r.editRetry.get(n)?.failures ?? 0) + 1;
        r.editRetry.set(n, { failures, retryAt: failedAt + ioEditRetryMs(failures) });
      }
      const err = refusal.err;
      this.log.warn({ controller: id, signals: refused, bound, failures, retryInS: ioEditRetryMs(failures) / 1000,
        err: err instanceof Error ? err.message : String(err) },
        'adding signal subscriptions failed - the signals stay on the poll path');
    }
    // The group may have been re-created or lost while the edit was out; a
    // link gone stale meanwhile still has it, and the signals are in it.
    if (bound.length === 0 || r.subKey !== key || !this.sameIoGroup(id, manager, key)) { return; }
    for (const n of bound) { r.subscribed.add(n); r.editRetry.delete(n); }
    // A signal taken out of the watch while the add was out leaves the group
    // again straight away, rather than when the lease lapses.
    this.dropIoSubscriptions(id, r, bound.filter(n => !r.signals.some(s => s.name === n)));
    // From here on the group delivers every change, but what the signal
    // showed before the add may already be out of date: one confirming read
    // (`confirm` puts it on the poll path for exactly one round), begun after
    // the bind - a read already out is not written back. Its value and asOf
    // stay as last confirmed until then.
    for (const s of r.signals) {
      if (bound.includes(s.name)) { r.confirm.add(s.name); this.bumpIoEventSeq(r, s.name); }
    }
  }

  /**
   * The names of a refused add that the controller bound all the same, by
   * resource path (signalResourcePath). A client that reads the 400's body
   * lists the bound paths on its error (`bound`). An older client does not:
   * then, for the controller's 400 for an unknown resource
   * (UPDATE_SUBSCRIPTION_INVALID_URI), one read of the group's members says,
   * while the edit's group is still the manager's - unless the edit named a
   * single signal: then that signal is the unknown one and the refusal bound
   * nothing, so a lone retry of it costs no read. Any other failure, or a
   * member list that cannot be read, counts as nothing bound: those names
   * are retried alone, and a re-add of a name already in the group answers
   * 200 with an empty body (RW 7.21.4, 8.2.1).
   */
  private async boundAfterRefusal(
    id: string, r: IoRuntime, manager: RobotManager, group: string, names: string[], key: string, e: unknown,
  ): Promise<string[]> {
    let paths = boundPathsOf(e);
    if (paths === null) {
      if (names.length < 2 || !isPartialBindRefusal(e) || typeof manager.getSubscriptionGroup !== 'function'
        || this.io.get(id) !== r || !this.sameIoGroup(id, manager, key)) { return []; }
      try {
        paths = (await manager.getSubscriptionGroup(group)).map(m => m.resource);
      } catch (err) {
        this.log.debug({ controller: id, group, err: err instanceof Error ? err.message : String(err) },
          'reading the subscription group after a refused add failed - its signals are retried alone');
        return [];
      }
    }
    const inGroup = new Set(paths.map(resourcePathKey));
    return names.filter(n => inGroup.has(signalResourcePath(n)));
  }

  /**
   * The group the subscriptions were in is gone or no longer delivers: forget
   * them under the new key, so every watched signal is polled again until it
   * is added to the current group - and stops claiming it arrives by
   * subscription meanwhile. Adds that failed on the old group start over.
   */
  private forgetIoSubscriptions(id: string, r: IoRuntime, key: string): void {
    r.subscribed.clear();
    r.confirm.clear();   // every signal is on the poll path again
    r.editRetry.clear();
    r.drops.clear();   // the old group took those resources with it
    r.subKey = key;
    let relabelled = false;
    for (const s of r.signals) {
      if (s.via === 'subscription') { s.via = 'poll'; relabelled = true; }
    }
    if (relabelled) { this.announceIo(id); }
  }

  /**
   * Take watched signals out of the live subscription group: queued, and sent
   * one removal at a time on the watcher's budget (nextIoEdit) - a lapsed
   * watch of 24 signals must not put 24 requests in front of everyone else's
   * at once. A failed removal is tried again on a backoff, at most
   * IO_DROP_TRIES times in all; the resource dies with the group at the latest.
   */
  private dropIoSubscriptions(id: string, r: IoRuntime, names: string[]): void {
    const toDrop = names.filter(n => r.subscribed.has(n));
    for (const n of toDrop) { r.subscribed.delete(n); }
    const manager = this.managerOf(id);
    // Only from the group they were added to: after a re-mint that one is gone.
    // A stale link still has it, and the removals wait for the link to heal.
    if (!manager?.subscriptionGroupPath || !this.sameIoGroup(id, manager, r.subKey)) { return; }
    for (const n of toDrop) {
      if (!r.drops.has(n)) { r.drops.set(n, { failures: 0, retryAt: 0 }); }
    }
  }

  /** Remove one signal from the group (see dropIoSubscriptions). */
  private async releaseIoSignal(
    id: string, r: IoRuntime, manager: RobotManager, group: string, name: string, now: () => number,
  ): Promise<void> {
    const key = r.subKey;
    const prior = r.drops.get(name)?.failures ?? 0;
    r.drops.set(name, { failures: prior, retryAt: Infinity });   // one try out at a time
    r.subBusy = true;
    try {
      await manager.unsubscribeResource(group, signalResource(name));
      r.drops.delete(name);
    } catch (e) {
      r.drops.delete(name);
      // No further try once the group has gone, or when the signal is watched
      // again meanwhile (its next add binds it anew).
      if (this.io.get(id) !== r || !this.sameIoGroup(id, manager, key)
        || (r.leaseUntil > now() && r.signals.some(s => s.name === name))) { return; }
      const failures = prior + 1;
      const err = e instanceof Error ? e.message : String(e);
      if (failures >= IO_DROP_TRIES) {
        this.log.warn({ controller: id, signal: name, failures, err },
          'removing a signal subscription failed; it stays in the group until the group ends');
        return;
      }
      r.drops.set(name, { failures, retryAt: now() + ioEditRetryMs(failures) });
      this.log.debug({ controller: id, signal: name, failures, err }, 'removing a signal subscription failed; will retry');
    } finally {
      r.subBusy = false;
    }
  }

  /**
   * A signal event from the manager's stream: apply it to the watched signal
   * it names - but only while a lease is held and the link is on the right
   * controller. A resource whose removal failed keeps delivering until the
   * group ends, and must not bring a lapsed watch back to life.
   */
  private onIoEvent(id: string, event: SubscriptionEvent): void {
    const name = signalNameFromResource(event.resource);
    if (!name) { return; }
    const r = this.io.get(id);
    if (!r || r.stopping || r.leaseUntil <= Date.now()) { return; }
    const cfg = this.configs.get(id);
    if (!cfg || identityCheck(cfg, this.view(id)).status === 'mismatch') { return; }
    const s = watchedSignalFor(r.signals, name);
    if (!s) { return; }
    this.bumpIoEventSeq(r, s.name);   // whatever a read already out brings back is older
    if (event.value !== '') {
      s.value = event.value;
      s.type = s.type ?? null;
      s.via = 'subscription';
      s.asOf = Date.now();
      s.error = null;
      this.announceIo(id);
    } else {
      // The event announced a change without a value (state-only payloads have
      // been reported per generation): confirm with one read - `confirm` puts
      // the signal back on the poll path for exactly one round, and the last
      // confirmed value and asOf stand until it lands.
      r.confirm.add(s.name);
    }
  }

  private bumpIoEventSeq(r: IoRuntime, name: string): void {
    r.eventSeq.set(name, (r.eventSeq.get(name) ?? 0) + 1);
  }

  /**
   * One I/O poll round: read the next of the signals polling must serve (`due`:
   * every signal the subscription does not serve, plus one confirming read
   * once a signal is bound to the group and after an event that carried no
   * value). Abandoned once its link, lease or controller is gone, like the
   * motion sampler. A read overtaken by an event for its signal is not written
   * back: the event's value is newer, and a change announced without a value
   * needs a read that began after it.
   */
  private async pollIoRound(id: string, r: IoRuntime, due: WatchedSignal[], now: () => number): Promise<void> {
    const manager = this.managerOf(id);
    if (!manager) { return; }
    r.busy = true;
    const epoch = this.linkEpoch.get(id) ?? 0;
    const abandoned = (): boolean => r.stopping || this.io.get(id) !== r || !manager.state.connected
      || (this.linkEpoch.get(id) ?? 0) !== epoch;
    try {
      if (abandoned()) { return; }
      const s = due[r.cursor % due.length];
      r.cursor++;
      const seq = r.eventSeq.get(s.name) ?? 0;
      const overtaken = (): boolean => (r.eventSeq.get(s.name) ?? 0) !== seq;
      try {
        const read = await manager.readIoSignal('', '', s.name);
        if (abandoned() || overtaken()) { return; }
        s.value = read.lvalue ?? read.value ?? null;
        s.type = read.type ?? s.type;
        s.via = r.subscribed.has(s.name) ? 'subscription' : 'poll';
        s.asOf = now();
        s.error = null;
        r.confirm.delete(s.name);
      } catch (e) {
        if (abandoned() || overtaken()) { return; }
        s.error = errorOf(e);
      }
    } finally {
      r.busy = false;
      this.announceIo(id);
    }
  }

  private motionWatchLive(id: string, t: number): boolean {
    const m = this.motion.get(id);
    return !!m && m.leaseUntil > t;
  }

  /** Tell the change handlers when a controller's io content changed (not for its timestamps alone). */
  private announceIo(id: string): void {
    const r = this.io.get(id);
    const snap = r && this.get(id);
    if (!r || !snap) { return; }
    const sig = ioSignature(snap.io);
    if (sig === r.announced) { return; }
    r.announced = sig;
    for (const cb of this.changeHandlers) { cb(id); }
  }

  /**
   * Sample joint positions (and, every POSE_EVERY_TICKS-th round, the TCP pose)
   * of every watched controller: MOTION_HZ rounds per second, MOTION_HZ_POLLING
   * while the link is `polling`, one jointtarget read per mechanical unit per
   * round. Reads go through the controller's own manager, whose request spacing
   * keeps the total under the controller's ceiling; a slow round just delays the
   * next. Never samples a link that is down, degraded, or on the wrong
   * controller. A lapsed lease stops sampling and freezes `motion.asOf`.
   */
  startMotionSampler(tickMs = 20, now: () => number = Date.now): void {
    if (this.motionTimer) { return; }
    this.motionTimer = setInterval(() => {
      for (const [id, m] of this.motion) {
        const cfg = this.configs.get(id);
        if (!cfg) { this.motion.delete(id); continue; }
        const t = now();
        this.noteLink(id);   // also catches a link change that raised no event
        const view = this.view(id);
        const trusted = identityCheck(cfg, view).status !== 'mismatch';
        if (!trusted) { m.info.clear(); m.axes.clear(); }
        const watching = m.leaseUntil > t;
        const eligible = watching && trusted && !!view?.state.connected && isHealthy(view.state.quality);
        if (!eligible) {
          const stopped = m.sampledSince !== null;
          if (stopped) { m.sampledSince = null; m.samples = []; }
          // A lapsed lease turns `watching` false, a stop clears the measured rate.
          if (stopped || watching !== m.watchingSeen) { m.watchingSeen = watching; this.announceMotion(id); }
          continue;
        }
        m.watchingSeen = true;
        if (m.sampledSince === null) { m.sampledSince = t; m.samples = []; m.tick = 0; m.nextAt = t; }
        if (m.busy || t < m.nextAt) { continue; }
        // Never an unhandled rejection: this runs 8 times a second per watched
        // controller, and a throwing change handler would end the process.
        m.inFlight = this.sampleMotion(id, m, view!.state.quality, now).catch(e => {
          this.log.error({ controller: id, err: e instanceof Error ? e.message : String(e) }, 'motion sampler round failed');
        });
      }
    }, tickMs);
    (this.motionTimer as { unref?: () => void }).unref?.();
  }

  stopMotionSampler(): void {
    if (this.motionTimer) { clearInterval(this.motionTimer); this.motionTimer = null; }
  }

  /**
   * One sampling round: every unit's joints, and its pose on every
   * POSE_EVERY_TICKS-th round. A unit's description and its axis configuration
   * (readAxisConfig's walk of the motion configuration: which logical axes it
   * has, their units and limits) are read once per connection, ahead of its
   * first joints; the walk is ~20 reads through the same paced queue, so that
   * first round is late by about a second rather than over the controller's
   * budget, and a failed walk is retried on a backoff while the joints are
   * reported without units or limits.
   *
   * The round is abandoned between reads once its link, lease or controller is
   * gone (nothing is sent behind a /logout), and discarded when the link
   * changed under it (a reconnect may have landed on another controller).
   * Both leave the last values as they were.
   */
  private async sampleMotion(id: string, m: MotionRuntime, quality: LinkQuality, now: () => number): Promise<void> {
    const manager = this.managerOf(id);
    if (!manager) { return; }
    m.busy = true;
    const start = now();
    const epoch = this.linkEpoch.get(id) ?? 0;
    const withPose = m.tick % POSE_EVERY_TICKS === 0;
    m.tick++;
    const abandoned = (): boolean => m.stopping || this.motion.get(id) !== m || !manager.state.connected
      || (this.linkEpoch.get(id) ?? 0) !== epoch;
    /** Before every read, and after a failed one: a read refused by a teardown is not the unit's failure. */
    const guard = (): void => { if (abandoned()) { throw new RoundAbandoned(); } };
    try {
      const names = [...manager.state.mechunits];
      // The unit list rides the manager's slow poll and is empty for a moment
      // after a reconnect: keep the last values rather than drop every unit.
      if (names.length === 0) { return; }
      const info = new Map<string, UnitInfoEntry>();
      const axes = new Map<string, UnitAxesEntry>();
      const reads = new Map<string, { joints?: MotionJoint[]; pose?: MotionPose; jointError?: UnitSample['jointError']; poseError?: UnitSample['poseError'] }>();
      for (const name of names) {
        // The unit's own description, once per connection (retried after a failure).
        let entry = m.info.get(name);
        if (!entry || (entry.meta === null && start >= entry.retryAt)) {
          guard();
          try {
            entry = { meta: unitMetaFrom(await manager.getMechunitDetails(name)), error: null, retryAt: 0 };
          } catch (e) {
            guard();
            entry = { meta: null, error: errorOf(e), retryAt: now() + UNIT_INFO_RETRY_MS };
          }
        }
        info.set(name, entry);
        // Its axis configuration, once per connection (retried on a backoff).
        let ax = m.axes.get(name);
        if (!ax || (ax.axes === null && start >= ax.retryAt)) {
          try {
            const list = await readAxisConfig(name, (type, instance) => {
              guard();
              return manager.getCfgInstance('MOC', type, instance) as Promise<Record<string, string>>;
            });
            ax = { axes: list, failures: 0, retryAt: 0 };
            this.log.info({ controller: id, unit: name, axes: list.map(a => `${a.logicalAxis}:${a.unit ?? '?'}`) },
              'axis configuration read');
          } catch (e) {
            if (e instanceof RoundAbandoned) { throw e; }
            guard();
            const failures = (ax?.failures ?? 0) + 1;
            const retryMs = axisConfigRetryMs(failures);
            ax = { axes: null, failures, retryAt: now() + retryMs };
            this.log.warn({ controller: id, unit: name, failures, retryInS: retryMs / 1000, err: errorOf(e).message },
              'axis configuration not read: joints reported without units or limits');
          }
        }
        axes.set(name, ax);
        const r: NonNullable<ReturnType<typeof reads.get>> = {};
        guard();
        try {
          r.joints = motionJoints(await manager.getJointTargetFull(name), entry.meta, ax.axes);
          r.jointError = null;
        } catch (e) { guard(); r.jointError = errorOf(e); }
        if (withPose && entry.meta?.kind === 'robot') {
          guard();
          try {
            r.pose = poseFrom(await manager.getCartesianFull(name));
            r.poseError = null;
          } catch (e) { guard(); r.poseError = errorOf(e); }
        }
        reads.set(name, r);
      }
      // Discard the round if the link changed under it (a reconnect may have
      // landed on another controller), or the controller went away.
      const cfg = this.configs.get(id);
      if (abandoned() || !cfg || identityCheck(cfg, this.view(id)).status === 'mismatch') { return; }
      let anyJoints = false;
      for (const [name, r] of reads) {
        const prev = m.byUnit.get(name) ?? { joints: [], pose: null, jointError: null, poseError: null };
        if (r.joints) { anyJoints = true; }
        if (r.poseError && r.poseError.code !== prev.poseError?.code) {
          // Not the unit's `error` (the joints are current): logged, and the last pose is kept.
          this.log.warn({ controller: id, unit: name, ...r.poseError }, 'pose read failed; keeping the last pose');
        }
        m.byUnit.set(name, {
          joints: r.joints ?? prev.joints,
          pose: r.pose ?? prev.pose,
          jointError: r.jointError !== undefined ? r.jointError : prev.jointError,
          poseError: r.poseError !== undefined ? r.poseError : prev.poseError,
        });
      }
      for (const name of [...m.byUnit.keys()]) { if (!reads.has(name)) { m.byUnit.delete(name); } }
      for (const [name, entry] of info) { m.info.set(name, entry); }
      for (const [name, entry] of axes) { m.axes.set(name, entry); }
      m.units = names.map(name => {
        const s = m.byUnit.get(name)!;
        const e = info.get(name)!;
        return {
          name,
          kind: e.meta?.kind ?? null,
          typeRaw: e.meta?.typeRaw ?? null,
          task: e.meta?.task ?? null,
          joints: s.joints,
          pose: e.meta?.kind === 'robot' ? s.pose : null,
          // The joints' own failure - or, while no joint is reported at all, the
          // description's. Never the pose's: successfully read joints stay shown.
          error: s.jointError ?? (s.joints.length === 0 ? e.error : null),
        };
      });
      const done = now();
      if (anyJoints) { m.asOf = done; m.samples.push(done); }
      while (m.samples.length > 0 && m.samples[0] <= done - RATE_WINDOW_MS) { m.samples.shift(); }
    } catch (e) {
      if (!(e instanceof RoundAbandoned)) { throw e; }
    } finally {
      m.busy = false;
      // Keep the cadence against the tick's granularity; a round that started a
      // whole period late does not bank a burst - the next one just follows it.
      m.nextAt = Math.max(m.nextAt + 1_000 / motionTargetHz(quality), start);
      // Also after an early return: a stalled round still lets the measured rate decay.
      this.announceMotion(id);
    }
  }

  /** Tell the change handlers when a controller's motion content changed (not for its asOf alone). */
  private announceMotion(id: string): void {
    const m = this.motion.get(id);
    const snap = m && this.get(id);
    if (!m || !snap) { return; }
    const sig = motionSignature(snap.motion);
    if (sig === m.announced) { return; }
    m.announced = sig;
    for (const cb of this.changeHandlers) { cb(id); }
  }

  /**
   * Follow every controller's event log. On each new connection,
   * and each time the link's event stream changes (it came back, was made
   * anew, or gave way to polling: eventsPeriod), the controller's clock is
   * measured first, then the log is read once to catch up on what came
   * meanwhile. After that, while the subscription delivers, the manager's own
   * reads of the log - one per message the controller announces - are taken
   * as they come, and the reader reads it again only when none has come for
   * EVENTS_RECHECK_MS; while no subscription delivers, the reader reads it
   * every EVENTS_POLL_MS, further apart for a long RWS 2.0 log (one request
   * per page), which keeps it near a request a second at most. The clock is
   * measured again every CLOCK_REFRESH_MS. Nothing is read from a link that
   * is down, degraded, or not confirmed to be the controller that was added
   * (eventsLinkReady).
   */
  startEventReader(tickMs = 250, now: () => number = Date.now): void {
    if (this.eventsTimer) { return; }
    this.eventsNow = now;
    this.eventsTimer = setInterval(() => {
      for (const [id, r] of this.eventLogs) {
        if (!this.configs.has(id)) { this.eventLogs.delete(id); continue; }
        this.stepEvents(id, r, now, true);
      }
    }, tickMs);
    (this.eventsTimer as { unref?: () => void }).unref?.();
  }

  stopEventReader(): void {
    if (this.eventsTimer) { clearInterval(this.eventsTimer); this.eventsTimer = null; }
  }

  /** A listing the manager just read is taken at once, not on the reader's next tick (no request is started here). */
  private followEvents(id: string): void {
    const r = this.eventLogs.get(id);
    if (this.eventsTimer && r) { this.stepEvents(id, r, this.eventsNow, false); }
  }

  /**
   * One look at a controller's event log (startEventReader). `mayRead`: it may
   * start a request - the clock's or the log's - which only the reader's own
   * tick does.
   */
  private stepEvents(id: string, r: EventsRuntime, now: () => number, mayRead: boolean): void {
    const cfg = this.configs.get(id);
    const manager = this.managerOf(id);
    if (r.stopping || !cfg || !manager) { return; }
    this.noteLink(id);
    const t = now();
    if (!eventsLinkReady(cfg, manager)) {
      // Nothing is read from this link; the next one the reader can use starts afresh.
      r.caughtUp = false;
      if (r.period !== '') { r.period = ''; this.announceEvents(id); }
      return;
    }
    const epoch = this.linkEpoch.get(id) ?? 0;
    const period = eventsPeriod(epoch, manager);
    if (period !== r.period) {
      r.period = period;
      r.caughtUp = false;
      r.nextReadAt = t;   // catch up on what came while nothing announced it
      this.announceEvents(id);
    }
    // Never an unhandled rejection: a throwing change handler would end the process.
    const failed = (what: string) => (e: unknown): void => {
      this.log.error({ controller: id, err: e instanceof Error ? e.message : String(e) }, `${what} failed`);
    };
    const clockable = typeof manager.getControllerClock === 'function';
    if (!clockable) {
      if (r.clock.problem !== NO_CLOCK_READER) { r.clock = { ...r.clock, problem: NO_CLOCK_READER }; this.announceEvents(id); }
    } else if (mayRead && !r.clockRead.busy && (r.clockRead.epoch !== epoch || t >= r.clockRead.nextAt)) {
      r.clockRead.inFlight = this.readControllerClock(id, r, manager, epoch, now).catch(failed('controller clock read'));
    }
    // On a new connection events wait for the clock's first reading, so their
    // times are corrected from the start (or say why not).
    if (clockable && r.clockRead.epoch !== epoch) { return; }
    this.takeManagerEvents(id, r, manager, t);
    if (mayRead && !r.busy && t >= r.nextReadAt) {
      r.inFlight = this.readEventLog(id, r, manager, epoch, now).catch(failed('event log read'));
    }
  }

  /**
   * Take the manager's own latest read of the log, once. The manager reads it
   * again on every message the controller announces and on its slow poll, and
   * empties it on disconnect: an empty one is "not read yet", or a read that
   * failed, and is left alone.
   */
  private takeManagerEvents(id: string, r: EventsRuntime, manager: RobotManager, t: number): void {
    const list = manager.state.eventLog;
    if (!Array.isArray(list) || list === r.taken) { return; }
    r.taken = list;
    if (list.length === 0) { return; }
    this.recordEvents(id, r, manager, list, false, t);
    // As good as a read of the reader's own - but not as the catch-up, which
    // must have begun after the stream changed: the next read waits its turn.
    const via = manager.state.quality === 'live' ? 'subscription' : 'poll';
    if (r.caughtUp || via === 'poll') {
      r.nextReadAt = Math.max(r.nextReadAt, t + eventsReadIntervalMs(via, eventsReadRequests(generationOf(manager), list.length)));
    }
  }

  /** Record a listing of the log (EventFeed.take); `complete`: the reader's own answer, where empty means an empty log. */
  private recordEvents(id: string, r: EventsRuntime, manager: RobotManager, list: readonly ElogMessage[], complete: boolean, t: number): void {
    const added = r.feed.take(list, { generation: generationOf(manager), offsetMs: r.clock.offsetMs, at: t, complete });
    r.readAt = t;
    r.error = null;
    if (added > 0) { this.log.debug({ controller: id, added, lastSeq: r.feed.lastSeq }, 'event log messages recorded'); }
    this.announceEvents(id);
  }

  /**
   * The reader's own read of the log: the catch-up after the event stream
   * changed, a poll while no subscription delivers, or the recheck. A read
   * whose link changed, or stopped being trusted, under it records nothing; a
   * failed one is tried again on a backoff (eventsRetryMs), and the group
   * carries the error meanwhile.
   */
  private async readEventLog(id: string, r: EventsRuntime, manager: RobotManager, epoch: number, now: () => number): Promise<void> {
    r.busy = true;
    const period = r.period;
    const abandoned = (): boolean => this.eventsReadAbandoned(id, r, manager, epoch);
    try {
      let list: ElogMessage[];
      try {
        list = await manager.getEventLog(0, 'en');
      } catch (e) {
        if (abandoned()) { return; }
        r.failures++;
        r.error = groupError(e);
        const retryMs = eventsRetryMs(r.failures);
        r.nextReadAt = now() + retryMs;
        this.log.warn({ controller: id, failures: r.failures, retryInS: retryMs / 1000, err: r.error.message }, 'event log read failed');
        return;
      }
      const cfg = this.configs.get(id);
      if (abandoned() || !cfg || !eventsLinkReady(cfg, manager)) { return; }
      const t = now();
      r.failures = 0;
      this.recordEvents(id, r, manager, list, true, t);
      // A read begun before the event stream changed is no catch-up for the
      // new one: that read stays due.
      if (r.period === period) {
        r.caughtUp = true;
        const via = manager.state.quality === 'live' ? 'subscription' : 'poll';
        r.nextReadAt = t + eventsReadIntervalMs(via, eventsReadRequests(generationOf(manager), list.length));
      }
    } finally {
      r.busy = false;
      this.announceEvents(id);
    }
  }

  /**
   * Measure the controller clock's offset against the daemon's UTC time
   * (clockOffsetMs). Once measured, events recorded before it are corrected
   * with it. A failed read keeps the offset measured before, if any, says why
   * in `clock.problem`, and is tried again on a backoff.
   */
  private async readControllerClock(id: string, r: EventsRuntime, manager: RobotManager, epoch: number, now: () => number): Promise<void> {
    r.clockRead.busy = true;
    const abandoned = (): boolean => this.eventsReadAbandoned(id, r, manager, epoch);
    const clockFailed = (problem: string, at: number): void => {
      r.clockRead.failures++;
      r.clockRead.epoch = epoch;
      const retryMs = eventsRetryMs(r.clockRead.failures);
      r.clockRead.nextAt = at + retryMs;
      r.clock = { ...r.clock, problem };
      this.log.warn({ controller: id, failures: r.clockRead.failures, retryInS: retryMs / 1000, problem },
        r.clock.offsetMs === null ? 'controller clock not measured: event times are not corrected' : 'controller clock not measured again');
    };
    try {
      const sentAt = now();
      let reading: string;
      try {
        reading = await manager.getControllerClock();
      } catch (e) {
        if (!abandoned()) { clockFailed(`the controller clock could not be read: ${groupError(e).message}`, now()); }
        return;
      }
      const answeredAt = now();
      const cfg = this.configs.get(id);
      if (abandoned() || !cfg || !eventsLinkReady(cfg, manager)) { return; }
      const offsetMs = clockOffsetMs(reading, sentAt, answeredAt);
      if (offsetMs === null) {
        clockFailed(`the controller clock read "${eventText(reading, 40) ?? ''}", which is no date and time`, answeredAt);
        return;
      }
      r.clock = { offsetMs, measuredAt: answeredAt, problem: null };
      r.clockRead.epoch = epoch;
      r.clockRead.failures = 0;
      r.clockRead.nextAt = answeredAt + CLOCK_REFRESH_MS;
      const corrected = r.feed.correct(offsetMs);
      this.log.debug({ controller: id, offsetMs, corrected }, 'controller clock measured');
    } finally {
      r.clockRead.busy = false;
      this.announceEvents(id);
    }
  }

  /**
   * Whether an event-reader read that began on link `epoch` must be dropped:
   * the controller is being removed (or was added again), or its link went
   * down or moved to another connection meanwhile - which is looked at here
   * and now, not left to the reader's next tick.
   */
  private eventsReadAbandoned(id: string, r: EventsRuntime, manager: RobotManager, epoch: number): boolean {
    if (r.stopping || this.eventLogs.get(id) !== r) { return true; }
    this.noteLink(id);
    return !manager.state.connected || (this.linkEpoch.get(id) ?? 0) !== epoch;
  }

  /** Tell the change handlers when a controller's events content changed (not for its asOf moving on). */
  private announceEvents(id: string): void {
    const r = this.eventLogs.get(id);
    const snap = r && this.get(id);
    if (!r || !snap) { return; }
    const sig = eventsSignature(snap.events);
    if (sig === r.announced) { return; }
    r.announced = sig;
    for (const cb of this.changeHandlers) { cb(id); }
  }

  /**
   * Read every controller's access status: who holds each lock of
   * its generation - mastership on RobotWare 6 and 7, control-station write
   * access on RobotWare 8 - and, on RobotWare 6 and 7, the RMMP privilege of
   * the daemon's own session. Reporting only: every request is a status read,
   * and the reader never requests, releases or changes any of it.
   *
   * A round reads the parts one after another, never two requests at a time:
   * RobotWare 6 cfg, motion, rapid, RMMP; RobotWare 7 edit, motion, RMMP (RMMP
   * is left out once the controller answered that it does not offer it);
   * RobotWare 8 the write-access status. The next round starts ACCESS_READ_MS
   * after the last one ended (ACCESS_READ_SLOW_MS while the link is
   * `polling`), on a backoff (accessRetryMs) after a round in which every
   * part failed, and sooner when the operating mode changes (a mode change
   * ends mastership on RobotWare 6 and 7) or the link becomes readable again.
   * Whatever brings a round forward, on one connection it begins no sooner
   * than ACCESS_READ_MS after the round before it began; only the first
   * round of a new connection is not held back. So a link that keeps
   * recovering, or a mode that keeps changing, is read no more often than a
   * steady one: at most 0.8 requests a second.
   *
   * Nothing is read from a link that is down, degraded or on the wrong
   * controller, before the client knows the access generation, or on
   * RobotWare 8 with a client that has no read for the status
   * (accessReadable). While a link cannot be read, what was read stays, with
   * its times. The moment the reader finds it readable again - a new
   * connection, or the same one recovered - it first clears every part to
   * unread and announces that, then reads (at once on a new connection):
   * mastership does not outlive its holder's session and write access can
   * change hands while the daemon is away, so a holder from before an outage
   * is never shown beside a usable link.
   *
   * Until the reader is started nothing is read: a healthy link then shows
   * `via: poll` with every part unread.
   */
  startAccessReader(tickMs = 500, now: () => number = Date.now): void {
    if (this.accessTimer) { return; }
    this.accessNow = now;
    this.accessTimer = setInterval(() => {
      for (const id of [...this.access.keys()]) {
        if (!this.configs.has(id)) { this.access.delete(id); }
      }
      for (const cfg of this.all()) { this.lookAccess(cfg.id, now, true); }
    }, tickMs);
    (this.accessTimer as { unref?: () => void }).unref?.();
  }

  stopAccessReader(): void {
    if (this.accessTimer) { clearInterval(this.accessTimer); this.accessTimer = null; }
  }

  /** A link change is looked at when it happens, not on the reader's next tick (no request is started here). */
  private followAccess(id: string): void {
    if (this.accessTimer) { this.lookAccess(id, this.accessNow, false); }
  }

  /**
   * One look at a controller's access status (stepAccess), under its runtime,
   * which is made on the first look. Never throws: a change handler that
   * throws must end neither the reader's timer nor the client's notification.
   */
  private lookAccess(id: string, now: () => number, mayRead: boolean): void {
    if (!this.configs.has(id) || this.stopping.has(id)) { return; }
    let r = this.access.get(id);
    if (!r) {
      r = newAccessRuntime();
      this.access.set(id, r);
    }
    try {
      this.stepAccess(id, r, now, mayRead);
    } catch (e) {
      this.log.error({ controller: id, err: redactSecrets(e instanceof Error ? e.message : String(e)) }, 'access reader failed');
    }
  }

  /**
   * The generation whose access status the reader may read on a controller's
   * link now, or null when it may not send: the controller is configured and
   * not being torn down, its link is connected and healthy and not on a
   * different controller (an unverified link is read, as for the panel
   * group), the client knows the access generation, and the generation has a
   * part this client can read - so RobotWare 8 with a client that lacks the
   * write-access status read is never read.
   */
  private accessReadable(id: string): AccessGeneration | null {
    const cfg = this.configs.get(id);
    const view = this.view(id);
    if (!cfg || !view || this.stopping.has(id)) { return null; }
    if (!view.state.connected || !isHealthy(view.state.quality) || identityCheck(cfg, view).status === 'mismatch') { return null; }
    const generation = clientGeneration((view.state as { access?: unknown }).access);
    if (generation === 'rw8' && typeof (view as { getWriteAccessStatus?: unknown }).getWriteAccessStatus !== 'function') { return null; }
    return generation;
  }

  /** The run of usability a controller's link is in now: its link epoch, and how often the reader found it not usable. */
  private accessRun(id: string, r: AccessRuntime): string {
    return `${this.linkEpoch.get(id) ?? 0}|${r.gaps}`;
  }

  /** The reader found the link not usable: whatever is read on it next belongs to another run. */
  private endAccessRun(r: AccessRuntime): boolean {
    if (!r.usable) { return false; }
    r.usable = false;
    r.gaps++;
    return true;
  }

  /**
   * One look at a controller's access status (startAccessReader). `mayRead`:
   * it may start a round, which only the reader's own tick does.
   */
  private stepAccess(id: string, r: AccessRuntime, now: () => number, mayRead: boolean): void {
    const cfg = this.configs.get(id);
    const manager = this.managerOf(id);
    if (r.stopping || !cfg || !manager) { return; }
    this.noteLink(id);
    const t = now();
    const generation = this.accessReadable(id);
    if (generation === null) {
      const ended = this.endAccessRun(r);
      // A link on the wrong controller carries nothing, and nothing read before is kept for it.
      const wrong = identityCheck(cfg, manager).status === 'mismatch' && r.view.generation !== null;
      if (wrong) { r.view = unreadView(null); }
      if (ended || wrong) { this.announceAccess(id); }
      return;
    }
    const run = this.accessRun(id, r);
    r.usable = true;
    if (run !== r.run) {
      // Nothing read before this run is shown beside a usable link: every part
      // starts unread (RMMP too, should it have answered `unsupported` before).
      r.run = run;
      r.view = unreadView(generation);
      r.failures = 0;
      r.again = false;
      r.logged.clear();
      r.opmode = manager.state.opmode ?? null;
      r.nextAt = t;
      this.announceAccess(id);
    }
    const opmode = manager.state.opmode ?? null;
    if (opmode !== r.opmode) {
      r.opmode = opmode;
      r.nextAt = t;
      r.again = r.busy;   // a round already out may have read before the change
    }
    // The floor under the cadence: on one connection a round begins no sooner
    // than ACCESS_READ_MS after the round before it began, whatever brought it
    // forward (a link that recovered, a mode that changed). Only the first
    // round of a new connection is not held back.
    const epoch = this.linkEpoch.get(id) ?? 0;
    const paced = r.startedEpoch !== epoch || t - r.startedAt >= ACCESS_READ_MS;
    if (mayRead && !r.busy && t >= r.nextAt && paced) {
      r.startedAt = t;
      r.startedEpoch = epoch;
      // Never an unhandled rejection: a throwing change handler would end the process.
      r.inFlight = this.readAccess(id, r, manager, generation, run, now).catch(e => {
        this.log.error({ controller: id, err: redactSecrets(e instanceof Error ? e.message : String(e)) }, 'access status round failed');
      });
    }
  }

  /**
   * One round of status reads (startAccessReader), one request at a time.
   * Before every read, and before anything a read brought is written back,
   * the round asks whether it is abandoned: the controller is being torn
   * down, its runtime was replaced, or its link is no longer readable or has
   * moved to another run. An abandoned round writes nothing back and sends
   * nothing more, so nothing goes out behind a logout. Each part's answer
   * lands on that part alone: a read the daemon did not understand, or that
   * failed, leaves the part's values and time as they were and sets its
   * error (lockFromMastership, lockFromWriteAccess, rmmpFromPrivilege).
   */
  private async readAccess(
    id: string, r: AccessRuntime, manager: RobotManager, generation: AccessGeneration, run: string, now: () => number,
  ): Promise<void> {
    r.busy = true;
    const abandoned = (): boolean => {
      if (r.stopping || this.access.get(id) !== r) { return true; }
      this.noteLink(id);
      if (this.accessReadable(id) !== generation) {
        this.endAccessRun(r);
        return true;
      }
      return this.accessRun(id, r) !== run;
    };
    /** One status read: what the client answered, or what it threw. */
    const attempt = async (read: () => unknown): Promise<AccessRead> => {
      try { return { answer: await read() }; } catch (e) { return { thrown: e }; }
    };
    let parts = 0;
    let failed = 0;
    const landed = (part: string, error: GroupError | null, word: string | null): void => {
      parts++;
      if (error) { failed++; }
      this.noteAccessPart(id, r, part, error, word);
    };
    let complete = false;
    try {
      if (generation === 'rw8') {
        if (abandoned()) { return; }
        const read = await attempt(() => (manager as unknown as { getWriteAccessStatus(): unknown }).getWriteAccessStatus());
        if (abandoned()) { return; }
        const next = lockFromWriteAccess({ lock: r.view.locks[0], remoteAccessEnabled: r.view.remoteAccessEnabled }, read, now());
        r.view.locks = [next.lock];
        r.view.remoteAccessEnabled = next.remoteAccessEnabled;
        landed(next.lock.lock, next.lock.error, null);
      } else {
        for (const lock of r.view.locks.map(l => l.lock)) {
          const domain = domainOf(lock);
          if (domain === null) { continue; }
          if (abandoned()) { return; }
          // A client without the read answers as the client's own wrapper does without one: null, "could not be read".
          const read = await attempt(() => (typeof manager.getMastershipStatus === 'function' ? manager.getMastershipStatus(domain) : null));
          if (abandoned()) { return; }
          const before = r.view.locks.find(l => l.lock === lock);
          if (!before) { continue; }
          const after = lockFromMastership(before, read, now());
          r.view.locks = r.view.locks.map(l => (l === before ? after : l));
          landed(lock, after.error, answeredWord(read, 'mastership'));
        }
        if (r.view.rmmp.supported !== false) {
          if (abandoned()) { return; }
          const read = await attempt(() => (typeof manager.getRmmpPrivilege === 'function' ? manager.getRmmpPrivilege() : 'unsupported'));
          if (abandoned()) { return; }
          r.view.rmmp = rmmpFromPrivilege(r.view.rmmp, read, now());
          landed('RMMP', r.view.rmmp.error, answeredWord(read));
        }
      }
      complete = true;
    } finally {
      r.busy = false;
      if (complete) {
        const done = now();
        r.failures = parts > 0 && failed === parts ? r.failures + 1 : 0;
        const every = manager.state.quality === 'polling' ? ACCESS_READ_SLOW_MS : ACCESS_READ_MS;
        // A failing status is not read more often than a good one.
        r.nextAt = r.again ? done : done + (r.failures > 0 ? Math.max(every, accessRetryMs(r.failures)) : every);
        r.again = false;
      }
      this.announceAccess(id);
    }
  }

  /**
   * Log a part whose read failed, when its error code changes - not every
   * round. The line names the controller, the part and the code, and for a
   * status that was not understood the word that was answered (masked and
   * cut like every served text). Never a holder's id or a raw answer.
   */
  private noteAccessPart(id: string, r: AccessRuntime, part: string, error: GroupError | null, word: string | null): void {
    if (error === null) {
      r.logged.delete(part);
      return;
    }
    if (r.logged.get(part) === error.code) { return; }
    r.logged.set(part, error.code);
    this.log.warn({ controller: id, part, code: error.code, ...(error.code === 'PARSE_ERROR' && word !== null ? { word } : {}) },
      'access status not read; the last value is kept');
  }

  /** Tell the change handlers when a controller's access content changed (not for an asOf moving on). */
  private announceAccess(id: string): void {
    const r = this.access.get(id);
    const snap = r && this.get(id);
    if (!r || !snap) { return; }
    const sig = accessSignature(snap.access);
    if (sig === r.announced) { return; }
    r.announced = sig;
    for (const cb of this.changeHandlers) { cb(id); }
  }

  /**
   * Track which connection a controller is on. Unit descriptions are read once
   * per connection, so a new connection (or none) drops them, and a sampling
   * round that straddles the change is discarded.
   */
  private noteLink(id: string): void {
    const view = this.view(id);
    const key = view?.state.connected ? `${view.currentPort}|${view.currentUseHttps}` : null;
    if (this.linkKey.has(id) && this.linkKey.get(id) === key) { return; }
    this.linkKey.set(id, key);
    this.linkEpoch.set(id, (this.linkEpoch.get(id) ?? 0) + 1);
    const m = this.motion.get(id);
    if (m) { m.info.clear(); m.axes.clear(); }
  }

  onChanged(cb: (id: string) => void): void { this.changeHandlers.push(cb); }

  /** Add, persist, and start connecting. Connection failure is state, not an error. */
  add(cfg: ControllerConfig): void {
    this.addToManager(cfg);
    this.onConfigChange(this.all());
    void this.connect(cfg.id);
  }

  /**
   * Remove a controller: its sampling stops, the reads in flight (the
   * samplers' and those on demand) are allowed to finish but issue no further
   * read, and only then is the session logged out, so no read is sent behind
   * the /logout.
   */
  async remove(id: string): Promise<void> {
    this.retries.delete(id);
    this.timing.delete(id);
    this.pointers.delete(id);
    this.pointerNext.delete(id);
    this.lastExec.delete(id);
    const m = this.motion.get(id);
    this.motion.delete(id);      // no further round starts; the one in flight is discarded
    if (m) { m.stopping = true; }
    const r = this.io.get(id);
    this.io.delete(id);
    if (r) { r.stopping = true; r.untap?.(); }
    const ev = this.eventLogs.get(id);
    this.eventLogs.delete(id);   // what was recorded goes with it: an id added again is a new feed
    if (ev) { ev.stopping = true; }
    const ac = this.access.get(id);
    this.access.delete(id);      // what was read goes with it: an id added again starts unread
    if (ac) { ac.stopping = true; }
    this.stopping.add(id);
    this.linkKey.delete(id);
    this.linkEpoch.delete(id);
    await settleWithin([m?.inFlight, r?.inFlight, r?.editInFlight, ev?.inFlight, ev?.clockRead.inFlight, ac?.inFlight,
      this.pointerInFlight.get(id), ...this.reads.inFlight(id)], TEARDOWN_WAIT_MS);
    this.pointerInFlight.delete(id);
    this.reads.forget(id);   // nothing kept outlives the controller: an id added again starts afresh
    await this.multiCalls.disconnectRobot(id).catch(() => {});
    this.multiCalls.removeRobot(id);
    this.configs.delete(id);
    this.onConfigChange(this.all());
    this.log.info({ controller: id }, 'controller removed');
  }

  async connectAll(): Promise<void> {
    await Promise.allSettled(this.all().map(c => this.connect(c.id)));
  }

  /**
   * Shutdown: stop every timer, let the reads in flight finish (issuing no
   * more), then log out of every controller, all at once. Bounded: the reads
   * get at most half of `waitMs` (and never more than a single teardown
   * waits), the logouts what is left, and a logout still out then is
   * reported `timed-out` rather than waited for. No connect starts after
   * this. Returns what became of each controller's session, in config order.
   */
  async disconnectAll(opts: { waitMs?: number } = {}): Promise<ControllerLogout[]> {
    const waitMs = Math.max(0, opts.waitMs ?? DISCONNECT_ALL_WAIT_MS);
    const started = Date.now();
    this.closed = true;
    this.stopSupervisor();   // or it would reconnect what shutdown is closing
    this.stopPointerPoller();
    this.stopMotionSampler();
    this.stopIoPoller();
    this.stopEventReader();
    this.stopAccessReader();
    // What each link was before anything is torn down: that is what the report says.
    const links = this.all().map(cfg => {
      const view = this.view(cfg.id);
      return {
        about: { id: cfg.id, name: cfg.name, host: cfg.host, port: view?.currentPort ?? cfg.port },
        was: view?.state.connected ? 'connected' as const : this.connecting.has(cfg.id) ? 'connecting' as const : 'down' as const,
      };
    });
    for (const m of this.motion.values()) { m.stopping = true; }
    for (const r of this.io.values()) { r.stopping = true; r.untap?.(); }
    for (const r of this.eventLogs.values()) { r.stopping = true; }
    for (const r of this.access.values()) { r.stopping = true; }
    for (const id of this.configs.keys()) { this.stopping.add(id); }
    await settleWithin([
      ...[...this.motion.values()].map(m => m.inFlight),
      ...[...this.io.values()].flatMap(r => [r.inFlight, r.editInFlight]),
      ...[...this.eventLogs.values()].flatMap(r => [r.inFlight, r.clockRead.inFlight]),
      ...[...this.access.values()].map(r => r.inFlight),
      ...this.pointerInFlight.values(),
      ...this.reads.inFlight(),
    ], Math.min(TEARDOWN_WAIT_MS, waitMs / 2));
    const left = Math.max(0, waitMs - (Date.now() - started));
    return Promise.all(links.map(({ about, was }) => this.logoutWithin(about, was, left)));
  }

  /** Log out of one controller, waiting at most `ms` for it; what became of its session. */
  private async logoutWithin(
    about: Omit<ControllerLogout, 'outcome' | 'error'>, was: 'connected' | 'connecting' | 'down', ms: number,
  ): Promise<ControllerLogout> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const outOfTime = new Promise<'timed-out'>(resolve => { timer = setTimeout(() => resolve('timed-out'), ms); });
    const done = this.multiCalls.disconnectRobot(about.id).then(
      () => 'done' as const,
      (e: unknown) => ({ error: redactSecrets(e instanceof Error ? e.message : String(e)) }),
    );
    try {
      const result = await Promise.race([done, outOfTime]);
      if (result === 'timed-out') { return { ...about, outcome: 'timed-out' }; }
      if (result !== 'done') { return { ...about, outcome: 'failed', error: result.error }; }
      return { ...about, outcome: was === 'connected' ? 'logged-out' : was === 'connecting' ? 'connect-cancelled' : 'not-connected' };
    } finally {
      if (timer) { clearTimeout(timer); }
    }
  }

  private async connect(id: string, now: () => number = Date.now): Promise<void> {
    // Stopping: a session opened now would never be logged out.
    if (this.closed || this.connecting.has(id)) { return; }
    this.connecting.add(id);
    try {
      await this.multiCalls.connectRobot(id);
      this.retries.delete(id);
      this.log.info({ controller: id }, 'connected');
    } catch (e) {
      const failures = (this.retries.get(id)?.failures ?? 0) + 1;
      const delay = reconnectDelayMs(failures);
      this.retries.set(id, { failures, next: now() + delay });
      this.log.warn({ controller: id, failures, retryInS: delay / 1000, err: e instanceof Error ? e.message : String(e) },
        'connect failed');
    } finally {
      this.connecting.delete(id);
    }
  }

  private addToManager(cfg: ControllerConfig): void {
    this.configs.set(cfg.id, cfg);
    this.stopping.delete(cfg.id);   // an id removed earlier may be added again
    const before = this.eventLogs.get(cfg.id);
    if (before) { before.stopping = true; }
    this.eventLogs.set(cfg.id, newEventsRuntime());   // a new feed: seq starts at 1
    const read = this.access.get(cfg.id);
    if (read) { read.stopping = true; }
    this.access.delete(cfg.id);   // the access reader makes a new one on its first look
    this.multiCalls.addRobot({
      id: cfg.id, name: cfg.name, host: cfg.host, port: cfg.port,
      useHttps: cfg.useHttps, username: cfg.username, password: cfg.password,
      expectedSystemId: cfg.systemId,
    });
  }

  private view(id: string): ManagerView | null {
    return this.managerOf(id);
  }

  /**
   * The controller's own manager - the one session every read goes through.
   * While a recording runs, its tapped view (setTap): every call through it is
   * recorded, and does exactly what it does untapped.
   */
  private managerOf(id: string): RobotManager | null {
    const manager = this.clientManager(id);
    return manager && this.tap.current() ? this.tap.manager(manager, id) : manager;
  }

  /** The controller's manager itself, never tapped: what a recording is shown, not what the fleet calls. */
  private clientManager(id: string): RobotManager | null {
    return this.multi.entries.find(e => e.id === id)?.manager ?? null;
  }

  /** The MultiRobotManager to call: while a recording runs, its tapped view (setTap). Listeners go on `multi` itself. */
  private get multiCalls(): MultiRobotManager {
    return this.tap.current() ? this.tap.multi(this.multi) : this.multi;
  }

  /**
   * Record the controller's system id the first time it is read, if setup did
   * not supply one, and hand it to the client so port recovery can check it.
   */
  private learnSystemId(id: string): void {
    const cfg = this.configs.get(id);
    const actual = this.view(id)?.state.systemInfo?.sysid;
    if (!cfg || cfg.systemId || !actual) { return; }
    this.configs.set(id, { ...cfg, systemId: actual });
    this.multiCalls.updateConfig(id, { expectedSystemId: actual });
    this.log.info({ controller: id, systemId: actual }, 'system id recorded');
    this.onConfigChange(this.all());
  }

  /**
   * Never stay connected to the wrong robot. A link whose controller turns out
   * to have a different system id is disconnected, and the supervisor retries
   * it on its normal backoff; the client's connect then refuses the stranger
   * and looks for the right controller.
   */
  private dropIfWrongController(id: string): void {
    const cfg = this.configs.get(id);
    const view = this.view(id);
    if (!cfg || !view?.state.connected || this.dropping.has(id)) { return; }
    const check = identityCheck(cfg, view);
    if (check.status !== 'mismatch') { return; }
    this.dropping.add(id);
    this.log.error({ controller: id, expected: check.expected, actual: check.actual, port: view.currentPort },
      'connected to a different controller; disconnecting');
    const failures = (this.retries.get(id)?.failures ?? 0) + 1;
    this.retries.set(id, { failures, next: Date.now() + reconnectDelayMs(failures) });
    void this.multiCalls.disconnectRobot(id).catch(() => {}).finally(() => this.dropping.delete(id));
  }

  /**
   * Save a port the client moved to - but only once the controller there is
   * confirmed to be the one that was added. An unverified or different
   * controller must never be written into the config.
   */
  private persistPortIfMoved(id: string): void {
    const cfg = this.configs.get(id);
    const view = this.view(id);
    if (!cfg || view?.currentPort === undefined || view.currentPort === cfg.port) { return; }
    const check = identityCheck(cfg, view);
    if (check.status !== 'confirmed') {
      if (check.status === 'mismatch' && !this.warnedMismatch.has(id)) {
        this.warnedMismatch.add(id);
        this.log.error({ controller: id, expected: check.expected, actual: check.actual, port: view.currentPort },
          'controller on this link is a different system; port not saved');
      }
      return;
    }
    this.warnedMismatch.delete(id);
    const moved = { ...cfg, port: view.currentPort, useHttps: view.currentUseHttps ?? cfg.useHttps };
    this.configs.set(id, moved);
    this.log.info({ controller: id, from: cfg.port, to: moved.port }, 'controller moved port; config updated');
    this.onConfigChange(this.all());
  }
}

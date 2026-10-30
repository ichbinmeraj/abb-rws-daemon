import { REPLAY_SPEED_MAX, REPLAY_SPEED_MIN } from '../schema/v0.js';

/**
 * A replay's position in recording time (ms since the recording began, the
 * records' `t`), and how wall time maps onto it: playing at a speed, or
 * paused. Nothing here sends anything; the replay stream asks the clock how
 * long to wait for the next frame.
 */
export class ReplayClock {
  /** The position when the clock was last anchored (ms, recording time). */
  private anchorPos: number;
  /** When it was last anchored (ms on `now`). */
  private anchorAt: number;
  private paused: boolean;
  private rate: number;
  private readonly now: () => number;
  private readonly startMs: number;
  private readonly endMs: number;

  /**
   * `startMs` and `endMs` bound the position (the first and the last frame's
   * time); `now` is a monotonic clock in ms (performance.now by default), so
   * a change of the system clock moves nothing.
   */
  constructor(opts: { startMs: number; endMs: number; speed?: number; paused?: boolean; now?: () => number }) {
    this.now = opts.now ?? (() => performance.now());
    this.startMs = opts.startMs;
    this.endMs = Math.max(opts.startMs, opts.endMs);
    this.rate = checkSpeed(opts.speed ?? 1);
    this.paused = opts.paused ?? false;
    this.anchorPos = this.startMs;
    this.anchorAt = this.now();
  }

  get isPaused(): boolean { return this.paused; }
  get speed(): number { return this.rate; }

  /** The position now (ms, recording time), within the first and the last frame's time. */
  position(): number {
    if (this.paused) { return this.anchorPos; }
    return Math.min(this.endMs, this.anchorPos + (this.now() - this.anchorAt) * this.rate);
  }

  play(): void {
    if (!this.paused) { return; }
    this.anchorAt = this.now();
    this.paused = false;
  }

  pause(): void {
    if (this.paused) { return; }
    this.anchorPos = this.position();
    this.anchorAt = this.now();
    this.paused = true;
  }

  /** A new speed, REPLAY_SPEED_MIN to REPLAY_SPEED_MAX; the position carries on from where it is. Throws RangeError outside. */
  setSpeed(speed: number): void {
    const s = checkSpeed(speed);
    this.anchorPos = this.position();
    this.anchorAt = this.now();
    this.rate = s;
  }

  /** Move the position (a step to a frame's time, a start over). */
  seek(positionMs: number): void {
    this.anchorPos = Math.min(this.endMs, Math.max(this.startMs, positionMs));
    this.anchorAt = this.now();
  }

  /** Wall ms until the position reaches `t`: 0 when it has, Infinity while paused. */
  wallMsUntil(t: number): number {
    if (this.paused) { return Number.POSITIVE_INFINITY; }
    return Math.max(0, (t - this.position()) / this.rate);
  }
}

/** A replay speed, checked: REPLAY_SPEED_MIN to REPLAY_SPEED_MAX. Throws RangeError otherwise. */
export function checkSpeed(speed: number): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < REPLAY_SPEED_MIN || speed > REPLAY_SPEED_MAX) {
    throw new RangeError(`the replay speed must be ${REPLAY_SPEED_MIN} to ${REPLAY_SPEED_MAX} (got ${String(speed)})`);
  }
  return speed;
}

/**
 * The definitions of the snapshot schema a replay serves (frames and route
 * answers) that hold a date-time somewhere: which of their properties are
 * date-times (`format: date-time` in schema/v0.schema.json) and which hold
 * another such definition. A replay with `--replay-time shifted` moves
 * exactly these; raw controller texts (`identity.startTime`,
 * `events[].time.raw`) are never touched. A test checks this table against
 * the exported schema.
 */
export type TimedDefinition =
  | 'SnapshotFrame' | 'DeltaFrame' | 'RemovedFrame' | 'ControllerList' | 'EventsPage'
  | 'ControllerSnapshot' | 'DeltaGroups' | 'IdentityGroup' | 'LinkGroup' | 'ReconnectInfo' | 'PanelGroup' | 'RapidGroup'
  | 'MotionGroup' | 'IoGroup' | 'IoWatchedSignal' | 'EventsGroup' | 'ControllerEvent' | 'EventTime' | 'EventClock'
  | 'AccessGroup' | 'AccessLockInfo' | 'RmmpInfo' | 'CapabilitiesGroup' | 'FreshnessGroup' | 'GroupFreshness'
  | 'RapidSymbolValue';

interface TimedShape {
  /** Properties that are date-times. */
  times: readonly string[];
  /** Date-times a replay never moves: they say when the recording was made (`link.recordedAt`). */
  fixed?: readonly string[];
  /** Properties that hold another timed definition (`array`: a list of them). */
  nested: Readonly<Record<string, { def: TimedDefinition; array?: boolean }>>;
}

const GROUPS: TimedShape['nested'] = {
  identity: { def: 'IdentityGroup' }, link: { def: 'LinkGroup' }, panel: { def: 'PanelGroup' }, rapid: { def: 'RapidGroup' },
  motion: { def: 'MotionGroup' }, io: { def: 'IoGroup' }, events: { def: 'EventsGroup' },
  access: { def: 'AccessGroup' }, capabilities: { def: 'CapabilitiesGroup' }, freshness: { def: 'FreshnessGroup' },
};

export const TIMED_DEFINITIONS: Readonly<Record<TimedDefinition, TimedShape>> = {
  SnapshotFrame: { times: ['observedAt'], nested: { controllers: { def: 'ControllerSnapshot', array: true } } },
  DeltaFrame: { times: ['observedAt'], nested: { groups: { def: 'DeltaGroups' } } },
  RemovedFrame: { times: ['observedAt'], nested: {} },
  ControllerList: { times: ['observedAt'], nested: { controllers: { def: 'ControllerSnapshot', array: true } } },
  EventsPage: { times: [], nested: { events: { def: 'ControllerEvent', array: true } } },
  ControllerSnapshot: { times: [], nested: GROUPS },
  DeltaGroups: { times: [], nested: GROUPS },
  IdentityGroup: { times: ['asOf'], nested: {} },
  LinkGroup: { times: ['since', 'downSince'], fixed: ['recordedAt'], nested: { reconnect: { def: 'ReconnectInfo' } } },
  ReconnectInfo: { times: ['nextAttemptAt'], nested: {} },
  PanelGroup: { times: ['asOf'], nested: {} },
  RapidGroup: { times: ['asOf'], nested: {} },
  MotionGroup: { times: ['asOf'], nested: {} },
  IoGroup: { times: ['asOf'], nested: { signals: { def: 'IoWatchedSignal', array: true } } },
  IoWatchedSignal: { times: ['asOf'], nested: {} },
  EventsGroup: { times: ['asOf'], nested: { recent: { def: 'ControllerEvent', array: true }, clock: { def: 'EventClock' } } },
  ControllerEvent: { times: ['receivedAt'], nested: { time: { def: 'EventTime' } } },
  EventTime: { times: ['utc'], nested: {} },
  EventClock: { times: ['measuredAt'], nested: {} },
  AccessGroup: { times: ['asOf'], nested: { locks: { def: 'AccessLockInfo', array: true }, rmmp: { def: 'RmmpInfo' } } },
  AccessLockInfo: { times: ['asOf'], nested: {} },
  RmmpInfo: { times: ['asOf'], nested: {} },
  CapabilitiesGroup: { times: ['asOf'], nested: {} },
  FreshnessGroup: { times: [], nested: { groups: { def: 'GroupFreshness', array: true } } },
  GroupFreshness: { times: ['asOf'], nested: {} },
  RapidSymbolValue: { times: ['readAt'], nested: {} },
};

/** The definitions a replay serves whole: the three frames, the controller list and one controller, an events page, a RAPID value. */
export const REPLAY_TIME_ROOTS: readonly TimedDefinition[] = [
  'SnapshotFrame', 'DeltaFrame', 'RemovedFrame', 'ControllerList', 'ControllerSnapshot', 'EventsPage', 'RapidSymbolValue',
];

/**
 * Every date-time below `root` a replay moves, as a path
 * (`controllers[].link.reconnect.nextAttemptAt`), sorted; with `fixed`, the
 * ones it never moves instead.
 */
export function dateTimePaths(root: TimedDefinition, which: 'moved' | 'fixed' = 'moved'): string[] {
  const out: string[] = [];
  const walk = (def: TimedDefinition, prefix: string): void => {
    const shape = TIMED_DEFINITIONS[def];
    for (const p of which === 'moved' ? shape.times : shape.fixed ?? []) { out.push(`${prefix}${p}`); }
    for (const [p, n] of Object.entries(shape.nested)) { walk(n.def, `${prefix}${p}${n.array ? '[]' : ''}.`); }
  };
  walk(root, '');
  return out.sort();
}

/** An ISO date-time moved by `deltaMs`; anything that is not a date-time is returned as it is. */
export function shiftIso(value: string, deltaMs: number): string {
  if (deltaMs === 0) { return value; }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms + deltaMs).toISOString() : value;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Move every date-time of `value` (a `def`) by `deltaMs`, in place. Missing or null parts are skipped. */
export function shiftTimes(def: TimedDefinition, value: unknown, deltaMs: number): void {
  if (deltaMs === 0 || !isObj(value)) { return; }
  const shape = TIMED_DEFINITIONS[def];
  for (const p of shape.times) {
    const v = value[p];
    if (typeof v === 'string') { value[p] = shiftIso(v, deltaMs); }
  }
  for (const [p, n] of Object.entries(shape.nested)) {
    const v = value[p];
    if (n.array) {
      if (Array.isArray(v)) { for (const item of v) { shiftTimes(n.def, item, deltaMs); } }
    } else {
      shiftTimes(n.def, v, deltaMs);
    }
  }
}

/** The definition of a frame by its type; null for a type this daemon does not know (sent as recorded). */
export function frameDefinition(frame: unknown): TimedDefinition | null {
  if (!isObj(frame)) { return null; }
  switch (frame.type) {
    case 'snapshot': return 'SnapshotFrame';
    case 'delta': return 'DeltaFrame';
    case 'removed': return 'RemovedFrame';
    default: return null;
  }
}

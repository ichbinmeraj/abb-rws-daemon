import type { Log } from '../fleet.js';
import type { ReplayControl, ReplayHub, StreamEndpoint } from '../recording/contract.js';
import type {
  ReplayAction, ReplayControlRequest, ReplayHealth, ReplayState as ReplayPlayState, ReplayStatus, ReplayTimeMode,
} from '../schema/v0.js';
import type { SocketLike } from '../wsHub.js';
import { ReplayClock, checkSpeed, frameDefinition, shiftTimes, type TimedDefinition } from './clock.js';
import type { Recording, ReplayFrame } from './reader.js';
import { ReplayState, carriesAccess } from './state.js';

/** The hub a replay sends through (SocketHub): consumers, broadcast, and closing them all to start over. */
export interface ReplaySocketHub extends ReplayHub {
  attach(socket: SocketLike, firstFrame: string): boolean;
  detach(socket: SocketLike): void;
  broadcast(frame: string): void;
  /** The daemon stops: close every consumer as going away. */
  close(): void;
}

export interface ReplayStreamOptions {
  /** Playback speed, REPLAY_SPEED_MIN to REPLAY_SPEED_MAX; default 1. */
  speed?: number;
  /** Start over at the end; default false. */
  loop?: boolean;
  /** Start paused (`--replay-paused`); default false. */
  paused?: boolean;
  /** How times are served; default `shifted`. */
  time?: ReplayTimeMode;
  log?: Log;
  /** Wall clock (ms since the epoch); default Date.now. */
  wallNow?: () => number;
  /** Monotonic clock (ms) the frames are paced on; default performance.now. */
  monoNow?: () => number;
  /** How long after the last frame a looping replay starts over; default LOOP_DELAY_MS. */
  loopDelayMs?: number;
}

/** How long after its last frame a looping replay starts over (ms). */
export const LOOP_DELAY_MS = 1_000;

/** The close code (RFC 6455, service restart) stream consumers get when a replay starts over. */
export const CLOSE_REPLAY_RESTART = 1012;

/** The reason given with CLOSE_REPLAY_RESTART. */
export const REPLAY_RESTART_REASON = 'the recording starts over';

/** What `POST /v0/replay/control` may ask (ReplayAction). */
const REPLAY_ACTIONS: ReadonlySet<string> = new Set<ReplayAction>(['play', 'pause', 'step', 'restart']);

const SILENT: Log = { debug() {}, info() {}, warn() {}, error() {} };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Give every events group in `value` (a `def`) the feed name `rename` makes of it, in place. */
/**
 * Mark every link group of an answer or frame (a copy the caller owns) as
 * served from a recording: `mode` `replay`, and `recordedAt` the recorded
 * session's start. Returns whether it found a link group.
 */
function markReplayLinks(def: TimedDefinition, value: unknown, recordedAt: string): boolean {
  if (!isObj(value)) { return false; }
  const mark = (link: unknown): boolean => {
    if (!isObj(link)) { return false; }
    link.mode = 'replay';
    link.recordedAt = recordedAt;
    return true;
  };
  switch (def) {
    case 'SnapshotFrame': case 'ControllerList':
      return Array.isArray(value.controllers) && value.controllers.map(c => isObj(c) && mark(c.link)).includes(true);
    case 'DeltaFrame':
      return isObj(value.groups) && mark(value.groups.link);
    case 'ControllerSnapshot':
      return mark(value.link);
    default:
      return false;
  }
}

function renameFeeds(def: TimedDefinition, value: unknown, rename: (feed: string) => string): void {
  if (!isObj(value)) { return; }
  const renameGroup = (events: unknown) => {
    if (isObj(events) && typeof events.feed === 'string') { events.feed = rename(events.feed); }
  };
  switch (def) {
    case 'SnapshotFrame': case 'ControllerList':
      if (Array.isArray(value.controllers)) { for (const c of value.controllers) { if (isObj(c)) { renameGroup(c.events); } } }
      break;
    case 'DeltaFrame':
      if (isObj(value.groups)) { renameGroup(value.groups.events); }
      break;
    case 'ControllerSnapshot':
      renameGroup(value.events);
      break;
    default:
      break;
  }
}

/**
 * Replays a recording's frames on its stream (`WS /v0/stream` in replay
 * mode), on the recording's schedule, and answers for the replay's position.
 *
 * - A consumer that attaches gets a snapshot of the replay's state at the
 *   position, then every frame as its time comes: the recorded frames
 *   themselves, never run through the live stream's coalescer.
 * - A snapshot the recorder took in the middle of the recording (a part's
 *   start, after a gap) goes out as the deltas and removals that lead to it,
 *   so each consumer sees one snapshot, as on the live stream.
 * - Speed, pause, step and start over (ReplayControl). At the end with loop
 *   on, LOOP_DELAY_MS later, every consumer is closed with 1012 and the
 *   replay starts over from the first snapshot; each turn's event feed is
 *   renamed `<feed>~loop<n>`, so a consumer holding a `seq` cursor starts
 *   over. Without loop it stays at the last state, `ended`.
 * - Times: `shifted` moves every date-time of every frame and answer by the
 *   wall time minus the recording time at that point, so values are as old
 *   as they were then; `recorded` sends them as recorded (recorded frames
 *   without a link group byte for byte on the first turn), and a snapshot
 *   made for a consumer is stamped `sessionStartedAt + position`.
 * - Links: every link group of a frame or an answer says `mode` `replay`
 *   and `recordedAt` (the recorded session's start), for a recording of
 *   schema 0.13 or later.
 */
export class ReplayStream implements StreamEndpoint, ReplayControl {
  /** The controllers at the position. */
  readonly state = new ReplayState();
  private readonly clock: ReplayClock;
  private readonly frames: readonly ReplayFrame[];
  private readonly log: Log;
  private readonly wallNow: () => number;
  private readonly loopDelayMs: number;
  private readonly time: ReplayTimeMode;
  private readonly loop: boolean;
  private readonly firstT: number;
  private readonly lastT: number;
  /** The next frame to send. */
  private next = 0;
  private loops = 0;
  private ended = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly appliedHandlers: Array<(ids: string[]) => void> = [];

  constructor(private readonly recording: Recording, private readonly hub: ReplaySocketHub, opts: ReplayStreamOptions = {}) {
    if (recording.frames.length === 0) { throw new Error('a replay needs at least one frame'); }
    this.frames = recording.frames;
    this.log = opts.log ?? SILENT;
    this.wallNow = opts.wallNow ?? (() => Date.now());
    this.loopDelayMs = opts.loopDelayMs ?? LOOP_DELAY_MS;
    this.time = opts.time ?? 'shifted';
    this.loop = opts.loop ?? false;
    this.firstT = this.frames[0].t;
    this.lastT = this.frames[this.frames.length - 1].t;
    this.clock = new ReplayClock({
      startMs: this.firstT, endMs: this.lastT, speed: opts.speed ?? 1, paused: opts.paused ?? false, now: opts.monoNow,
    });
    this.applyFirst();
    this.schedule();
  }

  // --- the stream (StreamEndpoint) ---

  /** Add a consumer and send it a snapshot of the replay's state now; false when the hub refused it (and closed it). */
  attach(socket: SocketLike): boolean { return this.hub.attach(socket, this.snapshotFrame()); }

  detach(socket: SocketLike): void { this.hub.detach(socket); }

  /** A snapshot frame string of the replay's state at the position, as a consumer attaching now gets it. */
  snapshotFrame(): string {
    const frame = {
      type: 'snapshot', schemaVersion: this.recording.schemaVersion,
      observedAt: new Date(this.recording.sessionStartedAtMs + Math.round(this.clock.position())).toISOString(),
      controllers: structuredClone(this.state.list()),
    };
    this.mapAnswer('SnapshotFrame', frame);
    return JSON.stringify(frame);
  }

  /** The daemon stops: no more frames, every consumer closed as going away. */
  close(): void {
    this.closed = true;
    this.clearTimer();
    this.hub.close();
  }

  // --- what the replay fleet reads ---

  /** The position (ms since the recording began). */
  positionMs(): number { return this.clock.position(); }

  /** A recorded moment (ms since the recording began) as the time it was (ms since the epoch); mapAnswer moves it as it moves every time. */
  recordedAtMs(t: number): number { return this.recording.sessionStartedAtMs + Math.round(t); }

  /** The moment answers made now stand for (ms since the epoch): the wall clock when shifted, the recording's own time otherwise. */
  answerNowMs(): number {
    const at = this.recording.sessionStartedAtMs + Math.round(this.clock.position());
    return at + this.answerShiftMs();
  }

  /** Map an answer made now from the state (a copy the caller owns): times as the replay serves them, the feed of this turn. */
  mapAnswer<T>(def: TimedDefinition, value: T): T {
    shiftTimes(def, value, this.answerShiftMs());
    if (this.loops > 0) { renameFeeds(def, value, f => this.feedName(f)); }
    this.markLinks(def, value);
    return value;
  }

  /**
   * Mark the links of an answer or frame as replayed, for a recording whose
   * snapshot schema has `link.mode` (0.13 on); one made before keeps its
   * links as recorded, so it stays valid against its own version.
   */
  private markLinks(def: TimedDefinition, value: unknown): boolean {
    return carriesAccess(this.recording.schemaVersion) && markReplayLinks(def, value, this.recording.sessionStartedAt);
  }

  /** The name a recorded event feed is served under on this turn of the replay. */
  feedName(feed: string): string { return this.loops > 0 ? `${feed}~loop${this.loops}` : feed; }

  /** Call `cb` with the ids of the controllers each change of the state touched (a frame sent, a start over). */
  onApplied(cb: (ids: string[]) => void): void { this.appliedHandlers.push(cb); }

  // --- control (ReplayControl) ---

  status(): ReplayStatus {
    const h = this.recording.header;
    return {
      ...this.health(),
      files: [...this.recording.files],
      session: this.recording.session,
      label: this.recording.label,
      source: this.recording.source,
      recordedSchemaVersion: this.recording.schemaVersion,
      daemonVersion: typeof h.daemon?.version === 'string' ? h.daemon.version : null,
      clientVersion: typeof h.client?.version === 'string' ? h.client.version : null,
      gaps: this.recording.gaps,
    };
  }

  health(): ReplayHealth {
    return {
      state: this.playState(),
      positionMs: Math.round(this.clock.position()),
      durationMs: Math.round(this.lastT),
      speed: this.clock.speed,
      loop: this.loop,
      loops: this.loops,
      recordedAt: this.recording.sessionStartedAt,
      time: this.time,
    };
  }

  /**
   * Play, pause, send the next frame at once (`step`, which pauses), or
   * start over (`restart`, like a loop's turn: every consumer closed with
   * 1012). `speed` applies first. Throws RangeError for a speed out of
   * bounds, before anything changes.
   */
  control(request: ReplayControlRequest): ReplayStatus {
    if (!REPLAY_ACTIONS.has(request.action)) {
      throw new RangeError(`unknown replay action "${String((request as { action?: unknown }).action)}"`);
    }
    if (request.speed !== undefined) {
      checkSpeed(request.speed);
      this.clock.setSpeed(request.speed);
    }
    switch (request.action) {
      case 'play':
        if (!this.ended) { this.clock.play(); }
        break;
      case 'pause':
        if (!this.ended) { this.clock.pause(); }
        break;
      case 'step':
        this.step();
        break;
      case 'restart': {
        const stayPaused = this.clock.isPaused && !this.ended;
        this.startOver();
        if (stayPaused) { this.clock.pause(); } else { this.clock.play(); }
        break;
      }
    }
    this.schedule();
    return this.status();
  }

  // --- playing ---

  private playState(): ReplayPlayState {
    if (this.ended) { return 'ended'; }
    return this.clock.isPaused ? 'paused' : 'playing';
  }

  /** The first frame (a snapshot) is the state the replay starts from; it is sent to nobody. */
  private applyFirst(): void {
    const ids = this.state.apply(JSON.parse(this.frames[0].text));
    this.next = 1;
    this.notify(ids);
  }

  /** Book the timer for what comes next: the next frame's time, or the start over; nothing while paused, ended or closed. */
  private schedule(): void {
    this.clearTimer();
    if (this.closed || this.ended) { return; }
    const atEnd = this.next >= this.frames.length;
    const loops = this.loop && this.frames.length > 1;
    if (atEnd && !loops) { this.finish(); return; }
    if (this.clock.isPaused) { return; }
    this.timer = atEnd
      ? setTimeout(() => { this.timer = null; this.startOver(); this.schedule(); }, this.loopDelayMs)
      : setTimeout(() => this.tick(), Math.ceil(this.clock.wallMsUntil(this.frames[this.next].t)));
    (this.timer as { unref?: () => void }).unref?.();
  }

  private tick(): void {
    this.timer = null;
    const position = this.clock.position();
    // Every frame whose time has come; frames recorded together go out together.
    while (this.next < this.frames.length && this.frames[this.next].t <= position + 1e-6) { this.sendNext(); }
    this.schedule();
  }

  /**
   * Pause and send the next frame at once, moving the position to its time.
   * At the end a looping replay starts over (still paused); one that does
   * not loop has ended (schedule() sees to it).
   */
  private step(): void {
    if (this.ended) { return; }
    this.clock.pause();
    if (this.next < this.frames.length) {
      const frame = this.frames[this.next];
      this.sendNext();
      this.clock.seek(frame.t);
    } else if (this.loop && this.frames.length > 1) {
      this.startOver();
    }
  }

  /** The end without loop: the replay stays at the last state. */
  private finish(): void {
    this.clock.seek(this.lastT);
    this.clock.pause();
    if (!this.ended) { this.log.info({ loops: this.loops }, 'the replay reached the end of the recording'); }
    this.ended = true;
  }

  /** A loop's turn (or a restart): every consumer closed with 1012, the state back to the first snapshot, the position to its time. */
  private startOver(): void {
    this.clearTimer();
    this.hub.closeAll(CLOSE_REPLAY_RESTART, REPLAY_RESTART_REASON);
    const before = this.state.ids();
    this.state.reset();
    this.loops++;
    this.ended = false;
    this.notify(before);
    this.applyFirst();
    this.clock.seek(this.firstT);
    this.log.info({ loops: this.loops }, 'the replay starts over');
  }

  /** Send the next frame record: apply it, and broadcast it (a mid-recording snapshot as the deltas that lead to it). */
  private sendNext(): void {
    const frame = this.frames[this.next++];
    const parsed: unknown = JSON.parse(frame.text);
    if (frame.type === 'snapshot') {
      const out = structuredClone(this.state.resyncFrames(parsed));
      const ids = this.state.apply(parsed);
      for (const f of out) { this.hub.broadcast(this.frameText(f, frame.t)); }
      this.notify(ids);
      return;
    }
    // As recorded on the first turn, byte for byte, unless it carries a link,
    // which goes out marked as replayed.
    const asRecorded = this.time === 'recorded' && this.loops === 0;
    const def = frameDefinition(parsed);
    const text = asRecorded && !(def && this.markLinks(def, structuredClone(parsed)))
      ? frame.text
      : this.frameText(JSON.parse(frame.text), frame.t);
    const ids = this.state.apply(parsed);
    this.hub.broadcast(text);
    this.notify(ids);
  }

  /** A frame (a copy the caller owns) as it goes out at recording time `t`. */
  private frameText(frame: unknown, t: number): string {
    const def = frameDefinition(frame);
    if (def) {
      if (this.time === 'shifted') {
        shiftTimes(def, frame, Math.round(this.wallNow() - (this.recording.sessionStartedAtMs + t)));
      }
      if (this.loops > 0) { renameFeeds(def, frame, f => this.feedName(f)); }
      this.markLinks(def, frame);
    }
    return JSON.stringify(frame);
  }

  /** How far answers made now move their times: wall time minus recording time at the position (shifted), else 0. */
  private answerShiftMs(): number {
    if (this.time !== 'shifted') { return 0; }
    return Math.round(this.wallNow() - (this.recording.sessionStartedAtMs + Math.round(this.clock.position())));
  }

  private notify(ids: string[]): void {
    if (ids.length === 0) { return; }
    for (const cb of this.appliedHandlers) {
      try { cb(ids); } catch (e) {
        this.log.error({ err: e instanceof Error ? e.message : String(e) }, 'a replay change handler failed');
      }
    }
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

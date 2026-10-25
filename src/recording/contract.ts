import type { SubscriptionEvent, RobotState } from 'abb-rws-client';
import type { CallTarget } from '../schema/recording.js';
import type {
  RecordingHealth, RecordingStartRequest, RecordingStatus, ReplayControlRequest, ReplayHealth, ReplayStatus,
} from '../schema/v0.js';
import type { SocketLike } from '../wsHub.js';

/**
 * The interfaces the recorder, the fleet's tap, the stream and replay meet
 * at. Each side is built against these and tested with fakes of the others.
 */

/** What the recorder reads of a controller's manager when it records its state. */
export interface TappedManagerView {
  readonly state: RobotState;
  readonly currentPort?: number;
  readonly currentUseHttps?: boolean;
  readonly subscriptionGroupPath?: string;
}

/** A call the tap reported when it began; told its outcome once it settles. */
export interface PendingCall {
  done(outcome: { ok: true; result: unknown } | { ok: false; error: unknown }): void;
}

/**
 * Where the fleet's tap reports what crosses between the daemon and the
 * client: every client method the daemon calls (`call`, told at the call's
 * start, so its arguments are masked before anything else can happen), the
 * client's state as it changes (`state`) and every raw I/O subscription event
 * the daemon consumes (`sub`). A sink never changes what it is shown and
 * never throws; the tap guards it all the same.
 */
export interface ClientTapSink {
  /** False once the recording has ended: a tap holding this sink passes calls straight through. */
  readonly active: boolean;
  call(target: CallTarget, id: string | null, method: string, args: readonly unknown[]): PendingCall | null;
  state(id: string, manager: TappedManagerView | null): void;
  sub(id: string, event: SubscriptionEvent): void;
}

/** What may install a tap: the fleet. */
export interface TapHost {
  setTap(sink: ClientTapSink | null): void;
}

/** Feeds known secret values to the masking of a recording. Append-only. */
export interface SecretSource {
  /** A password (with its user name, for the encoded forms) or a token; returns whether it is masked by value (strong). */
  add(value: string, opts?: { user?: string; controller?: string }): boolean;
}

/** The recorder as the routes and the health answer see it. */
export interface RecorderControl {
  start(request: RecordingStartRequest): Promise<RecordingStatus>;
  stop(reason?: 'stopped' | 'daemon-stop', opts?: { waitMs?: number }): Promise<RecordingStatus>;
  status(): RecordingStatus;
  health(): RecordingHealth;
}

/** A replay as the routes and the health answer see it. */
export interface ReplayControl {
  status(): ReplayStatus;
  health(): ReplayHealth;
  control(request: ReplayControlRequest): ReplayStatus;
}

/** What an observer of the stream holds: the snapshot it began from, and how to stop. */
export interface FrameObservation {
  /** The snapshot frame (a JSON string) a consumer attaching at this moment would get. */
  first: string;
  stop(): void;
}

/**
 * The stream, as an in-process observer sees it: every frame string the hub
 * broadcasts, outside the hub (no consumer slot, never closed by it).
 */
export interface FrameObserver {
  observe(fn: (frame: string) => void): FrameObservation;
  /** A snapshot frame string of this moment, sent to nobody. */
  snapshotFrame(): string;
}

/** What `WS /v0/stream` hands each accepted socket to: the live stream, or a replay. */
export interface StreamEndpoint {
  /** Attach a consumer and send its first frame; false when it was refused (and closed). */
  attach(socket: SocketLike): boolean;
  detach(socket: SocketLike): void;
}

/** The hub as a replay needs it: close every consumer with a code, and keep accepting new ones. */
export interface ReplayHub {
  closeAll(code: number, reason: string): void;
}

/** A route would reach a controller, and the daemon is replaying a recording: 409 `REPLAY_MODE`. */
export class ReplayModeError extends Error {
  readonly code = 'REPLAY_MODE';
  constructor(message = 'the daemon is replaying a recording and reaches no controller') { super(message); }
}

/** The recording holds no answer to this request: 404 `NOT_RECORDED`. */
export class NotRecordedError extends Error {
  readonly code = 'NOT_RECORDED';
  constructor(message = 'the recording holds no answer to this request') { super(message); }
}

/** A recording already runs: 409 `RECORDING_ACTIVE`. */
export class RecordingActiveError extends Error {
  readonly code = 'RECORDING_ACTIVE';
  constructor(message = 'a recording already runs; stop it first') { super(message); }
}

/** The recording could not start (its folder or file, a limit already reached): 503 `RECORDING_FAILED`. Never names a path. */
export class RecordingFailedError extends Error {
  readonly code = 'RECORDING_FAILED';
}

/** A start request asked for a value outside the daemon's bounds: 400 `BAD_REQUEST`. */
export class RecordingBoundsError extends Error {
  readonly code = 'BAD_REQUEST';
}

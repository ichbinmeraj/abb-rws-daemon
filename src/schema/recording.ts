import type { StreamFrame } from './v0.js';

/**
 * The recording file format, version 1: JSON Lines (UTF-8, one JSON object
 * per line, `\n` separators, `kind` always the first member). The first line
 * of every part is a `RecordingHeader`; every other line is a record with a
 * `kind` and a `t`, the milliseconds since the recording began on a monotonic
 * clock, stamped when the record was captured. `t` never decreases within a
 * part, nor from one part to the next.
 *
 * A reader ignores unknown kinds and unknown fields, refuses a
 * `formatVersion` it does not know, and ignores a cut last line (a part whose
 * daemon was killed has no `end` record). `formatVersion` changes only for a
 * breaking change; additions keep 1.
 *
 * Every part starts with everything a reader needs to begin there: a
 * snapshot frame (in the first part, the one the stream gave when the
 * recording began; in every later part, one the recorder took, marked
 * `resync`), the `controller` records and `full` state records. A recording
 * is private controller data: credentials are masked when a record is
 * written (`masking` in the header), but user names, hosts, system ids,
 * names, signal names and RAPID source are kept.
 *
 * The format's own types are defined here (the `Recorded*` types), not taken
 * from the snapshot schema, so a new snapshot minor cannot change what a
 * format-1 file holds. Only `frame` records refer to the snapshot schema
 * (`StreamFrame`); validate them against the snapshot schema of the header's
 * `schemaVersion`.
 */

/** The format's name in every header. */
export const RECORDING_FORMAT = 'abb-rws-recording' as const;

/** The format version this daemon writes and reads. */
export const RECORDING_FORMAT_VERSION = 1;

/**
 * A masking rule, in the order they run: secret-named `keys`, secret
 * arguments by position (`args`), credential-shaped `text`, secret RAPID
 * literals (`rapid`), known secret `values`, and the `final` check.
 */
export type RecordingMaskingRule = 'keys' | 'args' | 'text' | 'rapid' | 'values' | 'final';

/**
 * What a recording holds: `frames` (the stream frames as consumers received
 * them), `calls` (client methods the daemon called, and the raw I/O
 * subscription events it consumed), `state` (changes of the client's state).
 */
export type RecordedContent = 'frames' | 'calls' | 'state';

/**
 * Why a recording, or one part of it, ended: `stopped`, `duration`,
 * `size-limit`, `dir-limit`, `disk-space`, `writer-behind`, `mask-check`,
 * `error`, `daemon-stop`, `rotated` (the recording goes on in the next
 * part), `closed` and `interrupted` (a stream capture).
 */
export type RecordedEndReason =
  | 'stopped' | 'duration' | 'size-limit' | 'dir-limit' | 'disk-space' | 'writer-behind' | 'mask-check' | 'error'
  | 'daemon-stop' | 'rotated' | 'closed' | 'interrupted';

/** The limits a recording ran under. */
export interface RecordedLimits {
  /**
   * A part reaching this size was closed and the recording went on in a new part.
   * @integer
   * @unit bytes
   */
  maxFileBytes: number;
  /**
   * All parts together stay within this (`size-limit`).
   * @integer
   * @unit bytes
   */
  maxTotalBytes: number;
  /**
   * The recordings folder's limit (`dir-limit`).
   * @integer
   * @unit bytes
   */
  maxDirBytes: number;
  /**
   * The largest line other than a frame.
   * @integer
   * @unit bytes
   */
  maxRecordBytes: number;
  /**
   * The free-space floor (`disk-space`).
   * @integer
   * @unit bytes
   */
  minFreeBytes: number;
  /**
   * The recording's duration (`duration`).
   * @integer
   * @unit s
   */
  durationS: number;
}

/** Records left out, by kind; every kind is present, zeros included. Frames are never left out. */
export interface RecordedDropped {
  /**
   * @integer
   * @unit count
   */
  call: number;
  /**
   * @integer
   * @unit count
   */
  state: number;
  /**
   * @integer
   * @unit count
   */
  sub: number;
}

/**
 * What masking did over the whole recording: known secret values masked by
 * value (`values`, their encoded forms `derived`), those too weak to mask by
 * value (`weakValues`), the records masking changed, the keys it dropped and
 * the lines it refused to write.
 */
export interface RecordedMasking {
  /**
   * @integer
   * @unit count
   */
  values: number;
  /**
   * @integer
   * @unit count
   */
  derived: number;
  /**
   * @integer
   * @unit count
   */
  weakValues: number;
  /**
   * @integer
   * @unit count
   */
  maskedRecords: number;
  /**
   * @integer
   * @unit count
   */
  droppedKeys: number;
  /**
   * @integer
   * @unit count
   */
  refusedLines: number;
}

/** What the controller answered to a failed call. */
export interface RecordedControllerAnswer {
  /**
   * The HTTP status; null when no answer reached the daemon.
   * @integer
   * @unit none
   */
  httpStatus: number | null;
  /**
   * The controller's own status code; null when its body had none.
   * @integer
   * @unit none
   */
  code: number | null;
  /** The controller's own message; null when its body had none. */
  message: string | null;
}

/**
 * The client's account of a refusal (`kind`, `missing`, `grantor`, `fix`, and
 * whatever more it carries), masked.
 * @ros json
 */
export interface RecordedRefusal {
  kind?: string;
  missing?: string;
  grantor?: string;
  fix?: string;
  [field: string]: unknown;
}

/**
 * A call's failure in the daemon's own shape: `code` (the client's error code,
 * or one of the daemon's: a reader accepts codes it does not know), `message`,
 * and the controller's answer and refusal when there were any.
 */
export interface RecordedError {
  code: string;
  message: string;
  controller?: RecordedControllerAnswer;
  refusal?: RecordedRefusal;
}

/** Who made a recording: the daemon's recorder, or a stream consumer (scripts/capture-stream.mjs). */
export type RecordingSource = 'daemon' | 'stream-capture';

/** A program's version, as recorded in a header. */
export interface RecordingVersionInfo {
  /** The package version; `unknown` when it could not be read. */
  version: string;
}

/**
 * A controller the daemon was configured with when the part began. A hint
 * only: nothing has been read at launch, so the `controller` records are the
 * authority for the system id, generation and RobotWare.
 */
export interface RecordingControllerHint {
  id: string;
  systemId: string | null;
  generation: 'rws1' | 'rws2' | null;
  robotWare: string | null;
}

/** What masking did, as the header of a part states it when the part begins. */
export interface RecordingMaskingHeader {
  /** The rules applied, in order (a stream capture sees no client calls, so it has no `args`). */
  rules: RecordingMaskingRule[];
  /**
   * Known secret values masked by value.
   * @integer
   * @unit count
   */
  values: number;
  /**
   * Encoded forms of those values.
   * @integer
   * @unit count
   */
  derived: number;
  /**
   * Known values too short or too common to mask by value.
   * @integer
   * @unit count
   */
  weakValues: number;
}

/** The first line of every part. */
export interface RecordingHeader {
  kind: 'header';
  format: typeof RECORDING_FORMAT;
  /**
   * @integer
   * @unit none
   */
  formatVersion: typeof RECORDING_FORMAT_VERSION;
  /** The snapshot schema version of the frames. */
  schemaVersion: string;
  source: RecordingSource;
  /** The recording's name: its files' names without the part suffix. */
  session: string;
  /**
   * This part's number, from 1.
   * @integer
   * @unit count
   */
  part: number;
  /** The previous part's file name; null for the first. */
  previous: string | null;
  /**
   * When this part began.
   * @format date-time
   */
  startedAt: string;
  /**
   * When the recording began: `t` counts from here.
   * @format date-time
   */
  sessionStartedAt: string;
  label: string | null;
  content: RecordedContent[];
  daemon: RecordingVersionInfo;
  client: RecordingVersionInfo;
  controllers: RecordingControllerHint[];
  /** The limits the recording runs under; null for a stream capture. */
  limits: RecordedLimits | null;
  masking: RecordingMaskingHeader;
  /** Set by the sanitizer: identifiers replaced, fit for a public fixture. */
  sanitized?: boolean;
}

/**
 * One `/v0/stream` frame exactly as consumers received it: the observed
 * string, byte for byte, unless `masked` says masking changed it.
 */
export interface FrameRecord {
  kind: 'frame';
  /**
   * @integer
   * @unit ms
   */
  t: number;
  frame: StreamFrame;
  /**
   * How many values masking replaced plus keys it dropped; absent when the frame is unchanged.
   * @integer
   * @unit count
   */
  masked?: number;
  /**
   * A snapshot taken by the recorder (the start of every part but the first,
   * and after a gap): a reader replaces all state with it, as with any snapshot.
   */
  resync?: boolean;
}

/** A controller's identity as it became known or changed (the authority for `call.gen`). */
export interface ControllerRecord {
  kind: 'controller';
  /**
   * @integer
   * @unit ms
   */
  t: number;
  id: string;
  systemId: string | null;
  generation: 'rws1' | 'rws2' | null;
  robotWare: string | null;
  identityCheck: 'confirmed' | 'unverified' | 'mismatch';
}

/** Where a call went: a controller's manager, the manager of every controller, or a setup step. */
export type CallTarget = 'manager' | 'multi' | 'setup';

/** One client method the daemon called: arguments, outcome and how long it took. */
export interface CallRecord {
  kind: 'call';
  /**
   * When the call settled; it began `ms` earlier.
   * @integer
   * @unit ms
   */
  t: number;
  target: CallTarget;
  /** The controller's id; null for a setup step. */
  id: string | null;
  /** The controller's generation from its latest `controller` record; null until known. */
  gen: 'rws1' | 'rws2' | null;
  /**
   * Counts calls in the recording, from 1.
   * @integer
   * @unit count
   */
  seq: number;
  method: string;
  /** The arguments as plain JSON, masked; `***` for a method whose arguments are secret as a whole. */
  args: unknown[] | string;
  /**
   * @integer
   * @unit ms
   */
  ms: number;
  ok: boolean;
  /** The result as plain JSON, masked (with `ok`). */
  result?: unknown;
  /** The failure as a snapshot group carries it (without `ok`). */
  error?: RecordedError;
  /**
   * @integer
   * @unit count
   */
  masked?: number;
}

/** The connection a manager was on when its state was recorded. */
export interface StateManagerInfo {
  /**
   * @integer
   * @unit none
   */
  port: number | null;
  useHttps: boolean | null;
  groupPath: string | null;
}

/** The I/O signal table changed: signals added (whole), changed (whole) and removed (by name). */
export interface IoSignalsDiff {
  added: unknown[];
  changed: unknown[];
  removed: string[];
}

/** One chunk of the whole I/O signal table; chunks 1 to `chunks` together are the table. */
export interface IoSignalsChunk {
  /**
   * @integer
   * @unit count
   */
  chunk: number;
  /**
   * @integer
   * @unit count
   */
  chunks: number;
  full: unknown[];
}

/**
 * The client's state for one controller, as it changed: only the top-level
 * keys that changed (`full`: every key). The event log is never in a state
 * record (frames and the event reads carry it); the I/O signal table is
 * recorded by signal (`ioSignals`), whole only in chunks.
 */
export interface StateRecord {
  kind: 'state';
  /**
   * @integer
   * @unit ms
   */
  t: number;
  id: string;
  /** Every key, not only those that changed: the first state record per controller per part, and after a gap. */
  full?: boolean;
  /** Changed keys and their new values, masked. */
  changed?: Record<string, unknown>;
  manager?: StateManagerInfo;
  ioSignals?: IoSignalsDiff | IoSignalsChunk;
  /**
   * @integer
   * @unit count
   */
  masked?: number;
}

/** One raw I/O subscription event the daemon consumed. */
export interface SubRecord {
  kind: 'sub';
  /**
   * @integer
   * @unit ms
   */
  t: number;
  id: string;
  event: unknown;
  /**
   * @integer
   * @unit count
   */
  masked?: number;
}

/**
 * Records were left out here: `writer-behind` (the disk did not keep up) or
 * `mask-check` (a record the final masking check refused). Always followed by
 * a resync snapshot and `full` state records. Frames are never left out.
 */
export interface GapRecord {
  kind: 'gap';
  /**
   * @integer
   * @unit ms
   */
  t: number;
  why: 'writer-behind' | 'mask-check';
  /** What was left out, by kind; every kind is present, zeros included. */
  kinds: RecordedDropped;
}

/** A line of plain text: why a recording stopped, a rotation. */
export interface NoteRecord {
  kind: 'note';
  /**
   * @integer
   * @unit ms
   */
  t: number;
  text: string;
}

/** Figures about the recorder itself. */
export interface RecordingStats {
  /**
   * The longest a state comparison took.
   * @integer
   * @unit ms
   */
  stateDiffMsMax: number;
}

/**
 * The last line of a part its writer closed. `reason` is `rotated` when the
 * next part goes on, else why the recording ended; a stream capture ends
 * `closed` (the daemon closed the stream; `closeCode` says how) or
 * `interrupted`.
 */
export interface EndRecord {
  kind: 'end';
  /**
   * @integer
   * @unit ms
   */
  t: number;
  reason: RecordedEndReason;
  /**
   * Records in this part, the header and this one included.
   * @integer
   * @unit count
   */
  records: number;
  /**
   * Bytes in this part before this line.
   * @integer
   * @unit bytes
   */
  bytes: number;
  /** Records left out of this part, by kind (`GET /v0/recording` counts the whole recording). */
  dropped: RecordedDropped;
  /** What masking did over the whole recording up to here. */
  masking: RecordedMasking;
  stats: RecordingStats;
  /** The next part's file name; null for the last. */
  next: string | null;
  /**
   * The WebSocket close code, for a capture the daemon closed.
   * @integer
   * @unit none
   */
  closeCode?: number;
}

/** Any line of a recording. */
export type RecordingLine =
  | RecordingHeader | FrameRecord | ControllerRecord | CallRecord | StateRecord | SubRecord | GapRecord | NoteRecord | EndRecord;

/** Every record kind but the header. */
export type RecordKind = 'frame' | 'controller' | 'call' | 'state' | 'sub' | 'gap' | 'note' | 'end';

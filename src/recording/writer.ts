import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { OwnerOnlyHandle } from '../config.js';
import type { RecordKind, RecordingStats } from '../schema/recording.js';
import type {
  RecordingDropped, RecordingEndReason, RecordingLimits, RecordingLimitsRequest, RecordingMasking,
} from '../schema/v0.js';
import { RecordingBoundsError } from './contract.js';

/**
 * The recording writer: one queue per part, written only through the part's
 * open handle (the daemon's event loop never waits on the disk), with the
 * limits a recording runs under, rotation into the next part, and what
 * happens when the disk falls behind.
 */

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

/** The limits a recording runs under unless the daemon is started with others. */
export const RECORDING_LIMIT_DEFAULTS: Readonly<RecordingLimits> = Object.freeze({
  maxFileBytes: 64 * MIB,
  maxTotalBytes: 256 * MIB,
  maxDirBytes: 4 * GIB,
  maxRecordBytes: 1 * MIB,
  minFreeBytes: 2 * GIB,
  durationS: 3600,
});

/** The bounds every limit is held to, whoever sets it (the command line or a start request). */
export const RECORDING_LIMIT_BOUNDS: Readonly<Record<keyof RecordingLimits, { readonly min: number; readonly max: number }>> = Object.freeze({
  maxFileBytes: { min: 1 * MIB, max: 256 * MIB },
  maxTotalBytes: { min: 1 * MIB, max: 8 * GIB },
  maxDirBytes: { min: 1 * MIB, max: 64 * GIB },
  maxRecordBytes: { min: 64 * KIB, max: 4 * MIB },
  minFreeBytes: { min: 1 * GIB, max: Number.MAX_SAFE_INTEGER },
  durationS: { min: 1, max: 24 * 3600 },
});

/** The writer's queue: above `softBytes` calls, state and sub events are dropped; at `hardBytes` the recording stops. */
export interface WriterQueueLimits {
  softBytes: number;
  hardBytes: number;
  /** After a drop, the gap and the resync are written once the queue is below this. */
  resumeBytes: number;
}

export const WRITER_QUEUE_LIMITS: Readonly<WriterQueueLimits> = Object.freeze({
  softBytes: 8 * MIB,
  hardBytes: 32 * MIB,
  resumeBytes: 1 * MIB,
});

/** A frame line is never shortened or dropped; one larger than this stops the recording (`error`). */
export const FRAME_LINE_MAX_BYTES = 16 * MIB;

/**
 * Room kept below `maxTotalBytes` for every part still to be closed: its stop
 * note and end record. A recording that stops at `size-limit` (or for any
 * other reason) therefore stays within `maxTotalBytes`, so a recording made
 * at the defaults is never larger than the replay reader reads.
 */
export const END_RESERVE_BYTES = 2 * KIB;

/** At most this much is handed to one write. */
const WRITE_BATCH_BYTES = 256 * KIB;

const LIMIT_KEYS = Object.keys(RECORDING_LIMIT_BOUNDS) as Array<keyof RecordingLimits>;

/** Why a limit is outside its bounds (or not a whole number), or null when every one given is within them. */
export function limitsProblem(limits: Partial<Record<string, unknown>>): string | null {
  for (const [key, value] of Object.entries(limits)) {
    if (value === undefined) { continue; }
    const bounds = RECORDING_LIMIT_BOUNDS[key as keyof RecordingLimits];
    if (!bounds) { return `${key} is not a recording limit`; }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
      return `${key} must be a whole number from ${bounds.min} to ${bounds.max}`;
    }
  }
  return null;
}

/**
 * The limits a start request runs under: each limit it gives must be within
 * the bounds (else RecordingBoundsError, 400), and may only tighten `base`
 * (the daemon's own): the `max*` limits and the duration take the smaller
 * value, `minFreeBytes` the larger.
 */
export function tightenLimits(base: RecordingLimits, request?: RecordingLimitsRequest | null, durationS?: number): RecordingLimits {
  const asked: Partial<Record<string, unknown>> = { ...(request ?? {}) };
  if ('durationS' in asked) { throw new RecordingBoundsError('durationS is given beside limits, not in them'); }
  if (durationS !== undefined) { asked.durationS = durationS; }
  const problem = limitsProblem(asked);
  if (problem) { throw new RecordingBoundsError(problem); }
  const out = { ...base };
  for (const key of LIMIT_KEYS) {
    const v = asked[key] as number | undefined;
    if (v === undefined) { continue; }
    out[key] = key === 'minFreeBytes' ? Math.max(base[key], v) : Math.min(base[key], v);
  }
  return out;
}

/** A recording's name: `rec-<UTC yyyymmddThhmmssZ>[-<label>]`. */
export function recordingSessionName(at: Date, label: string | null): string {
  const stamp = `${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  return `rec-${stamp}${label ? `-${label}` : ''}`;
}

/** A part's file name: the recording's name and `-p<0001>.jsonl`. */
export function recordingPartName(session: string, part: number): string {
  return `${session}-p${String(part).padStart(4, '0')}.jsonl`;
}

/** The files the folder limit counts: every recording part in the folder. */
export const RECORDING_FILE_PATTERN = /^rec-.*\.jsonl$/;

/** File-system reads behind the folder limit and the free-space floor; each defaults to the real one. */
export interface FolderFs {
  readdir?: (dir: string) => Promise<string[]>;
  size?: (path: string) => Promise<number>;
  statfs?: (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
}

/** The bytes every recording part in `dir` holds together (`maxDirBytes`). */
export async function recordingFolderBytes(dir: string, fsx: FolderFs = {}): Promise<number> {
  const names = await (fsx.readdir ?? (d => readdir(d)))(dir);
  const size = fsx.size ?? (async (p: string) => (await stat(p)).size);
  let total = 0;
  for (const name of names) {
    if (!RECORDING_FILE_PATTERN.test(name)) { continue; }
    try { total += await size(join(dir, name)); } catch { /* gone meanwhile */ }
  }
  return total;
}

/** The bytes free to this account on the disk holding `dir` (`minFreeBytes`). */
export async function freeDiskBytes(dir: string, fsx: FolderFs = {}): Promise<number> {
  const s = await (fsx.statfs ?? (d => statfs(d)))(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * The lines of a recording file as a reader takes them: every complete line
 * parsed; a last line without its newline that does not parse is `cut` (a
 * daemon killed mid-write) and left out; any other line that does not parse
 * is listed in `bad` (1-based line numbers).
 */
export function splitRecordingLines(text: string): { records: unknown[]; cut: boolean; bad: number[] } {
  const lines = text.split('\n');
  const last = lines.pop() ?? '';
  const records: unknown[] = [];
  const bad: number[] = [];
  lines.forEach((line, i) => {
    if (line.length === 0) { return; }
    try { records.push(JSON.parse(line)); } catch { bad.push(i + 1); }
  });
  let cut = false;
  if (last.length > 0) {
    try { records.push(JSON.parse(last)); } catch { cut = true; }
  }
  return { records, cut, bad };
}

/** A line to queue and the kind of record it is. */
export interface WriterLine {
  kind: RecordKind;
  line: string;
}

/** Why the writer stopped a recording by itself, in plain words (never a path). */
export interface WriterStop {
  reason: RecordingEndReason;
  message: string | null;
}

/** What the writer needs of the recorder. */
export interface RecordingWriterOptions {
  /** The recording's name: part file names are made from it. */
  session: string;
  limits: RecordingLimits;
  /** The recording's clock: ms since it began, never decreasing. */
  clock(): number;
  /** Make a part's file owner-only with its header line, and return the open handle. */
  create(name: string, headerLine: string): Promise<OwnerOnlyHandle>;
  /** Before every part after the first: null to go on, else why the recording stops instead. */
  checkBeforePart(): Promise<WriterStop | null>;
  /** A part's header line (no newline), made at the moment the part begins. */
  header(part: number, name: string, previous: string | null): string;
  /**
   * The lines that make a reader whole again, captured now: at the top of a
   * part (`part`: controller records, a resync snapshot, full state
   * records) and after a gap (`gap`: a resync snapshot, full state records,
   * controller records).
   */
  resync(cause: 'part' | 'gap'): WriterLine[];
  /** What an end record carries besides the writer's own counts. */
  endExtras(): { masking: RecordingMasking; stats: RecordingStats };
  /** The writer stopped the recording by itself (a limit, the disk, a failed write). Told once. */
  onStop(stop: WriterStop): void;
  /** A state record of this controller was dropped: its next one must be full. */
  onStateDropped?(id: string): void;
  /** The recording went on in a new part. */
  onRotated?(from: string, to: string): void;
  queue?: Partial<WriterQueueLimits>;
}

/** What one stop note says, by reason. */
const STOP_NOTES: Partial<Record<RecordingEndReason, string>> = {
  stopped: 'recording stopped: asked to stop',
  duration: 'recording stopped: duration reached',
  'size-limit': 'recording stopped: the recording reached maxTotalBytes',
  'dir-limit': 'recording stopped: the recordings folder reached maxDirBytes',
  'disk-space': 'recording stopped: free disk space fell below minFreeBytes',
  'writer-behind': 'recording stopped: the disk did not keep up',
  'mask-check': 'recording stopped: a frame still held a known secret after masking',
  error: 'recording stopped: an error',
  'daemon-stop': 'recording stopped: the daemon stopped',
};

const zeroDropped = (): RecordingDropped => ({ call: 0, state: 0, sub: 0 });

interface Part {
  n: number;
  name: string;
  handle: OwnerOnlyHandle | null;
  /** Lines waiting for the disk, each with its newline. */
  queue: string[];
  queuedBytes: number;
  /** The part's size once everything given to it is written: header included. */
  bytes: number;
  /** Lines given to it, the header included. */
  records: number;
  /** Records given to it after its header and resync lines. */
  sincePreamble: number;
  dropped: RecordingDropped;
  /** Takes no more records (its end is coming). */
  sealed: boolean;
  /** Its end line is queued: closed once written. */
  endQueued: boolean;
  closed: boolean;
}

const lineBytes = (line: string): number => Buffer.byteLength(line, 'utf8') + 1;

/**
 * Queues a recording's lines and writes them, part after part, each through
 * the part's own handle. Frames, controller records, notes, gaps and ends are
 * never dropped; calls, state and sub events are dropped (and counted) while
 * the queue is above its soft limit, and once it drains a `gap` record and a
 * resync follow. A queue at its hard limit stops the recording
 * (`writer-behind`) after writing what is queued, rather than leave a hole in
 * the frames.
 *
 * Rotation: when a part reaches `maxFileBytes`, at that moment T the records
 * so far stay in it, its end (`rotated`) is stamped T, and the next part's
 * queue starts with its header and resync lines made at T; everything later
 * goes behind them. The next part's file is made (folder checks first) while
 * records keep arriving; once it exists the old part's end is written and its
 * handle closed, then the new queue is written. If it cannot be made, the old
 * part ends with that reason and the recording stops.
 */
export class RecordingWriter {
  private readonly q: WriterQueueLimits;
  private parts: Part[] = [];
  private readonly made: string[] = [];
  private queuedBytes = 0;
  private totalBytes = 0;
  private readonly droppedTotal = zeroDropped();
  /** Dropped since the last gap record. */
  private gapKinds = zeroDropped();
  private dropping = false;
  private rotating: Promise<void> | null = null;
  private stopping = false;
  private broken = false;
  private pumping = false;
  private waiters: Array<() => void> = [];
  private reason: RecordingEndReason | null = null;
  private problem: string | null = null;

  constructor(private readonly opts: RecordingWriterOptions) {
    this.q = { ...WRITER_QUEUE_LIMITS, ...(opts.queue ?? {}) };
  }

  /** The parts made so far, oldest first (base names). */
  get files(): string[] { return [...this.made]; }
  /** Lines given to the parts, headers and ends included. */
  get records(): number { return this.parts.reduce((n, p) => n + p.records, 0); }
  /** The parts' size once everything given to them is written. */
  get bytes(): number { return this.totalBytes; }
  /** Bytes waiting for the disk. */
  get queued(): number { return this.queuedBytes; }
  get dropped(): RecordingDropped { return { ...this.droppedTotal }; }
  /** Still taking records. */
  get active(): boolean { return !this.stopping; }
  /** Why the recording ended; null while it runs. */
  get endReason(): RecordingEndReason | null { return this.reason; }
  /** What went wrong, in plain words. */
  get error(): string | null { return this.problem; }

  /** Make the first part. Throws why it could not be made; nothing is left behind then. */
  async open(): Promise<void> {
    const name = recordingPartName(this.opts.session, 1);
    const header = this.opts.header(1, name, null);
    const part = this.newPart(1, name, header);
    this.parts.push(part);
    try {
      part.handle = await this.opts.create(name, `${header}\n`);
    } catch (e) {
      this.parts = [];
      this.totalBytes = 0;
      this.queuedBytes = 0;
      this.stopping = true;
      throw e;
    }
    this.made.push(name);
    this.pump();
  }

  /**
   * Whether a record of this kind is taken now; false when it is dropped
   * (counted, and a state record's controller marked for a full record
   * next). Asked before a call, state or sub record is made, so a dropped
   * one costs nothing. Frames and every other kind are always taken.
   */
  admit(kind: RecordKind, id?: string): boolean {
    if (this.stopping) { return false; }
    if (kind !== 'call' && kind !== 'state' && kind !== 'sub') { return true; }
    if (!this.dropping && this.queuedBytes < this.q.softBytes) { return true; }
    this.dropping = true;
    this.droppedTotal[kind]++;
    this.gapKinds[kind]++;
    const last = this.last();
    if (last) { last.dropped[kind]++; }
    if (kind === 'state' && id !== undefined) { this.opts.onStateDropped?.(id); }
    return false;
  }

  /**
   * Queue one line. False when it was not: the recording has stopped, or
   * stops now - at the hard queue limit (`writer-behind`) or at
   * `maxTotalBytes` (`size-limit`).
   */
  push(kind: RecordKind, line: string): boolean {
    return this.pushBlock([{ kind, line }]);
  }

  /**
   * Queue lines that belong together (a state record split by key, a signal
   * table in chunks, a frame and the controller records it brought, a gap and
   * its resync): all of them, in one part, or none. A rotation the block
   * makes due happens after its last line, so a part never ends inside a
   * block and the next part's preamble never comes between its lines. False
   * when nothing was queued: the recording has stopped, or stops now
   * (`writer-behind`, `size-limit`).
   */
  pushBlock(lines: readonly WriterLine[]): boolean {
    if (this.stopping || this.parts.length === 0) { return false; }
    if (lines.length === 0) { return true; }
    const sizes = lines.map(l => lineBytes(l.line));
    const bytes = sizes.reduce((a, b) => a + b, 0);
    if (this.queuedBytes + bytes > this.q.hardBytes) {
      this.stopOwn({ reason: 'writer-behind', message: 'the disk did not keep up with the recording' });
      return false;
    }
    // Room stays for the stop note and end of every part not yet ended.
    if (this.totalBytes + bytes + this.endReserve() > this.opts.limits.maxTotalBytes) {
      this.stopOwn({ reason: 'size-limit', message: null });
      return false;
    }
    const part = this.last()!;
    lines.forEach((l, i) => { this.append(part, l.line, sizes[i]); });
    part.sincePreamble += lines.length;
    if (!this.rotating && part.bytes >= this.opts.limits.maxFileBytes) { this.rotate(); }
    this.pump();
    return true;
  }

  /**
   * A gap: records were left out here (`writer-behind`: the disk fell
   * behind; `mask-check`: the final masking check refused one). Written with
   * the kinds left out, then the resync lines.
   */
  gap(why: 'writer-behind' | 'mask-check', kinds: Partial<RecordingDropped>): void {
    if (this.stopping) { return; }
    const line = JSON.stringify({
      kind: 'gap', t: this.opts.clock(), why,
      kinds: { call: kinds.call ?? 0, state: kinds.state ?? 0, sub: kinds.sub ?? 0 },
    });
    // The gap and its resync are one block: a part never ends between them.
    this.pushBlock([{ kind: 'gap', line }, ...this.opts.resync('gap')]);
  }

  /**
   * End the recording: a note and the end record (`reason`) go into the last
   * part; resolves once every part is written and closed. Ending again
   * returns the same wait.
   */
  finish(reason: RecordingEndReason): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      this.reason = reason;
      const last = this.last();
      if (last && !last.sealed && !this.broken) { this.endPart(last, reason, null); }
    }
    this.pump();
    return this.whenClosed();
  }

  private last(): Part | undefined { return this.parts[this.parts.length - 1]; }

  /** The bytes kept for the stop notes and end records of the parts not yet ended. */
  private endReserve(): number {
    return this.parts.filter(p => !p.endQueued).length * END_RESERVE_BYTES;
  }

  private newPart(n: number, name: string, header: string): Part {
    const bytes = lineBytes(header);
    this.totalBytes += bytes;
    return {
      n, name, handle: null, queue: [], queuedBytes: 0, bytes, records: 1, sincePreamble: 0,
      dropped: zeroDropped(), sealed: false, endQueued: false, closed: false,
    };
  }

  private append(part: Part, line: string, bytes = lineBytes(line)): void {
    part.queue.push(`${line}\n`);
    part.queuedBytes += bytes;
    part.bytes += bytes;
    part.records++;
    this.queuedBytes += bytes;
    this.totalBytes += bytes;
  }

  /** A note and the end record, then the part takes nothing more. */
  private endPart(
    part: Part, reason: RecordingEndReason, next: string | null,
    at?: { t: number; extras: { masking: RecordingMasking; stats: RecordingStats } },
  ): void {
    const t = at?.t ?? this.opts.clock();
    const note = STOP_NOTES[reason];
    if (note) { this.append(part, JSON.stringify({ kind: 'note', t, text: note })); }
    const extras = at?.extras ?? this.opts.endExtras();
    this.append(part, JSON.stringify({
      kind: 'end', t, reason, records: part.records + 1, bytes: part.bytes, dropped: { ...part.dropped },
      masking: extras.masking, stats: extras.stats, next,
    }));
    part.sealed = true;
    part.endQueued = true;
  }

  private rotate(): void {
    const old = this.last()!;
    const at = { t: this.opts.clock(), extras: this.opts.endExtras() };
    const n = old.n + 1;
    const name = recordingPartName(this.opts.session, n);
    const header = this.opts.header(n, name, old.name);
    const preamble = this.opts.resync('part');
    // The new part's header and preamble, and both parts' ends, must fit in
    // maxTotalBytes; when they cannot, the recording ends here instead.
    const preambleBytes = lineBytes(header) + preamble.reduce((sum, l) => sum + lineBytes(l.line), 0);
    if (this.totalBytes + preambleBytes + 2 * END_RESERVE_BYTES > this.opts.limits.maxTotalBytes) {
      this.stopOwn({ reason: 'size-limit', message: null });
      return;
    }
    old.sealed = true;
    const part = this.newPart(n, name, header);
    this.parts.push(part);
    for (const l of preamble) { this.append(part, l.line); }
    this.rotating = (async () => {
      let stop: WriterStop | null = null;
      try {
        stop = await this.opts.checkBeforePart();
      } catch (e) {
        stop = { reason: 'error', message: `the recordings folder could not be checked (${plainError(e)})` };
      }
      if (!stop && !this.broken) {
        try {
          part.handle = await this.opts.create(name, `${header}\n`);
        } catch (e) {
          stop = { reason: 'error', message: `the next part could not be made (${plainError(e)})` };
        }
      }
      this.rotating = null;
      if (this.broken) {
        // A write failed meanwhile: the recording has stopped; the new part's handle is let go.
        await part.handle?.close().catch(() => {});
        this.pump();
        return;
      }
      if (stop) {
        // The next part is not made: what was queued for it is let go, and
        // the old part ends at T with the reason.
        this.discard(part);
        this.endPart(old, stop.reason, null, at);
        if (this.stopping) {
          this.reason = stop.reason;
          this.problem = stop.message;
        } else {
          this.stopOwn(stop, true);
        }
      } else {
        this.made.push(name);
        this.endPart(old, 'rotated', name, at);
        this.opts.onRotated?.(old.name, name);
      }
      this.pump();
    })();
  }

  /** Let a part that was never made go, with everything queued for it. */
  private discard(part: Part): void {
    this.parts = this.parts.filter(p => p !== part);
    this.queuedBytes -= part.queuedBytes;
    this.totalBytes -= part.bytes;
    part.queue = [];
    part.queuedBytes = 0;
    part.closed = true;
  }

  /** The writer stops the recording by itself: a note and the end go into the last part (unless `ended`). */
  private stopOwn(stop: WriterStop, ended = false): void {
    if (this.stopping) { return; }
    this.stopping = true;
    this.reason = stop.reason;
    this.problem = stop.message;
    const last = this.last();
    if (!ended && last && !last.sealed && !this.broken) { this.endPart(last, stop.reason, null); }
    this.opts.onStop(stop);
    this.pump();
  }

  private pump(): void {
    if (this.pumping) { return; }
    this.pumping = true;
    void this.drain().finally(() => {
      this.pumping = false;
      const next = this.parts.find(p => !p.closed);
      if (next && next.handle && (next.queue.length > 0 || next.endQueued)) {
        this.pump();
        return;
      }
      this.settle();
    });
  }

  /** Write queued lines, oldest part first; a part whose end is written is closed, then the next one goes. */
  private async drain(): Promise<void> {
    for (;;) {
      const part = this.parts.find(p => !p.closed);
      if (!part || !part.handle) { return; }
      if (part.queue.length > 0) {
        let text = '';
        let count = 0;
        while (count < part.queue.length && (count === 0 || text.length < WRITE_BATCH_BYTES)) {
          text += part.queue[count];
          count++;
        }
        const bytes = Buffer.byteLength(text, 'utf8');
        part.queue.splice(0, count);
        try {
          await part.handle.write(text);
        } catch (e) {
          this.writeFailed(e);
          return;
        }
        part.queuedBytes -= bytes;
        this.queuedBytes -= bytes;
        this.afterWrite();
        continue;
      }
      if (part.endQueued) {
        await part.handle.close().catch(() => {});
        part.closed = true;
        continue;
      }
      return;
    }
  }

  /** After a drop: once the queue has drained enough, the gap and a resync. */
  private afterWrite(): void {
    if (!this.dropping || this.stopping || this.queuedBytes >= this.q.resumeBytes) { return; }
    const kinds = this.gapKinds;
    this.gapKinds = zeroDropped();
    this.dropping = false;
    this.gap('writer-behind', kinds);
  }

  /** A write failed: nothing more can go into any part; every handle is closed and the recording stops. */
  private writeFailed(e: unknown): void {
    this.broken = true;
    for (const p of this.parts) {
      if (p.closed) { continue; }
      p.queue = [];
      p.queuedBytes = 0;
      p.closed = true;
      void p.handle?.close().catch(() => {});
    }
    this.queuedBytes = 0;
    const stop: WriterStop = { reason: 'error', message: `a write to the recording failed (${plainError(e)})` };
    if (this.stopping) {
      this.reason = 'error';
      this.problem = stop.message;
    } else {
      this.stopOwn(stop);
    }
  }

  private settle(): void {
    if (!this.stopping || this.rotating) { return; }
    if (this.parts.every(p => p.closed)) {
      const waiting = this.waiters;
      this.waiters = [];
      for (const w of waiting) { w(); }
    }
  }

  private whenClosed(): Promise<void> {
    if (this.stopping && !this.rotating && this.parts.every(p => p.closed)) { return Promise.resolve(); }
    return new Promise(resolve => {
      this.waiters.push(resolve);
      this.pump();
    });
  }
}

/**
 * An error in plain words, without file paths or account names (a status
 * answer reaches every token holder; the daemon's log has the details): the
 * system error code and call when there is one, else the message with every
 * path, account and command line left out.
 *
 * A path may hold spaces (`C:\Users\First Last\...`), so a Windows path
 * (drive or UNC) runs to the next colon - none can be inside one - quote or
 * line end, and a POSIX path to the next colon, quote or line end; a `)`
 * ends either unless a separator follows it (`Program Files (x86)\`). What is
 * left with a backslash in it (`DOMAIN\name`, `DOMAIN\name:(OI)(CI)F`) and
 * any security identifier is an account, and is left out too.
 */
export function plainError(e: unknown): string {
  const err = e as NodeJS.ErrnoException | null;
  if (err && typeof err === 'object' && typeof err.code === 'string' && typeof err.syscall === 'string') {
    return `${err.code} on ${err.syscall}`;
  }
  const text = e instanceof Error ? e.message : String(e);
  return text
    .replace(/'[^'\r\n]*'/g, "'...'")
    .replace(/"[^"\r\n]*"/g, '"..."')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)(?:[^:'"\r\n)]|\)(?=[\\/]))*/g, '<path>')
    .replace(/(^|[\s(=])\/(?:[^:'"\r\n)]|\)(?=\/))*/g, '$1<path>')
    .replace(/[^\s()'",:]*\\[^\s()'",:]*/g, '<account>')
    .replace(/\*?\bS-1-\d+(?:-\d+)+/g, '<account>');
}

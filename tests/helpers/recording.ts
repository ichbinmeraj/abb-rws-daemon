/**
 * Recordings built in memory, for any test that needs one: every line typed
 * as the file format defines it (src/schema/recording.ts), with defaults that
 * pass recording.schema.json strictly, parts that follow one another as the
 * recorder writes them (a rotated `end`, a header naming the previous part),
 * and the JSONL text, as part texts for parseRecording or written to a folder
 * for readRecording. The builder writes what it is told, in the order it is
 * told: it never reorders lines or checks `t`, so a test can also build a
 * recording that is wrong on purpose.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecordingPartText } from '../../src/replay/reader.js';
import { recordingPartName, recordingSessionName } from '../../src/recording/writer.js';
import {
  RECORDING_FORMAT, RECORDING_FORMAT_VERSION,
  type CallRecord, type CallTarget, type ControllerRecord, type EndRecord, type FrameRecord, type GapRecord,
  type IoSignalsChunk, type IoSignalsDiff, type NoteRecord, type RecordingControllerHint, type RecordingHeader,
  type RecordingLine, type RecordingMaskingHeader, type RecordingMaskingRule, type RecordingSource, type StateManagerInfo,
  type StateRecord, type SubRecord,
} from '../../src/schema/recording.js';
import {
  SCHEMA_VERSION,
  type ControllerSnapshot, type DeltaGroups, type GroupError, type RecordingContent, type RecordingDropped,
  type RecordingEndReason, type RecordingLimits, type RecordingMasking, type StreamFrame,
} from '../../src/schema/v0.js';

/** When built recordings begin unless told otherwise. */
export const BUILT_STARTED_AT = '2026-10-04T15:30:12.345Z';

/** The recorder's limits by default (the defaults of RECORDING_LIMIT_DEFAULTS, a short duration). */
export const BUILT_LIMITS: RecordingLimits = {
  maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxDirBytes: 4 * 1024 * 1024 * 1024,
  maxRecordBytes: 1024 * 1024, minFreeBytes: 2 * 1024 * 1024 * 1024, durationS: 190,
};

const ALL_RULES: RecordingMaskingRule[] = ['keys', 'args', 'text', 'rapid', 'values', 'final'];

export interface RecordingBuilderOptions {
  /** The recording's label (part of its name); default none. */
  label?: string | null;
  /** When the recording began; default BUILT_STARTED_AT. */
  startedAt?: string;
  /** The snapshot schema version in the headers and snapshot frames; default the daemon's. */
  schemaVersion?: string;
  /** Default `daemon`. */
  source?: RecordingSource;
  /** Default every kind. */
  content?: RecordingContent[];
  /** The header's controller hints; default none. */
  controllers?: RecordingControllerHint[];
  /** Default BUILT_LIMITS for the daemon, null for a stream capture. */
  limits?: RecordingLimits | null;
  /** The header's masking figures; default every rule, no values. */
  masking?: Partial<RecordingMaskingHeader>;
  daemonVersion?: string;
  clientVersion?: string;
}

/** Frame options shared by every frame kind. */
export interface FrameOptions {
  /** Default: the recording's start plus `t`. */
  observedAt?: string;
  masked?: number;
}

/** What a `call` record says; everything but `method` has a default. */
export interface CallInput {
  target?: CallTarget;
  /** Default `rw7`; null for a setup step. */
  id?: string | null;
  gen?: 'rws1' | 'rws2' | null;
  method: string;
  args?: unknown[] | string;
  /** Default 5. */
  ms?: number;
  /** A result (ok) unless `error` is given. */
  result?: unknown;
  error?: GroupError;
  masked?: number;
}

/** What a `state` record says besides its controller. */
export interface StateInput {
  full?: boolean;
  changed?: Record<string, unknown>;
  manager?: StateManagerInfo;
  ioSignals?: IoSignalsDiff | IoSignalsChunk;
  masked?: number;
}

const zeroDropped = (): RecordingDropped => ({ call: 0, state: 0, sub: 0 });

/** A recording, built line by line in memory. */
export class RecordingBuilder {
  /** The recording's name: its part names without `-p<n>.jsonl`. */
  readonly session: string;
  readonly startedAt: string;
  readonly schemaVersion: string;
  private readonly startedMs: number;
  private readonly parts: RecordingLine[][] = [];
  private readonly ended: boolean[] = [];
  private seq = 0;

  constructor(private readonly opts: RecordingBuilderOptions = {}) {
    this.startedAt = opts.startedAt ?? BUILT_STARTED_AT;
    this.startedMs = Date.parse(this.startedAt);
    this.schemaVersion = opts.schemaVersion ?? SCHEMA_VERSION;
    const prefix = (opts.source ?? 'daemon') === 'stream-capture' ? 'cap-' : 'rec-';
    this.session = prefix + recordingSessionName(new Date(this.startedMs), opts.label ?? null).slice('rec-'.length);
    this.startPart(0, null);
  }

  /** The time `t` ms into the recording, as an ISO string. */
  at(t: number): string { return new Date(this.startedMs + t).toISOString(); }

  /** The current part's number, from 1. */
  get part(): number { return this.parts.length; }

  /** Part `n`'s file name. */
  partName(n: number = this.part): string { return recordingPartName(this.session, n); }

  /** Any line, as given (a test's own or a wrong one). */
  line(line: RecordingLine | Record<string, unknown>): this {
    this.current().push(line as RecordingLine);
    return this;
  }

  snapshot(t: number, controllers: ControllerSnapshot[], o: FrameOptions & { resync?: boolean } = {}): this {
    const frame: StreamFrame = {
      type: 'snapshot', schemaVersion: this.schemaVersion as typeof SCHEMA_VERSION, observedAt: o.observedAt ?? this.at(t), controllers,
    };
    return this.frame(t, frame, o);
  }

  delta(t: number, id: string, groups: DeltaGroups, o: FrameOptions & { name?: string } = {}): this {
    return this.frame(t, { type: 'delta', observedAt: o.observedAt ?? this.at(t), id, name: o.name ?? id.toUpperCase(), groups }, o);
  }

  removed(t: number, id: string, o: FrameOptions = {}): this {
    return this.frame(t, { type: 'removed', observedAt: o.observedAt ?? this.at(t), id }, o);
  }

  /** A frame record around any frame. */
  frame(t: number, frame: StreamFrame, o: { masked?: number; resync?: boolean } = {}): this {
    const rec: FrameRecord = { kind: 'frame', t, frame };
    if (o.masked !== undefined) { rec.masked = o.masked; }
    if (o.resync) { rec.resync = true; }
    return this.line(rec);
  }

  controller(t: number, id: string, facts: Partial<Omit<ControllerRecord, 'kind' | 't' | 'id'>> = {}): this {
    const rec: ControllerRecord = {
      kind: 'controller', t, id, systemId: facts.systemId ?? null, generation: facts.generation ?? null,
      robotWare: facts.robotWare ?? null, identityCheck: facts.identityCheck ?? 'unverified',
    };
    return this.line(rec);
  }

  /** A call that settled at `t`; `seq` counts on across parts. */
  call(t: number, c: CallInput): this {
    const rec: CallRecord = {
      kind: 'call', t, target: c.target ?? 'manager', id: c.id === undefined ? 'rw7' : c.id, gen: c.gen ?? null,
      seq: ++this.seq, method: c.method, args: c.args ?? [], ms: c.ms ?? 5, ok: c.error === undefined,
    };
    if (c.error !== undefined) { rec.error = c.error; } else { rec.result = c.result ?? null; }
    if (c.masked !== undefined) { rec.masked = c.masked; }
    return this.line(rec);
  }

  state(t: number, id: string, s: StateInput): this {
    const rec: StateRecord = { kind: 'state', t, id, ...s };
    return this.line(rec);
  }

  sub(t: number, id: string, event: unknown, masked?: number): this {
    const rec: SubRecord = { kind: 'sub', t, id, event };
    if (masked !== undefined) { rec.masked = masked; }
    return this.line(rec);
  }

  /** Records left out; every kind is written, zeros included, as the writer does. */
  gap(t: number, kinds: Partial<RecordingDropped>, why: GapRecord['why'] = 'writer-behind'): this {
    const rec: GapRecord = { kind: 'gap', t, why, kinds: { ...zeroDropped(), ...kinds } };
    return this.line(rec);
  }

  note(t: number, text: string): this {
    const rec: NoteRecord = { kind: 'note', t, text };
    return this.line(rec);
  }

  /**
   * End the current part at `t` (`rotated`, naming the next) and begin the
   * next one with its header. As the recorder does, the caller then writes
   * the part's resync snapshot, controller records and full state.
   */
  rotate(t: number): this {
    const next = this.partName(this.part + 1);
    this.endPart(t, 'rotated', next);
    this.startPart(t, this.partName());
    return this;
  }

  /** End the last part at `t`. */
  end(t: number, reason: RecordingEndReason = 'stopped', extra: { closeCode?: number; masking?: Partial<RecordingMasking> } = {}): this {
    this.endPart(t, reason, null, extra);
    return this;
  }

  /** Part `n`'s lines (default the current part). */
  lines(n: number = this.part): RecordingLine[] { return [...this.parts[n - 1]]; }

  /** Every line of every part, in order. */
  allLines(): RecordingLine[] { return this.parts.flat(); }

  /** Part `n`'s JSONL text (default the current part). */
  text(n: number = this.part): string { return this.parts[n - 1].map(l => `${JSON.stringify(l)}\n`).join(''); }

  /** Every part as parseRecording takes them. */
  texts(): RecordingPartText[] {
    return this.parts.map((_, i) => ({ name: this.partName(i + 1), text: this.text(i + 1) }));
  }

  /** Write every part into `dir` (made if needed) under its own name; returns the paths in part order. */
  async writeTo(dir: string): Promise<string[]> {
    await mkdir(dir, { recursive: true });
    const paths: string[] = [];
    for (const { name, text } of this.texts()) {
      const path = join(dir, name);
      await writeFile(path, text, { flag: 'wx' });
      paths.push(path);
    }
    return paths;
  }

  private current(): RecordingLine[] {
    const lines = this.parts.at(-1)!;
    if (this.ended[this.parts.length - 1]) { throw new Error(`part ${this.parts.length} has ended; rotate() begins the next`); }
    return lines;
  }

  private startPart(t: number, previous: string | null): void {
    const o = this.opts;
    const capture = (o.source ?? 'daemon') === 'stream-capture';
    const header: RecordingHeader = {
      kind: 'header', format: RECORDING_FORMAT, formatVersion: RECORDING_FORMAT_VERSION, schemaVersion: this.schemaVersion,
      source: o.source ?? 'daemon', session: this.session, part: this.parts.length + 1, previous,
      startedAt: this.at(t), sessionStartedAt: this.startedAt, label: o.label ?? null,
      content: o.content ?? (capture ? ['frames'] : ['frames', 'calls', 'state']),
      daemon: { version: o.daemonVersion ?? '0.1.0-dev' }, client: { version: o.clientVersion ?? (capture ? 'unknown' : '1.4.0') },
      controllers: o.controllers ?? [],
      limits: o.limits !== undefined ? o.limits : capture ? null : { ...BUILT_LIMITS },
      masking: {
        rules: o.masking?.rules ?? (capture ? ALL_RULES.filter(r => r !== 'args') : [...ALL_RULES]),
        values: o.masking?.values ?? 0, derived: o.masking?.derived ?? 0, weakValues: o.masking?.weakValues ?? 0,
      },
    };
    this.parts.push([header]);
    this.ended.push(false);
  }

  private endPart(
    t: number, reason: RecordingEndReason, next: string | null, extra: { closeCode?: number; masking?: Partial<RecordingMasking> } = {},
  ): void {
    const lines = this.current();
    const dropped = zeroDropped();
    for (const l of lines) {
      if (l.kind === 'gap') { for (const k of ['call', 'state', 'sub'] as const) { dropped[k] += l.kinds[k]; } }
    }
    const masked = lines.filter(l => 'masked' in l && typeof l.masked === 'number' && l.masked > 0).length;
    const header = lines[0] as RecordingHeader;
    const rec: EndRecord = {
      kind: 'end', t, reason, records: lines.length + 1,
      bytes: lines.reduce((n, l) => n + Buffer.byteLength(`${JSON.stringify(l)}\n`, 'utf8'), 0),
      dropped,
      masking: {
        values: header.masking.values, derived: header.masking.derived, weakValues: header.masking.weakValues,
        maskedRecords: masked, droppedKeys: 0, refusedLines: 0, ...extra.masking,
      },
      stats: { stateDiffMsMax: 0 }, next,
    };
    if (extra.closeCode !== undefined) { rec.closeCode = extra.closeCode; }
    lines.push(rec);
    this.ended[this.parts.length - 1] = true;
  }
}

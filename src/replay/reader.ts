import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Log } from '../fleet.js';
import { RECORDING_FORMAT, RECORDING_FORMAT_VERSION, type RecordingHeader } from '../schema/recording.js';
import { SCHEMA_VERSION } from '../schema/v0.js';
import { IoTableTimeline, type IoTableAnswer } from './state.js';

/**
 * Reading a recording for a replay: the parts of one recording session, in
 * part order, checked line by line. Frames are kept as text (each is parsed
 * again when it is replayed), with an index of what the on-demand routes
 * answer from: the recorded module source, listing and signal search results,
 * and the client's I/O signal table over time.
 */

/** The most a replay reads, every selected part together (bytes). Equals a recording's default `maxTotalBytes`. */
export const REPLAY_MAX_BYTES = 256 * 1024 * 1024;

/** The recording cannot be replayed (as it is, or with the options given); the message says why, naming files by base name. */
export class ReplayReadError extends Error {}

/** Which parts to replay: `from` to `to` (null: to the last). */
export interface PartRange { from: number; to: number | null }

/**
 * `--replay-parts`: `3` (that part alone), `2-4`, or `3-` (from part 3 to
 * the last). Every part begins with a whole snapshot, so any window replays.
 */
export function parsePartRange(text: string): PartRange {
  const m = /^\s*(\d{1,6})\s*(?:(-)\s*(\d{1,6})?)?\s*$/.exec(text);
  const from = m ? Number(m[1]) : NaN;
  const to = !m ? NaN : m[2] === undefined ? from : m[3] === undefined ? null : Number(m[3]);
  if (!m || from < 1 || (to !== null && to < from)) {
    throw new ReplayReadError(`--replay-parts takes a part or a range of parts (e.g. 3, 2-4 or 3-), not "${text}"`);
  }
  return { from, to };
}

/** One frame record as a replay keeps it. */
export interface ReplayFrame {
  /** When it was captured (ms since the recording began). */
  t: number;
  /** The frame as recorded, as JSON text (`frame` of the record). */
  text: string;
  /** Its `type`; a type this daemon does not know is replayed as recorded. */
  type: string;
  /** A snapshot the recorder took in the middle of a recording (a part's start, after a gap). */
  resync: boolean;
  /** How many values masking changed in it when it was recorded (0: unchanged). */
  masked: number;
}

/** A recorded result of a client read, as the on-demand routes answer from it. */
export interface RecordedCall {
  /** When the call settled (ms since the recording began). */
  t: number;
  ok: boolean;
  /** The result as recorded (masked plain JSON); undefined for a failed call. */
  result: unknown;
}

/** The client reads whose results a replay answers on-demand routes with. */
const INDEXED_METHODS = new Set(['getModuleText', 'listModulesDetailed', 'searchSignals']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Signal search criteria as one key: the fields given, in name order (as the live daemon keys its searches). */
export function criteriaKey(criteria: unknown): string {
  if (!isObj(criteria)) { return 'null'; }
  const given = Object.entries(criteria).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(given);
}

const callKey = (id: string, method: string, args: readonly unknown[]): string =>
  `${id}\u0000${method}\u0000${method === 'searchSignals' ? criteriaKey(args[0]) : JSON.stringify(args)}`;

/** The last entry at or before `at` of a list ordered by `t`; null when none is. */
function lastAtOrBefore<T extends { t: number }>(list: readonly T[] | undefined, at: number): T | null {
  if (!list) { return null; }
  let lo = 0;
  let hi = list.length - 1;
  let found: T | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= at) { found = list[mid]; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

/** What the on-demand routes of a replay answer from. */
export class RecordingIndex {
  /** The client's I/O signal table per controller over time. */
  readonly io = new IoTableTimeline();
  private readonly calls = new Map<string, RecordedCall[]>();
  private readonly ioNames = new Map<string, Set<string>>();

  /** A manager call, in recording order; only the reads the routes answer from are kept. */
  addCall(id: string, method: string, args: readonly unknown[], t: number, ok: boolean, result: unknown): void {
    if (!INDEXED_METHODS.has(method)) { return; }
    const key = callKey(id, method, args);
    let list = this.calls.get(key);
    if (!list) { list = []; this.calls.set(key, list); }
    list.push({ t, ok, result: ok ? result : undefined });
  }

  /** The last call of `method` with these arguments on `id` that settled at or before `at`; null when none did. */
  latestCall(id: string, method: string, args: readonly unknown[], at: number): RecordedCall | null {
    return lastAtOrBefore(this.calls.get(callKey(id, method, args)), at);
  }

  /** The client's I/O signal table of `id` as of `at`. */
  ioTableAt(id: string, at: number): IoTableAnswer { return this.io.at(id, at); }

  /** Every signal name the io group of `id` carried anywhere in the recording. */
  ioSignalNames(id: string): ReadonlySet<string> { return this.ioNames.get(id) ?? new Set(); }

  /** Note what a frame carries that the routes answer from (the io group's signal names). */
  noteFrame(frame: Obj): void {
    const noteIo = (id: unknown, io: unknown): void => {
      if (typeof id !== 'string' || !isObj(io) || !Array.isArray(io.signals)) { return; }
      let names = this.ioNames.get(id);
      if (!names) { names = new Set(); this.ioNames.set(id, names); }
      for (const s of io.signals) { if (isObj(s) && typeof s.name === 'string') { names.add(s.name); } }
    };
    if (frame.type === 'snapshot' && Array.isArray(frame.controllers)) {
      for (const c of frame.controllers) { if (isObj(c)) { noteIo(c.id, c.io); } }
    } else if (frame.type === 'delta' && isObj(frame.groups)) {
      noteIo(frame.id, frame.groups.io);
    }
  }
}

/** A recording, read for a replay. */
export interface Recording {
  /** The first selected part's header. */
  header: RecordingHeader;
  /** The selected parts' file names (base names), in part order. */
  files: string[];
  /** Their part numbers. */
  parts: number[];
  session: string;
  label: string | null;
  source: string;
  /** The snapshot schema version the frames were made with. */
  schemaVersion: string;
  /** When the recording began: `t` counts from here. */
  sessionStartedAt: string;
  sessionStartedAtMs: number;
  /** Every frame, in order; the first is a snapshot. */
  frames: ReplayFrame[];
  index: RecordingIndex;
  /** `gap` records in the selected parts. */
  gaps: number;
  /** Lines skipped: bad lines (`--replay-skip-bad`), the frames dropped after them, malformed records other than frames. */
  skipped: { badLines: number; droppedFrames: number; malformed: number };
}

/** A part as text, named by its base name. */
export interface RecordingPartText { name: string; text: string }

export interface ParseOptions {
  /** Skip a bad line (one that does not parse, or a frame record that is not valid) and the frames after it up to the next snapshot, instead of refusing the recording. */
  skipBad?: boolean;
  log?: Log;
  /** The snapshot schema version this daemon serves (default SCHEMA_VERSION): a recording made with another is served as recorded, with a warning. */
  schemaVersion?: string;
}

export interface ReadOptions extends ParseOptions {
  /** The parts to replay; default every part. */
  parts?: PartRange;
  /** The most the selected parts may hold together; default REPLAY_MAX_BYTES. */
  maxBytes?: number;
}

const SILENT: Log = { debug() {}, info() {}, warn() {}, error() {} };

/** The record kinds of format 1; any other is a later addition and is ignored. */
const KNOWN_KINDS = new Set(['header', 'frame', 'controller', 'call', 'state', 'sub', 'gap', 'note', 'end']);

/** A part's header from its first line; throws ReplayReadError when it is not one this daemon reads. */
export function headerOf(line: string, name: string): RecordingHeader {
  let h: unknown;
  try { h = JSON.parse(line); } catch { h = null; }
  if (!isObj(h) || h.kind !== 'header' || h.format !== RECORDING_FORMAT) {
    throw new ReplayReadError(`${name} is not a recording: its first line is not a recording header`);
  }
  if (h.formatVersion !== RECORDING_FORMAT_VERSION) {
    throw new ReplayReadError(`${name} is recording format ${String(h.formatVersion)}; this daemon reads format ${RECORDING_FORMAT_VERSION}`);
  }
  const problem = typeof h.session !== 'string' || h.session.length === 0 ? 'session'
    : !Number.isInteger(h.part) || (h.part as number) < 1 ? 'part'
      : typeof h.sessionStartedAt !== 'string' || !Number.isFinite(Date.parse(h.sessionStartedAt)) ? 'sessionStartedAt'
        : typeof h.schemaVersion !== 'string' || !/^\d+\.\d+$/.test(h.schemaVersion) ? 'schemaVersion'
          : null;
  if (problem) { throw new ReplayReadError(`${name} has a recording header without a valid ${problem}`); }
  return h as unknown as RecordingHeader;
}

/** Why a frame record cannot be replayed; null when it can. Frame types this daemon does not know pass. */
function frameProblem(rec: Obj): string | null {
  const f = rec.frame;
  if (!isObj(f)) { return 'is a frame record without a frame'; }
  if (typeof f.type !== 'string') { return 'holds a frame without a type'; }
  const known = f.type === 'snapshot' || f.type === 'delta' || f.type === 'removed';
  if (known && typeof f.observedAt !== 'string') { return `holds a ${f.type} frame without observedAt`; }
  if (f.type === 'snapshot' && !(Array.isArray(f.controllers)
    && f.controllers.every(c => isObj(c) && typeof c.id === 'string' && typeof c.name === 'string'))) {
    return 'holds a snapshot frame whose controllers are not valid';
  }
  if (f.type === 'delta' && (typeof f.id !== 'string' || typeof f.name !== 'string' || !isObj(f.groups))) {
    return 'holds a delta frame without an id, a name or groups';
  }
  if (f.type === 'removed' && typeof f.id !== 'string') { return 'holds a removed frame without an id'; }
  return null;
}

/** Whether a record of a known kind other than a frame has what a reader relies on. */
function recordValid(rec: Obj): boolean {
  switch (rec.kind) {
    case 'call':
      return typeof rec.target === 'string' && (rec.id === null || typeof rec.id === 'string') && typeof rec.method === 'string'
        && typeof rec.ok === 'boolean' && (Array.isArray(rec.args) || typeof rec.args === 'string');
    case 'state': return typeof rec.id === 'string' && (rec.changed === undefined || isObj(rec.changed));
    case 'controller': case 'sub': return typeof rec.id === 'string';
    case 'gap': return isObj(rec.kinds);
    case 'note': return typeof rec.text === 'string';
    case 'end': return true;
    default: return false;   // a header where a record belongs
  }
}

/**
 * Read parts already chosen and ordered (one session, part order). Refuses
 * (ReplayReadError): a missing or foreign header, an unknown format version,
 * parts of different sessions, no frame at all, and - unless `skipBad` - a
 * line that does not parse or a frame record that is not valid. A cut last
 * line (a part whose daemon was killed) is ignored; a malformed record other
 * than a frame is skipped, counted and logged once.
 */
export function parseRecording(parts: readonly RecordingPartText[], opts: ParseOptions = {}): Recording {
  const log = opts.log ?? SILENT;
  const skipBad = opts.skipBad ?? false;
  if (parts.length === 0) { throw new ReplayReadError('there is no recording part to replay'); }
  const frames: ReplayFrame[] = [];
  const index = new RecordingIndex();
  const headers: RecordingHeader[] = [];
  let lastT = 0;
  let gaps = 0;
  let skipping = false;
  let badLines = 0;
  let droppedFrames = 0;
  let malformed = 0;
  let firstMalformed: { part: string; line: number } | null = null;
  let clamped = 0;

  const bad = (part: string, line: number, why: string): void => {
    if (!skipBad) {
      throw new ReplayReadError(`line ${line} of ${part} ${why}; replay with --replay-skip-bad to skip such lines`
        + ' and the frames after each up to the next snapshot');
    }
    badLines++;
    skipping = true;
    log.warn({ part, line, problem: why }, 'skipped a bad line of the recording and the frames after it up to the next snapshot');
  };

  for (const part of parts) {
    const lines = part.text.split('\n');
    const closed = part.text.endsWith('\n');
    if (closed) { lines.pop(); }
    const header = headerOf((lines[0] ?? '').replace(/\r$/, ''), part.name);
    const first = headers[0];
    if (first && header.session !== first.session) {
      throw new ReplayReadError(`${part.name} belongs to recording ${header.session}, not ${first.session}`);
    }
    const previous = headers.at(-1);
    if (previous && header.part !== previous.part + 1) {
      log.warn({ part: part.name, after: previous.part }, 'parts of the recording are missing; the replay goes on with the next part');
      index.io.gap(lastT);
    }
    headers.push(header);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
      if (line.trim() === '') { continue; }
      const lineNo = i + 1;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        if (!closed && i === lines.length - 1) {
          log.info({ part: part.name, line: lineNo }, 'the last line of a recording part is cut (the recording was not closed); ignored');
          continue;
        }
        bad(part.name, lineNo, 'is not JSON');
        continue;
      }
      if (!isObj(rec) || typeof rec.kind !== 'string') { bad(part.name, lineNo, 'is not a record'); continue; }
      if (!KNOWN_KINDS.has(rec.kind)) { continue; }   // a later addition to the format
      const timed = typeof rec.t === 'number' && Number.isFinite(rec.t) && rec.t >= 0;
      if (rec.kind === 'frame') {
        const problem = timed ? frameProblem(rec) : 'is a frame record without a valid time';
        if (problem) { bad(part.name, lineNo, problem); continue; }
      } else if (!timed || !recordValid(rec)) {
        malformed++;
        firstMalformed ??= { part: part.name, line: lineNo };
        continue;
      }
      let t = rec.t as number;
      if (t < lastT) { t = lastT; clamped++; }
      lastT = t;

      switch (rec.kind) {
        case 'frame': {
          const frame = rec.frame as Obj;
          const type = frame.type as string;
          if (type === 'snapshot') {
            skipping = false;
          } else if (skipping) {
            droppedFrames++;
            continue;
          } else if (frames.length === 0) {
            bad(part.name, lineNo, `is the first frame but a ${type}, not a snapshot`);
            continue;
          }
          frames.push({
            t, text: JSON.stringify(frame), type, resync: rec.resync === true,
            masked: typeof rec.masked === 'number' ? rec.masked : 0,
          });
          index.noteFrame(frame);
          break;
        }
        case 'call':
          if (rec.target === 'manager' && typeof rec.id === 'string' && Array.isArray(rec.args)) {
            index.addCall(rec.id, rec.method as string, rec.args, t, rec.ok as boolean, rec.result);
          }
          break;
        case 'state':
          index.io.apply({ t, id: rec.id as string, changed: rec.changed as Obj | undefined, ioSignals: rec.ioSignals });
          break;
        case 'gap': {
          gaps++;
          const kinds = rec.kinds as Obj;
          log.warn({ part: part.name, t, why: rec.why, kinds }, 'the recording has a gap: records were left out while it was made');
          if (typeof kinds.state === 'number' && kinds.state > 0) { index.io.gap(t); }
          break;
        }
        default:
          break;
      }
    }
  }

  if (malformed > 0) {
    log.warn({ count: malformed, first: firstMalformed }, 'skipped malformed records of the recording (frames are not among them)');
  }
  if (clamped > 0) {
    log.warn({ count: clamped }, 'records of the recording went back in time; they are replayed in file order');
  }
  if (frames.length === 0) {
    throw new ReplayReadError(badLines > 0
      ? 'the recording holds no frame that could be replayed (every frame was skipped)'
      : 'the recording holds no frames (it was made without frames in its content)');
  }
  const header = headers[0];
  const daemonSchema = opts.schemaVersion ?? SCHEMA_VERSION;
  if (header.schemaVersion !== daemonSchema) {
    log.warn({ recorded: header.schemaVersion, daemon: daemonSchema },
      'the recording was made with another snapshot schema version; it is served as recorded');
  }
  return {
    header,
    files: parts.map(p => p.name),
    parts: headers.map(h => h.part),
    session: header.session,
    label: typeof header.label === 'string' ? header.label : null,
    source: typeof header.source === 'string' ? header.source : 'unknown',
    schemaVersion: header.schemaVersion,
    sessionStartedAt: header.sessionStartedAt,
    sessionStartedAtMs: Date.parse(header.sessionStartedAt),
    frames,
    index,
    gaps,
    skipped: { badLines, droppedFrames, malformed },
  };
}

/** A recording part on disk, with its header. */
interface FoundPart { path: string; name: string; size: number; header: RecordingHeader }

/** The first line of a file (at most 64 KiB); null when it cannot be read. */
async function firstLine(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const end = text.indexOf('\n');
    return (end >= 0 ? text.slice(0, end) : text).replace(/\r$/, '');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Every recording part in a folder (files ending .jsonl whose first line is a header this daemon reads). */
async function partsIn(dir: string): Promise<FoundPart[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new ReplayReadError(`the folder ${basename(dir)} cannot be read`);
  }
  const found: FoundPart[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) { continue; }
    const path = join(dir, e.name);
    const line = await firstLine(path);
    if (line === null) { continue; }
    let header: RecordingHeader;
    try { header = headerOf(line, e.name); } catch { continue; }
    const size = (await stat(path).catch(() => null))?.size;
    if (size !== undefined) { found.push({ path, name: e.name, size, header }); }
  }
  return found;
}

/** Part numbers as short ranges: 1-3, 5. */
function partList(parts: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let j = i;
    while (j + 1 < parts.length && parts[j + 1] === parts[j] + 1) { j++; }
    out.push(j > i ? `${parts[i]}-${parts[j]}` : `${parts[i]}`);
    i = j;
  }
  return out.join(', ');
}

/** A byte count for a message: MiB, or KiB below one MiB. */
const size = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;

/**
 * The parts of the recording `target` names, in part order: a part file (its
 * session's other parts are found beside it), a folder holding one recording,
 * or a recording's name in a folder (`<folder>/rec-...` without the part
 * suffix).
 */
async function findSession(target: string): Promise<{ session: string; parts: FoundPart[] }> {
  const st = await stat(target).catch(() => null);
  let dir: string;
  let session: string;
  let sanitized: boolean | null = null;
  /** The part file named, whatever its name ends in. */
  let named: FoundPart | null = null;
  if (st?.isDirectory()) {
    dir = target;
    const sessions = [...new Set((await partsIn(dir)).map(p => p.header.session))].sort();
    if (sessions.length === 0) { throw new ReplayReadError(`the folder ${basename(target)} holds no recording`); }
    if (sessions.length > 1) {
      throw new ReplayReadError(`the folder ${basename(target)} holds ${sessions.length} recordings (${sessions.join(', ')}); `
        + 'name one: --replay <folder>/<recording>');
    }
    session = sessions[0];
  } else if (st?.isFile()) {
    dir = dirname(target);
    const line = await firstLine(target);
    const header = headerOf(line ?? '', basename(target));
    session = header.session;
    sanitized = header.sanitized === true;
    named = { path: resolve(target), name: basename(target), size: st.size, header };
  } else {
    dir = dirname(target);
    session = basename(target).replace(/\.jsonl$/, '').replace(/-p\d{4,}$/, '');
  }
  const found = await partsIn(dir);
  const given = named;
  if (given && !found.some(p => resolve(p.path) === given.path)) { found.push(given); }
  const parts = found
    .filter(p => p.header.session === session && (sanitized === null || (p.header.sanitized === true) === sanitized))
    .sort((a, b) => a.header.part - b.header.part);
  if (parts.length === 0) { throw new ReplayReadError(`there is no recording ${session} in that folder`); }
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].header.part === parts[i - 1].header.part) {
      throw new ReplayReadError(`${parts[i - 1].name} and ${parts[i].name} are both part ${parts[i].header.part} of ${session}; `
        + 'move one of them out of the folder');
    }
  }
  return { session, parts };
}

/**
 * Read a recording for a replay (`--replay <file-or-folder>`): its parts in
 * order, or the window `parts` picks. Refuses (ReplayReadError) more than
 * `maxBytes` in the selected parts, naming them and suggesting a range, and
 * everything parseRecording refuses.
 */
export async function readRecording(target: string, opts: ReadOptions = {}): Promise<Recording> {
  const { session, parts } = await findSession(target);
  let chosen = parts;
  const range = opts.parts;
  if (range) {
    chosen = parts.filter(p => p.header.part >= range.from && (range.to === null || p.header.part <= range.to));
    if (chosen.length === 0) {
      throw new ReplayReadError(`recording ${session} has no part ${range.from}${range.to === range.from ? '' : `-${range.to ?? ''}`}`
        + ` (it has parts ${partList(parts.map(p => p.header.part))})`);
    }
  }
  const limit = opts.maxBytes ?? REPLAY_MAX_BYTES;
  const total = chosen.reduce((sum, p) => sum + p.size, 0);
  if (total > limit) {
    let fit = 0;
    let sum = 0;
    while (fit < chosen.length && sum + chosen[fit].size <= limit) { sum += chosen[fit].size; fit++; }
    const first = chosen[0].header.part;
    const suggestion = fit === 0 ? '; its first part alone is larger than that and cannot be replayed'
      : `; choose fewer with --replay-parts, e.g. ${fit === 1 ? `${first}` : `${first}-${chosen[fit - 1].header.part}`}`;
    throw new ReplayReadError(`the selected parts of ${session} hold ${size(total)} `
      + `(${chosen.map(p => `${p.name} ${size(p.size)}`).join(', ')}), more than the ${size(limit)} a replay reads${suggestion}`);
  }
  const texts: RecordingPartText[] = [];
  for (const p of chosen) { texts.push({ name: p.name, text: await readFile(p.path, 'utf8') }); }
  return parseRecording(texts, opts);
}

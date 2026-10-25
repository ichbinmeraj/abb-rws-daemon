import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Log } from '../src/fleet.js';
import {
  REPLAY_MAX_BYTES, ReplayReadError, criteriaKey, parsePartRange, parseRecording, readRecording,
} from '../src/replay/reader.js';
import type { RecordingHeader } from '../src/schema/recording.js';
import { SCHEMA_VERSION } from '../src/schema/v0.js';

const START = '2026-10-04T15:30:12.000Z';
const START_MS = Date.parse(START);
const at = (t: number) => new Date(START_MS + t).toISOString();
const SESSION = 'rec-20261004T153012Z-reader';

function header(part = 1, over: Partial<RecordingHeader> & Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'header', format: 'abb-rws-recording', formatVersion: 1, schemaVersion: '0.12', source: 'daemon',
    session: SESSION, part, previous: part > 1 ? `${SESSION}-p${String(part - 1).padStart(4, '0')}.jsonl` : null,
    startedAt: START, sessionStartedAt: START, label: 'reader', content: ['frames', 'calls', 'state'],
    daemon: { version: '0.1.0-dev' }, client: { version: '1.4.0' }, controllers: [{ id: 'rw7', systemId: null, generation: null, robotWare: null }],
    limits: null, masking: { rules: ['keys', 'args', 'text', 'rapid', 'values', 'final'], values: 0, derived: 0, weakValues: 0 },
    ...over,
  };
}

const ctrl = (id: string, speed = 100) => ({
  id, name: id.toUpperCase(), identity: null,
  link: { connected: true, quality: 'live', qualityReason: 'ok', since: at(0), host: '127.0.0.1', port: 9403, useHttps: true,
    subscriptions: { active: true }, identityCheck: { status: 'confirmed', expected: null, actual: null }, reconnect: null },
  panel: { ctrlState: 'motoron', opMode: 'AUTO', speedRatio: speed, collisionDetection: null, asOf: at(0) },
  rapid: { execState: null, cycle: null, tasks: [], asOf: null },
  motion: { watching: false, units: [], rate: { targetHz: null, achievedHz: null, via: null }, asOf: null },
  io: { watching: false, signals: [], asOf: null },
  events: { feed: 'f', lastSeq: 0, recent: [], via: null, clock: { offsetMs: null, measuredAt: null, problem: null }, asOf: null, error: null },
});

const snap = (t: number, extra: Record<string, unknown> = {}) =>
  ({ kind: 'frame', t, frame: { type: 'snapshot', schemaVersion: '0.12', observedAt: at(t), controllers: [ctrl('rw7')] }, ...extra });
const speed = (t: number, s: number) =>
  ({ kind: 'frame', t, frame: { type: 'delta', observedAt: at(t), id: 'rw7', name: 'RW7', groups: { panel: { ...ctrl('rw7', s).panel, asOf: at(t) } } } });
const jsonl = (lines: unknown[], closed = true) => lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (closed ? '\n' : '');
const part = (lines: unknown[], n = 1, closed = true) => ({ name: `${SESSION}-p${String(n).padStart(4, '0')}.jsonl`, text: jsonl([header(n), ...lines], closed) });

function spyLog(): Log & { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('parseRecording: what is kept', () => {
  it('keeps the header facts and every frame as recorded, in order', () => {
    const rec = parseRecording([part([snap(3), speed(10, 50), { kind: 'note', t: 11, text: 'x' }, speed(20, 40)])]);
    expect(rec).toMatchObject({
      session: SESSION, label: 'reader', source: 'daemon', schemaVersion: '0.12', sessionStartedAt: START,
      sessionStartedAtMs: START_MS, files: [`${SESSION}-p0001.jsonl`], parts: [1], gaps: 0,
      skipped: { badLines: 0, droppedFrames: 0, malformed: 0 },
    });
    expect(rec.frames.map(f => [f.t, f.type])).toEqual([[3, 'snapshot'], [10, 'delta'], [20, 'delta']]);
    expect(rec.frames[1].text).toBe(JSON.stringify(speed(10, 50).frame));
  });

  it('keeps resync and masked markers, and frame types it does not know', () => {
    const rec = parseRecording([part([snap(0), { kind: 'frame', t: 5, frame: { type: 'later-kind', x: 1 } }, snap(9, { resync: true, masked: 2 })])]);
    expect(rec.frames.map(f => [f.type, f.resync, f.masked])).toEqual([['snapshot', false, 0], ['later-kind', false, 0], ['snapshot', true, 2]]);
  });

  it('ignores record kinds and fields it does not know', () => {
    const rec = parseRecording([part([snap(0), { kind: 'telemetry', t: 1, x: 2 }, { ...speed(2, 10), extra: true }])]);
    expect(rec.frames).toHaveLength(2);
    expect(rec.skipped.malformed).toBe(0);
  });

  it('indexes call results by controller, method and arguments; a search by its criteria in any order', () => {
    const rec = parseRecording([part([
      snap(0),
      { kind: 'call', t: 100, target: 'manager', id: 'rw7', gen: 'rws2', seq: 1, method: 'getModuleText', args: ['T_ROB1', 'Main'], ms: 9, ok: true, result: { text: 'v1', changeCount: 1 } },
      { kind: 'call', t: 300, target: 'manager', id: 'rw7', gen: 'rws2', seq: 2, method: 'getModuleText', args: ['T_ROB1', 'Main'], ms: 9, ok: true, result: { text: 'v2', changeCount: 2 } },
      { kind: 'call', t: 400, target: 'manager', id: 'rw7', gen: 'rws2', seq: 3, method: 'searchSignals', args: [{ type: 'DO', name: 'do1' }], ms: 9, ok: true, result: [{ name: 'do1' }] },
      { kind: 'call', t: 500, target: 'manager', id: 'rw7', gen: 'rws2', seq: 4, method: 'getJointTargetFull', args: ['ROB_1'], ms: 9, ok: true, result: {} },
      { kind: 'call', t: 600, target: 'setup', id: null, gen: null, seq: 5, method: 'getModuleText', args: ['T_ROB1', 'Main'], ms: 9, ok: true, result: { text: 'no' } },
    ])]);
    expect(rec.index.latestCall('rw7', 'getModuleText', ['T_ROB1', 'Main'], 99)).toBeNull();
    expect(rec.index.latestCall('rw7', 'getModuleText', ['T_ROB1', 'Main'], 299)?.result).toEqual({ text: 'v1', changeCount: 1 });
    expect(rec.index.latestCall('rw7', 'getModuleText', ['T_ROB1', 'Main'], 10_000)?.result).toEqual({ text: 'v2', changeCount: 2 });
    expect(rec.index.latestCall('rw7', 'searchSignals', [{ name: 'do1', type: 'DO' }], 400)?.result).toEqual([{ name: 'do1' }]);
    expect(rec.index.latestCall('rw7', 'getJointTargetFull', ['ROB_1'], 10_000)).toBeNull();
    expect(criteriaKey({ b: '1', a: '2', c: undefined })).toBe(criteriaKey({ a: '2', b: '1' }));
  });

  it('logs every gap with its kinds, counts it, and warns when the schema version differs', () => {
    const log = spyLog();
    const rec = parseRecording([part([snap(0), { kind: 'gap', t: 50, why: 'writer-behind', kinds: { call: 3, state: 1, sub: 0 } }, snap(51, { resync: true })])],
      { log, schemaVersion: '0.13' });
    expect(rec.gaps).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ why: 'writer-behind', kinds: { call: 3, state: 1, sub: 0 } }), expect.stringContaining('gap'));
    expect(log.warn).toHaveBeenCalledWith({ recorded: '0.12', daemon: '0.13' }, expect.stringContaining('another snapshot schema'));
  });

  it('compares with the daemon`s own schema version unless told another: an older recording is warned about, one of its own is not', () => {
    const older = spyLog();
    const rec = parseRecording([part([snap(0)])], { log: older });
    expect(rec.schemaVersion).toBe('0.12');
    expect(older.warn).toHaveBeenCalledTimes(1);
    expect(older.warn).toHaveBeenCalledWith({ recorded: '0.12', daemon: SCHEMA_VERSION }, expect.stringContaining('served as recorded'));
    const own = spyLog();
    const text = jsonl([header(1, { schemaVersion: SCHEMA_VERSION }), snap(0)]);
    expect(parseRecording([{ name: `${SESSION}-p0001.jsonl`, text }], { log: own }).schemaVersion).toBe(SCHEMA_VERSION);
    expect(own.warn).not.toHaveBeenCalled();
  });

  it('replays records that went back in time in file order, with one warning', () => {
    const log = spyLog();
    // Read as the version it was made with, so the one warning is the one about time.
    const rec = parseRecording([part([snap(10), speed(30, 1), speed(20, 2)])], { log, schemaVersion: '0.12' });
    expect(rec.frames.map(f => f.t)).toEqual([10, 30, 30]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('parseRecording: what it refuses', () => {
  const refused = (parts: Array<{ name: string; text: string }>, pattern: RegExp) => {
    expect(() => parseRecording(parts)).toThrow(ReplayReadError);
    expect(() => parseRecording(parts)).toThrow(pattern);
  };

  it('a missing or foreign header, an unknown format version, a header without its facts', () => {
    refused([{ name: 'a.jsonl', text: jsonl([snap(0)]) }], /a\.jsonl is not a recording/);
    refused([{ name: 'a.jsonl', text: jsonl([header(1, { format: 'other-format' }), snap(0)]) }], /not a recording/);
    refused([{ name: 'a.jsonl', text: jsonl([header(1, { formatVersion: 2 }), snap(0)]) }], /format 2; this daemon reads format 1/);
    refused([{ name: 'a.jsonl', text: jsonl([header(1, { sessionStartedAt: 'yesterday' }), snap(0)]) }], /sessionStartedAt/);
    refused([{ name: 'a.jsonl', text: jsonl([header(1, { schemaVersion: 'unknown' }), snap(0)]) }], /without a valid schemaVersion/);
    refused([{ name: 'a.jsonl', text: '' }], /not a recording/);
  });

  it('a recording without frames, and parts of two recordings', () => {
    refused([part([{ kind: 'state', t: 1, id: 'rw7', full: true, changed: {} }])], /holds no frames/);
    refused([part([snap(0)], 1), { name: 'other-p0002.jsonl', text: jsonl([header(2, { session: 'other' }), snap(1)]) }], /belongs to recording other/);
  });

  it('a line that does not parse, naming the line and the part; with skipBad it and the frames after it up to the next snapshot are skipped', () => {
    const lines = [snap(0), speed(10, 90), '{"kind":"frame","t":20,"fra', speed(30, 70), speed(40, 60), snap(50, { resync: true }), speed(60, 50)];
    refused([part(lines)], /line 4 of rec-20261004T153012Z-reader-p0001\.jsonl is not JSON; replay with --replay-skip-bad/);
    const log = spyLog();
    const rec = parseRecording([part(lines)], { skipBad: true, log });
    expect(rec.frames.map(f => f.t)).toEqual([0, 10, 50, 60]);
    expect(rec.skipped).toEqual({ badLines: 1, droppedFrames: 2, malformed: 0 });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ line: 4, problem: 'is not JSON' }), expect.stringContaining('skipped a bad line'));
  });

  it('a frame record that does not validate; with skipBad, skipped to the next snapshot, each skip logged', () => {
    const noGroups = { kind: 'frame', t: 20, frame: { type: 'delta', observedAt: at(20), id: 'rw7', name: 'RW7' } };
    const noTime = { kind: 'frame', frame: speed(0, 1).frame };
    const badSnapshot = { kind: 'frame', t: 40, frame: { type: 'snapshot', schemaVersion: '0.12', observedAt: at(40), controllers: [{ name: 'x' }] } };
    refused([part([snap(0), noGroups])], /line 3 .* holds a delta frame without an id, a name or groups/);
    refused([part([snap(0), noTime])], /line 3 .* without a valid time/);
    refused([part([snap(0), badSnapshot])], /controllers are not valid/);
    refused([part([snap(0), { kind: 'frame', t: 5, frame: 'text' }])], /without a frame/);
    refused([part([snap(0), ['not', 'a', 'record']])], /is not a record/);
    const log = spyLog();
    const rec = parseRecording([part([snap(0), noGroups, speed(30, 1), badSnapshot, speed(45, 2), snap(50, { resync: true })])],
      { skipBad: true, log, schemaVersion: '0.12' });
    expect(rec.frames.map(f => f.t)).toEqual([0, 50]);
    expect(rec.skipped.badLines).toBe(2);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('a first frame that is not a snapshot', () => {
    refused([part([speed(0, 1), snap(5)])], /is the first frame but a delta, not a snapshot/);
    const rec = parseRecording([part([speed(0, 1), speed(2, 3), snap(5), speed(6, 7)])], { skipBad: true });
    expect(rec.frames.map(f => f.t)).toEqual([5, 6]);
  });

  it('every frame skipped leaves nothing to replay', () => {
    expect(() => parseRecording([part([speed(0, 1)])], { skipBad: true })).toThrow(/every frame was skipped/);
  });
});

describe('parseRecording: lines it tolerates', () => {
  it('a cut last line (the daemon was killed) is ignored, with a note in the log', () => {
    const log = spyLog();
    const text = jsonl([header(1), snap(0), speed(10, 5)]) + '{"kind":"frame","t":20,"frame":{"type":"del';
    const rec = parseRecording([{ name: 'p.jsonl', text }], { log });
    expect(rec.frames.map(f => f.t)).toEqual([0, 10]);
    expect(log.info).toHaveBeenCalledWith({ part: 'p.jsonl', line: 4 }, expect.stringContaining('cut'));
    // A whole last line without its newline is a line like any other.
    expect(parseRecording([part([snap(0), speed(10, 5)], 1, false)]).frames).toHaveLength(2);
  });

  it('a malformed record other than a frame is skipped, counted and logged once; blank lines and CRLF pass', () => {
    const log = spyLog();
    const lines = [
      snap(0),
      { kind: 'call', t: 5, target: 'manager', id: 'rw7', ok: true, args: [] },          // no method
      { kind: 'state', t: 6, changed: {} },                                                // no id
      { kind: 'note', t: 'soon', text: 'x' },                                              // no time
      { kind: 'header', t: 7 },                                                            // a header where a record belongs
      '',
      speed(10, 1),
    ];
    const text = jsonl([header(1), ...lines]).replace(/\n/g, '\r\n');
    const rec = parseRecording([{ name: 'p.jsonl', text }], { log, schemaVersion: '0.12' });
    expect(rec.frames).toHaveLength(2);
    expect(rec.skipped.malformed).toBe(4);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({ count: 4, first: { part: 'p.jsonl', line: 3 } }, expect.stringContaining('malformed'));
  });
});

describe('parsePartRange', () => {
  it('a part, a range, or from a part to the last', () => {
    expect(parsePartRange('3')).toEqual({ from: 3, to: 3 });
    expect(parsePartRange('2-4')).toEqual({ from: 2, to: 4 });
    expect(parsePartRange(' 3- ')).toEqual({ from: 3, to: null });
    for (const bad of ['', '0', '4-2', 'a', '1-2-3', '-2']) { expect(() => parsePartRange(bad), bad).toThrow(ReplayReadError); }
  });
});

describe('readRecording: finding the parts on disk', () => {
  let root: string;
  let dir: string;
  const name = (n: number) => `${SESSION}-p${String(n).padStart(4, '0')}.jsonl`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'replay-reader-'));
    dir = join(root, 'recordings');
    await mkdir(dir);
    // Three parts, written out of order; each begins with a resync snapshot but the first.
    await writeFile(join(dir, name(2)), jsonl([header(2), snap(1000, { resync: true }), speed(1500, 20)]));
    await writeFile(join(dir, name(1)), jsonl([header(1), snap(0), speed(500, 10)]));
    await writeFile(join(dir, name(3)), jsonl([header(3), snap(2000, { resync: true }), speed(2500, 30)]));
    await writeFile(join(dir, 'notes.jsonl'), '{"not":"a recording"}\n');
    await writeFile(join(dir, 'README.txt'), 'private\n');
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('a part file: every part of its recording, in part order', async () => {
    const rec = await readRecording(join(dir, name(2)));
    expect(rec.files).toEqual([name(1), name(2), name(3)]);
    expect(rec.parts).toEqual([1, 2, 3]);
    expect(rec.frames.map(f => f.t)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
  });

  it('the folder, or the recording by name', async () => {
    expect((await readRecording(dir)).parts).toEqual([1, 2, 3]);
    expect((await readRecording(join(dir, SESSION))).parts).toEqual([1, 2, 3]);
  });

  it('a window of parts starts at that part\'s snapshot', async () => {
    const window = await readRecording(dir, { parts: parsePartRange('2-3') });
    expect(window.parts).toEqual([2, 3]);
    expect(window.frames[0]).toMatchObject({ t: 1000, type: 'snapshot', resync: true });
    expect((await readRecording(dir, { parts: parsePartRange('2') })).parts).toEqual([2]);
    expect((await readRecording(dir, { parts: parsePartRange('2-') })).parts).toEqual([2, 3]);
    await expect(readRecording(dir, { parts: parsePartRange('5-6') })).rejects.toThrow(/has no part 5-6 \(it has parts 1-3\)/);
  });

  it('more than the replay reads: refused, naming every selected part and suggesting a range', async () => {
    const sizes = await Promise.all([1, 2].map(async n => (await stat(join(dir, name(n)))).size));
    const err: unknown = await readRecording(dir, { maxBytes: sizes[0] + sizes[1] + 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplayReadError);
    const { message } = err as ReplayReadError;
    for (const n of [1, 2, 3]) { expect(message).toMatch(new RegExp(`${name(n).replace(/\./g, '\\.')} \\d+\\.\\d KiB`)); }
    expect(message).toMatch(/more than the \d+\.\d KiB a replay reads; choose fewer with --replay-parts, e\.g\. 1-2$/);
    await expect(readRecording(dir, { maxBytes: 10 })).rejects.toThrow(/first part alone is larger/);
    expect(REPLAY_MAX_BYTES).toBe(256 * 1024 * 1024);
  });

  it('refuses a folder with two recordings, a duplicate part, a foreign file, and nothing at all', async () => {
    const two = join(root, 'two');
    await mkdir(two);
    await writeFile(join(two, 'a-p0001.jsonl'), jsonl([header(1, { session: 'rec-a' }), snap(0)]));
    await writeFile(join(two, 'b-p0001.jsonl'), jsonl([header(1, { session: 'rec-b' }), snap(0)]));
    await expect(readRecording(two)).rejects.toThrow(/holds 2 recordings \(rec-a, rec-b\)/);
    await writeFile(join(two, 'a-copy-p0001.jsonl'), jsonl([header(1, { session: 'rec-a' }), snap(0)]));
    await expect(readRecording(join(two, 'a-p0001.jsonl'))).rejects.toThrow(/are both part 1 of rec-a/);
    await expect(readRecording(join(dir, 'notes.jsonl'))).rejects.toThrow(/notes\.jsonl is not a recording/);
    await expect(readRecording(join(root, 'nothing-here'))).rejects.toThrow(ReplayReadError);
    const empty = join(root, 'empty');
    await mkdir(empty);
    await expect(readRecording(empty)).rejects.toThrow(/holds no recording/);
  });

  it('a sanitized copy beside the recording is a recording of its own', async () => {
    const both = join(root, 'both');
    await mkdir(both);
    await writeFile(join(both, 'r-p0001.jsonl'), jsonl([header(1), snap(0)]));
    await writeFile(join(both, 'r-sanitized-p0001.jsonl'), jsonl([header(1, { sanitized: true }), snap(0), speed(5, 1)]));
    expect((await readRecording(join(both, 'r-sanitized-p0001.jsonl'))).frames).toHaveLength(2);
    expect((await readRecording(join(both, 'r-p0001.jsonl'))).frames).toHaveLength(1);
  });

  it('a part file named otherwise (a capture, say) is read all the same', async () => {
    const other = join(root, 'other');
    await mkdir(other);
    await writeFile(join(other, 'capture-live.txt'), jsonl([header(1, { session: 'cap-1', source: 'stream-capture' }), snap(0), speed(5, 1)]));
    const rec = await readRecording(join(other, 'capture-live.txt'));
    expect(rec).toMatchObject({ files: ['capture-live.txt'], source: 'stream-capture', session: 'cap-1' });
  });

  it('a missing part in the middle is replayed past, with a warning', async () => {
    const holes = join(root, 'holes');
    await mkdir(holes);
    await writeFile(join(holes, 'h-p0001.jsonl'), jsonl([header(1), snap(0)]));
    await writeFile(join(holes, 'h-p0003.jsonl'), jsonl([header(3), snap(2000, { resync: true })]));
    const log = spyLog();
    const rec = await readRecording(holes, { log });
    expect(rec.parts).toEqual([1, 3]);
    expect(log.warn).toHaveBeenCalledWith({ part: 'h-p0003.jsonl', after: 1 }, expect.stringContaining('missing'));
  });
});

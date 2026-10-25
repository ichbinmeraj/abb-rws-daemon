import { describe, it, expect } from 'vitest';
import { RecordingBoundsError, RecordingFailedError } from '../src/recording/contract.js';
import { Recorder, planRecording } from '../src/recording/recorder.js';
import {
  RECORDING_LIMIT_BOUNDS, RECORDING_LIMIT_DEFAULTS, RecordingWriter, freeDiskBytes, limitsProblem, plainError,
  recordingFolderBytes, recordingPartName, recordingSessionName, splitRecordingLines, tightenLimits,
  type RecordingWriterOptions, type WriterStop,
} from '../src/recording/writer.js';
import type { RecordingLimits } from '../src/schema/v0.js';
import {
  FakeFrameObserver, MemoryFiles, MemoryLog, ManualClock, ManualTimers, parseJsonl, settle, snapshotOf,
} from './helpers/recording-fakes.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const SESSION = 'rec-20261004T153012Z-test';
const zeroMasking = { values: 0, derived: 0, weakValues: 0, maskedRecords: 0, droppedKeys: 0, refusedLines: 0 };

/** A writer over in-memory parts, with a clock the test moves and a resync that says when it was made. */
function harness(limits: Partial<RecordingLimits> = {}, over: Partial<RecordingWriterOptions> = {}) {
  const files = new MemoryFiles();
  const stops: WriterStop[] = [];
  const dropped: string[] = [];
  const resyncs: Array<{ cause: string; t: number }> = [];
  const order: string[] = [];
  let t = 0;
  const writer = new RecordingWriter({
    session: SESSION,
    limits: { ...RECORDING_LIMIT_DEFAULTS, ...limits },
    clock: () => t,
    create: async (name, header) => {
      const h = await files.create(name, header);
      order.push(`create ${name}`);
      return {
        ...h,
        write: async (data: string) => { const r = await h.write(data); order.push(`write ${name}`); return r; },
        close: async () => { await h.close(); order.push(`close ${name}`); },
      };
    },
    checkBeforePart: async () => null,
    header: (part, name, previous) => JSON.stringify({ kind: 'header', t, part, name, previous }),
    resync: cause => {
      resyncs.push({ cause, t });
      return [{ kind: 'frame', line: JSON.stringify({ kind: 'frame', t, resync: true, frame: { type: 'snapshot' } }) }];
    },
    endExtras: () => ({ masking: zeroMasking, stats: { stateDiffMsMax: 0 } }),
    onStop: s => { stops.push(s); },
    onStateDropped: id => { dropped.push(id); },
    ...over,
  });
  return { writer, files, stops, dropped, resyncs, order, at: (ms: number) => { t = ms; } };
}

const line = (kind: string, t: number, extra: Record<string, unknown> = {}): string => JSON.stringify({ kind, t, ...extra });
const pad = (n: number): string => 'x'.repeat(n);

describe('limits and bounds', () => {
  it('has the documented defaults, every one within its bounds', () => {
    expect(RECORDING_LIMIT_DEFAULTS).toEqual({
      maxFileBytes: 64 * MIB, maxTotalBytes: 256 * MIB, maxDirBytes: 4 * GIB, maxRecordBytes: MIB, minFreeBytes: 2 * GIB, durationS: 3600,
    });
    expect(limitsProblem(RECORDING_LIMIT_DEFAULTS)).toBeNull();
    expect(RECORDING_LIMIT_BOUNDS.maxFileBytes).toEqual({ min: MIB, max: 256 * MIB });
    expect(RECORDING_LIMIT_BOUNDS.maxTotalBytes.max).toBe(8 * GIB);
    expect(RECORDING_LIMIT_BOUNDS.maxDirBytes.max).toBe(64 * GIB);
    expect(RECORDING_LIMIT_BOUNDS.minFreeBytes.min).toBe(GIB);
    expect(RECORDING_LIMIT_BOUNDS.maxRecordBytes).toEqual({ min: 64 * 1024, max: 4 * MIB });
    expect(RECORDING_LIMIT_BOUNDS.durationS).toEqual({ min: 1, max: 86400 });
  });

  it('names a limit outside its bounds, or not a whole number', () => {
    expect(limitsProblem({ maxFileBytes: MIB - 1 })).toMatch(/maxFileBytes/);
    expect(limitsProblem({ maxFileBytes: 257 * MIB })).toMatch(/maxFileBytes/);
    expect(limitsProblem({ durationS: 1.5 })).toMatch(/durationS/);
    expect(limitsProblem({ minFreeBytes: GIB - 1 })).toMatch(/minFreeBytes/);
    expect(limitsProblem({ other: 1 })).toMatch(/not a recording limit/);
    expect(limitsProblem({ maxDirBytes: 64 * GIB, durationS: 86400 })).toBeNull();
  });

  it('a start request only tightens: smaller max and duration, larger free-space floor', () => {
    const base: RecordingLimits = { ...RECORDING_LIMIT_DEFAULTS, maxFileBytes: 8 * MIB, durationS: 600 };
    expect(tightenLimits(base, { maxFileBytes: 32 * MIB, maxTotalBytes: 16 * MIB, minFreeBytes: GIB, maxRecordBytes: 128 * 1024 }, 1200))
      .toEqual({ ...base, maxFileBytes: 8 * MIB, maxTotalBytes: 16 * MIB, minFreeBytes: 2 * GIB, maxRecordBytes: 128 * 1024, durationS: 600 });
    expect(tightenLimits(base, { minFreeBytes: 3 * GIB }, 30)).toEqual({ ...base, minFreeBytes: 3 * GIB, durationS: 30 });
    expect(tightenLimits(base, undefined)).toEqual(base);
  });

  it('refuses a request value outside the bounds (400), even one that would tighten nothing', () => {
    const base = { ...RECORDING_LIMIT_DEFAULTS };
    expect(() => tightenLimits(base, { maxFileBytes: 300 * MIB })).toThrow(RecordingBoundsError);
    expect(() => tightenLimits(base, { maxTotalBytes: 10 })).toThrow(RecordingBoundsError);
    expect(() => tightenLimits(base, {}, 0)).toThrow(RecordingBoundsError);
    expect(() => tightenLimits(base, {}, 86401)).toThrow(RecordingBoundsError);
    expect(() => tightenLimits(base, { durationS: 5 } as never)).toThrow(RecordingBoundsError);
  });

  it('checks a start request: label, content, fields', () => {
    const base = { ...RECORDING_LIMIT_DEFAULTS };
    expect(planRecording(base, {})).toEqual({ label: null, content: ['frames', 'calls', 'state'], limits: base });
    expect(planRecording(base, { label: 'live-3min', content: ['state', 'frames', 'state'], durationS: 190 }))
      .toEqual({ label: 'live-3min', content: ['frames', 'state'], limits: { ...base, durationS: 190 } });
    expect(() => planRecording(base, { label: 'Live' })).toThrow(RecordingBoundsError);
    expect(() => planRecording(base, { label: 'a'.repeat(33) })).toThrow(RecordingBoundsError);
    expect(() => planRecording(base, { label: '../x' })).toThrow(RecordingBoundsError);
    expect(() => planRecording(base, { content: [] })).toThrow(RecordingBoundsError);
    expect(() => planRecording(base, { content: ['frames', 'wire'] as never })).toThrow(RecordingBoundsError);
    expect(() => planRecording(base, { record: true } as never)).toThrow(RecordingBoundsError);
  });
});

describe('names, folder size and free space', () => {
  it('names a recording and its parts', () => {
    const at = new Date('2026-10-04T15:30:12.345Z');
    expect(recordingSessionName(at, 'live-3min')).toBe('rec-20261004T153012Z-live-3min');
    expect(recordingSessionName(at, null)).toBe('rec-20261004T153012Z');
    expect(recordingPartName('rec-20261004T153012Z', 1)).toBe('rec-20261004T153012Z-p0001.jsonl');
    expect(recordingPartName('rec-20261004T153012Z', 12)).toBe('rec-20261004T153012Z-p0012.jsonl');
  });

  it('counts every recording part in the folder, and nothing else', async () => {
    const sizes: Record<string, number> = { 'rec-a-p0001.jsonl': 100, 'rec-b-p0002.jsonl': 50, 'README.txt': 1000, '.gitignore': 2, 'other.jsonl': 7 };
    const bytes = await recordingFolderBytes('dir', {
      readdir: async () => Object.keys(sizes),
      size: async p => sizes[p.split(/[\\/]/).pop()!]!,
    });
    expect(bytes).toBe(150);
  });

  it('reads free space from statfs, numbers or bigints', async () => {
    expect(await freeDiskBytes('d', { statfs: async () => ({ bavail: 10, bsize: 4096 }) })).toBe(40960);
    expect(await freeDiskBytes('d', { statfs: async () => ({ bavail: 3n, bsize: 1024n }) })).toBe(3072);
  });
});

describe('the writer', () => {
  it('writes through the part handle: header, records, a note and the end with its counts', async () => {
    const h = harness();
    await h.writer.open();
    h.at(5);
    expect(h.writer.push('frame', line('frame', 5, { frame: { type: 'snapshot' } }))).toBe(true);
    h.at(9);
    expect(h.writer.push('call', line('call', 9))).toBe(true);
    h.at(20);
    await h.writer.finish('stopped');
    const text = h.files.files.get(`${SESSION}-p0001.jsonl`)!.text;
    const lines = parseJsonl(text);
    expect(lines.map(l => l.kind)).toEqual(['header', 'frame', 'call', 'note', 'end']);
    const end = lines[4]!;
    expect(end).toMatchObject({ kind: 'end', t: 20, reason: 'stopped', records: 5, dropped: { call: 0, state: 0, sub: 0 }, next: null });
    const endLine = text.trimEnd().split('\n').pop()!;
    expect(end.bytes).toBe(Buffer.byteLength(text) - Buffer.byteLength(endLine) - 1);
    expect(lines[3]).toEqual({ kind: 'note', t: 20, text: 'recording stopped: asked to stop' });
    expect(h.files.files.get(`${SESSION}-p0001.jsonl`)!.closed).toBe(true);
    expect(h.writer.files).toEqual([`${SESSION}-p0001.jsonl`]);
    expect(h.writer.bytes).toBe(Buffer.byteLength(text));
    expect(h.writer.records).toBe(5);
    expect(h.writer.push('frame', line('frame', 30))).toBe(false);
  });

  it('rotates at maxFileBytes: records up to T stay, the old end is stamped T, the new part starts with its header and resync from T', async () => {
    const h = harness({ maxFileBytes: 2000 });
    await h.writer.open();
    let t = 0;
    while (h.writer.files.length < 2) {
      t += 10;
      h.at(t);
      h.writer.push('frame', line('frame', t, { pad: pad(300) }));
      if (h.resyncs.length > 0) { break; }
    }
    const T = t;
    expect(h.resyncs).toEqual([{ cause: 'part', t: T }]);
    h.at(T + 5);
    h.writer.push('call', line('call', T + 5));
    await settle();
    expect(h.writer.files).toEqual([`${SESSION}-p0001.jsonl`, `${SESSION}-p0002.jsonl`]);
    const p1 = parseJsonl(h.files.files.get(`${SESSION}-p0001.jsonl`)!.text);
    const p2 = parseJsonl(h.files.files.get(`${SESSION}-p0002.jsonl`)!.text);
    expect(p1.at(-1)).toMatchObject({ kind: 'end', t: T, reason: 'rotated', next: `${SESSION}-p0002.jsonl` });
    expect(p1.filter(l => l.kind === 'frame').every(l => (l.t as number) <= T)).toBe(true);
    expect(p2.map(l => l.kind)).toEqual(['header', 'frame', 'call']);
    expect(p2[0]).toMatchObject({ part: 2, previous: `${SESSION}-p0001.jsonl`, t: T });
    expect(p2[1]).toMatchObject({ resync: true, t: T });
    expect(p2[2]).toMatchObject({ t: T + 5 });
    // The old part is closed before anything is written to the new one.
    const closeOld = h.order.indexOf(`close ${SESSION}-p0001.jsonl`);
    const firstNew = h.order.indexOf(`write ${SESSION}-p0002.jsonl`);
    expect(closeOld).toBeGreaterThanOrEqual(0);
    expect(firstNew).toBeGreaterThan(closeOld);
    await h.writer.finish('stopped');
  });

  it('ends the old part with the reason and stops when the next part cannot be made', async () => {
    const h = harness({ maxFileBytes: 1000 });
    h.files.failCreateAfter = 1;
    await h.writer.open();
    for (let i = 1; h.writer.active && i < 20; i++) { h.at(i); h.writer.push('frame', line('frame', i, { pad: pad(300) })); }
    await settle();
    expect(h.stops).toHaveLength(1);
    expect(h.stops[0]!.reason).toBe('error');
    expect(h.stops[0]!.message).not.toMatch(/rec-2026/);
    await h.writer.finish('stopped');
    const p1 = parseJsonl(h.files.files.get(`${SESSION}-p0001.jsonl`)!.text);
    expect(p1.at(-1)).toMatchObject({ kind: 'end', reason: 'error', next: null });
    expect(h.files.files.size).toBe(1);
    expect(h.writer.endReason).toBe('error');
  });

  it('stops with dir-limit or disk-space when the folder check before the next part says so', async () => {
    for (const reason of ['dir-limit', 'disk-space'] as const) {
      const h = harness({ maxFileBytes: 1000 }, { checkBeforePart: async () => ({ reason, message: null }) });
      await h.writer.open();
      for (let i = 1; h.writer.active && i < 20; i++) { h.writer.push('frame', line('frame', i, { pad: pad(300) })); }
      await settle();
      expect(h.stops.map(s => s.reason)).toEqual([reason]);
      await h.writer.finish('stopped');
      const p1 = parseJsonl(h.files.files.get(`${SESSION}-p0001.jsonl`)!.text);
      expect(p1.slice(-2).map(l => l.kind)).toEqual(['note', 'end']);
      expect(p1.at(-1)).toMatchObject({ reason });
      expect(h.writer.endReason).toBe(reason);
    }
  });

  it('a stop asked for while the next part is being made: the old part ends with the folder check reason', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ maxFileBytes: 1000 }, { checkBeforePart: async () => { await gate; return { reason: 'dir-limit', message: 'full' }; } });
    await h.writer.open();
    for (let i = 1; h.resyncs.length === 0; i++) { h.writer.push('frame', line('frame', i, { pad: pad(300) })); }
    const done = h.writer.finish('stopped');
    release();
    await done;
    const p1 = parseJsonl(h.files.texts()[0]!);
    expect(p1.at(-1)).toMatchObject({ kind: 'end', reason: 'dir-limit' });
    expect(h.files.files.size).toBe(1);
    expect(h.writer.endReason).toBe('dir-limit');
    expect(h.writer.error).toBe('full');
  });

  it('stops at maxTotalBytes (size-limit) without writing the record that would pass it', async () => {
    const h = harness({ maxTotalBytes: 3000 });
    await h.writer.open();
    let n = 0;
    while (h.writer.push('frame', line('frame', n, { pad: pad(400) }))) { n++; }
    await h.writer.finish('stopped');
    expect(h.stops.map(s => s.reason)).toEqual(['size-limit']);
    const text = h.files.texts()[0]!;
    const lines = parseJsonl(text);
    expect(lines.filter(l => l.kind === 'frame')).toHaveLength(n);
    expect(lines.at(-1)).toMatchObject({ kind: 'end', reason: 'size-limit' });
    // The note and the end fit too: the whole part stays within maxTotalBytes.
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3000);
    expect(h.writer.bytes).toBe(Buffer.byteLength(text));
  });

  it('a recording stopped at size-limit across rotations stays within maxTotalBytes, every part end included', async () => {
    const h = harness({ maxTotalBytes: 20_000, maxFileBytes: 6000 });
    await h.writer.open();
    let t = 0;
    while (h.writer.push('frame', line('frame', t, { pad: pad(700) }))) { h.at(++t); }
    await settle();
    await h.writer.finish('stopped');
    expect(h.stops.map(s => s.reason)).toEqual(['size-limit']);
    expect(h.writer.files.length).toBeGreaterThan(1);
    const total = h.files.texts().reduce((n, x) => n + Buffer.byteLength(x), 0);
    expect(total).toBe(h.writer.bytes);
    expect(total).toBeLessThanOrEqual(20_000);
    const parts = h.files.texts().map(parseJsonl);
    expect(parts.slice(0, -1).every(p => p.at(-1)!.reason === 'rotated')).toBe(true);
    expect(parts.at(-1)!.at(-1)).toMatchObject({ kind: 'end', reason: 'size-limit' });
  });

  it('a block is never split by a rotation: it all stays in the old part, and the new part starts after it', async () => {
    const h = harness({ maxFileBytes: 2000 });
    await h.writer.open();
    h.at(5);
    h.writer.push('frame', line('frame', 5, { pad: pad(1200) }));
    h.at(6);
    // The first line of the block crosses maxFileBytes; the rest follows it in the same part.
    expect(h.writer.pushBlock([
      { kind: 'state', line: line('state', 6, { chunk: 1, pad: pad(900) }) },
      { kind: 'state', line: line('state', 6, { chunk: 2, pad: pad(900) }) },
      { kind: 'state', line: line('state', 6, { chunk: 3, pad: pad(10) }) },
    ])).toBe(true);
    h.at(7);
    h.writer.push('call', line('call', 7));
    await settle();
    await h.writer.finish('stopped');
    const [p1, p2] = h.files.texts().map(parseJsonl);
    expect(p1!.filter(l => l.kind === 'state').map(l => l.chunk)).toEqual([1, 2, 3]);
    expect(p1!.at(-1)).toMatchObject({ kind: 'end', reason: 'rotated', t: 6 });
    expect(p2!.map(l => l.kind)).toEqual(['header', 'frame', 'call', 'note', 'end']);
    expect(h.resyncs).toEqual([{ cause: 'part', t: 6 }]);
  });

  it('a gap and its resync are one block: a part never ends between them', async () => {
    const h = harness({ maxFileBytes: 2000 }, {
      resync: cause => [
        { kind: 'frame', line: line('frame', 0, { resync: true, cause, pad: pad(900) }) },
        { kind: 'state', line: line('state', 0, { full: true, cause, pad: pad(900) }) },
      ],
    });
    await h.writer.open();
    h.writer.push('frame', line('frame', 1, { pad: pad(1500) }));
    h.at(2);
    h.writer.gap('mask-check', { call: 1 });
    await settle();
    await h.writer.finish('stopped');
    const [p1] = h.files.texts().map(parseJsonl);
    const kinds = p1!.map(l => `${l.kind}${l.cause ? `:${l.cause}` : ''}`);
    expect(kinds).toEqual(['header', 'frame', 'gap', 'frame:gap', 'state:gap', 'end']);
  });

  it('above the soft limit drops calls, state and sub events (counted), never frames; once drained: a gap, then the resync', async () => {
    const h = harness({}, { queue: { softBytes: 2000, hardBytes: 1_000_000, resumeBytes: 600 } });
    await h.writer.open();
    h.files.hold();
    let i = 0;
    while (h.writer.queued < 2000) { h.writer.push('frame', line('frame', i++, { pad: pad(200) })); }
    expect(h.writer.admit('frame')).toBe(true);
    expect(h.writer.admit('call')).toBe(false);
    expect(h.writer.admit('state', 'rw7')).toBe(false);
    expect(h.writer.admit('call')).toBe(false);
    expect(h.dropped).toEqual(['rw7']);
    expect(h.writer.push('frame', line('frame', i++, { last: true }))).toBe(true);
    expect(h.writer.dropped).toEqual({ call: 2, state: 1, sub: 0 });
    h.at(500);
    h.files.release();
    await settle();
    expect(h.writer.admit('call')).toBe(true);
    h.writer.push('call', line('call', 501));
    await h.writer.finish('stopped');
    const lines = parseJsonl(h.files.texts()[0]!);
    const kinds = lines.map(l => l.kind);
    const gapAt = kinds.indexOf('gap');
    expect(gapAt).toBeGreaterThan(0);
    expect(lines[gapAt]).toEqual({ kind: 'gap', t: 500, why: 'writer-behind', kinds: { call: 2, state: 1, sub: 0 } });
    expect(lines[gapAt + 1]).toMatchObject({ kind: 'frame', resync: true });
    expect(h.resyncs).toEqual([{ cause: 'gap', t: 500 }]);
    // Every frame is there, in order, before the gap; the call comes after the resync.
    expect(lines.slice(0, gapAt).filter(l => l.kind === 'frame')).toHaveLength(i);
    expect(kinds.indexOf('call')).toBeGreaterThan(gapAt + 1);
    expect(lines.at(-1)).toMatchObject({ kind: 'end', dropped: { call: 2, state: 1, sub: 0 } });
  });

  it('stops with writer-behind at the hard limit, after writing everything queued', async () => {
    const h = harness({}, { queue: { softBytes: 1000, hardBytes: 5000, resumeBytes: 500 } });
    await h.writer.open();
    h.files.hold();
    let n = 0;
    while (h.writer.push('frame', line('frame', n, { pad: pad(300) }))) { n++; }
    expect(h.stops.map(s => s.reason)).toEqual(['writer-behind']);
    expect(h.writer.active).toBe(false);
    h.files.release();
    await h.writer.finish('stopped');
    const lines = parseJsonl(h.files.texts()[0]!);
    expect(lines.filter(l => l.kind === 'frame')).toHaveLength(n);
    expect(lines.at(-1)).toMatchObject({ kind: 'end', reason: 'writer-behind' });
    expect(h.writer.endReason).toBe('writer-behind');
  });

  it('a failed write stops the recording with a plain reason and closes the handle', async () => {
    const h = harness();
    await h.writer.open();
    h.files.failWrites = true;
    h.writer.push('frame', line('frame', 1));
    await settle();
    expect(h.stops).toEqual([{ reason: 'error', message: 'a write to the recording failed (ENOSPC on write)' }]);
    await h.writer.finish('stopped');
    expect(h.files.files.get(`${SESSION}-p0001.jsonl`)!.closed).toBe(true);
    expect(h.writer.error).toMatch(/ENOSPC/);
  });

  it('a recording whose first part cannot be made leaves nothing behind', async () => {
    const h = harness();
    h.files.failCreateAfter = 0;
    await expect(h.writer.open()).rejects.toThrow(/EACCES/);
    expect(h.writer.push('frame', line('frame', 1))).toBe(false);
    await h.writer.finish('stopped');
    expect(h.files.files.size).toBe(0);
  });
});

describe('cut lines', () => {
  it('every write ends on a line end, so a killed daemon leaves at most a cut last line, which readers ignore', async () => {
    const h = harness();
    await h.writer.open();
    for (let i = 0; i < 50; i++) { h.writer.push('frame', line('frame', i, { pad: pad(i * 37) })); }
    await settle();
    const text = h.files.texts()[0]!;
    expect(text.endsWith('\n')).toBe(true);
    const cut = text + text.split('\n')[3]!.slice(0, 40);   // a kill in the middle of the next line
    const r = splitRecordingLines(cut);
    expect(r.cut).toBe(true);
    expect(r.bad).toEqual([]);
    expect(r.records).toHaveLength(51);
    const broken = splitRecordingLines('{"kind":"header"}\n{nope\n{"kind":"note","t":1,"text":"x"}\n');
    expect(broken).toEqual({ records: [{ kind: 'header' }, { kind: 'note', t: 1, text: 'x' }], cut: false, bad: [2] });
    await h.writer.finish('stopped');
  });
});

describe('plain errors', () => {
  it('leaves file paths out of what a status answer says', () => {
    expect(plainError(Object.assign(new Error("EACCES: permission denied, open 'C:\\Users\\someone\\x.jsonl'"), { code: 'EACCES', syscall: 'open' })))
      .toBe('EACCES on open');
    expect(plainError(new Error('icacls failed: C:\\Users\\someone\\AppData\\rec: Access is denied.'))).not.toMatch(/someone/);
    expect(plainError(new Error('cannot use /home/someone/recordings now'))).not.toMatch(/someone/);
    expect(plainError(new Error("could not open 'D:/data/rec'"))).not.toMatch(/data/);
  });

  it('leaves out paths with spaces, account names and icacls command lines', () => {
    const spaced = plainError(new Error('the folder could not be made owner-only (it could not be restricted to the current user '
      + '(icacls failed: C:\\Users\\John Smith\\AppData\\Roaming\\abb-rws-daemon\\recordings: Access is denied.))'));
    expect(spaced).not.toMatch(/John|Smith|AppData|Roaming|recordings/);
    expect(spaced).toContain('Access is denied.');
    expect(plainError(new Error('cannot use D:\\Shared Data\\rec now'))).not.toMatch(/Shared|Data|rec now/);
    expect(plainError(new Error('cannot use C:\\Program Files (x86)\\data\\rec: denied'))).not.toMatch(/Program|x86|data/);
    const command = plainError(new Error('icacls failed: Command failed: icacls C:\\Users\\jsmith\\rec C:\\Users\\jsmith\\rec\\x.tmp '
      + '/inheritance:r /grant:r DESKTOP-AB12CDE\\jsmith:(OI)(CI)F *S-1-5-18:(OI)(CI)F'));
    expect(command).not.toMatch(/jsmith|DESKTOP|AB12CDE|S-1-5/);
    expect(plainError(new Error('cannot use \\\\server\\share\\First Last\\rec: denied'))).not.toMatch(/server|share|First|Last/);
    expect(plainError(new Error('cannot use /home/First Last/.config/abb-rws-daemon/recordings: Permission denied')))
      .toBe('cannot use <path>: Permission denied');
    expect(plainError('its permissions let other accounts on this PC open it (Everyone, S-1-5-21-1-2-3-1001, CORP\\bob)'))
      .toBe('its permissions let other accounts on this PC open it (Everyone, <account>, <account>)');
  });
});

describe('the recorder at start: folder limit and free space', () => {
  function recorderWith(files: MemoryFiles, limits: Partial<RecordingLimits> = {}) {
    const clock = new ManualClock();
    return new Recorder({
      observer: new FakeFrameObserver([snapshotOf('rw7')]), dir: 'C:\\Users\\someone\\recordings', folder: 'custom',
      log: new MemoryLog(), daemonVersion: '0.1.0-dev', clientVersion: '1.4.0', clock, timers: new ManualTimers(), files, limits,
    });
  }

  it('refuses to start (503) below the free-space floor, read with a fake statfs', async () => {
    const files = new MemoryFiles();
    files.freeBytes = dir => freeDiskBytes(dir, { statfs: async () => ({ bavail: 1000n, bsize: 4096n }) });
    const rec = recorderWith(files);
    await expect(rec.start({})).rejects.toThrow(RecordingFailedError);
    const status = rec.status();
    expect(status.active).toBe(false);
    expect(status.error).toMatch(/minFreeBytes/);
    expect(JSON.stringify(status)).not.toMatch(/someone/);
    expect(files.files.size).toBe(0);
  });

  it('refuses to start when the folder already holds maxDirBytes of recordings', async () => {
    const files = new MemoryFiles();
    files.used = 5 * GIB;
    const rec = recorderWith(files);
    await expect(rec.start({})).rejects.toThrow(/maxDirBytes/);
    expect(files.files.size).toBe(0);
    files.used = 0;
    await expect(rec.start({})).resolves.toMatchObject({ active: true, error: null });
    await rec.stop();
  });

  it('a start request may tighten the limits, and the status shows those in force', async () => {
    const files = new MemoryFiles();
    const rec = recorderWith(files, { maxFileBytes: 8 * MIB });
    const status = await rec.start({ durationS: 60, limits: { maxFileBytes: 64 * MIB, maxTotalBytes: 32 * MIB, minFreeBytes: 3 * GIB } });
    expect(status.limits).toEqual({ ...RECORDING_LIMIT_DEFAULTS, maxFileBytes: 8 * MIB, maxTotalBytes: 32 * MIB, minFreeBytes: 3 * GIB, durationS: 60 });
    await rec.stop();
    await expect(rec.start({ limits: { maxFileBytes: 512 } })).rejects.toThrow(RecordingBoundsError);
  });

  it('stops with disk-space when free space falls below the floor at a rotation', async () => {
    const files = new MemoryFiles();
    const observer = new FakeFrameObserver([snapshotOf('rw7')]);
    const rec = new Recorder({
      observer, dir: 'd', folder: 'default', log: new MemoryLog(), daemonVersion: '0', clientVersion: '0',
      clock: new ManualClock(), timers: new ManualTimers(), files, limits: { maxFileBytes: MIB },
    });
    await rec.start({ content: ['frames'] });
    files.free = 0;
    const big = snapshotOf('rw7', { eventDescription: 'y '.repeat(100_000) });
    for (let i = 0; i < 8 && rec.active; i++) { observer.delta(big, ['events']); }
    await settle();
    const status = rec.status();
    expect(status.active).toBe(false);
    expect(status.endReason).toBe('disk-space');
    expect(parseJsonl(files.texts()[0]!).at(-1)).toMatchObject({ kind: 'end', reason: 'disk-space' });
  });
});

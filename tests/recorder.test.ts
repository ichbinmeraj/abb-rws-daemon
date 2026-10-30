import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RwsError, type RobotState, type Signal } from 'abb-rws-client';
import { ownerOnlyProblem, type ControllerConfig } from '../src/config.js';
import { RecordingActiveError, RecordingBoundsError, RecordingFailedError, type ClientTapSink } from '../src/recording/contract.js';
import { Recorder, clientVersion, defaultRecordingDir, realRecordingFiles, type RecordingFiles } from '../src/recording/recorder.js';
import type { RecordingLimits, RecordingStartRequest } from '../src/schema/v0.js';
import {
  FakeFrameObserver, FakeTapHost, MemoryFiles, MemoryLog, ManualClock, ManualTimers, managerOf, parseJsonl, settle, snapshotOf, stateOf,
} from './helpers/recording-fakes.js';
import { parseRecording } from '../src/replay/reader.js';

vi.setConfig({ testTimeout: 60_000 });

const MIB = 1024 * 1024;
const USER = 'Default User';
const DIR = 'C:\\Users\\someone\\AppData\\Roaming\\abb-rws-daemon\\recordings';
const TOKEN = 'tok_0123456789abcdefghijklmnopqrstuvwxyzABCD';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const cfg = (id: string, password: string, username = USER): ControllerConfig => ({
  id, name: id.toUpperCase(), host: '127.0.0.1', port: 9403, useHttps: true, username, password,
});
const spaces = (n: number): string => 'y '.repeat(Math.ceil(n / 2));

function setup(o: {
  configs?: ControllerConfig[]; token?: string | null; limits?: Partial<RecordingLimits>; files?: RecordingFiles;
  snapshots?: ReturnType<typeof snapshotOf>[]; dir?: string; consumers?: number;
} = {}) {
  const observer = new FakeFrameObserver(o.snapshots ?? [snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed' })], o.consumers ?? 0);
  const tap = new FakeTapHost();
  const files = (o.files ?? new MemoryFiles()) as MemoryFiles;
  const log = new MemoryLog();
  const clock = new ManualClock();
  const timers = new ManualTimers();
  const configs = o.configs ?? [cfg('rw7', 'Cell7-Password')];
  const recorder = new Recorder({
    observer, tap, controllers: () => configs, token: o.token === undefined ? TOKEN : o.token, dir: o.dir ?? DIR,
    folder: 'default', limits: o.limits, log, daemonVersion: '0.1.0-dev', clientVersion: '1.4.0', clock, timers, files,
  });
  const sink = (): ClientTapSink => {
    if (!tap.sink) { throw new Error('no sink installed'); }
    return tap.sink;
  };
  return { observer, tap, files, log, clock, timers, recorder, sink, configs };
}

const ok = (result: unknown) => ({ ok: true as const, result });
const fail = (error: unknown) => ({ ok: false as const, error });

describe('starting and the first lines', () => {
  it('writes the header, the first snapshot as observed and a controller record per controller', async () => {
    const s = setup({ snapshots: [snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed' }), snapshotOf('rw6')] });
    const status = await s.recorder.start({ label: 'live-3min' });
    expect(status).toMatchObject({
      active: true, session: 'rec-20261004T153012Z-live-3min', label: 'live-3min', content: ['frames', 'calls', 'state'],
      startedAt: '2026-10-04T15:30:12.345Z', endsAt: '2026-10-04T16:30:12.345Z', endedAt: null, folder: 'default',
      files: ['rec-20261004T153012Z-live-3min-p0001.jsonl'], endReason: null, error: null,
    });
    expect(s.recorder.health()).toEqual({ active: true, since: '2026-10-04T15:30:12.345Z' });
    expect(s.tap.sink?.active).toBe(true);
    expect(s.observer.observers.size).toBe(1);
    await settle();
    const text = s.files.texts()[0]!;
    for (const raw of text.trimEnd().split('\n')) { expect(raw.startsWith('{"kind":')).toBe(true); }
    const [header, frame, c7, c6] = parseJsonl(text);
    expect(header).toEqual({
      kind: 'header', format: 'abb-rws-recording', formatVersion: 1, schemaVersion: '0.15', source: 'daemon',
      session: 'rec-20261004T153012Z-live-3min', part: 1, previous: null, startedAt: '2026-10-04T15:30:12.345Z',
      sessionStartedAt: '2026-10-04T15:30:12.345Z', label: 'live-3min', content: ['frames', 'calls', 'state'],
      daemon: { version: '0.1.0-dev' }, client: { version: '1.4.0' },
      controllers: [
        { id: 'rw7', systemId: 'SYS-7', generation: 'rws2', robotWare: '7.21.4+417' },
        { id: 'rw6', systemId: null, generation: null, robotWare: null },
      ],
      limits: { maxFileBytes: 64 * MIB, maxTotalBytes: 256 * MIB, maxDirBytes: 4 * 1024 * MIB, maxRecordBytes: MIB, minFreeBytes: 2 * 1024 * MIB, durationS: 3600 },
      masking: { rules: ['keys', 'args', 'text', 'rapid', 'values', 'final'], values: 2, derived: 2, weakValues: 0 },
    });
    expect(frame).toMatchObject({ kind: 'frame', t: 0, frame: { type: 'snapshot', schemaVersion: '0.15' } });
    expect(frame).not.toHaveProperty('resync');
    expect(c7).toEqual({ kind: 'controller', t: 0, id: 'rw7', systemId: 'SYS-7', generation: 'rws2', robotWare: '7.21.4+417', identityCheck: 'confirmed' });
    expect(c6).toEqual({ kind: 'controller', t: 0, id: 'rw6', systemId: null, generation: null, robotWare: null, identityCheck: 'unverified' });
    await s.recorder.stop();
  });

  it('writes every frame byte for byte as the stream sent it', async () => {
    const s = setup();
    await s.recorder.start({});
    const sent: string[] = [];
    for (let i = 0; i < 5; i++) {
      s.clock.advance(250);
      sent.push(s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', speed: 10 * i }), ['panel']));
    }
    await s.recorder.stop();
    const raw = s.files.texts()[0]!.split('\n').filter(l => l.includes('"type":"delta"'));
    expect(raw).toHaveLength(5);
    raw.forEach((l, i) => {
      expect(l).toBe(`{"kind":"frame","t":${250 * (i + 1)},"frame":${sent[i]}}`);
    });
  });

  it('refuses a second recording (409), a bad request (400), and a folder or file it cannot make (503, no path)', async () => {
    const s = setup();
    await s.recorder.start({});
    await expect(s.recorder.start({})).rejects.toBeInstanceOf(RecordingActiveError);
    await s.recorder.stop();
    await expect(s.recorder.start({ durationS: 0 })).rejects.toBeInstanceOf(RecordingBoundsError);
    await expect(s.recorder.start({ content: [] } as RecordingStartRequest)).rejects.toBeInstanceOf(RecordingBoundsError);
    s.files.prepareFolder = async () => { throw new RecordingFailedError('the recordings folder is not this account\'s alone: it belongs to another account'); };
    await expect(s.recorder.start({})).rejects.toBeInstanceOf(RecordingFailedError);
    expect(s.recorder.status().error).toMatch(/another account/);
    s.files.prepareFolder = async () => {};
    s.files.failCreateAfter = 0;
    s.clock.advance(1000);
    await expect(s.recorder.start({})).rejects.toBeInstanceOf(RecordingFailedError);
    const status = s.recorder.status();
    expect(status.active).toBe(false);
    expect(status.error).toMatch(/first part could not be made/);
    expect(JSON.stringify(status)).not.toMatch(/someone|\\\\|[A-Za-z]:[\\/]/);
    expect(s.log.text()).toMatch(/someone/);   // the folder is in the log, never in an answer
  });
});

describe('controller records and call.gen', () => {
  it('writes a controller record when identity becomes known or changes, and tags calls with the generation', async () => {
    const s = setup({ snapshots: [snapshotOf('rw6')] });
    await s.recorder.start({});
    const sink = s.sink();
    const before = sink.call('manager', 'rw6', 'getMotionPointer', ['T_ROB1'])!;
    before.done(ok(null));
    s.clock.advance(10);
    s.observer.delta(snapshotOf('rw6', { sysId: 'SYS-6', generation: 'rws1', robotWare: '6.16.3007', check: 'confirmed' }), ['identity', 'link']);
    s.clock.advance(10);
    s.observer.delta(snapshotOf('rw6', { sysId: 'SYS-6', generation: 'rws1', robotWare: '6.16.3007', check: 'confirmed', speed: 50 }), ['panel']);
    const after = sink.call('manager', 'rw6', 'getMotionPointer', ['T_ROB1'])!;
    after.done(fail(new RwsError('not found', 'RESOURCE_NOT_FOUND', 404, undefined, -1073445859, 'Resource not found')));
    s.clock.advance(10);
    s.observer.delta(snapshotOf('rw6', { sysId: 'SYS-6', generation: 'rws1', robotWare: '6.16.3008', check: 'confirmed' }), ['identity']);
    s.observer.removed('rw6');
    s.observer.delta(snapshotOf('rw6', { sysId: 'SYS-6', generation: 'rws1', robotWare: '6.16.3008', check: 'mismatch' }), ['identity', 'link']);
    await s.recorder.stop();
    const lines = parseJsonl(s.files.texts()[0]!);
    const ctl = lines.filter(l => l.kind === 'controller');
    expect(ctl.map(l => [l.robotWare, l.identityCheck])).toEqual([
      [null, 'unverified'], ['6.16.3007', 'confirmed'], ['6.16.3008', 'confirmed'], ['6.16.3008', 'mismatch'],
    ]);
    const calls = lines.filter(l => l.kind === 'call');
    expect(calls.map(c => c.gen)).toEqual([null, 'rws1']);
    expect(calls[1]).toMatchObject({
      ok: false, seq: 2, error: { code: 'RESOURCE_NOT_FOUND', message: 'not found', controller: { httpStatus: 404, code: -1073445859, message: 'Resource not found' } },
    });
  });
});

describe('calls, sub events and the clock', () => {
  it('records arguments (masked at the start), the outcome, its duration and t when it settled', async () => {
    const s = setup();
    await s.recorder.start({});
    const sink = s.sink();
    s.clock.advance(100);
    const p = sink.call('manager', 'rw7', 'getJointTargetFull', ['ROB_1'])!;
    s.clock.advance(23);
    p.done(ok({ rax_1: 1.5, at: new Date('2026-10-04T15:30:12.468Z') }));
    p.done(ok('twice'));
    const st = sink.call('manager', 'rw7', 'setControlStation', [{ name: 'panel', id: 'secret-station-id' }])!;
    st.done(ok({ stationId: 'x' }));
    const d = sink.call('setup', null, 'discover', [{ hosts: ['127.0.0.1'] }, [cfg('rw9', 'Disc-Secret-9753', 'u9')], new AbortController().signal])!;
    d.done(ok({ controllers: [] }));
    s.clock.advance(7);
    sink.sub('rw7', { resource: '/rw/iosystem/signals/doX;state', value: '1', timestamp: new Date('2026-10-04T15:30:12.600Z') });
    await s.recorder.stop();
    const lines = parseJsonl(s.files.texts()[0]!);
    const calls = lines.filter(l => l.kind === 'call');
    expect(calls[0]).toEqual({
      kind: 'call', t: 123, target: 'manager', id: 'rw7', gen: 'rws2', seq: 1, method: 'getJointTargetFull', args: ['ROB_1'],
      ms: 23, ok: true, result: { rax_1: 1.5, at: '2026-10-04T15:30:12.468Z' },
    });
    expect(calls[1]).toMatchObject({ method: 'setControlStation', args: '***', result: { $omitted: 'secret' }, masked: 1 });
    expect(calls[2]).toMatchObject({
      target: 'setup', id: null, gen: null, method: 'discover',
      args: [{ hosts: ['127.0.0.1'] }, [{ id: 'rw9', username: 'u9', password: '***' }], '[object AbortSignal]'],
    });
    expect(calls).toHaveLength(3);
    expect(lines.find(l => l.kind === 'sub')).toEqual({
      kind: 'sub', t: 130, id: 'rw7', event: { resource: '/rw/iosystem/signals/doX;state', value: '1', timestamp: '2026-10-04T15:30:12.600Z' },
    });
    expect(s.files.texts()[0]).not.toContain('Disc-Secret-9753');
    expect(s.files.texts()[0]).not.toContain('secret-station-id');
  });

  it('a RAPID value read from a symbol whose name names a secret is recorded without its value; any other value is recorded', async () => {
    const s = setup();
    await s.recorder.start({});
    const sink = s.sink();
    sink.call('manager', 'rw7', 'getRapidVariable', ['T_ROB1', 'Cell', 'ftpPassword'])!.done(ok('"ftp-pass-7531"'));
    sink.call('manager', 'rw7', 'getRapidVariable', ['T_ROB1', 'Cell', 'partPresent'])!.done(ok('FALSE'));
    await s.recorder.stop();
    const calls = parseJsonl(s.files.texts()[0]!).filter(l => l.kind === 'call');
    expect(calls[0]).toMatchObject({ method: 'getRapidVariable', args: ['T_ROB1', 'Cell', 'ftpPassword'], ok: true, result: { $omitted: 'secret' } });
    expect(calls[1]).toMatchObject({ method: 'getRapidVariable', args: ['T_ROB1', 'Cell', 'partPresent'], result: 'FALSE' });
    expect(s.files.texts()[0]).not.toContain('ftp-pass-7531');
  });

  it('stamps t at capture, not when the disk gets to it, and never lets it go back', async () => {
    const s = setup();
    await s.recorder.start({});
    await settle();
    s.files.hold();
    const sink = s.sink();
    const stamps: number[] = [];
    for (let i = 0; i < 6; i++) {
      s.clock.advance(17);
      stamps.push(Math.floor(s.clock.monoMs - 1000));
      sink.sub('rw7', { resource: 'r', value: String(i), timestamp: new Date(0) });
    }
    s.clock.monoMs -= 50;   // a monotonic clock never does this; t holds anyway
    sink.sub('rw7', { resource: 'r', value: 'late', timestamp: new Date(0) });
    s.clock.advance(5000);   // the disk is slow
    s.files.release();
    await s.recorder.stop();
    const subs = parseJsonl(s.files.texts()[0]!).filter(l => l.kind === 'sub');
    expect(subs.map(l => l.t)).toEqual([...stamps, stamps.at(-1)]);
    const all = parseJsonl(s.files.texts()[0]!).slice(1).map(l => l.t as number);
    expect([...all].sort((a, b) => a - b)).toEqual(all);
  });

  it('a call settling after the recording ended writes nothing, and the sink passes calls through once inactive', async () => {
    const s = setup();
    await s.recorder.start({});
    const sink = s.sink();
    const p = sink.call('manager', 'rw7', 'getModuleText', ['T_ROB1', 'M'])!;
    await s.recorder.stop();
    p.done(ok({ text: 'x' }));
    expect(sink.active).toBe(false);
    expect(sink.call('manager', 'rw7', 'x', [])).toBeNull();
    expect(s.tap.history.at(-1)).toBeNull();
    expect(s.files.texts()[0]).not.toContain('"kind":"call"');
  });

  it('with calls left out, still learns secrets from call arguments', async () => {
    const s = setup();
    await s.recorder.start({ content: ['frames'] });
    expect(s.sink().call('multi', null, 'addRobot', [cfg('rw5', 'Added-Secret-5555')])).toBeNull();
    s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventTitle: 'login as Added-Secret-5555 refused' }), ['events']);
    s.sink().state('rw7', managerOf(stateOf()));
    await s.recorder.stop();
    const text = s.files.texts()[0]!;
    expect(text).not.toContain('Added-Secret-5555');
    expect(text).not.toContain('"kind":"state"');
    expect(parseJsonl(text).find(l => l.kind === 'frame' && l.masked)).toBeDefined();
  });
});

describe('state records', () => {
  const sig = (name: string, value: string): Signal => ({ name, value, lvalue: value, type: 'DO' });

  it('first full (every key but the event log), then only what changed; the signal table whole, then by name', async () => {
    const s = setup();
    await s.recorder.start({});
    const sink = s.sink();
    const state = stateOf({ ioSignals: [sig('doA', '0'), sig('doB', '0')], ioSignalsLoaded: true, eventLog: [{ title: 'in the log only' }] as never });
    const mgr = managerOf(state);
    s.clock.advance(40);
    sink.state('rw7', mgr);
    sink.state('rw7', mgr);                                     // nothing changed
    state.modulesByTask = { T_ROB1: ['MainModule'] };          // a new object, same value
    sink.state('rw7', mgr);
    state.speedRatio = 50;
    state.eventLog = [{ title: 'still the log only' }] as never;
    sink.state('rw7', mgr);
    state.ioSignals = [sig('doA', '1'), sig('doC', '0')];
    mgr.currentPort = 9404;
    sink.state('rw7', mgr);
    await s.recorder.stop();
    const text = s.files.texts()[0]!;
    expect(text).not.toContain('eventLog');
    expect(text).not.toContain('the log only');
    const st = parseJsonl(text).filter(l => l.kind === 'state');
    expect(st).toHaveLength(5);
    const fullKeys = Object.keys(stateOf()).filter(k => k !== 'eventLog' && k !== 'ioSignals');
    expect(st[0]).toMatchObject({ t: 40, id: 'rw7', full: true, manager: { port: 9403, useHttps: true, groupPath: '/subscription/5' } });
    expect(Object.keys(st[0]!.changed as object).sort()).toEqual(fullKeys.sort());
    expect(st[1]).toEqual({ kind: 'state', t: 40, id: 'rw7', full: true, ioSignals: { chunk: 1, chunks: 1, full: [sig('doA', '0'), sig('doB', '0')] } });
    expect(st[2]).toEqual({ kind: 'state', t: 40, id: 'rw7', changed: { speedRatio: 50 } });
    expect(st[3]).toEqual({ kind: 'state', t: 40, id: 'rw7', manager: { port: 9404, useHttps: true, groupPath: '/subscription/5' } });
    expect(st[4]).toEqual({
      kind: 'state', t: 40, id: 'rw7', ioSignals: { added: [sig('doC', '0')], changed: [sig('doA', '1')], removed: ['doB'] },
    });
  });

  it('diffs the signal table by name: added, changed, removed', async () => {
    const s = setup();
    await s.recorder.start({});
    const state = stateOf({ ioSignals: [sig('doA', '0'), sig('doB', '0')] });
    const mgr = managerOf(state);
    s.sink().state('rw7', mgr);
    state.ioSignals = [sig('doA', '1'), sig('doC', '0')];
    s.sink().state('rw7', mgr);
    await s.recorder.stop();
    const st = parseJsonl(s.files.texts()[0]!).filter(l => l.kind === 'state');
    expect(st.at(-1)).toEqual({
      kind: 'state', t: 0, id: 'rw7', ioSignals: { added: [sig('doC', '0')], changed: [sig('doA', '1')], removed: ['doB'] },
    });
  });

  it('chunks a table larger than a record, and replaces a single key larger than a record by its size', async () => {
    const s = setup({ limits: { maxRecordBytes: 64 * 1024 } });
    await s.recorder.start({});
    const table = Array.from({ length: 3000 }, (_, i) => sig(`signal_${String(i).padStart(5, '0')}`, '0'));
    const state = stateOf({ ioSignals: table, qualityReason: spaces(100_000) });
    s.sink().state('rw7', managerOf(state));
    await s.recorder.stop();
    const lines = s.files.texts()[0]!.split('\n').filter(l => l.length > 0);
    for (const l of lines) { expect(Buffer.byteLength(l) + 1).toBeLessThanOrEqual(64 * 1024); }
    const st = lines.map(l => JSON.parse(l) as Record<string, unknown>).filter(l => l.kind === 'state');
    const main = st[0]!;
    expect((main.changed as Record<string, unknown>).qualityReason).toEqual({ $omitted: { bytes: 100_002 } });
    const chunks = st.slice(1).map(l => l.ioSignals as { chunk: number; chunks: number; full: Signal[] });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(c => c.chunk)).toEqual(chunks.map((_, i) => i + 1));
    expect(chunks.every(c => c.chunks === chunks.length)).toBe(true);
    expect(chunks.flatMap(c => c.full)).toEqual(table);
  });

  it('a rotation never splits a chunked signal table: every part reads in time order and the replayed table stays ready', async () => {
    const s = setup({ limits: { maxRecordBytes: 64 * 1024, maxFileBytes: MIB } });
    await s.recorder.start({});
    // Fill the first part to just below its limit with frames.
    while (s.recorder.status().bytes < MIB - 60 * 1024) {
      s.clock.advance(10);
      s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventDescription: spaces(20_000) }), ['events']);
    }
    expect(s.recorder.status().files).toHaveLength(1);
    // The first state record: the whole table, about 180 KB in three chunks, crosses the part limit at its first chunk.
    const table = Array.from({ length: 3000 }, (_, i) => sig(`signal_${String(i).padStart(5, '0')}`, '0'));
    const state = stateOf({ ioSignals: table, ioSignalsLoaded: true });
    const mgr = managerOf(state);
    s.clock.advance(10);
    s.sink().state('rw7', mgr);
    await settle();
    expect(s.recorder.status().files).toHaveLength(2);
    s.clock.advance(10);
    state.ioSignals = table.map((x, i) => (i === 7 ? sig(x.name, '1') : x));
    s.sink().state('rw7', mgr);
    await s.recorder.stop();

    const texts = [...s.files.files.keys()].sort().map(name => ({ name, text: s.files.files.get(name)!.text }));
    const [p1, p2] = texts.map(x => parseJsonl(x.text));
    // Part 1 holds every chunk of its table; part 2 begins with its own whole table, and no chunk comes after it out of order.
    const chunksOf = (lines: Array<Record<string, unknown>>) => lines
      .filter(l => l.kind === 'state' && (l.ioSignals as { chunk?: number } | undefined)?.chunk !== undefined)
      .map(l => (l.ioSignals as { chunk: number; chunks: number }));
    const c1 = chunksOf(p1!);
    expect(c1.length).toBeGreaterThan(1);
    expect(c1.map(c => c.chunk)).toEqual(c1.map((_, i) => i + 1));
    const c2 = chunksOf(p2!);
    expect(c2.map(c => c.chunk)).toEqual(c2.map((_, i) => i + 1));
    expect(p1!.at(-1)).toMatchObject({ kind: 'end', reason: 'rotated' });
    for (const part of [p1!, p2!]) {
      const ts = part.filter(l => l.kind !== 'header').map(l => l.t as number);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
    }
    const rec = parseRecording(texts);
    const last = (p2!.at(-1)!.t as number);
    const answer = rec.index.ioTableAt('rw7', last);
    expect(answer.status).toBe('ready');
    const signals = answer.status === 'ready' ? answer.signals : [];
    expect(signals[7]).toEqual(sig('signal_00007', '1'));
    expect(signals).toHaveLength(3000);
  });

  it('a large call result keeps its envelope; a frame over the record limit is still written whole', async () => {
    const s = setup({ limits: { maxRecordBytes: 64 * 1024 } });
    await s.recorder.start({});
    const p = s.sink().call('manager', 'rw7', 'getModuleText', ['T_ROB1', 'Big'])!;
    p.done(ok({ text: spaces(200_000) }));
    const big = s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventDescription: spaces(100_000) }), ['events']);
    await s.recorder.stop();
    const text = s.files.texts()[0]!;
    const call = parseJsonl(text).find(l => l.kind === 'call')!;
    expect(call).toMatchObject({ method: 'getModuleText', args: ['T_ROB1', 'Big'], ok: true, result: { $omitted: { bytes: expect.any(Number) } } });
    expect(text).toContain(`"frame":${big}}`);
  });
});

describe('ending', () => {
  it('ends by its duration: a note, the end record, the tap and the observer let go', async () => {
    const s = setup();
    await s.recorder.start({ durationS: 190 });
    expect(s.recorder.status().endsAt).toBe('2026-10-04T15:33:22.345Z');
    s.clock.advance(190_000);
    s.timers.fire(190_000);
    await settle();
    const status = s.recorder.status();
    expect(status).toMatchObject({ active: false, endReason: 'duration', endsAt: null, endedAt: '2026-10-04T15:33:22.345Z' });
    expect(s.recorder.health()).toEqual({ active: false, since: null });
    expect(s.observer.observers.size).toBe(0);
    expect(s.tap.history.at(-1)).toBeNull();
    const lines = parseJsonl(s.files.texts()[0]!);
    expect(lines.slice(-2)).toEqual([
      { kind: 'note', t: 190_000, text: 'recording stopped: duration reached' },
      expect.objectContaining({ kind: 'end', t: 190_000, reason: 'duration', next: null, stats: { stateDiffMsMax: expect.any(Number) } }),
    ]);
    expect(s.log.entries.some(e => e.msg === 'recording stopped' && (e.obj as { reason?: string }).reason === 'duration')).toBe(true);
  });

  it('endsAt counts from when the duration timer starts, after the first part was made', async () => {
    const files = new MemoryFiles();
    const s = setup({ files });
    const create = files.create.bind(files);
    // Making the first part takes 1.5 s (as the permission step can on Windows).
    files.create = async (path, line) => { s.clock.advance(1500); return create(path, line); };
    await s.recorder.start({ durationS: 190 });
    const status = s.recorder.status();
    expect(status.startedAt).toBe('2026-10-04T15:30:12.345Z');
    expect(status.endsAt).toBe('2026-10-04T15:33:23.845Z');
    expect([...s.timers.pending.values()].map(t => t.ms)).toContain(190_000);
  });

  it('stop is idempotent; the status names files by base name only; a new recording can start', async () => {
    const s = setup();
    await s.recorder.start({});
    const first = await s.recorder.stop();
    const again = await s.recorder.stop();
    expect(again).toEqual(first);
    expect(first).toMatchObject({ active: false, endReason: 'stopped', files: ['rec-20261004T153012Z-p0001.jsonl'] });
    expect(JSON.stringify(first)).not.toMatch(/someone|AppData|[A-Za-z]:\\/);
    s.clock.advance(1000);
    const next = await s.recorder.start({ label: 'second' });
    expect(next.session).toBe('rec-20261004T153013Z-second');
    expect(next.records).toBeGreaterThan(0);
    const end = await s.recorder.stop('daemon-stop', { waitMs: 1000 });
    expect(end.endReason).toBe('daemon-stop');
    await expect(s.recorder.start({})).rejects.toThrow(/stopping/);
  });

  it('a failing manager never fails the caller; a recorder fault stops only the recording', async () => {
    const s = setup();
    await s.recorder.start({});
    const throwing = { get state(): RobotState { throw new Error('gone'); }, currentPort: 1 };
    expect(() => s.sink().state('rw7', throwing)).not.toThrow();
    expect(s.recorder.active).toBe(true);
    s.files.failWrites = true;
    s.sink().sub('rw7', { resource: 'r', value: 'v', timestamp: new Date(0) });
    await settle();
    const status = s.recorder.status();
    expect(status).toMatchObject({ active: false, endReason: 'error' });
    expect(status.error).toMatch(/ENOSPC on write/);
    expect(() => s.observer.delta(snapshotOf('rw7'), ['panel'])).not.toThrow();
  });
});

describe('rotation', () => {
  it('with 32 consumers attached: no consumer touched, one observer throughout; the new part starts with controller records, a resync snapshot and full state', async () => {
    const s = setup({ limits: { maxFileBytes: MIB }, consumers: 32 });
    await s.recorder.start({});
    const mgr = managerOf(stateOf({ ioSignals: [{ name: 'doA', value: '0', lvalue: '0', type: 'DO' }] }));
    s.sink().state('rw7', mgr);
    let emitted = 0;
    while (s.recorder.status().files.length < 2 && emitted < 20) {
      s.clock.advance(100);
      s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventDescription: spaces(300_000) }), ['events']);
      emitted++;
      await settle();
    }
    s.clock.advance(100);
    mgr.state.speedRatio = 10;
    s.sink().state('rw7', mgr);
    await s.recorder.stop();
    expect(s.observer.observeCalls).toBe(1);
    expect(s.observer.consumers.every(c => !c.closed && c.sent === emitted)).toBe(true);
    const [p1, p2] = s.files.texts().map(parseJsonl);
    expect(p1!.at(-1)).toMatchObject({ kind: 'end', reason: 'rotated', next: 'rec-20261004T153012Z-p0002.jsonl' });
    const T = p1!.at(-1)!.t as number;
    expect(p2!.slice(0, 5).map(l => [l.kind, l.t ?? null])).toEqual([
      ['header', null], ['controller', T], ['frame', T], ['state', T], ['state', T],
    ]);
    expect(p2![0]).toMatchObject({ part: 2, previous: 'rec-20261004T153012Z-p0001.jsonl', sessionStartedAt: '2026-10-04T15:30:12.345Z' });
    expect(p2![2]).toMatchObject({ resync: true, frame: { type: 'snapshot' } });
    expect(p2![3]).toMatchObject({ full: true, id: 'rw7' });
    expect(p2![4]).toMatchObject({ full: true, ioSignals: { chunk: 1, chunks: 1 } });
    expect(p2!.at(-3)).toMatchObject({ kind: 'state', changed: { speedRatio: 10 } });
    const ts = [...p1!, ...p2!].filter(l => typeof l.t === 'number').map(l => l.t as number);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(s.recorder.status().files).toHaveLength(2);
  });
});

describe('the file format', () => {
  it('every line written is a valid recording line (recording.schema.json, strict)', async () => {
    const Fastify = (await import('fastify')).default;
    // @ts-expect-error - plain ESM script without type declarations
    const { CUSTOM_KEYWORDS } = await import('../scripts/export-schema.mjs') as { CUSTOM_KEYWORDS: string[] };
    const schema = (p: string) => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8')) as { $id: string };
    const recording = schema('schema/recording.schema.json');
    const app = Fastify({
      ajv: { customOptions: { keywords: [...CUSTOM_KEYWORDS], allowUnionTypes: true, removeAdditional: false, coerceTypes: false, useDefaults: false } },
    });
    // Frames as recording.schema.json says: against the history file of the header's schemaVersion (the daemon's own),
    // registered under the major-line id the recording schema refers to.
    const { SCHEMA_VERSION: recorded } = await import('../src/schema/v0.js');
    app.addSchema({ ...schema(`schema/history/v${recorded}.schema.json`), $id: 'urn:abb-rws-daemon:schema:v0' });
    app.addSchema(recording);
    app.post('/line', { schema: { body: { $ref: `${recording.$id}#/definitions/RecordingLine` } } }, async () => ({ ok: true }));
    await app.ready();

    const s = setup({ limits: { maxFileBytes: MIB, maxRecordBytes: 64 * 1024 }, snapshots: [snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed' }), snapshotOf('rw6')] });
    await s.recorder.start({ label: 'format' });
    const sink = s.sink();
    sink.call('manager', 'rw7', 'getJointTargetFull', ['ROB_1'])!.done(ok({ rax_1: 1 }));
    sink.call('manager', 'rw7', 'getModuleText', ['T_ROB1', 'M'])!.done(ok({ text: spaces(100_000) }));
    sink.call('manager', 'rw6', 'getMotionPointer', ['T_ROB1'])!.done(fail(new RwsError('nf', 'RESOURCE_NOT_FOUND', 404, undefined, -1, 'x')));
    sink.call('manager', 'rw7', 'setControlStation', [{}])!.done(ok(undefined));
    // The status reads of schema 0.13: a holder's user id is dropped, a holder's station id masked.
    sink.call('manager', 'rw7', 'getMastershipStatus', ['rapid'])!.done(ok({ mastership: 'remote', uid: 'user-id-of-the-holder', application: 'RobotStudio' }));
    sink.call('manager', 'rw7', 'getRmmpPrivilege', [])!.done(ok('none'));
    sink.call('manager', 'rw7', 'getWriteAccessStatus', [])!.done(ok({
      held: true, heldByMe: false, heldByName: 'RobotStudio', heldById: '{6F1C0E2A-8B3D-4E5F-9A7B-1C2D3E4F5A6B}', externalControlEnabled: null,
    }));
    sink.call('setup', null, 'readPassport', [{ host: '127.0.0.1', username: 'u', password: 'Passport-Pw-1' }])!.done(fail(new Error('down')));
    sink.sub('rw7', { resource: 'r', value: 'Cell7-Password', timestamp: new Date(0) });
    const state = stateOf({ ioSignals: [{ name: 'doA', value: '0', lvalue: '0', type: 'DO' }] });
    const mgr = managerOf(state);
    sink.state('rw7', mgr);
    state.ioSignals = [{ name: 'doB', value: '1', lvalue: '1', type: 'DO' }];
    sink.state('rw7', mgr);
    s.observer.delta(snapshotOf('rw6', { sysId: 'SYS-6', generation: 'rws1', robotWare: '6.16.3007' }), ['identity', 'link']);
    s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventTitle: 'with Cell7-Password' }), ['events']);
    for (let i = 0; i < 6 && s.recorder.status().files.length < 2; i++) {
      s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventDescription: spaces(300_000) }), ['events']);
      await settle();
    }
    s.observer.removed('rw6');
    await s.recorder.stop();
    const lines = s.files.texts().flatMap(t => t.split('\n').filter(l => l.length > 0));
    const kinds = new Set(lines.map(l => (JSON.parse(l) as { kind: string }).kind));
    expect([...kinds].sort()).toEqual(['call', 'controller', 'end', 'frame', 'header', 'note', 'state', 'sub']);
    for (const l of lines) {
      const r = await app.inject({ method: 'POST', url: '/line', headers: { 'content-type': 'application/json' }, payload: l });
      expect(r.statusCode, `${l.slice(0, 200)}: ${r.body}`).toBe(200);
    }
    const mastership = lines.find(l => l.includes('"method":"getMastershipStatus"'))!;
    expect(mastership).toContain('"result":{"mastership":"remote","application":"RobotStudio"},"masked":1}');
    const writeAccess = lines.find(l => l.includes('"method":"getWriteAccessStatus"'))!;
    expect(writeAccess).toContain('"heldByName":"RobotStudio","heldById":"***","externalControlEnabled":null},"masked":1}');
    for (const l of lines) {
      expect(l).not.toContain('user-id-of-the-holder');
      expect(l).not.toContain('6F1C0E2A');
    }
    // The check bites: an extra field, or a gap without every kind, is refused.
    for (const bad of ['{"kind":"note","t":1,"text":"x","extra":1}', '{"kind":"gap","t":1,"why":"mask-check","kinds":{"call":1,"state":0}}']) {
      const r = await app.inject({ method: 'POST', url: '/line', headers: { 'content-type': 'application/json' }, payload: bad });
      expect(r.statusCode).toBe(400);
    }
    await app.close();
  });
});

describe('the default folder', () => {
  it('is next to the token file, in the per-user folder', () => {
    expect(defaultRecordingDir({ APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' }, 'win32', 'C:\\Users\\someone'))
      .toBe('C:\\Users\\someone\\AppData\\Roaming\\abb-rws-daemon\\recordings');
    expect(defaultRecordingDir({}, 'linux', '/home/someone')).toBe('/home/someone/.config/abb-rws-daemon/recordings');
    expect(defaultRecordingDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/someone')).toBe('/cfg/abb-rws-daemon/recordings');
  });
});

describe('the client version', () => {
  it('is read from the package.json next to the resolved entry point, else unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-client-'));
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'abb-rws-client', version: '9.8.7' }));
    expect(clientVersion(() => pathToFileURL(join(dir, 'dist', 'index.js')).href)).toBe('9.8.7');
    expect(clientVersion(() => pathToFileURL(join(dir, 'nowhere', 'deeper', 'index.js')).href)).toBe('unknown');
    expect(clientVersion(() => { throw new Error('cannot resolve'); })).toBe('unknown');
    const real = JSON.parse(await readFile(join(process.cwd(), 'node_modules', 'abb-rws-client', 'package.json'), 'utf8')) as { version: string };
    expect(clientVersion()).toBe(real.version);
  });
});

/**
 * Every place a credential can enter a recording, through the real file
 * system: the raw bytes of every part are searched for each secret.
 */
describe('the masking proof', () => {
  class HttpSessionLike {
    password = 'Cell7 Pass@w0rd#';
    cookies = new Map([['-http-session-', 'SessionCookieValue-1234']]);
    digestChallenge = { realm: 'r', nonce: 'n' };
  }

  it('no secret, encoded form or session cookie reaches any part, across a rotation', async () => {
    const PW = 'Cell7 Pass@w0rd#';
    const secrets = {
      PW, token: TOKEN, pin: 'Pin-Secret-2468', disc: 'Disc-Secret-9753', passport: 'Pass-Secret-8642', removed: 'Removed-Secret-1357',
      rapid: 'Ftp-Secret-4321', keyed: 'Key-Secret-123', station: 'Station-Secret-77', url: 'Url-Secret-99',
      cookie1: 'SESSIONCOOKIE1234', cookie2: 'ABBCXCOOKIE5678', sessionCookie: 'SessionCookieValue-1234',
      digest: '6629fae49393a05397450978507c4ef1', bearer: 'BearerTokenValue0987654321',
      holderUid: 'Uid-Of-Holder-4471', holderStation: '{6F1C0E2A-8B3D-4E5F-9A7B-1C2D3E4F5A6B}',
    };
    const encoded = [b64(PW), b64(`${USER}:${PW}`), encodeURIComponent(PW), b64(secrets.disc), b64(`u9:${secrets.disc}`),
      b64(`u8:${secrets.passport}`), b64(`u5:${secrets.removed}`), b64(secrets.pin)];
    const root = await mkdtemp(join(tmpdir(), 'daemon-rec-'));
    const dir = join(root, 'recordings');
    const configs = [cfg('rw7', PW)];
    const s = setup({ configs, dir, files: realRecordingFiles(), limits: { maxFileBytes: MIB } });

    // Every object handed to the recording, and a copy to prove none of them changed.
    const removedCfg = cfg('rw5', secrets.removed, 'u5');
    const discoverArgs = [{ hosts: ['127.0.0.1'] }, [cfg('rw9', secrets.disc, 'u9')]];
    const passportTarget = { host: '127.0.0.1', port: 9403, useHttps: true, username: 'u8', password: secrets.passport };
    const results = {
      blob: { blob: b64(`${USER}:${PW}`), url: `https://ctrl/x?p=${encodeURIComponent(PW)}` },
      headers: { raw: `Authorization: Basic ${b64(`${USER}:${PW}`)}\r\nCookie: -http-session-=${secrets.cookie1}; ABBCX=${secrets.cookie2}` },
      keyed: { password: secrets.keyed, stationId: secrets.station, [PW]: 1, bearer: `Bearer ${secrets.bearer}` },
      session: { session: new HttpSessionLike() },
      rapid: { text: `MODULE Cell\n  VAR string ftpPassword := "${secrets.rapid}";\n  VAR num count := 2026;\nENDMODULE` },
      mastership: { mastership: 'remote', uid: secrets.holderUid, application: 'RobotStudio' },
      writeAccess: { held: true, heldByMe: false, heldByName: 'RobotStudio', heldById: secrets.holderStation, externalControlEnabled: true },
    };
    const state = stateOf({ qualityReason: `retry; Cookie: -http-session-=${secrets.cookie1}` });
    const kept = structuredClone({ configs, removedCfg, discoverArgs, passportTarget, results: { ...results, session: null }, state });

    await s.recorder.start({ label: 'proof' });
    const sink = s.sink();
    const settleCall = (target: 'manager' | 'multi' | 'setup', id: string | null, method: string, args: unknown[], outcome: { ok: true; result: unknown } | { ok: false; error: unknown }) => {
      s.clock.advance(5);
      sink.call(target, id, method, args)!.done(outcome);
    };
    settleCall('manager', 'rw7', 'connect', ['127.0.0.1', USER, PW, 9403, true], ok(undefined));
    settleCall('manager', 'rw7', 'lockOperationMode', [secrets.pin, true], ok(undefined));
    settleCall('setup', null, 'discover', discoverArgs, ok({ found: [] }));
    settleCall('setup', null, 'readPassport', [passportTarget], ok({ level: 'supported' }));
    settleCall('multi', null, 'addRobot', [removedCfg], ok(undefined));
    settleCall('multi', null, 'removeRobot', ['rw5'], ok(undefined));
    settleCall('manager', 'rw7', 'listCfgInstances', ['SIO', 'COM'], ok(results.blob));
    settleCall('manager', 'rw7', 'getDiagnostics', [], ok(results.headers));
    settleCall('manager', 'rw7', 'getCfgInstance', ['MOC', 'X', 'y'], ok(results.keyed));
    settleCall('manager', 'rw7', 'getRapidTask', ['T_ROB1'], ok(results.session));
    settleCall('manager', 'rw7', 'getModuleText', ['T_ROB1', 'Cell'], ok(results.rapid));
    settleCall('manager', 'rw7', 'getMastershipStatus', ['rapid'], ok(results.mastership));
    settleCall('manager', 'rw7', 'getWriteAccessStatus', [], ok(results.writeAccess));
    settleCall('manager', 'rw7', 'refresh', [], fail(new RwsError(
      `login failed: Digest username="${USER}", realm="r", nonce="n", response="${secrets.digest}"`, 'AUTH_FAILED', 401, undefined, -1,
      `bad login for ${PW} from https://admin:${secrets.url}@127.0.0.1/`)));
    sink.sub('rw7', { resource: '/rw/x', value: `Set-Cookie: ABBCX=${secrets.cookie2}; path=/`, timestamp: new Date(0) });
    sink.sub('rw7', { resource: '/rw/y', value: `seen ${secrets.disc} and ${secrets.removed}`, timestamp: new Date(0) });
    sink.state('rw7', managerOf(state));
    s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventTitle: `User logged in with ${PW} rejected` }), ['events']);
    s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventTitle: `passport ${secrets.passport} used` }), ['events']);

    // Force a rotation (the resync snapshot is taken when it begins), then secrets again in the second part.
    let deltas = 2;
    const snapshotsBefore = s.observer.snapshotCalls;
    while (s.observer.snapshotCalls === snapshotsBefore && deltas < 20) {
      s.clock.advance(100);
      s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventDescription: `${spaces(300_000)} ${PW} end` }), ['events']);
      deltas++;
    }
    for (let i = 0; i < 200 && s.recorder.status().files.length < 2; i++) { await new Promise(resolve => setTimeout(resolve, 25)); }
    expect(s.recorder.status().files).toHaveLength(2);
    state.qualityReason = `quoted ${secrets.removed} after removal`;
    sink.state('rw7', managerOf(state));
    settleCall('manager', 'rw7', 'getCfgInstance', ['MOC', 'X', 'z'], ok({ note: `again ${PW} and ${secrets.token}` }));
    s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventTitle: `token ${secrets.token} shown` }), ['events']);
    deltas++;
    const status = await s.recorder.stop();

    // The raw bytes of every part.
    const names = (await readdir(dir)).filter(n => n.endsWith('.jsonl')).sort();
    expect(names).toEqual(['rec-20261004T153012Z-proof-p0001.jsonl', 'rec-20261004T153012Z-proof-p0002.jsonl']);
    const raw = await Promise.all(names.map(n => readFile(join(dir, n), 'utf8')));
    for (const text of raw) {
      for (const [label, value] of Object.entries(secrets)) { expect(text.includes(value), label).toBe(false); }
      for (const value of encoded) { expect(text.includes(value), value).toBe(false); }
      expect(text).not.toMatch(/Authorization: Basic [A-Za-z0-9+/]/);
    }

    // Header and end counts.
    const parts = raw.map(parseJsonl);
    expect(parts[0]![0]).toMatchObject({ kind: 'header', masking: { values: 2, derived: 3, weakValues: 0 } });
    const lastEnd = parts[1]!.at(-1)!;
    expect(lastEnd).toMatchObject({ kind: 'end', reason: 'stopped', masking: { values: 6, weakValues: 0, refusedLines: 0 } });
    expect((lastEnd.masking as { maskedRecords: number }).maskedRecords).toBeGreaterThan(5);
    expect(status.masking).toEqual(lastEnd.masking);
    expect(parts[1]![0]).toMatchObject({ part: 2, masking: { values: 6 } });

    // Every frame is there: the first snapshot, every delta, the resync snapshot at the rotation.
    const frames = parts.flat().filter(l => l.kind === 'frame');
    expect(frames.filter(f => (f.frame as { type: string }).type === 'delta')).toHaveLength(deltas);
    expect(frames.filter(f => f.resync)).toHaveLength(1);
    const masked = frames.find(f => JSON.stringify(f).includes('User logged in with *** rejected'));
    expect(masked?.masked).toBeGreaterThanOrEqual(1);

    // What the masking left in place.
    const all = raw.join('');
    expect(all).toContain('"result":{"session":"[object HttpSessionLike]"}');
    expect(all).toContain('VAR string ftpPassword := \\"***\\";');
    expect(all).toContain('VAR num count := 2026;');
    expect(all).toContain(`"args":["127.0.0.1","${USER}","***",9403,true]`);   // user names are kept
    expect(all).toContain('"username":"u9","password":"***"');
    // The status reads are recorded, a holder by name only: no user id, no station id.
    expect(all).toContain('"method":"getMastershipStatus","args":["rapid"]');
    expect(all).toContain('"result":{"mastership":"remote","application":"RobotStudio"},"masked":1}');
    expect(all).toContain('"heldByName":"RobotStudio","heldById":"***","externalControlEnabled":true},"masked":1}');

    // Nothing handed to the recording was changed.
    expect({ configs, removedCfg, discoverArgs, passportTarget, results: { ...results, session: null }, state: { ...state, qualityReason: kept.state.qualityReason } })
      .toEqual(kept);
    expect(results.session.session.password).toBe(PW);

    // The folder and every part are the current account's alone; the markers are there.
    for (const n of names) { expect(await ownerOnlyProblem(join(dir, n))).toBeNull(); }
    expect((await readdir(dir)).sort()).toEqual(['.gitignore', 'README.txt', ...names].sort());
  });

  it('a weak numeric password changes no time, number or frame, and is counted', async () => {
    const s = setup({ configs: [cfg('rw7', '2026')] });
    await s.recorder.start({});
    const sent = [
      s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventTitle: 'code 2026 at 2026-10-04' }), ['events', 'motion']),
      s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', speed: 2026 }), ['panel']),
    ];
    s.sink().state('rw7', managerOf(stateOf({ speedRatio: 2026, qualityReason: 'since 2026' })));
    const status = await s.recorder.stop();
    expect(status.masking.weakValues).toBe(1);
    const text = s.files.texts()[0]!;
    const lines = parseJsonl(text);
    expect(lines[0]).toMatchObject({ masking: { weakValues: 1 } });
    for (const f of sent) { expect(text).toContain(`"frame":${f}}`); }
    expect(lines.filter(l => l.kind === 'frame')).toHaveLength(3);
    expect(lines.some(l => 'masked' in l)).toBe(false);
    expect(text).toContain('"speedRatio":2026');
    const warn = s.log.entries.find(e => e.level === 'warn');
    expect(warn?.obj).toEqual({ controller: 'rw7', weakValues: 1 });
    expect(s.log.text()).not.toContain('"2026"');
  });

  it('a password that is a word in the controllers\' own texts is weak: that text stays as it is', async () => {
    const snap = snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventTitle: 'Motors ON state reached' });
    const s = setup({ configs: [cfg('rw7', 'Motors ON state')], snapshots: [snap] });
    await s.recorder.start({});
    const again = s.observer.delta(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', eventTitle: 'Motors ON state reached' }), ['events']);
    const status = await s.recorder.stop();
    expect(status.masking.weakValues).toBe(1);
    const text = s.files.texts()[0]!;
    expect(text).toContain(`"frame":${again}}`);
    expect(text).toContain('Motors ON state reached');
    expect(parseJsonl(text).some(l => 'masked' in l)).toBe(false);
  });
});

describe('the recordings folder', () => {
  it('a part name that exists already makes the start fail, and nothing is overwritten', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daemon-rec-'));
    const dir = join(root, 'recordings');
    const s = setup({ dir, files: realRecordingFiles() });
    await s.recorder.start({});
    await s.recorder.stop();
    const name = 'rec-20261004T153012Z-p0001.jsonl';
    const before = await readFile(join(dir, name), 'utf8');
    await expect(s.recorder.start({})).rejects.toBeInstanceOf(RecordingFailedError);
    expect(s.recorder.status().error).toMatch(/already exists/);
    expect(await readFile(join(dir, name), 'utf8')).toBe(before);
    expect((await readdir(dir)).filter(n => n.includes('.tmp'))).toEqual([]);
  });
});

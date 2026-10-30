import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IO_LEASE_MS } from '../src/io.js';
import { MOTION_HZ_POLLING, MOTION_LEASE_MS } from '../src/motion.js';
import { NotRecordedError, ReplayModeError } from '../src/recording/contract.js';
import { NOT_IN_RECORDING, ReplayFleet } from '../src/replay/fleet.js';
import { parseRecording } from '../src/replay/reader.js';
import { ReplayStream, type ReplaySocketHub, type ReplayStreamOptions } from '../src/replay/stream.js';
import { NEW_LEASE, RAPID_VALUE_RESOURCE, WATCH_LEASES_MAX, type ControllerEvent, type RapidSymbolValue } from '../src/schema/v0.js';
import type { SocketLike } from '../src/wsHub.js';

const START = '2026-10-04T15:30:12.000Z';
const START_MS = Date.parse(START);
const at = (t: number) => new Date(START_MS + t).toISOString();
const WALL0 = Date.parse('2026-10-05T08:00:00.000Z');

const header = () => ({
  kind: 'header', format: 'abb-rws-recording', formatVersion: 1, schemaVersion: '0.12', source: 'daemon',
  session: 'rec-20261004T153012Z-fleet', part: 1, previous: null, startedAt: START, sessionStartedAt: START, label: 'fleet',
  content: ['frames', 'calls', 'state'], daemon: { version: '0.1.0-dev' }, client: { version: '1.4.0' }, controllers: [], limits: null,
  masking: { rules: [], values: 0, derived: 0, weakValues: 0 },
});

const ev = (seq: number): ControllerEvent => ({
  seq, seqnum: seq, code: 10_000 + seq, severity: 'info', title: `Event ${seq}`, titleFromCode: false, description: null, causes: null,
  consequences: null, actions: null, args: [], source: null, time: { raw: '2026-10-04 T 17:30:12', utc: at(seq), corrected: true },
  receivedAt: at(seq), backlog: false,
});

function ctrl(id: string, o: { speed?: number; quality?: string; io?: string[]; targetHz?: number | null; events?: ControllerEvent[]; lastSeq?: number } = {}) {
  return {
    id, name: id.toUpperCase(), identity: null,
    link: {
      connected: true, quality: o.quality ?? 'live', qualityReason: 'ok', since: at(0), host: '127.0.0.1', port: 9403, useHttps: true,
      subscriptions: { active: true }, identityCheck: { status: 'confirmed', expected: null, actual: null }, reconnect: null,
    },
    panel: { ctrlState: 'motoron', opMode: 'AUTO', speedRatio: o.speed ?? 100, collisionDetection: null, asOf: at(0) },
    rapid: { execState: 'stopped', cycle: 'once', tasks: [], asOf: at(0) },
    motion: { watching: o.targetHz != null, units: [], rate: { targetHz: o.targetHz ?? null, achievedHz: null, via: o.targetHz != null ? 'poll' : null }, asOf: null },
    io: { watching: (o.io ?? []).length > 0, signals: (o.io ?? []).map(name => ({ name, type: 'DO', value: '0', via: 'poll', asOf: at(0), error: null })), asOf: null },
    events: {
      feed: 'feed-a', lastSeq: o.lastSeq ?? o.events?.at(-1)?.seq ?? 0, recent: o.events ?? [], via: 'poll',
      clock: { offsetMs: 0, measuredAt: at(0), problem: null }, asOf: at(0), error: null,
    },
  };
}

const snap = (t: number, controllers: unknown[]) => ({ kind: 'frame', t, frame: { type: 'snapshot', schemaVersion: '0.12', observedAt: at(t), controllers } });
const delta = (t: number, id: string, groups: Record<string, unknown>) =>
  ({ kind: 'frame', t, frame: { type: 'delta', observedAt: at(t), id, name: id.toUpperCase(), groups } });
let seq = 0;
const call = (t: number, method: string, args: unknown[], outcome: { result?: unknown; error?: unknown } = {}, id = 'rw7') => ({
  kind: 'call', t, target: 'manager', id, gen: 'rws2', seq: ++seq, method, args, ms: 12,
  ok: outcome.error === undefined, ...(outcome.error === undefined ? { result: outcome.result } : { error: outcome.error }),
});
const state = (t: number, extra: Record<string, unknown>, id = 'rw7') => ({ kind: 'state', t, id, ...extra });
const sig = (name: string, value = '0') => ({ name, value, type: 'DO', lvalue: value });

class FakeHub implements ReplaySocketHub {
  sent: string[] = [];
  attach(socket: SocketLike, first: string): boolean { socket.send(first); return true; }
  detach(): void {}
  broadcast(frame: string): void { this.sent.push(frame); }
  closeAll(): void {}
  close(): void {}
}

const jsonl = (lines: unknown[]) => lines.map(l => JSON.stringify(l)).join('\n') + '\n';

/**
 * A recording: rw7 and rw6 from the start; module source read twice; the
 * signal table loaded at 40 and changed at 2000; a search; motion watched
 * from 1500; do9 watched only near the end; a removal of rw6 at 4000.
 */
const RECORDING = [
  snap(0, [ctrl('rw7', { io: ['do1'], events: [ev(1), ev(2)] }), ctrl('rw6', { quality: 'polling' })]),
  state(40, { full: true, changed: { connected: true, ioSignalsLoaded: true }, manager: { port: 9403, useHttps: true, groupPath: '/subscription/5' } }),
  state(41, { full: true, ioSignals: { chunk: 1, chunks: 1, full: [sig('do1'), sig('do2')] } }),
  state(42, { full: true, changed: { connected: true, ioSignalsLoaded: false } }, 'rw6'),
  call(500, 'listModulesDetailed', ['T_ROB1'], { result: [{ name: 'Main', type: 'ProgMod' }, { name: 'Base', type: 'SysMod' }] }),
  call(510, 'getModuleText', ['T_ROB1', 'Main'], { result: { text: 'MODULE Main\nENDMODULE', changeCount: 3 } }),
  call(600, 'searchSignals', [{ name: 'do', type: 'DO' }], { result: [sig('do1'), sig('do2')] }),
  call(700, 'searchSignals', [{ name: 'big' }], { result: [sig('big1'), { $truncated: 4000 }] }),
  delta(1000, 'rw7', { panel: ctrl('rw7', { speed: 40 }).panel }),
  delta(1500, 'rw7', { motion: ctrl('rw7', { targetHz: 8 }).motion }),
  state(2000, { ioSignals: { added: [sig('do3')], changed: [sig('do1', '1')], removed: ['do2'] } }),
  call(2100, 'getModuleText', ['T_ROB1', 'Main'], { result: { text: 'MODULE Main\n  ! v2\nENDMODULE', changeCount: 4 } }),
  call(2200, 'getModuleText', ['T_ROB1', 'Gone'], { error: { code: 'RESOURCE_NOT_FOUND', message: 'no such module' } }),
  call(2300, 'getRapidVariable', ['T_ROB1', 'Main', 'partPresent'], { result: 'FALSE' }),
  call(2310, 'getRapidVariable', ['T_ROB1', 'Main', 'bigArray'], { result: '' }),
  call(2320, 'getRapidVariable', ['T_ROB1', 'Main', 'gone'], { error: { code: 'RESOURCE_NOT_FOUND', message: 'Symbol not found' } }),
  call(2330, 'getRapidVariable', ['T_ROB1', 'Main', 'ftpPassword'], { result: { $omitted: 'secret' } }),
  call(2340, 'getRapidVariable', ['T_ROB1', 'user', 'reg1'], { result: '0' }, 'rw6'),
  delta(2500, 'rw7', { events: ctrl('rw7', { events: [ev(5), ev(6)] }).events }),
  delta(3000, 'rw7', { motion: ctrl('rw7').motion, io: ctrl('rw7', { io: ['do1', 'do9'] }).io }),
  { kind: 'gap', t: 3500, why: 'writer-behind', kinds: { call: 0, state: 2, sub: 0 } },
  { kind: 'frame', t: 4000, frame: { type: 'removed', observedAt: at(4000), id: 'rw6' } },
];

function setup(opts: ReplayStreamOptions = {}) {
  const rec = parseRecording([{ name: 'rec-20261004T153012Z-fleet-p0001.jsonl', text: jsonl([header(), ...RECORDING]) }]);
  const stream = new ReplayStream(rec, new FakeHub(), { paused: true, monoNow: () => Date.now(), ...opts });
  const fleet = new ReplayFleet(stream, rec.index);
  /** Step to the frame recorded at `t`. */
  const stepTo = (t: number) => { while (stream.positionMs() < t) { stream.control({ action: 'step' }); } };
  return { rec, stream, fleet, stepTo };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(WALL0); });
afterEach(() => { vi.useRealTimers(); });

describe('ReplayFleet: controllers', () => {
  it('lists and gets the replay\'s state at the position; has() follows it; no configuration', () => {
    const { fleet, stepTo } = setup({ time: 'recorded' });
    expect(fleet.list().map(c => [c.id, c.panel.speedRatio])).toEqual([['rw7', 100], ['rw6', 100]]);
    stepTo(1000);
    expect(fleet.get('rw7')?.panel.speedRatio).toBe(40);
    expect(fleet.has('rw6')).toBe(true);
    expect(fleet.get('nobody')).toBeNull();
    stepTo(4000);
    expect(fleet.has('rw6')).toBe(false);
    expect(fleet.list().map(c => c.id)).toEqual(['rw7']);
    expect(fleet.all()).toEqual([]);
  });

  it('answers are copies: changing one changes nothing the replay holds', () => {
    const { fleet, stream } = setup();
    fleet.get('rw7')!.panel.speedRatio = 1;
    fleet.list()[0].events.recent.length = 0;
    expect(stream.state.get('rw7')?.panel.speedRatio).toBe(100);
    expect(stream.state.get('rw7')?.events.recent).toHaveLength(2);
  });

  it('times as the replay serves them: shifted to now, or as recorded; now() stamps a list answer', () => {
    const shifted = setup();
    shifted.stepTo(1000);
    expect(shifted.fleet.get('rw7')?.panel.asOf).toBe(new Date(WALL0 - 1000).toISOString());   // recorded at 0, the position is 1000
    expect(shifted.fleet.now()).toBe(WALL0);
    const recorded = setup({ time: 'recorded' });
    recorded.stepTo(1000);
    expect(recorded.fleet.get('rw7')?.panel.asOf).toBe(at(0));
    expect(recorded.fleet.now()).toBe(START_MS + 1000);
  });

  it('adding or removing a controller is refused REPLAY_MODE; the stop finds nothing to log out of', async () => {
    const { fleet } = setup();
    expect(() => fleet.add({ id: 'x', name: 'x', host: '127.0.0.1', port: 80, useHttps: false, username: 'u', password: 'p' }))
      .toThrow(ReplayModeError);
    await expect(fleet.remove('rw7')).rejects.toBeInstanceOf(ReplayModeError);
    await expect(fleet.disconnectAll({ waitMs: 1000 })).resolves.toEqual([]);
    expect(new ReplayModeError().code).toBe('REPLAY_MODE');
  });

  it('onChanged names every controller a frame touched (StreamSource)', () => {
    const { fleet, stream, stepTo } = setup();
    const changed: string[] = [];
    fleet.onChanged(id => changed.push(id));
    stepTo(1000);
    stream.control({ action: 'restart' });
    expect(changed).toEqual(['rw7', 'rw7', 'rw6', 'rw7', 'rw6']);
  });
});

describe('ReplayFleet: module source', () => {
  it('the last recorded read at or before the position, with its kind from the module listing', async () => {
    const { fleet, stepTo } = setup();
    await expect(fleet.moduleSource('rw7', 'T_ROB1', 'Main')).rejects.toBeInstanceOf(NotRecordedError);   // position 0: not read yet
    stepTo(1000);
    expect(await fleet.moduleSource('rw7', 'T_ROB1', 'Main')).toEqual({
      task: 'T_ROB1', module: 'Main', kind: 'program', text: 'MODULE Main\nENDMODULE', changeCount: 3,
    });
    stepTo(2500);
    expect((await fleet.moduleSource('rw7', 'T_ROB1', 'Main'))?.changeCount).toBe(4);
  });

  it('a module never read, or whose last read failed: NOT_RECORDED; an unknown controller: null', async () => {
    const { fleet, stepTo } = setup();
    stepTo(2500);
    const err: unknown = await fleet.moduleSource('rw7', 'T_ROB1', 'Other').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotRecordedError);
    expect((err as NotRecordedError).code).toBe('NOT_RECORDED');
    await expect(fleet.moduleSource('rw7', 'T_ROB1', 'Gone')).rejects.toThrow(/last read failed/);
    expect(await fleet.moduleSource('nobody', 'T_ROB1', 'Main')).toBeNull();
  });
});

describe('ReplayFleet: RAPID values', () => {
  it('the last recorded read at or before the position, with the resource of its generation and the time it was read', async () => {
    const { fleet, stepTo } = setup({ time: 'recorded' });
    await expect(fleet.rapidSymbol('rw7', 'T_ROB1', 'Main', 'partPresent')).rejects.toBeInstanceOf(NotRecordedError);
    stepTo(2500);
    expect(await fleet.rapidSymbol('rw7', 'T_ROB1', 'Main', 'partPresent')).toEqual({
      task: 'T_ROB1', module: 'Main', symbol: 'partPresent', value: 'FALSE', truncated: false,
      resource: RAPID_VALUE_RESOURCE.rws2, readAt: at(2300),
    });
  });

  it('the read time moves with a shifted replay, as every other time does', async () => {
    const { fleet, stepTo } = setup();
    stepTo(2500);
    expect((await fleet.rapidSymbol('rw7', 'T_ROB1', 'Main', 'partPresent')) as RapidSymbolValue)
      .toMatchObject({ readAt: new Date(WALL0 - (2500 - 2300)).toISOString() });
  });

  it('a read with no value text is no-value, as live; a failed, never made or left-out read is NOT_RECORDED; an unknown controller is null', async () => {
    const { fleet, stepTo } = setup();
    stepTo(2500);
    expect(await fleet.rapidSymbol('rw7', 'T_ROB1', 'Main', 'bigArray')).toBe('no-value');
    await expect(fleet.rapidSymbol('rw7', 'T_ROB1', 'Main', 'gone')).rejects.toThrow(/last read failed/);
    await expect(fleet.rapidSymbol('rw7', 'T_ROB1', 'Main', 'never')).rejects.toBeInstanceOf(NotRecordedError);
    await expect(fleet.rapidSymbol('rw7', 'T_ROB1', 'Main', 'ftpPassword')).rejects.toThrow(/left out/);
    expect(await fleet.rapidSymbol('nobody', 'T_ROB1', 'Main', 'partPresent')).toBeNull();
  });
});

describe('ReplayFleet: the signal table and searches', () => {
  it('no criteria: the client\'s table as recorded at the position', async () => {
    const { fleet, stepTo } = setup();
    await expect(fleet.searchIoSignals('rw7', {})).rejects.toBeInstanceOf(NotRecordedError);   // before the first state record
    stepTo(1000);
    expect(await fleet.searchIoSignals('rw7', {})).toEqual([sig('do1'), sig('do2')]);
    expect(await fleet.searchIoSignals('rw7', { name: '' })).toEqual([sig('do1'), sig('do2')]);
    stepTo(2500);
    expect(await fleet.searchIoSignals('rw7', {})).toEqual([sig('do1', '1'), sig('do3')]);
  });

  it('not loaded on the connection then: not-loaded (503 NOT_READY, as live)', async () => {
    const { fleet, stepTo } = setup();
    stepTo(1000);
    expect(await fleet.searchIoSignals('rw6', {})).toBe('not-loaded');
  });

  it('after a gap that left state records out: NOT_RECORDED, never the older table', async () => {
    const { fleet, stepTo } = setup();
    stepTo(4000);
    await expect(fleet.searchIoSignals('rw7', {})).rejects.toBeInstanceOf(NotRecordedError);
  });

  it('with criteria: a recorded search with equal criteria (in any order), else NOT_RECORDED; a search cut short is not an answer', async () => {
    const { fleet, stepTo } = setup();
    stepTo(1000);
    expect(await fleet.searchIoSignals('rw7', { type: 'DO', name: 'do' })).toEqual([sig('do1'), sig('do2')]);
    await expect(fleet.searchIoSignals('rw7', { name: 'do' })).rejects.toBeInstanceOf(NotRecordedError);
    await expect(fleet.searchIoSignals('rw7', { name: 'big' })).rejects.toBeInstanceOf(NotRecordedError);
    expect(await fleet.searchIoSignals('nobody', { name: 'do' })).toBeNull();
  });
});

describe('ReplayFleet: watches are granted as live and change nothing', () => {
  it('motion: the lease as live, the target rate as last recorded (else by link quality), lease ids minted the same way', () => {
    const { fleet, stream, stepTo } = setup();
    const before = JSON.stringify(stream.state.list());
    expect(fleet.watchMotion('rw7')).toEqual({ leaseMs: MOTION_LEASE_MS, targetHz: 8 });   // no rate recorded yet: live link, 8 Hz
    expect(fleet.watchMotion('rw6')).toEqual({ leaseMs: MOTION_LEASE_MS, targetHz: MOTION_HZ_POLLING });
    const own = fleet.watchMotion('rw7', NEW_LEASE);
    expect(own).toMatchObject({ leaseMs: MOTION_LEASE_MS, leaseId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(fleet.watchMotion('rw7', (own as { leaseId: string }).leaseId)).toEqual(own);
    expect(JSON.stringify(stream.state.list())).toBe(before);
    stepTo(3000);   // the watch ran from 1500 to 3000 at 8 Hz
    expect(fleet.watchMotion('rw7')).toMatchObject({ targetHz: 8 });
    expect(fleet.watchMotion('nobody')).toBeNull();
  });

  it('motion: one lease more than a controller may hold is refused, as live; a lapsed one frees its place', () => {
    const { fleet } = setup();
    for (let i = 1; i < WATCH_LEASES_MAX; i++) { expect(fleet.watchMotion('rw7', NEW_LEASE)).not.toBe('lease-limit'); }
    expect(fleet.watchMotion('rw7', NEW_LEASE)).not.toBe('lease-limit');
    expect(fleet.watchMotion('rw7', NEW_LEASE)).toBe('lease-limit');
    vi.setSystemTime(WALL0 + MOTION_LEASE_MS + 1);
    expect(fleet.watchMotion('rw7', NEW_LEASE)).not.toBe('lease-limit');
  });

  it('I/O: accepts the signals the recording\'s io group carries anywhere, refuses the others', () => {
    const { fleet, stream } = setup();
    const before = JSON.stringify(stream.state.list());
    expect(fleet.watchIo('rw7', ['do1', 'do9', 'do2', 'do1'])).toEqual({
      leaseMs: IO_LEASE_MS, accepted: ['do1', 'do9'], rejected: [{ name: 'do2', reason: NOT_IN_RECORDING }],
    });
    expect(NOT_IN_RECORDING).toBe('not in this recording');
    expect(fleet.watchIo('rw7', ['do1'], NEW_LEASE)).toMatchObject({ accepted: ['do1'], leaseId: expect.any(String) });
    expect(fleet.watchIo('rw6', ['do1'])).toMatchObject({ accepted: [], rejected: [{ name: 'do1', reason: NOT_IN_RECORDING }] });
    expect(fleet.watchIo('nobody', ['do1'])).toBeNull();
    expect(JSON.stringify(stream.state.list())).toBe(before);
  });
});

describe('ReplayFleet: events', () => {
  it('a page from every event the recording carried, gap where it never carried some; times and feed as served', () => {
    const { fleet, stream, stepTo } = setup({ time: 'recorded' });
    stepTo(2500);
    const page = fleet.events('rw7', undefined, 50)!;
    expect(page).toMatchObject({ feed: 'feed-a', firstSeq: 1, lastSeq: 6, gap: true, more: false });
    expect(page.events.map(e => e.seq)).toEqual([1, 2, 5, 6]);
    expect(page.events[0].receivedAt).toBe(at(1));
    expect(fleet.events('rw7', 2, 50)).toMatchObject({ gap: true });
    expect(fleet.events('rw7', 4, 50)).toMatchObject({ gap: false });
    expect(fleet.events('nobody', undefined, 50)).toBeNull();
    stream.control({ action: 'restart' });
    expect(fleet.events('rw7', undefined, 50)).toMatchObject({ feed: 'feed-a~loop1', lastSeq: 2 });
  });

  it('shifted: event times as old as they were at the position', () => {
    const { fleet, stepTo } = setup();
    stepTo(1000);
    expect(fleet.events('rw7', undefined, 1)!.events[0].receivedAt).toBe(new Date(WALL0 - 1000 + 2).toISOString());
  });
});

import { describe, it, expect } from 'vitest';
import { IoTableTimeline, ReplayState } from '../src/replay/state.js';
import { EVENTS_KEEP_MAX, type ControllerEvent, type ControllerSnapshot, type LinkQuality } from '../src/schema/v0.js';

const START_MS = Date.parse('2026-10-04T15:30:12.000Z');
const at = (t: number) => new Date(START_MS + t).toISOString();

function ev(seq: number, t = seq * 100, over: Partial<ControllerEvent> = {}): ControllerEvent {
  return {
    seq, seqnum: 500 + seq, code: 10_000 + seq, severity: 'info', title: `Event ${seq}`, titleFromCode: false,
    description: null, causes: null, consequences: null, actions: null, args: [], source: null,
    time: { raw: '2026-10-04 T 17:30:12', utc: at(t), corrected: true }, receivedAt: at(t), backlog: false, ...over,
  };
}

function ctrl(id: string, t = 0, o: { name?: string; speed?: number; quality?: LinkQuality; feed?: string | null; events?: ControllerEvent[]; lastSeq?: number; targetHz?: number | null } = {}): ControllerSnapshot {
  const events = o.events ?? [];
  return {
    id, name: o.name ?? id.toUpperCase(), identity: null,
    link: {
      connected: true, quality: o.quality ?? 'live', qualityReason: 'ok', since: at(0), downSince: null, host: '127.0.0.1', port: 9403, useHttps: true,
      subscriptions: { active: true }, identityCheck: { status: 'confirmed', expected: null, actual: null }, reconnect: null,
    },
    panel: { ctrlState: 'motoron', opMode: 'AUTO', speedRatio: o.speed ?? 100, collisionDetection: null, asOf: at(t) },
    rapid: { execState: 'stopped', cycle: 'once', tasks: [], asOf: at(t) },
    motion: { watching: o.targetHz != null, units: [], rate: { targetHz: o.targetHz ?? null, achievedHz: null, via: o.targetHz != null ? 'poll' : null }, asOf: null },
    io: { watching: false, signals: [], asOf: null },
    events: {
      feed: o.feed === undefined ? 'feed-a' : o.feed, lastSeq: o.lastSeq ?? events.at(-1)?.seq ?? 0, recent: events, via: 'subscription',
      clock: { offsetMs: 0, measuredAt: at(0), problem: null }, asOf: at(t), error: null,
    },
    access: {
      generation: 'rw7', model: 'mastership',
      locks: [
        { lock: 'edit', held: false, holder: null, heldByDaemon: false, reported: 'nomaster', asOf: at(t), error: null },
        { lock: 'motion', held: true, holder: { kind: 'remote', name: null, application: 'RobotStudio', flexPendant: false }, heldByDaemon: false, reported: 'remote', asOf: at(t), error: null },
      ],
      remoteAccessEnabled: null, rmmp: { supported: true, privilege: 'none', asOf: at(t), error: null }, via: 'poll', problem: null, asOf: at(t),
    },
    capabilities: {
      protocol: 'rws2', generation: 'rw7', robotWare: null, tested: null,
      entries: [{ id: 'status-push', state: 'available', reason: null }, { id: 'write-access', state: 'unavailable', reason: 'RobotWare 6 and 7 use mastership' }],
      asOf: at(t),
    },
    freshness: { level: 'current', reasons: [], groups: [{ group: 'panel', state: 'current', asOf: at(t), reason: null }] },
  };
}

/** The same controller as a daemon before schema 0.13 served it: without the three groups and `link.downSince`. */
function before013(c: ControllerSnapshot): ControllerSnapshot {
  const { access: _a, capabilities: _c, freshness: _f, ...older } = c;
  const { downSince: _d, ...link } = older.link;
  return { ...older, link } as unknown as ControllerSnapshot;
}

const snapshot = (t: number, controllers: ControllerSnapshot[], schemaVersion = '0.13') => ({ type: 'snapshot', schemaVersion, observedAt: at(t), controllers });
const delta = (t: number, id: string, groups: Record<string, unknown>, name = id.toUpperCase()) => ({ type: 'delta', observedAt: at(t), id, name, groups });
const removed = (t: number, id: string) => ({ type: 'removed', observedAt: at(t), id });
/** A fresh copy, as the replay hands every frame to the state. */
const fresh = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('ReplayState: applying frames as a consumer does', () => {
  it('a snapshot replaces everything, in its order', () => {
    const s = new ReplayState();
    expect(s.apply(fresh(snapshot(0, [ctrl('rw6'), ctrl('rw7')])))).toEqual(['rw6', 'rw7']);
    expect(s.apply(fresh(snapshot(10, [ctrl('rw8'), ctrl('rw7', 10, { speed: 50 })])))).toEqual(['rw6', 'rw7', 'rw8']);
    expect(s.ids()).toEqual(['rw8', 'rw7']);
    expect(s.get('rw7')?.panel.speedRatio).toBe(50);
    expect(s.has('rw6')).toBe(false);
  });

  it('a delta replaces each group it names whole and updates the name; other groups stay', () => {
    const s = new ReplayState();
    s.apply(fresh(snapshot(0, [ctrl('rw7')])));
    const before = fresh(s.get('rw7'));
    const panel = { ctrlState: 'motoroff', opMode: 'MANR', speedRatio: null, collisionDetection: null, asOf: at(5) };
    expect(s.apply(fresh(delta(5, 'rw7', { panel }, 'Renamed')))).toEqual(['rw7']);
    const after = s.get('rw7')!;
    expect(after.panel).toEqual(panel);
    expect(after.name).toBe('Renamed');
    expect(after.link).toEqual(before!.link);
    expect(after.rapid).toEqual(before!.rapid);
  });

  it('a delta for an unknown controller adds it; groups it did not carry are unread, in wire order', () => {
    const s = new ReplayState();
    s.apply(fresh(snapshot(0, [ctrl('rw7')])));
    const whole = ctrl('rw8', 20);
    const { id: _id, name: _name, ...groups } = whole;
    s.apply(fresh(delta(20, 'rw8', groups)));
    expect(s.get('rw8')).toEqual(whole);
    s.apply(fresh(delta(30, 'rw9', { panel: whole.panel })));
    const partial = s.get('rw9')!;
    expect(Object.keys(partial)).toEqual(['id', 'name', 'identity', 'link', 'panel', 'rapid', 'motion', 'io', 'events', 'access', 'capabilities', 'freshness']);
    expect(partial.panel).toEqual(whole.panel);
    expect(partial.link.quality).toBe('disconnected');
    expect(partial.events.recent).toEqual([]);
    // The link of a controller never reached: down since the frame that introduced it.
    expect(partial.link).toMatchObject({ connected: false, since: at(30), downSince: at(30) });
    expect(Object.keys(partial.link).slice(0, 5)).toEqual(['connected', 'quality', 'qualityReason', 'since', 'downSince']);
    // Nothing read: no generation, no lock, no value that could pass for an answer of the controller.
    expect(partial.access).toEqual({
      generation: null, model: null, locks: [], remoteAccessEnabled: null,
      rmmp: { supported: null, privilege: null, asOf: null, error: null }, via: null, problem: null, asOf: null,
    });
    expect(partial.capabilities).toMatchObject({ protocol: null, generation: null, robotWare: null, tested: null, asOf: null });
    expect(partial.capabilities.entries.map(e => e.id)).toEqual([
      'status-push', 'events-push', 'event-times', 'io-push', 'io-table', 'joint-limits', 'mastership', 'write-access', 'rmmp',
    ]);
    expect(partial.capabilities.entries.every(e => e.state === 'unknown' && e.reason === 'not connected')).toBe(true);
    expect(partial.freshness.level).toBe('down');
    expect(partial.freshness.reasons).toEqual(['link: not connected']);
    expect(partial.freshness.groups.map(g => [g.group, g.state, g.asOf])).toEqual([
      ['identity', 'unread', null], ['panel', 'unread', null], ['rapid', 'unread', null], ['motion', 'idle', null], ['io', 'idle', null],
      ['events', 'unread', null], ['access', 'unread', null],
    ]);
    expect(partial.freshness.groups.every(g => typeof g.reason === 'string' && g.reason.length > 0)).toBe(true);
  });

  it('a partial delta that carries one of the groups of schema 0.13 keeps it and fills the rest', () => {
    const s = new ReplayState();
    s.apply(fresh(snapshot(0, [ctrl('rw7')])));
    const whole = ctrl('rw8', 20);
    s.apply(fresh(delta(20, 'rw8', { freshness: whole.freshness, access: whole.access })));
    const got = s.get('rw8')!;
    expect(Object.keys(got)).toEqual(['id', 'name', 'identity', 'link', 'panel', 'rapid', 'motion', 'io', 'events', 'access', 'capabilities', 'freshness']);
    expect(got.access).toEqual(whole.access);
    expect(got.freshness).toEqual(whole.freshness);
    expect(got.capabilities.entries).toHaveLength(9);
    expect(got.panel.asOf).toBeNull();
  });

  it('a recording made before schema 0.13 stays as recorded: a controller it adds gets no group that version lacked', () => {
    const s = new ReplayState();
    s.apply(fresh(snapshot(0, [before013(ctrl('rw7'))], '0.12')));
    expect(Object.keys(s.get('rw7')!)).toEqual(['id', 'name', 'identity', 'link', 'panel', 'rapid', 'motion', 'io', 'events']);
    // A controller added while it was recorded: its first delta carries every group that version had.
    const whole = before013(ctrl('rw8', 20));
    const { id: _id, name: _name, ...groups } = whole;
    s.apply(fresh(delta(20, 'rw8', groups)));
    expect(s.get('rw8')).toEqual(whole);
    expect(Object.keys(s.get('rw8')!)).toEqual(['id', 'name', 'identity', 'link', 'panel', 'rapid', 'motion', 'io', 'events']);
    expect(s.get('rw8')!.link).not.toHaveProperty('downSince');
    // A partial one is filled with that version's groups, unread, and nothing newer.
    s.apply(fresh(delta(30, 'rw9', { panel: whole.panel })));
    const partial = s.get('rw9')!;
    expect(Object.keys(partial)).toEqual(['id', 'name', 'identity', 'link', 'panel', 'rapid', 'motion', 'io', 'events']);
    expect(partial.link).toMatchObject({ connected: false, quality: 'disconnected', since: at(30) });
    expect(partial.link).not.toHaveProperty('downSince');
    expect(JSON.stringify(s.list())).not.toMatch(/"access"|"capabilities"|"freshness"|"downSince"/);
    // A later snapshot of the daemon's own version turns the filling on again; so does starting over.
    s.apply(fresh(snapshot(40, [ctrl('rw7', 40)])));
    s.apply(fresh(delta(50, 'rw9', { panel: whole.panel })));
    expect(Object.keys(s.get('rw9')!)).toContain('freshness');
    s.apply(fresh(snapshot(60, [before013(ctrl('rw7', 60))], '0.12')));
    s.reset();
    s.apply(fresh(delta(70, 'rw9', { panel: whole.panel })));
    expect(s.get('rw9')!.link.downSince).toBe(at(70));
  });

  it('a snapshot without a readable schema version counts as the daemon`s own', () => {
    for (const version of [undefined, 13, 'v0.12', '']) {
      const s = new ReplayState();
      s.apply(fresh({ type: 'snapshot', schemaVersion: version, observedAt: at(0), controllers: [ctrl('rw7')] }));
      s.apply(fresh(delta(10, 'rw9', { panel: ctrl('rw9').panel })));
      expect(Object.keys(s.get('rw9')!), String(version)).toContain('access');
    }
    // A later minor and a later major carry the groups too.
    for (const version of ['0.13', '0.14', '1.0']) {
      const s = new ReplayState();
      s.apply(fresh(snapshot(0, [ctrl('rw7')], version)));
      s.apply(fresh(delta(10, 'rw9', { panel: ctrl('rw9').panel })));
      expect(Object.keys(s.get('rw9')!), version).toContain('access');
    }
  });

  it('removed drops a controller; an unknown frame type changes nothing', () => {
    const s = new ReplayState();
    s.apply(fresh(snapshot(0, [ctrl('rw6'), ctrl('rw7')])));
    expect(s.apply(fresh(removed(5, 'rw6')))).toEqual(['rw6']);
    expect(s.ids()).toEqual(['rw7']);
    expect(s.apply(fresh(removed(6, 'nobody')))).toEqual([]);
    expect(s.apply({ type: 'hello-from-a-later-daemon', id: 'rw7' })).toEqual([]);
    expect(s.apply('not a frame')).toEqual([]);
    expect(s.ids()).toEqual(['rw7']);
  });

  it('reset forgets everything', () => {
    const s = new ReplayState();
    s.apply(fresh(snapshot(0, [ctrl('rw7', 0, { events: [ev(1)] })])));
    s.reset();
    expect(s.ids()).toEqual([]);
    expect(s.eventsPage('rw7', undefined, 50)).toBeNull();
  });
});

describe('ReplayState: a resync snapshot as the frames that lead to it', () => {
  it('a delta per controller with only the groups that differ, a whole one for a new controller, removed for one it lacks', () => {
    const s = new ReplayState();
    s.apply(fresh(snapshot(0, [ctrl('rw6'), ctrl('rw7')])));
    const resync = fresh(snapshot(100, [ctrl('rw7', 0, { speed: 25 }), ctrl('rw8', 100)]));
    const frames = s.resyncFrames(resync);
    expect(frames).toEqual([
      { type: 'delta', observedAt: at(100), id: 'rw7', name: 'RW7', groups: { panel: ctrl('rw7', 0, { speed: 25 }).panel } },
      { type: 'delta', observedAt: at(100), id: 'rw8', name: 'RW8', groups: (({ id: _i, name: _n, ...g }) => g)(ctrl('rw8', 100)) },
      { type: 'removed', observedAt: at(100), id: 'rw6' },
    ]);
    // A consumer that applies them holds what the snapshot holds.
    const consumer = new ReplayState();
    consumer.apply(fresh(snapshot(0, [ctrl('rw6'), ctrl('rw7')])));
    for (const f of fresh(frames)) { consumer.apply(f); }
    s.apply(resync);
    expect(consumer.list()).toEqual(s.list());
  });

  it('a renamed controller gets a delta with no groups; an identical snapshot gives no frame', () => {
    const s = new ReplayState();
    s.apply(fresh(snapshot(0, [ctrl('rw7')])));
    expect(s.resyncFrames(fresh(snapshot(5, [ctrl('rw7')])))).toEqual([]);
    expect(s.resyncFrames(fresh(snapshot(5, [ctrl('rw7', 0, { name: 'Cell 2' })])))).toEqual([
      { type: 'delta', observedAt: at(5), id: 'rw7', name: 'Cell 2', groups: {} },
    ]);
  });
});

describe('ReplayState: events accumulated for the events route', () => {
  it('keeps every event any frame carried, beyond the recent window, and pages them as live', () => {
    const s = new ReplayState();
    s.apply(fresh(snapshot(0, [ctrl('rw7', 0, { events: [ev(1), ev(2), ev(3)] })])));
    s.apply(fresh(delta(10, 'rw7', { events: ctrl('rw7', 10, { events: [ev(3), ev(4), ev(5)] }).events })));
    const all = s.eventsPage('rw7', undefined, 50)!;
    expect(all.feed).toBe('feed-a');
    expect(all.events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all).toMatchObject({ firstSeq: 1, lastSeq: 5, gap: false, more: false });
    expect(s.eventsPage('rw7', undefined, 2)!.events.map(e => e.seq)).toEqual([4, 5]);
    const page = s.eventsPage('rw7', 1, 2)!;
    expect(page.events.map(e => e.seq)).toEqual([2, 3]);
    expect(page).toMatchObject({ gap: false, more: true });
    expect(s.eventsPage('rw7', 5, 10)).toMatchObject({ events: [], gap: false, more: false });
    expect(s.eventsPage('nobody', undefined, 10)).toBeNull();
  });

  it('says gap where the recording never carried a seq: between events, and right after `since`', () => {
    const s = new ReplayState();
    // 25 events arrived between two frames: recent (at most 20) carried 6..25, never 3..5.
    s.apply(fresh(snapshot(0, [ctrl('rw7', 0, { events: [ev(1), ev(2)] })])));
    const recent = Array.from({ length: 20 }, (_, i) => ev(i + 6));
    s.apply(fresh(delta(10, 'rw7', { events: ctrl('rw7', 10, { events: recent }).events })));
    expect(s.eventsPage('rw7', undefined, 50)).toMatchObject({ gap: true, lastSeq: 25 });
    expect(s.eventsPage('rw7', undefined, 5)).toMatchObject({ gap: false });   // 21..25 are all there
    expect(s.eventsPage('rw7', 2, 50)).toMatchObject({ gap: true });           // 3 is missing
    expect(s.eventsPage('rw7', 5, 50)).toMatchObject({ gap: false });
    expect(s.eventsPage('rw7', 0, 2)!.events.map(e => e.seq)).toEqual([1, 2]);
    // Nothing after `since` was carried although lastSeq says there is more.
    s.apply(fresh(delta(20, 'rw7', { events: ctrl('rw7', 20, { events: recent, lastSeq: 30 }).events })));
    expect(s.eventsPage('rw7', 25, 50)).toMatchObject({ events: [], gap: true, lastSeq: 30 });
  });

  it('the latest carrying of an event wins; a new feed starts over; a removed controller forgets its events', () => {
    const s = new ReplayState();
    s.apply(fresh(snapshot(0, [ctrl('rw7', 0, { events: [ev(1, 100, { time: { raw: 'x', utc: at(1), corrected: false } })] })])));
    s.apply(fresh(delta(10, 'rw7', { events: ctrl('rw7', 10, { events: [ev(1)] }).events })));
    expect(s.eventsPage('rw7', undefined, 10)!.events[0].time.corrected).toBe(true);
    s.apply(fresh(delta(20, 'rw7', { events: ctrl('rw7', 20, { feed: 'feed-b', events: [ev(1, 2000)] }).events })));
    const after = s.eventsPage('rw7', undefined, 10)!;
    expect(after.feed).toBe('feed-b');
    expect(after.events.map(e => e.receivedAt)).toEqual([at(2000)]);
    // A null feed (a link on the wrong controller) carries nothing and keeps what was held.
    s.apply(fresh(delta(30, 'rw7', { events: ctrl('rw7', 30, { feed: null }).events })));
    expect(s.eventsPage('rw7', undefined, 10)!.events).toHaveLength(1);
    s.apply(fresh(removed(40, 'rw7')));
    s.apply(fresh(delta(50, 'rw7', (({ id: _i, name: _n, ...g }) => g)(ctrl('rw7', 50, { feed: 'feed-c' })))));
    expect(s.eventsPage('rw7', undefined, 10)).toMatchObject({ feed: 'feed-c', events: [] });
  });

  it('holds at most EVENTS_KEEP_MAX events per controller, the newest', () => {
    const s = new ReplayState();
    s.apply(fresh(snapshot(0, [ctrl('rw7')])));
    const total = 300;
    for (let first = 1; first <= total; first += 20) {
      const batch = Array.from({ length: 20 }, (_, i) => ev(first + i));
      s.apply(fresh(delta(first, 'rw7', { events: ctrl('rw7', first, { events: batch }).events })));
    }
    const page = s.eventsPage('rw7', undefined, EVENTS_KEEP_MAX)!;
    expect(page.events).toHaveLength(EVENTS_KEEP_MAX);
    expect(page.lastSeq).toBe(total);
    expect(page.firstSeq).toBe(total - EVENTS_KEEP_MAX + 1);
  });

  it('remembers the last motion target rate a frame carried', () => {
    const s = new ReplayState();
    s.apply(fresh(snapshot(0, [ctrl('rw7')])));
    expect(s.lastTargetHz('rw7')).toBeNull();
    s.apply(fresh(delta(10, 'rw7', { motion: ctrl('rw7', 10, { targetHz: 8 }).motion })));
    s.apply(fresh(delta(20, 'rw7', { motion: ctrl('rw7', 20).motion })));   // the watch lapsed: rate null
    expect(s.lastTargetHz('rw7')).toBe(8);
  });
});

const sig = (name: string, value = '0') => ({ name, value, type: 'DO', lvalue: value });

describe('IoTableTimeline: the signal table from chunks and diffs', () => {
  it('a whole table from its chunks, then changed by diffs; each point answers its own table', () => {
    const io = new IoTableTimeline();
    io.apply({ t: 40, id: 'rw7', changed: { connected: true, ioSignalsLoaded: true } });
    io.apply({ t: 41, id: 'rw7', ioSignals: { chunk: 1, chunks: 2, full: [sig('a'), sig('b')] } });
    io.apply({ t: 41, id: 'rw7', ioSignals: { chunk: 2, chunks: 2, full: [sig('c')] } });
    io.apply({ t: 500, id: 'rw7', ioSignals: { added: [sig('d')], changed: [sig('b', '1')], removed: ['a'] } });
    expect(io.at('rw7', 30)).toEqual({ status: 'not-recorded' });
    expect(io.at('rw7', 40)).toEqual({ status: 'not-recorded' });        // loaded, but no table yet
    expect(io.at('rw7', 41)).toEqual({ status: 'ready', signals: [sig('a'), sig('b'), sig('c')] });
    expect(io.at('rw7', 499)).toEqual({ status: 'ready', signals: [sig('a'), sig('b'), sig('c')] });
    expect(io.at('rw7', 500)).toEqual({ status: 'ready', signals: [sig('b', '1'), sig('c'), sig('d')] });
    expect(io.at('rw8', 500)).toEqual({ status: 'not-recorded' });
  });

  it('not loaded on the connection: not-loaded, as live (the client flag first, else a disconnected link)', () => {
    const io = new IoTableTimeline();
    io.apply({ t: 1, id: 'rw7', changed: { connected: true, ioSignalsLoaded: false }, ioSignals: { chunk: 1, chunks: 1, full: [] } });
    expect(io.at('rw7', 1)).toEqual({ status: 'not-loaded' });
    io.apply({ t: 2, id: 'rw7', changed: { ioSignalsLoaded: true } });
    expect(io.at('rw7', 2)).toEqual({ status: 'ready', signals: [] });
    // A client without the flag: connected with a non-empty table is loaded.
    const old = new IoTableTimeline();
    old.apply({ t: 1, id: 'rw6', changed: { connected: false }, ioSignals: { chunk: 1, chunks: 1, full: [sig('a')] } });
    expect(old.at('rw6', 1)).toEqual({ status: 'not-loaded' });
    old.apply({ t: 2, id: 'rw6', changed: { connected: true } });
    expect(old.at('rw6', 2)).toEqual({ status: 'ready', signals: [sig('a')] });
  });

  it('a chunk missing or out of order, a row left out, a shape it does not know: not-recorded, never an older table', () => {
    const loaded = { connected: true, ioSignalsLoaded: true };
    const missing = new IoTableTimeline();
    missing.apply({ t: 1, id: 'rw7', changed: loaded, ioSignals: { chunk: 1, chunks: 1, full: [sig('a')] } });
    missing.apply({ t: 2, id: 'rw7', ioSignals: { chunk: 1, chunks: 3, full: [sig('a')] } });
    missing.apply({ t: 3, id: 'rw7', ioSignals: { chunk: 3, chunks: 3, full: [sig('c')] } });
    expect(missing.at('rw7', 1)).toEqual({ status: 'ready', signals: [sig('a')] });
    expect(missing.at('rw7', 2)).toEqual({ status: 'ready', signals: [sig('a')] });   // still being read: the old one stands
    expect(missing.at('rw7', 3)).toEqual({ status: 'not-recorded' });
    // A diff on a table not held stays not recorded; the next whole table answers again.
    missing.apply({ t: 4, id: 'rw7', ioSignals: { added: [sig('x')], changed: [], removed: [] } });
    expect(missing.at('rw7', 4)).toEqual({ status: 'not-recorded' });
    missing.apply({ t: 5, id: 'rw7', ioSignals: { chunk: 1, chunks: 1, full: [sig('z')] } });
    expect(missing.at('rw7', 5)).toEqual({ status: 'ready', signals: [sig('z')] });

    const omitted = new IoTableTimeline();
    omitted.apply({ t: 1, id: 'rw7', changed: loaded, ioSignals: { chunk: 1, chunks: 1, full: [sig('a'), { $omitted: { bytes: 2_000_000 } }] } });
    expect(omitted.at('rw7', 1)).toEqual({ status: 'not-recorded' });

    const shape = new IoTableTimeline();
    shape.apply({ t: 1, id: 'rw7', changed: loaded, ioSignals: { chunk: 1, chunks: 1, full: [sig('a')] } });
    shape.apply({ t: 2, id: 'rw7', ioSignals: { $omitted: { bytes: 5_000_000 } } });
    expect(shape.at('rw7', 2)).toEqual({ status: 'not-recorded' });
  });

  it('a gap that dropped state records: not-recorded until the next whole table', () => {
    const io = new IoTableTimeline();
    io.apply({ t: 1, id: 'rw7', changed: { connected: true, ioSignalsLoaded: true }, ioSignals: { chunk: 1, chunks: 1, full: [sig('a')] } });
    io.gap(100);
    expect(io.at('rw7', 99)).toEqual({ status: 'ready', signals: [sig('a')] });
    expect(io.at('rw7', 100)).toEqual({ status: 'not-recorded' });
    io.apply({ t: 101, id: 'rw7', ioSignals: { chunk: 1, chunks: 1, full: [sig('a', '1')] } });
    expect(io.at('rw7', 101)).toEqual({ status: 'ready', signals: [sig('a', '1')] });
  });
});

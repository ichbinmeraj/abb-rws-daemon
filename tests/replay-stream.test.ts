import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseRecording } from '../src/replay/reader.js';
import { ReplayState } from '../src/replay/state.js';
import { ReplayStream, type ReplaySocketHub } from '../src/replay/stream.js';
import { SocketHub, type SocketLike } from '../src/wsHub.js';

const START = '2026-10-04T15:30:12.000Z';
const START_MS = Date.parse(START);
const at = (t: number) => new Date(START_MS + t).toISOString();

const header = (part = 1) => ({
  kind: 'header', format: 'abb-rws-recording', formatVersion: 1, schemaVersion: '0.12', source: 'daemon',
  session: 'rec-20261004T153012Z-stream', part, previous: null, startedAt: START, sessionStartedAt: START, label: null,
  content: ['frames', 'calls', 'state'], daemon: { version: '0.1.0-dev' }, client: { version: '1.4.0' }, controllers: [], limits: null,
  masking: { rules: [], values: 0, derived: 0, weakValues: 0 },
});

function ctrl(id: string, o: { speed?: number; quality?: string; exec?: string; name?: string } = {}) {
  return {
    id, name: o.name ?? id.toUpperCase(), identity: null,
    link: {
      connected: true, quality: o.quality ?? 'live', qualityReason: 'ok', since: at(0), host: '127.0.0.1', port: 9403, useHttps: true,
      subscriptions: { active: true }, identityCheck: { status: 'confirmed', expected: null, actual: null }, reconnect: null,
    },
    panel: { ctrlState: 'motoron', opMode: 'AUTO', speedRatio: o.speed ?? 100, collisionDetection: null, asOf: at(0) },
    rapid: { execState: o.exec ?? 'stopped', cycle: 'once', tasks: [], asOf: at(0) },
    motion: { watching: false, units: [], rate: { targetHz: null, achievedHz: null, via: null }, asOf: null },
    io: { watching: false, signals: [], asOf: null },
    events: { feed: 'f', lastSeq: 0, recent: [], via: null, clock: { offsetMs: null, measuredAt: null, problem: null }, asOf: null, error: null },
  };
}
const groupsOf = (c: ReturnType<typeof ctrl>) => (({ id: _i, name: _n, ...g }) => g)(c);

const snap = (t: number, controllers: unknown[], resync = false) =>
  ({ kind: 'frame', t, frame: { type: 'snapshot', schemaVersion: '0.12', observedAt: at(t), controllers }, ...(resync ? { resync: true } : {}) });
const delta = (t: number, id: string, groups: Record<string, unknown>) =>
  ({ kind: 'frame', t, frame: { type: 'delta', observedAt: at(t), id, name: id.toUpperCase(), groups } });
const removed = (t: number, id: string) => ({ kind: 'frame', t, frame: { type: 'removed', observedAt: at(t), id } });

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  frames(): Array<Record<string, any>> { return this.sent.map(s => JSON.parse(s)); }
}

class FakeHub implements ReplaySocketHub {
  sent: string[] = [];
  refuse = false;
  readonly sockets = new Set<FakeSocket>();
  attach(socket: SocketLike, first: string): boolean {
    if (this.refuse) { socket.close?.(1013, 'full'); return false; }
    this.sockets.add(socket as FakeSocket);
    socket.send(first);
    return true;
  }
  detach(socket: SocketLike): void { this.sockets.delete(socket as FakeSocket); }
  broadcast(frame: string): void { this.sent.push(frame); for (const s of this.sockets) { s.send(frame); } }
  closeAll(): void { this.sockets.clear(); }
  close(): void { this.sockets.clear(); }
  frames(): Array<Record<string, any>> { return this.sent.map(s => JSON.parse(s)); }
}

const jsonl = (lines: unknown[]) => lines.map(l => JSON.stringify(l)).join('\n') + '\n';

/** A recording of two parts: the second begins with the recorder's resync snapshot. */
function twoParts(part1: unknown[], part2: unknown[]) {
  return parseRecording([
    { name: 'rec-20261004T153012Z-stream-p0001.jsonl', text: jsonl([header(1), ...part1]) },
    { name: 'rec-20261004T153012Z-stream-p0002.jsonl', text: jsonl([header(2), ...part2]) },
  ]);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ReplayStream: a resync snapshot goes out as deltas', () => {
  it('only the groups that differ, a whole delta for a new controller, removed for one the snapshot lacks; never a second snapshot', () => {
    const rec = twoParts(
      [snap(0, [ctrl('rw6'), ctrl('rw7')]), delta(100, 'rw7', { panel: ctrl('rw7', { speed: 50 }).panel })],
      // Part 2: rw7's speed changed and its RAPID started while the recorder rotated; rw6 is gone, rw8 is new.
      [snap(200, [ctrl('rw7', { speed: 30, exec: 'running' }), ctrl('rw8')], true), delta(300, 'rw8', { panel: ctrl('rw8', { speed: 10 }).panel })],
    );
    const hub = new FakeHub();
    const stream = new ReplayStream(rec, hub, { time: 'recorded', paused: true, monoNow: () => Date.now() });
    const consumer = new FakeSocket();
    stream.attach(consumer);
    for (let i = 0; i < 3; i++) { stream.control({ action: 'step' }); }
    const got = consumer.frames();
    expect(got.map(f => f.type)).toEqual(['snapshot', 'delta', 'delta', 'delta', 'removed', 'delta']);
    expect(got.filter(f => f.type === 'snapshot')).toHaveLength(1);
    const [, , rw7, rw8, gone, last] = got;
    expect(rw7).toEqual({ type: 'delta', observedAt: at(200), id: 'rw7', name: 'RW7',
      groups: { panel: ctrl('rw7', { speed: 30 }).panel, rapid: ctrl('rw7', { exec: 'running' }).rapid } });
    expect(rw8).toEqual({ type: 'delta', observedAt: at(200), id: 'rw8', name: 'RW8', groups: groupsOf(ctrl('rw8')) });
    expect(gone).toEqual({ type: 'removed', observedAt: at(200), id: 'rw6' });
    expect(last.groups.panel.speedRatio).toBe(10);
    // The replay's own state is the snapshot's, then the delta's.
    expect(stream.state.ids()).toEqual(['rw7', 'rw8']);
    expect(stream.state.get('rw8')?.panel.speedRatio).toBe(10);
  });

  it('a resync snapshot equal to the state sends nothing', () => {
    const rec = twoParts([snap(0, [ctrl('rw7')])], [snap(50, [ctrl('rw7')], true)]);
    const hub = new FakeHub();
    const stream = new ReplayStream(rec, hub, { paused: true, monoNow: () => Date.now() });
    stream.control({ action: 'step' });
    expect(hub.sent).toEqual([]);
    expect(stream.status().positionMs).toBe(50);
  });

  it('a consumer applying every frame it gets holds the replay\'s state at every step, across gaps and parts', () => {
    const rec = twoParts(
      [
        snap(0, [ctrl('rw6'), ctrl('rw7')]),
        delta(100, 'rw7', { panel: ctrl('rw7', { speed: 50 }).panel }),
        { kind: 'gap', t: 150, why: 'writer-behind', kinds: { call: 4, state: 1, sub: 0 } },
        snap(150, [ctrl('rw6', { quality: 'polling' }), ctrl('rw7', { speed: 60 })], true),
        removed(180, 'rw6'),
      ],
      [
        snap(200, [ctrl('rw7', { speed: 70 }), ctrl('rw9', { name: 'Cell 9' })], true),
        delta(250, 'rw9', { rapid: ctrl('rw9', { exec: 'running' }).rapid }),
      ],
    );
    const hub = new FakeHub();
    const stream = new ReplayStream(rec, hub, { paused: true, monoNow: () => Date.now() });
    const consumer = new FakeSocket();
    stream.attach(consumer);
    const mirror = new ReplayState();
    let seen = 0;
    const catchUp = () => { for (const f of consumer.frames().slice(seen)) { mirror.apply(f); } seen = consumer.sent.length; };
    catchUp();
    for (let i = 1; i < rec.frames.length; i++) {
      stream.control({ action: 'step' });
      catchUp();
      // Times are shifted for the consumer; compare what the state holds.
      expect(mirror.ids()).toEqual(stream.state.ids());
      for (const c of stream.state.list()) {
        const m = mirror.get(c.id)!;
        expect(m.name).toBe(c.name);
        expect(m.panel.speedRatio).toBe(c.panel.speedRatio);
        expect(m.link.quality).toBe(c.link.quality);
        expect(m.rapid.execState).toBe(c.rapid.execState);
      }
    }
    expect(consumer.frames().filter(f => f.type === 'snapshot')).toHaveLength(1);
    expect(stream.status().gaps).toBe(1);
  });
});

describe('ReplayStream: consumers', () => {
  it('attach sends a snapshot of the state at the position; a refused consumer is reported; detach stops the frames', () => {
    const rec = twoParts([snap(0, [ctrl('rw7')]), delta(100, 'rw7', { panel: ctrl('rw7', { speed: 5 }).panel })], [snap(200, [ctrl('rw7', { speed: 5 })], true)]);
    const hub = new FakeHub();
    const stream = new ReplayStream(rec, hub, { paused: true, time: 'recorded', monoNow: () => Date.now() });
    const a = new FakeSocket();
    expect(stream.attach(a)).toBe(true);
    stream.control({ action: 'step' });
    const b = new FakeSocket();
    stream.attach(b);
    expect(b.frames()[0]).toMatchObject({ type: 'snapshot', schemaVersion: '0.12', observedAt: at(100) });
    expect(b.frames()[0].controllers[0].panel.speedRatio).toBe(5);
    stream.detach(a);
    hub.refuse = true;
    expect(stream.attach(new FakeSocket())).toBe(false);
    expect(a.sent).toHaveLength(2);
  });

  it('runs on the daemon\'s SocketHub: frames reach consumers, a restart closes them with 1012 and new ones are accepted', () => {
    const rec = twoParts([snap(0, [ctrl('rw7')]), delta(100, 'rw7', { panel: ctrl('rw7', { speed: 5 }).panel })], [snap(200, [ctrl('rw7')], true)]);
    const hub = new SocketHub({ heartbeatMs: 0 });
    const stream = new ReplayStream(rec, hub, { paused: true, monoNow: () => Date.now() });
    const closes: Array<[number | undefined, string | undefined]> = [];
    const a = Object.assign(new FakeSocket(), { close: (code?: number, reason?: string) => { closes.push([code, reason]); } });
    expect(stream.attach(a)).toBe(true);
    stream.control({ action: 'step' });
    expect(a.frames().map(f => f.type)).toEqual(['snapshot', 'delta']);
    stream.control({ action: 'restart' });
    expect(closes).toEqual([[1012, 'the recording starts over']]);
    expect(hub.size).toBe(0);
    const b = new FakeSocket();
    expect(stream.attach(b)).toBe(true);
    expect(hub.size).toBe(1);
    stream.close();
    expect(hub.size).toBe(0);
  });

  it('serves the snapshot schema version the recording was made with', () => {
    const old = { ...header(1), schemaVersion: '0.11' };
    const rec = parseRecording([{ name: 'old-p0001.jsonl', text: jsonl([old, snap(0, [ctrl('rw7')])]) }]);
    const stream = new ReplayStream(rec, new FakeHub(), { paused: true, monoNow: () => Date.now() });
    expect(JSON.parse(stream.snapshotFrame()).schemaVersion).toBe('0.11');
    expect(stream.status().recordedSchemaVersion).toBe('0.11');
  });

  it('a frame of a type this daemon does not know goes out as recorded and changes no state', () => {
    const later = { kind: 'frame', t: 10, frame: { type: 'annotation', observedAt: at(10), text: 'hello' } };
    const rec = twoParts([snap(0, [ctrl('rw7')]), later], [snap(20, [ctrl('rw7')], true)]);
    const hub = new FakeHub();
    const stream = new ReplayStream(rec, hub, { paused: true, monoNow: () => Date.now() });
    stream.control({ action: 'step' });
    expect(hub.sent).toEqual([JSON.stringify(later.frame)]);
    expect(stream.state.ids()).toEqual(['rw7']);
  });

  it('status names the recording without a path', () => {
    const rec = twoParts([snap(0, [ctrl('rw7')])], [snap(20, [ctrl('rw7')], true)]);
    const stream = new ReplayStream(rec, new FakeHub(), { paused: true, monoNow: () => Date.now() });
    expect(stream.status()).toEqual({
      state: 'paused', positionMs: 0, durationMs: 20, speed: 1, loop: false, loops: 0, recordedAt: START, time: 'shifted',
      files: ['rec-20261004T153012Z-stream-p0001.jsonl', 'rec-20261004T153012Z-stream-p0002.jsonl'],
      session: 'rec-20261004T153012Z-stream', label: null, source: 'daemon', recordedSchemaVersion: '0.12',
      daemonVersion: '0.1.0-dev', clientVersion: '1.4.0', gaps: 0,
    });
    expect(Object.keys(stream.health())).toEqual(['state', 'positionMs', 'durationMs', 'speed', 'loop', 'loops', 'recordedAt', 'time']);
  });
});

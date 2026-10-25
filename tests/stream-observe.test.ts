import { describe, it, expect } from 'vitest';
import { Recorder } from '../src/recording/recorder.js';
import { SnapshotStream, type StreamSource } from '../src/stream.js';
import { CLOSE_GOING_AWAY, CLOSE_TRY_LATER, MAX_STREAM_CONSUMERS, SocketHub } from '../src/wsHub.js';
import type { ControllerSnapshot } from '../src/schema/v0.js';
import { ManualTimers, MemoryFiles, MemoryLog, parseJsonl, settle, snapshotOf } from './helpers/recording-fakes.js';

const NOW = Date.parse('2026-10-04T15:30:12.345Z');

/** A consumer's socket: what it was sent, whether it was closed or cut off. */
class FakeSocket {
  sent: string[] = [];
  readyState = 1;
  bufferedAmount = 0;
  terminated = false;
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void { this.sent.push(data); }
  terminate(): void { this.terminated = true; }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  on(): void {}
}

/** A fleet stand-in whose controllers the test changes, then announces. */
function makeSource(initial: ControllerSnapshot[]) {
  const map = new Map(initial.map(c => [c.id, c]));
  let handler: (id: string) => void = () => {};
  const source: StreamSource & { set(c: ControllerSnapshot): void; drop(id: string): void } = {
    list: () => [...map.values()],
    get: id => map.get(id) ?? null,
    onChanged: cb => { handler = cb; },
    set: c => { map.set(c.id, c); handler(c.id); },
    drop: id => { map.delete(id); handler(id); },
  };
  return source;
}

/** A stream over one controller; changes go out at once (no throttle window). */
function setup(hub = new SocketHub({ heartbeatMs: 0 })) {
  const source = makeSource([snapshotOf('rw7', { sysId: 'sys-rw7' })]);
  const stream = new SnapshotStream(source, hub, { debounceMs: 0, now: () => NOW });
  /** The controller with a new speed ratio: a delta with the panel group. */
  const speed = (ratio: number) => source.set({ ...snapshotOf('rw7', { sysId: 'sys-rw7', speed: ratio }) });
  return { source, stream, hub, speed };
}

describe('SnapshotStream.observe', () => {
  it('starts from the snapshot a consumer attaching now would get, then gets every broadcast string, the very same', () => {
    const { stream, speed } = setup();
    const consumer = new FakeSocket();
    stream.attach(consumer);
    const seen: string[] = [];
    const obs = stream.observe(f => seen.push(f));
    expect(obs.first).toBe(consumer.sent[0]);
    expect(JSON.parse(obs.first)).toMatchObject({ type: 'snapshot', controllers: [{ id: 'rw7' }] });
    speed(50);
    speed(25);
    expect(seen).toHaveLength(2);
    expect(seen).toEqual(consumer.sent.slice(1));
    expect(JSON.parse(seen[1])).toMatchObject({ type: 'delta', id: 'rw7', groups: { panel: { speedRatio: 25 } } });
  });

  it('takes no consumer slot: a full hub turns a consumer away while the observer goes on', () => {
    const { stream, hub, speed } = setup(new SocketHub({ heartbeatMs: 0, maxClients: 1 }));
    const first = new FakeSocket();
    expect(stream.attach(first)).toBe(true);
    const seen: string[] = [];
    stream.observe(f => seen.push(f));
    expect(hub.size).toBe(1);
    const second = new FakeSocket();
    expect(stream.attach(second)).toBe(false);
    expect(second.closed?.code).toBe(CLOSE_TRY_LATER);
    speed(10);
    expect(seen).toHaveLength(1);
    expect(first.sent).toHaveLength(2);
    expect(hub.size).toBe(1);
  });

  it('a consumer the hub cuts off for not reading is cut off alone; the observer is never one', () => {
    const { stream, speed } = setup(new SocketHub({ heartbeatMs: 0, maxBufferedBytes: 10 }));
    const stalled = new FakeSocket();
    stream.attach(stalled);
    const seen: string[] = [];
    stream.observe(f => seen.push(f));
    stalled.bufferedAmount = 1_000;
    speed(10);
    speed(20);
    expect(stalled.terminated).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('survives close(): consumers are told the daemon goes away, frames made while it stops still reach the observer', () => {
    const { stream, source, speed } = setup();
    const consumer = new FakeSocket();
    stream.attach(consumer);
    const seen: string[] = [];
    stream.observe(f => seen.push(f));
    stream.close();
    expect(consumer.closed?.code).toBe(CLOSE_GOING_AWAY);
    speed(5);
    source.drop('rw7');
    expect(seen.map(f => JSON.parse(f).type)).toEqual(['delta', 'removed']);
    expect(consumer.sent).toHaveLength(1);
  });

  it('an observer that throws changes nothing for consumers or for other observers', () => {
    const { stream, speed } = setup();
    const consumer = new FakeSocket();
    stream.attach(consumer);
    stream.observe(() => { throw new Error('observer bug'); });
    const seen: string[] = [];
    stream.observe(f => seen.push(f));
    expect(() => speed(40)).not.toThrow();
    expect(consumer.sent).toHaveLength(2);
    expect(seen).toHaveLength(1);
  });

  it('stop() ends one observation: the same function observing twice is stopped once per stop', () => {
    const { stream, speed } = setup();
    const seen: string[] = [];
    const fn = (f: string) => { seen.push(f); };
    const a = stream.observe(fn);
    const b = stream.observe(fn);
    speed(1);
    expect(seen).toHaveLength(2);
    a.stop();
    speed(2);
    expect(seen).toHaveLength(3);
    b.stop();
    speed(3);
    expect(seen).toHaveLength(3);
  });

  it('snapshotFrame() reaches nobody and leaves what was broadcast alone: the next change still goes out', () => {
    const { stream, speed } = setup();
    const consumer = new FakeSocket();
    stream.attach(consumer);
    speed(70);
    const snap = JSON.parse(stream.snapshotFrame());
    expect(snap).toMatchObject({ type: 'snapshot', observedAt: new Date(NOW).toISOString(), controllers: [{ id: 'rw7' }] });
    expect(consumer.sent).toHaveLength(2);
    speed(71);
    expect(consumer.sent).toHaveLength(3);
    expect(JSON.parse(consumer.sent[2])).toMatchObject({ type: 'delta', groups: { panel: { speedRatio: 71 } } });
  });
});

describe('the recorder on the real stream', () => {
  it(`rotates with ${MAX_STREAM_CONSUMERS} consumers attached: the new part starts with a snapshot, no consumer is closed`, async () => {
    const hub = new SocketHub({ heartbeatMs: 0 });
    const big = (n: number): ControllerSnapshot => {
      const c = snapshotOf('rw7', { sysId: 'sys-rw7' });
      // About 12 KiB of options, changed every time: each delta carries the identity group whole.
      c.identity!.options = Array.from({ length: 400 }, (_, i) => `option-${n}-${String(i).padStart(4, '0')}-abcdef`);
      return c;
    };
    const source = makeSource([big(0)]);
    const stream = new SnapshotStream(source, hub, { debounceMs: 0, now: () => NOW });
    const consumers = Array.from({ length: MAX_STREAM_CONSUMERS }, () => new FakeSocket());
    for (const c of consumers) { expect(stream.attach(c)).toBe(true); }

    const files = new MemoryFiles();
    const recorder = new Recorder({
      observer: stream, dir: '/recordings', folder: 'custom', limits: { maxFileBytes: 1024 * 1024 },
      log: new MemoryLog(), daemonVersion: '0.0.0-test', clientVersion: '0.0.0-test', files, timers: new ManualTimers(),
    });
    await recorder.start({ content: ['frames'], label: 'rotation' });
    const changes = 120;
    for (let n = 1; n <= changes; n++) {
      source.set(big(n));
      if (n % 10 === 0) { await settle(); }
    }
    await settle();
    await recorder.stop();

    const names = [...files.files.keys()].sort();
    expect(names.length).toBeGreaterThanOrEqual(2);
    const second = parseJsonl(files.files.get(names[1])!.text);
    expect(second[0]).toMatchObject({ kind: 'header', part: 2 });
    const firstFrame = second.find(r => r.kind === 'frame');
    expect(firstFrame).toMatchObject({ resync: true, frame: { type: 'snapshot' } });
    const frames = files.lines().filter(r => r.kind === 'frame' && r.resync !== true);
    expect(frames).toHaveLength(changes + 1);   // the first snapshot, then every delta: none left out across the rotation
    expect(hub.size).toBe(MAX_STREAM_CONSUMERS);
    for (const c of consumers) {
      expect(c.closed).toBeNull();
      expect(c.terminated).toBe(false);
      expect(c.sent).toHaveLength(changes + 1);
    }
    stream.close();
  });
});

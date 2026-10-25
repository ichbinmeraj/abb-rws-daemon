import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  REPLAY_TIME_ROOTS, ReplayClock, TIMED_DEFINITIONS, checkSpeed, dateTimePaths, shiftIso, shiftTimes,
} from '../src/replay/clock.js';
import { parseRecording } from '../src/replay/reader.js';
import { CLOSE_REPLAY_RESTART, LOOP_DELAY_MS, REPLAY_RESTART_REASON, ReplayStream, type ReplaySocketHub } from '../src/replay/stream.js';
import type { SocketLike } from '../src/wsHub.js';

const START = '2026-10-04T15:30:12.000Z';
const START_MS = Date.parse(START);
const at = (t: number) => new Date(START_MS + t).toISOString();
/** The wall clock while the tests replay: a day after the recording. */
const WALL0 = Date.parse('2026-10-05T08:00:00.000Z');

const header = () => ({
  kind: 'header', format: 'abb-rws-recording', formatVersion: 1, schemaVersion: '0.13', source: 'daemon',
  session: 'rec-20261004T153012Z-clock', part: 1, previous: null, startedAt: START, sessionStartedAt: START, label: 'clock',
  content: ['frames'], daemon: { version: '0.1.0-dev' }, client: { version: '1.4.0' }, controllers: [], limits: null,
  masking: { rules: [], values: 0, derived: 0, weakValues: 0 },
});

/** A controller with a date-time in every place the schema has one, plus the raw controller texts that must never move. */
function ctrl(id: string, t: number, speed = 100, feed = 'feed-a') {
  return {
    id, name: id.toUpperCase(),
    identity: {
      controllerName: id, controllerId: null, controllerType: 'Virtual Controller', virtual: true, mac: null, systemName: id,
      sysId: null, startTime: '2026-10-04 T 17:00:00', robotWare: { raw: '7.21.4+417', major: 7, minor: 21, generation: 'rws2' },
      options: [], asOf: at(t),
    },
    link: {
      connected: false, quality: 'disconnected', qualityReason: 'x', since: at(t), downSince: at(t - 60_000), host: '127.0.0.1', port: 9403, useHttps: true,
      subscriptions: { active: false }, identityCheck: { status: 'confirmed', expected: null, actual: null },
      reconnect: { failures: 1, nextAttemptAt: at(t + 5000) },
    },
    panel: { ctrlState: 'motoron', opMode: 'AUTO', speedRatio: speed, collisionDetection: null, asOf: at(t) },
    rapid: { execState: 'stopped', cycle: 'once', tasks: [], asOf: at(t) },
    motion: { watching: false, units: [], rate: { targetHz: null, achievedHz: null, via: null }, asOf: at(t) },
    io: { watching: true, signals: [{ name: 'do1', type: 'DO', value: '1', via: 'poll', asOf: at(t), error: null }], asOf: at(t) },
    events: {
      feed, lastSeq: 1, via: 'poll', asOf: at(t), error: null, clock: { offsetMs: -7_200_000, measuredAt: at(t), problem: null },
      recent: [{
        seq: 1, seqnum: 9, code: 10002, severity: 'info', title: 'Program pointer moved', titleFromCode: false, description: null,
        causes: null, consequences: null, actions: null, args: [], source: null,
        time: { raw: '2026-10-04 T 17:30:12', utc: at(t), corrected: true }, receivedAt: at(t), backlog: false,
      }],
    },
    access: {
      generation: 'rw7', model: 'mastership',
      locks: [
        { lock: 'edit', held: false, holder: null, heldByDaemon: false, reported: 'nomaster', asOf: at(t - 2000), error: null },
        { lock: 'motion', held: true, holder: { kind: 'local', name: null, application: null, flexPendant: null }, heldByDaemon: false, reported: 'local', asOf: at(t - 1000), error: null },
      ],
      remoteAccessEnabled: null, rmmp: { supported: true, privilege: 'none', asOf: at(t - 500), error: null },
      via: null, problem: null, asOf: at(t - 2000),
    },
    capabilities: {
      protocol: null, generation: 'rw7', robotWare: '7.21.4+417', tested: true,
      entries: [{ id: 'status-push', state: 'unknown', reason: 'x' }], asOf: at(t),
    },
    freshness: {
      level: 'down', reasons: ['link: x'],
      groups: [{ group: 'panel', state: 'stale', asOf: at(t), reason: 'x' }, { group: 'access', state: 'stale', asOf: at(t - 2000), reason: 'x' }],
    },
  };
}

const snap = (t: number, controllers = [ctrl('rw7', t)]) =>
  ({ kind: 'frame', t, frame: { type: 'snapshot', schemaVersion: '0.13', observedAt: at(t), controllers } });
const delta = (t: number, groups: Record<string, unknown>, id = 'rw7') =>
  ({ kind: 'frame', t, frame: { type: 'delta', observedAt: at(t), id, name: id.toUpperCase(), groups } });
const speed = (t: number, s: number) => delta(t, { panel: ctrl('rw7', t, s).panel });

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; this.readyState = 3; }
}

class FakeHub implements ReplaySocketHub {
  sent: string[] = [];
  closedAll: Array<{ code: number; reason: string }> = [];
  closed = false;
  readonly sockets = new Set<FakeSocket>();
  attach(socket: SocketLike, first: string): boolean { this.sockets.add(socket as FakeSocket); socket.send(first); return true; }
  detach(socket: SocketLike): void { this.sockets.delete(socket as FakeSocket); }
  broadcast(frame: string): void { this.sent.push(frame); for (const s of this.sockets) { s.send(frame); } }
  closeAll(code: number, reason: string): void {
    this.closedAll.push({ code, reason });
    for (const s of this.sockets) { s.close(code, reason); }
    this.sockets.clear();
  }
  close(): void { this.closed = true; }
  frames(): Array<Record<string, any>> { return this.sent.map(s => JSON.parse(s)); }
}

const jsonl = (lines: unknown[]) => lines.map(l => JSON.stringify(l)).join('\n') + '\n';

function replay(lines: unknown[], opts: ConstructorParameters<typeof ReplayStream>[2] = {}) {
  const rec = parseRecording([{ name: 'rec-20261004T153012Z-clock-p0001.jsonl', text: jsonl([header(), ...lines]) }]);
  const hub = new FakeHub();
  const stream = new ReplayStream(rec, hub, { monoNow: () => Date.now(), ...opts });
  return { rec, hub, stream };
}

const TIMELINE = [snap(0), speed(1000, 50), speed(2000, 40), speed(2000, 30), speed(3000, 20)];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(WALL0); });
afterEach(() => { vi.useRealTimers(); });

describe('ReplayClock', () => {
  it('maps wall time onto recording time at a speed; pause, play, seek and speed changes carry the position on', () => {
    let now = 0;
    const clock = new ReplayClock({ startMs: 100, endMs: 5000, now: () => now });
    expect(clock.position()).toBe(100);
    now = 400;
    expect(clock.position()).toBe(500);
    clock.setSpeed(2);
    now = 500;
    expect(clock.position()).toBe(700);
    expect(clock.wallMsUntil(1700)).toBe(500);
    clock.pause();
    now = 10_000;
    expect(clock.position()).toBe(700);
    expect(clock.wallMsUntil(1700)).toBe(Number.POSITIVE_INFINITY);
    clock.play();
    now = 10_100;
    expect(clock.position()).toBe(900);
    now = 1_000_000;
    expect(clock.position()).toBe(5000);   // never past the last frame
    clock.seek(-5);
    expect(clock.position()).toBe(100);
    expect(clock.wallMsUntil(50)).toBe(0);
  });

  it('a speed is 0.1 to 50', () => {
    expect(checkSpeed(0.1)).toBe(0.1);
    expect(checkSpeed(50)).toBe(50);
    for (const bad of [0.05, 51, Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) { expect(() => checkSpeed(bad)).toThrow(RangeError); }
    expect(() => new ReplayClock({ startMs: 0, endMs: 1, speed: 100 })).toThrow(RangeError);
  });
});

describe('ReplayStream: timing', () => {
  it('sends each frame when the position reaches its time; frames recorded together go out together', async () => {
    const { hub, stream } = replay(TIMELINE);
    expect(hub.sent).toHaveLength(0);                  // the first snapshot is the start state, sent to nobody
    await vi.advanceTimersByTimeAsync(999);
    expect(hub.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.frames().map(f => f.groups.panel.speedRatio)).toEqual([50]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(hub.frames().map(f => f.groups.panel.speedRatio)).toEqual([50, 40, 30]);
    expect(stream.health()).toMatchObject({ state: 'playing', positionMs: 2000, durationMs: 3000, speed: 1, loops: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(hub.sent).toHaveLength(4);
    expect(stream.health()).toMatchObject({ state: 'ended', positionMs: 3000 });
  });

  it('at speed 2 the waits halve; a speed change carries on from the position', async () => {
    const { hub, stream } = replay(TIMELINE, { speed: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(hub.sent).toHaveLength(1);
    stream.control({ action: 'play', speed: 0.5 });   // position 1000: the next frame (2000) is 2000 wall ms away
    await vi.advanceTimersByTimeAsync(1999);
    expect(hub.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.sent).toHaveLength(3);
    expect(stream.status().speed).toBe(0.5);
  });

  it('paused, nothing is sent; play resumes from the position', async () => {
    const { hub, stream } = replay(TIMELINE);
    await vi.advanceTimersByTimeAsync(500);
    expect(stream.control({ action: 'pause' })).toMatchObject({ state: 'paused', positionMs: 500 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hub.sent).toHaveLength(0);
    expect(stream.health().positionMs).toBe(500);
    stream.control({ action: 'play' });
    await vi.advanceTimersByTimeAsync(499);
    expect(hub.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.sent).toHaveLength(1);
  });

  it('started paused, step sends the next frame record at once and moves the position to its time', async () => {
    const { hub, stream } = replay(TIMELINE, { paused: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hub.sent).toHaveLength(0);
    expect(stream.control({ action: 'step' })).toMatchObject({ state: 'paused', positionMs: 1000 });
    expect(hub.sent).toHaveLength(1);
    stream.control({ action: 'step' });
    stream.control({ action: 'step' });
    expect(stream.health().positionMs).toBe(2000);
    expect(hub.frames().map(f => f.groups.panel.speedRatio)).toEqual([50, 40, 30]);
    expect(stream.control({ action: 'step' })).toMatchObject({ state: 'ended', positionMs: 3000 });
    stream.control({ action: 'step' });
    stream.control({ action: 'play' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hub.sent).toHaveLength(4);
    expect(stream.health().state).toBe('ended');
  });

  it('a step while playing pauses', async () => {
    const { hub, stream } = replay(TIMELINE);
    await vi.advanceTimersByTimeAsync(100);
    expect(stream.control({ action: 'step' })).toMatchObject({ state: 'paused', positionMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hub.sent).toHaveLength(1);
  });

  it('a speed out of bounds is refused and changes nothing', () => {
    const { stream } = replay(TIMELINE, { paused: true });
    expect(() => stream.control({ action: 'play', speed: 51 })).toThrow(RangeError);
    expect(() => stream.control({ action: 'rewind' as 'play', speed: 2 })).toThrow(/unknown replay action "rewind"/);
    expect(stream.status()).toMatchObject({ state: 'paused', speed: 1 });
  });
});

describe('ReplayStream: the end, looping and starting over', () => {
  it('loop: a second after the last frame every consumer is closed with 1012, the state starts over, the feed is renamed', async () => {
    const { hub, stream } = replay([snap(0), speed(1000, 50), delta(2000, { events: { ...ctrl('rw7', 2000).events, lastSeq: 1 } })], { loop: true });
    const consumer = new FakeSocket();
    stream.attach(consumer);
    await vi.advanceTimersByTimeAsync(2000);
    expect(stream.health()).toMatchObject({ state: 'playing', positionMs: 2000, loops: 0 });
    await vi.advanceTimersByTimeAsync(LOOP_DELAY_MS - 1);
    expect(hub.closedAll).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.closedAll).toEqual([{ code: CLOSE_REPLAY_RESTART, reason: REPLAY_RESTART_REASON }]);
    expect(CLOSE_REPLAY_RESTART).toBe(1012);
    expect(consumer.closed).toEqual({ code: 1012, reason: 'the recording starts over' });
    expect(stream.health()).toMatchObject({ state: 'playing', positionMs: 0, loops: 1, loop: true });
    expect(stream.state.get('rw7')?.panel.speedRatio).toBe(100);
    // The consumer reconnects: a fresh snapshot under this turn's feed name.
    const again = new FakeSocket();
    stream.attach(again);
    expect(JSON.parse(again.sent[0]).controllers[0].events.feed).toBe('feed-a~loop1');
    await vi.advanceTimersByTimeAsync(2000);
    const second = hub.frames().slice(2);
    expect(second.map(f => Object.keys(f.groups))).toEqual([['panel'], ['events']]);
    expect(second[1].groups.events.feed).toBe('feed-a~loop1');
    await vi.advanceTimersByTimeAsync(LOOP_DELAY_MS);
    expect(stream.health().loops).toBe(2);
  });

  it('without loop the replay stays at the last state, ended; restart starts over, playing, closing every consumer', async () => {
    const { hub, stream } = replay(TIMELINE);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stream.health().state).toBe('ended');
    expect(stream.state.get('rw7')?.panel.speedRatio).toBe(20);
    expect(stream.control({ action: 'play' }).state).toBe('ended');
    expect(stream.control({ action: 'restart' })).toMatchObject({ state: 'playing', positionMs: 0, loops: 1 });
    expect(hub.closedAll).toHaveLength(1);
    expect(stream.state.get('rw7')?.panel.speedRatio).toBe(100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(hub.sent).toHaveLength(5);
  });

  it('restart while paused stays paused; a looping replay stepped past its end starts over', () => {
    const { hub, stream } = replay(TIMELINE, { paused: true, loop: true });
    stream.control({ action: 'step' });
    expect(stream.control({ action: 'restart' })).toMatchObject({ state: 'paused', positionMs: 0, loops: 1 });
    for (let i = 0; i < 4; i++) { stream.control({ action: 'step' }); }
    expect(stream.health()).toMatchObject({ state: 'paused', positionMs: 3000, loops: 1 });
    stream.control({ action: 'step' });
    expect(stream.health()).toMatchObject({ state: 'paused', positionMs: 0, loops: 2 });
    expect(hub.closedAll).toHaveLength(2);
  });

  it('close stops the frames and closes the hub', async () => {
    const { hub, stream } = replay(TIMELINE);
    stream.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hub.sent).toHaveLength(0);
    expect(hub.closed).toBe(true);
  });
});

/** Every value at a date-time path (`controllers[].link.since`) of an object. */
function valuesAt(value: unknown, path: string): unknown[] {
  const [head, ...rest] = path.split('.');
  const many = head.endsWith('[]');
  const key = many ? head.slice(0, -2) : head;
  const v = (value as Record<string, unknown> | null)?.[key];
  const items = many ? (Array.isArray(v) ? v : []) : [v];
  return rest.length === 0 ? items : items.flatMap(i => valuesAt(i, rest.join('.')));
}

describe('ReplayStream: times', () => {
  it('shifted (default): every date-time of a frame moves by wall time minus recording time; raw controller texts never', async () => {
    const { rec, hub } = replay([snap(0), delta(1000, (({ id: _i, name: _n, ...g }) => g)(ctrl('rw7', 1000, 55)))]);
    await vi.advanceTimersByTimeAsync(1000);
    const sent = hub.frames()[0];
    const recorded = JSON.parse(rec.frames[1].text);
    const shift = WALL0 + 1000 - (START_MS + 1000);
    expect(sent.observedAt).toBe(new Date(WALL0 + 1000).toISOString());
    for (const path of dateTimePaths('DeltaFrame')) {
      const want = valuesAt(recorded, path).map(v => (typeof v === 'string' ? new Date(Date.parse(v) + shift).toISOString() : v));
      expect(valuesAt(sent, path), path).toEqual(want);
      // The fixture holds a time at every path, so none of them passes for want of a value.
      expect(want.length, path).toBeGreaterThan(0);
      expect(want.every(v => typeof v === 'string'), path).toBe(true);
    }
    // The times schema 0.13 added move with the rest: the link's, each lock's, RMMP's, each group's.
    const moved = (ms: number) => new Date(WALL0 + ms).toISOString();
    expect(sent.groups.link.downSince).toBe(moved(1000 - 60_000));
    expect(sent.groups.access.asOf).toBe(moved(-1000));
    expect(sent.groups.access.locks.map((l: { asOf: string }) => l.asOf)).toEqual([moved(-1000), moved(0)]);
    expect(sent.groups.access.rmmp.asOf).toBe(moved(500));
    expect(sent.groups.capabilities.asOf).toBe(moved(1000));
    expect(sent.groups.freshness.groups.map((g: { asOf: string }) => g.asOf)).toEqual([moved(1000), moved(-1000)]);
    expect(sent.groups.identity.startTime).toBe('2026-10-04 T 17:00:00');
    expect(sent.groups.events.recent[0].time.raw).toBe('2026-10-04 T 17:30:12');
    expect(sent.groups.panel.speedRatio).toBe(55);
  });

  it('shifted: a snapshot made for a consumer is stamped now, its values as old as they were at the position', async () => {
    const { stream } = replay(TIMELINE);
    await vi.advanceTimersByTimeAsync(1500);
    const s = new FakeSocket();
    stream.attach(s);
    const first = JSON.parse(s.sent[0]);
    expect(first).toMatchObject({ type: 'snapshot', schemaVersion: '0.13', observedAt: new Date(WALL0 + 1500).toISOString() });
    // panel.asOf was recorded at t=1000, 500 ms before the position: it is served 500 ms old.
    expect(first.controllers[0].panel.asOf).toBe(new Date(WALL0 + 1000).toISOString());
    expect(stream.answerNowMs()).toBe(WALL0 + 1500);
  });

  it('recorded: frames go out byte for byte; a snapshot made for a consumer is stamped sessionStartedAt + position', async () => {
    const { rec, hub, stream } = replay(TIMELINE, { time: 'recorded', paused: true });
    stream.control({ action: 'step' });
    stream.control({ action: 'step' });
    expect(hub.sent).toEqual([rec.frames[1].text, rec.frames[2].text]);
    const s = new FakeSocket();
    stream.attach(s);
    const first = JSON.parse(s.sent[0]);
    expect(first.observedAt).toBe(at(2000));
    expect(first.controllers[0].panel.asOf).toBe(at(2000));
    expect(stream.answerNowMs()).toBe(START_MS + 2000);
    expect(stream.health().time).toBe('recorded');
  });

  it('shiftIso and shiftTimes leave anything that is not a date-time alone', () => {
    expect(shiftIso('not a time', 5000)).toBe('not a time');
    expect(shiftIso(at(0), 0)).toBe(at(0));
    const v = { observedAt: null, controllers: [null, { link: { since: 7 } }] };
    shiftTimes('SnapshotFrame', v, 5000);
    expect(v).toEqual({ observedAt: null, controllers: [null, { link: { since: 7 } }] });
  });

  it('the date-time fields a replay moves are exactly those of the exported schema', () => {
    const schema = JSON.parse(readFileSync(new URL('../schema/v0.schema.json', import.meta.url), 'utf8')) as {
      definitions: Record<string, { properties?: Record<string, Record<string, unknown>> }>;
    };
    const refOf = (p: Record<string, unknown> | undefined): string | null => {
      if (!p) { return null; }
      if (typeof p.$ref === 'string') { return p.$ref.replace('#/definitions/', ''); }
      for (const k of ['anyOf', 'oneOf', 'allOf']) {
        for (const s of (p[k] as Array<Record<string, unknown>> | undefined) ?? []) { const r = refOf(s); if (r) { return r; } }
      }
      return null;
    };
    const fromSchema = (def: string, prefix = ''): string[] => {
      const out: string[] = [];
      for (const [name, p] of Object.entries(schema.definitions[def].properties ?? {})) {
        if (p.format === 'date-time') { out.push(`${prefix}${name}`); }
        const items = p.items as Record<string, unknown> | undefined;
        const ref = items ? refOf(items) : refOf(p);
        if (ref) { out.push(...fromSchema(ref, `${prefix}${name}${items ? '[]' : ''}.`)); }
      }
      return out;
    };
    for (const root of REPLAY_TIME_ROOTS) {
      expect([...dateTimePaths(root), ...dateTimePaths(root, 'fixed')].sort(), root).toEqual(fromSchema(root).sort());
      // Only the time a recording was made stays put.
      expect(dateTimePaths(root, 'fixed').every(p => p.endsWith('link.recordedAt')), root).toBe(true);
    }
    // Every definition the table names exists in the schema under that name.
    for (const def of Object.keys(TIMED_DEFINITIONS)) { expect(schema.definitions[def], def).toBeDefined(); }
  });
});

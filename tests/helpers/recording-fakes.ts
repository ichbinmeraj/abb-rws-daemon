/**
 * Fakes for the recorder's tests: the stream as an observer sees it, the
 * fleet's tap host, a manager's state, the recording folder in memory, a log,
 * clocks and timers. Shared read-only with other tests.
 */
import type { RobotState } from 'abb-rws-client';
import type { OwnerOnlyHandle } from '../../src/config.js';
import type {
  ClientTapSink, FrameObservation, FrameObserver, TapHost, TappedManagerView,
} from '../../src/recording/contract.js';
import type { RecorderTimers, RecordingFiles } from '../../src/recording/recorder.js';
import {
  SCHEMA_VERSION,
  type AccessLockInfo, type AccessLockName, type ControllerSnapshot, type DeltaGroups, type StreamFrame,
} from '../../src/schema/v0.js';

/**
 * A whole controller snapshot, every group present (the schema 0.13 shape:
 * `access`, `capabilities`, `freshness` and `link.downSince` included);
 * `identity` only when a system id is given. The link is healthy, so the
 * three groups say what a daemon serves for one: mastership read on this
 * connection (RobotWare 6 on RWS 1.0, else RobotWare 7), a full capability
 * table and everything current.
 */
export function snapshotOf(id: string, over: {
  sysId?: string; robotWare?: string; generation?: 'rws1' | 'rws2'; check?: 'confirmed' | 'unverified' | 'mismatch';
  eventTitle?: string; eventDescription?: string | null; speed?: number; observedAt?: string;
} = {}): ControllerSnapshot {
  const at = over.observedAt ?? '2026-10-04T15:30:12.345Z';
  const protocol = over.generation ?? 'rws2';
  const rw6 = protocol === 'rws1';
  const free = (lock: AccessLockName): AccessLockInfo =>
    ({ lock, held: false, holder: null, heldByDaemon: false, reported: 'nomaster', asOf: at, error: null });
  const motionLock: AccessLockInfo = {
    lock: 'motion', held: true, holder: { kind: 'local', name: null, application: 'TPU', flexPendant: true }, heldByDaemon: false,
    reported: 'local', asOf: at, error: null,
  };
  return {
    id,
    name: id.toUpperCase(),
    identity: over.sysId === undefined ? null : {
      controllerName: `${id}-ctrl`, controllerId: `${id}-cid`, controllerType: 'Virtual Controller', virtual: true,
      mac: '00-00-00-00-00-00', systemName: `${id}-system`, sysId: over.sysId, startTime: '2026-10-04 15:00:00',
      robotWare: {
        raw: over.robotWare ?? '7.21.4+417', major: 7, minor: 21, generation: over.generation ?? 'rws2',
      },
      options: ['RobotWare Base'], asOf: at,
    },
    link: {
      connected: true, quality: 'live', qualityReason: 'subscriptions streaming', since: at, downSince: null, host: '127.0.0.1', port: 9403,
      useHttps: true, subscriptions: { active: true },
      identityCheck: { status: over.check ?? 'unverified', expected: over.sysId ?? null, actual: over.sysId ?? null },
      reconnect: null, mode: 'live', recordedAt: null,
    },
    panel: { ctrlState: 'motoron', opMode: 'AUTO', speedRatio: over.speed ?? 100, collisionDetection: null, asOf: at },
    rapid: { execState: 'stopped', cycle: 'forever', tasks: [], asOf: at },
    motion: {
      watching: true,
      units: [{
        name: 'ROB_1', kind: 'robot', typeRaw: 'TCPRobot', task: 'T_ROB1',
        joints: [{ name: 'J1', value: 12.5, unit: 'deg', min: -180, max: 180 }],
        pose: { x: 2026, y: 10.04, z: 1530.12, q: [1, 0, 0, 0], tool: 'tool0', wobj: 'wobj0', coord: 'Base' },
        error: null,
      }],
      rate: { targetHz: 4, achievedHz: 4, via: 'poll' },
      asOf: at,
    },
    io: { watching: false, signals: [], asOf: null },
    events: {
      feed: `${id}-feed`, lastSeq: 1,
      recent: [{
        seq: 1, seqnum: 2026, code: 10010, severity: 'info', title: over.eventTitle ?? 'Motors ON state', titleFromCode: false,
        description: over.eventDescription ?? 'The system is in the Motors ON state.', causes: null, consequences: null,
        actions: null, args: [], source: null,
        time: { raw: '2026-10-04 15:30:00', utc: '2026-10-04T15:30:00.000Z', corrected: false },
        receivedAt: at, backlog: false,
      }],
      via: 'poll', clock: { offsetMs: 0, measuredAt: at, problem: null }, asOf: at, error: null,
    },
    access: {
      generation: rw6 ? 'rw6' : 'rw7', model: 'mastership',
      locks: rw6 ? [free('cfg'), motionLock, free('rapid')] : [free('edit'), motionLock],
      remoteAccessEnabled: null,
      rmmp: { supported: true, privilege: 'none', asOf: at, error: null },
      via: 'poll', problem: null, asOf: at,
    },
    capabilities: {
      protocol, generation: rw6 ? 'rw6' : 'rw7',
      robotWare: over.sysId === undefined ? null : over.robotWare ?? '7.21.4+417', tested: over.sysId === undefined ? null : true,
      entries: [
        { id: 'status-push', state: 'available', reason: null },
        { id: 'events-push', state: 'degraded', reason: 'no event subscription delivers; the log is read every few seconds' },
        { id: 'event-times', state: 'available', reason: null },
        rw6
          ? { id: 'io-push', state: 'unavailable', reason: 'watched signals are read by polling on RWS 1.0' }
          : { id: 'io-push', state: 'available', reason: null },
        { id: 'io-table', state: 'unknown', reason: 'the signal table is not loaded yet' },
        { id: 'joint-limits', state: 'available', reason: null },
        { id: 'mastership', state: 'available', reason: null },
        { id: 'write-access', state: 'unavailable', reason: 'RobotWare 6 and 7 use mastership' },
        { id: 'rmmp', state: 'available', reason: null },
      ],
      asOf: at,
    },
    freshness: {
      level: 'current', reasons: [],
      groups: [
        over.sysId === undefined
          ? { group: 'identity', state: 'unread', asOf: null, reason: 'not read yet' }
          : { group: 'identity', state: 'current', asOf: at, reason: null },
        { group: 'panel', state: 'current', asOf: at, reason: null },
        { group: 'rapid', state: 'current', asOf: at, reason: null },
        { group: 'motion', state: 'current', asOf: at, reason: null },
        { group: 'io', state: 'idle', asOf: null, reason: 'no consumer is watching' },
        { group: 'events', state: 'current', asOf: at, reason: null },
        { group: 'access', state: 'current', asOf: at, reason: null },
      ],
    },
  };
}

/**
 * The stream as the recorder sees it: frames broadcast to in-process
 * observers, and a hub of consumers the recorder must never touch.
 */
export class FakeFrameObserver implements FrameObserver {
  readonly controllers = new Map<string, ControllerSnapshot>();
  readonly observers = new Set<(frame: string) => void>();
  observeCalls = 0;
  snapshotCalls = 0;
  /** Stand-ins for attached consumers: each counts what it was sent and whether it was closed. */
  readonly consumers: Array<{ sent: number; closed: boolean }> = [];
  observedAt = '2026-10-04T15:30:12.345Z';

  constructor(initial: ControllerSnapshot[] = [], consumers = 0) {
    for (const c of initial) { this.controllers.set(c.id, c); }
    for (let i = 0; i < consumers; i++) { this.consumers.push({ sent: 0, closed: false }); }
  }

  observe(fn: (frame: string) => void): FrameObservation {
    this.observeCalls++;
    const first = this.build();
    this.observers.add(fn);
    return { first, stop: () => { this.observers.delete(fn); } };
  }

  snapshotFrame(): string {
    this.snapshotCalls++;
    return this.build();
  }

  /** Broadcast a frame (an object or its exact string) to the consumers and the observers. */
  emit(frame: StreamFrame | string): string {
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
    for (const c of this.consumers) { c.sent++; }
    for (const fn of [...this.observers]) { fn(text); }
    return text;
  }

  /** A controller changed: kept, and a delta with the given groups broadcast. */
  delta(c: ControllerSnapshot, groups: (keyof DeltaGroups)[]): string {
    this.controllers.set(c.id, c);
    const g: Record<string, unknown> = {};
    for (const k of groups) { g[k] = c[k]; }
    return this.emit({ type: 'delta', observedAt: this.observedAt, id: c.id, name: c.name, groups: g as DeltaGroups });
  }

  removed(id: string): string {
    this.controllers.delete(id);
    return this.emit({ type: 'removed', observedAt: this.observedAt, id });
  }

  private build(): string {
    return JSON.stringify({
      type: 'snapshot', schemaVersion: SCHEMA_VERSION, observedAt: this.observedAt, controllers: [...this.controllers.values()],
    });
  }
}

/** The fleet as a tap host: remembers every sink it was given. */
export class FakeTapHost implements TapHost {
  sink: ClientTapSink | null = null;
  readonly history: Array<ClientTapSink | null> = [];
  setTap(sink: ClientTapSink | null): void {
    this.sink = sink;
    this.history.push(sink);
  }
}

/** A client state with every key the client has, set to ordinary values. */
export function stateOf(over: Partial<RobotState> = {}): RobotState {
  return {
    connected: true, quality: 'live', qualityReason: 'subscriptions streaming', host: '127.0.0.1',
    ctrlstate: 'motoron', opmode: 'AUTO', execstate: 'stopped', execCycle: 'forever', speedRatio: 100, coldetstate: null,
    tasks: [], modules: ['MainModule'], modulesByTask: { T_ROB1: ['MainModule'] }, mechunits: ['ROB_1'],
    joints: null, cartesian: null, cartesianFull: null, identity: null, systemInfo: null,
    eventLog: [], ioSignals: [], ioSignalsLoaded: false,
    access: { locks: [] } as unknown as RobotState['access'],
    ...over,
  } as RobotState;
}

/** A manager as the recorder reads it: its state (replace keys to change it) and its connection. */
export function managerOf(state: RobotState, conn: { port?: number; useHttps?: boolean; groupPath?: string } = {}):
TappedManagerView & { state: RobotState; currentPort?: number; currentUseHttps?: boolean; subscriptionGroupPath?: string } {
  return {
    state,
    currentPort: conn.port ?? 9403,
    currentUseHttps: conn.useHttps ?? true,
    subscriptionGroupPath: conn.groupPath ?? '/subscription/5',
  };
}

/** One part file in memory. */
export interface MemoryFile {
  text: string;
  closed: boolean;
  writes: number;
}

/**
 * The recordings folder in memory: parts made, written and closed through
 * their handles. Writes can be held (a stalled disk) or made to fail.
 */
export class MemoryFiles implements RecordingFiles {
  readonly files = new Map<string, MemoryFile>();
  prepared = 0;
  free = 100 * 1024 ** 3;
  used = 0;
  problem: string | null = null;
  failCreateAfter = Infinity;
  failWrites = false;
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  creates = 0;

  async prepareFolder(_dir: string): Promise<void> { this.prepared++; }
  async folderProblem(_dir: string): Promise<string | null> { return this.problem; }
  async freeBytes(_dir: string): Promise<number> { return this.free; }
  async folderBytes(_dir: string): Promise<number> { return this.used; }

  async create(path: string, firstLine: string): Promise<OwnerOnlyHandle> {
    this.creates++;
    if (this.creates > this.failCreateAfter) { throw new Error(`EACCES: permission denied, open '${path}'`); }
    const name = baseName(path);
    if (this.files.has(name)) { throw Object.assign(new Error('a file of that name already exists'), { code: 'EEXIST' }); }
    const file: MemoryFile = { text: firstLine, closed: false, writes: 0 };
    this.files.set(name, file);
    return {
      chmod: async () => {},
      stat: async () => ({ dev: 1, ino: this.files.size, mode: 0o100600, uid: 0 }),
      write: async (data: string) => {
        if (this.gate) { await this.gate; }
        if (this.failWrites) { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' }); }
        if (file.closed) { throw new Error('write after close'); }
        file.text += data;
        file.writes++;
        return { bytesWritten: Buffer.byteLength(data) };
      },
      close: async () => { file.closed = true; },
    };
  }

  /** Stall every write until release(). */
  hold(): void {
    if (this.gate) { return; }
    this.gate = new Promise(resolve => { this.open = resolve; });
  }

  release(): void {
    this.open?.();
    this.gate = null;
    this.open = null;
  }

  /** Every part's text, in name order. */
  texts(): string[] {
    return [...this.files.keys()].sort().map(k => this.files.get(k)!.text);
  }

  /** Every line of every part, parsed, in part order. */
  lines(): Array<Record<string, unknown>> {
    return this.texts().flatMap(parseJsonl);
  }
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** The complete lines of a JSONL text, parsed. */
export function parseJsonl(text: string): Array<Record<string, unknown>> {
  return text.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as Record<string, unknown>);
}

/** A log that keeps every entry. */
export class MemoryLog {
  readonly entries: Array<{ level: string; obj: object; msg?: string }> = [];
  debug(obj: object, msg?: string): void { this.entries.push({ level: 'debug', obj, msg }); }
  info(obj: object, msg?: string): void { this.entries.push({ level: 'info', obj, msg }); }
  warn(obj: object, msg?: string): void { this.entries.push({ level: 'warn', obj, msg }); }
  error(obj: object, msg?: string): void { this.entries.push({ level: 'error', obj, msg }); }
  /** Every entry as text, to search. */
  text(): string { return this.entries.map(e => `${e.level} ${e.msg ?? ''} ${JSON.stringify(e.obj)}`).join('\n'); }
}

/** A wall clock and a monotonic clock that move only when told. */
export class ManualClock {
  wallMs = Date.parse('2026-10-04T15:30:12.345Z');
  monoMs = 1000;
  wall = (): number => this.wallMs;
  mono = (): number => this.monoMs;
  advance(ms: number): void {
    this.wallMs += ms;
    this.monoMs += ms;
  }
}

/** Timers that run only when fired. */
export class ManualTimers implements RecorderTimers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clear(handle: unknown): void { this.pending.delete(handle as number); }
  /** Run every timer set for exactly `ms` (or all when omitted). */
  fire(ms?: number): void {
    for (const [id, t] of [...this.pending]) {
      if (ms !== undefined && t.ms !== ms) { continue; }
      this.pending.delete(id);
      t.fn();
    }
  }
}

/** Let queued writes and promise callbacks run. */
export async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) { await new Promise<void>(resolve => setImmediate(resolve)); }
}

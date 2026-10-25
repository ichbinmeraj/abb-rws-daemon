import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { RwsError, type ElogMessage, type RobotState } from 'abb-rws-client';
import { ControllerFleet, NO_CLOCK_READER } from '../src/fleet.js';
import { EVENTS_POLL_MS, EVENTS_RECHECK_MS, eventsRetryMs } from '../src/events.js';
import { CLOCK_REFRESH_MS, type EventsGroup } from '../src/schema/v0.js';
import type { ControllerConfig } from '../src/config.js';

const RW7_ID = '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}';
const RW8_ID = '{DDDEA751-93CE-4DAC-8D85-55725137AF66}';
const ID = 'irb1600-6-120-1';
const T0 = Date.parse('2026-09-29T10:00:00Z');

/** The controller's clock in these tests: two hours ahead (its local zone) and 3 s fast. */
const CLOCK_OFFSET_MS = -(2 * 3_600_000 + 3_000);

/** What the controller's clock reads at a UTC moment, as the controllers write it ("2026-09-29 T 12:00:03"). */
const controllerTime = (utcMs: number) => new Date(utcMs - CLOCK_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' T ');

/** The controller as configured; `systemId` null: added without one. */
const cfg = (systemId: string | null = RW7_ID): ControllerConfig => ({
  id: ID, name: 'IRB1600_6_120_1', host: '127.0.0.1', port: 9403, useHttps: true,
  username: 'Default User', password: 'x', ...(systemId ? { systemId } : {}),
});

/** A message as the client's readers return it (see tests/events.test.ts for the recorded shapes). */
const message = (seqnum: number, code: number, tstamp: string, title: string): ElogMessage => ({
  seqnum, code, msgtype: 1, timestamp: tstamp, srcName: 'MC0', title, desc: '', causes: '', consequences: '', actions: '', args: [],
});

/** A controller's manager, reduced to what the event reader touches. */
function fakeManager(opts: { generation?: 'rws1' | 'rws2' } = {}) {
  const generation = opts.generation ?? 'rws2';
  const m = {
    /** The controller's log, oldest first. */
    log: [] as ElogMessage[],
    logReads: 0,
    clockReads: 0,
    failLog: null as Error | null,
    failClock: null as Error | null,
    /** While set, every read of the log waits for it. */
    logGate: null as Promise<void> | null,
    /** What the clock reads; null: the controller's clock at this moment. */
    clockReading: null as string | null,
    currentPort: 9403 as number | undefined,
    currentUseHttps: (generation === 'rws2') as boolean | undefined,
    subscriptionGroupPath: (generation === 'rws2' ? '/subscription/1' : undefined) as string | undefined,
    state: {
      connected: true, quality: 'live', qualityReason: 'WebSocket events streaming', identity: null,
      systemInfo: { name: 'x', rwVersion: '7.21.0', sysid: RW7_ID, startTime: '', options: [] },
      tasks: [], mechunits: [], ioSignals: [],
      eventLog: [] as ElogMessage[],
    } as unknown as RobotState,
    /** The log as the client lists it: newest first on RWS 1.0, oldest first on RWS 2.0. */
    listing: (): ElogMessage[] => (generation === 'rws1' ? [...m.log].reverse() : [...m.log]),
    getEventLog: async (_domain?: number, _lang?: string): Promise<ElogMessage[]> => {
      m.logReads++;
      if (m.logGate) { await m.logGate; }
      if (m.failLog) { throw m.failLog; }
      return m.listing();
    },
    getControllerClock: async (): Promise<string> => {
      m.clockReads++;
      if (m.failClock) { throw m.failClock; }
      return m.clockReading ?? controllerTime(Date.now());
    },
    /** The controller logs a message now. */
    raise: (seqnum: number, code: number, title: string) => { m.log.push(message(seqnum, code, controllerTime(Date.now()), title)); },
    /** The manager reads the log again, as it does for every message the controller announces. */
    managerRead: () => { m.state.eventLog = m.listing(); },
  };
  return m;
}

let fleet: ControllerFleet | null = null;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

// The clock starts a tick before T0, so the reader's first tick - and its first clock reading - is at T0 exactly.
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0 - 250); });
afterEach(() => { fleet?.stopEventReader(); fleet = null; vi.useRealTimers(); });

/** A fleet reading `manager`. Its sessions are stubbed: nothing here connects to, or logs out of, anything. */
function fleetWith(manager: ReturnType<typeof fakeManager>, config: ControllerConfig = cfg()): ControllerFleet {
  fleet = new ControllerFleet([config], silent);
  const inner = fleet as unknown as {
    managerOf: () => unknown;
    multi: { connectRobot: (id: string) => Promise<void>; disconnectRobot: (id: string) => Promise<void> };
  };
  inner.managerOf = () => manager;
  inner.multi.connectRobot = async () => {};
  inner.multi.disconnectRobot = async () => {};
  return fleet;
}

const eventsOf = (f: ControllerFleet): EventsGroup => f.get(ID)!.events;

/** Start the reader and let it measure the clock (tick at T0) and read the log (tick at T0 + 250). */
async function started(mgr: ReturnType<typeof fakeManager>, config?: ControllerConfig): Promise<ControllerFleet> {
  const f = fleetWith(mgr, config);
  f.startEventReader();
  await vi.advanceTimersByTimeAsync(600);
  return f;
}

describe('event reader: a live link', () => {
  it('measures the controller clock first, then reads the log once; the backlog carries corrected times', async () => {
    const mgr = fakeManager();
    mgr.log = [message(1, 10046, controllerTime(T0 - 60_000), 'System reset'), message(2, 10056, controllerTime(T0 - 30_000), 'System shutdown initiated')];
    const f = await started(mgr);
    expect(mgr.clockReads).toBe(1);
    expect(mgr.logReads).toBe(1);
    const ev = eventsOf(f);
    expect(ev).toMatchObject({ via: 'subscription', lastSeq: 2, error: null, asOf: new Date(Date.now()).toISOString() });
    expect(ev.clock).toEqual({ offsetMs: CLOCK_OFFSET_MS, measuredAt: new Date(T0).toISOString(), problem: null });
    expect(ev.recent.map(e => [e.seq, e.seqnum, e.backlog])).toEqual([[1, 1, true], [2, 2, true]]);
    expect(ev.recent[0].time).toEqual({ raw: controllerTime(T0 - 60_000), utc: new Date(T0 - 60_000).toISOString(), corrected: true });
    expect(ev.feed).toEqual(expect.any(String));
  });

  it('then takes the manager\'s own reads, one per announced message, and reads nothing itself until the recheck', async () => {
    const mgr = fakeManager();
    mgr.raise(1, 10046, 'System reset');
    const f = await started(mgr);
    await vi.advanceTimersByTimeAsync(1_000);
    mgr.raise(2, 10011, 'Motors ON state');
    mgr.managerRead();
    await vi.advanceTimersByTimeAsync(250);
    expect(eventsOf(f).recent.at(-1)).toMatchObject({ seq: 2, seqnum: 2, backlog: false, title: 'Motors ON state' });
    expect(eventsOf(f).recent.at(-1)!.time.utc).toBe(new Date(Date.now() - 250).toISOString().replace(/\.\d{3}Z$/, '.000Z'));
    expect(mgr.logReads).toBe(1);
    // The same listing again, and a late repeat of it, add nothing.
    mgr.managerRead();
    await vi.advanceTimersByTimeAsync(250);
    expect(eventsOf(f).lastSeq).toBe(2);
    // No listing for EVENTS_RECHECK_MS: the reader looks itself.
    await vi.advanceTimersByTimeAsync(EVENTS_RECHECK_MS - 1_000);
    expect(mgr.logReads).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mgr.logReads).toBe(2);
  });

  it('measures the clock again every CLOCK_REFRESH_MS', async () => {
    const mgr = fakeManager();
    const f = await started(mgr);
    mgr.clockReading = controllerTime(T0 + CLOCK_REFRESH_MS + 5_000);   // the controller's clock was set 5 s forward
    await vi.advanceTimersByTimeAsync(CLOCK_REFRESH_MS);
    expect(mgr.clockReads).toBe(2);
    expect(eventsOf(f).clock.offsetMs).toBe(CLOCK_OFFSET_MS - 5_000);
  });

  it('a stream that came back in a new RWS 2.0 group is caught up once: a message it did not announce is recorded', async () => {
    const mgr = fakeManager();
    mgr.raise(1, 10046, 'System reset');
    const f = await started(mgr);
    mgr.raise(2, 10012, 'Safety guard stop state');   // while the stream was down: never announced
    mgr.subscriptionGroupPath = '/subscription/2';
    await vi.advanceTimersByTimeAsync(250);
    expect(mgr.logReads).toBe(2);
    expect(eventsOf(f).recent.map(e => e.seqnum)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mgr.logReads).toBe(2);
  });
});

describe('event reader: falls back to polling', () => {
  it('reads the log every EVENTS_POLL_MS while the subscription is down, and catches up once when it comes back', async () => {
    const mgr = fakeManager({ generation: 'rws1' });
    mgr.raise(1, 10046, 'System reset');
    const f = await started(mgr);
    expect(mgr.logReads).toBe(1);
    Object.assign(mgr.state, { quality: 'polling', qualityReason: 'live event stream lost - fast polling' });
    await vi.advanceTimersByTimeAsync(250);
    expect(mgr.logReads).toBe(2);   // at once: messages may have passed while the stream failed
    expect(eventsOf(f).via).toBe('poll');
    mgr.raise(2, 10010, 'Motors OFF state');
    await vi.advanceTimersByTimeAsync(EVENTS_POLL_MS);
    expect(mgr.logReads).toBe(3);
    expect(eventsOf(f).recent.map(e => [e.seqnum, e.backlog])).toEqual([[1, true], [2, false]]);
    expect(eventsOf(f).asOf).toBe(new Date(T0 + 250 + 250 + EVENTS_POLL_MS).toISOString());
    await vi.advanceTimersByTimeAsync(EVENTS_POLL_MS);
    expect(mgr.logReads).toBe(4);
    // The stream is back (RWS 1.0 has no group to change; the link says so).
    Object.assign(mgr.state, { quality: 'live', qualityReason: 'live event stream restored' });
    mgr.raise(3, 10011, 'Motors ON state');
    await vi.advanceTimersByTimeAsync(250);
    expect(mgr.logReads).toBe(5);
    expect(eventsOf(f)).toMatchObject({ via: 'subscription', lastSeq: 3 });
    await vi.advanceTimersByTimeAsync(EVENTS_POLL_MS * 3);
    expect(mgr.logReads).toBe(5);
  });

  it('a read begun before the stream failed is no catch-up: another read follows at once', async () => {
    const mgr = fakeManager();
    mgr.raise(1, 10046, 'System reset');
    const f = await started(mgr);
    let release: () => void = () => {};
    mgr.logGate = new Promise(res => { release = res; });
    await vi.advanceTimersByTimeAsync(EVENTS_RECHECK_MS);   // the recheck goes out, and hangs
    expect(mgr.logReads).toBe(2);
    Object.assign(mgr.state, { quality: 'polling', qualityReason: 'live event stream lost - fast polling' });
    await vi.advanceTimersByTimeAsync(250);
    expect(mgr.logReads).toBe(2);   // one read at a time
    mgr.logGate = null;
    release();
    await vi.advanceTimersByTimeAsync(250);
    expect(mgr.logReads).toBe(3);   // the catch-up for the polling period, not EVENTS_POLL_MS later
    expect(eventsOf(f).via).toBe('poll');
  });

  it('a long RWS 2.0 log is read a second per page apart (one request per 50 messages)', async () => {
    const mgr = fakeManager();
    for (let i = 1; i <= 400; i++) { mgr.log.push(message(i, 10011, controllerTime(T0 - (400 - i) * 1000), 'Motors ON state')); }
    Object.assign(mgr.state, { quality: 'polling', qualityReason: 'WebSocket unavailable - fast polling' });
    const f = await started(mgr);
    expect(mgr.logReads).toBe(1);
    await vi.advanceTimersByTimeAsync(7_500);
    expect(mgr.logReads).toBe(1);   // 8 pages: 8 s apart, not EVENTS_POLL_MS
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.logReads).toBe(2);
    expect(eventsOf(f).lastSeq).toBe(256);   // of a 400-message backlog, the newest EVENTS_KEEP_MAX
  });

  it('the manager\'s own read while polling puts the reader\'s next read off', async () => {
    const mgr = fakeManager();
    Object.assign(mgr.state, { quality: 'polling', qualityReason: 'WebSocket unavailable - fast polling' });
    const f = await started(mgr);
    await vi.advanceTimersByTimeAsync(3_000);
    mgr.raise(1, 10011, 'Motors ON state');
    mgr.managerRead();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mgr.logReads).toBe(1);
    expect(eventsOf(f).lastSeq).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mgr.logReads).toBe(2);
  });
});

describe('event reader: across reconnects', () => {
  it('records nothing twice: after a reconnect only what came during the gap is new', async () => {
    const mgr = fakeManager();
    mgr.raise(1, 10046, 'System reset');
    mgr.raise(2, 10056, 'System shutdown initiated');
    const f = await started(mgr);
    mgr.managerRead();
    // The link goes down; the manager empties its copy of the log.
    Object.assign(mgr.state, { connected: false, quality: 'disconnected', qualityReason: 'auto-disconnected after 3 failed polls', eventLog: [] });
    mgr.currentPort = undefined;
    mgr.currentUseHttps = undefined;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(eventsOf(f)).toMatchObject({ via: null, lastSeq: 2 });
    mgr.raise(3, 10010, 'Motors OFF state');   // while nobody was connected
    // Back, on another port (a virtual controller that restarted), with a new group.
    Object.assign(mgr.state, { connected: true, quality: 'live', qualityReason: 'WebSocket events streaming' });
    mgr.currentPort = 9404;
    mgr.currentUseHttps = true;
    mgr.subscriptionGroupPath = '/subscription/7';
    await vi.advanceTimersByTimeAsync(600);
    expect(mgr.clockReads).toBe(2);   // a new connection: the clock first
    expect(mgr.logReads).toBe(2);
    mgr.managerRead();   // the manager's own first read of the new connection
    await vi.advanceTimersByTimeAsync(250);
    expect(eventsOf(f).recent.map(e => [e.seq, e.seqnum, e.backlog])).toEqual([[1, 1, true], [2, 2, true], [3, 3, false]]);
  });
});

describe('event reader: the clock', () => {
  it('a failed clock read leaves times uncorrected and says why; the next reading corrects them', async () => {
    const mgr = fakeManager();
    mgr.raise(1, 10046, 'System reset');
    mgr.failClock = new RwsError('Controller is busy: 503', 'CONTROLLER_BUSY', 503);
    const f = await started(mgr);
    expect(mgr.logReads).toBe(1);   // the failed attempt does not hold the log back
    let ev = eventsOf(f);
    expect(ev.clock.offsetMs).toBeNull();
    expect(ev.clock.problem).toMatch(/^the controller clock could not be read: /);
    expect(ev.recent[0].time).toMatchObject({ raw: controllerTime(T0 - 250), corrected: false });
    mgr.failClock = null;
    await vi.advanceTimersByTimeAsync(eventsRetryMs(1));
    ev = eventsOf(f);
    expect(ev.clock).toMatchObject({ offsetMs: expect.any(Number), problem: null });
    expect(ev.recent[0].time).toEqual({ raw: controllerTime(T0 - 250), utc: new Date(T0 - 1_000).toISOString(), corrected: true });
  });

  it('a reading that is no date and time is refused, and says what it was', async () => {
    const mgr = fakeManager();
    mgr.clockReading = 'NaN-NaN';
    const f = await started(mgr);
    expect(eventsOf(f).clock).toMatchObject({ offsetMs: null, problem: 'the controller clock read "NaN-NaN", which is no date and time' });
  });

  it('a client that cannot read the clock: times are uncorrected, and the group says why', async () => {
    const mgr = fakeManager();
    delete (mgr as { getControllerClock?: unknown }).getControllerClock;
    mgr.raise(1, 10046, 'System reset');
    const f = await started(mgr);
    const ev = eventsOf(f);
    expect(ev.clock).toEqual({ offsetMs: null, measuredAt: null, problem: NO_CLOCK_READER });
    expect(ev.recent[0].time.corrected).toBe(false);
    expect(mgr.logReads).toBe(1);
  });
});

describe('event reader: failures and trust', () => {
  it('a failed read puts the error in the group and is retried on a backoff; a success clears it', async () => {
    const mgr = fakeManager();
    mgr.failLog = new RwsError('Controller is busy: 503', 'CONTROLLER_BUSY', 503);
    const f = await started(mgr);
    expect(mgr.logReads).toBe(1);
    expect(eventsOf(f)).toMatchObject({ error: { code: 'CONTROLLER_BUSY' }, asOf: null });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mgr.logReads).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mgr.logReads).toBe(2);   // 5 s after the first
    mgr.failLog = null;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mgr.logReads).toBe(3);   // 10 s after the second
    expect(eventsOf(f)).toMatchObject({ error: null, asOf: expect.any(String) });
  });

  it('reads nothing from a link not yet confirmed to be the controller that was added, nor from another controller', async () => {
    const mgr = fakeManager();
    mgr.raise(1, 10046, 'System reset');
    (mgr.state as { systemInfo: unknown }).systemInfo = null;   // this link's system id is not read yet
    const f = await started(mgr);
    expect([mgr.clockReads, mgr.logReads]).toEqual([0, 0]);
    expect(eventsOf(f)).toMatchObject({ via: null, lastSeq: 0 });
    (mgr.state as { systemInfo: unknown }).systemInfo = { name: 'x', rwVersion: '8.1.1', sysid: RW8_ID, startTime: '', options: [] };
    await vi.advanceTimersByTimeAsync(1_000);
    expect([mgr.clockReads, mgr.logReads]).toEqual([0, 0]);
    expect(eventsOf(f).feed).toBeNull();   // a stranger's link carries none of it
    (mgr.state as { systemInfo: unknown }).systemInfo = { name: 'x', rwVersion: '7.21.0', sysid: RW7_ID, startTime: '', options: [] };
    await vi.advanceTimersByTimeAsync(600);
    expect([mgr.clockReads, mgr.logReads]).toEqual([1, 1]);
    expect(eventsOf(f).lastSeq).toBe(1);
  });

  it('a controller added without a system id is read at once: its first read records the id', async () => {
    const mgr = fakeManager();
    mgr.raise(1, 10046, 'System reset');
    (mgr.state as { systemInfo: unknown }).systemInfo = null;
    const f = await started(mgr, cfg(null));
    expect(mgr.logReads).toBe(1);
    expect(eventsOf(f).lastSeq).toBe(1);
  });

  it('the manager\'s empty log means nothing; an empty log the reader read is empty, and what follows is new', async () => {
    const mgr = fakeManager();
    const f = await started(mgr);
    expect(mgr.logReads).toBe(1);
    mgr.raise(1, 10011, 'Motors ON state');
    mgr.managerRead();
    await vi.advanceTimersByTimeAsync(250);
    expect(eventsOf(f).recent).toMatchObject([{ seq: 1, backlog: false }]);
  });

  it('a read whose link changed under it records nothing', async () => {
    const mgr = fakeManager();
    let release: () => void = () => {};
    mgr.logGate = new Promise(res => { release = res; });
    mgr.raise(1, 10046, 'System reset');
    const f = await started(mgr);
    expect(mgr.logReads).toBe(1);
    mgr.currentPort = 9500;   // another connection while the read was out
    release();
    await vi.advanceTimersByTimeAsync(0);
    mgr.logGate = null;
    mgr.log = [message(9, 10010, controllerTime(T0), 'Motors OFF state')];
    await vi.advanceTimersByTimeAsync(600);
    expect(eventsOf(f).recent.map(e => e.seqnum)).toEqual([9]);
  });
});

describe('event reader: teardown', () => {
  it('remove(): the read in flight records nothing, and nothing is read after', async () => {
    const mgr = fakeManager();
    let release: () => void = () => {};
    mgr.logGate = new Promise(res => { release = res; });
    mgr.raise(1, 10046, 'System reset');
    const f = await started(mgr);
    expect(mgr.logReads).toBe(1);
    const removed = f.remove(ID);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await removed;
    await vi.advanceTimersByTimeAsync(EVENTS_POLL_MS * 4);
    expect([mgr.clockReads, mgr.logReads]).toEqual([1, 1]);
    expect(f.events(ID, undefined, 10)).toBeNull();
  });

  it('disconnectAll(): the reader stops, and the read in flight is waited for', async () => {
    const mgr = fakeManager();
    let release: () => void = () => {};
    mgr.logGate = new Promise(res => { release = res; });
    const f = await started(mgr);
    const stopped = f.disconnectAll({ waitMs: 2_000 });
    release();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopped;
    await vi.advanceTimersByTimeAsync(EVENTS_POLL_MS * 4);
    expect([mgr.clockReads, mgr.logReads]).toEqual([1, 1]);
  });

  it('a controller added again under the same id starts a new feed', async () => {
    const mgr = fakeManager();
    mgr.raise(1, 10046, 'System reset');
    const f = await started(mgr);
    const first = eventsOf(f).feed;
    await f.remove(ID);
    f.add(cfg());
    await vi.advanceTimersByTimeAsync(600);
    const again = eventsOf(f);
    expect(again.feed).not.toBe(first);
    expect(again.recent).toMatchObject([{ seq: 1, backlog: true }]);
  });
});

describe('fleet.events', () => {
  it('pages the log from memory', async () => {
    const mgr = fakeManager();
    for (let i = 1; i <= 30; i++) { mgr.log.push(message(i, 10011, controllerTime(T0 - (30 - i) * 1000), 'Motors ON state')); }
    const f = await started(mgr);
    const reads = mgr.logReads;
    const page = f.events(ID, 25, 10)!;
    expect(page).toMatchObject({ feed: eventsOf(f).feed, firstSeq: 1, lastSeq: 30, gap: false, more: false });
    expect(page.events.map(e => e.seq)).toEqual([26, 27, 28, 29, 30]);
    expect(f.events(ID, undefined, 3)!.events.map(e => e.seq)).toEqual([28, 29, 30]);
    expect(mgr.logReads).toBe(reads);
    expect(f.events('nope', undefined, 3)).toBeNull();
  });
});

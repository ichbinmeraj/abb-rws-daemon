import { describe, it, expect, vi, afterEach } from 'vitest';
import { RwsError, type RobotState, type SubscriptionEvent, type SubscriptionResource } from 'abb-rws-client';
import { ControllerFleet } from '../src/fleet.js';
import { IO_CAP_REASON, IO_DROP_TRIES, IO_LEASE_MS, IO_WATCH_LEASE_MAX, IO_WATCH_MAX } from '../src/io.js';
import { NEW_LEASE, WATCH_LEASES_MAX, type IoWatch } from '../src/schema/v0.js';
import type { ControllerConfig } from '../src/config.js';

const RW7_ID = '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}';
const ID = 'irb1600-6-120-1';
const T0 = Date.parse('2026-09-27T12:00:00Z');

const cfg = (): ControllerConfig => ({
  id: ID, name: 'IRB1600_6_120_1', host: '127.0.0.1', port: 9403, useHttps: true,
  username: 'Default User', password: 'x', systemId: RW7_ID,
});

/** A controller's manager, reduced to what the I/O watcher touches. */
function fakeManager(opts: { groupPath?: string } = {}) {
  const taps: Array<(e: SubscriptionEvent) => void> = [];
  const m = {
    reads: [] as string[],
    added: [] as SubscriptionResource[][],
    /** The group each edit in `added` went to, and when it was sent. */
    addedTo: [] as string[],
    addedAt: [] as number[],
    /** While set, every group edit waits for it. */
    editGate: null as Promise<void> | null,
    /**
     * Signals the controller does not have: an edit naming one answers 400
     * -1073445866 and binds the others, which the error lists (`bound`).
     */
    refuse: new Set<string>(),
    /** Resources removed from the group (successful removals only), and when each removal was sent. */
    dropped: [] as SubscriptionResource[],
    droppedAt: [] as number[],
    dropAttempts: 0,
    /** Every group edit (add or removal) takes this long; how many were out at once, at most. */
    editMs: 0,
    editsOut: 0,
    maxEditsOut: 0,
    /** The next this-many removals fail. */
    failDrops: 0,
    failRead: null as Error | null,
    /** While set, every read waits for it. */
    readGate: null as Promise<void> | null,
    values: {} as Record<string, string>,
    currentPort: 9403 as number | undefined,
    currentUseHttps: true as boolean | undefined,
    subscriptionGroupPath: opts.groupPath,
    state: {
      connected: true, quality: 'live', qualityReason: 'x', identity: null,
      systemInfo: { name: 'x', rwVersion: '7.21.0', sysid: RW7_ID, startTime: '', options: [] },
      ioSignals: [],
    } as unknown as RobotState,
    onSubscriptionEvent: (fn: (e: SubscriptionEvent) => void) => {
      taps.push(fn);
      return () => { const i = taps.indexOf(fn); if (i >= 0) { taps.splice(i, 1); } };
    },
    fire: (resource: string, value: string) => { for (const t of [...taps]) { t({ resource, value, timestamp: new Date() }); } },
    tapCount: () => taps.length,
    searched: [] as object[],
    searchSignals: async (criteria: object) => { m.searched.push(criteria); return [{ name: 'do_found', type: 'DO', value: '0', lvalue: '0' }]; },
    readIoSignal: async (_n: string, _d: string, name: string) => {
      m.reads.push(name);
      // The controller answers with the value at the moment the read starts.
      const value = m.values[name] ?? '0';
      if (m.readGate) { await m.readGate; }
      if (m.failRead) { throw m.failRead; }
      return { name, value, lvalue: value, type: 'DO' as const };
    },
    updateSubscriptionGroup: (_g: string, resources: SubscriptionResource[]) => m.editing(async () => {
      m.added.push(resources);
      m.addedTo.push(_g);
      m.addedAt.push(Date.now());
      if (m.editGate) { await m.editGate; }
      if (resources.some(r => m.refuse.has(r.name))) {
        const msg = 'Invalid resource URI in Update Subscription request';
        throw Object.assign(new RwsError(`HTTP 400 - ${msg}`, 'RESOURCE_NOT_FOUND', 400, undefined, -1073445866, msg), {
          bound: resources.filter(r => !m.refuse.has(r.name)).map(r => `/rw/iosystem/signals/${r.name}`),
          refused: resources.filter(r => m.refuse.has(r.name)).map(r => `/rw/iosystem/signals/${r.name}`),
          body: '',
        });
      }
      return _g;
    }),
    unsubscribeResource: (_g: string, resource: SubscriptionResource) => m.editing(async () => {
      m.dropAttempts++;
      m.droppedAt.push(Date.now());
      if (m.failDrops > 0) { m.failDrops--; throw new RwsError('HTTP 500 - subscription service busy', 'UNKNOWN'); }
      m.dropped.push(resource);
    }),
    /** Run one group edit: counted while it is out, taking editMs. */
    editing: async <T>(edit: () => Promise<T>): Promise<T> => {
      m.editsOut++;
      m.maxEditsOut = Math.max(m.maxEditsOut, m.editsOut);
      try {
        if (m.editMs > 0) { await new Promise(res => setTimeout(res, m.editMs)); }
        return await edit();
      } finally {
        m.editsOut--;
      }
    },
  };
  return m;
}

let fleet: ControllerFleet | null = null;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fleetWith(manager: ReturnType<typeof fakeManager>): ControllerFleet {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  fleet = new ControllerFleet([cfg()], silent);
  (fleet as unknown as { managerOf: () => unknown }).managerOf = () => manager;
  return fleet;
}
afterEach(() => { fleet?.stopIoPoller(); fleet = null; vi.useRealTimers(); });

/** Watch do_a and do_b on a live group until both are subscribed, read once, and served by an event. */
async function boundPair(mgr: ReturnType<typeof fakeManager>): Promise<ControllerFleet> {
  const f = fleetWith(mgr);
  f.watchIo(ID, ['do_a', 'do_b']);
  f.startIoPoller();
  await vi.advanceTimersByTimeAsync(1_000);
  mgr.fire('/rw/iosystem/signals/do_a;state', mgr.values.do_a);
  mgr.fire('/rw/iosystem/signals/do_b;state', mgr.values.do_b);
  const settled = mgr.reads.length;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(mgr.reads.length).toBe(settled);   // both served by the group
  expect(f.get(ID)!.io.signals.map(s => s.via)).toEqual(['subscription', 'subscription']);
  return f;
}

describe('watchIo - the lease', () => {
  it('returns the lease and dedupes, trims and caps the requested signals', () => {
    const f = fleetWith(fakeManager());
    const names = Array.from({ length: IO_WATCH_MAX + 3 }, (_, i) => `do_${i}`);
    const w = f.watchIo(ID, [' do_0 ', 'do_0', ...names.slice(1)])!;
    expect(w.leaseMs).toBe(IO_LEASE_MS);
    expect(w.accepted).toHaveLength(IO_WATCH_MAX);
    expect(w.accepted[0]).toBe('do_0');
    expect(w.rejected).toHaveLength(3);
    expect(w.rejected[0].reason).toContain(`${IO_WATCH_MAX}`);
  });

  it('refuses names that are not I/O signal names, and nothing of them reaches the controller', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    const f = fleetWith(mgr);
    const w = f.watchIo(ID, ['do_a', 'do_b&x=1', 'x?y', '../../rw/panel', 'a#b', 'Local/DRV_1/do_c', 'a/b'])!;
    expect(w.accepted).toEqual(['do_a', 'Local/DRV_1/do_c']);
    expect(w.rejected.map(r => r.name)).toEqual(['do_b&x=1', 'x?y', '../../rw/panel', 'a#b', 'a/b']);
    for (const r of w.rejected) { expect(r.reason).toMatch(/^not an I\/O signal name/); }
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);
    const touched = new Set([...mgr.reads, ...mgr.added.flat().map(r => r.name)]);
    expect(touched).toEqual(new Set(['do_a', 'Local/DRV_1/do_c']));
  });

  it('checks names against the controller`s signal table once it is loaded on this connection', () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    const state = mgr.state as unknown as { ioSignals: Array<{ name: string }>; ioSignalsLoaded: boolean };
    state.ioSignals = [{ name: 'do_a' }, { name: 'di_b' }];
    state.ioSignalsLoaded = false;   // an old table, or none: not a verdict
    expect(f.watchIo(ID, ['zzNoSuchSignal01'])!.accepted).toEqual(['zzNoSuchSignal01']);
    state.ioSignalsLoaded = true;
    const w = f.watchIo(ID, ['do_a', 'zzNoSuchSignal01', 'Local/DRV_1/di_b', 'Local/DRV_1/do_zz'])!;
    expect(w.accepted).toEqual(['do_a', 'Local/DRV_1/di_b']);
    expect(w.rejected).toEqual([
      { name: 'zzNoSuchSignal01', reason: 'no such signal on this controller' },
      { name: 'Local/DRV_1/do_zz', reason: 'no such signal on this controller' },
    ]);
    expect(f.get(ID)!.io.signals.map(s => s.name)).toEqual(['do_a', 'Local/DRV_1/di_b']);
  });

  it('on RWS 1.0 a table one page long may be cut short: a name missing from it is checked for its form only', async () => {
    const mgr = fakeManager();
    mgr.currentUseHttps = false;   // RWS 1.0: the client reads one page of the table
    mgr.values = { do_150: '1' };
    const f = fleetWith(mgr);
    const state = mgr.state as unknown as { ioSignals: Array<{ name: string }>; ioSignalsLoaded: boolean };
    state.ioSignals = Array.from({ length: 100 }, (_, i) => ({ name: `do_${i}` }));
    state.ioSignalsLoaded = true;
    const w = f.watchIo(ID, ['do_5', 'do_150', 'do_x&y=1'])!;
    expect(w.accepted).toEqual(['do_5', 'do_150']);
    expect(w.rejected.map(r => r.name)).toEqual(['do_x&y=1']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.get(ID)!.io.signals.find(s => s.name === 'do_150')).toMatchObject({ value: '1', via: 'poll' });
    // Shorter than a page, the table is the whole list, and still refuses.
    state.ioSignals = state.ioSignals.slice(0, 99);
    expect(f.watchIo(ID, ['do_150'])!.rejected).toEqual([{ name: 'do_150', reason: 'no such signal on this controller' }]);
  });

  it('on RWS 2.0 the table is walked to its end and refuses at any length', () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    const state = mgr.state as unknown as { ioSignals: Array<{ name: string }>; ioSignalsLoaded: boolean };
    state.ioSignals = Array.from({ length: 100 }, (_, i) => ({ name: `do_${i}` }));
    state.ioSignalsLoaded = true;
    expect(f.watchIo(ID, ['do_150'])!.rejected).toEqual([{ name: 'do_150', reason: 'no such signal on this controller' }]);
  });

  it('a watched name refused on renewal leaves the watch and the group', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_gone']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(500);
    expect(mgr.added.flat().map(r => r.name)).toEqual(['do_a', 'do_gone']);
    const state = mgr.state as unknown as { ioSignals: Array<{ name: string }>; ioSignalsLoaded: boolean };
    state.ioSignals = [{ name: 'do_a' }];
    state.ioSignalsLoaded = true;
    const w = f.watchIo(ID, ['do_a', 'do_gone'])!;
    expect(w.rejected.map(r => r.name)).toEqual(['do_gone']);
    expect(f.get(ID)!.io.signals.map(s => s.name)).toEqual(['do_a']);
    await vi.advanceTimersByTimeAsync(500);
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_gone' }]);
  });

  it('is null for an unknown controller', () => {
    const f = fleetWith(fakeManager());
    expect(f.watchIo('nope', ['do_x'])).toBeNull();
  });

  it('replacing the set keeps the kept signals` state and forgets the rest', async () => {
    const mgr = fakeManager();
    mgr.values = { do_a: '1', do_b: '0' };
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_b']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.get(ID)!.io.signals.find(s => s.name === 'do_a')!.value).toBe('1');
    f.watchIo(ID, ['do_a', 'di_new']);
    const g = f.get(ID)!.io;
    expect(g.signals.map(s => s.name)).toEqual(['do_a', 'di_new']);
    expect(g.signals[0].value).toBe('1');       // kept, not re-nulled
    expect(g.signals[1].value).toBeNull();      // new, not yet read
  });
});

describe('searchIoSignals - the signal directory', () => {
  type TableState = { connected: boolean; ioSignals: Array<{ name: string }>; ioSignalsLoaded?: boolean };

  it('is not-loaded, never an empty list, until the table is read on the current connection', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    const state = mgr.state as unknown as TableState;
    state.ioSignalsLoaded = false;              // after a reconnect: emptied, not read again yet
    expect(await f.searchIoSignals(ID, {})).toBe('not-loaded');
    state.ioSignals = [{ name: 'do_a' }];
    state.ioSignalsLoaded = true;
    expect(await f.searchIoSignals(ID, {})).toEqual([{ name: 'do_a' }]);
    state.ioSignals = [];                       // read, and the controller has none
    expect(await f.searchIoSignals(ID, {})).toEqual([]);
  });

  it('without the client`s flag, a connected link with a non-empty table counts as loaded', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    const state = mgr.state as unknown as TableState;
    delete state.ioSignalsLoaded;
    expect(await f.searchIoSignals(ID, {})).toBe('not-loaded');
    state.ioSignals = [{ name: 'do_a' }];
    expect(await f.searchIoSignals(ID, {})).toEqual([{ name: 'do_a' }]);
    state.connected = false;
    expect(await f.searchIoSignals(ID, {})).toBe('not-loaded');
  });

  it('a search with criteria goes to the controller whatever the cached table holds; an unknown id is null', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    (mgr.state as unknown as TableState).ioSignalsLoaded = false;
    expect(await f.searchIoSignals(ID, { type: 'DO' })).toEqual([{ name: 'do_found', type: 'DO', value: '0', lvalue: '0' }]);
    expect(mgr.searched).toEqual([{ type: 'DO' }]);
    expect(await f.searchIoSignals('nope', {})).toBeNull();
  });
});

describe('the poll path (no editable subscription group - RWS 1.0)', () => {
  it('reads nothing while nobody holds a lease', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.reads).toHaveLength(0);
    expect(f.get(ID)!.io.watching).toBe(false);
  });

  it('with a lease: round-robin reads at the budget, values served via poll', async () => {
    const mgr = fakeManager();
    mgr.values = { do_a: '1', do_b: '0' };
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_b']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);
    // ioPollHz(2, 'live', false) = 4 reads/s over 2 signals - each about twice a second.
    expect(mgr.reads.length).toBeGreaterThanOrEqual(3);
    expect(mgr.reads.length).toBeLessThanOrEqual(5);
    expect(mgr.reads.filter(n => n === 'do_a').length).toBeGreaterThanOrEqual(1);
    const g = f.get(ID)!.io;
    expect(g.watching).toBe(true);
    expect(g.signals.map(s => ({ name: s.name, value: s.value, via: s.via })))
      .toEqual([
        { name: 'do_a', value: '1', via: 'poll' },
        { name: 'do_b', value: '0', via: 'poll' },
      ]);
    expect(g.signals[0].type).toBe('DO');
    expect(g.asOf).not.toBeNull();
  });

  it('a failed read marks the signal and keeps its last value', async () => {
    const mgr = fakeManager();
    mgr.values = { do_a: '1' };
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(600);
    expect(f.get(ID)!.io.signals[0].value).toBe('1');
    mgr.failRead = new RwsError('no such signal', 'RESOURCE_NOT_FOUND');
    await vi.advanceTimersByTimeAsync(1_000);
    const s = f.get(ID)!.io.signals[0];
    expect(s.error).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(s.value).toBe('1');
  });

  it("a failed read keeps the controller's status, code and message on the signal", async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    const changed: string[] = [];
    f.onChanged(id => changed.push(id));
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    mgr.failRead = new RwsError('Resource does not exist on the controller: 404', 'RESOURCE_NOT_FOUND',
      404, '<html>raw</html>', -1073445862, 'Signal not found');
    await vi.advanceTimersByTimeAsync(600);
    expect(f.get(ID)!.io.signals[0].error).toEqual({
      code: 'RESOURCE_NOT_FOUND',
      message: 'Resource does not exist on the controller: 404',
      controller: { httpStatus: 404, code: -1073445862, message: 'Signal not found' },
    });
    // A different answer from the controller is news, even under the same code.
    const before = changed.length;
    mgr.failRead = new RwsError('Resource does not exist on the controller: 404', 'RESOURCE_NOT_FOUND',
      404, '<html>raw</html>', -1073445861, 'Device not running');
    await vi.advanceTimersByTimeAsync(600);
    expect(f.get(ID)!.io.signals[0].error?.controller).toEqual({ httpStatus: 404, code: -1073445861, message: 'Device not running' });
    expect(changed.length).toBeGreaterThan(before);
  });

  it('a lapsed lease stops the reads and freezes the group honestly', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);
    const before = mgr.reads.length;
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS + 1_000);
    expect(mgr.reads.length).toBeLessThanOrEqual(before + 30);  // lease ran out mid-window
    const g = f.get(ID)!.io;
    expect(g.watching).toBe(false);
    const after = mgr.reads.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.reads.length).toBe(after);
  });

  it('never reads a link on the wrong controller, and serves it nothing', async () => {
    const mgr = fakeManager();
    (mgr.state as unknown as { systemInfo: { sysid: string } }).systemInfo.sysid = '{DDDEA751-93CE-4DAC-8D85-55725137AF66}';
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.reads).toHaveLength(0);
    expect(f.get(ID)!.io).toEqual({ watching: false, signals: [], asOf: null });
  });
});

describe('the subscription path (live RWS 2.0 group)', () => {
  it('adds watched signals to the live group in chunks, never over the chunk size per edit', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    const f = fleetWith(mgr);
    f.watchIo(ID, Array.from({ length: 8 }, (_, i) => `do_${i}`));
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.added.length).toBeGreaterThanOrEqual(2);
    for (const edit of mgr.added) { expect(edit.length).toBeLessThanOrEqual(6); }
    expect(mgr.added.flat()).toHaveLength(8);
    expect(mgr.added.flat()[0]).toEqual({ type: 'signal', name: 'do_0' });
    expect(mgr.tapCount()).toBe(1);   // one tap per controller, not per signal
  });

  it('an event updates the watched signal: value, via subscription, no more polling for it', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '0' };
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(300);
    mgr.fire('/rw/iosystem/signals/Local/PANEL/do_a;state', '1');
    const s = f.get(ID)!.io.signals[0];
    expect(s).toMatchObject({ name: 'do_a', value: '1', via: 'subscription', error: null });
    const before = mgr.reads.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.reads.length).toBe(before);   // pushed values need no polling
  });

  it('an event without a value triggers exactly one confirming read', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '1' };
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(600);   // initial read done, subscribed
    mgr.fire('/rw/iosystem/signals/Local/PANEL/do_a;state', '1');   // now on the push path
    await vi.advanceTimersByTimeAsync(600);
    const before = mgr.reads.length;
    mgr.fire('/rw/iosystem/signals/Local/PANEL/do_a;state', '');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mgr.reads.length).toBe(before + 1);
  });

  it('a lapsed lease releases the subscribed resources', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_b']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(500);
    expect(mgr.added.flat().length).toBe(2);
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS + 1_000);
    expect(mgr.dropped).toEqual([
      { type: 'signal', name: 'do_a' },
      { type: 'signal', name: 'do_b' },
    ]);
  });

  it('a replaced set drops only the removed signal from the group', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_b']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(500);
    f.watchIo(ID, ['do_a']);
    await vi.advanceTimersByTimeAsync(500);   // removals go out on the watcher's budget
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_b' }]);
  });

  it('a signal bound to the group gets one confirming read after the add', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '0' };
    let open!: () => void;
    mgr.editGate = new Promise(res => { open = res; });
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);   // polled while the add is out
    expect(f.get(ID)!.io.signals[0]).toMatchObject({ value: '0', via: 'poll' });
    mgr.values = { do_a: '1' };                 // changed before the group delivers it
    const before = mgr.reads.length;
    open();
    mgr.editGate = null;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.reads.length).toBe(before + 1);
    expect(f.get(ID)!.io.signals[0]).toMatchObject({ value: '1', via: 'subscription' });
  });

  it('a bind keeps the polled value`s time until the confirming read replaces it', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '0' };
    let open!: () => void;
    mgr.editGate = new Promise(res => { open = res; });
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);   // polled while the add is out
    const polled = f.get(ID)!.io.signals[0];
    expect(polled).toMatchObject({ value: '0', via: 'poll' });
    expect(polled.asOf).not.toBeNull();
    mgr.values = { do_a: '1' };
    open();
    mgr.editGate = null;
    await vi.advanceTimersByTimeAsync(0);       // the bind lands; its confirming read is not out yet
    expect(f.get(ID)!.io.signals[0]).toMatchObject({ value: '0', asOf: polled.asOf });
    await vi.advanceTimersByTimeAsync(1_500);
    const confirmed = f.get(ID)!.io.signals[0];
    expect(confirmed).toMatchObject({ value: '1', via: 'subscription' });
    expect(Date.parse(confirmed.asOf!)).toBeGreaterThan(Date.parse(polled.asOf!));
  });

  it('an event without a value keeps the last confirmed time until its confirming read', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '0', do_b: '0' };
    const f = await boundPair(mgr);
    const before = f.get(ID)!.io.signals[0];
    expect(before.asOf).not.toBeNull();
    mgr.values.do_a = '1';
    mgr.fire('/rw/iosystem/signals/do_a;state', '');
    expect(f.get(ID)!.io.signals[0]).toMatchObject({ value: '0', asOf: before.asOf });
    await vi.advanceTimersByTimeAsync(1_000);
    const after = f.get(ID)!.io.signals[0];
    expect(after).toMatchObject({ value: '1', via: 'subscription' });
    expect(Date.parse(after.asOf!)).toBeGreaterThan(Date.parse(before.asOf!));
  });

  it('a bind that lands after the lease lapsed leaves the frozen values as they were', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '0' };
    let open!: () => void;
    mgr.editGate = new Promise(res => { open = res; });
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS + 500);   // polled while the add is out, then the lease lapses
    const frozen = f.get(ID)!.io;
    expect(frozen.watching).toBe(false);
    expect(frozen.signals[0].asOf).not.toBeNull();
    open();
    mgr.editGate = null;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.get(ID)!.io).toEqual(frozen);
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_a' }]);   // and it leaves the group again
  });

  it('after a lapsed lease, a re-watch shows no kept value as current and re-reads every signal', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    const names = Array.from({ length: 8 }, (_, i) => `do_${i}`);
    mgr.values = Object.fromEntries(names.map(n => [n, '0']));
    const f = fleetWith(mgr);
    f.watchIo(ID, names);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.get(ID)!.io.signals.every(s => s.value === '0' && s.asOf !== null)).toBe(true);
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS);   // the tab was hidden: the lease lapses
    expect(f.get(ID)!.io.watching).toBe(false);
    expect(mgr.dropped).toHaveLength(8);
    mgr.values = Object.fromEntries(names.map(n => [n, '1']));   // changed while nobody watched
    f.watchIo(ID, names);
    const g = f.get(ID)!.io;
    expect(g.watching).toBe(true);
    expect(g.asOf).toBeNull();
    for (const s of g.signals) { expect(s).toMatchObject({ value: '0', asOf: null, via: null }); }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.get(ID)!.io.signals.map(s => s.value)).toEqual(names.map(() => '1'));
    expect(f.get(ID)!.io.signals.every(s => s.asOf !== null && s.via === 'subscription')).toBe(true);
  });

  it('a group re-created on the same connection: signals are polled until they are added to the new group', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '1', do_b: '0' };
    const f = await boundPair(mgr);
    let open!: () => void;
    mgr.editGate = new Promise(res => { open = res; });
    const before = mgr.reads.length;
    // The stream reconnected: the client deleted its group and made a new one, still live, same port.
    mgr.subscriptionGroupPath = '/subscription/8';
    mgr.values = { do_a: '0', do_b: '1' };
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mgr.addedTo.at(-1)).toBe('/subscription/8');
    expect(mgr.added.at(-1)!.map(r => r.name)).toEqual(['do_a', 'do_b']);
    const meanwhile = mgr.reads.slice(before);
    expect(meanwhile).toContain('do_a');
    expect(meanwhile).toContain('do_b');
    expect(f.get(ID)!.io.signals.map(s => [s.value, s.via])).toEqual([['0', 'poll'], ['1', 'poll']]);
    open();
    mgr.editGate = null;
    await vi.advanceTimersByTimeAsync(1_000);
    const settled = mgr.reads.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.reads.length).toBe(settled);   // served by the new group
    mgr.fire('/rw/iosystem/signals/do_a;state', '1');
    expect(f.get(ID)!.io.signals[0]).toMatchObject({ value: '1', via: 'subscription' });
  });

  it('an edit that lands after the group was re-created does not count for the new group', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    let open!: () => void;
    mgr.editGate = new Promise(res => { open = res; });
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(200);
    expect(mgr.addedTo).toEqual(['/subscription/7']);
    mgr.subscriptionGroupPath = '/subscription/8';
    await vi.advanceTimersByTimeAsync(200);
    open();
    mgr.editGate = null;
    await vi.advanceTimersByTimeAsync(500);
    expect(mgr.addedTo).toEqual(['/subscription/7', '/subscription/8']);
  });

  it('a stream lost for good (no group, link polling): every watched signal is polled again', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '1', do_b: '0' };
    const f = await boundPair(mgr);
    const before = mgr.reads.length;
    const edits = mgr.added.length;
    mgr.subscriptionGroupPath = undefined;
    (mgr.state as { quality: string }).quality = 'polling';
    mgr.values = { do_a: '0', do_b: '1' };
    await vi.advanceTimersByTimeAsync(3_000);
    const reads = mgr.reads.slice(before);
    expect(reads.filter(n => n === 'do_a').length).toBeGreaterThanOrEqual(2);
    expect(reads.filter(n => n === 'do_b').length).toBeGreaterThanOrEqual(2);
    expect(mgr.added.length).toBe(edits);   // no group to add to
    expect(f.get(ID)!.io.signals.map(s => [s.value, s.via])).toEqual([['0', 'poll'], ['1', 'poll']]);
  });

  it('a signal taken out of the watch while its add is out leaves the group when the add lands', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    let open!: () => void;
    mgr.editGate = new Promise(res => { open = res; });
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_b']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(200);
    expect(mgr.added).toEqual([[{ type: 'signal', name: 'do_a' }, { type: 'signal', name: 'do_b' }]]);
    f.watchIo(ID, ['do_a']);
    expect(mgr.dropped).toEqual([]);   // not in the group yet as far as the watcher knows
    open();
    mgr.editGate = null;
    await vi.advanceTimersByTimeAsync(500);
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_b' }]);
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS);   // at the lapse only do_a is left to release
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_b' }, { type: 'signal', name: 'do_a' }]);
  });

  it('a refused add backs off per signal: never again within a second, then doubling', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.refuse.add('do_bad');
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_bad']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(10_000);
    // Sent at about 0, 1, 3 and 7 s - not every tick.
    expect(mgr.added).toHaveLength(4);
    const gaps = mgr.addedAt.slice(1).map((t, i) => t - mgr.addedAt[i]);
    for (const [i, gap] of gaps.entries()) { expect(gap).toBeGreaterThanOrEqual(1_000 * 2 ** i); }
    expect(f.get(ID)!.io.signals[0]).toMatchObject({ via: 'poll' });   // polled meanwhile
  });

  it('one refused name among 12, listed first, keeps no other signal out of the group', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.refuse.add('do_bad');
    const good = Array.from({ length: 11 }, (_, i) => `do_${i + 1}`);
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_bad', ...good]);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(5_000);
    for (const edit of mgr.added) { expect(edit.length).toBeLessThanOrEqual(6); }
    // The edit that named do_bad bound the five valid names beside it: none is sent again.
    for (const n of good) { expect(mgr.added.filter(e => e.some(r => r.name === n))).toHaveLength(1); }
    // The refused name is retried alone after the first failure, at 1 s and then 3 s.
    const withBad = mgr.added.filter(e => e.some(r => r.name === 'do_bad'));
    expect(withBad.length).toBeLessThanOrEqual(3);
    expect(withBad.slice(1).every(e => e.length === 1)).toBe(true);
    // Only the refused signal is still polled; the group serves the rest.
    const before = mgr.reads.length;
    await vi.advanceTimersByTimeAsync(2_000);
    const later = mgr.reads.slice(before);
    expect(later.length).toBeGreaterThanOrEqual(1);
    expect(new Set(later)).toEqual(new Set(['do_bad']));
  });

  it('a failed group edit leaves the signals on the poll path', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.updateSubscriptionGroup = async () => { throw new RwsError('body too large', 'PROTOCOL_ERROR' as never); };
    mgr.values = { do_a: '1' };
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_500);
    const s = f.get(ID)!.io.signals[0];
    expect(s).toMatchObject({ value: '1', via: 'poll' });
    expect(mgr.reads.length).toBeGreaterThanOrEqual(2);   // still polling
  });
});

describe('poll reads racing subscription events', () => {
  /** Hold every read until the returned function is called. */
  function holdReads(mgr: ReturnType<typeof fakeManager>): () => void {
    let open!: () => void;
    mgr.readGate = new Promise(res => { open = res; });
    return () => { mgr.readGate = null; open(); };
  }

  it('a read overtaken by a value event does not write the older value back', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '0', do_b: '0' };
    const f = await boundPair(mgr);
    mgr.fire('/rw/iosystem/signals/do_a;state', '');   // a change without a value: one confirming read
    const release = holdReads(mgr);
    await vi.advanceTimersByTimeAsync(600);
    expect(mgr.reads.at(-1)).toBe('do_a');              // the confirming read is out, taken at '0'
    mgr.values.do_a = '1';
    mgr.fire('/rw/iosystem/signals/do_a;state', '1');   // the group pushes the newer value meanwhile
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.get(ID)!.io.signals[0]).toMatchObject({ value: '1', via: 'subscription' });
  });

  it('a change announced without a value during a read gets a read of its own', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '0', do_b: '0' };
    const f = await boundPair(mgr);
    mgr.fire('/rw/iosystem/signals/do_a;state', '');
    const release = holdReads(mgr);
    await vi.advanceTimersByTimeAsync(600);
    expect(mgr.reads.at(-1)).toBe('do_a');              // out, taken at '0'
    const before = mgr.reads.length;
    mgr.values.do_a = '1';
    mgr.fire('/rw/iosystem/signals/do_a;state', '');    // changed again, still without a value
    release();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mgr.reads.length).toBe(before + 1);          // one more read, begun after the change
    const s = f.get(ID)!.io.signals[0];
    expect(s).toMatchObject({ value: '1', via: 'subscription' });
    expect(s.asOf).not.toBeNull();
  });

  it('a read that started before the bind is not taken as its confirming read', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '0' };
    let openEdit!: () => void;
    mgr.editGate = new Promise(res => { openEdit = res; });
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);   // polled while the add is out
    const release = holdReads(mgr);
    await vi.advanceTimersByTimeAsync(600);
    const before = mgr.reads.length;            // a read is out, taken at '0'
    mgr.values.do_a = '1';                      // changes before the group delivers anything
    openEdit();
    mgr.editGate = null;
    await vi.advanceTimersByTimeAsync(0);       // the bind lands
    release();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mgr.reads.length).toBe(before + 1);
    expect(f.get(ID)!.io.signals[0]).toMatchObject({ value: '1', via: 'subscription' });
  });
});

describe('events and removals after the watch ends', () => {
  it('a lapsed lease ignores the events a failed removal still delivers, and the removal is retried', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '0' };
    mgr.failDrops = 1;
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS - 500);   // lapses; the removal fails
    expect(mgr.dropAttempts).toBe(1);
    expect(mgr.dropped).toEqual([]);
    const frozen = f.get(ID)!.io;
    expect(frozen).toMatchObject({ watching: false, signals: [{ value: '0' }] });
    mgr.fire('/rw/iosystem/signals/do_a;state', '1');   // the resource is still in the group
    mgr.fire('/rw/iosystem/signals/do_a;state', '');
    expect(f.get(ID)!.io).toEqual(frozen);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.dropAttempts).toBe(2);
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_a' }]);
  });

  it('a removal that keeps failing is tried a bounded number of times', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.failDrops = 1_000;
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS + 60_000);
    expect(mgr.dropAttempts).toBe(IO_DROP_TRIES);
  });

  it('a signal watched again before its removal is retried is not removed', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.failDrops = 1;
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_b']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(500);
    f.watchIo(ID, ['do_a']);
    await vi.advanceTimersByTimeAsync(600);   // do_b's removal fails; the retry is due a second later
    expect(mgr.dropAttempts).toBe(1);
    f.watchIo(ID, ['do_a', 'do_b']);          // and do_b is wanted again
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mgr.dropAttempts).toBe(1);
    expect(mgr.dropped).toEqual([]);
    expect(mgr.added.flat().filter(r => r.name === 'do_b')).toHaveLength(2);   // bound anew
  });

  it('a lease that lapses while the link is stale releases its resources once the link heals on the same group', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '0', do_b: '0' };
    const f = await boundPair(mgr);
    const state = mgr.state as { quality: string };
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS - 2_500);   // just before the lapse
    state.quality = 'stale';                                 // one failed poll: same group, same stream
    await vi.advanceTimersByTimeAsync(1_000);                // the lease lapses meanwhile
    expect(f.get(ID)!.io.watching).toBe(false);
    expect(mgr.dropAttempts).toBe(0);                        // nothing goes out on a stale link
    state.quality = 'live';                                  // the next poll heals it
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mgr.dropAttempts).toBe(2);
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_a' }, { type: 'signal', name: 'do_b' }]);
    f.watchIo(ID, ['do_a']);                                 // a later watch binds do_a anew, after its removal
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.added.flat().filter(r => r.name === 'do_a')).toHaveLength(2);
  });

  it('a signal taken out of the watch while the link is stale leaves the group once it heals', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '0', do_b: '0' };
    const f = await boundPair(mgr);
    const state = mgr.state as { quality: string };
    state.quality = 'stale';
    f.watchIo(ID, ['do_a']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.dropAttempts).toBe(0);
    state.quality = 'live';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_b' }]);
  });

  it('an add that lands while the link is stale counts for its group, so a lapse before the heal still releases it', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    const state = mgr.state as { quality: string };
    let open!: () => void;
    mgr.editGate = new Promise(res => { open = res; });
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(200);            // the add is out
    state.quality = 'stale';
    open();
    mgr.editGate = null;
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS);   // it lands; the lease lapses before the link heals
    state.quality = 'live';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mgr.added.flat().map(r => r.name)).toEqual(['do_a']);
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_a' }]);
  });

  it('a removal that fails as the link turns stale is retried once the link heals', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    const state = mgr.state as { quality: string };
    const drop = mgr.unsubscribeResource;
    // The controller is briefly failing: the removal fails, and so does the manager's next poll.
    mgr.unsubscribeResource = async (g, res) => {
      try { return await drop(g, res); } catch (e) { state.quality = 'stale'; throw e; }
    };
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);
    mgr.failDrops = 1;
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS);   // lapses; the removal fails
    expect(mgr.dropAttempts).toBe(1);
    expect(mgr.dropped).toEqual([]);
    state.quality = 'live';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mgr.dropAttempts).toBe(2);
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_a' }]);
  });

  it('ignores events while the link is on the wrong controller', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '0', do_b: '0' };
    const f = await boundPair(mgr);
    const info = (mgr.state as unknown as { systemInfo: { sysid: string } }).systemInfo;
    info.sysid = '{DDDEA751-93CE-4DAC-8D85-55725137AF66}';
    mgr.fire('/rw/iosystem/signals/do_a;state', '1');
    info.sysid = RW7_ID;
    expect(f.get(ID)!.io.signals[0].value).toBe('0');
  });
});

describe('the request budget - reads and group edits together', () => {
  it('a lapsed watch of 24 signals releases them one at a time, spaced by the budget', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.editMs = 60;
    const f = fleetWith(mgr);
    f.watchIo(ID, Array.from({ length: 24 }, (_, i) => `do_${i}`));
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mgr.added.flat()).toHaveLength(24);
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS);
    expect(mgr.dropped).toHaveLength(24);
    expect(mgr.maxEditsOut).toBe(1);
    // 8 req/s on a quiet live link: 23 gaps of 125 ms on average, never a burst.
    expect(mgr.droppedAt[23] - mgr.droppedAt[0]).toBeGreaterThanOrEqual(23 * 125 - 100);
  });

  it('group edits are paid out of the same budget as reads', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    const f = fleetWith(mgr);
    f.watchIo(ID, Array.from({ length: 24 }, (_, i) => `do_${i}`));
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.added).toHaveLength(4);                               // every add went out...
    expect(mgr.added.length + mgr.reads.length).toBeLessThanOrEqual(17);   // ...inside 8 req/s with the reads
  });

  it('a slow group edit does not hold up the polling', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.editMs = 3_000;
    mgr.values = { do_a: '1' };
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.editsOut).toBe(1);                         // the add is still out
    expect(mgr.reads.length).toBeGreaterThanOrEqual(3);   // and the signal is read meanwhile
    expect(f.get(ID)!.io.signals[0]).toMatchObject({ value: '1', via: 'poll' });
  });

  it('a live motion watch reserves every unit it samples: two robots leave the I/O poller one read a second', async () => {
    const mgr = fakeManager();   // RWS 1.0: every watched signal is polled
    (mgr.state as unknown as { mechunits: string[] }).mechunits = ['ROB_1', 'ROB_2'];
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.watchIo(ID, ['do_a', 'do_b', 'do_c', 'do_d']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mgr.reads.length).toBeGreaterThanOrEqual(4);
    expect(mgr.reads.length).toBeLessThanOrEqual(6);
  });

  it('reserves the pointer reads of every running task', async () => {
    const mgr = fakeManager();
    const state = mgr.state as unknown as { execstate: string; tasks: Array<{ name: string; active: boolean; excstate: string }> };
    state.execstate = 'running';
    state.tasks = Array.from({ length: 5 }, (_, i) => ({ name: `T_ROB${i + 1}`, active: true, excstate: 'running' }));
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_b', 'do_c', 'do_d']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(5_000);
    // 14 - 2 (the manager's own polls) - 5 x 2 (pointers) = 2 reads a second.
    expect(mgr.reads.length).toBeGreaterThanOrEqual(8);
    expect(mgr.reads.length).toBeLessThanOrEqual(11);
  });
});

describe('consumer leases - each consumer`s set is its own, the daemon watches the union', () => {
  const names = (n: number, prefix = 'do_') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const watched = (f: ControllerFleet) => f.get(ID)!.io.signals.map(s => s.name);
  const grant = (w: ReturnType<ControllerFleet['watchIo']>): IoWatch => {
    if (!w || w === 'lease-limit') { throw new Error(`no grant: ${String(w)}`); }
    return w;
  };

  it('"new" opens a lease of the caller`s own, under an id of its own, which renewals keep', () => {
    const f = fleetWith(fakeManager());
    const a = grant(f.watchIo(ID, ['do_a'], NEW_LEASE));
    const b = grant(f.watchIo(ID, ['do_b'], NEW_LEASE));
    expect(a.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.leaseId).not.toBe(a.leaseId);
    expect(grant(f.watchIo(ID, ['do_a'], a.leaseId))).toEqual({ leaseMs: IO_LEASE_MS, accepted: ['do_a'], rejected: [], leaseId: a.leaseId });
    expect(watched(f)).toEqual(['do_a', 'do_b']);
  });

  it('two consumers: one changing its set never takes a signal the other holds', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '1', do_b: '1', do_c: '1' };
    const f = fleetWith(mgr);
    const a = grant(f.watchIo(ID, ['do_a', 'do_b'], NEW_LEASE));
    const b = grant(f.watchIo(ID, ['do_b', 'do_c'], NEW_LEASE));
    expect(b.accepted).toEqual(['do_b', 'do_c']);
    expect(watched(f)).toEqual(['do_a', 'do_b', 'do_c']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.added.flat().map(r => r.name).sort()).toEqual(['do_a', 'do_b', 'do_c']);   // each signal bound once
    const before = f.get(ID)!.io.signals.find(s => s.name === 'do_b')!;
    expect(before).toMatchObject({ value: '1', via: 'subscription' });
    expect(before.asOf).not.toBeNull();
    // A lets go of do_b; B still holds it, so it stays watched, bound and valued.
    f.watchIo(ID, ['do_a'], a.leaseId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watched(f)).toEqual(['do_a', 'do_b', 'do_c']);
    expect(f.get(ID)!.io.signals.find(s => s.name === 'do_b')).toEqual(before);
    expect(mgr.dropped).toEqual([]);
    // A lets go of do_a too: nobody else holds it, so it leaves the watch and the group.
    f.watchIo(ID, [], a.leaseId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watched(f)).toEqual(['do_b', 'do_c']);
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_a' }]);
    expect(f.get(ID)!.io.watching).toBe(true);
  });

  it('a lapsed consumer lease takes out only its own signals, with no request needed; the others stay current', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    mgr.values = { do_a: '1', do_b: '1', do_c: '1' };
    const f = fleetWith(mgr);
    grant(f.watchIo(ID, ['do_a', 'do_b'], NEW_LEASE));            // A: runs out at 15 s
    const b = grant(f.watchIo(ID, ['do_b', 'do_c'], NEW_LEASE));
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS / 2);
    f.watchIo(ID, ['do_b', 'do_c'], b.leaseId);                   // B: runs until 22.5 s
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS / 2 - 500);
    expect(watched(f)).toEqual(['do_a', 'do_b', 'do_c']);          // t = 14.5 s: A still runs
    const changed: string[] = [];
    f.onChanged(id => changed.push(id));
    const reads = mgr.reads.length;
    await vi.advanceTimersByTimeAsync(1_500);                     // t = 16 s, and nobody asked for anything
    const g = f.get(ID)!.io;
    expect(g.watching).toBe(true);
    expect(g.signals.map(s => s.name)).toEqual(['do_b', 'do_c']);
    for (const s of g.signals) {
      expect(s).toMatchObject({ value: '1', via: 'subscription' });
      expect(s.asOf).not.toBeNull();
    }
    expect(mgr.reads.length).toBe(reads);   // B watched them all along: nothing to re-confirm
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_a' }]);
    expect(changed.length).toBeGreaterThan(0);   // the smaller set was announced
  });

  it('when the last lease runs out the watch lapses as a whole: the set stays, frozen', async () => {
    const mgr = fakeManager();
    mgr.values = { do_a: '1', do_b: '0' };
    const f = fleetWith(mgr);
    grant(f.watchIo(ID, ['do_a'], NEW_LEASE));
    grant(f.watchIo(ID, ['do_b'], NEW_LEASE));
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS + 1_000);
    const g = f.get(ID)!.io;
    expect(g.watching).toBe(false);
    expect(g.signals.map(s => [s.name, s.value])).toEqual([['do_a', '1'], ['do_b', '0']]);
    const reads = mgr.reads.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.reads.length).toBe(reads);
  });

  it('caps each consumer`s lease, and the union at the controller`s cap, with the reason by name', () => {
    const f = fleetWith(fakeManager());
    const a = grant(f.watchIo(ID, names(IO_WATCH_LEASE_MAX + 4), NEW_LEASE));
    expect(a.accepted).toEqual(names(IO_WATCH_LEASE_MAX));
    expect(a.rejected).toEqual(names(IO_WATCH_LEASE_MAX + 4).slice(IO_WATCH_LEASE_MAX).map(name => ({ name, reason: IO_CAP_REASON.lease })));
    // B shares four of A's signals - those cost the controller nothing - and asks for twelve new ones.
    const room = IO_WATCH_MAX - IO_WATCH_LEASE_MAX;
    const b = grant(f.watchIo(ID, [...names(4), ...names(12, 'di_')], NEW_LEASE));
    expect(b.accepted).toEqual([...names(4), ...names(room, 'di_')]);
    expect(b.rejected).toEqual(names(12, 'di_').slice(room).map(name => ({ name, reason: IO_CAP_REASON.controller })));
    expect(watched(f)).toHaveLength(IO_WATCH_MAX);
    // With the controller full, a third consumer still gets what the others watch, and nothing else.
    const c = grant(f.watchIo(ID, ['do_5', 'di_0', 'di_99'], NEW_LEASE));
    expect(c.accepted).toEqual(['do_5', 'di_0']);
    expect(c.rejected).toEqual([{ name: 'di_99', reason: IO_CAP_REASON.controller }]);
    // A renewing its same list is never refused for B's signals.
    expect(grant(f.watchIo(ID, names(IO_WATCH_LEASE_MAX), a.leaseId)).rejected).toEqual([]);
  });

  it('without a lease id: the one shared anonymous set, replaced by every such request, beside the consumers` own', async () => {
    const mgr = fakeManager({ groupPath: '/subscription/7' });
    const f = fleetWith(mgr);
    const first = grant(f.watchIo(ID, ['do_a', 'do_b']));
    expect(first).toEqual({ leaseMs: IO_LEASE_MS, accepted: ['do_a', 'do_b'], rejected: [] });
    expect('leaseId' in first).toBe(false);
    const x = grant(f.watchIo(ID, ['do_x', 'do_b'], NEW_LEASE));
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(1_000);
    // Another consumer without an id replaces the anonymous set, as before leases had ids ...
    f.watchIo(ID, ['do_c']);
    expect(watched(f)).toEqual(['do_c', 'do_x', 'do_b']);
    await vi.advanceTimersByTimeAsync(1_000);
    // ... and do_b, which the lease holds, stays in the group; only do_a leaves.
    expect(mgr.dropped).toEqual([{ type: 'signal', name: 'do_a' }]);
    // The anonymous set has no cap of its own: only the controller's, counting the lease's signals.
    const big = grant(f.watchIo(ID, names(IO_WATCH_MAX)));
    expect(big.accepted).toHaveLength(IO_WATCH_MAX - 2);
    expect(big.rejected.map(r => r.reason)).toEqual([IO_CAP_REASON.controller, IO_CAP_REASON.controller]);
    // The consumer's lease is untouched by all of it.
    expect(grant(f.watchIo(ID, ['do_x', 'do_b'], x.leaseId)).accepted).toEqual(['do_x', 'do_b']);
  });

  it('an id the daemon no longer holds opens that lease again, under the same id', async () => {
    const mgr = fakeManager();
    mgr.values = { do_a: '1' };
    const f = fleetWith(mgr);
    const a = grant(f.watchIo(ID, ['do_a'], NEW_LEASE));
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(IO_LEASE_MS + 1_000);
    expect(f.get(ID)!.io.watching).toBe(false);
    const again = grant(f.watchIo(ID, ['do_a'], a.leaseId));
    expect(again.leaseId).toBe(a.leaseId);
    expect(f.get(ID)!.io.signals[0]).toMatchObject({ value: '1', asOf: null });   // kept, but not current
    // An id from before a daemon restart works the same way.
    const before = 'b41f7a3c-0d2e-4c5b-9a61-7e3f2d1c0b9a';
    expect(grant(f.watchIo(ID, ['do_b'], before)).leaseId).toBe(before);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.get(ID)!.io.signals.map(s => [s.name, s.value])).toEqual([['do_a', '1'], ['do_b', '0']]);
  });

  it('holds at most WATCH_LEASES_MAX leases with an id; renewals and the anonymous lease are never refused', () => {
    const f = fleetWith(fakeManager());
    const ids = Array.from({ length: WATCH_LEASES_MAX }, () => grant(f.watchIo(ID, ['do_a'], NEW_LEASE)).leaseId!);
    expect(new Set(ids).size).toBe(WATCH_LEASES_MAX);
    expect(f.watchIo(ID, ['do_a'], NEW_LEASE)).toBe('lease-limit');
    expect(f.watchIo(ID, ['do_a'], 'one-more')).toBe('lease-limit');
    expect(grant(f.watchIo(ID, ['do_b'], ids[0])).accepted).toEqual(['do_b']);
    expect(grant(f.watchIo(ID, ['do_c'])).accepted).toEqual(['do_c']);
    vi.advanceTimersByTime(IO_LEASE_MS);   // every lease runs out
    expect(grant(f.watchIo(ID, ['do_a'], NEW_LEASE)).leaseId).toBeDefined();
  });
});

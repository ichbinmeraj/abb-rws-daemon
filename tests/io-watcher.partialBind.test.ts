import { describe, it, expect, vi, afterEach } from 'vitest';
import { RwsError, type RobotState, type SubscriptionEvent, type SubscriptionResource } from 'abb-rws-client';
import { ControllerFleet } from '../src/fleet.js';
import type { ControllerConfig } from '../src/config.js';

// A group-add PUT that names one unknown signal among valid ones answers
// 400 -1073445866 "Invalid resource URI in Update Subscription request", and
// the controller binds the valid ones all the same: the 400's state div lists
// them, and GET /subscription/{g} shows them as members (RW 7.21, RW 8.1.1,
// RW 8.2.1). A client that reads that body says so on its error (`bound`,
// resource paths without the `;state` suffix); an older client throws a plain
// error with the status and the controller's code.

const RW7_ID = '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}';
const ID = 'irb1600-6-120-1';
const T0 = Date.parse('2026-09-27T12:00:00Z');
const GROUP = '/subscription/7';
const INVALID_URI = -1073445866;
const UPDATE_MSG = 'Invalid resource URI in Update Subscription request';
/** A group of another client, or a deleted one. */
const NOT_THIS_CLIENTS_GROUP = -1073435900;
const FOREIGN_MSG = 'Group 7 does not belong to Client 3.';

const cfg = (): ControllerConfig => ({
  id: ID, name: 'IRB1600_6_120_1', host: '127.0.0.1', port: 9403, useHttps: true,
  username: 'Default User', password: 'x', systemId: RW7_ID,
});

/** The path a group edit names for a signal, as the controller reports it bound. */
const signalPath = (name: string) => `/rw/iosystem/signals/${name}`;

/**
 * How the fake's client reports a 400 that bound part of an edit:
 *  - 'bound': the error carries the bound and refused resource paths and the body;
 *  - 'plain': an older client, status and controller code only;
 *  - 'other': not that refusal at all (a 500, no controller code);
 *  - 'foreign': a 400 with another controller code and no bound list (the
 *    group is not this client's), which binds nothing.
 */
type Report = 'bound' | 'plain' | 'other' | 'foreign';

/** A controller's manager, reduced to what the I/O watcher touches; the group behaves like RW 7.21/8.x. */
function fakeManager(report: Report) {
  const taps: Array<(e: SubscriptionEvent) => void> = [];
  const m = {
    report,
    /** Signals the controller does not have: an edit naming one answers 400 and binds the rest. */
    unknown: new Set<string>(['do_bad']),
    /** The group's members, as GET /subscription/{g} lists them (`;state` kept). */
    members: ['/rw/panel/ctrl-state;ctrlstate'] as string[],
    /** The names of every group add, in order, and when each was sent. */
    added: [] as string[][],
    addedAt: [] as number[],
    addedTo: [] as string[],
    /** Every member-list read: the group it named. */
    groupReads: [] as string[],
    /** Resources removed from the group. */
    dropped: [] as string[],
    reads: [] as string[],
    values: {} as Record<string, string>,
    /** While set, every group add waits for it. */
    editGate: null as Promise<void> | null,
    /** The member-list read throws this, when set. */
    failGroupRead: null as Error | null,
    currentPort: 9403 as number | undefined,
    currentUseHttps: true as boolean | undefined,
    subscriptionGroupPath: GROUP as string | undefined,
    state: {
      connected: true, quality: 'live', qualityReason: 'x', identity: null,
      systemInfo: { name: 'x', rwVersion: '7.21.4', sysid: RW7_ID, startTime: '', options: [] },
      ioSignals: [],
    } as unknown as RobotState,
    onSubscriptionEvent: (fn: (e: SubscriptionEvent) => void) => {
      taps.push(fn);
      return () => { const i = taps.indexOf(fn); if (i >= 0) { taps.splice(i, 1); } };
    },
    fire: (resource: string, value: string) => { for (const t of [...taps]) { t({ resource, value, timestamp: new Date() }); } },
    readIoSignal: async (_n: string, _d: string, name: string) => {
      m.reads.push(name);
      const value = m.values[name] ?? '0';
      return { name, value, lvalue: value, type: 'DO' as const };
    },
    updateSubscriptionGroup: async (group: string, resources: SubscriptionResource[]): Promise<string> => {
      const names = resources.map(r => (r as { name: string }).name);
      m.added.push(names);
      m.addedAt.push(Date.now());
      m.addedTo.push(group);
      if (m.editGate) { await m.editGate; }
      if (m.report === 'other' && names.some(n => m.unknown.has(n))) {
        throw new RwsError('HTTP 500 - subscription service busy', 'UNKNOWN', 500);
      }
      if (m.report === 'foreign' && names.some(n => m.unknown.has(n))) {
        throw new RwsError(`HTTP 400 - ${FOREIGN_MSG}`, 'INVALID_ARGUMENT', 400, undefined, NOT_THIS_CLIENTS_GROUP, FOREIGN_MSG);
      }
      const bound = names.filter(n => !m.unknown.has(n));
      for (const n of bound) {
        const member = `${signalPath(n)};state`;
        if (!m.members.includes(member)) { m.members.push(member); }
      }
      if (bound.length === names.length) { return ''; }
      const err = new RwsError(`HTTP 400 - ${UPDATE_MSG}`, 'RESOURCE_NOT_FOUND', 400, undefined, INVALID_URI, UPDATE_MSG);
      if (m.report === 'bound') {
        // The 400's state div lists the bound entries in no fixed order.
        Object.assign(err, {
          bound: [...bound].reverse().map(signalPath),
          refused: names.filter(n => m.unknown.has(n)).map(signalPath),
          body: bound.map(n => `<li class="ios-signalstate-ev" title="${n}"><span class="lvalue">0</span></li>`).join(''),
        });
      }
      throw err;
    },
    getSubscriptionGroup: async (group: string) => {
      m.groupReads.push(group);
      if (m.failGroupRead) { throw m.failGroupRead; }
      return m.members.map((resource, i) => ({ index: String(i + 1), resource }));
    },
    unsubscribeResource: async (_g: string, resource: SubscriptionResource) => {
      const name = (resource as { name: string }).name;
      m.dropped.push(name);
      m.members = m.members.filter(x => x !== `${signalPath(name)};state`);
    },
    /** How many adds named `name`. */
    editsNaming: (name: string) => m.added.filter(e => e.includes(name)).length,
  };
  return m;
}

let fleet: ControllerFleet | null = null;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fleetWith(manager: object): ControllerFleet {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  fleet = new ControllerFleet([cfg()], silent);
  (fleet as unknown as { managerOf: () => unknown }).managerOf = () => manager;
  return fleet;
}
afterEach(() => { fleet?.stopIoPoller(); fleet = null; vi.useRealTimers(); });

const GOOD = Array.from({ length: 11 }, (_, i) => `do_${i + 1}`);

describe('a group add answered 400 -1073445866 for one unknown name: the valid names are bound', () => {
  it.each(['bound', 'plain'] as const)(
    'the other names of its chunk count as added at once and are never re-sent; only the unknown one backs off (%s)',
    async report => {
      const mgr = fakeManager(report);
      const f = fleetWith(mgr);
      f.watchIo(ID, ['do_bad', ...GOOD]);
      f.startIoPoller();
      await vi.advanceTimersByTimeAsync(5_000);
      for (const edit of mgr.added) { expect(edit.length).toBeLessThanOrEqual(6); }
      // do_1..do_5 shared do_bad's chunk: that edit bound them, so none is sent again.
      for (const n of GOOD) { expect(mgr.editsNaming(n)).toBe(1); }
      // The unknown name alone is retried, by itself, on its backoff.
      const withBad = mgr.added.filter(e => e.includes('do_bad'));
      expect(withBad[0]).toEqual(['do_bad', 'do_1', 'do_2', 'do_3', 'do_4', 'do_5']);
      expect(withBad.length).toBeGreaterThanOrEqual(2);
      expect(withBad.slice(1).every(e => e.length === 1)).toBe(true);
      // Each bound name had its one confirming read and is served by the group.
      const signals = f.get(ID)!.io.signals;
      for (const n of GOOD) { expect(signals.find(s => s.name === n)).toMatchObject({ via: 'subscription', error: null }); }
      expect(signals.find(s => s.name === 'do_bad')).toMatchObject({ via: 'poll' });
      const before = mgr.reads.length;
      await vi.advanceTimersByTimeAsync(2_000);
      const later = mgr.reads.slice(before);
      expect(later.length).toBeGreaterThanOrEqual(1);
      expect(new Set(later)).toEqual(new Set(['do_bad']));
      if (report === 'plain') {
        // An older client says nothing of what was bound: the group's member list does.
        expect(mgr.groupReads.length).toBeGreaterThanOrEqual(1);
        expect(new Set(mgr.groupReads)).toEqual(new Set([GROUP]));
      } else {
        expect(mgr.groupReads).toEqual([]);   // the error already says
      }
    },
  );

  it.each(['bound', 'plain'] as const)(
    'each bound name gets one confirming read, begun after the edit landed, and shows the value read then (%s)',
    async report => {
      const mgr = fakeManager(report);
      mgr.values = { do_a: '0', do_b: '0', do_bad: '0' };
      let open!: () => void;
      mgr.editGate = new Promise(res => { open = res; });
      const f = fleetWith(mgr);
      f.watchIo(ID, ['do_a', 'do_bad', 'do_b']);
      f.startIoPoller();
      await vi.advanceTimersByTimeAsync(1_000);   // polled while the add is out
      expect(mgr.added).toEqual([['do_a', 'do_bad', 'do_b']]);
      mgr.values = { do_a: '1', do_b: '1', do_bad: '0' };   // changed before the group delivers anything
      const before = mgr.reads.length;
      open();
      mgr.editGate = null;
      await vi.advanceTimersByTimeAsync(3_000);
      const later = mgr.reads.slice(before);
      expect(later.filter(n => n === 'do_a')).toHaveLength(1);
      expect(later.filter(n => n === 'do_b')).toHaveLength(1);
      expect(mgr.editsNaming('do_a')).toBe(1);
      expect(mgr.editsNaming('do_b')).toBe(1);
      const signals = f.get(ID)!.io.signals;
      expect(signals.find(s => s.name === 'do_a')).toMatchObject({ value: '1', via: 'subscription' });
      expect(signals.find(s => s.name === 'do_b')).toMatchObject({ value: '1', via: 'subscription' });
      // Pushed changes now reach them without a read.
      mgr.fire('/rw/iosystem/signals/do_a;state', '0');
      expect(f.get(ID)!.io.signals.find(s => s.name === 'do_a')).toMatchObject({ value: '0', via: 'subscription' });
    },
  );

  it.each(['bound', 'plain'] as const)(
    'a bound name taken out of the watch while the refused edit was out leaves the group when it lands (%s)',
    async report => {
      const mgr = fakeManager(report);
      let open!: () => void;
      mgr.editGate = new Promise(res => { open = res; });
      const f = fleetWith(mgr);
      f.watchIo(ID, ['do_a', 'do_bad', 'do_b']);
      f.startIoPoller();
      await vi.advanceTimersByTimeAsync(200);
      expect(mgr.added).toEqual([['do_a', 'do_bad', 'do_b']]);
      f.watchIo(ID, ['do_a', 'do_bad']);
      open();
      mgr.editGate = null;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mgr.dropped).toEqual(['do_b']);
      expect(mgr.members).not.toContain('/rw/iosystem/signals/do_b;state');
      expect(mgr.members).toContain('/rw/iosystem/signals/do_a;state');
    },
  );

  it.each(['bound', 'plain'] as const)(
    'a lapsed lease releases the names a refused edit bound (%s)',
    async report => {
      const mgr = fakeManager(report);
      const f = fleetWith(mgr);
      f.watchIo(ID, ['do_a', 'do_bad', 'do_b']);
      f.startIoPoller();
      await vi.advanceTimersByTimeAsync(500);
      expect(mgr.editsNaming('do_a')).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(new Set(mgr.dropped)).toEqual(new Set(['do_a', 'do_b']));
      expect(mgr.members).toEqual(['/rw/panel/ctrl-state;ctrlstate']);
    },
  );

  it('matches bound resources by path, in any order, and a network/device name by its whole path', async () => {
    const mgr = fakeManager('bound');
    const f = fleetWith(mgr);
    f.watchIo(ID, ['Local/DRV_1/di_x', 'do_bad', 'do_y', 'Local/DRV_1/do_y']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mgr.added[0]).toEqual(['Local/DRV_1/di_x', 'do_bad', 'do_y', 'Local/DRV_1/do_y']);
    for (const n of ['Local/DRV_1/di_x', 'do_y', 'Local/DRV_1/do_y']) { expect(mgr.editsNaming(n)).toBe(1); }
    expect(f.get(ID)!.io.signals.filter(s => s.via === 'subscription').map(s => s.name))
      .toEqual(['Local/DRV_1/di_x', 'do_y', 'Local/DRV_1/do_y']);
  });

  it('a bound list that names none of the chunk binds nothing: every name backs off', async () => {
    const mgr = fakeManager('bound');
    mgr.unknown = new Set(['do_bad', 'do_a', 'do_b']);
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_bad', 'do_b']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(2_500);
    for (const n of ['do_a', 'do_bad', 'do_b']) { expect(mgr.editsNaming(n)).toBe(2); }
    expect(mgr.added.slice(1).every(e => e.length === 1)).toBe(true);
    expect(f.get(ID)!.io.signals.every(s => s.via === 'poll')).toBe(true);
  });

  it('a refused edit that lands after the group was re-created counts for neither group', async () => {
    const mgr = fakeManager('plain');
    let open!: () => void;
    mgr.editGate = new Promise(res => { open = res; });
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_bad']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(200);
    mgr.subscriptionGroupPath = '/subscription/8';
    await vi.advanceTimersByTimeAsync(200);
    open();
    let openNext!: () => void;
    mgr.editGate = new Promise(res => { openNext = res; });   // the add to the new group stays out
    await vi.advanceTimersByTimeAsync(500);
    expect(mgr.groupReads).toEqual([]);   // the old group's members say nothing of the new one
    expect(mgr.addedTo).toEqual([GROUP, '/subscription/8']);
    expect(mgr.added[1]).toEqual(['do_a', 'do_bad']);
    // Nothing counts as added until the new group's edit lands: do_a is still polled.
    const before = mgr.reads.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.reads.slice(before)).toContain('do_a');
    expect(f.get(ID)!.io.signals.every(s => s.via === 'poll')).toBe(true);
    openNext();
    mgr.editGate = null;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.groupReads).toEqual(['/subscription/8']);
    expect(mgr.editsNaming('do_a')).toBe(2);
  });
});

describe('an older client: a refused add that named one signal bound nothing', () => {
  it('each lone retry of the unknown name is refused without a read of the group', async () => {
    const mgr = fakeManager('plain');
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_bad']);
    f.startIoPoller();
    for (let i = 0; i < 4; i++) {   // renewed within the lease, backoff 1, 2, 4, 8 s
      await vi.advanceTimersByTimeAsync(5_000);
      f.watchIo(ID, ['do_a', 'do_bad']);
    }
    expect(mgr.added[0]).toEqual(['do_a', 'do_bad']);
    const lone = mgr.added.slice(1);
    expect(lone.length).toBeGreaterThanOrEqual(3);
    expect(lone.every(e => e.length === 1 && e[0] === 'do_bad')).toBe(true);
    // Only the first refusal, which named a valid signal too, reads the group.
    expect(mgr.groupReads).toEqual([GROUP]);
    const signals = f.get(ID)!.io.signals;
    expect(signals.find(s => s.name === 'do_a')).toMatchObject({ via: 'subscription' });
    expect(signals.find(s => s.name === 'do_bad')).toMatchObject({ via: 'poll' });
  });

  it('a watch of the unknown name alone never reads the group', async () => {
    const mgr = fakeManager('plain');
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_bad']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mgr.added.length).toBeGreaterThanOrEqual(3);
    expect(mgr.added.every(e => e.length === 1 && e[0] === 'do_bad')).toBe(true);
    expect(mgr.groupReads).toEqual([]);
  });
});

describe('a failed group add that does not say what it bound', () => {
  it('an older client whose manager cannot read the group: every name of the chunk backs off and is re-sent alone', async () => {
    const mgr = fakeManager('plain');
    const bare: Partial<typeof mgr> = mgr;
    delete bare.getSubscriptionGroup;
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_bad', 'do_b']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(2_500);
    for (const n of ['do_a', 'do_bad', 'do_b']) { expect(mgr.editsNaming(n)).toBe(2); }
    expect(mgr.added.slice(1).every(e => e.length === 1)).toBe(true);
    // Re-sent alone, the valid ones are already members: the controller answers 200, and they count as added.
    expect(f.get(ID)!.io.signals.filter(s => s.via === 'subscription').map(s => s.name)).toEqual(['do_a', 'do_b']);
  });

  it('an older client whose group read fails: every name of the chunk backs off', async () => {
    const mgr = fakeManager('plain');
    mgr.failGroupRead = new RwsError('HTTP 503 - busy', 'CONTROLLER_BUSY', 503);
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_bad', 'do_b']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(mgr.groupReads[0]).toBe(GROUP);
    for (const n of ['do_a', 'do_bad', 'do_b']) { expect(mgr.editsNaming(n)).toBe(2); }
  });

  it('a 400 with another controller code and no bound list reads no group and backs off every name of the chunk', async () => {
    const mgr = fakeManager('foreign');
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_bad', 'do_b']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(mgr.groupReads).toEqual([]);
    for (const n of ['do_a', 'do_bad', 'do_b']) { expect(mgr.editsNaming(n)).toBe(2); }
    expect(mgr.added.slice(1).every(e => e.length === 1)).toBe(true);
    expect(f.get(ID)!.io.signals.filter(s => s.via === 'subscription').map(s => s.name)).toEqual(['do_a', 'do_b']);
  });

  it('another failure reads no group and backs off every name of the chunk', async () => {
    const mgr = fakeManager('other');
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a', 'do_bad', 'do_b']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(mgr.groupReads).toEqual([]);
    for (const n of ['do_a', 'do_bad', 'do_b']) { expect(mgr.editsNaming(n)).toBe(2); }
    expect(mgr.added.slice(1).every(e => e.length === 1)).toBe(true);
  });
});

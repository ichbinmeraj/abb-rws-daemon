import { describe, it, expect } from 'vitest';
import { NO_GENERATION, NO_WRITE_ACCESS_READER } from '../src/access.js';
import { CAPABILITY_IDS, capabilitiesGroup, clientFacts, type ClientFacts } from '../src/capabilities.js';
import { NO_CLOCK_READER } from '../src/fleet.js';
import type {
  AccessGroup, AccessLockInfo, Capability, CapabilityId, ControllerSnapshot, EventsGroup, Generation, GroupError, IdentityGroup,
  LinkGroup, LinkQuality, MotionGroup, MotionUnitInfo, PanelGroup, RmmpInfo,
} from '../src/schema/v0.js';

const AT = '2026-10-05T08:00:00.000Z';
const RW7_ID = '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}';
const ERR: GroupError = { code: 'CONTROLLER_BUSY', message: 'HTTP 503 - busy' };

type Groups = Pick<ControllerSnapshot, 'identity' | 'link' | 'panel' | 'motion' | 'events' | 'access'>;

const link = (quality: LinkQuality = 'live', over: Partial<LinkGroup> = {}): LinkGroup => {
  const healthy = quality === 'live' || quality === 'polling';
  return {
    connected: quality !== 'disconnected' && quality !== 'reconnecting', quality,
    qualityReason: quality === 'live' ? 'WebSocket events streaming' : quality === 'polling' ? 'event stream lost; polling' : `link is ${quality}`,
    since: AT, downSince: healthy ? null : AT, host: '127.0.0.1', port: 9403, useHttps: true,
    subscriptions: { active: quality === 'live' }, identityCheck: { status: 'confirmed', expected: RW7_ID, actual: RW7_ID }, reconnect: null,
    ...over,
  };
};

const identity = (raw: string | null = '7.21.4+417'): IdentityGroup => {
  const m = raw?.match(/^(\d+)\.(\d+)/);
  return {
    controllerName: 'c', controllerId: null, controllerType: 'Virtual Controller', virtual: true, mac: null, systemName: 's', sysId: RW7_ID,
    startTime: null, robotWare: { raw, major: m ? Number(m[1]) : null, minor: m ? Number(m[2]) : null, generation: 'rws2' }, options: [],
    asOf: AT,
  };
};

const panel: PanelGroup = { ctrlState: 'motoron', opMode: 'AUTO', speedRatio: 100, collisionDetection: null, asOf: AT };

const unit = (name: string, joints: MotionUnitInfo['joints']): MotionUnitInfo =>
  ({ name, kind: 'robot', typeRaw: 'TCPRobot', task: 'T_ROB1', joints, pose: null, error: null });
const fullJoint = { name: 'J1', value: 10, unit: 'deg' as const, min: -170, max: 170 };
const motion = (units: MotionUnitInfo[] = [unit('ROB_1', [fullJoint])]): MotionGroup =>
  ({ watching: units.length > 0, units, rate: { targetHz: null, achievedHz: null, via: null }, asOf: units.length > 0 ? AT : null });

const events = (over: Partial<EventsGroup> = {}): EventsGroup => ({
  feed: 'f', lastSeq: 0, recent: [], via: 'subscription', clock: { offsetMs: -7_200_000, measuredAt: AT, problem: null }, asOf: AT, error: null,
  ...over,
});

const lock = (name: AccessLockInfo['lock'], over: Partial<AccessLockInfo> = {}): AccessLockInfo =>
  ({ lock: name, held: false, holder: null, heldByDaemon: false, reported: name === 'writeaccess' ? null : 'nomaster', asOf: AT, error: null, ...over });
const rmmpRead: RmmpInfo = { supported: true, privilege: 'none', asOf: AT, error: null };
const rmmpNone: RmmpInfo = { supported: false, privilege: null, asOf: null, error: null };
const rmmpUnread: RmmpInfo = { supported: null, privilege: null, asOf: null, error: null };

const rw7 = (over: Partial<AccessGroup> = {}): AccessGroup => ({
  generation: 'rw7', model: 'mastership', locks: [lock('edit'), lock('motion')], remoteAccessEnabled: null, rmmp: rmmpRead,
  via: 'poll', problem: null, asOf: AT, ...over,
});
const rw6 = (over: Partial<AccessGroup> = {}): AccessGroup =>
  rw7({ generation: 'rw6', locks: [lock('cfg'), lock('motion'), lock('rapid')], ...over });
const rw8 = (over: Partial<AccessGroup> = {}): AccessGroup => ({
  generation: 'rw8', model: 'writeaccess', locks: [lock('writeaccess')], remoteAccessEnabled: true, rmmp: rmmpNone,
  via: 'poll', problem: null, asOf: AT, ...over,
});

const FACTS: ClientFacts = { clock: true, ioEvents: true, writeAccessStatus: true, subscriptionGroup: true, ioTableLoaded: true, ioTableRows: 40 };

const groups = (over: Partial<Groups> = {}): Groups =>
  ({ identity: identity(), link: link(), panel, motion: motion(), events: events(), access: rw7(), ...over });

/** The table as `id -> [state, reason]`. */
function table(over: Partial<Groups> = {}, protocol: Generation | null = 'rws2', facts: ClientFacts | null = FACTS) {
  const g = capabilitiesGroup(groups(over), protocol, facts);
  return Object.fromEntries(g.entries.map(e => [e.id, [e.state, e.reason]])) as Record<CapabilityId, [Capability['state'], string | null]>;
}

describe('the capability table: shape', () => {
  it('one row per capability id, in wire order; a reason exactly when the state is not `available`', () => {
    const g = capabilitiesGroup(groups(), 'rws2', FACTS);
    expect(g.entries.map(e => e.id)).toEqual(['status-push', 'events-push', 'event-times', 'io-push', 'io-table', 'joint-limits',
      'mastership', 'write-access', 'rmmp']);
    expect(g.entries.map(e => e.id)).toEqual([...CAPABILITY_IDS]);
    for (const variant of [groups(), groups({ link: link('polling') }), groups({ link: link('stale') }), groups({ access: rw8() })]) {
      for (const e of capabilitiesGroup(variant, 'rws2', FACTS).entries) {
        if (e.state === 'available') { expect(e.reason, e.id).toBeNull(); } else { expect(e.reason, e.id).toEqual(expect.any(String)); }
      }
    }
  });

  it('the head: protocol, generation, the version as reported, tested, and panel\'s asOf', () => {
    expect(capabilitiesGroup(groups(), 'rws2', FACTS)).toMatchObject({
      protocol: 'rws2', generation: 'rw7', robotWare: '7.21.4+417', tested: true, asOf: AT,
    });
    expect(capabilitiesGroup(groups({ access: rw6(), identity: identity('6.16.3007') }), 'rws1', FACTS)).toMatchObject({
      protocol: 'rws1', generation: 'rw6', robotWare: '6.16.3007', tested: true,
    });
  });

  it('tested: true for a tested major.minor, false for another, null while the version is not known', () => {
    const tested = (raw: string | null) => capabilitiesGroup(groups({ identity: identity(raw) }), 'rws2', FACTS).tested;
    expect(['6.16.3007', '7.21.0', '8.1.1+614', '8.2.1+1023'].map(tested)).toEqual([true, true, true, true]);
    expect(['7.18.0', '6.15.08', '9.0.0'].map(tested)).toEqual([false, false, false]);
    expect(tested(null)).toBeNull();
    expect(tested('garbage')).toBeNull();
    expect(capabilitiesGroup(groups({ identity: null }), 'rws2', FACTS)).toMatchObject({ robotWare: null, tested: null });
  });

  it('a link on the wrong controller has no table: no row, nothing else', () => {
    const wrong = link('live', { identityCheck: { status: 'mismatch', expected: RW7_ID, actual: '{OTHER}' } });
    expect(capabilitiesGroup(groups({ link: wrong }), 'rws2', FACTS)).toEqual({
      protocol: null, generation: null, robotWare: null, tested: null, entries: [], asOf: null,
    });
  });
});

describe('a link that is not healthy has no table to speak of', () => {
  it.each(['stale', 'reconnecting', 'disconnected'] as const)('%s: every row unknown with the link\'s reason, even with good values kept in the groups', quality => {
    // Everything a healthy link would call `available` is still in the groups: a lock read before the outage, a measured clock, joints with limits.
    const kept = groups({ link: link(quality), access: rw7({ via: null }) });
    const g = capabilitiesGroup(kept, quality === 'stale' ? 'rws2' : null, FACTS);
    expect(g.entries).toEqual(CAPABILITY_IDS.map(id => ({ id, state: 'unknown', reason: kept.link.qualityReason })));
    expect(g.generation).toBe('rw7');
    expect(g.robotWare).toBe('7.21.4+417');
  });

  it('a link that says `live` but is not connected is not healthy either', () => {
    const g = capabilitiesGroup(groups({ link: link('live', { connected: false, qualityReason: 'logging out' }) }), 'rws2', FACTS);
    expect(new Set(g.entries.map(e => e.state))).toEqual(new Set(['unknown']));
    expect(g.entries[0].reason).toBe('logging out');
  });

  it('the protocol is null while not connected, whatever the client still remembers of the link', () => {
    expect(capabilitiesGroup(groups({ link: link('disconnected') }), 'rws2', FACTS).protocol).toBeNull();
    expect(capabilitiesGroup(groups({ link: link('reconnecting') }), 'rws1', FACTS).protocol).toBeNull();
    expect(capabilitiesGroup(groups({ link: link('stale') }), 'rws2', FACTS).protocol).toBe('rws2');
  });

  it('a controller never reached: every row unknown, "not connected"', () => {
    const never = groups({
      identity: null, link: link('disconnected', { qualityReason: 'not connected' }), motion: motion([]),
      events: events({ via: null, asOf: null, clock: { offsetMs: null, measuredAt: null, problem: null } }),
      access: { generation: null, model: null, locks: [], remoteAccessEnabled: null, rmmp: rmmpUnread, via: null, problem: null, asOf: null },
      panel: { ...panel, asOf: null },
    });
    expect(capabilitiesGroup(never, null, null)).toEqual({
      protocol: null, generation: null, robotWare: null, tested: null,
      entries: CAPABILITY_IDS.map(id => ({ id, state: 'unknown', reason: 'not connected' })), asOf: null,
    });
  });
});

describe('status-push, events-push, io-push: `polling` is degraded, not unavailable', () => {
  it('live: all three available', () => {
    const t = table();
    expect(t['status-push']).toEqual(['available', null]);
    expect(t['events-push']).toEqual(['available', null]);
    expect(t['io-push']).toEqual(['available', null]);
  });

  it('polling: all three degraded, with the link\'s reason', () => {
    const t = table({ link: link('polling'), events: events({ via: 'poll' }) });
    expect(t['status-push']).toEqual(['degraded', 'event stream lost; polling']);
    expect(t['events-push']).toEqual(['degraded', 'event stream lost; polling']);
    expect(t['io-push']).toEqual(['degraded', 'event stream lost; polling']);
  });

  it('events-push: a link without a reason still says why; a failed read is degraded with its message; not confirmed is unknown', () => {
    expect(table({ link: link('polling', { qualityReason: '' }), events: events({ via: 'poll' }) })['events-push'])
      .toEqual(['degraded', 'no event subscription delivers; the log is read every few seconds']);
    expect(table({ events: events({ error: ERR }) })['events-push']).toEqual(['degraded', 'HTTP 503 - busy']);
    expect(table({ events: events({ via: null }) })['events-push'])
      .toEqual(['unknown', 'the controller is not yet confirmed to be the one that was added']);
  });
});

describe('event-times', () => {
  it('available with a measured offset and no problem; unknown until measured', () => {
    expect(table()['event-times']).toEqual(['available', null]);
    expect(table({ events: events({ clock: { offsetMs: null, measuredAt: null, problem: null } }) })['event-times'])
      .toEqual(['unknown', 'the controller clock is not measured yet']);
  });

  it('a client without the clock read: unavailable; any other problem: degraded', () => {
    expect(table({ events: events({ clock: { offsetMs: null, measuredAt: null, problem: NO_CLOCK_READER } }) })['event-times'])
      .toEqual(['unavailable', NO_CLOCK_READER]);
    expect(table({}, 'rws2', { ...FACTS, clock: false })['event-times']).toEqual(['unavailable', NO_CLOCK_READER]);
    const problem = 'the controller clock could not be read: HTTP 503 - busy';
    expect(table({ events: events({ clock: { offsetMs: -7_200_000, measuredAt: AT, problem } }) })['event-times']).toEqual(['degraded', problem]);
    expect(table({ events: events({ clock: { offsetMs: null, measuredAt: null, problem } }) })['event-times']).toEqual(['degraded', problem]);
  });
});

describe('io-push and io-table: RWS 1.0 against RWS 2.0, and what the client offers', () => {
  it('RWS 1.0: signals are polled, whatever else holds', () => {
    expect(table({ access: rw6() }, 'rws1', { ...FACTS, subscriptionGroup: false })['io-push'])
      .toEqual(['unavailable', 'watched signals are read by polling on RWS 1.0']);
  });

  it('RWS 2.0 with a client that cannot deliver signal changes: unavailable', () => {
    expect(table({}, 'rws2', { ...FACTS, ioEvents: false })['io-push']).toEqual(['unavailable', 'this abb-rws-client cannot deliver signal changes']);
  });

  it('RWS 2.0 with the tap but no subscription group: degraded', () => {
    expect(table({}, 'rws2', { ...FACTS, subscriptionGroup: false })['io-push']).toEqual(['degraded', 'WebSocket events streaming']);
  });

  it('io-table: available when loaded and complete; degraded when it may be cut; unknown until loaded', () => {
    expect(table()['io-table']).toEqual(['available', null]);
    expect(table({}, 'rws2', { ...FACTS, ioTableRows: 5_000 })['io-table']).toEqual(['available', null]);
    expect(table({ access: rw6() }, 'rws1', { ...FACTS, ioTableRows: 99 })['io-table']).toEqual(['available', null]);
    expect(table({ access: rw6() }, 'rws1', { ...FACTS, ioTableRows: 100 })['io-table'])
      .toEqual(['degraded', 'the table may list only the first 100 signals; search by name finds the rest']);
    expect(table({}, 'rws2', { ...FACTS, ioTableLoaded: false, ioTableRows: 0 })['io-table']).toEqual(['unknown', 'the signal table is not loaded yet']);
  });

  it('client facts missing altogether: nothing the client would have to offer counts as offered', () => {
    const t = table({}, 'rws2', null);
    expect(t['io-push'][0]).toBe('unavailable');
    expect(t['io-table'][0]).toBe('unknown');
    expect(t['event-times']).toEqual(['available', null]);   // the measured offset speaks for itself
    expect(t['status-push']).toEqual(['available', null]);
  });
});

describe('joint-limits', () => {
  it('available when every reported joint has a unit and both limits', () => {
    expect(table()['joint-limits']).toEqual(['available', null]);
  });

  it('degraded, naming the unit, when a joint lacks a unit or a limit', () => {
    const reason = (name: string) => `the axis configuration of ${name} was not read, or the controller gives none for an axis`;
    const bare = { name: 'J1', value: 10, unit: null, min: null, max: null };
    expect(table({ motion: motion([unit('ROB_1', [fullJoint]), unit('STN_1', [bare])]) })['joint-limits']).toEqual(['degraded', reason('STN_1')]);
    expect(table({ motion: motion([unit('ROB_1', [{ ...fullJoint, max: null }])]) })['joint-limits']).toEqual(['degraded', reason('ROB_1')]);
    expect(table({ motion: motion([unit('ROB_1', [{ ...fullJoint, min: null }])]) })['joint-limits']).toEqual(['degraded', reason('ROB_1')]);
  });

  it('degraded with the unit\'s own error when its joints were not read at all; a limits reason is never given for that', () => {
    // A failed joint read leaves `joints` empty and sets the unit's error: that error is the reason.
    expect(table({ motion: motion([{ ...unit('ROB_1', []), error: ERR }]) })['joint-limits']).toEqual(['degraded', ERR.message]);
    // No joints and no error: the first read has not landed; still not a limits gap.
    expect(table({ motion: motion([unit('ROB_1', [])]) })['joint-limits']).toEqual(['degraded', 'no joint of ROB_1 was read yet']);
    // A unit that is behind another one with full joints is still found.
    expect(table({ motion: motion([unit('ROB_1', [fullJoint]), { ...unit('STN_1', []), error: ERR }]) })['joint-limits']).toEqual(['degraded', ERR.message]);
  });

  it('unknown while no unit was sampled', () => {
    expect(table({ motion: motion([]) })['joint-limits'])
      .toEqual(['unknown', 'no mechanical unit was sampled yet; joints are read while a consumer watches motion']);
  });
});

describe('mastership, write-access, rmmp', () => {
  it('RobotWare 7, everything read: mastership and rmmp available, write-access unavailable', () => {
    const t = table();
    expect(t.mastership).toEqual(['available', null]);
    expect(t.rmmp).toEqual(['available', null]);
    expect(t['write-access']).toEqual(['unavailable', 'RobotWare 6 and 7 use mastership']);
  });

  it('RobotWare 6 the same, over three locks', () => {
    const t = table({ access: rw6() }, 'rws1');
    expect(t.mastership).toEqual(['available', null]);
    expect(t['write-access']).toEqual(['unavailable', 'RobotWare 6 and 7 use mastership']);
  });

  it('RobotWare 8 with the read: write-access available; mastership and rmmp unavailable', () => {
    const t = table({ access: rw8() });
    expect(t['write-access']).toEqual(['available', null]);
    expect(t.mastership).toEqual(['unavailable', 'RobotWare 8 has no mastership; see write-access']);
    expect(t.rmmp).toEqual(['unavailable', 'RobotWare 8 has no RMMP']);
  });

  it('RobotWare 8 with a client that lacks the read: unavailable, with that reason', () => {
    const access = rw8({ locks: [lock('writeaccess', { held: null, asOf: null })], remoteAccessEnabled: null, via: null,
      problem: NO_WRITE_ACCESS_READER, asOf: null });
    expect(table({ access }, 'rws2', { ...FACTS, writeAccessStatus: false })['write-access']).toEqual(['unavailable', NO_WRITE_ACCESS_READER]);
  });

  it('no generation on a healthy link: all three unavailable, with that reason', () => {
    const access: AccessGroup = {
      generation: null, model: null, locks: [], remoteAccessEnabled: null, rmmp: rmmpUnread, via: null, problem: NO_GENERATION, asOf: null,
    };
    const t = table({ access });
    expect(t.mastership).toEqual(['unavailable', NO_GENERATION]);
    expect(t['write-access']).toEqual(['unavailable', NO_GENERATION]);
    expect(t.rmmp).toEqual(['unavailable', NO_GENERATION]);
  });

  it('a lock with `held` null and no error is unknown: not read yet on this connection', () => {
    const access = rw7({ locks: [lock('edit'), lock('motion', { held: null, reported: null, asOf: null })], asOf: null });
    expect(table({ access }).mastership).toEqual(['unknown', 'not read on this connection yet']);
    const all = rw7({ locks: [lock('edit', { held: null, asOf: null }), lock('motion', { held: null, asOf: null })], rmmp: rmmpUnread, asOf: null });
    expect(table({ access: all }).mastership).toEqual(['unknown', 'not read on this connection yet']);
    expect(table({ access: all }).rmmp).toEqual(['unknown', 'not read on this connection yet']);
  });

  it('a lock with an error is degraded with the first message, never available - also when it still carries a value', () => {
    const notUnderstood: GroupError = { code: 'PARSE_ERROR', message: 'the mastership status of motion was not understood' };
    // A first read that was not understood: no value, an error.
    const first = rw7({ locks: [lock('edit'), lock('motion', { held: null, reported: 'unknown', asOf: null, error: notUnderstood })], asOf: null });
    expect(table({ access: first }).mastership).toEqual(['degraded', notUnderstood.message]);
    // A later read failing: the value of the read before it is kept, and the row is still not `available`.
    const later = rw7({ locks: [lock('edit', { error: ERR }), lock('motion', { held: true, error: notUnderstood })] });
    expect(table({ access: later }).mastership).toEqual(['degraded', 'HTTP 503 - busy']);
    // An error counts before an unread lock.
    const mixed = rw7({ locks: [lock('edit', { held: null, asOf: null }), lock('motion', { error: ERR })], asOf: null });
    expect(table({ access: mixed }).mastership).toEqual(['degraded', 'HTTP 503 - busy']);
  });

  it('write-access: unknown until read, degraded with the lock\'s error', () => {
    expect(table({ access: rw8({ locks: [lock('writeaccess', { held: null, asOf: null })], asOf: null }) })['write-access'])
      .toEqual(['unknown', 'not read on this connection yet']);
    const failing = { code: 'PARSE_ERROR', message: 'the write-access status was not understood' };
    expect(table({ access: rw8({ locks: [lock('writeaccess', { held: null, asOf: null, error: failing })], asOf: null }) })['write-access'])
      .toEqual(['degraded', failing.message]);
    expect(table({ access: rw8({ locks: [lock('writeaccess', { held: true, error: ERR })] }) })['write-access']).toEqual(['degraded', ERR.message]);
  });

  it('rmmp: not offered on RobotWare 6 is unavailable; an error is degraded; unread is unknown', () => {
    expect(table({ access: rw6({ rmmp: rmmpNone }) }, 'rws1').rmmp).toEqual(['unavailable', 'this controller does not offer RMMP']);
    expect(table({ access: rw7({ rmmp: rmmpNone }) }).rmmp).toEqual(['unavailable', 'this controller does not offer RMMP']);
    const failing: RmmpInfo = { supported: true, privilege: 'none', asOf: AT, error: { code: 'PARSE_ERROR', message: 'the RMMP privilege was not understood' } };
    expect(table({ access: rw7({ rmmp: failing }) }).rmmp).toEqual(['degraded', 'the RMMP privilege was not understood']);
    expect(table({ access: rw7({ rmmp: { ...rmmpUnread, error: ERR } }) }).rmmp).toEqual(['degraded', ERR.message]);
    expect(table({ access: rw7({ rmmp: rmmpUnread }) }).rmmp).toEqual(['unknown', 'not read on this connection yet']);
    // Mastership does not wait for RMMP.
    expect(table({ access: rw7({ rmmp: rmmpUnread }) }).mastership).toEqual(['available', null]);
  });
});

describe('every state of every row is reachable', () => {
  it('as the table of states this file exercises', () => {
    const seen = new Map<CapabilityId, Set<string>>();
    const note = (t: ReturnType<typeof table>) => {
      for (const id of CAPABILITY_IDS) { seen.set(id, (seen.get(id) ?? new Set()).add(t[id][0])); }
    };
    const noGeneration: AccessGroup = {
      generation: null, model: null, locks: [], remoteAccessEnabled: null, rmmp: rmmpUnread, via: null, problem: NO_GENERATION, asOf: null,
    };
    note(table());
    note(table({ link: link('polling'), events: events({ via: 'poll', clock: { offsetMs: null, measuredAt: null, problem: 'x' } }) }));
    note(table({ link: link('stale') }));
    note(table({ access: rw8(), motion: motion([]), events: events({ via: null, clock: { offsetMs: null, measuredAt: null, problem: null } }) },
      'rws2', { ...FACTS, clock: true, ioTableLoaded: false }));
    note(table({ access: rw6({ rmmp: rmmpNone }), motion: motion([unit('ROB_1', [])]) }, 'rws1', { ...FACTS, clock: false, ioTableRows: 100 }));
    note(table({ access: rw7({ locks: [lock('edit', { error: ERR }), lock('motion')], rmmp: { ...rmmpRead, error: ERR } }) }));
    note(table({ access: rw7({ locks: [lock('edit', { held: null, asOf: null }), lock('motion')], rmmp: rmmpUnread, asOf: null }) }));
    note(table({ access: rw8({ locks: [lock('writeaccess', { held: null, asOf: null })], asOf: null }) }));
    note(table({ access: rw8({ locks: [lock('writeaccess', { error: ERR })] }) }));
    note(table({ access: noGeneration }));
    const states = (id: CapabilityId) => [...seen.get(id)!].sort();
    // `unknown` on every row comes from the link that is not healthy; the rest from a healthy one.
    expect(states('status-push')).toEqual(['available', 'degraded', 'unknown']);
    expect(states('events-push')).toEqual(['available', 'degraded', 'unknown']);
    expect(states('event-times')).toEqual(['available', 'degraded', 'unavailable', 'unknown']);
    expect(states('io-push')).toEqual(['available', 'degraded', 'unavailable', 'unknown']);
    expect(states('io-table')).toEqual(['available', 'degraded', 'unknown']);
    expect(states('joint-limits')).toEqual(['available', 'degraded', 'unknown']);
    expect(states('mastership')).toEqual(['available', 'degraded', 'unavailable', 'unknown']);
    expect(states('write-access')).toEqual(['available', 'degraded', 'unavailable', 'unknown']);
    expect(states('rmmp')).toEqual(['available', 'degraded', 'unavailable', 'unknown']);
  });
});

describe('inputs the fleet never hands over: still a row that guesses nothing', () => {
  // The fleet gives a healthy link a protocol, and a healthy link without a generation a `problem`.
  // The table is a pure function, so it is held to an answer for the inputs between those too.
  it('a healthy link whose protocol is not known: io-push is unknown, with the link\'s reason', () => {
    expect(table({}, null)['io-push']).toEqual(['unknown', 'WebSocket events streaming']);
    expect(capabilitiesGroup(groups(), null, FACTS).protocol).toBeNull();
  });

  it('a healthy link with no generation and no problem: mastership, write-access and rmmp are unknown, never available', () => {
    const bare: AccessGroup = {
      generation: null, model: null, locks: [], remoteAccessEnabled: null, rmmp: rmmpUnread, via: null, problem: null, asOf: null,
    };
    const t = table({ access: bare });
    expect(t.mastership).toEqual(['unknown', 'not read on this connection yet']);
    expect(t['write-access']).toEqual(['unknown', 'not read on this connection yet']);
    expect(t.rmmp).toEqual(['unknown', 'not read on this connection yet']);
  });
});

describe('client facts, taken from the manager without a request', () => {
  it('a manager with every read', () => {
    const manager = {
      getControllerClock() {}, onSubscriptionEvent() {}, updateSubscriptionGroup() {}, getWriteAccessStatus() {},
      subscriptionGroupPath: '/subscription/1',
      state: { connected: true, ioSignals: [{ name: 'do_a' }, { name: 'do_b' }], ioSignalsLoaded: true },
    };
    expect(clientFacts(manager)).toEqual({
      clock: true, ioEvents: true, writeAccessStatus: true, subscriptionGroup: true, ioTableLoaded: true, ioTableRows: 2,
    });
  });

  it('a manager without them, and none at all', () => {
    const bare = { subscriptionGroupPath: undefined, state: { connected: true, ioSignals: [], ioSignalsLoaded: false } };
    const none = { clock: false, ioEvents: false, writeAccessStatus: false, subscriptionGroup: false, ioTableLoaded: false, ioTableRows: 0 };
    expect(clientFacts(bare)).toEqual(none);
    expect(clientFacts(null)).toEqual(none);
    expect(clientFacts({})).toEqual(none);
    // The tap alone is not enough to deliver signal changes: the group must be editable too.
    expect(clientFacts({ onSubscriptionEvent() {} }).ioEvents).toBe(false);
  });

  it('a client without the loaded flag: a connected link with a table counts as loaded', () => {
    expect(clientFacts({ state: { connected: true, ioSignals: [{ name: 'a' }] } })).toMatchObject({ ioTableLoaded: true, ioTableRows: 1 });
    expect(clientFacts({ state: { connected: false, ioSignals: [{ name: 'a' }] } }).ioTableLoaded).toBe(false);
  });
});

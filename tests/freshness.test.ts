import { describe, it, expect } from 'vitest';
import type { RobotState } from 'abb-rws-client';
import { NO_GENERATION, NO_WRITE_ACCESS_READER, lockFromMastership, rmmpFromPrivilege, unreadView, type AccessView } from '../src/access.js';
import type { ControllerConfig } from '../src/config.js';
import { FRESH_GROUPS, WITHHELD_REASON, freshnessGroup } from '../src/freshness.js';
import { summarize, type ManagerView, type Timing } from '../src/fleet.js';
import type {
  AccessGroup, AccessLockInfo, ControllerSnapshot, EventsGroup, FreshGroupName, GroupError, GroupFreshnessState, IoGroup, LinkGroup,
  LinkQuality, MotionGroup, MotionUnitInfo, RmmpInfo,
} from '../src/schema/v0.js';

const AT = '2026-10-05T08:00:00.000Z';
const EARLIER = '2026-10-05T07:55:00.000Z';
const RW7_ID = '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}';
const ERR: GroupError = { code: 'CONTROLLER_BUSY', message: 'HTTP 503 - busy' };

type Groups = Pick<ControllerSnapshot, 'identity' | 'link' | 'panel' | 'rapid' | 'motion' | 'io' | 'events' | 'access'>;

const REASON: Record<LinkQuality, string> = {
  live: 'WebSocket events streaming', polling: 'event stream lost; polling', stale: 'poll failed (1/3)',
  reconnecting: 'reconnecting', disconnected: 'connection lost',
};

const link = (quality: LinkQuality = 'live', over: Partial<LinkGroup> = {}): LinkGroup => {
  const healthy = quality === 'live' || quality === 'polling';
  return {
    connected: quality !== 'disconnected' && quality !== 'reconnecting', quality, qualityReason: REASON[quality],
    since: AT, downSince: healthy ? null : EARLIER, host: '127.0.0.1', port: 9403, useHttps: true,
    subscriptions: { active: quality === 'live' }, identityCheck: { status: 'confirmed', expected: RW7_ID, actual: RW7_ID }, reconnect: null,
    ...over,
  };
};

const unit = (name: string, error: GroupError | null = null): MotionUnitInfo =>
  ({ name, kind: 'robot', typeRaw: 'TCPRobot', task: null, joints: [], pose: null, error });
const motionIdle: MotionGroup = { watching: false, units: [], rate: { targetHz: null, achievedHz: null, via: null }, asOf: null };
const motion = (units: MotionUnitInfo[], asOf: string | null = AT): MotionGroup =>
  ({ watching: true, units, rate: { targetHz: 8, achievedHz: 8, via: 'poll' }, asOf });

const signal = (name: string, over: Partial<IoGroup['signals'][number]> = {}): IoGroup['signals'][number] =>
  ({ name, type: 'DO', value: '0', via: 'poll', asOf: AT, error: null, ...over });
const ioIdle: IoGroup = { watching: false, signals: [], asOf: null };
const io = (signals: IoGroup['signals']): IoGroup => ({ watching: true, signals, asOf: signals.some(s => s.asOf) ? AT : null });

const events = (over: Partial<EventsGroup> = {}): EventsGroup => ({
  feed: 'f', lastSeq: 0, recent: [], via: 'subscription', clock: { offsetMs: -7_200_000, measuredAt: AT, problem: null }, asOf: AT, error: null,
  ...over,
});

const lock = (name: AccessLockInfo['lock'], over: Partial<AccessLockInfo> = {}): AccessLockInfo =>
  ({ lock: name, held: false, holder: null, heldByDaemon: false, reported: name === 'writeaccess' ? null : 'nomaster', asOf: AT, error: null, ...over });
const unreadLock = (name: AccessLockInfo['lock']) => lock(name, { held: null, reported: null, asOf: null });
const rmmpRead: RmmpInfo = { supported: true, privilege: 'none', asOf: AT, error: null };
const rmmpNone: RmmpInfo = { supported: false, privilege: null, asOf: null, error: null };
const rmmpUnread: RmmpInfo = { supported: null, privilege: null, asOf: null, error: null };
const access = (over: Partial<AccessGroup> = {}): AccessGroup => ({
  generation: 'rw7', model: 'mastership', locks: [lock('edit'), lock('motion')], remoteAccessEnabled: null, rmmp: rmmpRead,
  via: 'poll', problem: null, asOf: AT, ...over,
});

/** A healthy, fully read controller with nothing watched. */
const groups = (over: Partial<Groups> = {}): Groups => ({
  identity: {
    controllerName: 'c', controllerId: null, controllerType: null, virtual: null, mac: null, systemName: 's', sysId: RW7_ID, startTime: null,
    robotWare: { raw: '7.21.4', major: 7, minor: 21, generation: 'rws2' }, options: [], asOf: EARLIER,
  },
  link: link(),
  panel: { ctrlState: 'motoron', opMode: 'AUTO', speedRatio: 100, collisionDetection: null, asOf: AT },
  rapid: { execState: 'stopped', cycle: null, tasks: [], asOf: AT },
  motion: motionIdle,
  io: ioIdle,
  events: events(),
  access: access(),
  ...over,
});

const stateOf = (g: ReturnType<typeof freshnessGroup>, group: FreshGroupName) => {
  const e = g.groups.find(x => x.group === group)!;
  return [e.state, e.reason] as [GroupFreshnessState, string | null];
};
const states = (g: ReturnType<typeof freshnessGroup>) => Object.fromEntries(g.groups.map(e => [e.group, e.state]));

describe('freshness: the shape', () => {
  it('one entry per group, in wire order, each with that group\'s own asOf', () => {
    const g = freshnessGroup(groups({ motion: motion([unit('ROB_1')], EARLIER), io: io([signal('do_a')]) }));
    expect(g.groups.map(e => e.group)).toEqual(['identity', 'panel', 'rapid', 'motion', 'io', 'events', 'access']);
    expect(g.groups.map(e => e.group)).toEqual([...FRESH_GROUPS]);
    expect(Object.fromEntries(g.groups.map(e => [e.group, e.asOf]))).toEqual({
      identity: EARLIER, panel: AT, rapid: AT, motion: EARLIER, io: AT, events: AT, access: AT,
    });
  });

  it('a reason exactly when the state is not `current`', () => {
    const variants = [groups(), groups({ link: link('stale') }), groups({ link: link('disconnected') }),
      groups({ motion: motion([unit('A', ERR), unit('B')]), io: io([signal('a', { asOf: null }), signal('b')]) })];
    for (const v of variants) {
      for (const e of freshnessGroup(v).groups) {
        if (e.state === 'current') { expect(e.reason, e.group).toBeNull(); } else { expect(e.reason, e.group).toEqual(expect.any(String)); }
      }
    }
  });
});

describe('freshness: the link', () => {
  it('healthy and everything read: current, no reasons, idle watches do not lower it', () => {
    const g = freshnessGroup(groups());
    expect(g.level).toBe('current');
    expect(g.reasons).toEqual([]);
    expect(states(g)).toEqual({ identity: 'current', panel: 'current', rapid: 'current', motion: 'idle', io: 'idle', events: 'current', access: 'current' });
    expect(stateOf(g, 'motion')).toEqual(['idle', 'no consumer is watching']);
    expect(stateOf(g, 'io')).toEqual(['idle', 'no consumer is watching']);
  });

  it('polling is healthy: the level stays current', () => {
    const g = freshnessGroup(groups({ link: link('polling'), events: events({ via: 'poll' }) }));
    expect(g.level).toBe('current');
    expect(g.reasons).toEqual([]);
    expect(states(g)).toMatchObject({ identity: 'current', panel: 'current', rapid: 'current', events: 'current', access: 'current' });
  });

  it('a stale link: degraded, the link\'s reason alone; every group that holds values is stale since its own asOf', () => {
    const g = freshnessGroup(groups({
      link: link('stale'), events: events({ via: null }), access: access({ via: null }),
      motion: motion([unit('ROB_1')]), io: io([signal('do_a')]),
    }));
    expect(g.level).toBe('degraded');
    expect(g.reasons).toEqual(['link: poll failed (1/3)']);
    for (const group of FRESH_GROUPS) { expect(stateOf(g, group), group).toEqual(['stale', 'poll failed (1/3)']); }
  });

  it('disconnected after it was healthy: down; the groups keep their values as stale', () => {
    const g = freshnessGroup(groups({ link: link('disconnected'), events: events({ via: null }), access: access({ via: null }) }));
    expect(g.level).toBe('down');
    expect(g.reasons).toEqual(['link: connection lost']);
    expect(states(g)).toEqual({ identity: 'stale', panel: 'stale', rapid: 'stale', motion: 'idle', io: 'idle', events: 'stale', access: 'stale' });
    expect(stateOf(g, 'access')).toEqual(['stale', 'connection lost']);
    expect(freshnessGroup(groups({ link: link('reconnecting') })).level).toBe('down');
  });

  it('never reached: down, and every group unread with the link\'s reason', () => {
    const never = groups({
      identity: null, link: link('disconnected', { qualityReason: 'not connected' }),
      panel: { ctrlState: null, opMode: null, speedRatio: null, collisionDetection: null, asOf: null },
      rapid: { execState: null, cycle: null, tasks: [], asOf: null },
      events: events({ via: null, asOf: null, clock: { offsetMs: null, measuredAt: null, problem: null } }),
      access: { generation: null, model: null, locks: [], remoteAccessEnabled: null, rmmp: rmmpUnread, via: null, problem: null, asOf: null },
    });
    expect(freshnessGroup(never)).toEqual({
      level: 'down', reasons: ['link: not connected'],
      groups: [
        { group: 'identity', state: 'unread', asOf: null, reason: 'not connected' },
        { group: 'panel', state: 'unread', asOf: null, reason: 'not connected' },
        { group: 'rapid', state: 'unread', asOf: null, reason: 'not connected' },
        { group: 'motion', state: 'idle', asOf: null, reason: 'no consumer is watching' },
        { group: 'io', state: 'idle', asOf: null, reason: 'no consumer is watching' },
        { group: 'events', state: 'unread', asOf: null, reason: 'not connected' },
        { group: 'access', state: 'unread', asOf: null, reason: 'not connected' },
      ],
    });
  });

  it('a link that is up but has not delivered a group yet: unread, "not read yet", level current', () => {
    const g = freshnessGroup(groups({ identity: null, rapid: { execState: null, cycle: null, tasks: [], asOf: null } }));
    expect(stateOf(g, 'identity')).toEqual(['unread', 'not read yet']);
    expect(stateOf(g, 'rapid')).toEqual(['unread', 'not read yet']);
    expect(g.level).toBe('current');
  });

  it('the wrong controller: every group withheld, the link\'s own reason', () => {
    const reason = 'connected to a DIFFERENT controller (system id {B}, expected {A})';
    const g = freshnessGroup(groups({ link: link('live', { qualityReason: reason, identityCheck: { status: 'mismatch', expected: '{A}', actual: '{B}' } }) }));
    expect(g.level).toBe('wrong-controller');
    expect(g.reasons).toEqual([reason]);
    for (const group of FRESH_GROUPS) { expect(stateOf(g, group), group).toEqual(['withheld', WITHHELD_REASON]); }
    expect(WITHHELD_REASON).toBe('the link is on a different controller');
  });
});

describe('freshness: motion and io', () => {
  it('watching, not sampled yet: unread', () => {
    expect(stateOf(freshnessGroup(groups({ motion: motion([], null) })), 'motion')).toEqual(['unread', 'not sampled yet']);
    expect(stateOf(freshnessGroup(groups({ motion: motion([unit('ROB_1')], null) })), 'motion')).toEqual(['unread', 'not sampled yet']);
  });

  it('partial motion: some units failing; all failing is stale with the first message', () => {
    const partial = freshnessGroup(groups({ motion: motion([unit('ROB_1'), unit('STN_1', ERR), unit('STN_2')]) }));
    expect(stateOf(partial, 'motion')).toEqual(['partial', '1 of 3 mechanical units could not be read']);
    expect(partial.level).toBe('degraded');
    expect(partial.reasons).toEqual(['motion: 1 of 3 mechanical units could not be read']);
    const all = freshnessGroup(groups({ motion: motion([unit('ROB_1', ERR), unit('STN_1', { code: 'UNKNOWN', message: 'second' })]) }));
    expect(stateOf(all, 'motion')).toEqual(['stale', 'HTTP 503 - busy']);
    expect(all.level).toBe('degraded');
    expect(stateOf(freshnessGroup(groups({ motion: motion([unit('ROB_1')]) })), 'motion')).toEqual(['current', null]);
  });

  it('watching io with no signal is idle; with signals: current, unread, partial or stale', () => {
    expect(stateOf(freshnessGroup(groups({ io: io([]) })), 'io')).toEqual(['idle', 'no signal is watched']);
    expect(stateOf(freshnessGroup(groups({ io: io([signal('a'), signal('b')]) })), 'io')).toEqual(['current', null]);
    expect(stateOf(freshnessGroup(groups({ io: io([signal('a', { asOf: null }), signal('b', { asOf: null })]) })), 'io')).toEqual(['unread', 'not read yet']);
    expect(stateOf(freshnessGroup(groups({ io: io([signal('a', { asOf: null }), signal('b'), signal('c')]) })), 'io'))
      .toEqual(['partial', '1 of 3 watched signals not read yet']);
    expect(stateOf(freshnessGroup(groups({ io: io([signal('a', { error: ERR }), signal('b', { asOf: null }), signal('c')]) })), 'io'))
      .toEqual(['partial', '1 of 3 watched signals could not be read']);
    expect(stateOf(freshnessGroup(groups({ io: io([signal('a', { error: ERR }), signal('b', { error: ERR })]) })), 'io')).toEqual(['stale', 'HTTP 503 - busy']);
  });

  it('a watch on a link that is not healthy is stale', () => {
    const g = freshnessGroup(groups({ link: link('stale'), motion: motion([unit('ROB_1')]), io: io([signal('a')]) }));
    expect(stateOf(g, 'motion')).toEqual(['stale', 'poll failed (1/3)']);
    expect(stateOf(g, 'io')).toEqual(['stale', 'poll failed (1/3)']);
  });

  it('two groups lowering the level: one reason each, in group order', () => {
    const g = freshnessGroup(groups({
      motion: motion([unit('A', ERR), unit('B')]), io: io([signal('a', { error: ERR }), signal('b')]),
    }));
    expect(g.level).toBe('degraded');
    expect(g.reasons).toEqual(['motion: 1 of 2 mechanical units could not be read', 'io: 1 of 2 watched signals could not be read']);
  });

  it('a signal that is only waiting for its first read is partial and does not lower the level; a failing one does', () => {
    const waiting = freshnessGroup(groups({ io: io([signal('a', { asOf: null }), signal('b')]) }));
    expect(stateOf(waiting, 'io')).toEqual(['partial', '1 of 2 watched signals not read yet']);
    expect(waiting.level).toBe('current');
    expect(waiting.reasons).toEqual([]);
    // Beside a group that does lower the level, the waiting one is not among the reasons.
    const beside = freshnessGroup(groups({ motion: motion([unit('A', ERR), unit('B')]), io: io([signal('a', { asOf: null }), signal('b')]) }));
    expect(beside.level).toBe('degraded');
    expect(beside.reasons).toEqual(['motion: 1 of 2 mechanical units could not be read']);
    // A signal that fails is a fault, whatever else is still waiting.
    const failing = freshnessGroup(groups({ io: io([signal('a', { error: ERR }), signal('b', { asOf: null }), signal('c')]) }));
    expect(stateOf(failing, 'io')).toEqual(['partial', '1 of 3 watched signals could not be read']);
    expect(failing.level).toBe('degraded');
    expect(failing.reasons).toEqual(['io: 1 of 3 watched signals could not be read']);
  });
});

describe('freshness: events', () => {
  it('a clock problem: partial - times not corrected, or corrected with an earlier reading', () => {
    const none = freshnessGroup(groups({ events: events({ clock: { offsetMs: null, measuredAt: null, problem: 'this abb-rws-client cannot read the controller clock' } }) }));
    expect(stateOf(none, 'events')).toEqual(['partial', 'event times are not corrected: this abb-rws-client cannot read the controller clock']);
    expect(none.level).toBe('degraded');
    expect(none.reasons).toEqual(['events: event times are not corrected: this abb-rws-client cannot read the controller clock']);
    const older = freshnessGroup(groups({ events: events({ clock: { offsetMs: -3_000, measuredAt: EARLIER, problem: 'the controller clock could not be read: timeout' } }) }));
    expect(stateOf(older, 'events'))
      .toEqual(['partial', 'event times are corrected with an earlier clock reading: the controller clock could not be read: timeout']);
  });

  it('a failed read is stale with its message; not confirmed is unread, or stale once something was read', () => {
    expect(stateOf(freshnessGroup(groups({ events: events({ error: ERR }) })), 'events')).toEqual(['stale', 'HTTP 503 - busy']);
    const notConfirmed = 'the controller is not yet confirmed to be the one that was added';
    expect(stateOf(freshnessGroup(groups({ events: events({ via: null, asOf: null }) })), 'events')).toEqual(['unread', notConfirmed]);
    expect(stateOf(freshnessGroup(groups({ events: events({ via: null }) })), 'events')).toEqual(['stale', notConfirmed]);
  });

  it('no feed, or readable and not read yet: unread', () => {
    expect(stateOf(freshnessGroup(groups({ events: events({ feed: null, via: null, asOf: null }) })), 'events')).toEqual(['unread', 'not read yet']);
    const first = freshnessGroup(groups({ events: events({ asOf: null }) }));
    expect(stateOf(first, 'events')).toEqual(['unread', 'not read yet']);
    expect(first.level).toBe('current');
  });
});

describe('freshness: access, rule by rule', () => {
  const NOT_UNDERSTOOD: GroupError = { code: 'PARSE_ERROR', message: 'the mastership status of motion was not understood' };

  it('1. a problem: unavailable, and the level stays current', () => {
    const noReader = freshnessGroup(groups({ access: access({
      generation: 'rw8', model: 'writeaccess', locks: [unreadLock('writeaccess')], rmmp: rmmpNone, via: null, problem: NO_WRITE_ACCESS_READER, asOf: null,
    }) }));
    expect(stateOf(noReader, 'access')).toEqual(['unavailable', NO_WRITE_ACCESS_READER]);
    expect(noReader.level).toBe('current');
    expect(noReader.reasons).toEqual([]);
    const noGeneration = freshnessGroup(groups({ access: {
      generation: null, model: null, locks: [], remoteAccessEnabled: null, rmmp: rmmpUnread, via: null, problem: NO_GENERATION, asOf: null,
    } }));
    expect(stateOf(noGeneration, 'access')).toEqual(['unavailable', NO_GENERATION]);
    expect(noGeneration.level).toBe('current');
  });

  it('2. no generation and no problem (the link is not up): unread, with the link\'s reason', () => {
    const g = freshnessGroup(groups({ link: link('disconnected'), events: events({ via: null }), access: {
      generation: null, model: null, locks: [], remoteAccessEnabled: null, rmmp: rmmpUnread, via: null, problem: null, asOf: null,
    } }));
    expect(stateOf(g, 'access')).toEqual(['unread', 'connection lost']);
  });

  it('3. nothing is being read: stale when a part holds a reading, unread when none does', () => {
    const kept = freshnessGroup(groups({ link: link('stale'), access: access({ via: null, locks: [lock('edit'), unreadLock('motion')], rmmp: rmmpUnread, asOf: null }) }));
    expect(stateOf(kept, 'access')).toEqual(['stale', 'poll failed (1/3)']);
    const nothing = freshnessGroup(groups({ link: link('stale'), access: access({ via: null, locks: [unreadLock('edit'), unreadLock('motion')], rmmp: rmmpUnread, asOf: null }) }));
    expect(stateOf(nothing, 'access')).toEqual(['unread', 'poll failed (1/3)']);
  });

  it('4. every part failing: stale, with the first message - a status that was not understood included', () => {
    const g = freshnessGroup(groups({ access: access({
      locks: [lock('edit', { error: ERR }), lock('motion', { held: null, reported: 'unknown', asOf: null, error: NOT_UNDERSTOOD })],
      rmmp: { ...rmmpRead, error: ERR }, asOf: null,
    }) }));
    expect(stateOf(g, 'access')).toEqual(['stale', 'HTTP 503 - busy']);
    expect(g.level).toBe('degraded');
    expect(g.reasons).toEqual(['access: HTTP 503 - busy']);
    // RobotWare 8: one part, not understood.
    const rw8 = freshnessGroup(groups({ access: access({
      generation: 'rw8', model: 'writeaccess', rmmp: rmmpNone, asOf: null,
      locks: [lock('writeaccess', { held: null, asOf: null, error: { code: 'PARSE_ERROR', message: 'the write-access status was not understood' } })],
    }) }));
    expect(stateOf(rw8, 'access')).toEqual(['stale', 'the write-access status was not understood']);
  });

  it('5. no part failing and none good: unread - a group cleared after a reconnect, before its first round lands', () => {
    const g = freshnessGroup(groups({ access: access({ locks: [unreadLock('edit'), unreadLock('motion')], rmmp: rmmpUnread, asOf: null }) }));
    expect(stateOf(g, 'access')).toEqual(['unread', 'not read on this connection yet']);
    expect(g.level).toBe('current');
    expect(g.reasons).toEqual([]);
  });

  it('6. some part failing, or some part not read: partial, naming those parts', () => {
    const failing = freshnessGroup(groups({ access: access({ locks: [lock('edit'), lock('motion', { held: true, error: NOT_UNDERSTOOD })] }) }));
    expect(stateOf(failing, 'access')).toEqual(['partial', 'motion: the mastership status of motion was not understood']);
    expect(failing.level).toBe('degraded');
    expect(failing.reasons).toEqual(['access: motion: the mastership status of motion was not understood']);
    const mixed = freshnessGroup(groups({ access: access({
      locks: [lock('edit', { held: null, reported: 'unknown', asOf: null, error: { code: 'PARSE_ERROR', message: 'the mastership status of edit was not understood' } }), lock('motion')],
      rmmp: rmmpUnread, asOf: null,
    }) }));
    expect(stateOf(mixed, 'access')).toEqual(['partial', 'edit: the mastership status of edit was not understood; RMMP: not read yet']);
    expect(mixed.level).toBe('degraded');
    const midRound = freshnessGroup(groups({ access: access({ locks: [lock('edit'), unreadLock('motion')], rmmp: rmmpUnread, asOf: null }) }));
    expect(stateOf(midRound, 'access')).toEqual(['partial', 'motion: not read yet; RMMP: not read yet']);
    const rmmpFailing = freshnessGroup(groups({ access: access({ rmmp: { ...rmmpRead, error: { code: 'PARSE_ERROR', message: 'the RMMP privilege was not understood' } } }) }));
    expect(stateOf(rmmpFailing, 'access')).toEqual(['partial', 'RMMP: the RMMP privilege was not understood']);
    expect(rmmpFailing.level).toBe('degraded');
  });

  it('6, half-way through the first round of a connection: partial, and the level is not lowered - no part is failing', () => {
    const midRound = freshnessGroup(groups({ access: access({ locks: [lock('edit'), unreadLock('motion')], rmmp: rmmpUnread, asOf: null }) }));
    expect(stateOf(midRound, 'access')).toEqual(['partial', 'motion: not read yet; RMMP: not read yet']);
    expect(midRound.level).toBe('current');
    expect(midRound.reasons).toEqual([]);
    const lastPart = freshnessGroup(groups({ access: access({ rmmp: rmmpUnread, asOf: null }) }));
    expect(stateOf(lastPart, 'access')).toEqual(['partial', 'RMMP: not read yet']);
    expect(lastPart.level).toBe('current');
    // One failing part beside the unread ones is a fault again.
    const oneFailing = freshnessGroup(groups({ access: access({ locks: [lock('edit', { error: ERR }), unreadLock('motion')], rmmp: rmmpUnread, asOf: null }) }));
    expect(stateOf(oneFailing, 'access')).toEqual(['partial', 'edit: HTTP 503 - busy; motion: not read yet; RMMP: not read yet']);
    expect(oneFailing.level).toBe('degraded');
    expect(oneFailing.reasons).toEqual(['access: edit: HTTP 503 - busy; motion: not read yet; RMMP: not read yet']);
  });

  it('7. every part good: current - RMMP not counted once the controller does not offer it', () => {
    expect(stateOf(freshnessGroup(groups()), 'access')).toEqual(['current', null]);
    expect(stateOf(freshnessGroup(groups({ access: access({ rmmp: rmmpNone }) })), 'access')).toEqual(['current', null]);
    expect(stateOf(freshnessGroup(groups({ access: access({
      generation: 'rw8', model: 'writeaccess', locks: [lock('writeaccess', { held: true })], rmmp: rmmpNone, remoteAccessEnabled: true,
    }) })), 'access')).toEqual(['current', null]);
  });

  it('a status that was not understood is never current, wherever it sits', () => {
    for (const where of [0, 1]) {
      for (const held of [null, true, false]) {
        const locks = [lock('edit'), lock('motion')];
        locks[where] = { ...locks[where], held, error: NOT_UNDERSTOOD };
        const [state] = stateOf(freshnessGroup(groups({ access: access({ locks }) })), 'access');
        expect(['partial', 'stale']).toContain(state);
      }
    }
  });
});

describe('freshness: no reason holds a time or a running count', () => {
  it('across every variant of this file', () => {
    const variants: Groups[] = [
      groups(), groups({ link: link('polling') }), groups({ link: link('stale') }), groups({ link: link('disconnected') }),
      groups({ link: link('reconnecting') }),
      groups({ motion: motion([unit('A', ERR), unit('B')]), io: io([signal('a', { asOf: null }), signal('b', { error: ERR })]) }),
      groups({ events: events({ error: ERR }) }), groups({ events: events({ clock: { offsetMs: null, measuredAt: null, problem: 'p' } }) }),
      groups({ access: access({ locks: [lock('edit', { error: ERR }), unreadLock('motion')], rmmp: rmmpUnread, asOf: null }) }),
      groups({ access: access({ via: null }), link: link('stale') }),
    ];
    for (const v of variants) {
      const g = freshnessGroup(v);
      for (const text of [...g.reasons, ...g.groups.map(e => e.reason ?? '')]) {
        expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|\d+ ?(ms|s|min)\b|\bago\b|since/);
      }
    }
  });

  it('is the same whenever it is worked out: only the groups go in', () => {
    const v = groups({ link: link('stale'), access: access({ via: null }) });
    const a = freshnessGroup(v);
    const later = { ...v, panel: { ...v.panel, asOf: '2026-10-05T09:00:00.000Z' } };
    const b = freshnessGroup(later);
    expect(b.reasons).toEqual(a.reasons);
    expect(b.groups.map(e => [e.state, e.reason])).toEqual(a.groups.map(e => [e.state, e.reason]));
  });
});

describe('freshness through summarize', () => {
  const T0 = Date.parse(AT);
  const cfg = (systemId?: string): ControllerConfig => ({
    id: 'c1', name: 'C1', host: '127.0.0.1', port: 9403, useHttps: true, username: 'u', password: 'p', ...(systemId ? { systemId } : {}),
  });
  const view = (quality: string, connected = true, generation: string | null = 'rw7', sysid = RW7_ID): ManagerView => ({
    currentPort: 9403, currentUseHttps: true,
    state: {
      connected, quality, qualityReason: REASON[quality as LinkQuality], identity: null,
      systemInfo: { name: 'x', rwVersion: '7.21.0', sysid, startTime: '', options: [] },
      ctrlstate: 'motoron', opmode: 'AUTO', tasks: [], ioSignals: [],
      access: { generation, locks: generation ? [{ lock: 'edit', state: 'idle' }, { lock: 'motion', state: 'idle' }] : [] },
    } as unknown as RobotState,
  });
  const timing: Timing = { identityAt: T0 - 60_000, since: T0 - 5_000, healthyAt: T0 - 30_000, watchedSince: T0 - 3_600_000 };
  const read = (): AccessView => {
    const v = unreadView('rw7');
    return {
      ...v,
      locks: v.locks.map(l => lockFromMastership(l, { answer: { mastership: 'nomaster' } }, T0 - 1_000)),
      rmmp: rmmpFromPrivilege(v.rmmp, { answer: 'none' }, T0 - 1_000),
    };
  };

  it('a healthy controller with the access status read is current', () => {
    const s = summarize(cfg(RW7_ID), view('live'), null, timing, T0, null, null, null, null, read());
    expect(s.freshness.level).toBe('current');
    expect(s.freshness.groups.find(g => g.group === 'access')).toEqual({ group: 'access', state: 'current', asOf: new Date(T0 - 1_000).toISOString(), reason: null });
    expect(s.capabilities.entries.find(e => e.id === 'mastership')).toEqual({ id: 'mastership', state: 'available', reason: null });
  });

  it('disconnected after healthy: down, the access values kept as stale, and no capability row says available', () => {
    const s = summarize(cfg(RW7_ID), view('disconnected', false, null), null, timing, T0, null, null, null, null, read());
    expect(s.freshness.level).toBe('down');
    expect(s.access).toMatchObject({ generation: 'rw7', via: null });
    expect(s.access.locks.map(l => l.held)).toEqual([false, false]);
    expect(s.freshness.groups.find(g => g.group === 'access')).toMatchObject({ state: 'stale', reason: 'connection lost' });
    expect(new Set(s.capabilities.entries.map(e => e.state))).toEqual(new Set(['unknown']));
  });

  it('a group cleared after a reconnect is unread until its first round lands', () => {
    const s = summarize(cfg(RW7_ID), view('live'), null, timing, T0, null, null, null, null, unreadView('rw7'));
    expect(s.freshness.groups.find(g => g.group === 'access')).toMatchObject({ state: 'unread', reason: 'not read on this connection yet' });
    expect(s.freshness.level).toBe('current');
    expect(s.capabilities.entries.find(e => e.id === 'mastership')).toMatchObject({ state: 'unknown' });
  });

  it('a healthy link without a generation: unavailable, and the level stays current', () => {
    const s = summarize(cfg(RW7_ID), view('live', true, null), null, timing, T0);
    expect(s.access).toMatchObject({ generation: null, problem: NO_GENERATION, via: null });
    expect(s.freshness.groups.find(g => g.group === 'access')).toMatchObject({ state: 'unavailable', reason: NO_GENERATION });
    expect(s.freshness.level).toBe('current');
  });

  it('the wrong controller: withheld everywhere, no capability row, an empty access group', () => {
    const s = summarize(cfg(RW7_ID), view('live', true, 'rw7', '{DDDEA751-93CE-4DAC-8D85-55725137AF66}'), null, timing, T0, null, null, null, null, read());
    expect(s.freshness.level).toBe('wrong-controller');
    expect(new Set(s.freshness.groups.map(g => g.state))).toEqual(new Set(['withheld']));
    expect(s.freshness.reasons).toEqual([s.link.qualityReason]);
    expect(s.capabilities.entries).toEqual([]);
    expect(s.access).toMatchObject({ generation: null, locks: [], via: null, problem: null });
  });
});

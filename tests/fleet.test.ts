import { describe, it, expect } from 'vitest';
import type { RobotState } from 'abb-rws-client';
import { assertIdentityCheckedRecovery, executionRunning, identityCheck, moduleKind, pointerDelayMs, pointerFrom, rapidGroup, reconnectDelayMs, summarize, type ManagerView } from '../src/fleet.js';
import type { ControllerConfig } from '../src/config.js';

const RW7_ID = '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}';
const RW8_ID = '{DDDEA751-93CE-4DAC-8D85-55725137AF66}';

const cfg = (systemId?: string): ControllerConfig => ({
  id: 'irb1600-6-120-1', name: 'IRB1600_6_120_1', host: '127.0.0.1', port: 9403, useHttps: true,
  username: 'Default User', password: 'x', ...(systemId ? { systemId } : {}),
});

/** A manager connected to whatever system `sysid` names, on `port`. */
const view = (sysid: string | null, port = 9403): ManagerView => ({
  currentPort: port,
  currentUseHttps: true,
  state: {
    connected: true, quality: 'live', qualityReason: 'WebSocket events streaming',
    identity: null,
    systemInfo: sysid ? { name: 'x', rwVersion: '7.21.0', sysid, startTime: '', options: [] } : null,
  } as unknown as RobotState,
});

describe('identityCheck', () => {
  it('confirms the configured controller, ignoring braces and case', () => {
    expect(identityCheck(cfg(RW7_ID), view(RW7_ID.toLowerCase().slice(1, -1))).status).toBe('confirmed');
  });

  it('is unverified until both ids are known', () => {
    expect(identityCheck(cfg(), view(RW7_ID)).status).toBe('unverified');
    expect(identityCheck(cfg(RW7_ID), view(null)).status).toBe('unverified');
    expect(identityCheck(cfg(RW7_ID), null).status).toBe('unverified');
  });

  it('flags a different controller', () => {
    expect(identityCheck(cfg(RW7_ID), view(RW8_ID))).toEqual({ status: 'mismatch', expected: RW7_ID, actual: RW8_ID });
  });
});

describe('summarize', () => {
  // The 2026-09-23 incident: the RW7 entry ended up talking to the RW8 VC on 5466.
  it('says so plainly when a link is connected to a different controller', () => {
    const s = summarize(cfg(RW7_ID), view(RW8_ID, 5466));
    expect(s.link.identityCheck.status).toBe('mismatch');
    expect(s.link.qualityReason).toMatch(/DIFFERENT controller/);
  });

  it('reports the confirmed link unchanged', () => {
    const s = summarize(cfg(RW7_ID), view(RW7_ID));
    expect(s.link.identityCheck.status).toBe('confirmed');
    expect(s.link.qualityReason).toBe('WebSocket events streaming');
  });
});

describe('assertIdentityCheckedRecovery', () => {
  it('accepts the installed client', () => {
    expect(() => assertIdentityCheckedRecovery()).not.toThrow();
  });

  it('refuses a client whose recovery cannot check identity', () => {
    expect(() => assertIdentityCheckedRecovery({})).toThrow(/too old/);
  });
});

describe('reconnectDelayMs', () => {
  it('backs off 5, 10, 20, 40 s and caps at 60 s', () => {
    expect([1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
  });
});

describe('summarize reconnect', () => {
  it('shows the pending reconnect while disconnected, and nothing once connected', () => {
    const retry = { failures: 2, next: Date.parse('2026-09-23T22:50:00Z') };
    const down = { ...view(RW7_ID), state: { ...view(RW7_ID).state, connected: false } } as ManagerView;
    expect(summarize(cfg(RW7_ID), down, retry).link.reconnect).toEqual({ failures: 2, nextAttemptAt: '2026-09-23T22:50:00.000Z' });
    expect(summarize(cfg(RW7_ID), view(RW7_ID), retry).link.reconnect).toBeNull();
  });
});

describe('summarize panel and freshness', () => {
  const T0 = Date.parse('2026-09-23T20:00:00Z');
  const timing = { identityAt: T0 - 60_000, since: T0 - 5_000, healthyAt: T0 - 30_000 };
  const withPanel = (quality: string, sysid = RW7_ID) => ({
    ...view(sysid),
    state: { ...view(sysid).state, quality, ctrlstate: 'motoron', opmode: 'AUTO', speedRatio: 75, coldetstate: 'INIT' },
  }) as unknown as ManagerView;

  it('carries the status values, current while the link is healthy', () => {
    const s = summarize(cfg(RW7_ID), withPanel('live'), null, timing, T0);
    expect(s.panel).toEqual({ ctrlState: 'motoron', opMode: 'AUTO', speedRatio: 75, collisionDetection: 'INIT', asOf: '2026-09-23T20:00:00.000Z' });
  });

  it('freezes panel.asOf at the last healthy moment once the link degrades', () => {
    const s = summarize(cfg(RW7_ID), withPanel('stale'), null, timing, T0);
    expect(s.panel.asOf).toBe('2026-09-23T19:59:30.000Z');
    expect(s.panel.speedRatio).toBe(75);   // still shown - as stale, not hidden
  });

  it('stamps identity with when it was actually re-read, and link with when its state began', () => {
    const s = summarize(cfg(RW7_ID), withPanel('live'), null, timing, T0);
    expect(s.identity?.asOf).toBe('2026-09-23T19:59:00.000Z');
    expect(s.link.since).toBe('2026-09-23T19:59:55.000Z');
  });

  it('shows no identity or status for a link on the wrong controller', () => {
    const s = summarize(cfg(RW7_ID), withPanel('live', RW8_ID), null, timing, T0);
    expect(s.link.identityCheck.status).toBe('mismatch');
    expect(s.identity).toBeNull();
    expect(s.panel).toEqual({ ctrlState: null, opMode: null, speedRatio: null, collisionDetection: null, asOf: null });
  });
});

describe('summarize link.mode (schema 0.13)', () => {
  it('a live daemon says live, with no recording time, healthy or not', () => {
    expect(summarize(cfg(RW7_ID), view(RW7_ID)).link).toMatchObject({ mode: 'live', recordedAt: null });
    expect(summarize(cfg(RW7_ID), null).link).toMatchObject({ mode: 'live', recordedAt: null });
  });
});

describe('summarize link.connected', () => {
  const withQuality = (quality: string, connected = true) => ({
    ...view(RW7_ID), state: { ...view(RW7_ID).state, quality, connected },
  }) as unknown as ManagerView;

  it('is false while a session is being made or remade, before the controller has answered on it', () => {
    for (const quality of ['reconnecting', 'disconnected']) {
      expect(summarize(cfg(RW7_ID), withQuality(quality, true)).link, quality).toMatchObject({ connected: false, quality });
    }
  });

  it('is true once the controller has answered on the session, and stays so while its answers go stale', () => {
    for (const quality of ['live', 'polling', 'stale']) {
      expect(summarize(cfg(RW7_ID), withQuality(quality, true)).link.connected, quality).toBe(true);
      expect(summarize(cfg(RW7_ID), withQuality(quality, false)).link.connected, quality).toBe(false);
    }
  });
});

describe('summarize link.downSince (schema 0.13)', () => {
  const T0 = Date.parse('2026-10-05T08:00:00Z');
  const withQuality = (quality: string, connected = true) => ({
    ...view(RW7_ID), state: { ...view(RW7_ID).state, quality, connected },
  }) as unknown as ManagerView;

  it('is null while the link is healthy', () => {
    const timing = { identityAt: T0, since: T0 - 5_000, healthyAt: T0, watchedSince: T0 - 3_600_000 };
    expect(summarize(cfg(RW7_ID), withQuality('live'), null, timing, T0).link.downSince).toBeNull();
    expect(summarize(cfg(RW7_ID), withQuality('polling'), null, timing, T0).link.downSince).toBeNull();
  });

  it('down after it was healthy: the last healthy moment, which does not move with each reconnect attempt', () => {
    const healthyAt = T0 - 90_000;
    for (const [quality, connected, since] of [['stale', true, T0 - 60_000], ['disconnected', false, T0 - 30_000], ['reconnecting', false, T0 - 1_000]] as const) {
      const s = summarize(cfg(RW7_ID), withQuality(quality, connected), null, { identityAt: T0, since, healthyAt, watchedSince: T0 - 3_600_000 }, T0);
      expect(s.link.downSince).toBe(new Date(healthyAt).toISOString());
      expect(s.link.since).toBe(new Date(since).toISOString());   // `since` restarts with every change of quality
    }
  });

  it('a quality that reads without a session is not a healthy link: downSince is set, and the panel keeps its last healthy time', () => {
    const healthyAt = T0 - 90_000;
    const timing = { identityAt: T0, since: T0 - 60_000, healthyAt, watchedSince: T0 - 3_600_000 };
    for (const quality of ['live', 'polling'] as const) {
      const s = summarize(cfg(RW7_ID), withQuality(quality, false), null, timing, T0);
      expect(s.link).toMatchObject({ connected: false, quality, downSince: new Date(healthyAt).toISOString() });
      expect(s.panel.asOf).toBe(new Date(healthyAt).toISOString());
      // The other groups say the same of this link.
      expect(s.freshness.level).toBe('down');
      expect(new Set(s.capabilities.entries.map(e => e.state))).toEqual(new Set(['unknown']));
    }
  });

  it('never reached: when the fleet began to watch the controller', () => {
    const watchedSince = T0 - 600_000;
    const timing = { identityAt: null, since: T0 - 2_000, healthyAt: null, watchedSince };
    expect(summarize(cfg(RW7_ID), null, { failures: 7, next: T0 + 60_000 }, timing, T0).link).toMatchObject({
      connected: false, quality: 'disconnected', downSince: new Date(watchedSince).toISOString(), since: new Date(T0 - 2_000).toISOString(),
    });
    expect(summarize(cfg(RW7_ID), withQuality('reconnecting', false), null, timing, T0).link.downSince).toBe(new Date(watchedSince).toISOString());
    // Without any timing at all (a snapshot made outside the fleet): now.
    expect(summarize(cfg(RW7_ID), null, null, null, T0).link.downSince).toBe(new Date(T0).toISOString());
    expect(summarize(cfg(RW7_ID), null, null, { identityAt: null, since: T0, healthyAt: null }, T0).link.downSince).toBe(new Date(T0).toISOString());
  });
});

describe('summarize access, capabilities and freshness (schema 0.13)', () => {
  const T0 = Date.parse('2026-10-05T08:00:00Z');

  it('a controller without a manager carries the three groups in their unread form', () => {
    const s = summarize(cfg(RW7_ID), null, null, null, T0);
    expect(Object.keys(s)).toEqual(['id', 'name', 'identity', 'link', 'panel', 'rapid', 'motion', 'io', 'events', 'access', 'capabilities', 'freshness']);
    expect(s.access).toEqual({
      generation: null, model: null, locks: [], remoteAccessEnabled: null,
      rmmp: { supported: null, privilege: null, asOf: null, error: null }, via: null, problem: null, asOf: null,
    });
    expect(s.capabilities).toEqual({
      protocol: null, generation: null, robotWare: null, tested: null,
      entries: ['status-push', 'events-push', 'event-times', 'io-push', 'io-table', 'joint-limits', 'mastership', 'write-access', 'rmmp']
        .map(id => ({ id, state: 'unknown', reason: 'not connected' })),
      asOf: null,
    });
    expect(s.freshness).toEqual({
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

  it('a connected manager that says nothing about access: the groups are there, and say why nothing is read', () => {
    const s = summarize(cfg(RW7_ID), view(RW7_ID), null, null, T0);
    expect(s.access).toMatchObject({ generation: null, locks: [], via: null, problem: 'the controller did not report a RobotWare version the client could use' });
    expect(s.capabilities).toMatchObject({ protocol: 'rws2', generation: null, robotWare: '7.21.0', tested: true, asOf: new Date(T0).toISOString() });
    expect(s.capabilities.entries.map(e => e.id)).toHaveLength(9);
    expect(s.freshness.groups.map(g => g.group)).toEqual(['identity', 'panel', 'rapid', 'motion', 'io', 'events', 'access']);
    expect(s.freshness.groups.find(g => g.group === 'access')).toMatchObject({ state: 'unavailable' });
  });

  it('a link on the wrong controller: no access, no capability row, everything withheld', () => {
    const s = summarize(cfg(RW7_ID), view(RW8_ID, 5466), null, null, T0);
    expect(s.access).toMatchObject({ generation: null, locks: [], via: null, problem: null });
    expect(s.capabilities).toEqual({ protocol: null, generation: null, robotWare: null, tested: null, entries: [], asOf: null });
    expect(s.freshness.level).toBe('wrong-controller');
    expect(new Set(s.freshness.groups.map(g => g.state))).toEqual(new Set(['withheld']));
  });

  it('what the client offers is taken from the manager when no facts are handed in', () => {
    const rw8 = (reader: boolean): ManagerView => ({
      ...view(RW8_ID),
      state: { ...view(RW8_ID).state, access: { generation: 'rw8', locks: [{ lock: 'writeaccess', state: 'idle', count: 0, since: null }] } },
      ...(reader ? { getWriteAccessStatus: async () => ({}) } : {}),
    }) as unknown as ManagerView;
    expect(summarize(cfg(RW8_ID), rw8(false), null, null, T0).access)
      .toMatchObject({ generation: 'rw8', via: null, problem: 'this abb-rws-client cannot read the write-access status' });
    expect(summarize(cfg(RW8_ID), rw8(true), null, null, T0).access).toMatchObject({ generation: 'rw8', via: 'poll', problem: null });
    // Facts handed in win over what the view looks like.
    const none = { clock: false, ioEvents: false, writeAccessStatus: false, subscriptionGroup: false, ioTableLoaded: false, ioTableRows: 0 };
    expect(summarize(cfg(RW8_ID), rw8(true), null, null, T0, null, null, null, null, null, none).access.problem)
      .toBe('this abb-rws-client cannot read the write-access status');
  });
});

describe('rapidGroup', () => {
  const state = {
    execstate: 'running', execCycle: 'forever',
    tasks: [
      { name: 'T_ROB1', type: 'normal', taskstate: 'initiated', excstate: 'running', active: true, motiontask: true },
      { name: 'T_BACK', type: 'static', taskstate: '', excstate: 'stopped', active: false, motiontask: false },
    ],
    modulesByTask: { T_ROB1: ['MainModule', 'BASE', 'user'] },
  } as unknown as RobotState;
  const pp = { module: 'MainModule', routine: 'main', line: 17 };

  it('maps execution, tasks, modules and the pointers read for each task', () => {
    const g = rapidGroup(state, { T_ROB1: { pp, mp: null } }, true, '2026-09-25T10:00:00.000Z');
    expect(g.execState).toBe('running');
    expect(g.cycle).toBe('forever');
    expect(g.asOf).toBe('2026-09-25T10:00:00.000Z');
    expect(g.tasks[0]).toEqual({ name: 'T_ROB1', type: 'normal', taskState: 'initiated', execState: 'running', active: true,
      motion: true, modules: ['MainModule', 'BASE', 'user'], pp, mp: null });
    // a task the modules poll has not covered, with no pointer read yet
    expect(g.tasks[1]).toMatchObject({ name: 'T_BACK', taskState: null, execState: 'stopped', modules: [], pp: null, mp: null });
  });

  it('carries nothing from a link on the wrong controller', () => {
    expect(rapidGroup(state, { T_ROB1: { pp, mp: null } }, false, '2026-09-25T10:00:00.000Z'))
      .toEqual({ execState: null, cycle: null, tasks: [], asOf: null });
  });

  it('is empty before the controller has been read', () => {
    expect(rapidGroup(null, null, true, null)).toEqual({ execState: null, cycle: null, tasks: [], asOf: null });
  });

  it('an unknown execution state is null, not guessed', () => {
    expect(rapidGroup({ ...state, execstate: 'weird' } as RobotState, null, true, null).execState).toBeNull();
  });
});

describe('pointer reads', () => {
  it('maps the client pointer; no module means no pointer', () => {
    expect(pointerFrom({ module: 'MainModule', routine: 'main', row: 17, col: 3 } as never)).toEqual({ module: 'MainModule', routine: 'main', line: 17 });
    expect(pointerFrom({ module: 'MainModule' })).toEqual({ module: 'MainModule', routine: null, line: null });
    expect(pointerFrom({})).toBeNull();
    expect(pointerFrom(null)).toBeNull();
    expect(pointerFrom({ module: 'M', row: 0 })).toEqual({ module: 'M', routine: null, line: null });
  });

  it('reads every second while a task runs, every 5 s otherwise', () => {
    expect(pointerDelayMs(true)).toBe(1000);
    expect(pointerDelayMs(false)).toBe(5000);
  });

  it('module kind from SysMod / ProgMod, null when unknown', () => {
    expect(moduleKind('SysMod')).toBe('system');
    expect(moduleKind('ProgMod')).toBe('program');
    expect(moduleKind('')).toBeNull();
    expect(moduleKind(undefined)).toBeNull();
  });
});

describe('executionRunning (the pointer cadence)', () => {
  const task = (excstate: string, active = true) => ({ name: 'T', type: 'normal', taskstate: '', excstate, active, motiontask: true }) as never;
  it('trusts the pushed execution state over the slow-polled task state', () => {
    // live 2026-09-25: the task list still said stopped while the program ran
    expect(executionRunning({ execstate: 'running', tasks: [task('stopped')] })).toBe(true);
  });
  it('a running active task counts too; an inactive one does not', () => {
    expect(executionRunning({ execstate: 'stopped', tasks: [task('running')] })).toBe(true);
    expect(executionRunning({ execstate: 'stopped', tasks: [task('running', false)] })).toBe(false);
    expect(executionRunning({ execstate: null, tasks: [] })).toBe(false);
  });
});

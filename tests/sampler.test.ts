import { describe, it, expect, vi, afterEach } from 'vitest';
import { RwsError, type RobotState } from 'abb-rws-client';
import { ControllerFleet, summarize, type ManagerView } from '../src/fleet.js';
import type { ControllerConfig } from '../src/config.js';
import { NEW_LEASE, WATCH_LEASES_MAX, type MotionWatch } from '../src/schema/v0.js';

const RW7_ID = '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}';
const RW8_ID = '{DDDEA751-93CE-4DAC-8D85-55725137AF66}';
const ID = 'irb1600-6-120-1';

const cfg = (systemId?: string): ControllerConfig => ({
  id: ID, name: 'IRB1600_6_120_1', host: '127.0.0.1', port: 9403, useHttps: true,
  username: 'Default User', password: 'x', ...(systemId ? { systemId } : {}),
});

const view = (sysid: string | null): ManagerView => ({
  currentPort: 9403,
  currentUseHttps: true,
  state: {
    connected: true, quality: 'live', qualityReason: 'WebSocket events streaming', identity: null,
    systemInfo: sysid ? { name: 'x', rwVersion: '7.21.0', sysid, startTime: '', options: [] } : null,
  } as unknown as RobotState,
});

describe('summarize motion', () => {
  const T0 = Date.parse('2026-09-25T12:00:00Z');
  const motion = {
    leaseUntil: T0 + 10_000, asOf: T0 - 50, samples: [], sampledSince: T0 - 500,
    units: [{ name: 'ROB_1', kind: 'robot' as const, typeRaw: 'TCPRobot', task: 'T_ROB1', joints: [], pose: null, error: null }],
  };
  const idle = { watching: false, units: [], rate: { targetHz: null, achievedHz: null, via: null }, asOf: null };

  it('is idle before anyone watches', () => {
    expect(summarize(cfg(RW7_ID), view(RW7_ID), null, null, T0).motion).toEqual(idle);
  });

  it('carries the sampled units while watched', () => {
    const m = summarize(cfg(RW7_ID), view(RW7_ID), null, null, T0, null, motion).motion;
    expect(m).toMatchObject({ watching: true, rate: { targetHz: 8, via: 'poll' }, asOf: '2026-09-25T11:59:59.950Z' });
    expect(m.units.map(u => u.name)).toEqual(['ROB_1']);
  });

  it('carries nothing from a link on the wrong controller', () => {
    expect(summarize(cfg(RW7_ID), view(RW8_ID), null, null, T0, null, motion).motion).toEqual(idle);
  });
});

describe('motion sampler', () => {
  const silent = { debug() {}, info() {}, warn() {}, error() {} };

  const T0 = Date.parse('2026-09-25T12:00:00Z');

  /** The motion configuration of six-axis TCP robots, as the axis-configuration walk reads it (instance names as on the VCs). */
  function mocOf(units: string[]): Record<string, Record<string, string>> {
    const moc: Record<string, Record<string, string>> = {};
    for (const u of units) {
      const p = u.toLowerCase().replace('_', '');   // ROB_1 -> rob1_N
      moc[`MECHANICAL_UNIT/${u}`] = { name: u, use_robot: u };
      moc[`ROBOT/${u}`] = Object.fromEntries([0, 1, 2, 3, 4, 5].map(i => [`use_joint_${i}`, `${p}_${i + 1}`]));
      for (let n = 1; n <= 6; n++) {
        moc[`JOINT/${p}_${n}`] = { logical_axis: String(n), use_arm: `${p}_${n}`, use_transmission: `${p}_${n}` };
        moc[`TRANSMISSION/${p}_${n}`] = { rotating_move: 'TRUE' };
        moc[`ARM/${p}_${n}`] = { lower_joint_bound: '-1.099558', upper_joint_bound: '2.3736479' };
      }
    }
    return moc;
  }

  /**
   * A controller's manager, reduced to what the sampler touches. Every read
   * takes `readMs` (0: resolves at once) and is logged as `<what>@<ms since T0>`
   * when it starts and `done:<what>@<ms>` when it ends.
   */
  function fakeManager(sysid = RW7_ID, opts: { units?: string[]; readMs?: number } = {}) {
    const units = opts.units ?? ['ROB_1'];
    const calls = { joints: 0, details: 0, pose: 0, cfg: 0 };
    const log: string[] = [];
    const moc = mocOf(units);
    const m = {
      calls,
      log,
      readMs: opts.readMs ?? 0,
      failJoints: null as Error | null,
      failDetails: null as Error | null,
      failPose: null as Error | null,
      failCfg: null as Error | null,
      j1: 10,
      currentPort: 9403 as number | undefined,
      currentUseHttps: true as boolean | undefined,
      state: {
        connected: true, quality: 'live', qualityReason: 'x', identity: null,
        systemInfo: { name: 'x', rwVersion: '7.21.0', sysid, startTime: '', options: [] },
        mechunits: units, execstate: null, tasks: [],
      } as unknown as RobotState,
      read: async <T>(what: string, fail: Error | null, value: () => T): Promise<T> => {
        log.push(`${what}@${Date.now() - T0}`);
        if (m.readMs > 0) { await new Promise(r => setTimeout(r, m.readMs)); }
        log.push(`done:${what}@${Date.now() - T0}`);
        if (fail) { throw fail; }
        return value();
      },
      getMechunitDetails: async (name: string) => {
        calls.details++;
        return m.read(`details:${name}`, m.failDetails, () => ({
          name, type: 'TCPRobot', axes: 6, axesTotal: 6, task: 'T_ROB1', mode: 'Activated', status: 'Synchronized',
          coordSystem: 'World', tool: 'tool0', wobj: 'wobj0', isIntegratedUnit: null, hasIntegratedUnit: null, raw: {},
        }));
      },
      getJointTargetFull: async (name: string) => {
        calls.joints++;
        return m.read(`joints:${name}`, m.failJoints, () => ({ rax: [m.j1, -10, 20, 0, 30, 0], eax: [0, 0, 0, 0, 0, 0] }));
      },
      getCartesianFull: async (name: string) => {
        calls.pose++;
        return m.read(`pose:${name}`, m.failPose, () => ({ x: 806.3, y: 0, z: 1015, q1: 0.5, q2: 0, q3: 0.866, q4: 0, j1: 0, j4: 0, j6: 0, jx: 0 }));
      },
      getCfgInstance: async (domain: string, type: string, instance: string) => {
        calls.cfg++;
        return m.read(`cfg:${domain}/${type}/${instance}`, m.failCfg, () => moc[`${type}/${instance}`] ?? {});
      },
    };
    return m;
  }
  const set = (mgr: ReturnType<typeof fakeManager>, over: Record<string, unknown>) => { Object.assign(mgr.state, over); };
  const noReads = { joints: 0, details: 0, pose: 0, cfg: 0 };

  let fleet: ControllerFleet | null = null;
  let logged: Array<{ level: string; obj: object; msg?: string }> = [];
  function fleetWith(manager: ReturnType<typeof fakeManager>): ControllerFleet {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    logged = [];
    const capture = (level: string) => (obj: object, msg?: string) => { logged.push({ level, obj, msg }); };
    fleet = new ControllerFleet([cfg(RW7_ID)], { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') });
    // Route the fleet's reads to the fake instead of a real session.
    (fleet as unknown as { managerOf: () => unknown }).managerOf = () => manager;
    return fleet;
  }
  afterEach(() => { fleet?.stopMotionSampler(); fleet = null; vi.useRealTimers(); });

  it('reads nothing while nobody holds a lease', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.calls).toEqual(noReads);
    expect(f.get(ID)!.motion.watching).toBe(false);
  });

  it('with a lease: 8 joint rounds a second, the pose every 4th, the unit description once', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    expect(f.watchMotion(ID)).toEqual({ leaseMs: 15_000, targetHz: 8 });
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.calls.joints).toBe(8);
    expect(mgr.calls.pose).toBe(2);
    expect(mgr.calls.details).toBe(1);
    const m = f.get(ID)!.motion;
    expect(m.watching).toBe(true);
    expect(m.rate).toMatchObject({ targetHz: 8, via: 'poll' });
    expect(m.units[0]).toMatchObject({ name: 'ROB_1', kind: 'robot', typeRaw: 'TCPRobot', task: 'T_ROB1', error: null });
    expect(m.units[0].joints.map(j => j.name)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6']);
    expect(m.units[0].pose).toMatchObject({ x: 806.3, q: [0.5, 0, 0.866, 0] });
    expect(m.asOf).not.toBeNull();
  });

  it('reads the axis configuration once per connection (~20 paced reads): units and limits from the MOC, again on a new connection', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.calls.cfg).toBe(20);
    const j = f.get(ID)!.motion.units[0].joints;
    expect(j[1]).toEqual({ name: 'J2', value: -10, unit: 'deg', min: -63, max: 136 });   // IRB1600 axis 2: -1.0996..2.3736 rad
    expect(j.every(x => x.unit === 'deg' && x.min === -63 && x.max === 136)).toBe(true);
    // The walk goes before the unit's first joints, through the same queue: no burst beside the sampling.
    expect(mgr.log.findIndex(l => l.startsWith('cfg:'))).toBeLessThan(mgr.log.findIndex(l => l.startsWith('joints:')));
    mgr.currentPort = 9404;              // the VC re-bound; the client followed it
    await vi.advanceTimersByTimeAsync(500);
    expect(mgr.calls.cfg).toBe(40);
    expect(logged.filter(l => l.msg === 'axis configuration read')).toHaveLength(2);
  });

  it('a failed configuration walk: joints without units or limits (never a guessed "deg"), retried after 5 s, then 10 s', async () => {
    const mgr = fakeManager();
    mgr.failCfg = new RwsError('controller busy', 'CONTROLLER_BUSY');
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.calls.cfg).toBe(1);   // the walk stops at its first failed read
    const j = f.get(ID)!.motion.units[0].joints;
    expect(j.map(x => x.name)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6']);
    expect(j.every(x => x.unit === null && x.min === null && x.max === null)).toBe(true);
    expect(f.get(ID)!.motion.units[0].error).toBeNull();   // the joints themselves were read
    expect(logged.filter(l => l.level === 'warn' && /axis configuration not read/.test(l.msg ?? ''))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);   // t = 6 s: retried once (after 5 s)
    expect(mgr.calls.cfg).toBe(2);
    mgr.failCfg = null;
    f.watchMotion(ID);                          // keep the lease (15 s) through the wait
    await vi.advanceTimersByTimeAsync(5_000);   // t = 11 s: the second retry waits 10 s
    expect(mgr.calls.cfg).toBe(2);
    f.watchMotion(ID);
    await vi.advanceTimersByTimeAsync(5_000);   // t = 16 s: the retry succeeds
    expect(mgr.calls.cfg).toBe(22);
    expect(f.get(ID)!.motion.units[0].joints[0]).toMatchObject({ unit: 'deg', min: -63, max: 136 });
  });

  it('a failed pose read is not the unit\'s error: the joints stay current and the last pose is kept', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(600);
    const before = f.get(ID)!.motion;
    expect(before.units[0].pose).not.toBeNull();
    mgr.failPose = new RwsError('controller busy', 'CONTROLLER_BUSY');
    mgr.j1 = 42;
    await vi.advanceTimersByTimeAsync(1_000);
    const u = f.get(ID)!.motion.units[0];
    expect(mgr.calls.pose).toBeGreaterThan(2);
    expect(u.error).toBeNull();
    expect(u.joints[0].value).toBe(42);
    expect(u.pose).toEqual(before.units[0].pose);
    expect(Date.parse(f.get(ID)!.motion.asOf!)).toBeGreaterThan(Date.parse(before.asOf!));
    expect(logged.filter(l => l.level === 'warn' && /pose read failed/.test(l.msg ?? ''))).toHaveLength(1);   // once, not at 2 Hz
  });

  it('a failed description is the unit\'s error only while it leaves no joint to report; the retry after 5 s clears it', async () => {
    const mgr = fakeManager();
    mgr.failDetails = new RwsError('controller busy', 'CONTROLLER_BUSY');
    mgr.failCfg = new RwsError('controller busy', 'CONTROLLER_BUSY');   // no configuration either: kind and axes unknown
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(1_000);
    let u = f.get(ID)!.motion.units[0];
    expect(u).toMatchObject({ kind: null, joints: [], pose: null, error: { code: 'CONTROLLER_BUSY' } });
    expect(mgr.calls.details).toBe(1);
    mgr.failDetails = null;
    await vi.advanceTimersByTimeAsync(3_000);   // t = 4 s: not yet retried
    expect(mgr.calls.details).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);   // t = 6 s: retried, joints reported, error gone
    expect(mgr.calls.details).toBe(2);
    u = f.get(ID)!.motion.units[0];
    expect(u).toMatchObject({ kind: 'robot', error: null });
    expect(u.joints.map(j => j.name)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6']);
  });

  it('a failed description with a readable configuration: the joints are reported from the MOC, with no error', async () => {
    const mgr = fakeManager();
    mgr.failDetails = new RwsError('parse', 'PARSE_ERROR');
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(1_000);
    const u = f.get(ID)!.motion.units[0];
    expect(u).toMatchObject({ kind: null, typeRaw: null, task: null, pose: null, error: null });
    expect(u.joints).toHaveLength(6);
    expect(mgr.calls.pose).toBe(0);   // no pose read without knowing it is a robot
  });

  it('two units with slow reads: one read at a time, the pose on every fourth round, and an honest achieved rate', async () => {
    const mgr = fakeManager(RW7_ID, { units: ['ROB_1', 'ROB_2'] });
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(200);   // the first round, configuration included, with instant reads
    mgr.readMs = 60;
    const jointsBefore = mgr.calls.joints;
    await vi.advanceTimersByTimeAsync(6_000);
    const m = f.get(ID)!.motion;
    expect(m.units.map(u => u.name)).toEqual(['ROB_1', 'ROB_2']);
    // Reads never overlap: each one ends before the next starts.
    let open = 0;
    for (const l of mgr.log) {
      if (l.startsWith('done:')) { open--; } else { open++; }
      expect(open).toBeLessThanOrEqual(1);
    }
    // A round is two 60 ms joint reads, plus two pose reads every fourth: ~150 ms on average, so under 8 Hz - and said so.
    const rounds = (mgr.calls.joints - jointsBefore) / 2;
    const perSecond = rounds / 6;
    expect(perSecond).toBeLessThan(7.5);
    expect(m.rate.achievedHz).not.toBeNull();
    expect(Math.abs(m.rate.achievedHz! - perSecond)).toBeLessThan(1);
    expect(mgr.calls.pose).toBeGreaterThanOrEqual(Math.floor(rounds / 4) * 2 - 2);
  });

  it('remove() in the middle of a round: the read in flight finishes, no further read goes out, and only then is the session closed', async () => {
    const mgr = fakeManager(RW7_ID, { units: ['ROB_1', 'ROB_2'] });
    const f = fleetWith(mgr);
    const multi = (f as unknown as { multi: { disconnectRobot: (id: string) => Promise<void> } }).multi;
    const realDisconnect = multi.disconnectRobot.bind(multi);
    multi.disconnectRobot = async (id: string) => { mgr.log.push(`logout@${Date.now() - T0}`); return realDisconnect(id); };
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(200);   // descriptions and configurations cached
    mgr.readMs = 60;
    await vi.advanceTimersByTimeAsync(110);   // a round has started (t = 280): ROB_1's joints are in flight
    const inFlight = mgr.log.at(-1)!;
    expect(inFlight).toMatch(/^joints:ROB_1@/);
    const jointsAtRemove = mgr.calls.joints;
    const removed = f.remove(ID);
    await vi.advanceTimersByTimeAsync(1_000);
    await removed;
    expect(mgr.calls.joints).toBe(jointsAtRemove);   // ROB_2's read was never issued
    const done = mgr.log.findIndex(l => l.startsWith('done:joints:ROB_1'));
    const logout = mgr.log.findIndex(l => l.startsWith('logout@'));
    expect(done).toBeGreaterThan(-1);
    expect(logout).toBeGreaterThan(done);
    expect(f.watchMotion(ID)).toBeNull();
  });

  it('disconnectAll() likewise: the round in flight is allowed to finish and issues nothing more', async () => {
    const mgr = fakeManager(RW7_ID, { units: ['ROB_1', 'ROB_2'] });
    const f = fleetWith(mgr);
    const multi = (f as unknown as { multi: { disconnectRobot: (id: string) => Promise<void> } }).multi;
    const realDisconnect = multi.disconnectRobot.bind(multi);
    multi.disconnectRobot = async (id: string) => { mgr.log.push(`logout@${Date.now() - T0}`); return realDisconnect(id); };
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(200);
    mgr.readMs = 60;
    await vi.advanceTimersByTimeAsync(110);
    expect(mgr.log.at(-1)).toMatch(/^joints:ROB_1@/);
    const jointsAtStop = mgr.calls.joints;
    const stopped = f.disconnectAll();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(mgr.calls.joints).toBe(jointsAtStop);
    expect(mgr.log.findIndex(l => l.startsWith('logout@'))).toBeGreaterThan(mgr.log.findIndex(l => l.startsWith('done:joints:ROB_1')));
  });

  it('a link change in the middle of a round discards it, and the next round re-reads the descriptions', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.get(ID)!.motion.units[0].joints[0].value).toBe(10);
    mgr.readMs = 60;
    mgr.j1 = 42;
    await vi.advanceTimersByTimeAsync(110);   // a joint read is in flight (started at t = 280)
    expect(mgr.log.at(-1)).toMatch(/^joints:ROB_1@/);
    mgr.currentPort = 9404;                    // the link moved under the round
    mgr.readMs = 0;
    await vi.advanceTimersByTimeAsync(40);     // the in-flight read lands: its round is discarded
    const detailsAfter = mgr.calls.details;
    expect(f.get(ID)!.motion.units[0].joints[0].value).toBe(10);
    await vi.advanceTimersByTimeAsync(300);    // the next rounds: a fresh description and configuration, then the new value
    expect(mgr.calls.details).toBe(detailsAfter + 1);
    expect(mgr.calls.cfg).toBe(40);
    expect(f.get(ID)!.motion.units[0].joints[0].value).toBe(42);
  });

  it('a change handler that throws is logged, and the sampler goes on', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    let boom = true;
    f.watchMotion(ID);
    f.onChanged(id => { if (boom && f.get(id)!.motion.units.length > 0) { boom = false; throw new Error('handler boom'); } });
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(logged.filter(l => l.level === 'error' && l.msg === 'motion sampler round failed')).toHaveLength(1);
    expect(mgr.calls.joints).toBe(8);
    expect(f.get(ID)!.motion.units[0].joints).toHaveLength(6);
  });

  it('measures the rate it achieves', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(6_000);
    const hz = f.get(ID)!.motion.rate.achievedHz!;
    expect(hz).toBeGreaterThanOrEqual(7.5);
    expect(hz).toBeLessThanOrEqual(8.5);
  });

  it('steps back to 2 Hz while the link is polling', async () => {
    const mgr = fakeManager();
    set(mgr, { quality: 'polling' });
    const f = fleetWith(mgr);
    expect(f.watchMotion(ID)!.targetHz).toBe(2);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.calls.joints).toBe(4);
    expect(f.get(ID)!.motion.rate.targetHz).toBe(2);
  });

  it('a lapsed lease stops sampling, keeps the values and freezes asOf, and says so', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    const seen: boolean[] = [];
    f.onChanged(id => { seen.push(f.get(id)!.motion.watching); });
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(16_000);
    const reads = mgr.calls.joints;
    const asOf = f.get(ID)!.motion.asOf;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mgr.calls.joints).toBe(reads);
    const m = f.get(ID)!.motion;
    expect(m.watching).toBe(false);
    expect(m.asOf).toBe(asOf);
    expect(Date.parse(asOf!)).toBeLessThanOrEqual(Date.parse('2026-09-25T12:00:15Z'));
    expect(m.units[0].joints).toHaveLength(6);
    expect(m.rate).toEqual({ targetHz: null, achievedHz: null, via: null });
    expect(seen[0]).toBe(true);
    expect(seen.at(-1)).toBe(false);
  });

  it('renewing the lease keeps it going', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(7_000); f.watchMotion(ID); }
    const before = mgr.calls.joints;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.calls.joints - before).toBe(8);
  });

  it('never reads a link on the wrong controller', async () => {
    const mgr = fakeManager(RW8_ID);
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.calls).toEqual(noReads);
    expect(f.get(ID)!.motion.units).toEqual([]);
  });

  it('nor one that is down or degraded', async () => {
    const mgr = fakeManager();
    set(mgr, { connected: false, quality: 'disconnected' });
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(1_000);
    set(mgr, { connected: true, quality: 'stale' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.calls.joints).toBe(0);
  });

  it('reads the unit description again on a new connection', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.calls.details).toBe(1);
    mgr.currentPort = 9404;              // the VC re-bound; the client followed it
    await vi.advanceTimersByTimeAsync(500);
    expect(mgr.calls.details).toBe(2);
  });

  it('a failed read is reported with its code, keeping the last good values', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(500);
    const asOf = f.get(ID)!.motion.asOf;
    mgr.failJoints = new RwsError('controller busy', 'CONTROLLER_BUSY');
    await vi.advanceTimersByTimeAsync(500);
    const u = f.get(ID)!.motion.units[0];
    expect(u.error).toEqual({ code: 'CONTROLLER_BUSY', message: 'controller busy' });
    expect(u.joints[0].value).toBe(10);
    expect(f.get(ID)!.motion.asOf).toBe(asOf);
  });

  it("a failed read keeps the controller's status, code and message on the unit", async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(500);
    mgr.failJoints = new RwsError('Service not supported by this controller version: 400', 'UNSUPPORTED_OPERATION',
      400, '<html>raw</html>', -1073445879, 'Invalid argument');
    await vi.advanceTimersByTimeAsync(500);
    expect(f.get(ID)!.motion.units[0].error).toEqual({
      code: 'UNSUPPORTED_OPERATION',
      message: 'Service not supported by this controller version: 400',
      controller: { httpStatus: 400, code: -1073445879, message: 'Invalid argument' },
    });
  });

  it('announces a joint that moved', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    const j1: number[] = [];
    f.onChanged(id => {
      const v = f.get(id)!.motion.units[0]?.joints[0]?.value;
      if (typeof v === 'number') { j1.push(v); }
    });
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(500);
    mgr.j1 = 42;
    await vi.advanceTimersByTimeAsync(500);
    expect(j1).toContain(10);
    expect(j1.at(-1)).toBe(42);
  });

  it('keeps the last values while the unit list is momentarily empty after a reconnect', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(500);
    set(mgr, { mechunits: [] });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.get(ID)!.motion.units.map(u => u.name)).toEqual(['ROB_1']);
  });

  it('removing the controller stops its sampling', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    f.watchMotion(ID);
    f.startMotionSampler();
    await vi.advanceTimersByTimeAsync(500);
    await f.remove(ID);
    const reads = mgr.calls.joints;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.calls.joints).toBe(reads);
    expect(f.watchMotion(ID)).toBeNull();
  });

  describe('consumer leases', () => {
    const grant = (w: ReturnType<ControllerFleet['watchMotion']>): MotionWatch => {
      if (!w || w === 'lease-limit') { throw new Error(`no grant: ${String(w)}`); }
      return w;
    };

    it('"new" opens a lease of the caller`s own, under an id of its own; without an id the grant carries none', () => {
      const f = fleetWith(fakeManager());
      const a = grant(f.watchMotion(ID, NEW_LEASE));
      const b = grant(f.watchMotion(ID, NEW_LEASE));
      expect(a).toEqual({ leaseMs: 15_000, targetHz: 8, leaseId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect(b.leaseId).not.toBe(a.leaseId);
      expect(grant(f.watchMotion(ID, a.leaseId)).leaseId).toBe(a.leaseId);
      expect(f.watchMotion(ID)).toEqual({ leaseMs: 15_000, targetHz: 8 });
    });

    it('sampling runs while any consumer`s lease runs: one lapsing leaves the other`s going, the last stops it', async () => {
      const mgr = fakeManager();
      const f = fleetWith(mgr);
      grant(f.watchMotion(ID, NEW_LEASE));                 // A: never renewed
      const b = grant(f.watchMotion(ID, NEW_LEASE));       // B: renewed every 7 s
      f.startMotionSampler();
      for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(7_000); f.watchMotion(ID, b.leaseId); }
      expect(f.get(ID)!.motion.watching).toBe(true);     // t = 28 s: A ran out long ago
      const before = mgr.calls.joints;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mgr.calls.joints - before).toBe(8);
      await vi.advanceTimersByTimeAsync(15_000);         // B stops renewing
      expect(f.get(ID)!.motion.watching).toBe(false);
      const after = mgr.calls.joints;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mgr.calls.joints).toBe(after);
    });

    it('a consumer`s lease is not ended by the anonymous lease running out', async () => {
      const mgr = fakeManager();
      const f = fleetWith(mgr);
      f.watchMotion(ID);                                   // anonymous, never renewed
      await vi.advanceTimersByTimeAsync(10_000);
      const own = grant(f.watchMotion(ID, NEW_LEASE));
      f.startMotionSampler();
      await vi.advanceTimersByTimeAsync(10_000);          // t = 20 s: the anonymous lease ran out at 15 s
      expect(f.get(ID)!.motion.watching).toBe(true);
      expect(grant(f.watchMotion(ID, own.leaseId)).leaseId).toBe(own.leaseId);
    });

    it('holds at most WATCH_LEASES_MAX leases with an id; renewals and the anonymous lease are never refused', () => {
      const f = fleetWith(fakeManager());
      const ids = Array.from({ length: WATCH_LEASES_MAX }, () => grant(f.watchMotion(ID, NEW_LEASE)).leaseId!);
      expect(f.watchMotion(ID, NEW_LEASE)).toBe('lease-limit');
      expect(grant(f.watchMotion(ID, ids[5])).leaseId).toBe(ids[5]);
      expect(f.watchMotion(ID)).toEqual({ leaseMs: 15_000, targetHz: 8 });
      vi.advanceTimersByTime(15_000);                      // every lease runs out
      expect(grant(f.watchMotion(ID, NEW_LEASE)).leaseId).toBeDefined();
    });
  });
});

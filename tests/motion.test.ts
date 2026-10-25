import { describe, it, expect } from 'vitest';
import type { JointTargetFull, MechunitDetails } from 'abb-rws-client';
import {
  MOTION_LEASE_MS, axisConfigRetryMs, measuredHz, motionGroup, motionJoints, motionSignature, motionTargetHz, poseFrom,
  readAxisConfig, unitKind, unitMetaFrom, type AxisConfig, type MotionView,
} from '../src/motion.js';

const X = 9e9;   // the jointtarget "not present" marker
const jt = (rax: number[], eax: number[]): JointTargetFull => ({ rax, eax }) as JointTargetFull;
const robot6 = { kind: 'robot' as const, axisCount: 6 };
const axis = (logicalAxis: number, unit: AxisConfig['unit'] = 'deg', min: number | null = -180, max: number | null = 180): AxisConfig =>
  ({ logicalAxis, unit, min, max });
/** The MOC of a six-axis robot as the axis-configuration walk sees it (instance names as on the VCs). */
const sixAxisRobot = (over: Record<string, Record<string, string>> = {}): Record<string, Record<string, string>> => {
  const moc: Record<string, Record<string, string>> = {
    'MECHANICAL_UNIT/ROB_1': { name: 'ROB_1', use_robot: 'ROB_1' },
    'ROBOT/ROB_1': { use_joint_0: 'rob1_1', use_joint_1: 'rob1_2', use_joint_2: 'rob1_3', use_joint_3: 'rob1_4', use_joint_4: 'rob1_5', use_joint_5: 'rob1_6' },
  };
  for (let n = 1; n <= 6; n++) {
    moc[`JOINT/rob1_${n}`] = { logical_axis: String(n), use_arm: `rob1_${n}`, use_transmission: `rob1_${n}` };
    moc[`TRANSMISSION/rob1_${n}`] = { rotating_move: 'TRUE' };
    moc[`ARM/rob1_${n}`] = { lower_joint_bound: '-1.099558', upper_joint_bound: '2.3736479' };
  }
  return { ...moc, ...over };
};
/** A CfgRead over a MOC table that records what it read; an unknown instance reads as empty, as RWS 1.0 answers. */
const cfgOf = (moc: Record<string, Record<string, string>>, reads: string[] = []) =>
  async (type: string, instance: string) => { reads.push(`${type}/${instance}`); return moc[`${type}/${instance}`] ?? {}; };

describe('unitKind', () => {
  it('TCPRobot is a robot; positioner types are positioners; anything else external', () => {
    expect(unitKind('TCPRobot')).toBe('robot');
    expect(unitKind('tcp_robot')).toBe('robot');
    expect(unitKind('TwoAxesPositioner')).toBe('positioner');
    expect(unitKind('Single')).toBe('external');
    expect(unitKind('Robot')).toBe('external');   // a robot without a TCP is not a TCP robot
  });

  it('a missing or empty type is unknown, not guessed', () => {
    expect(unitKind(null)).toBeNull();
    expect(unitKind(undefined)).toBeNull();
    expect(unitKind('  ')).toBeNull();
    expect(unitKind('None')).toBeNull();
  });
});

describe('unitMetaFrom', () => {
  const details = (over: Partial<MechunitDetails>): MechunitDetails => ({
    name: 'ROB_1', type: 'TCPRobot', axes: 6, axesTotal: 6, task: 'T_ROB1', mode: 'Activated', status: 'Synchronized',
    coordSystem: 'World', tool: 'tool0', wobj: 'wobj0', isIntegratedUnit: null, hasIntegratedUnit: null, raw: {}, ...over,
  });

  it('keeps the kind, reported type, driving task and axis count (values as a VC reports them)', () => {
    expect(unitMetaFrom(details({}))).toEqual({ kind: 'robot', typeRaw: 'TCPRobot', task: 'T_ROB1', axisCount: 6 });
  });

  it('counts the larger of axes / axes-total, and null when neither is reported', () => {
    expect(unitMetaFrom(details({ axes: 6, axesTotal: 7 })).axisCount).toBe(7);
    expect(unitMetaFrom(details({ axes: null, axesTotal: 7 })).axisCount).toBe(7);
    expect(unitMetaFrom(details({ axes: null, axesTotal: null })).axisCount).toBeNull();
  });
});

describe('motionJoints with the axis configuration (MOC)', () => {
  const six = [1, 2, 3, 4, 5, 6].map(n => axis(n, 'deg', -63, 136));

  it('a 6-axis robot on RW 7.21: J1..J6 from their slots with unit and limits, and none of the unused eax slots that read 0', () => {
    const j = motionJoints(jt([0, -10, 20, 0, 30.0000019073486, 0], [0, 0, 0, 0, 0, 0]), robot6, six);
    expect(j.map(x => x.name)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6']);
    expect(j[4]).toEqual({ name: 'J5', value: 30.0000019073486, unit: 'deg', min: -63, max: 136 });
  });

  it('a SCARA: its sliding J3 is in mm, as the configuration says - never labelled degrees by unit type', () => {
    const scara = [axis(1), axis(2), axis(3, 'mm', 0, 200), axis(4)];
    const j = motionJoints(jt([10, 20, 125.5, 30, 0, 0], [0, 0, 0, 0, 0, 0]), { kind: 'robot', axisCount: 4 }, scara);
    expect(j.map(x => `${x.name}:${x.unit}`)).toEqual(['J1:deg', 'J2:deg', 'J3:mm', 'J4:deg']);
    expect(j[2]).toEqual({ name: 'J3', value: 125.5, unit: 'mm', min: 0, max: 200 });
  });

  it('a 4-axis palletizer (axes 1, 2, 3 and 6): its placeholder rax_4/rax_5 zeros are not reported', () => {
    const pal = [axis(1), axis(2), axis(3), axis(6)];
    const j = motionJoints(jt([10, 20, 30, 0, 0, 45], [0, 0, 0, 0, 0, 0]), { kind: 'robot', axisCount: 4 }, pal);
    expect(j.map(x => x.name)).toEqual(['J1', 'J2', 'J3', 'J6']);
    expect(j[3].value).toBe(45);
  });

  it("a robot's seventh axis is the eax slot its logical axis names (8 -> eax_b), not the first slot with a value", () => {
    const j = motionJoints(jt([1, 2, 3, 4, 5, 6], [0, 1250.5, 0, 0, 0, 0]), { kind: 'robot', axisCount: 7 }, [...six, axis(8, 'mm', 0, 3000)]);
    expect(j.map(x => x.name)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'E2']);
    expect(j[6]).toEqual({ name: 'E2', value: 1250.5, unit: 'mm', min: 0, max: 3000 });
  });

  it('a positioner whose rax slots read 0 on RW7: E1/E2 from the configured eax slots, no J1=0 lie', () => {
    const j = motionJoints(jt([0, 0, 0, 0, 0, 0], [45, -90, 0, 0, 0, 0]), { kind: 'positioner', axisCount: 2 }, [axis(7), axis(8)]);
    expect(j).toEqual([
      { name: 'E1', value: 45, unit: 'deg', min: -180, max: 180 },
      { name: 'E2', value: -90, unit: 'deg', min: -180, max: 180 },
    ]);
  });

  it('a configured slot that carries the 9E9 marker gives value null, never the marker', () => {
    const j = motionJoints(jt([1, 2, 3, 4, 5, 6], [X, 8999999488, X, X, X, X]), robot6, [...six, axis(7), axis(8)]);
    expect(j.slice(6)).toEqual([
      { name: 'E1', value: null, unit: 'deg', min: -180, max: 180 },
      { name: 'E2', value: null, unit: 'deg', min: -180, max: 180 },
    ]);
  });

  it('a logical axis the jointtarget has no slot for is skipped; the rest come in slot order', () => {
    const j = motionJoints(jt([1, 2, 3, 4, 5, 6], [X, X, X, X, X, X]), robot6, [axis(13), axis(2), axis(1)]);
    expect(j.map(x => x.name)).toEqual(['J1', 'J2']);
  });

  it('an unknown unit or unreadable bound stays null in the output', () => {
    const j = motionJoints(jt([1, 2, 3, 4, 5, 6], [X, X, X, X, X, X]), robot6, [axis(1, null, null, null)]);
    expect(j).toEqual([{ name: 'J1', value: 1, unit: null, min: null, max: null }]);
  });
});

describe('motionJoints before the axis configuration is known', () => {
  it('a 6-axis robot: J1..J6 from rax_1..6 with unit and limits null - never a guessed "deg"', () => {
    const j = motionJoints(jt([0, -10, 20, 0, 30, 0], [0, 0, 0, 0, 0, 0]), robot6, null);
    expect(j.map(x => x.name)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6']);
    expect(j.every(x => x.unit === null && x.min === null && x.max === null)).toBe(true);
  });

  it('never reports a 9E9 placeholder, however it is spelled', () => {
    const j = motionJoints(jt([1, 2, 3, 4, 5, 8999999488], [X, 8999999488, X, X, X, X]), { kind: 'robot', axisCount: 8 }, null);
    expect(j.map(x => x.name)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5']);
    expect(j.every(x => x.value !== null && Math.abs(x.value) < 1e9)).toBe(true);
  });

  it('no external axis at all: which eax slot is real cannot be told from the values (an unused one may read 0)', () => {
    expect(motionJoints(jt([1, 2, 3, 4, 5, 6], [5, 0, 0, 0, 0, 0]), { kind: 'robot', axisCount: 7 }, null).map(x => x.name))
      .toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6']);
    expect(motionJoints(jt([1, 2, 3, 4, 5, 6], [5, 0, 0, 0, 0, 0]), { kind: 'robot', axisCount: null }, null).map(x => x.name))
      .toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6']);
  });

  it('a robot with fewer than six axes, a positioner, or a unit of unknown kind: no joints rather than slots picked by count', () => {
    expect(motionJoints(jt([10, 20, 30, 0, 0, 45], [0, 0, 0, 0, 0, 0]), { kind: 'robot', axisCount: 4 }, null)).toEqual([]);
    expect(motionJoints(jt([0, 0, 0, 0, 0, 0], [45, -90, 0, 0, 0, 0]), { kind: 'positioner', axisCount: 2 }, null)).toEqual([]);
    expect(motionJoints(jt([X, X, X, X, X, X], [45, -90, X, X, X, X]), { kind: 'positioner', axisCount: 2 }, null)).toEqual([]);
    expect(motionJoints(jt([1, 2, 3, 4, 5, 6], [X, X, X, X, X, X]), { kind: 'external', axisCount: 1 }, null)).toEqual([]);
    expect(motionJoints(jt([1, 2, 3, 4, 5, 6], [X, X, X, X, X, X]), null, null)).toEqual([]);
  });
});

describe('readAxisConfig (the walk of the motion configuration)', () => {
  it('a six-axis robot: six logical axes in degrees with the ARM bounds converted from radians, in ~20 reads', async () => {
    const reads: string[] = [];
    const axes = await readAxisConfig('ROB_1', cfgOf(sixAxisRobot(), reads));
    expect(axes.map(a => a.logicalAxis)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(axes[1]).toEqual({ logicalAxis: 2, unit: 'deg', min: -63, max: 136 });   // IRB1600 axis 2: -1.0996..2.3736 rad
    expect(reads).toHaveLength(20);
    expect(reads.slice(0, 3)).toEqual(['MECHANICAL_UNIT/ROB_1', 'ROBOT/ROB_1', 'JOINT/rob1_1']);
  });

  it('a sliding axis is in mm with bounds converted from metres', async () => {
    const moc = sixAxisRobot({
      'TRANSMISSION/rob1_3': { rotating_move: 'FALSE' },
      'ARM/rob1_3': { lower_joint_bound: '0', upper_joint_bound: '0.2' },
    });
    const axes = await readAxisConfig('ROB_1', cfgOf(moc));
    expect(axes[2]).toEqual({ logicalAxis: 3, unit: 'mm', min: 0, max: 200 });
  });

  it('external axes hang off use_single_N -> SINGLE.use_joint, and come sorted by logical axis', async () => {
    const moc = sixAxisRobot({
      'MECHANICAL_UNIT/ROB_1': { name: 'ROB_1', use_robot: 'ROB_1', use_single_0: 'TRACK' },
      'SINGLE/TRACK': { use_joint: 'track_1' },
      'JOINT/track_1': { logical_axis: '7', use_arm: 'track_1', use_transmission: 'track_1' },
      'TRANSMISSION/track_1': { rotating_move: 'FALSE' },
      'ARM/track_1': { lower_joint_bound: '0', upper_joint_bound: '3' },
    });
    const axes = await readAxisConfig('ROB_1', cfgOf(moc));
    expect(axes.map(a => a.logicalAxis)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(axes[6]).toEqual({ logicalAxis: 7, unit: 'mm', min: 0, max: 3000 });
  });

  it('rotating vs sliding unknown: unit null and the bounds null too (an SI bound cannot be converted blind)', async () => {
    const reads: string[] = [];
    const moc = sixAxisRobot({ 'TRANSMISSION/rob1_2': {}, 'JOINT/rob1_4': { logical_axis: '4', use_arm: 'rob1_4' } });
    const axes = await readAxisConfig('ROB_1', cfgOf(moc, reads));
    expect(axes[1]).toEqual({ logicalAxis: 2, unit: null, min: null, max: null });
    expect(axes[3]).toEqual({ logicalAxis: 4, unit: null, min: null, max: null });
    expect(reads).not.toContain('ARM/rob1_2');   // not read when it could not be converted
  });

  it('an unreadable bound is null while the unit stays', async () => {
    const moc = sixAxisRobot({ 'ARM/rob1_5': { lower_joint_bound: 'n/a', upper_joint_bound: '' } });
    const axes = await readAxisConfig('ROB_1', cfgOf(moc));
    expect(axes[4]).toEqual({ logicalAxis: 5, unit: 'deg', min: null, max: null });
  });

  it('a joint without a logical axis, or repeating one, is skipped', async () => {
    const moc = sixAxisRobot({ 'JOINT/rob1_3': { use_arm: 'rob1_3' }, 'JOINT/rob1_4': { logical_axis: '2', use_arm: 'rob1_4' } });
    const axes = await readAxisConfig('ROB_1', cfgOf(moc));
    expect(axes.map(a => a.logicalAxis)).toEqual([1, 2, 5, 6]);
  });

  it('an unknown unit (empty instance, as RWS 1.0 answers) or a walk that names no joint throws - never "no axes"', async () => {
    await expect(readAxisConfig('ROB_9', cfgOf(sixAxisRobot()))).rejects.toThrow(/no such instance/);
    const noJoints = sixAxisRobot({ 'ROBOT/ROB_1': { name: 'ROB_1' } });
    await expect(readAxisConfig('ROB_1', cfgOf(noJoints))).rejects.toThrow(/names no joint/);
  });

  it('a read error propagates, so the caller retries the whole walk', async () => {
    const get = async (type: string, instance: string) => {
      if (type === 'ARM') { throw new Error('503 busy'); }
      return sixAxisRobot()[`${type}/${instance}`] ?? {};
    };
    await expect(readAxisConfig('ROB_1', get)).rejects.toThrow('503 busy');
  });
});

describe('axisConfigRetryMs', () => {
  it('backs off 5, 10, 20, 40, then 60 s', () => {
    expect([1, 2, 3, 4, 5, 9].map(axisConfigRetryMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });
});

describe('poseFrom', () => {
  it('position in mm and the quaternion; tool, wobj and frame not claimed', () => {
    const p = poseFrom({ x: 806.2917, y: 0, z: 1015, q1: 0.5, q2: 0, q3: 0.866, q4: 0, j1: 0, j4: 0, j6: 0, jx: 0 });
    expect(p).toEqual({ x: 806.2917, y: 0, z: 1015, q: [0.5, 0, 0.866, 0], tool: null, wobj: null, coord: null });
  });
});

describe('motionTargetHz', () => {
  it('8 Hz on a live link, 2 Hz while the manager itself is polling', () => {
    expect(motionTargetHz('live')).toBe(8);
    expect(motionTargetHz('polling')).toBe(2);
  });
});

describe('measuredHz', () => {
  const at = (hz: number, fromMs: number, toMs: number) => {
    const out: number[] = [];
    for (let t = fromMs; t <= toMs; t += 1000 / hz) { out.push(t); }
    return out;
  };

  it('is null when not sampling, and for the first second', () => {
    expect(measuredHz([1, 2, 3], 10_000, null)).toBeNull();
    expect(measuredHz([10_100, 10_200], 10_500, 10_000)).toBeNull();
  });

  it('counts the rounds of the last 5 s', () => {
    expect(measuredHz(at(8, 125, 20_000), 20_000, 0)).toBe(8);
    expect(measuredHz(at(2, 500, 20_000), 20_000, 0)).toBe(2);
  });

  it('over the part of the window the sampler has been running', () => {
    expect(measuredHz(at(8, 10_125, 12_000), 12_000, 10_000)).toBe(8);
  });

  it('falls when the reads stall', () => {
    expect(measuredHz(at(8, 125, 17_500), 20_000, 0)).toBe(4);   // 20 rounds in the last 5 s
  });
});

describe('motionGroup', () => {
  const NOW = Date.parse('2026-09-25T12:00:00Z');
  const unit = {
    name: 'ROB_1', kind: 'robot' as const, typeRaw: 'TCPRobot', task: 'T_ROB1',
    joints: [{ name: 'J1', value: 10, unit: 'deg' as const, min: null, max: null }], pose: null, error: null,
  };
  const samples = Array.from({ length: 40 }, (_, i) => NOW - 4_875 + i * 125);
  const view = (over: Partial<MotionView> = {}): MotionView => ({
    leaseUntil: NOW + MOTION_LEASE_MS, units: [unit], asOf: NOW - 100, samples, sampledSince: NOW - 60_000, ...over,
  });
  const live = { quality: 'live' as const, connected: true };

  it('is idle and empty for a controller nobody has watched', () => {
    expect(motionGroup(null, live, true, NOW)).toEqual({
      watching: false, units: [], rate: { targetHz: null, achievedHz: null, via: null }, asOf: null,
    });
  });

  it('while watched: the units, the target and measured rate, and when the joints were read', () => {
    expect(motionGroup(view(), live, true, NOW)).toEqual({
      watching: true, units: [unit], rate: { targetHz: 8, achievedHz: 8, via: 'poll' }, asOf: '2026-09-25T11:59:59.900Z',
    });
  });

  it('targets 2 Hz while the link is polling', () => {
    expect(motionGroup(view(), { quality: 'polling', connected: true }, true, NOW).rate.targetHz).toBe(2);
  });

  it('a lapsed lease: not watching, the last values kept with asOf frozen', () => {
    const g = motionGroup(view({ leaseUntil: NOW - 1, sampledSince: null }), live, true, NOW);
    expect(g.watching).toBe(false);
    expect(g.units).toEqual([unit]);
    expect(g.rate).toEqual({ targetHz: null, achievedHz: null, via: null });
    expect(g.asOf).toBe('2026-09-25T11:59:59.900Z');
  });

  it('a degraded link: still watched, but no measured rate', () => {
    const g = motionGroup(view(), { quality: 'stale', connected: true }, true, NOW);
    expect(g.watching).toBe(true);
    expect(g.rate.achievedHz).toBeNull();
    expect(g.asOf).toBe('2026-09-25T11:59:59.900Z');
  });

  it('carries nothing from a link on the wrong controller', () => {
    expect(motionGroup(view(), live, false, NOW)).toEqual({
      watching: false, units: [], rate: { targetHz: null, achievedHz: null, via: null }, asOf: null,
    });
  });
});

describe('motionSignature', () => {
  const g = (achievedHz: number | null, asOf: string | null) => ({
    watching: true, units: [], rate: { targetHz: 8, achievedHz, via: 'poll' as const }, asOf,
  });
  it('ignores asOf and the tenths of the measured rate', () => {
    expect(motionSignature(g(7.9, 'a'))).toBe(motionSignature(g(8.1, 'b')));
    expect(motionSignature(g(8, 'a'))).not.toBe(motionSignature(g(6, 'a')));
  });
});

import { isJointValuePresent, type CartesianFull, type JointTargetFull, type MechunitDetails } from 'abb-rws-client';
import type { LinkQuality, MotionGroup, MotionJoint, MotionPose, MotionUnitInfo } from './schema/v0.js';

/**
 * Motion: the pure half - what the sampler's reads become in the
 * snapshot. The sampler itself lives in the fleet (`ControllerFleet`).
 */

/** A watch lease lasts this long; a consumer renews it at least every half. */
export const MOTION_LEASE_MS = 15_000;
/** Joint reads per second per controller while the link is `live`. */
export const MOTION_HZ = 8;
/**
 * ...and while it is `polling`: the manager's own polls then use ~12 req/s of
 * the controller's <20 req/s (measured on virtual controllers), so the
 * sampler steps back.
 */
export const MOTION_HZ_POLLING = 2;
/** The pose is read on every this-many-th joint tick (a quarter of the joint rate). */
export const POSE_EVERY_TICKS = 4;
/** `achievedHz` is measured over this window. */
export const RATE_WINDOW_MS = 5_000;
/** A failed unit-description read is retried after this long. */
export const UNIT_INFO_RETRY_MS = 5_000;
/** A failed axis-configuration walk (~20 reads) is retried after 5, 10, 20, 40, then every 60 s. */
export function axisConfigRetryMs(failures: number): number {
  return Math.min(60_000, UNIT_INFO_RETRY_MS * 2 ** Math.max(0, failures - 1));
}

/** The joint rate the sampler aims for on a link of this quality. */
export function motionTargetHz(quality: LinkQuality | undefined): number {
  return quality === 'polling' ? MOTION_HZ_POLLING : MOTION_HZ;
}

/**
 * A unit's kind from its reported type. Only `TCPRobot` has been observed on
 * the controllers tested; the positioner spellings are ABB's type names,
 * matched loosely.
 * A type that is missing or says "none" is unknown, not guessed.
 */
export function unitKind(type: string | null | undefined): MotionUnitInfo['kind'] {
  const t = type?.trim();
  if (!t || /^(none|unknown|undefined)$/i.test(t)) { return null; }
  if (/^tcp[ _-]?robot$/i.test(t)) { return 'robot'; }
  if (/positioner/i.test(t)) { return 'positioner'; }
  return 'external';
}

/** What the fleet keeps of a unit's own description, read once per connection. */
export interface UnitMeta {
  kind: MotionUnitInfo['kind'];
  typeRaw: string | null;
  task: string | null;
  /** How many axis slots the unit uses (the larger of `axes` / `axes-total`); null when not reported. */
  axisCount: number | null;
}

export function unitMetaFrom(d: MechunitDetails): UnitMeta {
  const counts = [d.axes, d.axesTotal].filter((n): n is number => typeof n === 'number');
  return {
    kind: unitKind(d.type),
    typeRaw: d.type,
    task: d.task,
    axisCount: counts.length > 0 ? Math.max(...counts) : null,
  };
}

/**
 * One axis of a mechanical unit as the motion configuration (MOC) describes
 * it - read once per connection by `readAxisConfig`.
 */
export interface AxisConfig {
  /** `MOC/JOINT.logical_axis`: 1..6 are the `rax_1..6` slots of a jointtarget, 7..12 the `eax_a..f` slots. */
  logicalAxis: number;
  /** From `MOC/TRANSMISSION.rotating_move`: true -> 'deg', false -> 'mm'; null when it could not be read. */
  unit: 'deg' | 'mm' | null;
  /** `MOC/ARM.lower/upper_joint_bound`, converted from SI to `unit`; null when unreadable or the unit is unknown. */
  min: number | null;
  max: number | null;
}

/** Reads one MOC instance: `(type, instance) -> attributes` (`RobotManager.getCfgInstance('MOC', type, instance)`). */
export type CfgRead = (type: string, instance: string) => Promise<Record<string, string>>;

const cfgString = (o: Record<string, string> | null | undefined, key: string): string | null => {
  const v = o?.[key]?.trim();
  return v ? v : null;
};
const cfgNumber = (o: Record<string, string>, key: string): number | null => {
  const v = cfgString(o, key);
  if (v === null) { return null; }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const cfgBool = (o: Record<string, string>, key: string): boolean | null => {
  const v = cfgString(o, key);
  if (v === null) { return null; }
  if (/^(true|yes|1)$/i.test(v)) { return true; }
  if (/^(false|no|0)$/i.test(v)) { return false; }
  return null;
};
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** An SI joint bound (the configuration stores radians or metres) in the unit RWS reports positions in. */
function boundIn(unit: 'deg' | 'mm', si: number | null): number | null {
  if (si === null) { return null; }
  return round3(unit === 'deg' ? (si * 180) / Math.PI : si * 1000);
}

/**
 * A unit's axes from the motion configuration - which logical axis each joint
 * is, whether it rotates or slides, and its bounds - by this walk, verified on
 * the RW 6.16 / 7.21 / 8.1.1 virtual controllers (2026-09-25):
 *
 *   MECHANICAL_UNIT/{unit}.use_robot      -> ROBOT/{r}.use_joint_0..5  -> JOINT
 *   MECHANICAL_UNIT/{unit}.use_single_0..5 -> SINGLE/{s}.use_joint      -> JOINT
 *   JOINT/{j}: logical_axis, use_transmission -> TRANSMISSION/{t}.rotating_move,
 *              use_arm -> ARM/{a}.lower_joint_bound / upper_joint_bound (SI)
 *
 * Instance names are followed, never assumed. A joint whose logical axis is
 * missing is skipped (it cannot be placed in a jointtarget). Rotating vs
 * sliding is `TRANSMISSION.rotating_move` (ABB's documented parameter; none
 * of the virtual controllers tested has a sliding axis): when it is missing or
 * unparseable the unit stays null, and with it the bounds - an SI bound cannot
 * be converted without knowing rad from m. No VC here has a SINGLE either, so
 * that branch follows ABB's documented parameter names unverified. ~20 reads
 * for a six-axis robot.
 * Throws the first read error, and when the walk names no joint at all (an
 * unknown instance reads as empty on RWS 1.0), so the caller retries the whole
 * walk rather than treating "no axes" as an answer.
 */
export async function readAxisConfig(unit: string, get: CfgRead): Promise<AxisConfig[]> {
  const mu = await get('MECHANICAL_UNIT', unit);
  if (Object.keys(mu ?? {}).length === 0) { throw new Error(`MOC/MECHANICAL_UNIT/${unit}: no such instance, or no attributes read`); }
  const jointNames: string[] = [];
  const robot = cfgString(mu, 'use_robot');
  if (robot) {
    const r = await get('ROBOT', robot);
    for (let i = 0; i < 6; i++) {
      const j = cfgString(r, `use_joint_${i}`);
      if (j) { jointNames.push(j); }
    }
  }
  for (let i = 0; i < 6; i++) {
    const s = cfgString(mu, `use_single_${i}`);
    if (!s) { continue; }
    const j = cfgString(await get('SINGLE', s), 'use_joint');
    if (j) { jointNames.push(j); }
  }
  const seen = new Set<number>();
  const axes: AxisConfig[] = [];
  for (const name of jointNames) {
    const joint = await get('JOINT', name);
    const logicalAxis = cfgNumber(joint, 'logical_axis');
    if (logicalAxis === null || !Number.isInteger(logicalAxis) || seen.has(logicalAxis)) { continue; }
    seen.add(logicalAxis);
    let unitOf: AxisConfig['unit'] = null;
    const transmission = cfgString(joint, 'use_transmission');
    if (transmission) {
      const rotating = cfgBool(await get('TRANSMISSION', transmission), 'rotating_move');
      unitOf = rotating === null ? null : rotating ? 'deg' : 'mm';
    }
    let min: number | null = null;
    let max: number | null = null;
    const arm = cfgString(joint, 'use_arm');
    if (arm && unitOf) {
      const a = await get('ARM', arm);
      min = boundIn(unitOf, cfgNumber(a, 'lower_joint_bound'));
      max = boundIn(unitOf, cfgNumber(a, 'upper_joint_bound'));
    }
    axes.push({ logicalAxis, unit: unitOf, min, max });
  }
  if (axes.length === 0) { throw new Error(`MOC/MECHANICAL_UNIT/${unit}: the configuration names no joint with a logical axis`); }
  return axes.sort((a, b) => a.logicalAxis - b.logicalAxis);
}

/** The jointtarget slot a logical axis lands in, named as the contract names it. */
function slotOf(t: JointTargetFull, logicalAxis: number): { name: string; value: number | undefined } | null {
  if (logicalAxis >= 1 && logicalAxis <= 6) { return { name: `J${logicalAxis}`, value: t.rax[logicalAxis - 1] }; }
  if (logicalAxis >= 7 && logicalAxis <= 12) { return { name: `E${logicalAxis - 6}`, value: t.eax[logicalAxis - 7] }; }
  return null;
}

/**
 * The joints a unit actually has, from its full jointtarget (`rax_1..6` ->
 * J1..J6, `eax_a..f` -> E1..E6).
 *
 * Which slots are real can NOT be told from the values: the 9E9 "not present"
 * marker is not guaranteed (on RW 7.21 the unused `eax_*` read 0),
 * so an unused slot may look like an axis parked at zero. The mapping comes
 * from the motion configuration instead (`axes`, see `readAxisConfig`): each
 * configured logical axis is reported from its slot, with the unit and bounds
 * the configuration gives - a slot that still carries the marker gives value
 * null, never a number.
 *
 * Until the configuration has been read (or when it cannot be), only a TCP
 * robot with six or more axes is reported, and only its `rax_1..6` slots that
 * carry a value, with unit and limits null: those six slots are its own axes
 * on every observed controller. Anything else - a positioner, a single
 * external unit, a robot with fewer than six axes, a unit of unknown type -
 * reports no joints rather than a slot picked by count (a placeholder 0 shown
 * as a position would be a lie).
 */
export function motionJoints(
  t: JointTargetFull,
  meta: Pick<UnitMeta, 'kind' | 'axisCount'> | null,
  axes: readonly AxisConfig[] | null,
): MotionJoint[] {
  const present = (v: number | undefined): v is number => typeof v === 'number' && isJointValuePresent(v);
  if (axes !== null) {
    const out: MotionJoint[] = [];
    for (const a of [...axes].sort((x, y) => x.logicalAxis - y.logicalAxis)) {
      const s = slotOf(t, a.logicalAxis);
      if (!s) { continue; }
      out.push({ name: s.name, value: present(s.value) ? s.value : null, unit: a.unit, min: a.min, max: a.max });
    }
    return out;
  }
  const kind = meta?.kind ?? null;
  const n = meta?.axisCount ?? null;
  if (kind !== 'robot' || (n !== null && n < 6)) { return []; }
  return t.rax
    .map((value, i) => ({ name: `J${i + 1}`, value }))
    .filter(s => present(s.value))
    .map(s => ({ name: s.name, value: s.value, unit: null, min: null, max: null }));
}

/**
 * The TCP pose from `/cartesian`: position in mm, orientation quaternion.
 * tool, wobj and coord are null: `/cartesian` is read without parameters, and
 * which tool, work object and frame the controller then uses is not verified
 * (the unit's `coord-system` is its jog frame, not necessarily this one).
 */
export function poseFrom(c: CartesianFull): MotionPose {
  return { x: c.x, y: c.y, z: c.z, q: [c.q1, c.q2, c.q3, c.q4], tool: null, wobj: null, coord: null };
}

/**
 * Samples per second over the last `windowMs`: the successful joint rounds
 * completed in that window, over the part of it the sampler has been running.
 * null when not sampling, or for the first second (too early to say).
 */
export function measuredHz(samples: readonly number[], now: number, since: number | null, windowMs = RATE_WINDOW_MS): number | null {
  if (since === null) { return null; }
  const from = Math.max(since, now - windowMs);
  const span = now - from;
  if (span < 1_000) { return null; }
  const n = samples.filter(t => t > from && t <= now).length;
  return Math.round((n / (span / 1_000)) * 10) / 10;
}

/** What the fleet holds per watched controller - all a snapshot needs. */
export interface MotionView {
  /** The watch lease runs until this time (ms); 0 when never watched. */
  leaseUntil: number;
  units: MotionUnitInfo[];
  /** When a joint read last succeeded (ms). */
  asOf: number | null;
  /** When each successful joint round completed (ms), newest last. */
  samples: readonly number[];
  /** When the current sampling run began (ms); null while not sampling. */
  sampledSince: number | null;
}

const isHealthy = (q: LinkQuality | undefined) => q === 'live' || q === 'polling';

/**
 * The motion group. `watching`: a consumer holds a lease. Values survive the
 * end of a lease or a degraded link, with `asOf` frozen at the last read. A
 * link on the WRONG controller carries none of it (as for panel and RAPID).
 */
export function motionGroup(
  m: MotionView | null,
  link: { quality: LinkQuality | undefined; connected: boolean },
  trusted: boolean,
  now: number,
): MotionGroup {
  if (!trusted) {
    return { watching: false, units: [], rate: { targetHz: null, achievedHz: null, via: null }, asOf: null };
  }
  const watching = m !== null && m.leaseUntil > now;
  const sampling = watching && link.connected && isHealthy(link.quality);
  return {
    watching,
    units: m ? [...m.units] : [],
    rate: {
      targetHz: watching ? motionTargetHz(link.quality) : null,
      achievedHz: sampling ? measuredHz(m!.samples, now, m!.sampledSince) : null,
      via: watching ? 'poll' : null,
    },
    asOf: m?.asOf != null ? new Date(m.asOf).toISOString() : null,
  };
}

/**
 * What counts as a motion change worth announcing: everything but `asOf`, with
 * the measured rate to the whole hertz (its tenths wobble on every read).
 */
export function motionSignature(g: MotionGroup): string {
  const { asOf: _asOf, ...rest } = g;
  const hz = rest.rate.achievedHz;
  return JSON.stringify({ ...rest, rate: { ...rest.rate, achievedHz: hz === null ? null : Math.round(hz) } });
}

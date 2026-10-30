import { afterEach, describe, expect, it, vi } from 'vitest';
import { RwsError } from 'abb-rws-client';
import Fastify from 'fastify';
import { NO_GENERATION, NO_WRITE_ACCESS_READER } from '../src/access.js';
import type { ControllerConfig } from '../src/config.js';
import type { ControllerFleet, Log } from '../src/fleet.js';
import type { ClientTapSink } from '../src/recording/contract.js';
import { registerControllerRoutes } from '../src/routes.js';
import { ACCESS_READ_MS, ACCESS_READ_SLOW_MS, SCHEMA_VERSION, type AccessLockInfo, type ControllerSnapshot } from '../src/schema/v0.js';
import { SnapshotStream } from '../src/stream.js';
import { SocketHub } from '../src/wsHub.js';
import { ID, T0, cfg, fleetOver, world, type FakeGeneration, type World, type WorldOptions } from './helpers/fake-fleet.js';

// The access reader, through the real fleet over a faked client: which status
// reads go out, when, and what they leave in the snapshot. No controller here.

/** Ids planted in the fake answers; they may reach neither the snapshot, a frame nor a log line. */
const PLANTED_UID = '{0B7C3A52-6D1E-4F0A-9C55-2E81D4F7A901}';
const PLANTED_STATION = '{C4D2E8F1-77AB-4B0E-8E3A-5A1F9D20B6C3}';

/** The reader's tick in these tests (ms). */
const TICK = 100;
/** One status read takes this long in the fake world (ms). */
const READ_MS = 5;
/** The budget of the one test that starts a Fastify app on real time (ms). */
const ROUTES_TEST_MS = 30_000;

let fleets: ControllerFleet[] = [];
afterEach(() => {
  for (const f of fleets) { f.stopAccessReader(); f.stopPointerPoller(); f.stopMotionSampler(); f.stopIoPoller(); f.stopEventReader(); f.stopSupervisor(); }
  fleets = [];
  vi.useRealTimers();
});

/** A log sink that keeps every line, as text. */
function keptLog(): Log & { lines: string[] } {
  const lines: string[] = [];
  const keep = (level: string) => (obj: object, msg?: string): void => { lines.push(`${level} ${msg ?? ''} ${JSON.stringify(obj)}`); };
  return { lines, debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') };
}

/** A fleet over a fresh world, connected; the reader is not started yet. */
async function connected(opts: WorldOptions, config: ControllerConfig = cfg()) {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const w = world(opts);
  const log = keptLog();
  const f = fleetOver(w, log);
  fleets.push(f);
  f.add(config);
  await vi.advanceTimersByTimeAsync(50);
  return { f, w, log };
}

/** The same with the reader started and its first round landed (when one is sent at all). */
async function reading(opts: WorldOptions, config?: ControllerConfig) {
  const made = await connected(opts, config);
  made.f.startAccessReader(TICK);
  await vi.advanceTimersByTimeAsync(TICK + 50);
  return made;
}

/** The access status reads the daemon sent, in order: `cfg`, `motion`, `rapid` (the mastership domain asked), `rmmp`, `writeaccess`. */
function statusReads(w: World, from = 0): Array<{ read: string; at: number }> {
  const out: Array<{ read: string; at: number }> = [];
  for (const line of w.log.slice(from)) {
    const m = /^manager:(getMastershipStatus|getRmmpPrivilege|getWriteAccessStatus):(.*)@(-?\d+)$/.exec(line);
    if (!m) { continue; }
    const read = m[1] === 'getMastershipStatus' ? (JSON.parse(m[2]) as string[])[0] : m[1] === 'getRmmpPrivilege' ? 'rmmp' : 'writeaccess';
    out.push({ read, at: Number(m[3]) });
  }
  return out;
}

/** The reads grouped into rounds: a round's reads follow each other within a few milliseconds. */
function rounds(w: World, from = 0): Array<{ reads: string[]; at: number }> {
  const out: Array<{ reads: string[]; at: number; last: number }> = [];
  for (const r of statusReads(w, from)) {
    const cur = out.at(-1);
    if (cur && r.at - cur.last <= 2 * READ_MS) { cur.reads.push(r.read); cur.last = r.at; }
    else { out.push({ reads: [r.read], at: r.at, last: r.at }); }
  }
  return out.map(({ reads, at }) => ({ reads, at }));
}

const accessOf = (f: ControllerFleet) => f.get(ID)!.access;
const lockOf = (f: ControllerFleet, lock: AccessLockInfo['lock']) => accessOf(f).locks.find(l => l.lock === lock)!;
const freshOf = (f: ControllerFleet) => f.get(ID)!.freshness.groups.find(g => g.group === 'access')!;
const UNREAD = { held: null, holder: null, reported: null, asOf: null, error: null };

/** Reconnect as the supervisor would: the client's connect, on the fake clock. */
async function reconnect(w: World): Promise<void> {
  const connecting = w.multi.connectRobot(ID);
  await vi.advanceTimersByTimeAsync(10);
  await connecting;
}

describe('access reader: which reads go out, and when', () => {
  const sequences: Array<[FakeGeneration, string[]]> = [
    ['rw6', ['cfg', 'motion', 'rapid', 'rmmp']],
    ['rw7', ['rapid', 'motion', 'rmmp']],   // `rapid` is the domain the client maps to the edit lock
  ];

  it.each(sequences)('%s: one round is exactly these reads, in this order, and the next starts ACCESS_READ_MS after it ended', async (generation, sequence) => {
    const { f, w } = await reading({ generation });
    expect(rounds(w).map(r => r.reads)).toEqual([sequence]);
    await vi.advanceTimersByTimeAsync(3 * ACCESS_READ_MS + 1_000);
    const all = rounds(w);
    expect(all.length).toBe(4);
    for (const r of all) { expect(r.reads).toEqual(sequence); }
    const roundMs = sequence.length * READ_MS;
    for (let i = 1; i < all.length; i++) {
      const gap = all[i].at - all[i - 1].at;
      expect(gap).toBeGreaterThanOrEqual(ACCESS_READ_MS + roundMs);
      expect(gap).toBeLessThan(ACCESS_READ_MS + roundMs + TICK + READ_MS);
    }
    // At most 0.8 requests a second, whatever the generation.
    const span = (all.at(-1)!.at - all[0].at) / 1_000;
    expect((statusReads(w).length - sequence.length) / span).toBeLessThanOrEqual(0.8);
    expect(accessOf(f).via).toBe('poll');
  });

  it('rw6: the snapshot carries the three locks and RMMP, each dated when its own read landed', async () => {
    const { f, w } = await reading({ generation: 'rw6' });
    const [cfgRead, motionRead, rapidRead, rmmpRead] = statusReads(w).map(r => new Date(T0 + r.at + READ_MS).toISOString());
    expect(accessOf(f)).toEqual({
      generation: 'rw6', model: 'mastership',
      locks: [
        { lock: 'cfg', held: false, holder: null, heldByDaemon: false, reported: 'nomaster', asOf: cfgRead, error: null },
        { lock: 'motion', held: false, holder: null, heldByDaemon: false, reported: 'nomaster', asOf: motionRead, error: null },
        { lock: 'rapid', held: false, holder: null, heldByDaemon: false, reported: 'nomaster', asOf: rapidRead, error: null },
      ],
      remoteAccessEnabled: null,
      rmmp: { supported: true, privilege: 'none', asOf: rmmpRead, error: null },
      via: 'poll', problem: null, asOf: cfgRead,
    });
    expect(freshOf(f)).toMatchObject({ state: 'current', reason: null });
    expect(f.get(ID)!.capabilities).toMatchObject({ protocol: 'rws1', generation: 'rw6', robotWare: '6.16.3007', tested: true });
  });

  it('never two requests at a time', async () => {
    for (const opts of [{ generation: 'rw6' }, { generation: 'rw7' }, { generation: 'rw8', writeAccessReader: true }] as WorldOptions[]) {
      const { w } = await reading(opts);
      w.access.ms = 40;   // slow answers: a round now spans more than one tick
      await vi.advanceTimersByTimeAsync(4 * ACCESS_READ_MS);
      expect(statusReads(w).length).toBeGreaterThanOrEqual(4);
      expect(w.access.maxOut).toBe(1);
      vi.useRealTimers();
    }
  });

  it('slower while the link is `polling`: ACCESS_READ_SLOW_MS between rounds', async () => {
    const { f, w } = await reading({ generation: 'rw7' });
    w.quality(ID, 'polling', 'event stream lost; polling');
    // The round already booked still comes on the live cadence; those after it on the slow one.
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + 2 * ACCESS_READ_SLOW_MS + 2_000);
    const all = rounds(w);
    expect(all.length).toBe(4);
    const roundMs = 3 * READ_MS;
    for (const i of [2, 3]) {
      const gap = all[i].at - all[i - 1].at;
      expect(gap).toBeGreaterThanOrEqual(ACCESS_READ_SLOW_MS + roundMs);
      expect(gap).toBeLessThan(ACCESS_READ_SLOW_MS + roundMs + TICK + READ_MS);
    }
    // `polling` is still a usable link: nothing was cleared, the values are current.
    expect(accessOf(f).via).toBe('poll');
    expect(freshOf(f).state).toBe('current');
  });

  it('a mode change reads at once, not at the next booked round, when the last round began ACCESS_READ_MS ago or more', async () => {
    const { f, w } = await reading({ generation: 'rw6' });
    // On a `polling` link the next round is booked ACCESS_READ_SLOW_MS ahead.
    w.quality(ID, 'polling', 'event stream lost; polling');
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + 1_000);
    const before = rounds(w);
    expect(before.length).toBe(2);
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS);   // well inside the slow interval, and past the floor
    expect(rounds(w).length).toBe(2);
    const changedAt = Date.now() - T0;
    w.access.mastership.motion = { mastership: 'nomaster' };
    w.set(ID, { opmode: 'MANR' });
    await vi.advanceTimersByTimeAsync(TICK + 50);
    const all = rounds(w);
    expect(all.length).toBe(3);
    expect(all.at(-1)!.at - changedAt).toBeLessThanOrEqual(TICK);
    expect(all.at(-1)!.reads).toEqual(['cfg', 'motion', 'rapid', 'rmmp']);
    // And the cadence goes on from that round.
    await vi.advanceTimersByTimeAsync(ACCESS_READ_SLOW_MS + TICK);
    expect(rounds(w).length).toBe(4);
    expect(f.get(ID)!.panel.opMode).toBe('MANR');
  });

  it('a mode change right after a round waits for the floor: no second round on the connection within ACCESS_READ_MS of the last one`s start', async () => {
    const { w } = await reading({ generation: 'rw6' });
    await vi.advanceTimersByTimeAsync(1_000);
    const first = rounds(w);
    expect(first.length).toBe(1);
    w.set(ID, { opmode: 'MANR' });
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS - 1_000 - 2 * TICK);
    expect(rounds(w).length).toBe(1);   // brought forward, and held by the floor
    await vi.advanceTimersByTimeAsync(3 * TICK);
    const all = rounds(w);
    expect(all.length).toBe(2);
    const gap = all[1].at - all[0].at;
    expect(gap).toBeGreaterThanOrEqual(ACCESS_READ_MS);
    expect(gap).toBeLessThan(ACCESS_READ_MS + TICK + READ_MS);
  });

  it('a mode that keeps changing is read no more often than a steady one: at most 0.8 requests a second', async () => {
    const { w } = await reading({ generation: 'rw6' });
    for (let i = 0; i < 80; i++) {   // twice a second, for 40 s
      w.set(ID, { opmode: i % 2 === 0 ? 'MANR' : 'AUTO' });
      await vi.advanceTimersByTimeAsync(500);
    }
    const all = rounds(w);
    for (let i = 1; i < all.length; i++) { expect(all[i].at - all[i - 1].at).toBeGreaterThanOrEqual(ACCESS_READ_MS); }
    expect(all.length).toBeGreaterThanOrEqual(8);
    const span = (all.at(-1)!.at - all[0].at) / 1_000;
    expect((statusReads(w).length - 4) / span).toBeLessThanOrEqual(0.8);
  });

  it('a link that keeps going stale and recovering is read no more often than a steady one, and shows nothing it read before a spell', async () => {
    const { f, w } = await reading({ generation: 'rw6' });
    w.access.mastership.cfg = { mastership: 'remote', application: 'RobotStudio' };
    for (let i = 0; i < 20; i++) {   // a second stale, a second live, for 40 s
      w.quality(ID, 'stale', 'poll failed (1/3)');
      await vi.advanceTimersByTimeAsync(1_000);
      w.quality(ID, 'live', 'poll succeeded - connection recovered');
      // Usable again: every part starts unread, whether or not the floor lets a round start now.
      for (const l of accessOf(f).locks) { expect(l).toMatchObject(UNREAD); }
      expect(f.get(ID)!.freshness.level).toBe('current');
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const all = rounds(w);
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < all.length; i++) { expect(all[i].at - all[i - 1].at).toBeGreaterThanOrEqual(ACCESS_READ_MS); }
    const span = (all.at(-1)!.at - all[0].at) / 1_000;
    expect((statusReads(w).length - 4) / span).toBeLessThanOrEqual(0.8);
    expect(w.access.maxOut).toBe(1);
  });

  it('a mode change during a round is followed by one more round as soon as the floor allows, not a whole interval later', async () => {
    const { w } = await reading({ generation: 'rw7' });
    w.quality(ID, 'polling', 'event stream lost; polling');
    w.access.ms = 60;
    const from = w.log.length;
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK);   // the second round is out now, its reads 60 ms each
    expect(statusReads(w, from).map(r => r.read)).toEqual(['rapid']);
    expect(w.access.out).toBe(1);
    const secondAt = statusReads(w, from)[0].at;
    w.set(ID, { opmode: 'MANR' });
    await vi.advanceTimersByTimeAsync(600);
    // The round that was out ran to its end; the one that follows it waits for the floor.
    expect(statusReads(w, from).map(r => r.read)).toEqual(['rapid', 'motion', 'rmmp']);
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS);
    // It may have read before the change, so one more round came ACCESS_READ_MS after it began - not ACCESS_READ_SLOW_MS after it ended.
    const reads = statusReads(w, from);
    expect(reads.map(r => r.read)).toEqual(['rapid', 'motion', 'rmmp', 'rapid', 'motion', 'rmmp']);
    expect(reads[3].at - secondAt).toBeGreaterThanOrEqual(ACCESS_READ_MS);
    expect(reads[3].at - secondAt).toBeLessThan(ACCESS_READ_MS + TICK + READ_MS);
    expect(w.access.maxOut).toBe(1);
    // Then the slow cadence again.
    await vi.advanceTimersByTimeAsync(ACCESS_READ_SLOW_MS - 2_000);
    expect(statusReads(w, from).length).toBe(6);
  });

  it('after a round in which every part failed the status is read again on a backoff: 5, 10, 20 s', async () => {
    const { f, w } = await connected({ generation: 'rw7' });
    w.access.mastership.rapid = null;
    w.access.mastership.motion = { mastership: 'unknown' };
    w.access.rmmp = new RwsError('HTTP 503 - busy', 'CONTROLLER_BUSY');
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(40_000);
    const all = rounds(w);
    expect(all.length).toBe(4);
    const gaps = all.slice(1).map((r, i) => r.at - all[i].at);
    for (const [i, base] of [5_000, 10_000, 20_000].entries()) {
      expect(gaps[i]).toBeGreaterThanOrEqual(base);
      expect(gaps[i]).toBeLessThan(base + 3 * READ_MS + TICK + READ_MS);
    }
    // One part good again: back to the normal cadence.
    w.access.mastership.rapid = { mastership: 'nomaster' };
    await vi.advanceTimersByTimeAsync(40_000 + 2 * ACCESS_READ_MS);
    const later = rounds(w);
    const last = later.at(-1)!.at - later.at(-2)!.at;
    expect(last).toBeLessThan(ACCESS_READ_MS + 3 * READ_MS + TICK + READ_MS);
  });
});

describe('access reader: RobotWare 8', () => {
  it('with a client that reads the status: one read per round, the holder named, the flag served', async () => {
    const { f, w } = await connected({ generation: 'rw8', writeAccessReader: true });
    w.access.writeAccess = { held: true, heldByMe: false, heldById: PLANTED_STATION, heldByName: 'Cell 4 HMI', externalControlEnabled: true };
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(2 * ACCESS_READ_MS + 1_000);
    expect(rounds(w).map(r => r.reads)).toEqual([['writeaccess'], ['writeaccess'], ['writeaccess']]);
    expect(accessOf(f)).toMatchObject({
      generation: 'rw8', model: 'writeaccess', remoteAccessEnabled: true, via: 'poll', problem: null,
      rmmp: { supported: false, privilege: null, asOf: null, error: null },
    });
    expect(lockOf(f, 'writeaccess')).toMatchObject({
      held: true, holder: { kind: 'station', name: 'Cell 4 HMI', application: null, flexPendant: false }, heldByDaemon: false, reported: null,
      error: null,
    });
    expect(freshOf(f).state).toBe('current');
    expect(f.get(ID)!.capabilities.entries.find(e => e.id === 'write-access')).toEqual({ id: 'write-access', state: 'available', reason: null });
    expect(JSON.stringify(f.get(ID))).not.toContain(PLANTED_STATION);
  });

  it('an answer whose `held` is no boolean is a failed read: the lock keeps its last value and time, nothing becomes false', async () => {
    const { f, w } = await reading({ generation: 'rw8', writeAccessReader: true });
    const good = lockOf(f, 'writeaccess');
    expect(good).toMatchObject({ held: false, error: null });
    for (const odd of [{}, { held: 'true', externalControlEnabled: 'true' }, { held: null, externalControlEnabled: null }]) {
      w.access.writeAccess = odd;
      await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK + 50);
      expect(lockOf(f, 'writeaccess')).toEqual({ ...good, error: { code: 'PARSE_ERROR', message: 'the write-access status was not understood' } });
      expect(accessOf(f).remoteAccessEnabled).toBe(true);
      expect(freshOf(f).state).toBe('stale');
    }
  });

  it('a first answer that is not understood leaves the lock unread with an error: held null, never false', async () => {
    const { f, w } = await connected({ generation: 'rw8', writeAccessReader: true });
    w.access.writeAccess = { heldByName: 'Cell 4 HMI' };
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(TICK + 50);
    expect(lockOf(f, 'writeaccess')).toMatchObject({ held: null, holder: null, asOf: null, error: { code: 'PARSE_ERROR' } });
    expect(accessOf(f).remoteAccessEnabled).toBeNull();
    expect(f.get(ID)!.capabilities.entries.find(e => e.id === 'write-access')).toMatchObject({ state: 'degraded' });
  });

  it('with a client that lacks the read: nothing is sent, and the group says why', async () => {
    const { f, w } = await reading({ generation: 'rw8' });
    await vi.advanceTimersByTimeAsync(3 * ACCESS_READ_MS);
    expect(statusReads(w)).toEqual([]);
    expect(accessOf(f)).toEqual({
      generation: 'rw8', model: 'writeaccess',
      locks: [{ lock: 'writeaccess', held: null, holder: null, heldByDaemon: false, reported: null, asOf: null, error: null }],
      remoteAccessEnabled: null, rmmp: { supported: false, privilege: null, asOf: null, error: null },
      via: null, problem: NO_WRITE_ACCESS_READER, asOf: null,
    });
    expect(freshOf(f)).toMatchObject({ state: 'unavailable', reason: NO_WRITE_ACCESS_READER });
    expect(f.get(ID)!.freshness.level).toBe('current');
    expect(f.get(ID)!.capabilities.entries.find(e => e.id === 'write-access')).toEqual({ id: 'write-access', state: 'unavailable', reason: NO_WRITE_ACCESS_READER });
  });
});

describe('access reader: the FlexPendant as holder, by either name', () => {
  // How the virtual controllers named it (RobotWare 7.21.4 and 8.2.1): the application TPU, the station FlexPendant.
  it('RobotWare 7: the edit lock held by the application TPU is served with flexPendant true', async () => {
    const { f, w } = await connected({ generation: 'rw7' });
    w.access.mastership.rapid = { mastership: 'local', uid: PLANTED_UID, application: 'TPU' };
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(TICK + 50);
    expect(lockOf(f, 'edit')).toMatchObject({
      held: true, holder: { kind: 'local', name: null, application: 'TPU', flexPendant: true }, reported: 'local', error: null,
    });
    expect(lockOf(f, 'motion').holder).toBeNull();
    expect(JSON.stringify(f.get(ID))).not.toContain(PLANTED_UID);
  });

  it('RobotWare 8: write access held by the station FlexPendant is served with flexPendant true', async () => {
    const { f, w } = await connected({ generation: 'rw8', writeAccessReader: true });
    w.access.writeAccess = { held: true, heldByMe: false, heldById: PLANTED_STATION, heldByName: 'FlexPendant', externalControlEnabled: false };
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(TICK + 50);
    expect(lockOf(f, 'writeaccess')).toMatchObject({
      held: true, holder: { kind: 'station', name: 'FlexPendant', application: null, flexPendant: true }, error: null,
    });
    expect(accessOf(f).remoteAccessEnabled).toBe(false);
    expect(JSON.stringify(f.get(ID))).not.toContain(PLANTED_STATION);
  });
});

describe('access reader: when nothing is read', () => {
  it('no request while the generation is unknown: the fake world as every other test uses it', async () => {
    const { f, w } = await reading({});
    await vi.advanceTimersByTimeAsync(3 * ACCESS_READ_MS);
    expect(statusReads(w)).toEqual([]);
    // Nothing but the connect went out: the reader added no request of any kind.
    expect(w.log.map(l => l.split(':')[1])).toEqual(['addRobot', 'connectRobot', 'updateConfig']);
    expect(accessOf(f)).toMatchObject({ generation: null, locks: [], via: null, problem: NO_GENERATION });
  });

  it('a client that reports no generation on a healthy link: nothing is sent, and the group says why', async () => {
    const { f, w } = await reading({ generation: null });
    await vi.advanceTimersByTimeAsync(3 * ACCESS_READ_MS);
    expect(statusReads(w)).toEqual([]);
    expect(accessOf(f)).toMatchObject({ generation: null, locks: [], via: null, problem: NO_GENERATION });
    expect(freshOf(f)).toMatchObject({ state: 'unavailable', reason: NO_GENERATION });
  });

  it('not while the link is down', async () => {
    const { f, w } = await reading({ generation: 'rw7' });
    w.drop(ID);
    const from = w.log.length;
    await vi.advanceTimersByTimeAsync(4 * ACCESS_READ_MS);
    expect(statusReads(w, from)).toEqual([]);
    expect(accessOf(f).via).toBeNull();
  });

  it('not while the link is stale', async () => {
    const { f, w } = await reading({ generation: 'rw7' });
    w.quality(ID, 'stale', 'poll failed (1/3)');
    const from = w.log.length;
    await vi.advanceTimersByTimeAsync(4 * ACCESS_READ_MS);
    expect(statusReads(w, from)).toEqual([]);
    expect(accessOf(f).via).toBeNull();
    expect(freshOf(f)).toMatchObject({ state: 'stale', reason: 'poll failed (1/3)' });
  });

  it('never on the wrong controller: nothing is sent and the group carries nothing', async () => {
    const other = { ...cfg(), systemId: '{DDDEA751-93CE-4DAC-8D85-55725137AF66}' };
    const { f, w } = await connected({ generation: 'rw7' }, other);
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(3 * ACCESS_READ_MS);
    expect(statusReads(w)).toEqual([]);
    expect(accessOf(f)).toEqual({
      generation: null, model: null, locks: [], remoteAccessEnabled: null,
      rmmp: { supported: null, privilege: null, asOf: null, error: null }, via: null, problem: null, asOf: null,
    });
  });

  it('a link found on the wrong controller after it was read: the round stops, and what was read is not kept', async () => {
    const { f, w } = await reading({ generation: 'rw7' });
    expect(lockOf(f, 'edit').held).toBe(false);
    // The controller on the link turns out to be another one (the client re-read its system info).
    const from = w.log.length;
    w.set(ID, { systemInfo: { name: 'other', rwVersion: '7.21.4', sysid: '{DDDEA751-93CE-4DAC-8D85-55725137AF66}', startTime: '', options: [] } });
    expect(accessOf(f)).toMatchObject({ generation: null, locks: [] });
    await vi.advanceTimersByTimeAsync(3 * ACCESS_READ_MS);
    expect(statusReads(w, from)).toEqual([]);
    // The fleet logged out of the stranger; no holder from before is shown for the link that is down now.
    expect(accessOf(f)).toMatchObject({ generation: null, locks: [], via: null });
  });
});

describe('access reader: a read that fails lands on its own part', () => {
  it('a null mastership answer, an `unknown` one and a thrown RMMP read keep the last value and time of their part alone', async () => {
    const { f, w } = await connected({ generation: 'rw6' });
    w.access.mastership.cfg = { mastership: 'remote', uid: PLANTED_UID, application: 'RobotStudio' };
    w.access.mastership.motion = { mastership: 'local', uid: PLANTED_UID };
    w.access.rmmp = 'modify';
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(TICK + 50);
    const good = accessOf(f);
    expect(good.locks.map(l => l.held)).toEqual([true, true, false]);

    w.access.mastership.cfg = null;
    w.access.mastership.motion = { mastership: 'unknown', uid: PLANTED_UID };
    w.access.rmmp = new RwsError('HTTP 503 - busy', 'CONTROLLER_BUSY');
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK + 50);
    const after = accessOf(f);
    // cfg: the client answered null.
    expect(after.locks[0]).toEqual({ ...good.locks[0], error: { code: 'UNKNOWN', message: 'the mastership status of cfg could not be read' } });
    expect(after.locks[0]).toMatchObject({ held: true, holder: { kind: 'remote', name: null, application: 'RobotStudio' } });
    // motion: the client's own fallback word.
    expect(after.locks[1]).toEqual({
      ...good.locks[1], reported: 'unknown', error: { code: 'PARSE_ERROR', message: 'the mastership status of motion was not understood' },
    });
    expect(after.locks[1].held).toBe(true);
    // rapid: read and understood, its time moved on.
    expect(after.locks[2]).toMatchObject({ held: false, error: null });
    expect(Date.parse(after.locks[2].asOf!)).toBeGreaterThan(Date.parse(good.locks[2].asOf!));
    // RMMP: the read threw.
    expect(after.rmmp).toEqual({ ...good.rmmp, error: { code: 'CONTROLLER_BUSY', message: 'HTTP 503 - busy' } });
    // No asOf of a failed part moved, and the group is as old as its oldest part.
    expect(after.locks[0].asOf).toBe(good.locks[0].asOf);
    expect(after.locks[1].asOf).toBe(good.locks[1].asOf);
    expect(after.rmmp.asOf).toBe(good.rmmp.asOf);
    expect(after.asOf).toBe(good.asOf);
    expect(freshOf(f)).toMatchObject({
      state: 'partial',
      reason: 'cfg: the mastership status of cfg could not be read; motion: the mastership status of motion was not understood; RMMP: HTTP 503 - busy',
    });
    expect(f.get(ID)!.capabilities.entries.find(e => e.id === 'mastership')).toMatchObject({ state: 'degraded' });

    // The reads succeed again: values, times and errors follow.
    w.access.mastership.cfg = { mastership: 'nomaster' };
    w.access.mastership.motion = { mastership: 'nomaster' };
    w.access.rmmp = 'none';
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK + 50);
    expect(accessOf(f).locks.map(l => [l.held, l.error])).toEqual([[false, null], [false, null], [false, null]]);
    expect(accessOf(f).rmmp).toMatchObject({ privilege: 'none', error: null });
    expect(freshOf(f).state).toBe('current');
  });

  it('first reads that fail leave every part without a value: held is null, not false', async () => {
    const { f, w } = await connected({ generation: 'rw7' });
    w.access.mastership.rapid = { mastership: '' };
    w.access.mastership.motion = 'nomaster';
    w.access.rmmp = 'granted';
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(TICK + 50);
    for (const l of accessOf(f).locks) {
      expect(l.held).toBeNull();
      expect(l.held).not.toBe(false);
      expect(l.asOf).toBeNull();
      expect(l.error).toMatchObject({ code: 'PARSE_ERROR' });
    }
    expect(accessOf(f).rmmp).toEqual({ supported: null, privilege: null, asOf: null, error: { code: 'PARSE_ERROR', message: 'the RMMP privilege was not understood' } });
    expect(freshOf(f)).toMatchObject({ state: 'stale' });
    expect(f.get(ID)!.capabilities.entries.find(e => e.id === 'mastership')).toMatchObject({ state: 'degraded' });
  });
});

describe('access reader: RMMP that the controller does not offer', () => {
  it('`unsupported` is not asked again in that run, and is asked once more after a reconnect', async () => {
    const { f, w } = await connected({ generation: 'rw6' });
    w.access.rmmp = 'unsupported';
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(3 * ACCESS_READ_MS + 1_000);
    expect(rounds(w).map(r => r.reads)).toEqual([
      ['cfg', 'motion', 'rapid', 'rmmp'], ['cfg', 'motion', 'rapid'], ['cfg', 'motion', 'rapid'], ['cfg', 'motion', 'rapid'],
    ]);
    expect(accessOf(f).rmmp).toEqual({ supported: false, privilege: null, asOf: null, error: null });
    // RMMP is no part any more: the group is dated by its locks and is current.
    expect(accessOf(f).asOf).not.toBeNull();
    expect(freshOf(f).state).toBe('current');
    expect(f.get(ID)!.capabilities.entries.find(e => e.id === 'rmmp')).toEqual({ id: 'rmmp', state: 'unavailable', reason: 'this controller does not offer RMMP' });

    w.drop(ID);
    await vi.advanceTimersByTimeAsync(1_000);
    const from = w.log.length;
    await reconnect(w);
    // Asked anew on the new connection: not determined until it answers.
    expect(accessOf(f).rmmp).toEqual({ supported: null, privilege: null, asOf: null, error: null });
    await vi.advanceTimersByTimeAsync(2 * ACCESS_READ_MS + 1_000);
    expect(rounds(w, from).map(r => r.reads)).toEqual([
      ['cfg', 'motion', 'rapid', 'rmmp'], ['cfg', 'motion', 'rapid'], ['cfg', 'motion', 'rapid'],
    ]);
  });
});

/** Every state a stream consumer held, frame by frame, from the frames the stream made. */
function consumerStates(frames: string[]): Array<{ at: string; snap: ControllerSnapshot }> {
  const out: Array<{ at: string; snap: ControllerSnapshot }> = [];
  let snap: ControllerSnapshot | null = null;
  for (const text of frames) {
    const frame = JSON.parse(text) as { type: string; observedAt: string; controllers?: ControllerSnapshot[]; groups?: Partial<ControllerSnapshot> };
    if (frame.type === 'snapshot') { snap = frame.controllers!.find(c => c.id === ID) ?? snap; }
    else if (frame.type === 'delta') { snap = { ...(snap as ControllerSnapshot), ...frame.groups }; }
    if (snap) { out.push({ at: frame.observedAt, snap }); }
  }
  return out;
}

describe('access reader: nothing from an earlier connection is shown beside a usable link', () => {
  const HELD = { mastership: 'remote', uid: PLANTED_UID, application: 'RobotStudio' };

  /** A controller whose edit lock another client holds, read and served. */
  async function heldByAnother() {
    const made = await connected({ generation: 'rw7' });
    made.w.access.mastership.rapid = HELD;
    // The event reader runs too: it announces a link change of its own, before the access reader has looked at it.
    made.f.startEventReader();
    made.f.startAccessReader(TICK);
    const stream = new SnapshotStream(made.f, new SocketHub({ heartbeatMs: 0 }));
    const frames: string[] = [];
    const obs = stream.observe(frame => frames.push(frame));
    frames.push(obs.first);
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + 1_000);
    expect(lockOf(made.f, 'edit')).toMatchObject({ held: true, holder: { kind: 'remote', name: null, application: 'RobotStudio' }, error: null });
    return { ...made, frames, stop: () => { obs.stop(); stream.close(); } };
  }

  it('a reconnect: the holder read before the outage is served while the link is down, gone the moment it is usable, and the new values come with the first round', async () => {
    const { f, w, frames, stop } = await heldByAnother();
    const before = lockOf(f, 'edit');

    w.drop(ID);
    await vi.advanceTimersByTimeAsync(20_000);
    // Down: the last reading stays, with its time, marked as no longer refreshed.
    expect(accessOf(f)).toMatchObject({ generation: 'rw7', via: null, problem: null });
    expect(lockOf(f, 'edit')).toEqual({ ...before, heldByDaemon: null });
    expect(freshOf(f)).toMatchObject({ state: 'stale', reason: 'connection lost' });
    expect(new Set(f.get(ID)!.capabilities.entries.map(e => e.state))).toEqual(new Set(['unknown']));

    // Meanwhile the other client's session ended: nobody holds the lock any more.
    w.access.mastership.rapid = { mastership: 'nomaster' };
    // The first read of the new connection is held back, so what is served before it lands can be looked at.
    let release = (): void => {};
    w.access.gate = new Promise<void>(res => { release = res; });
    const changes: string[] = [];
    f.onChanged(id => changes.push(id));
    const from = w.log.length;
    const reconnectedAt = new Date(Date.now() + 10).toISOString();
    await reconnect(w);

    // The moment the link is usable, before any read was sent: every part unread, and a change announced.
    expect(statusReads(w, from)).toEqual([]);
    expect(changes.length).toBeGreaterThan(0);
    expect(accessOf(f)).toMatchObject({ generation: 'rw7', via: 'poll', asOf: null, rmmp: { supported: null, privilege: null, asOf: null, error: null } });
    for (const l of accessOf(f).locks) { expect(l).toMatchObject(UNREAD); }
    expect(freshOf(f)).toMatchObject({ state: 'unread', reason: 'not read on this connection yet' });

    // The first round is out and has not landed: still unread, never the old holder.
    await vi.advanceTimersByTimeAsync(2 * TICK);
    expect(statusReads(w, from).map(r => r.read)).toEqual(['rapid']);
    expect(lockOf(f, 'edit')).toMatchObject(UNREAD);
    expect(freshOf(f).state).toBe('unread');

    release();
    w.access.gate = null;
    await vi.advanceTimersByTimeAsync(TICK);
    expect(lockOf(f, 'edit')).toMatchObject({ held: false, holder: null, reported: 'nomaster', error: null });
    expect(Date.parse(lockOf(f, 'edit').asOf!)).toBeGreaterThan(Date.parse(reconnectedAt));
    expect(freshOf(f).state).toBe('current');

    // What a stream consumer saw: from the reconnect on, no frame shows the old holder beside a connected link.
    stop();
    const after = consumerStates(frames).filter(s => s.at >= reconnectedAt);
    expect(after.length).toBeGreaterThanOrEqual(2);
    expect(after[0].snap.link.connected).toBe(true);
    expect(after[0].snap.access.locks[0]).toMatchObject(UNREAD);
    for (const s of after) {
      expect(s.snap.link.connected).toBe(true);
      expect(s.snap.access.locks[0].held).not.toBe(true);
      expect(s.snap.access.locks[0].holder).toBeNull();
    }
    expect(after.at(-1)!.snap.access.locks[0]).toMatchObject({ held: false, reported: 'nomaster' });
    // And while the link was down the consumer was told so: the holder stood beside `via` null.
    const down = consumerStates(frames).filter(s => !s.snap.link.connected && s.snap.access.locks.length > 0);
    expect(down.length).toBeGreaterThan(0);
    for (const s of down) { expect(s.snap.access.via).toBeNull(); }
  });

  it('the same after a stale spell on one connection: kept while stale, cleared when the link recovers, read anew at once', async () => {
    const { f, w, frames, stop } = await heldByAnother();
    const before = lockOf(f, 'edit');

    w.quality(ID, 'stale', 'poll failed (1/3)');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(lockOf(f, 'edit')).toEqual(before);
    expect(accessOf(f).via).toBeNull();
    expect(freshOf(f)).toMatchObject({ state: 'stale', reason: 'poll failed (1/3)' });

    w.access.mastership.rapid = { mastership: 'nomaster' };
    let release = (): void => {};
    w.access.gate = new Promise<void>(res => { release = res; });
    const changes: string[] = [];
    f.onChanged(id => changes.push(id));
    const from = w.log.length;
    const recoveredAt = new Date(Date.now()).toISOString();
    w.quality(ID, 'live', 'poll succeeded - connection recovered');

    expect(statusReads(w, from)).toEqual([]);
    expect(changes.length).toBeGreaterThan(0);
    for (const l of accessOf(f).locks) { expect(l).toMatchObject(UNREAD); }
    expect(accessOf(f).via).toBe('poll');
    expect(freshOf(f)).toMatchObject({ state: 'unread', reason: 'not read on this connection yet' });

    await vi.advanceTimersByTimeAsync(2 * TICK);
    expect(statusReads(w, from).map(r => r.read)).toEqual(['rapid']);   // read at once, not ACCESS_READ_MS later
    expect(lockOf(f, 'edit')).toMatchObject(UNREAD);
    release();
    w.access.gate = null;
    await vi.advanceTimersByTimeAsync(TICK);
    expect(lockOf(f, 'edit')).toMatchObject({ held: false, holder: null, reported: 'nomaster' });

    stop();
    const after = consumerStates(frames).filter(s => s.at >= recoveredAt && s.snap.link.quality === 'live');
    expect(after.length).toBeGreaterThanOrEqual(2);
    for (const s of after) { expect(s.snap.access.locks[0].held).not.toBe(true); }
  });

  it('a snapshot taken after a recovery the client did not announce, before the reader has looked: unread, not the old holder', async () => {
    const { f, w, stop } = await heldByAnother();
    stop();
    const before = lockOf(f, 'edit');
    // The link goes stale and the reader sees it on its tick; the client raises no change.
    w.manager(ID).state.quality = 'stale';
    await vi.advanceTimersByTimeAsync(2 * TICK);
    expect(lockOf(f, 'edit')).toEqual(before);
    expect(accessOf(f).via).toBeNull();
    // It recovers, again without a word from the client, and a consumer asks at once.
    w.manager(ID).state.quality = 'live';
    expect(f.get(ID)!.link.quality).toBe('live');
    expect(lockOf(f, 'edit')).toMatchObject(UNREAD);
    expect(freshOf(f)).toMatchObject({ state: 'unread', reason: 'not read on this connection yet' });
    expect(f.get(ID)!.capabilities.entries.find(e => e.id === 'mastership')).toMatchObject({ state: 'unknown' });
    // The same connection recovered: it is read anew once ACCESS_READ_MS have passed since its last round began, and stays unread until then.
    await vi.advanceTimersByTimeAsync(2 * TICK);
    expect(lockOf(f, 'edit')).toMatchObject(UNREAD);
    expect(f.get(ID)!.freshness.level).toBe('current');
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS);
    expect(lockOf(f, 'edit').held).toBe(true);
    // The same for a new connection the reader has not looked at yet; that one is read at once.
    Object.assign(w.manager(ID).state, { connected: false, quality: 'disconnected' });
    await vi.advanceTimersByTimeAsync(2 * TICK);
    expect(lockOf(f, 'edit')).toMatchObject({ held: true, holder: { kind: 'remote' } });
    Object.assign(w.manager(ID).state, { connected: true, quality: 'live' });
    expect(lockOf(f, 'edit')).toMatchObject(UNREAD);
    await vi.advanceTimersByTimeAsync(2 * TICK);
    expect(lockOf(f, 'edit')).toMatchObject({ held: true, error: null });
    expect(Date.parse(lockOf(f, 'edit').asOf!)).toBeGreaterThan(Date.parse(before.asOf!));
  });

  it('a round that was out when the link dropped writes nothing back, and sends nothing more', async () => {
    const { f, w } = await reading({ generation: 'rw6' });
    const before = accessOf(f);
    w.access.mastership.cfg = HELD;
    w.access.mastership.motion = HELD;
    let release = (): void => {};
    w.access.gate = new Promise<void>(res => { release = res; });
    const from = w.log.length;
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK);
    expect(statusReads(w, from).map(r => r.read)).toEqual(['cfg']);   // out, waiting for its answer
    w.drop(ID);
    release();
    w.access.gate = null;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statusReads(w, from).map(r => r.read)).toEqual(['cfg']);   // motion, rapid and RMMP were never sent
    expect(accessOf(f).locks.map(l => [l.held, l.asOf])).toEqual(before.locks.map(l => [l.held, l.asOf]));
  });

  it('a round begun before an outage and answered after the reconnect writes nothing into the new connection', async () => {
    const { f, w } = await reading({ generation: 'rw7' });
    w.access.mastership.rapid = HELD;
    let release = (): void => {};
    w.access.gate = new Promise<void>(res => { release = res; });
    const from = w.log.length;
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK);
    expect(statusReads(w, from).map(r => r.read)).toEqual(['rapid']);
    w.drop(ID);
    await reconnect(w);
    for (const l of accessOf(f).locks) { expect(l).toMatchObject(UNREAD); }
    // The old read answers now, with what it saw before the outage.
    w.access.mastership.rapid = { mastership: 'nomaster' };
    release();
    w.access.gate = null;
    await vi.advanceTimersByTimeAsync(3);
    expect(lockOf(f, 'edit')).toMatchObject(UNREAD);
    // The new connection's own round then reads the lock itself.
    await vi.advanceTimersByTimeAsync(2 * TICK);
    expect(lockOf(f, 'edit')).toMatchObject({ held: false, reported: 'nomaster' });
    expect(w.access.maxOut).toBe(1);
  });
});

describe('access reader: teardown', () => {
  it('remove: nothing is sent once it begins, and the round in flight is waited for before the logout', async () => {
    const { f, w } = await reading({ generation: 'rw6' });
    let release = (): void => {};
    w.access.gate = new Promise<void>(res => { release = res; });
    const from = w.log.length;
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK);
    expect(statusReads(w, from).map(r => r.read)).toEqual(['cfg']);
    const removing = f.remove(ID);
    await vi.advanceTimersByTimeAsync(200);
    // Still waiting for the read that is out: no logout yet.
    expect(w.log.slice(from).some(l => l.startsWith('multi:disconnectRobot'))).toBe(false);
    const releasedAt = Date.now() - T0;
    release();
    w.access.gate = null;
    await vi.advanceTimersByTimeAsync(500);
    await removing;
    const since = w.log.slice(from);
    expect(statusReads(w, from).map(r => r.read)).toEqual(['cfg']);
    const logout = since.find(l => l.startsWith('multi:disconnectRobot'))!;
    expect(Number(logout.slice(logout.lastIndexOf('@') + 1))).toBeGreaterThanOrEqual(releasedAt);
    // No request of any kind after the logout was sent, but the removal itself.
    expect(since.slice(since.indexOf(logout) + 1).map(l => l.split(':')[1])).toEqual(['removeRobot']);
    expect(f.get(ID)).toBeNull();
  });

  it('disconnectAll: the same, the reader stops, and what was read stays in the snapshot of the link that is down', async () => {
    const { f, w } = await reading({ generation: 'rw7' });
    const read = accessOf(f);
    let release = (): void => {};
    w.access.gate = new Promise<void>(res => { release = res; });
    const from = w.log.length;
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK);
    expect(statusReads(w, from).map(r => r.read)).toEqual(['rapid']);
    const stopping = f.disconnectAll({ waitMs: 2_000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(w.log.slice(from).some(l => l.startsWith('multi:disconnectRobot'))).toBe(false);
    release();
    w.access.gate = null;
    await vi.advanceTimersByTimeAsync(500);
    expect((await stopping).map(r => r.outcome)).toEqual(['logged-out']);
    await vi.advanceTimersByTimeAsync(4 * ACCESS_READ_MS);
    expect(statusReads(w, from).map(r => r.read)).toEqual(['rapid']);
    expect(accessOf(f)).toMatchObject({ generation: 'rw7', via: null });
    expect(accessOf(f).locks.map(l => [l.held, l.asOf])).toEqual(read.locks.map(l => [l.held, l.asOf]));
  });

  it('a controller removed and added again starts unread: nothing of the earlier one is shown', async () => {
    const { f, w } = await connected({ generation: 'rw7' });
    w.access.mastership.rapid = { mastership: 'remote', application: 'RobotStudio' };
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(TICK + 50);
    expect(lockOf(f, 'edit').held).toBe(true);
    const removing = f.remove(ID);
    await vi.advanceTimersByTimeAsync(100);
    await removing;
    let release = (): void => {};
    w.access.gate = new Promise<void>(res => { release = res; });
    f.add(cfg());
    await vi.advanceTimersByTimeAsync(50);
    for (const l of accessOf(f).locks) { expect(l).toMatchObject(UNREAD); }
    release();
    w.access.gate = null;
    await vi.advanceTimersByTimeAsync(2 * TICK);
    expect(lockOf(f, 'edit').held).toBe(true);
  });

  it('startAccessReader twice is one reader; stopAccessReader ends the reads', async () => {
    const { f, w } = await connected({ generation: 'rw7' });
    f.startAccessReader(TICK);
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(TICK + 50);
    expect(rounds(w).length).toBe(1);
    f.stopAccessReader();
    await vi.advanceTimersByTimeAsync(4 * ACCESS_READ_MS);
    expect(rounds(w).length).toBe(1);
  });
});

describe('access reader: announcing', () => {
  it('change handlers run when the content changes, not when a round reconfirms it', async () => {
    const { f, w } = await reading({ generation: 'rw6' });
    const changes: string[] = [];
    f.onChanged(id => changes.push(id));
    await vi.advanceTimersByTimeAsync(4 * ACCESS_READ_MS);
    expect(rounds(w).length).toBeGreaterThanOrEqual(4);
    expect(changes).toEqual([]);   // every asOf moved on; nothing else did
    w.access.mastership.motion = { mastership: 'local', application: 'FlexPendant' };
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK);
    expect(changes).toEqual([ID]);
    await vi.advanceTimersByTimeAsync(3 * ACCESS_READ_MS);
    expect(changes).toEqual([ID]);
    // A read that starts failing is a change, once.
    w.access.mastership.cfg = null;
    await vi.advanceTimersByTimeAsync(3 * ACCESS_READ_MS);
    expect(changes).toEqual([ID, ID]);
  });

  it('the stream carries the group: a delta names access, capabilities and freshness when the first round lands, and no frame for a stamp moving on', async () => {
    const { f, w } = await connected({ generation: 'rw7' });
    const stream = new SnapshotStream(f, new SocketHub({ heartbeatMs: 0 }));
    const frames: string[] = [];
    const obs = stream.observe(frame => frames.push(frame));
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(1_000);
    const deltas = frames.map(t => JSON.parse(t) as { type: string; groups?: Record<string, unknown> }).filter(fr => fr.type === 'delta');
    const named = new Set(deltas.flatMap(d => Object.keys(d.groups ?? {})));
    for (const g of ['access', 'capabilities', 'freshness']) { expect(named, g).toContain(g); }
    const settled = frames.length;
    await vi.advanceTimersByTimeAsync(4 * ACCESS_READ_MS);
    expect(rounds(w).length).toBeGreaterThanOrEqual(4);
    expect(frames.length).toBe(settled);
    obs.stop();
    stream.close();
  });

  // On real time: Fastify compiles the routes' snapshot schemas when the app
  // starts, about 0.5 s alone and past the 5 s default under a full parallel
  // run. Nothing in it waits on a clock, so a longer budget is all it needs.
  it('the routes carry the groups: GET /v0/controllers and GET /v0/controllers/:id, under the current schema, with no new route for access', async () => {
    const { f, w } = await connected({ generation: 'rw6' });
    w.access.mastership.motion = { mastership: 'local', uid: PLANTED_UID, application: 'FlexPendant' };
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(TICK + 50);
    vi.useRealTimers();
    const app = Fastify();
    await registerControllerRoutes(app, {
      fleet: f,
      discover: async () => { throw new Error('not in this test'); },
      readPassport: async () => { throw new Error('not in this test'); },
    });
    try {
      const list = (await app.inject({ method: 'GET', url: '/v0/controllers' })).json<{ schemaVersion: string; controllers: ControllerSnapshot[] }>();
      expect(list.schemaVersion).toBe(SCHEMA_VERSION);
      const one = (await app.inject({ method: 'GET', url: `/v0/controllers/${ID}` })).json<ControllerSnapshot>();
      for (const snap of [list.controllers[0], one]) {
        expect(snap.access).toMatchObject({ generation: 'rw6', model: 'mastership', via: 'poll', problem: null });
        expect(snap.access.locks.map(l => [l.lock, l.held, l.holder?.kind ?? null])).toEqual([['cfg', false, null], ['motion', true, 'local'], ['rapid', false, null]]);
        expect(snap.capabilities.entries.map(e => e.id)).toHaveLength(9);
        expect(snap.freshness.groups.find(g => g.group === 'access')).toMatchObject({ state: 'current' });
        expect(snap.link.downSince).toBeNull();
        expect(JSON.stringify(snap)).not.toContain(PLANTED_UID);
      }
      // Nothing is asked of the controller for a request, and there is no route that would.
      const from = w.log.length;
      for (const url of [`/v0/controllers/${ID}/access`, `/v0/controllers/${ID}/access/refresh`, `/v0/controllers/${ID}/capabilities`]) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
        expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(404);
      }
      expect(w.log.length).toBe(from);
    } finally {
      await app.close();
    }
  }, ROUTES_TEST_MS);

  it('a change handler that throws is caught: the reader goes on reading, and nothing is left unhandled', async () => {
    const { f, w, log } = await reading({ generation: 'rw7' });
    f.onChanged(() => { throw new Error('handler broke'); });
    // From a round: the content changes, the handler throws, the round's failure is logged.
    w.access.mastership.rapid = { mastership: 'remote', application: 'RobotStudio' };
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK);
    expect(log.lines.some(l => l.startsWith('error access status round failed') && l.includes('handler broke'))).toBe(true);
    expect(lockOf(f, 'edit').held).toBe(true);
    // From the reader's own tick: the link turned stale and came back without the client saying so.
    w.manager(ID).state.quality = 'stale';
    await vi.advanceTimersByTimeAsync(2 * TICK);
    expect(log.lines.some(l => l.startsWith('error access reader failed') && l.includes('handler broke'))).toBe(true);
    w.manager(ID).state.quality = 'live';
    const from = w.log.length;
    await vi.advanceTimersByTimeAsync(2 * ACCESS_READ_MS);
    expect(rounds(w, from).length).toBeGreaterThanOrEqual(2);
    expect(lockOf(f, 'edit')).toMatchObject({ held: true, error: null });
  });
});

describe('access reader: what it logs', () => {
  it('a failing part once per error code, with the part, the code and the word that was not understood - never an id or an answer', async () => {
    const { f, w, log } = await connected({ generation: 'rw6' });
    w.access.mastership.cfg = { mastership: 'remote', uid: PLANTED_UID, application: 'RobotStudio' };
    w.access.mastership.motion = { mastership: 'unknown', uid: PLANTED_UID, application: 'RobotStudio' };
    w.access.mastership.rapid = null;
    w.access.rmmp = new RwsError(`HTTP 500 - uid ${PLANTED_UID}`, 'UNKNOWN');
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(3 * ACCESS_READ_MS);
    expect(rounds(w).length).toBeGreaterThanOrEqual(3);
    const warned = log.lines.filter(l => l.startsWith('warn access status not read'));
    // One line per failing part, however many rounds failed the same way.
    expect(warned.map(l => JSON.parse(l.slice(l.indexOf('{'))) as object)).toEqual([
      { controller: ID, part: 'motion', code: 'PARSE_ERROR', word: 'unknown' },
      { controller: ID, part: 'rapid', code: 'UNKNOWN' },
      { controller: ID, part: 'RMMP', code: 'UNKNOWN' },
    ]);
    // What the client threw is served with its part, minus anything shaped like an id.
    expect(accessOf(f).rmmp.error).toEqual({ code: 'UNKNOWN', message: 'HTTP 500 - uid ***' });
    expect(JSON.stringify(f.get(ID))).not.toContain(PLANTED_UID);
    // The code changes: logged again. The read recovers and fails anew: logged again.
    w.access.mastership.rapid = { mastership: 'exclusive', uid: PLANTED_UID };
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK);
    w.access.mastership.motion = { mastership: 'nomaster' };
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK);
    w.access.mastership.motion = { mastership: 'unknown' };
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK);
    const again = log.lines.filter(l => l.startsWith('warn access status not read')).slice(3).map(l => JSON.parse(l.slice(l.indexOf('{'))) as object);
    expect(again).toEqual([
      { controller: ID, part: 'rapid', code: 'PARSE_ERROR', word: 'exclusive' },
      { controller: ID, part: 'motion', code: 'PARSE_ERROR', word: 'unknown' },
    ]);
    for (const line of log.lines) { expect(line).not.toContain(PLANTED_UID); }
    expect(log.lines.join('\n')).not.toMatch(/"uid"|RobotStudio/);
  });

  it('RobotWare 8: no log line and no served byte holds the holder\'s station id', async () => {
    const { f, w, log } = await connected({ generation: 'rw8', writeAccessReader: true });
    w.access.writeAccess = { held: true, heldByMe: false, heldById: PLANTED_STATION, heldByName: 'Cell 4 HMI', externalControlEnabled: true };
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS);
    w.access.writeAccess = { held: 'true', heldById: PLANTED_STATION };
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + TICK);
    w.access.writeAccess = new RwsError('the answer has no write-access status', 'PARSE_ERROR');
    await vi.advanceTimersByTimeAsync(2 * ACCESS_READ_MS);
    expect(log.lines.filter(l => l.startsWith('warn access status not read')).map(l => JSON.parse(l.slice(l.indexOf('{'))) as object))
      .toEqual([{ controller: ID, part: 'writeaccess', code: 'PARSE_ERROR' }]);
    for (const line of log.lines) { expect(line).not.toContain(PLANTED_STATION); }
    expect(JSON.stringify(f.get(ID))).not.toContain(PLANTED_STATION);
    expect(JSON.stringify(f.get(ID))).not.toMatch(/heldById/i);
  });

  it('nothing of the status reaches the snapshot as an id on RobotWare 6 and 7 either', async () => {
    const { f, w } = await connected({ generation: 'rw7' });
    w.access.mastership.rapid = { mastership: 'remote', uid: PLANTED_UID, application: 'RobotStudio' };
    w.access.mastership.motion = { mastership: 'unknown', uid: PLANTED_UID };
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS);
    const served = JSON.stringify(f.get(ID));
    expect(served).toContain('RobotStudio');
    expect(served).not.toContain(PLANTED_UID);
    expect(served).not.toMatch(/"uid"/);
  });
});

describe('access reader: a recording changes nothing', () => {
  /** Connect, read for a while through a mode change and a failing part, reconnect, read on, shut down. */
  async function lifetime(generation: FakeGeneration, sink: ClientTapSink | null) {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const w = world({ generation, writeAccessReader: true });
    const f = fleetOver(w);
    fleets.push(f);
    if (sink) { f.setTap(sink); }
    f.add(cfg());
    await vi.advanceTimersByTimeAsync(50);
    f.startAccessReader(TICK);
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + 1_000);
    w.access.mastership.motion = null;
    w.set(ID, { opmode: 'MANR' });
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + 1_000);
    w.drop(ID);
    await vi.advanceTimersByTimeAsync(1_000);
    const own = w.log.length;   // the reconnect below is this test's own call of the client, not the fleet's
    await reconnect(w);
    await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + 1_000);
    const stopping = f.disconnectAll({ waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
    return { log: [...w.log], fleetCalls: w.log.filter((_, i) => i !== own), access: JSON.stringify(f.get(ID)!.access) };
  }

  it.each(['rw6', 'rw7', 'rw8'] as const)('%s: the same calls, in the same order, at the same times, with the tap on and off', async generation => {
    const off = await lifetime(generation, null);
    vi.useRealTimers();
    const told: string[] = [];
    const sink: ClientTapSink = {
      active: true,
      call: (target, _id, method, args) => { told.push(`${target}:${method}:${JSON.stringify(args)}`); return { done() {} }; },
      state() {},
      sub() {},
    };
    const on = await lifetime(generation, sink);
    expect(on.log).toEqual(off.log);
    expect(on.access).toBe(off.access);
    expect(statusReads({ log: off.log } as World).length).toBeGreaterThanOrEqual(3);
    // The recording was told every status read, as a call of the controller's manager.
    expect(told).toEqual(on.fleetCalls.map(l => l.slice(0, l.lastIndexOf('@'))));
    const methods = new Set(told.map(t => t.split(':')[1]));
    for (const m of generation === 'rw8' ? ['getWriteAccessStatus'] : ['getMastershipStatus', 'getRmmpPrivilege']) { expect(methods, m).toContain(m); }
  });
});

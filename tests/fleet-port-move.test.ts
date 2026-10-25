import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControllerConfig } from '../src/config.js';
import type { ControllerFleet, Log } from '../src/fleet.js';
import { ID, RW7_ID, T0, cfg, fleetOver, world, type World } from './helpers/fake-fleet.js';

// A controller that moves port, through the real fleet over a faked client: the
// config takes the new port only once the controller there is confirmed, by its
// system id, to be the one that was added. No controller here, no network.
//
// The fake client does not check the system id itself on connect, so what is
// tested is the fleet's own check, the one that guards the saved config.

/** Another controller's system id: what a stranger on the moved-to port reports. */
const OTHER_ID = '{5E0C9B1A-2F47-4D8B-A6E3-91C07D24F5B8}';
/** The supervisor's tick in these tests (ms). */
const TICK = 100;

/** The system info the fake client reads from a controller with system id `sysid`. */
const systemInfo = (sysid: string) => ({ name: 'IRB1600_6_120_1', rwVersion: '7.21.4', sysid, startTime: '', options: [] });

type KeptLog = Log & { lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> };

/** A log that keeps every line as it was written. */
function keptLog(): KeptLog {
  const lines: KeptLog['lines'] = [];
  const keep = (level: string) => (obj: object, msg?: string): void => { lines.push({ level, obj: obj as Record<string, unknown>, msg: msg ?? '' }); };
  return { lines, debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') };
}

let fleets: ControllerFleet[] = [];
afterEach(() => {
  for (const f of fleets) { f.stopSupervisor(); }
  fleets = [];
  vi.useRealTimers();
});

/** A fleet over a fresh world, connected on the saved port; every config list it saves is kept in `saved`. */
async function connected(config: ControllerConfig = cfg()): Promise<{ f: ControllerFleet; w: World; log: KeptLog; saved: ControllerConfig[][] }> {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const w = world();
  const log = keptLog();
  const saved: ControllerConfig[][] = [];
  const f = fleetOver(w, log, all => saved.push(all.map(c => ({ ...c }))));
  fleets.push(f);
  f.add(config);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.get(ID)?.link).toMatchObject({ connected: true, port: 9403, identityCheck: { status: 'confirmed', actual: RW7_ID } });
  return { f, w, log, saved };
}

/** The saved port stops answering; the client's next connect finds `sysid` (null: not read yet) on `port`. */
async function moveTo(f: ControllerFleet, w: World, port: number, sysid: string | null): Promise<void> {
  w.drop(ID);
  w.controller.port = port;
  w.controller.sysid = sysid;
  f.startSupervisor(TICK);
  await vi.advanceTimersByTimeAsync(TICK + 50);
}

const lastSaved = (saved: ControllerConfig[][]) => saved.at(-1)?.find(c => c.id === ID);
const movedLines = (log: KeptLog) => log.lines.filter(l => l.msg === 'controller moved port; config updated');

describe('a controller that moves port', () => {
  it('takes the new port into the config only once the system id there confirms it (an id learned on the saved port)', async () => {
    const { f, w, log, saved } = await connected();
    expect(f.all()).toEqual([expect.objectContaining({ port: 9403, systemId: RW7_ID })]);
    const savesBefore = saved.length;

    // Found on 9404, before the client has read who is there: nothing is saved.
    await moveTo(f, w, 9404, null);
    expect(f.get(ID)?.link).toMatchObject({ connected: true, port: 9404, identityCheck: { status: 'unverified', expected: RW7_ID, actual: null } });
    expect(f.all()).toEqual([expect.objectContaining({ port: 9403, systemId: RW7_ID })]);
    expect(saved).toHaveLength(savesBefore);
    expect(movedLines(log)).toEqual([]);

    // The system id is read there and it is the same controller: now the move is saved, once.
    w.set(ID, { systemInfo: systemInfo(RW7_ID) });
    expect(f.get(ID)?.link.identityCheck.status).toBe('confirmed');
    expect(f.all()).toEqual([expect.objectContaining({ port: 9404, useHttps: true, systemId: RW7_ID })]);
    expect(saved).toHaveLength(savesBefore + 1);
    expect(lastSaved(saved)).toMatchObject({ port: 9404, systemId: RW7_ID });
    expect(movedLines(log)).toEqual([expect.objectContaining({ level: 'info', obj: { controller: ID, from: 9403, to: 9404 } })]);

    // The next change on the same link saves nothing more.
    w.quality(ID, 'live', 'WebSocket events streaming');
    expect(saved).toHaveLength(savesBefore + 1);
  });

  it('takes the new port when the system id supplied at setup is confirmed there', async () => {
    const { f, w, saved } = await connected({ ...cfg(), systemId: RW7_ID.toLowerCase().slice(1, -1) });
    const savesBefore = saved.length;
    await moveTo(f, w, 9404, RW7_ID);
    expect(f.get(ID)?.link.identityCheck.status).toBe('confirmed');
    expect(f.all()).toEqual([expect.objectContaining({ port: 9404 })]);
    expect(saved).toHaveLength(savesBefore + 1);
    expect(lastSaved(saved)?.port).toBe(9404);
  });

  it('never adopts a controller that answers on another port with a different system id', async () => {
    const { f, w, log, saved } = await connected();
    const savesBefore = saved.length;

    await moveTo(f, w, 9404, OTHER_ID);

    // The config keeps the saved port and the id of the controller that was added.
    expect(f.all()).toEqual([expect.objectContaining({ port: 9403, systemId: RW7_ID })]);
    expect(saved).toHaveLength(savesBefore);
    expect(saved.flat().some(c => c.port === 9404)).toBe(false);
    expect(movedLines(log)).toEqual([]);
    // Said once, with both ids and the port the stranger is on.
    expect(log.lines.filter(l => l.msg === 'controller on this link is a different system; port not saved')).toEqual([
      expect.objectContaining({ level: 'error', obj: { controller: ID, expected: RW7_ID, actual: OTHER_ID, port: 9404 } }),
    ]);
    // And the fleet does not stay on it.
    expect(w.log.filter(l => l.startsWith('multi:disconnectRobot:'))).toHaveLength(1);
    expect(f.get(ID)?.link.connected).toBe(false);
  });

  it('after a stranger, adopts the controller that was added once it is confirmed on yet another port', async () => {
    const { f, w, saved } = await connected();
    const savesBefore = saved.length;
    await moveTo(f, w, 9404, OTHER_ID);
    expect(f.all()[0]?.port).toBe(9403);

    // The supervisor retries after its backoff (5 s after one failure); this time the right controller answers, on 9405.
    w.controller.port = 9405;
    w.controller.sysid = RW7_ID;
    await vi.advanceTimersByTimeAsync(5_000 + TICK);
    expect(f.get(ID)?.link).toMatchObject({ connected: true, port: 9405, identityCheck: { status: 'confirmed' } });
    expect(f.all()).toEqual([expect.objectContaining({ port: 9405, systemId: RW7_ID })]);
    expect(saved).toHaveLength(savesBefore + 1);
    expect(saved.flat().some(c => c.port === 9404)).toBe(false);
  });
});

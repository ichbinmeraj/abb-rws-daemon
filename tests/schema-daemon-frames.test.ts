import { afterEach, describe, expect, it, vi } from 'vitest';
import { RwsError } from 'abb-rws-client';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error - plain ESM script without type declarations
import { CUSTOM_KEYWORDS, ROOT } from '../scripts/export-schema.mjs';
import type { ControllerFleet } from '../src/fleet.js';
import { SCHEMA_VERSION } from '../src/schema/v0.js';
import { SnapshotStream } from '../src/stream.js';
import { SocketHub } from '../src/wsHub.js';
import { ID, T0, cfg, fleetOver, world, type FakeGeneration } from './helpers/fake-fleet.js';

// What the daemon itself serves - not hand-made frames - validated strictly
// against the history file of its own schema version: a frame of the real
// stream that the exported schema refuses (a field not in it, a number that
// should be whole, a list over its cap) fails here.

type Json = Record<string, any>;

/** Ids planted in the fake client's answers; no frame may hold them. */
const PLANTED_UID = '{0B7C3A52-6D1E-4F0A-9C55-2E81D4F7A901}';
const PLANTED_STATION = '{C4D2E8F1-77AB-4B0E-8E3A-5A1F9D20B6C3}';

const SNAPSHOT_ID = `urn:abb-rws-daemon:schema:${SCHEMA_VERSION}`;
const history = JSON.parse(readFileSync(join(ROOT, `schema/history/v${SCHEMA_VERSION}.schema.json`), 'utf8')) as Json;

async function frameValidator(warnings: unknown[][]): Promise<FastifyInstance> {
  const app = Fastify({
    ajv: {
      customOptions: {
        keywords: [...CUSTOM_KEYWORDS], allowUnionTypes: true, removeAdditional: false, coerceTypes: false, useDefaults: false,
        logger: { log() {}, warn: (...a: unknown[]) => warnings.push(a), error: (...a: unknown[]) => warnings.push(a) },
      },
    },
  });
  app.addSchema(history);
  app.post('/frame', { schema: { body: { $ref: `${SNAPSHOT_ID}#/definitions/StreamFrame` } } }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

let fleets: ControllerFleet[] = [];
afterEach(() => {
  for (const f of fleets) {
    f.stopAccessReader(); f.stopPointerPoller(); f.stopMotionSampler(); f.stopIoPoller(); f.stopEventReader(); f.stopSupervisor();
  }
  fleets = [];
  vi.useRealTimers();
});

/**
 * A controller's whole lifetime through the real fleet and stream: added and
 * connected, the pointer poller, the motion sampler (a pose read failing), the
 * I/O watcher with a subscription event, the event reader, the access reader
 * (a holder, then a status that is not understood, no answer and a thrown
 * read), reads on demand, a state change, an outage and a reconnect, the
 * logout and the removal. Every frame the stream made, and a snapshot taken
 * at each stage.
 */
async function servedFrames(generation: FakeGeneration): Promise<string[]> {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const w = world({ generation, writeAccessReader: true });
  // Another client holds a lock. Its ids are in the answers, and must not be in a frame.
  w.access.mastership.rapid = { mastership: 'remote', uid: PLANTED_UID, application: 'RobotStudio' };
  w.access.writeAccess = { held: true, heldByMe: false, heldById: PLANTED_STATION, heldByName: 'Cell 4 HMI', externalControlEnabled: true };
  const f = fleetOver(w);
  fleets.push(f);
  const stream = new SnapshotStream(f, new SocketHub({ heartbeatMs: 0 }));
  const frames: string[] = [];
  const obs = stream.observe(frame => frames.push(frame));
  frames.push(obs.first);
  f.add(cfg());
  await vi.advanceTimersByTimeAsync(50);
  f.startPointerPoller();
  f.startMotionSampler();
  f.startIoPoller();
  f.startEventReader();
  f.startAccessReader();
  f.watchMotion(ID);
  f.watchIo(ID, ['do_a', 'do_b']);
  await vi.advanceTimersByTimeAsync(2_000);
  const reads = Promise.all([f.moduleSource(ID, 'T_ROB1', 'MainModule'), f.searchIoSignals(ID, { name: 'do' })]);
  await vi.advanceTimersByTimeAsync(100);
  await reads;
  w.manager(ID).fire('/rw/iosystem/signals/do_a;state', '1');
  w.manager(ID).state.execstate = 'stopped';
  w.multi.changed(ID);
  await vi.advanceTimersByTimeAsync(2_000);
  frames.push(stream.snapshotFrame());
  // The access status stops being readable, three ways: a word that is not understood, no answer, a thrown read.
  w.access.mastership.rapid = { mastership: 'unknown', uid: PLANTED_UID };
  w.access.mastership.motion = null;
  w.access.rmmp = new RwsError('HTTP 503 - busy', 'CONTROLLER_BUSY');
  w.access.writeAccess = { held: 'true', heldById: PLANTED_STATION };
  w.set(ID, { opmode: 'MANR' });   // a mode change: the status is read as soon as the floor between rounds allows
  await vi.advanceTimersByTimeAsync(2_000);
  frames.push(stream.snapshotFrame());
  // An outage, then a reconnect on which the controller does not offer RMMP.
  w.drop(ID);
  await vi.advanceTimersByTimeAsync(500);
  frames.push(stream.snapshotFrame());
  w.access.mastership.rapid = { mastership: 'nomaster' };
  w.access.mastership.motion = { mastership: 'local', application: 'FlexPendant' };
  w.access.rmmp = 'unsupported';
  w.access.writeAccess = { held: false, heldByMe: false, heldByName: null, externalControlEnabled: null };
  const connecting = w.multi.connectRobot(ID);
  await vi.advanceTimersByTimeAsync(1_500);
  await connecting;
  frames.push(stream.snapshotFrame());
  const stopping = f.disconnectAll({ waitMs: 1_000 });
  await vi.advanceTimersByTimeAsync(1_000);
  await stopping;
  const removing = f.remove(ID);
  await vi.advanceTimersByTimeAsync(1_000);
  await removing;
  // The fake client tells of the removal before the fleet has forgotten the controller: tell it again, as a later change would.
  w.multi.changed(ID);
  await vi.advanceTimersByTimeAsync(1_000);
  obs.stop();
  stream.close();
  return frames;
}

describe('schema frames: what the daemon serves', () => {
  it.each(['rw7', 'rw6', 'rw8'] as const)('%s: every frame of a controller lifetime validates strictly against the history file of the daemon version', async generation => {
    const texts = await servedFrames(generation);
    vi.useRealTimers();
    const frames = texts.map(t => JSON.parse(t) as Json);
    // The lifetime reached every frame type and the groups that change most.
    expect(new Set(frames.map(fr => fr.type))).toEqual(new Set(['snapshot', 'delta', 'removed']));
    const groups = new Set(frames.filter(fr => fr.type === 'delta').flatMap(fr => Object.keys(fr.groups)));
    for (const g of ['link', 'identity', 'motion', 'io', 'events', 'access', 'capabilities', 'freshness']) expect(groups, g).toContain(g);
    const [, watched, failing, down, reconnected] = frames.filter(fr => fr.type === 'snapshot').map(fr => fr.controllers[0] as Json);
    expect(watched.motion.units[0].joints.length).toBeGreaterThan(0);
    expect(watched.io.signals.length).toBe(2);

    // The access group went over the wire in each of its forms, and validates below.
    const locks = generation === 'rw6' ? ['cfg', 'motion', 'rapid'] : generation === 'rw7' ? ['edit', 'motion'] : ['writeaccess'];
    expect(watched.access).toMatchObject({ generation, via: 'poll', problem: null });
    expect(watched.access.locks.map((l: Json) => l.lock)).toEqual(locks);
    expect(watched.access.locks.every((l: Json) => l.held !== null && l.error === null && l.asOf !== null)).toBe(true);
    expect(watched.freshness.groups.find((g: Json) => g.group === 'access')).toMatchObject({ state: 'current', reason: null });
    expect(watched.link.downSince).toBeNull();
    if (generation === 'rw8') {
      expect(watched.access).toMatchObject({ model: 'writeaccess', remoteAccessEnabled: true, rmmp: { supported: false, privilege: null } });
      expect(watched.access.locks[0]).toMatchObject({ held: true, holder: { kind: 'station', name: 'Cell 4 HMI', application: null, flexPendant: false } });
    } else {
      expect(watched.access).toMatchObject({ model: 'mastership', remoteAccessEnabled: null, rmmp: { supported: true, privilege: 'none' } });
      expect(watched.access.locks.find((l: Json) => l.held)).toMatchObject({ holder: { kind: 'remote', name: null, application: 'RobotStudio', flexPendant: false } });
    }
    // Failing reads: an error beside the value of the read before it; nothing became "not held".
    expect(failing.access.locks.some((l: Json) => l.error !== null)).toBe(true);
    expect(failing.access.locks.find((l: Json) => l.holder !== null)).toMatchObject({ held: true });
    expect(['partial', 'stale']).toContain(failing.freshness.groups.find((g: Json) => g.group === 'access').state);
    expect(failing.freshness.level).toBe('degraded');
    // Down: the values kept, nothing being read, every capability row unknown, and the outage dated.
    expect(down.link.connected).toBe(false);
    expect(down.link.downSince).toEqual(expect.any(String));
    expect(down.access).toMatchObject({ generation, via: null });
    expect(down.freshness.level).toBe('down');
    expect(new Set(down.capabilities.entries.map((e: Json) => e.state))).toEqual(new Set(['unknown']));
    // Reconnected: read anew, without the holder of before; RMMP not offered on this connection.
    expect(reconnected.access.via).toBe('poll');
    expect(reconnected.access.locks.every((l: Json) => l.error === null && l.held !== null)).toBe(true);
    expect(reconnected.access.rmmp).toEqual({ supported: false, privilege: null, asOf: null, error: null });
    expect(reconnected.capabilities.entries.map((e: Json) => e.id)).toEqual([
      'status-push', 'events-push', 'event-times', 'io-push', 'io-table', 'joint-limits', 'mastership', 'write-access', 'rmmp']);
    // A holder is named, never identified: no frame holds a planted id.
    for (const text of texts) {
      expect(text).not.toContain(PLANTED_UID);
      expect(text).not.toContain(PLANTED_STATION);
    }

    const warnings: unknown[][] = [];
    const app = await frameValidator(warnings);
    try {
      for (const [i, frame] of frames.entries()) {
        const r = await app.inject({ method: 'POST', url: '/frame', payload: frame });
        expect(r.statusCode, `frame ${i} (${frame.type}): ${r.body}\n${texts[i]}`).toBe(200);
      }
    } finally {
      await app.close();
    }
    expect(warnings).toEqual([]);
  }, 60_000);

  it('a lifetime without an access generation serves the three groups too, and validates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const w = world();
    const f = fleetOver(w);
    fleets.push(f);
    const stream = new SnapshotStream(f, new SocketHub({ heartbeatMs: 0 }));
    const texts: string[] = [stream.snapshotFrame()];
    f.add(cfg());
    texts.push(stream.snapshotFrame());   // added, never reached
    await vi.advanceTimersByTimeAsync(50);
    f.startAccessReader();
    await vi.advanceTimersByTimeAsync(1_000);
    texts.push(stream.snapshotFrame());
    stream.close();
    vi.useRealTimers();
    const [, never, up] = texts.map(t => (JSON.parse(t) as Json).controllers[0] as Json);
    expect(never.link).toMatchObject({ connected: false, downSince: new Date(T0).toISOString() });
    expect(never.freshness.level).toBe('down');
    expect(up.access).toMatchObject({ generation: null, locks: [], via: null, problem: expect.any(String) });
    const warnings: unknown[][] = [];
    const app = await frameValidator(warnings);
    try {
      for (const [i, text] of texts.entries()) {
        const r = await app.inject({ method: 'POST', url: '/frame', payload: JSON.parse(text) as Json });
        expect(r.statusCode, `frame ${i}: ${r.body}`).toBe(200);
      }
    } finally {
      await app.close();
    }
    expect(warnings).toEqual([]);
  }, 60_000);

  it('the schema the frames are held to is the daemon\'s own version, with the three groups of 0.13', () => {
    expect(SCHEMA_VERSION).toBe('0.15');
    for (const name of ['AccessGroup', 'CapabilitiesGroup', 'FreshnessGroup']) { expect(history.definitions[name], name).toBeDefined(); }
  });
});

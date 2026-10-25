import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error - plain ESM script without type declarations
import { CUSTOM_KEYWORDS, ROOT } from '../scripts/export-schema.mjs';
import { ReplayState } from '../src/replay/state.js';
import { snapshotOf } from './helpers/recording-fakes.js';

// Validation goes through Fastify's own validator (its ajv), so the schema is
// checked with exactly what the daemon ships, and no other package is needed.

type Json = Record<string, any>;

const readJson = (p: string): Json => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const FIXTURE = 'tests/fixtures/u1-frames-synthetic.jsonl';
const lines: Json[] = readFileSync(join(ROOT, FIXTURE), 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l));
const header = lines[0];
const frames: Json[] = lines.filter((l) => l.kind === 'frame').map((l) => l.frame);

// The fixture is validated against the history file of the version its header names.
const VERSION: string = header.schemaVersion;
const SNAPSHOT_ID = `urn:abb-rws-daemon:schema:${VERSION}`;
const history = readJson(`schema/history/v${VERSION}.schema.json`);
const main = readJson('schema/v0.schema.json');
const recording = readJson('schema/recording.schema.json');
// What the daemon serves now is validated against the history file of its own version.
const CURRENT: string = main['x-schema-version'];
const CURRENT_ID = `urn:abb-rws-daemon:schema:${CURRENT}`;
const current = readJson(`schema/history/v${CURRENT}.schema.json`);

const clone = <T>(x: T): T => structuredClone(x);

function strictFastify(warnings: unknown[][], extra: Json = {}): FastifyInstance {
  return Fastify({
    ajv: {
      customOptions: {
        keywords: [...CUSTOM_KEYWORDS],
        allowUnionTypes: true,
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
        logger: { log() {}, warn: (...a: unknown[]) => warnings.push(a), error: (...a: unknown[]) => warnings.push(a) },
        ...extra,
      },
    },
  });
}

const warnings: unknown[][] = [];
let app: FastifyInstance;

beforeAll(async () => {
  app = strictFastify(warnings);
  app.addSchema(history);
  if (CURRENT !== VERSION) app.addSchema(current);
  // A recording line refers to its frames by the major-line id. As schema/README.md says, the
  // history file of the recording's own version is registered under that id, so the fixture's
  // lines are checked as its version defines them, not as the current v0.schema.json does.
  app.addSchema({ ...history, $id: main.$id });
  app.addSchema(recording);
  const ok = async () => ({ ok: true });
  app.post('/frame', { schema: { body: { $ref: `${SNAPSHOT_ID}#/definitions/StreamFrame` } } }, ok);
  app.post('/frame/current', { schema: { body: { $ref: `${CURRENT_ID}#/definitions/StreamFrame` } } }, ok);
  app.post('/line', { schema: { body: { $ref: `${recording.$id}#/definitions/RecordingLine` } } }, ok);
  // Every definition compiles: ajv's strict mode warns on anything it dislikes.
  for (const name of Object.keys(history.definitions)) {
    app.post(`/def/v0/${name}`, { schema: { body: { $ref: `${SNAPSHOT_ID}#/definitions/${name}` } } }, ok);
  }
  for (const name of Object.keys(current.definitions)) {
    app.post(`/def/current/${name}`, { schema: { body: { $ref: `${CURRENT_ID}#/definitions/${name}` } } }, ok);
  }
  for (const name of Object.keys(recording.definitions)) {
    app.post(`/def/recording/${name}`, { schema: { body: { $ref: `${recording.$id}#/definitions/${name}` } } }, ok);
  }
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app?.close();
});

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as Json });

async function expectFrame(frame: Json, status: number, why: string) {
  const r = await post('/frame', frame);
  expect(r.statusCode, `${why}: ${r.body}`).toBe(status);
}

describe('schema frames: the synthetic fixture', () => {
  it('names a version that has a frozen history file', () => {
    expect(header.kind).toBe('header');
    expect(VERSION).toMatch(/^0\.\d+$/);
    expect(history.$id).toBe(SNAPSHOT_ID);
  });

  it('covers every group, nulls, errors and all three frame types', () => {
    const types = new Set(frames.map((f) => f.type));
    expect([...types].sort()).toEqual(['delta', 'removed', 'snapshot']);
    const snapshot = frames.find((f) => f.type === 'snapshot')!;
    const groups = new Set<string>();
    for (const c of snapshot.controllers) for (const g of Object.keys(c)) groups.add(g);
    for (const f of frames.filter((x) => x.type === 'delta')) for (const g of Object.keys(f.groups)) groups.add(g);
    for (const g of ['identity', 'link', 'panel', 'rapid', 'motion', 'io', 'events']) expect(groups, g).toContain(g);
    const text = JSON.stringify(frames);
    expect(text).toContain('"identity":null');
    expect(text).toContain('"reconnect":{');
    expect(text).toContain('"refusal":{');
    expect(text).toContain('"controller":{');
    expect(text).toContain('"unit":null');
  });

  it('accepts every frame', async () => {
    expect(frames.length).toBeGreaterThan(3);
    for (const [i, f] of frames.entries()) await expectFrame(f, 200, `frame ${i} (${f.type})`);
  });

  it('accepts every line as a recording line', async () => {
    for (const [i, l] of lines.entries()) {
      const r = await post('/line', l);
      expect(r.statusCode, `line ${i + 1} (${l.kind}): ${r.body}`).toBe(200);
    }
  });

  it('compiles every definition without a strict-mode warning', () => {
    expect(warnings).toEqual([]);
  });
});

describe('schema frames: validation is strict', () => {
  const snapshot = () => clone(frames.find((f) => f.type === 'snapshot')!);
  const delta = () => clone(frames.find((f) => f.type === 'delta')!);

  it('refuses a field the schema does not name', async () => {
    const f = delta();
    f.extra = 1;
    await expectFrame(f, 400, 'extra frame field');
    const s = snapshot();
    s.controllers[0].panel.extra = 'x';
    await expectFrame(s, 400, 'extra group field');
  });

  it('refuses a value outside an enum', async () => {
    const s = snapshot();
    s.controllers[0].link.quality = 'great';
    await expectFrame(s, 400, 'link quality');
    const t = snapshot();
    t.controllers[0].link.identityCheck.status = 'maybe';
    await expectFrame(t, 400, 'identity check');
  });

  it('refuses a missing required field', async () => {
    const f = delta();
    delete f.observedAt;
    await expectFrame(f, 400, 'delta without observedAt');
    const s = snapshot();
    delete s.controllers[0].events;
    await expectFrame(s, 400, 'controller without events');
  });

  it('refuses a fractional sequence number', async () => {
    const s = snapshot();
    const c = s.controllers.find((x: Json) => x.events.recent.length > 0);
    c.events.recent[0].seq = 1.5;
    await expectFrame(s, 400, 'seq 1.5');
  });

  it('refuses a list longer than its cap (maxItems from the constant)', async () => {
    const s = snapshot();
    const c = s.controllers.find((x: Json) => x.events.recent.length > 0);
    const cap: number = history['x-constants'].EVENTS_RECENT_MAX;
    c.events.recent = Array.from({ length: cap }, (_, i) => ({ ...c.events.recent[0], seq: i + 1 }));
    await expectFrame(s, 200, `${cap} recent events`);
    c.events.recent.push({ ...c.events.recent[0], seq: cap + 1 });
    await expectFrame(s, 400, `${cap + 1} recent events`);
  });

  it('refuses a quaternion that is not four numbers', async () => {
    const s = snapshot();
    const unit = s.controllers.flatMap((x: Json) => x.motion.units).find((u: Json) => u.pose !== null);
    unit.pose.q = [1, 0, 0];
    await expectFrame(s, 400, '3-element q');
    unit.pose.q = [1, 0, 0, 0, 0];
    await expectFrame(s, 400, '5-element q');
  });

  it('refuses a time that is not ISO 8601', async () => {
    const f = delta();
    f.observedAt = '2026-10-04 12:00:00';
    await expectFrame(f, 400, 'observedAt without T and zone');
  });

  it('refuses a string where a number belongs, without coercion', async () => {
    const s = snapshot();
    s.controllers[0].link.port = '80';
    await expectFrame(s, 400, 'port as text');
  });

  it('accepts a frame of an older minor on schemaVersion alone', async () => {
    const s = snapshot();
    s.schemaVersion = '0.11';
    await expectFrame(s, 200, 'older minor');
    s.schemaVersion = 'v0.12';
    await expectFrame(s, 400, 'not a version');
  });

  it('refuses a recording line with an unknown field', async () => {
    const r = await post('/line', { ...lines.find((l) => l.kind === 'frame'), extra: true });
    expect(r.statusCode).toBe(400);
  });
});

describe('schema frames: what the daemon serves now (access, capabilities, freshness)', () => {
  const AT = '2026-10-05T08:00:00.000Z';
  const snapshot = (): Json => clone({
    type: 'snapshot', schemaVersion: CURRENT, observedAt: AT,
    controllers: [snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed' }), snapshotOf('rw6', { generation: 'rws1' })],
  });
  const expectCurrent = async (frame: Json, status: number, why: string) => {
    const r = await post('/frame/current', frame);
    expect(r.statusCode, `${why}: ${r.body}`).toBe(status);
  };

  it('accepts a snapshot with the three groups, and a delta that names any of them', async () => {
    const s = snapshot();
    await expectCurrent(s, 200, 'snapshot');
    const c = s.controllers[0];
    for (const groups of [{ access: c.access }, { capabilities: c.capabilities }, { freshness: c.freshness }, { link: c.link, freshness: c.freshness }]) {
      await expectCurrent({ type: 'delta', observedAt: AT, id: c.id, name: c.name, groups }, 200, `delta ${Object.keys(groups).join('+')}`);
    }
    // RobotWare 6 has three locks; the link of a healthy controller has no outage to date.
    expect(s.controllers[1].access.locks.map((l: Json) => l.lock)).toEqual(['cfg', 'motion', 'rapid']);
    expect(c.link.downSince).toBeNull();
  });

  it('a frame of the fixture`s version is not a frame of this one, nor the other way round', async () => {
    if (VERSION === CURRENT) return;
    await expectCurrent(clone(frames.find((f) => f.type === 'snapshot')!), 400, `a ${VERSION} snapshot against ${CURRENT}`);
    await expectFrame(snapshot(), 400, `a ${CURRENT} snapshot against ${VERSION}`);
  });

  it('refuses a snapshot without one of the three groups, or a link without downSince', async () => {
    for (const g of ['access', 'capabilities', 'freshness']) {
      const s = snapshot();
      delete s.controllers[0][g];
      await expectCurrent(s, 400, `controller without ${g}`);
    }
    const s = snapshot();
    delete s.controllers[0].link.downSince;
    await expectCurrent(s, 400, 'link without downSince');
    s.controllers[0].link.downSince = '2026-10-05T07:59:00.000Z';
    await expectCurrent(s, 200, 'link down since a time');
    s.controllers[0].link.downSince = 'a minute ago';
    await expectCurrent(s, 400, 'downSince that is no time');
  });

  it('takes null for a status that was not read, and never a word outside the ones the schema names', async () => {
    const unread = snapshot();
    const lock = unread.controllers[0].access.locks[0];
    Object.assign(lock, { held: null, holder: null, heldByDaemon: null, reported: null, asOf: null });
    Object.assign(unread.controllers[0].access, { remoteAccessEnabled: null, via: null, asOf: null, rmmp: { supported: null, privilege: null, asOf: null, error: null } });
    await expectCurrent(unread, 200, 'an unread lock');
    lock.error = { code: 'PARSE_ERROR', message: 'the mastership status of edit was not understood' };
    lock.reported = 'unknown';
    await expectCurrent(unread, 200, 'a lock whose read failed');

    const cases: Array<[string, (c: Json) => void, number]> = [
      ['held as text', (c) => { c.access.locks[0].held = 'false'; }, 400],
      ['a holder kind outside the four', (c) => { c.access.locks[1].holder.kind = 'flexpendant'; }, 400],
      ['a station as holder', (c) => { c.access.locks[1].holder = { kind: 'station', name: 'RobotStudio', application: null, flexPendant: false }; }, 200],
      ['a holder with an id', (c) => { c.access.locks[1].holder.id = '{6F1C0E2A-8B3D-4E5F-9A7B-1C2D3E4F5A6B}'; }, 400],
      ['a holder with a user id', (c) => { c.access.locks[1].holder.uid = 'someone'; }, 400],
      ['a lock with a station id', (c) => { c.access.locks[1].heldById = '{6F1C0E2A-8B3D-4E5F-9A7B-1C2D3E4F5A6B}'; }, 400],
      ['a lock outside the five', (c) => { c.access.locks[0].lock = 'io'; }, 400],
      ['a generation outside the three', (c) => { c.access.generation = 'rw9'; }, 400],
      ['a model outside the two', (c) => { c.access.model = 'token'; }, 400],
      ['the privilege pending exec', (c) => { c.access.rmmp.privilege = 'pending exec'; }, 200],
      ['a privilege outside the five', (c) => { c.access.rmmp.privilege = 'granted'; }, 400],
      ['access read by subscription', (c) => { c.access.via = 'subscription'; }, 400],
      ['a capability outside the nine', (c) => { c.capabilities.entries[0].id = 'writes'; }, 400],
      ['a capability state outside the four', (c) => { c.capabilities.entries[0].state = 'partial'; }, 400],
      ['a group that is unavailable', (c) => { c.freshness.groups[6].state = 'unavailable'; c.freshness.groups[6].reason = 'this abb-rws-client cannot read the write-access status'; }, 200],
      ['a group state outside the seven', (c) => { c.freshness.groups[0].state = 'fresh'; }, 400],
      ['freshness of a group it does not report on', (c) => { c.freshness.groups[0].group = 'link'; }, 400],
      ['a level outside the four', (c) => { c.freshness.level = 'ok'; }, 400],
      ['a wrong-controller level', (c) => { c.freshness.level = 'wrong-controller'; }, 200],
    ];
    for (const [why, change, status] of cases) {
      const s = snapshot();
      change(s.controllers[0]);
      await expectCurrent(s, status, why);
    }
  });

  it('refuses more locks than a controller has (maxItems from ACCESS_LOCKS_MAX)', async () => {
    const cap: number = current['x-constants'].ACCESS_LOCKS_MAX;
    const s = snapshot();
    const rw6 = s.controllers[1];
    expect(rw6.access.locks).toHaveLength(cap);
    await expectCurrent(s, 200, `${cap} locks`);
    rw6.access.locks.push({ ...rw6.access.locks[0], lock: 'edit' });
    await expectCurrent(s, 400, `${cap + 1} locks`);
  });

  it('a controller a replay fills in from a partial delta is a whole controller of the recording`s version', async () => {
    // This version: the three groups in their unread form, and the link down since the frame.
    const now = new ReplayState();
    now.apply(snapshot());
    now.apply({ type: 'delta', observedAt: AT, id: 'rw9', name: 'RW9', groups: { panel: snapshot().controllers[0].panel } });
    expect(Object.keys(now.get('rw9')!)).toContain('freshness');
    await expectCurrent({ type: 'snapshot', schemaVersion: CURRENT, observedAt: AT, controllers: clone(now.list()) }, 200, `filled in, ${CURRENT}`);
    if (VERSION === CURRENT) return;
    // The fixture's version: only the groups it had.
    const first = clone(frames.find((f) => f.type === 'snapshot')!);
    const then = new ReplayState();
    then.apply(clone(first));
    then.apply({ type: 'delta', observedAt: AT, id: 'rw9', name: 'RW9', groups: { panel: clone(first.controllers[0].panel) } });
    expect(Object.keys(then.get('rw9')!)).not.toContain('freshness');
    await expectFrame({ type: 'snapshot', schemaVersion: VERSION, observedAt: AT, controllers: clone(then.list()) }, 200, `filled in, ${VERSION}`);
  });
});

describe('schema frames: the warning capture works', () => {
  it('sees a strict-mode warning when one is due', async () => {
    const seen: unknown[][] = [];
    const probe = strictFastify(seen, { allowUnionTypes: false });
    probe.post('/x', { schema: { body: { type: 'object', properties: { a: { type: ['string', 'number'] } } } } }, async () => ({}));
    await probe.ready();
    await probe.close();
    expect(seen.length).toBeGreaterThan(0);
  });
});

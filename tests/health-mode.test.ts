import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error - plain ESM script without type declarations
import { CUSTOM_KEYWORDS, ROOT } from '../scripts/export-schema.mjs';
import { Recorder } from '../src/recording/recorder.js';
import { createServer } from '../src/server.js';
import type { ReplayHealth } from '../src/schema/v0.js';
import { FakeFrameObserver, ManualTimers, MemoryFiles, MemoryLog, snapshotOf } from './helpers/recording-fakes.js';

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const LOCAL = { host: '127.0.0.1:7810' };
const DIR = '/srv/daemon-test/recordings';

/** Answers checked against the published schema, strictly, with Fastify's own validator. */
let schema: FastifyInstance;
beforeAll(async () => {
  schema = Fastify({
    ajv: {
      customOptions: {
        keywords: [...CUSTOM_KEYWORDS], allowUnionTypes: true, removeAdditional: false, coerceTypes: false, useDefaults: false,
      },
    },
  });
  const main = JSON.parse(readFileSync(join(ROOT, 'schema/v0.schema.json'), 'utf8'));
  schema.addSchema(main);
  schema.post('/HealthAnswer', { schema: { body: { $ref: `${main.$id}#/definitions/HealthAnswer` } } }, async () => ({ ok: true }));
  await schema.ready();
}, 30_000);
afterAll(async () => { await schema?.close(); });

async function expectHealthAnswer(body: unknown): Promise<void> {
  const r = await schema.inject({ method: 'POST', url: '/HealthAnswer', payload: body as object });
  expect(r.statusCode, r.body).toBe(200);
}

let app: FastifyInstance | null = null;
afterEach(async () => { await app?.close(); app = null; });

const health = async (a: FastifyInstance) => {
  const res = await a.inject({ method: 'GET', url: '/v0/health', headers: LOCAL });
  expect(res.statusCode).toBe(200);
  return { body: res.json(), text: res.body };
};

describe('GET /v0/health: mode, recording and replay (schema 0.12)', () => {
  it('a live daemon without a recorder: live, no recording, no replay; exactly the schema`s fields', async () => {
    app = createServer({ accessToken: TOKEN });
    const { body } = await health(app);
    expect(Object.keys(body)).toEqual(['status', 'version', 'startedAt', 'uptimeS', 'mode', 'recording', 'replay']);
    expect(body).toMatchObject({ status: 'ok', mode: 'live', recording: { active: false, since: null }, replay: null });
    await expectHealthAnswer(body);
  });

  it('says a recording runs, since when, and nothing else of it: no file name, no folder', async () => {
    const files = new MemoryFiles();
    const recorder = new Recorder({
      observer: new FakeFrameObserver([snapshotOf('rw7', { sysId: 'sys-rw7' })]), dir: DIR, folder: 'custom',
      log: new MemoryLog(), daemonVersion: '0.0.0-test', clientVersion: '0.0.0-test', files, timers: new ManualTimers(),
    });
    app = createServer({ accessToken: TOKEN, health: { mode: 'live', recording: () => recorder.health(), replay: () => null } });

    expect((await health(app)).body.recording).toEqual({ active: false, since: null });
    const started = await recorder.start({ label: 'health' });
    const during = await health(app);
    expect(during.body.recording).toEqual({ active: true, since: started.startedAt });
    expect(during.body.mode).toBe('live');
    expect(during.text).not.toContain('recordings');
    expect(during.text).not.toContain('rec-');
    expect(during.text).not.toContain('health"');   // not even the label
    await expectHealthAnswer(during.body);

    await recorder.stop();
    expect((await health(app)).body.recording).toEqual({ active: false, since: null });
  });

  it('a replaying daemon: mode replay, the replay`s position, no recording', async () => {
    const replay: ReplayHealth = {
      state: 'paused', positionMs: 83_000, durationMs: 180_000, speed: 2, loop: true, loops: 1,
      recordedAt: '2026-10-04T15:30:12.345Z', time: 'shifted',
    };
    app = createServer({ accessToken: TOKEN, health: { mode: 'replay', replay: () => replay } });
    const { body } = await health(app);
    expect(body).toMatchObject({ mode: 'replay', recording: { active: false, since: null }, replay });
    await expectHealthAnswer(body);
  });

  it('needs no token in any mode, and a part that cannot say how it stands never fails it', async () => {
    app = createServer({
      accessToken: TOKEN,
      health: {
        mode: 'replay',
        recording: () => { throw new Error('recorder bug'); },
        replay: () => { throw new Error('replay bug'); },
      },
    });
    const { body } = await health(app);
    expect(body).toMatchObject({ status: 'ok', mode: 'replay', recording: { active: false, since: null }, replay: null });
    await expectHealthAnswer(body);
  });
});

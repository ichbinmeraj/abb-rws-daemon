import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error - plain ESM script without type declarations
import { CUSTOM_KEYWORDS, ROOT } from '../scripts/export-schema.mjs';
import type { ReplayControl } from '../src/recording/contract.js';
import { Recorder, realRecordingFiles, type RecordingFiles } from '../src/recording/recorder.js';
import { registerRecordingRoutes } from '../src/recordingRoutes.js';
import { registerReplayRoutes } from '../src/replayRoutes.js';
import { createServer } from '../src/server.js';
import { TOKEN_HEADER, type RecordingLimits, type ReplayStatus } from '../src/schema/v0.js';
import { FakeFrameObserver, ManualTimers, MemoryFiles, MemoryLog, snapshotOf } from './helpers/recording-fakes.js';

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const LOCAL = { host: '127.0.0.1:7810', [TOKEN_HEADER]: TOKEN };
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** An absolute folder no answer may ever name. */
const DIR = '/srv/daemon-test/private-recordings';

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
  for (const name of ['RecordingStatus', 'ErrorBody']) {
    schema.post(`/${name}`, { schema: { body: { $ref: `${main.$id}#/definitions/${name}` } } }, async () => ({ ok: true }));
  }
  await schema.ready();
}, 30_000);
afterAll(async () => { await schema?.close(); });

async function expectShape(name: 'RecordingStatus' | 'ErrorBody', body: unknown): Promise<void> {
  const r = await schema.inject({ method: 'POST', url: `/${name}`, payload: body as object });
  expect(r.statusCode, `${name}: ${r.body}`).toBe(200);
}

/** Every answer of a test, to check that none names the folder. */
const answers: string[] = [];
let apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps) { await a.close(); }
  apps = [];
});

/** A live daemon's recording routes over a recorder writing to memory (or to `files`). */
async function live<F extends RecordingFiles = MemoryFiles>(
  opts: { token?: string | null; limits?: Partial<RecordingLimits>; files?: F } = {},
) {
  const files = (opts.files ?? new MemoryFiles()) as F;
  const token = opts.token === undefined ? TOKEN : opts.token;
  const recorder = new Recorder({
    observer: new FakeFrameObserver([snapshotOf('rw7', { sysId: 'sys-rw7' })]), dir: DIR, folder: 'custom',
    limits: opts.limits, log: new MemoryLog(), daemonVersion: '0.0.0-test', clientVersion: '0.0.0-test', files,
    timers: new ManualTimers(), token,
  });
  const app = createServer({ accessToken: token, health: { mode: 'live', recording: () => recorder.health() } });
  await registerRecordingRoutes(app, { recorder });
  apps.push(app);
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = LOCAL) => {
    const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    answers.push(res.body);
    return res;
  };
  return { app, recorder, files, call };
}

const REPLAY_STATUS: ReplayStatus = {
  state: 'paused', positionMs: 0, durationMs: 1000, speed: 1, loop: false, loops: 0, recordedAt: '2026-10-04T15:30:12.345Z',
  time: 'shifted', files: ['rec-20261004T153012Z-p0001.jsonl'], session: 'rec-20261004T153012Z', label: null, source: 'daemon',
  recordedSchemaVersion: '0.12', daemonVersion: '0.0.0-test', clientVersion: '0.0.0-test', gaps: 0,
};
const fakeReplay: ReplayControl = {
  status: () => REPLAY_STATUS,
  health: () => ({ ...REPLAY_STATUS }),
  control: () => REPLAY_STATUS,
};

describe('GET /v0/recording, POST /v0/recording/start and /stop', () => {
  it('before any recording: inactive; the folder is named only as default or custom', async () => {
    const { call } = await live();
    const res = await call('GET', '/v0/recording');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ active: false, session: null, folder: 'custom', files: [], limits: null, error: null });
    await expectShape('RecordingStatus', res.json());
  });

  it('start answers 201 with what runs: base file names, content, the limits in force, when it ends', async () => {
    const { call, recorder } = await live();
    const before = Date.now();
    const res = await call('POST', '/v0/recording/start', { label: 'routes-test', content: ['frames', 'state'], durationS: 60 });
    const after = Date.now();
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s).toMatchObject({ active: true, label: 'routes-test', content: ['frames', 'state'], folder: 'custom', endReason: null });
    expect(s.session).toMatch(/^rec-\d{8}T\d{6}Z-routes-test$/);
    expect(s.files).toEqual([`${s.session}-p0001.jsonl`]);
    expect(s.limits.durationS).toBe(60);
    // The duration counts from when its timer started, once the first part existed: not before startedAt.
    expect(Date.parse(s.endsAt) - Date.parse(s.startedAt)).toBeGreaterThanOrEqual(60_000);
    expect(Date.parse(s.endsAt)).toBeGreaterThanOrEqual(before + 60_000);
    expect(Date.parse(s.endsAt)).toBeLessThanOrEqual(after + 60_000);
    expect(recorder.active).toBe(true);
    await expectShape('RecordingStatus', s);
    const status = await call('GET', '/v0/recording');
    expect(status.json()).toMatchObject({ active: true, session: s.session });
  });

  it('a start with no body runs with the daemon`s own settings', async () => {
    const { call } = await live({ limits: { durationS: 900 } });
    const res = await call('POST', '/v0/recording/start');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ active: true, content: ['frames', 'calls', 'state'], label: null, limits: { durationS: 900 } });
  });

  it('one recording at a time: a second start is 409 RECORDING_ACTIVE and changes nothing', async () => {
    const { call, files } = await live();
    const first = (await call('POST', '/v0/recording/start', { label: 'one' })).json();
    const again = await call('POST', '/v0/recording/start', { label: 'two' });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('RECORDING_ACTIVE');
    await expectShape('ErrorBody', again.json());
    expect((await call('GET', '/v0/recording')).json().session).toBe(first.session);
    expect(files.files.size).toBe(1);
  });

  it('stop answers what ran, ended; stopping again, or with none running, is not an error', async () => {
    const { call } = await live();
    expect((await call('POST', '/v0/recording/stop')).json()).toMatchObject({ active: false, session: null });
    const started = (await call('POST', '/v0/recording/start', {})).json();
    const stopped = await call('POST', '/v0/recording/stop');
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ active: false, session: started.session, endReason: 'stopped', endsAt: null });
    expect(stopped.json().records).toBeGreaterThan(0);
    await expectShape('RecordingStatus', stopped.json());
    const again = await call('POST', '/v0/recording/stop');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ active: false, session: started.session, endReason: 'stopped' });
  });
});

describe('the start request: bounds, and limits that only tighten', () => {
  const bad: Array<[string, unknown]> = [
    ['a zero duration', { durationS: 0 }],
    ['a duration over 24 h', { durationS: 86_401 }],
    ['a duration that is not whole', { durationS: 1.5 }],
    ['a duration given as text', { durationS: '60' }],
    ['a part under 1 MiB', { limits: { maxFileBytes: 1024 } }],
    ['a recording over 8 GiB', { limits: { maxTotalBytes: 9 * GIB } }],
    ['a folder over 64 GiB', { limits: { maxDirBytes: 65 * GIB } }],
    ['a free-space floor under 1 GiB', { limits: { minFreeBytes: MIB } }],
    ['a record limit under 64 KiB', { limits: { maxRecordBytes: 1024 } }],
    ['a duration inside limits', { limits: { durationS: 60 } }],
    ['an unknown limit', { limits: { maxParts: 3 } }],
    ['limits that are no object', { limits: [1] }],
    ['a label with capitals and spaces', { label: 'Bad Label' }],
    ['a label over 32 characters', { label: 'x'.repeat(33) }],
    ['empty content', { content: [] }],
    ['unknown content', { content: ['video'] }],
    ['an unknown field', { label: 'ok', path: '/tmp/elsewhere' }],
    ['a list for a body', [{ label: 'x' }]],
  ];
  for (const [what, body] of bad) {
    it(`refuses ${what}: 400, and nothing starts`, async () => {
      const { call, files, recorder } = await live();
      const res = await call('POST', '/v0/recording/start', body);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
      expect(recorder.active).toBe(false);
      expect(files.files.size).toBe(0);
    });
  }

  it('takes the smaller of each maximum and the duration, the larger free-space floor; the answer shows the limits in force', async () => {
    const { call } = await live({ limits: { maxFileBytes: 8 * MIB, maxTotalBytes: 64 * MIB, durationS: 600 } });
    const res = await call('POST', '/v0/recording/start', {
      durationS: 7_200,
      limits: { maxFileBytes: 128 * MIB, maxTotalBytes: 32 * MIB, maxDirBytes: 2 * GIB, maxRecordBytes: 128 * 1024, minFreeBytes: GIB },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().limits).toEqual({
      maxFileBytes: 8 * MIB, maxTotalBytes: 32 * MIB, maxDirBytes: 2 * GIB, maxRecordBytes: 128 * 1024,
      minFreeBytes: 2 * GIB, durationS: 600,
    });
  });

  it('a higher free-space floor is taken', async () => {
    const { call } = await live();
    const res = await call('POST', '/v0/recording/start', { limits: { minFreeBytes: 4 * GIB } });
    expect(res.json().limits.minFreeBytes).toBe(4 * GIB);
  });
});

describe('a recording that cannot start: 503 RECORDING_FAILED, in plain words, with no path', () => {
  /** The POSIX folder rules over a folder that exists already with `mode`, and nothing else on disk. */
  const sharedFolder = (mode: number): RecordingFiles => realRecordingFiles({
    platform: 'linux',
    uid: () => 1000,
    stat: async () => ({ dev: 1, ino: 2, mode: 0o040000 | mode, uid: 1000, isDirectory: () => true }),
    open: async () => { throw new Error('nothing may be created in a folder that was refused'); },
  });

  it('a folder other accounts can open (mode 0755) is refused, and left as it was', async () => {
    const { call, recorder } = await live({ files: sharedFolder(0o755) });
    const res = await call('POST', '/v0/recording/start', {});
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.code).toBe('RECORDING_FAILED');
    expect(body.error).toMatch(/not this account's alone/);
    expect(body.error).toMatch(/755/);
    expect(res.body).not.toContain(DIR);
    await expectShape('ErrorBody', body);
    expect(recorder.active).toBe(false);
    const status = (await call('GET', '/v0/recording')).json();
    expect(status).toMatchObject({ active: false, error: body.error });
  });

  it('too little free space, or a folder already at its limit', async () => {
    const low = new MemoryFiles();
    low.free = 1 * GIB;
    const a = await live({ files: low });
    const res = await a.call('POST', '/v0/recording/start', {});
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/minFreeBytes/);

    const full = new MemoryFiles();
    full.used = 5 * GIB;
    const b = await live({ files: full });
    const res2 = await b.call('POST', '/v0/recording/start', {});
    expect(res2.statusCode).toBe(503);
    expect(res2.json().error).toMatch(/maxDirBytes/);
    expect(full.files.size).toBe(0);
  });

  it('a part that cannot be made', async () => {
    const files = new MemoryFiles();
    files.failCreateAfter = 0;
    const { call } = await live({ files });
    const res = await call('POST', '/v0/recording/start', {});
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('RECORDING_FAILED');
    expect(res.body).not.toContain(DIR);
    expect(res.body).not.toMatch(/rec-\d{8}T\d{6}Z/);
  });
});

describe('the recording and replay routes need the access token', () => {
  const ROUTES: Array<['GET' | 'POST', string, unknown?]> = [
    ['GET', '/v0/recording'],
    ['POST', '/v0/recording/start', {}],
    ['POST', '/v0/recording/stop'],
    ['GET', '/v0/replay'],
    ['POST', '/v0/replay/control', { action: 'pause' }],
  ];

  async function withAll(token: string | null) {
    const { app } = await live({ token });
    await registerReplayRoutes(app, { replay: fakeReplay, recordedSchemaVersion: '0.12' });
    return app;
  }

  it('without it, or with another, all five are refused 401 and nothing starts', async () => {
    const app = await withAll(TOKEN);
    for (const [method, url, payload] of ROUTES) {
      for (const headers of [{ host: LOCAL.host }, { host: LOCAL.host, [TOKEN_HEADER]: 'another-token-another-token-0123456789' }]) {
        const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    }
    const ok = await app.inject({ method: 'GET', url: '/v0/recording', headers: LOCAL });
    expect(ok.json().active).toBe(false);
  });

  it('a daemon that runs without a token refuses all five outright: 403 TOKEN_REQUIRED', async () => {
    const app = await withAll(null);
    for (const [method, url, payload] of ROUTES) {
      const res = await app.inject({ method, url, headers: { host: LOCAL.host }, ...(payload !== undefined ? { payload: payload as object } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().code).toBe('TOKEN_REQUIRED');
    }
  });

  it('a live daemon has no replay routes: 404 NO_ROUTE', async () => {
    const { call } = await live();
    for (const [method, url, payload] of [['GET', '/v0/replay'], ['POST', '/v0/replay/control', { action: 'play' }]] as const) {
      const res = await call(method, url, payload);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NO_ROUTE');
    }
  });
});

describe('in replay mode', () => {
  it('start is 409 REPLAY_MODE; status and stop answer inactive, with no folder', async () => {
    const app = createServer({ accessToken: TOKEN, health: { mode: 'replay' } });
    apps.push(app);
    await registerRecordingRoutes(app, { recorder: null });
    const start = await app.inject({ method: 'POST', url: '/v0/recording/start', headers: LOCAL, payload: {} });
    expect(start.statusCode).toBe(409);
    expect(start.json().code).toBe('REPLAY_MODE');
    for (const [method, url] of [['GET', '/v0/recording'], ['POST', '/v0/recording/stop']] as const) {
      const res = await app.inject({ method, url, headers: LOCAL });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ active: false, folder: null, files: [], limits: null });
      await expectShape('RecordingStatus', res.json());
    }
  });
});

describe('no answer names a path', () => {
  it('none of the answers above carries the folder, or any absolute path', () => {
    expect(answers.length).toBeGreaterThan(30);
    for (const body of answers) {
      expect(body).not.toContain(DIR);
      expect(body).not.toMatch(/"\/(srv|home|tmp|Users)\//);
      expect(body).not.toMatch(/[A-Za-z]:\\\\/);
    }
  });
});

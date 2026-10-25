import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from '../src/recording/recorder.js';
import { RECORDING_LIMIT_DEFAULTS } from '../src/recording/writer.js';
import { REPLAY_MAX_BYTES, parsePartRange, parseRecording, readRecording } from '../src/replay/reader.js';
import { ReplayStream, type ReplaySocketHub } from '../src/replay/stream.js';
import type { SocketLike } from '../src/wsHub.js';
import { BUILT_LIMITS, RecordingBuilder } from './helpers/recording.js';
import {
  FakeFrameObserver, FakeTapHost, ManualClock, ManualTimers, MemoryFiles, MemoryLog, settle, snapshotOf,
} from './helpers/recording-fakes.js';

vi.setConfig({ testTimeout: 60_000 });

const MIB = 1024 * 1024;
const rw7 = (over: Parameters<typeof snapshotOf>[1] = {}) =>
  snapshotOf('rw7', { sysId: 'SYS-7', robotWare: '7.21.4+417', generation: 'rws2', check: 'confirmed', ...over });

/** A route that validates one recording line strictly against schema/recording.schema.json, through Fastify's own validator. */
async function lineValidator() {
  const Fastify = (await import('fastify')).default;
  // @ts-expect-error - plain ESM script without type declarations
  const { CUSTOM_KEYWORDS } = await import('../scripts/export-schema.mjs') as { CUSTOM_KEYWORDS: string[] };
  const schema = (p: string) => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8')) as { $id: string };
  const recording = schema('schema/recording.schema.json');
  const app = Fastify({
    ajv: { customOptions: { keywords: [...CUSTOM_KEYWORDS], allowUnionTypes: true, removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  // Frames as recording.schema.json says: against the history file of the header's schemaVersion (the daemon's own),
  // registered under the major-line id the recording schema refers to.
  const { SCHEMA_VERSION: recorded } = await import('../src/schema/v0.js');
  app.addSchema({ ...schema(`schema/history/v${recorded}.schema.json`), $id: 'urn:abb-rws-daemon:schema:v0' });
  app.addSchema(recording);
  app.post('/line', { schema: { body: { $ref: `${recording.$id}#/definitions/RecordingLine` } } }, async () => ({ ok: true }));
  await app.ready();
  return {
    async check(line: unknown): Promise<{ status: number; body: string }> {
      const r = await app.inject({ method: 'POST', url: '/line', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(line) });
      return { status: r.statusCode, body: r.body };
    },
    close: () => app.close(),
  };
}

/** A recording of two parts with every record kind. */
function everyKind(): RecordingBuilder {
  const b = new RecordingBuilder({ label: 'built', controllers: [{ id: 'rw7', systemId: null, generation: null, robotWare: null }] });
  return b
    .snapshot(0, [rw7()])
    .controller(0, 'rw7', { systemId: 'SYS-7', generation: 'rws2', robotWare: '7.21.4+417', identityCheck: 'confirmed' })
    .state(1, 'rw7', { full: true, changed: { quality: 'live', speedRatio: 100 }, manager: { port: 9403, useHttps: true, groupPath: '/subscription/5' } })
    .state(1, 'rw7', { full: true, ioSignals: { chunk: 1, chunks: 1, full: [{ name: 'doA', type: 'DO', value: '0', lvalue: '0' }] } })
    .call(20, { gen: 'rws2', method: 'getModuleText', args: ['T_ROB1', 'MainModule'], result: { text: 'MODULE MainModule\nENDMODULE' } })
    .call(30, { gen: 'rws2', method: 'getMotionPointer', args: ['T_ROB1'], error: { code: 'RESOURCE_NOT_FOUND', message: 'not found' } })
    .sub(40, 'rw7', { resource: '/rw/iosystem/signals/doA', value: '1' })
    .state(41, 'rw7', { ioSignals: { added: [], changed: [{ name: 'doA', type: 'DO', value: '1', lvalue: '1' }], removed: [] } })
    .delta(50, 'rw7', { panel: rw7({ speed: 50 }).panel })
    .gap(60, { call: 3 })
    .snapshot(60, [rw7({ speed: 50 })], { resync: true })
    .rotate(100)
    .snapshot(100, [rw7({ speed: 50 })], { resync: true })
    .controller(100, 'rw7', { systemId: 'SYS-7', generation: 'rws2', robotWare: '7.21.4+417', identityCheck: 'confirmed' })
    .delta(120, 'rw7', { events: rw7({ eventTitle: 'held *** here' }).events }, { masked: 1 })
    .removed(150, 'rw7')
    .note(200, 'recording stopped: asked to stop')
    .end(201);
}

describe('the in-memory recording builder', () => {
  it('builds lines that recording.schema.json accepts strictly, a daemon recording and a stream capture alike', async () => {
    const v = await lineValidator();
    try {
      const capture = new RecordingBuilder({ source: 'stream-capture' })
        .snapshot(0, [rw7()]).delta(250, 'rw7', { panel: rw7({ speed: 10 }).panel }).end(300, 'closed', { closeCode: 1001 });
      const lines = [...everyKind().allLines(), ...capture.allLines()];
      expect(new Set(lines.map(l => l.kind))).toEqual(new Set(['header', 'frame', 'controller', 'state', 'call', 'sub', 'gap', 'note', 'end']));
      for (const line of lines) {
        const r = await v.check(line);
        expect(r.status, `${JSON.stringify(line).slice(0, 160)}: ${r.body}`).toBe(200);
      }
      // The check bites on the header too: a foreign format or another format version is refused.
      const [header] = everyKind().lines(1);
      expect((await v.check({ ...header, format: 'something-else' })).status).toBe(400);
      expect((await v.check({ ...header, formatVersion: 2 })).status).toBe(400);
      expect((await v.check({ ...header, masking: { ...(header as { masking: object }).masking, rules: ['keys', 'guess'] } })).status).toBe(400);
    } finally {
      await v.close();
    }
  });

  it('chains parts as the recorder does, with end counts that describe each part', () => {
    const b = everyKind();
    const [p1, p2] = [b.lines(1), b.lines(2)];
    expect(p1[0]).toMatchObject({ kind: 'header', part: 1, previous: null, session: b.session });
    expect(p2[0]).toMatchObject({ kind: 'header', part: 2, previous: b.partName(1), startedAt: b.at(100), sessionStartedAt: b.startedAt });
    const end1 = p1.at(-1)!;
    expect(end1).toMatchObject({ kind: 'end', reason: 'rotated', next: b.partName(2), records: p1.length, dropped: { call: 3, state: 0, sub: 0 } });
    expect((end1 as { bytes: number }).bytes).toBe(Buffer.byteLength(b.text(1)) - Buffer.byteLength(`${JSON.stringify(end1)}\n`));
    expect(p2.at(-1)).toMatchObject({ kind: 'end', reason: 'stopped', next: null, dropped: { call: 0, state: 0, sub: 0 } });
    expect(b.partName(2)).toBe(`${b.session}-p0002.jsonl`);
    expect(() => b.note(300, 'after the end')).toThrow(/has ended/);
  });

  it('is read by the replay reader, whole and by part range, from memory and from a folder', async () => {
    const b = everyKind();
    const rec = parseRecording(b.texts());
    expect(rec).toMatchObject({ session: b.session, parts: [1, 2], gaps: 1, label: 'built', source: 'daemon', sessionStartedAt: b.startedAt });
    expect(rec.frames.map(f => [f.t, f.type, f.resync])).toEqual([
      [0, 'snapshot', false], [50, 'delta', false], [60, 'snapshot', true], [100, 'snapshot', true], [120, 'delta', false], [150, 'removed', false],
    ]);
    expect(rec.index.latestCall('rw7', 'getModuleText', ['T_ROB1', 'MainModule'], 1_000)).toMatchObject({ ok: true, result: { text: 'MODULE MainModule\nENDMODULE' } });

    const dir = await mkdtemp(join(tmpdir(), 'daemon-built-'));
    try {
      const paths = await b.writeTo(dir);
      expect(paths.map(p => p.slice(dir.length + 1))).toEqual([b.partName(1), b.partName(2)]);
      const second = await readRecording(dir, { parts: parsePartRange('2') });
      expect(second.parts).toEqual([2]);
      expect(second.frames[0]).toMatchObject({ t: 100, type: 'snapshot', resync: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** The replay's hub: what it broadcasts, in order. */
class CollectingHub implements ReplaySocketHub {
  readonly sent: string[] = [];
  attach(socket: SocketLike, first: string): boolean { socket.send(first); return true; }
  detach(): void {}
  broadcast(frame: string): void { this.sent.push(frame); }
  closeAll(): void {}
  close(): void {}
}

describe('what the recorder writes, replay sends', () => {
  it('frame for frame and byte for byte, across a rotation, ending in the state the stream ended in', async () => {
    const observer = new FakeFrameObserver([rw7(), snapshotOf('rw6', { sysId: 'SYS-6', generation: 'rws1', robotWare: '6.16.3007' })]);
    const files = new MemoryFiles();
    const clock = new ManualClock();
    const recorder = new Recorder({
      observer, tap: new FakeTapHost(), controllers: () => [], token: null, dir: 'recordings', folder: 'custom',
      limits: { maxFileBytes: MIB }, log: new MemoryLog(), daemonVersion: '0.1.0-dev', clientVersion: '1.4.0',
      clock, timers: new ManualTimers(), files,
    });
    await recorder.start({ label: 'roundtrip', content: ['frames'] });
    const sent: string[] = [];
    for (let i = 0; i < 8; i++) {
      clock.advance(100);
      sent.push(observer.delta(rw7({ speed: 90 - i, eventDescription: `${i} ${'y '.repeat(150_000)}` }), ['panel', 'events']));
      await settle();
    }
    clock.advance(100);
    sent.push(observer.removed('rw6'));
    await settle();
    await recorder.stop();
    expect(recorder.status().files.length).toBeGreaterThan(1);

    const texts = [...files.files.keys()].sort().map(name => ({ name, text: files.files.get(name)!.text }));
    const rec = parseRecording(texts);
    expect(rec.parts.length).toBe(texts.length);
    expect(rec.frames.filter(f => f.resync).length).toBe(texts.length - 1);

    const hub = new CollectingHub();
    const stream = new ReplayStream(rec, hub, { paused: true, time: 'recorded' });
    try {
      for (let i = 0; i < rec.frames.length + 2 && stream.status().state !== 'ended'; i++) { stream.control({ action: 'step' }); }
      expect(stream.status().state).toBe('ended');
      // The first snapshot is where the replay starts; each resync snapshot matched the state, so it sent nothing.
      expect(hub.sent).toEqual(sent);
      expect(stream.state.list()).toEqual([...observer.controllers.values()]);
    } finally {
      stream.close();
    }
  });
});

describe('limits shared by the recorder and the replay', () => {
  it('a recording within the default total replays whole: the reader reads exactly that much', () => {
    expect(REPLAY_MAX_BYTES).toBe(RECORDING_LIMIT_DEFAULTS.maxTotalBytes);
    expect({ ...BUILT_LIMITS, durationS: RECORDING_LIMIT_DEFAULTS.durationS }).toEqual(RECORDING_LIMIT_DEFAULTS);
  });

  it('a recording stopped at size-limit replays whole with a reader limit equal to its maxTotalBytes', async () => {
    const observer = new FakeFrameObserver([rw7()]);
    const files = new MemoryFiles();
    const clock = new ManualClock();
    const recorder = new Recorder({
      observer, tap: new FakeTapHost(), controllers: () => [], token: null, dir: 'recordings', folder: 'custom',
      limits: { maxFileBytes: MIB, maxTotalBytes: 2 * MIB }, log: new MemoryLog(), daemonVersion: '0.1.0-dev', clientVersion: '1.4.0',
      clock, timers: new ManualTimers(), files,
    });
    await recorder.start({ label: 'size-limit', content: ['frames'] });
    for (let i = 0; recorder.active && i < 1000; i++) {
      clock.advance(10);
      observer.delta(rw7({ speed: i % 100, eventDescription: `${i} ${'z '.repeat(20_000)}` }), ['panel', 'events']);
      await settle(2);
    }
    await settle();
    const status = recorder.status();
    expect(status).toMatchObject({ active: false, endReason: 'size-limit' });
    expect(status.files.length).toBeGreaterThan(1);
    const total = [...files.files.values()].reduce((n, f) => n + Buffer.byteLength(f.text), 0);
    expect(total).toBe(status.bytes);
    expect(total).toBeLessThanOrEqual(2 * MIB);
    const dir = await mkdtemp(join(tmpdir(), 'abb-rws-size-limit-'));
    try {
      for (const [name, f] of files.files) { await writeFile(join(dir, name), f.text); }
      const rec = await readRecording(dir, { maxBytes: 2 * MIB });
      expect(rec.files).toEqual(status.files);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

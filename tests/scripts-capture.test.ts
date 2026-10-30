import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsClient } from 'ws';
import { SnapshotStream, registerStreamRoute, type StreamSource } from '../src/stream.js';
import { SocketHub } from '../src/wsHub.js';
import { STREAM_PROTOCOL, TOKEN_PROTOCOL_PREFIX, type ControllerSnapshot } from '../src/schema/v0.js';
import { parseRecording } from '../src/replay/reader.js';
import { snapshotOf } from './helpers/recording-fakes.js';

// Real servers, real sockets and a child process: slower than a unit test. On Windows every capture
// also runs the system's permission tool on its folder, seconds each when the machine is busy.
vi.setConfig({ testTimeout: 60_000 });

interface CaptureResult {
  code: number; reason: string | null; frames: number; records: number; bytes: number; masked: number;
  error: string | null; closeCode?: number; file?: string | null;
}
interface CaptureModule {
  capture(opts: Record<string, unknown>): Promise<CaptureResult>;
  parseCaptureArgs(argv: string[], env?: Record<string, string | undefined>): Record<string, unknown>;
  UsageError: new (m: string) => Error;
  CAPTURE_MASKING_RULES: readonly string[];
}

let cap: CaptureModule;
let root: string;
beforeAll(async () => {
  cap = await import('../scripts/capture-stream.mjs' as string) as CaptureModule;
  root = await mkdtemp(join(tmpdir(), 'daemon-capture-'));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const TOKEN = 'capture-token-0123456789abcdefghijklmnopqrstuvwxyz';
let n = 0;
/** An output path in a folder the capture makes (owner-only) itself. */
const outPath = (): string => join(root, `run-${++n}`, 'capture.jsonl');

/** A fleet stand-in whose controllers a test edits, then announces. */
function makeSource(initial: ControllerSnapshot[]) {
  const map = new Map(initial.map(c => [c.id, c]));
  let handler: (id: string) => void = () => {};
  const source: StreamSource & { set(c: ControllerSnapshot): void } = {
    list: () => [...map.values()],
    get: id => map.get(id) ?? null,
    onChanged: cb => { handler = cb; },
    set: c => { map.set(c.id, c); handler(c.id); },
  };
  return source;
}

/** A daemon's HTTP server with a stream over a fake fleet, on an ephemeral loopback port. */
async function daemon(initial: ControllerSnapshot[]) {
  const { createServer } = await import('../src/server.js');
  const app = createServer({ accessToken: TOKEN });
  const hub = new SocketHub({ heartbeatMs: 0 });
  const source = makeSource(initial);
  const stream = new SnapshotStream(source, hub, { debounceMs: 0 });
  await registerStreamRoute(app, stream);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return { app, hub, source, stream, port, done: async () => { stream.close(); await app.close(); } };
}

// Preparing a capture folder runs the platform's own permission tool, which takes seconds on a busy
// machine: the wait is well inside this file's 60 s per test, not at the 5 s that work can reach alone.
const until = async (cond: () => boolean, ms = 45_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) { throw new Error('timed out'); }
    await new Promise(r => setTimeout(r, 10));
  }
};

const linesOf = (text: string): Record<string, unknown>[] =>
  text.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as Record<string, unknown>);

const quiet = { log: () => {} };

describe('capture-stream.mjs against a daemon', () => {
  it('writes a header from the first snapshot, every frame as received, masking markers and an end; replayable', async () => {
    const d = await daemon([snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', robotWare: '7.21.4+417' })]);
    const out = outPath();
    const running = cap.capture({ out, host: '127.0.0.1', port: d.port, token: TOKEN, durationMs: 1500, label: 'unit', ...quiet });
    await until(() => d.hub.size === 1);
    // A second, ordinary consumer: the capture's unmasked frames must be the very strings it receives.
    const seen: string[] = [];
    const other = new WsClient(`ws://127.0.0.1:${d.port}/v0/stream`, [STREAM_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${TOKEN}`]);
    other.on('message', data => seen.push(String(data)));
    await until(() => seen.length === 1);
    d.source.set(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', speed: 50 }));
    await until(() => seen.length === 2);
    d.source.set(snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', speed: 50, eventTitle: `login with ${TOKEN} refused` }));
    await until(() => seen.length === 3);
    d.source.set(snapshotOf('rw7', {
      sysId: 'SYS-7', check: 'confirmed', speed: 50, eventTitle: 'ok', eventDescription: 'retry; Cookie: -http-session-=abc123def456',
    }));
    await until(() => seen.length === 4);
    const r = await running;
    other.terminate();
    await d.done();

    expect(r).toMatchObject({ code: 0, reason: 'duration', error: null, frames: 4, masked: 2 });
    const text = await readFile(out, 'utf8');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('abc123def456');
    const lines = linesOf(text);
    expect(lines.map(l => l.kind)).toEqual(['header', 'frame', 'frame', 'frame', 'frame', 'end']);
    const [header, ...rest] = lines;
    expect(header).toMatchObject({
      kind: 'header', format: 'abb-rws-recording', formatVersion: 1, schemaVersion: '0.15', source: 'stream-capture',
      part: 1, previous: null, label: 'unit', content: ['frames'], client: { version: 'unknown' }, limits: null,
      controllers: [{ id: 'rw7', systemId: 'SYS-7', generation: 'rws2', robotWare: '7.21.4+417' }],
      masking: { rules: [...cap.CAPTURE_MASKING_RULES], values: 1, derived: 0, weakValues: 0 },
    });
    expect(header!.session).toMatch(/^cap-\d{8}T\d{6}Z-unit$/);
    expect(header!.sessionStartedAt).toBe(header!.startedAt);
    expect(typeof (header!.daemon as { version: string }).version).toBe('string');

    const frames = rest.filter(l => l.kind === 'frame');
    expect((frames[0]!.frame as { type: string }).type).toBe('snapshot');
    const ts = frames.map(f => f.t as number);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    // Unmasked deltas are byte for byte what a consumer received; masked ones say so.
    const raw = text.split('\n').filter(l => l.startsWith('{"kind":"frame"'));
    expect(raw[1]).toBe(`{"kind":"frame","t":${ts[1]},"frame":${seen[1]}}`);
    expect(frames[1]!.masked).toBeUndefined();
    expect(frames[2]!.masked).toBeGreaterThan(0);
    expect(frames[3]!.masked).toBeGreaterThan(0);
    expect(JSON.stringify(frames[2]!.frame)).toContain('login with *** refused');

    const end = rest.at(-1)!;
    expect(end).toMatchObject({
      kind: 'end', reason: 'duration', records: 6, next: null, dropped: { call: 0, state: 0, sub: 0 },
      masking: { values: 1, derived: 0, weakValues: 0, maskedRecords: 2, droppedKeys: 0, refusedLines: 0 },
    });
    expect(end.closeCode).toBeUndefined();
    expect(end.bytes).toBe(Buffer.byteLength(text.slice(0, text.lastIndexOf('{"kind":"end"')), 'utf8'));
    expect(end.t as number).toBeGreaterThanOrEqual(ts.at(-1)!);

    // A capture is a recording the daemon can replay.
    const rec = parseRecording([{ name: 'capture.jsonl', text }]);
    expect(rec.frames).toHaveLength(4);
    expect(rec.source).toBe('stream-capture');

    // Every line is a valid recording line (recording.schema.json, strict).
    const Fastify = (await import('fastify')).default;
    const { CUSTOM_KEYWORDS } = await import('../scripts/export-schema.mjs' as string) as { CUSTOM_KEYWORDS: string[] };
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
    for (const l of text.split('\n').filter(x => x.length > 0)) {
      const res = await app.inject({ method: 'POST', url: '/line', headers: { 'content-type': 'application/json' }, payload: l });
      expect(res.statusCode, `${l.slice(0, 160)}: ${res.body}`).toBe(200);
    }
    await app.close();
  });

  it('ends with the close code and exit 2 when the daemon closes the stream', async () => {
    const d = await daemon([snapshotOf('rw6')]);
    const out = outPath();
    const running = cap.capture({ out, host: '127.0.0.1', port: d.port, token: TOKEN, durationMs: 20_000, label: null, ...quiet });
    await until(() => d.hub.size === 1);
    await new Promise(r => setTimeout(r, 100));
    d.stream.close();
    const r = await running;
    await d.done();
    expect(r).toMatchObject({ code: 2, reason: 'closed', closeCode: 1001 });
    const lines = linesOf(await readFile(out, 'utf8'));
    expect(lines.at(-1)).toMatchObject({ kind: 'end', reason: 'closed', closeCode: 1001 });
    expect(lines[0]!.session).toMatch(/^cap-\d{8}T\d{6}Z$/);
  });

  it('ends as interrupted, exit 0, on Ctrl+C', async () => {
    const d = await daemon([snapshotOf('rw6')]);
    const out = outPath();
    const ac = new AbortController();
    const running = cap.capture({ out, host: '127.0.0.1', port: d.port, token: TOKEN, durationMs: 20_000, signal: ac.signal, ...quiet });
    await until(() => d.hub.size === 1);
    await new Promise(r => setTimeout(r, 100));
    ac.abort();
    const r = await running;
    await d.done();
    expect(r).toMatchObject({ code: 0, reason: 'interrupted', frames: 1 });
    expect(linesOf(await readFile(out, 'utf8')).map(l => l.kind)).toEqual(['header', 'frame', 'end']);
  });

  it('refuses an existing --out, and never touches it', async () => {
    const d = await daemon([snapshotOf('rw6')]);
    const out = join(root, 'existing.jsonl');
    await writeFile(out, 'mine\n');
    const r = await cap.capture({ out, host: '127.0.0.1', port: d.port, token: TOKEN, durationMs: 1000, ...quiet });
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/already exists/);
    expect(d.hub.size).toBe(0);
    expect(await readFile(out, 'utf8')).toBe('mine\n');
    await d.done();
  });

  it('refuses a folder that is not the current account`s alone', async () => {
    const d = await daemon([snapshotOf('rw6')]);
    const dir = join(root, 'shared');
    const out = join(dir, 'capture.jsonl');
    await rm(dir, { recursive: true, force: true });
    await import('node:fs/promises').then(fs => fs.mkdir(dir));
    const r = await cap.capture({
      out, host: '127.0.0.1', port: d.port, token: TOKEN, durationMs: 1000, ...quiet,
      fs: { platform: 'win32', ownerOnlyProblem: async () => 'other accounts on this PC can open it' },
    });
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/not this account's alone/);
    expect(d.hub.size).toBe(0);
    await d.done();
  });

  it('writes nothing when the token is refused or no daemon answers', async () => {
    const d = await daemon([snapshotOf('rw6')]);
    const out = outPath();
    const wrong = await cap.capture({ out, host: '127.0.0.1', port: d.port, token: 'wrong-token-wrong-token-wrong-token-1234', durationMs: 1000, ...quiet });
    expect(wrong.code).toBe(1);
    expect(wrong.error).toMatch(/token/);
    await expect(readFile(out, 'utf8')).rejects.toThrow();
    const port = d.port;
    await d.done();
    const none = await cap.capture({ out, host: '127.0.0.1', port, token: TOKEN, durationMs: 1000, ...quiet });
    expect(none.code).toBe(1);
    expect(none.error).toMatch(/no daemon answers/);
  });

  it('a handshake that fails with an error and no close event (Node.js 22) still ends the capture: exit 1, nothing written', async () => {
    const d = await daemon([snapshotOf('rw6')]);
    const out = outPath();
    // A WebSocket as Node.js 22 behaves on a refused upgrade: `error`, then silence, readyState CONNECTING for good.
    class ErrorOnly extends EventTarget {
      readyState = 0;
      constructor(public url: string, public protocols: string[]) {
        super();
        setTimeout(() => this.dispatchEvent(new Event('error')), 20);
      }
      close(): void { /* nothing follows */ }
    }
    const r = await Promise.race([
      cap.capture({ out, host: '127.0.0.1', port: d.port, token: TOKEN, durationMs: 1000, WebSocket: ErrorOnly, ...quiet }),
      new Promise<CaptureResult>((_, reject) => setTimeout(() => reject(new Error('the capture did not end')), 10_000)),
    ]);
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/did not open the stream.*token/);
    await expect(readFile(out, 'utf8')).rejects.toThrow();
    await d.done();
  });

  it('writes nothing when the first snapshot has no valid schemaVersion', async () => {
    const { createServer } = await import('../src/server.js');
    const app = createServer({ accessToken: TOKEN });
    // A stream whose snapshot names no schema version: the header would have to guess one.
    await registerStreamRoute(app, {
      attach: socket => { socket.send(JSON.stringify({ type: 'snapshot', observedAt: new Date().toISOString(), controllers: [] })); return true; },
      detach: () => {},
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const out = outPath();
      const r = await cap.capture({ out, host: '127.0.0.1', port: (app.server.address() as AddressInfo).port, token: TOKEN, durationMs: 2000, ...quiet });
      expect(r.code).toBe(1);
      expect(r.error).toMatch(/no valid schemaVersion/);
      await expect(readFile(out, 'utf8')).rejects.toThrow();
    } finally {
      await app.close();
    }
  });

  it('refuses a host other than this machine', async () => {
    for (const host of ['192.0.2.10', 'example.com', '0.0.0.0', 'robot.local']) {
      expect(() => cap.parseCaptureArgs(['--out', 'x.jsonl', '--host', host])).toThrow(cap.UsageError);
      const r = await cap.capture({ out: join(root, 'never.jsonl'), host, port: 1, token: null, durationMs: 1000, ...quiet });
      expect(r.code).toBe(1);
      expect(r.error).toMatch(/this machine only/);
    }
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(cap.parseCaptureArgs(['--out', 'x.jsonl', '--host', host])).toMatchObject({ host });
    }
  });

  it('checks its arguments', () => {
    const bad = [[], ['--out'], ['--out', 'x', '--port', '0'], ['--out', 'x', '--seconds', '1.5'], ['--out', 'x', '--label', 'Not OK'],
      ['--out', 'x', '--what', '1'], ['--out', 'x', '--out', 'y']];
    for (const argv of bad) { expect(() => cap.parseCaptureArgs(argv), argv.join(' ')).toThrow(cap.UsageError); }
    expect(cap.parseCaptureArgs(['--out', 'x.jsonl', '--token-file', 't'], {})).toMatchObject({
      port: 7810, host: '127.0.0.1', durationMs: 3_600_000, label: null, tokenFileNamed: true,
    });
    expect(cap.parseCaptureArgs(['--out', 'x.jsonl'], { ABB_RWS_DAEMON_TOKEN_FILE: 'from-env' })).toMatchObject({ tokenFileNamed: true });
    expect(cap.parseCaptureArgs(['--out', 'x.jsonl'], {})).toMatchObject({ tokenFileNamed: false });
  });

  it('runs from the command line: exit 0 after --seconds', async () => {
    const d = await daemon([snapshotOf('rw6')]);
    const out = outPath();
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, `${TOKEN}\n`);
    const code = await new Promise<number>(resolve => {
      execFile(process.execPath, ['scripts/capture-stream.mjs', '--port', String(d.port), '--token-file', tokenFile, '--out', out, '--seconds', '1'],
        { cwd: process.cwd(), windowsHide: true }, err => resolve(err ? (err as { code?: number }).code ?? 1 : 0));
    });
    await d.done();
    expect(code).toBe(0);
    const lines = linesOf(await readFile(out, 'utf8'));
    expect(lines.map(l => l.kind)).toEqual(['header', 'frame', 'end']);
    expect(lines.at(-1)).toMatchObject({ reason: 'duration' });
  });
});

#!/usr/bin/env node
/**
 * Captures a running daemon's /v0/stream exactly as a consumer sees it, into a
 * recording file the daemon can replay (`--replay`).
 *
 *   node scripts/capture-stream.mjs --out <file.jsonl> [--port 7810] [--host 127.0.0.1]
 *        [--token-file <path>] [--seconds 3600] [--label <label>]
 *
 * (`npm run capture -- ...` builds the daemon first: this script uses the
 * built masking and owner-only file helpers from dist/.)
 *
 * - Loopback only: --host is 127.0.0.1, localhost or ::1.
 * - The token is offered as the subprotocol `abb-rws-token.<token>` next to
 *   `abb-rws.v0`. It is read from --token-file, else from the file named by
 *   ABB_RWS_DAEMON_TOKEN_FILE, else from the daemon's default token file when
 *   that exists; with none, the stream is opened without a token.
 * - --out is created exclusively and owner-only, in a folder that is the
 *   current account's alone (made so when it does not exist, refused when it
 *   is not), exactly like a part the daemon's recorder writes. An existing
 *   file is refused, never overwritten.
 * - The file is the daemon's recording format: a header (source
 *   `stream-capture`, content `frames`, the snapshot schema version from the
 *   first snapshot: the header is written when that arrives), then one `frame`
 *   record per message with `t` = ms since the socket opened, then an `end`
 *   record when the duration runs out, on Ctrl+C, or when the daemon closes
 *   the stream (its close code in `closeCode`).
 * - Masked like the recorder with what a consumer knows: secret-named keys,
 *   credential-shaped text, secret RAPID literals, and the token as a known
 *   value; a changed frame carries `masked`.
 *
 * Exit status: 0 when the capture ended by its duration or Ctrl+C, 2 when the
 * daemon closed the stream first, 1 when nothing could be captured or a write
 * failed.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

/** The daemon's built modules this script uses; a missing build says how to make one. */
async function loadDist() {
  try {
    const [mask, config, recorder, v0, recording, token] = await Promise.all([
      import('../dist/recording/mask.js'),
      import('../dist/config.js'),
      import('../dist/recording/recorder.js'),
      import('../dist/schema/v0.js'),
      import('../dist/schema/recording.js'),
      import('../dist/token.js'),
    ]);
    return { mask, config, recorder, v0, recording, token };
  } catch (e) {
    throw new Error(`the daemon is not built (${e instanceof Error ? e.message : String(e)}); run npm run build first, or use npm run capture`);
  }
}

const dist = await loadDist();
const { SecretValues, maskFrame } = dist.mask;
const { createOwnerOnlyAppend } = dist.config;
const { prepareRecordingFolder } = dist.recorder;
const { RECORDING_LABEL_PATTERN, STREAM_PROTOCOL, TOKEN_PROTOCOL_PREFIX } = dist.v0;
const { RECORDING_FORMAT, RECORDING_FORMAT_VERSION } = dist.recording;

/** The hosts a capture may connect to: this machine only. */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1']);

/** The daemon's default port. */
export const DEFAULT_PORT = 7810;

/** How long a capture runs unless told otherwise (s), and the longest it may run. */
export const DEFAULT_SECONDS = 3600;
export const MAX_SECONDS = 24 * 3600;

/** What a snapshot's schemaVersion looks like (<major>.<minor>). */
const SCHEMA_VERSION_FORM = /^\d+\.\d+$/;

/** The masking rules a capture applies (a consumer sees no client calls, so no argument rule). */
export const CAPTURE_MASKING_RULES = Object.freeze(['keys', 'text', 'rapid', 'values', 'final']);

/** Bytes waiting for the disk at which the capture stops (`writer-behind`) rather than lose a frame. */
export const CAPTURE_QUEUE_MAX = 32 * 1024 * 1024;

/** A command-line mistake: printed with the usage, exit 1. */
export class UsageError extends Error {}

const USAGE = 'usage: node scripts/capture-stream.mjs --out <file.jsonl> [--port 7810] [--host 127.0.0.1]'
  + ' [--token-file <path>] [--seconds 3600] [--label <label>]';

/**
 * The capture's options from its command line (and ABB_RWS_DAEMON_TOKEN_FILE).
 * Throws UsageError. The token itself is read by readToken.
 */
export function parseCaptureArgs(argv, env = process.env) {
  const known = new Set(['--out', '--port', '--host', '--token-file', '--seconds', '--label']);
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') { throw new UsageError(USAGE); }
    if (!known.has(flag)) { throw new UsageError(`unknown argument ${flag}`); }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) { throw new UsageError(`${flag} needs a value`); }
    if (flag in values) { throw new UsageError(`${flag} is given twice`); }
    values[flag] = value;
    i++;
  }
  if (!values['--out']) { throw new UsageError('--out <file.jsonl> is required'); }
  const host = values['--host'] ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new UsageError(`--host must be ${LOOPBACK_HOSTS.join(', ')}: a capture reads a daemon on this machine only`);
  }
  const port = values['--port'] === undefined ? DEFAULT_PORT : Number(values['--port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new UsageError('--port must be a port number (1-65535)'); }
  const seconds = values['--seconds'] === undefined ? DEFAULT_SECONDS : Number(values['--seconds']);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS) {
    throw new UsageError(`--seconds must be a whole number from 1 to ${MAX_SECONDS}`);
  }
  const label = values['--label'] ?? null;
  if (label !== null && !new RegExp(RECORDING_LABEL_PATTERN).test(label)) {
    throw new UsageError('--label must be 1 to 32 lowercase letters, digits or hyphens');
  }
  const named = values['--token-file'] ?? env.ABB_RWS_DAEMON_TOKEN_FILE ?? null;
  return {
    out: resolve(values['--out']),
    host,
    port,
    durationMs: seconds * 1000,
    label,
    tokenFile: named === null ? dist.token.defaultTokenPath() : resolve(named),
    tokenFileNamed: named !== null,
  };
}

/** The token from its file: null when no file was named and the default one does not exist. Throws when a named file cannot be read. */
export function readToken(tokenFile, named) {
  if (!named && !existsSync(tokenFile)) { return null; }
  let text;
  try {
    text = readFileSync(tokenFile, 'utf8');
  } catch (e) {
    throw new Error(`the token file cannot be read (${e && e.code ? e.code : 'error'})`);
  }
  const token = text.trim();
  if (token.length === 0) { throw new Error('the token file is empty'); }
  return token;
}

/** `yyyymmddThhmmssZ`, UTC. */
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

const hostInUrl = (host) => (host.includes(':') ? `[${host}]` : host);

/** A controller hint for the header, from a snapshot's controller. */
function hintOf(c) {
  const identity = c && typeof c.identity === 'object' && c.identity !== null ? c.identity : null;
  const rw = identity && typeof identity.robotWare === 'object' && identity.robotWare !== null ? identity.robotWare : null;
  return {
    id: String(c.id),
    systemId: identity && typeof identity.sysId === 'string' ? identity.sysId : null,
    generation: rw && (rw.generation === 'rws1' || rw.generation === 'rws2') ? rw.generation : null,
    robotWare: rw && typeof rw.raw === 'string' ? rw.raw : null,
  };
}

/** The daemon's version from its health answer (no token needed); `unknown` when it does not answer one. */
async function daemonVersion(base, fetchImpl) {
  try {
    const res = await fetchImpl(`${base}/v0/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) { return { reached: true, version: 'unknown' }; }
    const body = await res.json();
    return { reached: true, version: typeof body?.version === 'string' && body.version ? body.version : 'unknown' };
  } catch {
    return { reached: false, version: 'unknown' };
  }
}

/**
 * Capture the stream into `out` until the duration runs out, `signal` aborts
 * (Ctrl+C) or the daemon closes the stream. Resolves with the exit code, the
 * end reason and the counts; never rejects for a capture problem (the
 * message is in `error`).
 *
 * opts: { out, host, port, token (string | null), durationMs, label,
 *         signal?, log? (line => void, default stderr), fs? (owner-only file
 *         operations, tests), WebSocket?, fetch? }
 */
export async function capture(opts) {
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  const result = (code, reason, extra = {}) => ({ code, reason, frames: 0, records: 0, bytes: 0, masked: 0, error: null, ...extra });
  const out = resolve(opts.out);
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.includes(host)) {
    return result(1, null, { error: `refused host ${host}: a capture reads a daemon on this machine only` });
  }
  if (await lstat(out).then(() => true, () => false)) {
    return result(1, null, { error: 'the output file already exists; a capture never overwrites a file' });
  }
  try {
    await prepareRecordingFolder(dirname(out), opts.fs ?? {});
  } catch (e) {
    return result(1, null, { error: e instanceof Error ? e.message : String(e) });
  }

  const base = `http://${hostInUrl(host)}:${opts.port}`;
  const health = await daemonVersion(base, opts.fetch ?? fetch);
  if (!health.reached) {
    return result(1, null, { error: `no daemon answers at ${base}` });
  }

  const token = opts.token ?? null;
  const secrets = new SecretValues();
  if (token) { secrets.add(token, { kind: 'token' }); }
  const WS = opts.WebSocket ?? globalThis.WebSocket;
  if (typeof WS !== 'function') {
    return result(1, null, { error: 'this Node.js has no WebSocket; Node.js 22 or later is needed' });
  }
  const protocols = token ? [STREAM_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`] : [STREAM_PROTOCOL];
  const url = `ws://${hostInUrl(host)}:${opts.port}/v0/stream`;

  return new Promise((done) => {
    let ws;
    try {
      ws = new WS(url, protocols);
    } catch (e) {
      done(result(1, null, { error: `the stream could not be opened (${e instanceof Error ? e.message : String(e)})` }));
      return;
    }
    let opened = false;
    let t0 = 0;
    let wallStart = 0;
    let header = false;
    let ending = false;
    let handle = null;
    let chain = Promise.resolve();
    let queued = 0;
    let written = 0;
    let records = 0;
    let frames = 0;
    let skipped = 0;
    let maskedRecords = 0;
    let droppedKeys = 0;
    let writeError = null;
    let timer = null;
    const now = () => Math.max(0, Math.round(performance.now() - t0));

    const enqueue = (line) => {
      const data = `${line}\n`;
      const n = Buffer.byteLength(data, 'utf8');
      queued += n;
      records++;
      chain = chain.then(async () => {
        try {
          if (writeError || !handle) { return; }
          await handle.write(data);
          written += n;
        } catch (e) {
          writeError ??= e;
          if (!ending) { finish('error', undefined, `a write failed (${e && e.code ? e.code : 'error'})`); }
        } finally {
          queued -= n;
        }
      });
      if (queued > CAPTURE_QUEUE_MAX && !ending) { finish('writer-behind', undefined, 'the disk did not keep up'); }
    };

    const startFile = (snapshot) => {
      const headerLine = JSON.stringify({
        kind: 'header',
        format: RECORDING_FORMAT,
        formatVersion: RECORDING_FORMAT_VERSION,
        schemaVersion: snapshot.schemaVersion,
        source: 'stream-capture',
        session: `cap-${stamp(wallStart)}${opts.label ? `-${opts.label}` : ''}`,
        part: 1,
        previous: null,
        startedAt: new Date(wallStart).toISOString(),
        sessionStartedAt: new Date(wallStart).toISOString(),
        label: opts.label ?? null,
        content: ['frames'],
        daemon: { version: health.version },
        client: { version: 'unknown' },
        controllers: Array.isArray(snapshot.controllers) ? snapshot.controllers.filter(c => c && typeof c.id === 'string').map(hintOf) : [],
        limits: null,
        masking: { rules: [...CAPTURE_MASKING_RULES], ...secrets.counts() },
      });
      const data = `${headerLine}\n`;
      records++;
      queued += Buffer.byteLength(data, 'utf8');
      chain = chain.then(async () => {
        try {
          handle = await createOwnerOnlyAppend(out, data, opts.fs ?? {});
          written += Buffer.byteLength(data, 'utf8');
        } catch (e) {
          writeError ??= e;
          if (!ending) { finish('error', undefined, `the output file could not be made (${e instanceof Error ? e.message : String(e)})`); }
        } finally {
          queued -= Buffer.byteLength(data, 'utf8');
        }
      });
      header = true;
    };

    const onFrame = (text) => {
      const t = now();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.type !== 'string') {
        skipped++;
        return;
      }
      const m = maskFrame(text, secrets);
      if (m.held) {
        finish('mask-check', undefined, 'a frame still held the token after masking; the capture stopped');
        return;
      }
      if (!header) {
        if (parsed.type !== 'snapshot') { skipped++; return; }
        // The header names the frames' schema version, which a replay serves and validators look up: never a guess.
        if (typeof parsed.schemaVersion !== 'string' || !SCHEMA_VERSION_FORM.test(parsed.schemaVersion)) {
          finish('error', undefined, 'the first snapshot has no valid schemaVersion; nothing was written');
          return;
        }
        startFile(m.masked > 0 ? JSON.parse(m.text) : parsed);
      }
      // The observed text, byte for byte, unless masking changed it. A frame
      // the daemon makes is one line; anything else is written on one line.
      const body = m.masked > 0 || !/[\r\n]/.test(m.text) ? m.text : JSON.stringify(parsed);
      if (m.masked > 0) {
        maskedRecords++;
        droppedKeys += m.droppedKeys;
      }
      enqueue(`{"kind":"frame","t":${t},"frame":${body}${m.masked > 0 ? `,"masked":${m.masked}` : ''}}`);
      frames++;
    };

    function finish(reason, closeCode, message) {
      if (ending) { return; }
      ending = true;
      if (timer) { clearTimeout(timer); timer = null; }
      opts.signal?.removeEventListener?.('abort', onAbort);
      if (reason !== 'closed') {
        try { ws.close(1000, 'capture ended'); } catch { /* already closed */ }
      }
      const exitCode = reason === 'duration' || reason === 'interrupted' ? 0 : reason === 'closed' ? 2 : 1;
      if (!header) {
        const why = message ?? (reason === 'interrupted' ? 'interrupted before the first snapshot; nothing was written'
          : opened ? 'no snapshot arrived; nothing was written'
            : 'the daemon did not open the stream (is the token right? see --token-file)');
        done(result(1, reason, { error: why, closeCode }));
        return;
      }
      if (skipped > 0) {
        enqueue(JSON.stringify({ kind: 'note', t: now(), text: `${skipped} message(s) that were not stream frames, or came before the first snapshot, were not written` }));
      }
      if (message && reason !== 'closed') {
        enqueue(JSON.stringify({ kind: 'note', t: now(), text: `capture stopped: ${message}` }));
      }
      const t = now();
      chain = chain.then(async () => {
        if (handle && !writeError) {
          const end = {
            kind: 'end',
            t,
            reason,
            records: records + 1,
            bytes: written,
            dropped: { call: 0, state: 0, sub: 0 },
            masking: { ...secrets.counts(), maskedRecords, droppedKeys, refusedLines: 0 },
            stats: { stateDiffMsMax: 0 },
            next: null,
            ...(closeCode !== undefined ? { closeCode } : {}),
          };
          const data = `${JSON.stringify(end)}\n`;
          try {
            await handle.write(data);
            written += Buffer.byteLength(data, 'utf8');
            records++;
          } catch (e) {
            writeError ??= e;
          }
        }
        await handle?.close().catch(() => {});
        const error = writeError
          ? `the capture could not be written completely (${writeError instanceof Error ? writeError.message : String(writeError)})`
          : (exitCode === 1 ? message ?? null : null);
        done(result(writeError ? 1 : exitCode, reason, {
          frames, records, bytes: written, masked: maskedRecords, error, closeCode, file: handle ? out : null,
        }));
      });
    }

    function onAbort() { finish('interrupted'); }
    if (opts.signal?.aborted) { finish('interrupted'); return; }
    opts.signal?.addEventListener?.('abort', onAbort, { once: true });

    ws.addEventListener('open', () => {
      opened = true;
      t0 = performance.now();
      wallStart = Date.now();
      log(`capturing ${url} into ${out} for ${Math.round(opts.durationMs / 1000)} s`);
      timer = setTimeout(() => finish('duration'), opts.durationMs);
    });
    ws.addEventListener('message', (ev) => {
      if (ending) { return; }
      if (typeof ev.data !== 'string') { skipped++; return; }
      onFrame(ev.data);
    });
    ws.addEventListener('error', () => {
      // Before the stream is open an error is the handshake failing (a refused token, a port that
      // closed): that is the end, and it is said here because Node.js 22 fires no close event after
      // it (24 does). Once open, the close event that follows says how it ended.
      if (!opened) { finish('error'); }
    });
    ws.addEventListener('close', (ev) => {
      if (ending) { return; }
      finish('closed', typeof ev.code === 'number' ? ev.code : undefined,
        opened ? `the daemon closed the stream (code ${ev.code})` : undefined);
    });
  });
}

/** Run from the command line: returns the exit code. */
export async function main(argv, env = process.env) {
  let opts;
  let token;
  try {
    opts = parseCaptureArgs(argv, env);
    token = readToken(opts.tokenFile, opts.tokenFileNamed);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof UsageError) { process.stderr.write(`${USAGE}\n`); }
    return 1;
  }
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const r = await capture({ ...opts, token, signal: ac.signal });
    if (r.error) { process.stderr.write(`${r.error}\n`); }
    if (r.bytes > 0) {
      process.stderr.write(`capture ended (${r.reason}${r.closeCode !== undefined ? `, close code ${r.closeCode}` : ''}): `
        + `${r.frames} frames, ${r.records} records, ${r.bytes} bytes, ${r.masked} masked\n`);
    }
    return r.code;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) { return false; }
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const run = realpathSync(isAbsolute(arg) ? arg : resolve(arg));
    return process.platform === 'win32' ? self.toLowerCase() === run.toLowerCase() : self === run;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}

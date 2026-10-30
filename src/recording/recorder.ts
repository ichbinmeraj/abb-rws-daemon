import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, posix, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SubscriptionEvent } from 'abb-rws-client';
import {
  createOwnerOnlyAppend, makeOwnerOnlyDir, ownerOnlyDirProblem,
  type ControllerConfig, type OwnerOnlyFsOptions, type OwnerOnlyHandle,
} from '../config.js';
import { groupError } from '../errorMap.js';
import type { Log } from '../fleet.js';
import { userConfigDir } from '../token.js';
import { RECORDING_FORMAT, RECORDING_FORMAT_VERSION, type CallTarget } from '../schema/recording.js';
import {
  RECORDING_LABEL_PATTERN, SCHEMA_VERSION,
  type IdentityGroup, type LinkGroup, type RecordingContent, type RecordingEndReason, type RecordingFolder,
  type RecordingHealth, type RecordingLimits, type RecordingMasking, type RecordingStartRequest, type RecordingStatus,
  type StreamFrame,
} from '../schema/v0.js';
import {
  RecordingActiveError, RecordingBoundsError, RecordingFailedError,
  type ClientTapSink, type FrameObservation, type FrameObserver, type PendingCall, type RecorderControl, type TapHost,
  type TappedManagerView,
} from './contract.js';
import {
  MASKING_RULES, SecretValues, isSecretMethod, isSecretRapidValue, maskCallArgs, maskFrame, maskRecordValue, toPlainJson, type Json,
} from './mask.js';
import {
  FRAME_LINE_MAX_BYTES, RECORDING_LIMIT_DEFAULTS, RecordingWriter, freeDiskBytes, limitsProblem, plainError,
  recordingFolderBytes, recordingSessionName, tightenLimits,
  type FolderFs, type WriterLine, type WriterQueueLimits, type WriterStop,
} from './writer.js';

/**
 * The daemon's recorder. Off unless started (`--record`, or
 * `POST /v0/recording/start`); every recording has a duration. While it runs
 * it writes, to owner-only JSON Lines files in an owner-only folder:
 *   - `frame`: every `/v0/stream` frame as consumers received it (the
 *     recorder observes the stream from inside the daemon; it is no consumer
 *     and adds no request to any controller);
 *   - `controller`: each controller's system id, generation, RobotWare and
 *     identity check whenever they become known or change;
 *   - `call`, `state`, `sub`: what crosses between the daemon and the client
 *     (the fleet's tap reports it to the recording, the ClientTapSink).
 * Everything is masked when it is captured, on a copy (mask.ts); the files
 * never hold a password, a session cookie, an authorization header or the
 * access token.
 */

/** What the recorder writes with when not told otherwise: the real file system. */
export interface RecordingFiles {
  /** Make the folder owner-only, or check that it is, and leave its markers in it. Throws RecordingFailedError. */
  prepareFolder(dir: string): Promise<void>;
  /** Why the folder is no longer the current account's alone, or null. */
  folderProblem(dir: string): Promise<string | null>;
  /** Make a part owner-only with its header line; the handle every later append goes through. */
  create(path: string, firstLine: string): Promise<OwnerOnlyHandle>;
  freeBytes(dir: string): Promise<number>;
  /** The bytes of every recording in the folder. */
  folderBytes(dir: string): Promise<number>;
}

/**
 * The default recordings folder: `recordings` in the per-user folder next to
 * the token file (`%APPDATA%\abb-rws-daemon\recordings` on Windows,
 * `$XDG_CONFIG_HOME` or `~/.config/abb-rws-daemon/recordings` elsewhere),
 * outside any repository wherever the daemon is started from.
 */
export function defaultRecordingDir(
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home?: string,
): string {
  return (platform === 'win32' ? win32 : posix).join(userConfigDir(env, platform, home), 'recordings');
}

/** The files a recordings folder always holds, made once and never overwritten. */
export const RECORDING_MARKERS: Readonly<Record<string, string>> = Object.freeze({
  '.gitignore': '*\n',
  'README.txt': 'Private controller recordings made by abb-rws-daemon. Do not commit or share unsanitized.\n',
});

/**
 * Make the recordings folder owner-only, or check that it already is - an
 * existing folder is never re-permissioned: one that is not the current
 * account's alone is refused - and create the markers (`.gitignore` with `*`
 * and a README line) if they are absent, owner-only and exclusive, never
 * overwriting one. Throws RecordingFailedError in plain words (no path).
 */
export async function prepareRecordingFolder(dir: string, fsOpts: OwnerOnlyFsOptions = {}): Promise<{ made: boolean }> {
  let made: boolean;
  try {
    made = await makeOwnerOnlyDir(dir, fsOpts);
  } catch (e) {
    throw new RecordingFailedError(`the recordings folder could not be made (${plainError(e)})`, { cause: e });
  }
  let problem: string | null;
  try {
    problem = await ownerOnlyDirProblem(dir, fsOpts);
  } catch (e) {
    throw new RecordingFailedError(`who can open the recordings folder could not be checked (${plainError(e)})`, { cause: e });
  }
  if (problem) {
    throw new RecordingFailedError(`the recordings folder is not this account's alone: ${plainError(problem)}`, { cause: problem });
  }
  const exists = fsOpts.stat ?? ((p: string) => stat(p));
  for (const [name, text] of Object.entries(RECORDING_MARKERS)) {
    const path = join(dir, name);
    if (await exists(path).then(() => true, () => false)) { continue; }
    try {
      const handle = await createOwnerOnlyAppend(path, text, fsOpts);
      await handle.close();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') { continue; }
      throw new RecordingFailedError(`the folder marker ${name} could not be made (${plainError(e)})`, { cause: e });
    }
  }
  return { made };
}

/** The real file system, with optional overrides (tests). */
export function realRecordingFiles(fsOpts: OwnerOnlyFsOptions = {}, folderFs: FolderFs = {}): RecordingFiles {
  return {
    prepareFolder: async dir => { await prepareRecordingFolder(dir, fsOpts); },
    folderProblem: dir => ownerOnlyDirProblem(dir, fsOpts),
    create: (path, firstLine) => createOwnerOnlyAppend(path, firstLine, fsOpts),
    freeBytes: dir => freeDiskBytes(dir, folderFs),
    folderBytes: dir => recordingFolderBytes(dir, folderFs),
  };
}

/**
 * The client's version, from the `package.json` next to its resolved entry
 * point (`dist/index.js` -> `../package.json`; the client's `exports` has
 * only `.`, so its package.json cannot be imported), else `unknown`.
 * `resolveEntry` gives the entry's file URL; by default the module
 * resolution of this file.
 */
export function clientVersion(resolveEntry: () => string = resolveClientEntry): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', resolveEntry()), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveClientEntry(): string {
  const resolve = (import.meta as { resolve?: (specifier: string) => string }).resolve;
  if (typeof resolve === 'function') { return resolve('abb-rws-client'); }
  // A loader without import.meta.resolve (a test runner): the package as Node
  // looks it up, in node_modules from this module's folder upwards.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'node_modules', 'abb-rws-client');
    if (existsSync(join(pkg, 'package.json'))) { return pathToFileURL(join(pkg, 'dist', 'index.js')).href; }
    const up = dirname(dir);
    if (up === dir) { throw new Error('abb-rws-client not found'); }
    dir = up;
  }
}

/** Timers the recorder uses (its duration); the real ones by default. */
export interface RecorderTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: RecorderTimers = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clear: h => { clearTimeout(h as ReturnType<typeof setTimeout>); },
};

/** What the recorder is built from. */
export interface RecorderOptions {
  /** The stream: frames are observed from inside the daemon. */
  observer: FrameObserver;
  /** The fleet: the recording is its tap's sink while it runs. */
  tap?: TapHost | null;
  /** The configured controllers, whose passwords the masking knows from the start. */
  controllers?: () => readonly ControllerConfig[];
  /** The access token, masked wherever it would occur. */
  token?: string | null;
  /** The recordings folder. */
  dir: string;
  /** Whether `dir` is the default folder or one given (the status names only this). */
  folder: RecordingFolder;
  /** The daemon's own limits (command line or defaults); a start request may only tighten them. */
  limits?: Partial<RecordingLimits>;
  log: Log;
  daemonVersion: string;
  /** Default: read from the client's package (clientVersion). */
  clientVersion?: string;
  /** Wall clock (ms since the epoch) and monotonic clock (ms); default Date.now and performance.now. */
  clock?: { wall?: () => number; mono?: () => number };
  timers?: RecorderTimers;
  /** Default: the real file system (realRecordingFiles). */
  files?: RecordingFiles;
  /** The writer's queue limits (tests). */
  queue?: Partial<WriterQueueLimits>;
}

const ALL_CONTENT: RecordingContent[] = ['frames', 'calls', 'state'];
const LABEL = new RegExp(RECORDING_LABEL_PATTERN);
const START_FIELDS = new Set(['label', 'content', 'durationS', 'limits']);

interface StartPlan {
  label: string | null;
  content: RecordingContent[];
  limits: RecordingLimits;
}

/** A start request checked against the bounds, and the limits it runs under (tighten-only). Throws RecordingBoundsError. */
export function planRecording(base: RecordingLimits, request: RecordingStartRequest | null | undefined): StartPlan {
  const r = (request ?? {}) as Record<string, unknown>;
  if (typeof r !== 'object' || Array.isArray(r)) { throw new RecordingBoundsError('the start request must be an object'); }
  for (const key of Object.keys(r)) {
    if (!START_FIELDS.has(key)) { throw new RecordingBoundsError(`${key} is not a recording start field`); }
  }
  let label: string | null = null;
  if (r.label !== undefined && r.label !== null) {
    if (typeof r.label !== 'string' || !LABEL.test(r.label)) {
      throw new RecordingBoundsError('label must be 1 to 32 lowercase letters, digits or hyphens');
    }
    label = r.label;
  }
  let content = ALL_CONTENT;
  if (r.content !== undefined) {
    if (!Array.isArray(r.content) || r.content.length === 0
      || r.content.some(c => typeof c !== 'string' || !(ALL_CONTENT as string[]).includes(c))) {
      throw new RecordingBoundsError('content must be a non-empty list of frames, calls and state');
    }
    const asked = new Set(r.content as string[]);
    content = ALL_CONTENT.filter(c => asked.has(c));
  }
  if (r.limits !== undefined && (r.limits === null || typeof r.limits !== 'object' || Array.isArray(r.limits))) {
    throw new RecordingBoundsError('limits must be an object');
  }
  const limits = tightenLimits(base, r.limits as RecordingStartRequest['limits'], r.durationS as number | undefined);
  return { label, content, limits };
}

const zeroMasking = (): RecordingMasking => ({
  values: 0, derived: 0, weakValues: 0, maskedRecords: 0, droppedKeys: 0, refusedLines: 0,
});

/**
 * The recorder as routes, the command line and the health answer use it:
 * one recording at a time, started and stopped on request, ended by its
 * duration or a limit. A recorder failure never fails the daemon: the
 * recording stops, and the status says why.
 */
export class Recorder implements RecorderControl {
  /** The daemon's own limits (a request may only tighten them). */
  readonly limits: RecordingLimits;
  private readonly files: RecordingFiles;
  private readonly client: string;
  private current: RecordingSession | null = null;
  private starting: Promise<RecordingStatus> | null = null;
  private lastError: string | null = null;
  /** The daemon is stopping: no recording starts any more. */
  private halted = false;

  constructor(private readonly opts: RecorderOptions) {
    const limits = { ...RECORDING_LIMIT_DEFAULTS, ...(opts.limits ?? {}) };
    const problem = limitsProblem(limits);
    if (problem) { throw new Error(`recording limits: ${problem}`); }
    this.limits = limits;
    this.files = opts.files ?? realRecordingFiles();
    this.client = opts.clientVersion ?? clientVersion();
  }

  /** Whether a recording runs now. */
  get active(): boolean { return this.current?.active ?? false; }

  async start(request: RecordingStartRequest = {}): Promise<RecordingStatus> {
    if (this.starting || this.current?.active) { throw new RecordingActiveError(); }
    if (this.halted) { throw new RecordingFailedError('the daemon is stopping'); }
    const plan = planRecording(this.limits, request);
    const run = this.begin(plan);
    this.starting = run;
    try {
      return await run;
    } finally {
      this.starting = null;
    }
  }

  async stop(reason: 'stopped' | 'daemon-stop' = 'stopped', opts: { waitMs?: number } = {}): Promise<RecordingStatus> {
    if (reason === 'daemon-stop') { this.halted = true; }
    if (this.starting) {
      const starting = this.starting.then(() => {}, () => {});
      await (opts.waitMs === undefined ? starting : Promise.race([starting, this.delay(opts.waitMs)]));
    }
    const s = this.current;
    if (s && s.active) { await s.end(reason, opts.waitMs); }
    return this.status();
  }

  status(): RecordingStatus {
    const s = this.current;
    if (!s) {
      return {
        active: false, session: null, label: null, content: [], startedAt: null, endsAt: null, endedAt: null,
        folder: this.opts.folder, files: [], records: 0, bytes: 0, dropped: { call: 0, state: 0, sub: 0 },
        masking: zeroMasking(), limits: null, endReason: null, error: this.lastError,
      };
    }
    const status = s.status();
    return this.lastError ? { ...status, error: this.lastError } : status;
  }

  health(): RecordingHealth {
    const s = this.current;
    return { active: s?.active ?? false, since: s?.active ? s.startedAt : null };
  }

  private async begin(plan: StartPlan): Promise<RecordingStatus> {
    const { dir, log } = this.opts;
    try {
      await this.files.prepareFolder(dir);
      const free = await this.files.freeBytes(dir);
      if (free < plan.limits.minFreeBytes) {
        throw new RecordingFailedError(
          `the disk holding the recordings folder has ${free} bytes free, below minFreeBytes (${plan.limits.minFreeBytes})`);
      }
      const used = await this.files.folderBytes(dir);
      if (used >= plan.limits.maxDirBytes) {
        throw new RecordingFailedError(`the recordings folder already holds ${used} bytes of recordings, `
          + `at or above maxDirBytes (${plan.limits.maxDirBytes}); move old recordings elsewhere first`);
      }
    } catch (e) {
      return this.refuse(e, 'the recordings folder could not be used');
    }
    const wall = this.opts.clock?.wall ?? Date.now;
    const session = new RecordingSession({
      name: recordingSessionName(new Date(wall()), plan.label),
      label: plan.label, content: plan.content, limits: plan.limits,
      dir, folder: this.opts.folder, files: this.files,
      observer: this.opts.observer, tap: this.opts.tap ?? null, log,
      daemonVersion: this.opts.daemonVersion, clientVersion: this.client,
      wall, mono: this.opts.clock?.mono ?? (() => performance.now()), timers: this.opts.timers ?? realTimers,
      controllers: this.opts.controllers?.() ?? [], token: this.opts.token ?? null,
      queue: this.opts.queue,
    });
    try {
      await session.open();
    } catch (e) {
      return this.refuse(e, 'the first part could not be made');
    }
    if (this.halted) {
      await session.end('daemon-stop');
      this.current = session;
      throw new RecordingFailedError('the daemon is stopping');
    }
    this.current = session;
    this.lastError = null;
    session.begin();
    return this.status();
  }

  private refuse(e: unknown, what: string): never {
    const message = e instanceof RecordingFailedError ? e.message : `${what} (${plainError(e)})`;
    this.lastError = message;
    // The log may name the folder and keeps the raw error; answers never do.
    const raw = (x: unknown): string => (x instanceof Error ? x.message : String(x));
    const cause = e instanceof Error && e.cause !== undefined ? raw(e.cause) : raw(e);
    this.opts.log.warn({ folder: this.opts.dir, err: cause }, `recording not started: ${message}`);
    throw new RecordingFailedError(message);
  }

  private delay(ms: number): Promise<void> {
    const timers = this.opts.timers ?? realTimers;
    return new Promise(resolve => { timers.set(resolve, ms); });
  }
}

/** A controller's identity as the frames give it (the authority for `call.gen`). */
interface ControllerFacts {
  systemId: string | null;
  generation: 'rws1' | 'rws2' | null;
  robotWare: string | null;
  identityCheck: 'confirmed' | 'unverified' | 'mismatch';
}

const blankFacts = (): ControllerFacts => ({ systemId: null, generation: null, robotWare: null, identityCheck: 'unverified' });

const sameFacts = (a: ControllerFacts, b: ControllerFacts): boolean =>
  a.systemId === b.systemId && a.generation === b.generation && a.robotWare === b.robotWare && a.identityCheck === b.identityCheck;

function identityFacts(f: ControllerFacts, identity: IdentityGroup | null | undefined): void {
  f.systemId = typeof identity?.sysId === 'string' ? identity.sysId : null;
  const gen = identity?.robotWare?.generation;
  f.generation = gen === 'rws1' || gen === 'rws2' ? gen : null;
  f.robotWare = typeof identity?.robotWare?.raw === 'string' ? identity.robotWare.raw : null;
}

function linkFacts(f: ControllerFacts, link: LinkGroup | null | undefined): void {
  const status = link?.identityCheck?.status;
  f.identityCheck = status === 'confirmed' || status === 'mismatch' ? status : 'unverified';
}

/** What the recording knows of one controller's client state: the last view and what was last written. */
interface StateBase {
  view: TappedManagerView;
  /** Each top-level key: the value object last seen, and its serialized form. */
  keys: Map<string, { ref: unknown; json: string }>;
  /** The manager's connection, serialized. */
  manager: string | null;
  /** The I/O signal table: the array last seen, and each signal serialized by name. */
  io: { ref: unknown; byName: Map<string, string> } | null;
  /** The next state record must be full (a dropped or refused one). */
  needFull: boolean;
  /** The part whose full record this controller has. */
  fullPart: number;
}

/** Room left in a record for its envelope when a state record is split. */
const ENVELOPE_BYTES = 512;

const lineBytes = (line: string): number => Buffer.byteLength(line, 'utf8') + 1;
const jsonBytes = (v: Json): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** Split items into groups whose sizes add up to at most `budget` each (one group at least). */
function pack<T>(items: T[], size: (x: T) => number, budget: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const x of items) {
    const s = size(x) + 1;
    if (cur.length > 0 && used + s > budget) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(x);
    used += s;
  }
  if (cur.length > 0 || out.length === 0) { out.push(cur); }
  return out;
}

/** A manager's field, read without letting a getter that throws stop the recording. */
function viewField<T>(read: () => T | undefined): T | null {
  try { return read() ?? null; } catch { return null; }
}

interface SessionConfig {
  name: string;
  label: string | null;
  content: RecordingContent[];
  limits: RecordingLimits;
  dir: string;
  folder: RecordingFolder;
  files: RecordingFiles;
  observer: FrameObserver;
  tap: TapHost | null;
  log: Log;
  daemonVersion: string;
  clientVersion: string;
  wall: () => number;
  mono: () => number;
  timers: RecorderTimers;
  controllers: readonly ControllerConfig[];
  token: string | null;
  queue?: Partial<WriterQueueLimits>;
}

/**
 * One recording, from start to end. It is the fleet tap's sink while it
 * runs; once it has ended it stays inactive, so a tap still holding it passes
 * calls straight through.
 */
class RecordingSession implements ClientTapSink {
  readonly startedAt: string;
  /** When the duration timer fires: set when it is started (begin), from the same instant. */
  private endsAt: string | null = null;
  private endedAt: string | null = null;
  private live = false;
  private readonly content: Set<RecordingContent>;
  private readonly secrets: SecretValues;
  private readonly writer: RecordingWriter;
  private obs: FrameObservation | null = null;
  private tapInstalled = false;
  private timer: unknown = null;
  private readonly t0: number;
  private lastT = 0;
  private seq = 0;
  /** The part being filled (header made). */
  private partNo = 1;
  private readonly ctl = new Map<string, ControllerFacts>();
  private readonly states = new Map<string, StateBase>();
  private readonly counts = { maskedRecords: 0, droppedKeys: 0, refusedLines: 0 };
  private stateDiffMsMax = 0;
  private hints: Array<{ id: string; systemId: string | null; generation: 'rws1' | 'rws2' | null; robotWare: string | null }> = [];
  private inResync = false;
  private ending: Promise<void> | null = null;
  private problem: string | null = null;

  constructor(private readonly cfg: SessionConfig) {
    const wallNow = cfg.wall();
    this.t0 = cfg.mono();
    this.startedAt = new Date(wallNow).toISOString();
    this.content = new Set(cfg.content);
    this.secrets = new SecretValues({
      commonText: () => cfg.observer.snapshotFrame(),
      onWeak: controller => {
        cfg.log.warn({ controller: controller ?? null, weakValues: this.secrets.counts().weakValues },
          'a known secret value is too short or too common to be masked by value; it is still masked by key and by shape');
      },
    });
    this.writer = new RecordingWriter({
      session: cfg.name,
      limits: cfg.limits,
      clock: () => this.now(),
      create: (name, headerLine) => cfg.files.create(join(cfg.dir, name), headerLine),
      checkBeforePart: () => this.checkBeforePart(),
      header: (part, name, previous) => this.headerLine(part, name, previous),
      resync: cause => this.resync(cause),
      endExtras: () => ({ masking: this.masking(), stats: { stateDiffMsMax: this.stateDiffMsMax } }),
      onStop: stop => { void this.end(stop.reason, undefined, stop.message); },
      onStateDropped: id => { const b = this.states.get(id); if (b) { b.needFull = true; } },
      onRotated: (_from, to) => { cfg.log.info({ session: cfg.name, part: to }, 'recording continues in a new part'); },
      queue: cfg.queue,
    });
  }

  get active(): boolean { return this.live; }

  /** Learn the known secrets and make the first part. Throws why it could not be made. */
  async open(): Promise<void> {
    for (const c of this.cfg.controllers) {
      if (typeof c.password === 'string') { this.secrets.add(c.password, { user: c.username, controller: c.id }); }
    }
    if (this.cfg.token) { this.secrets.add(this.cfg.token, { kind: 'token' }); }
    try {
      const snap = JSON.parse(this.cfg.observer.snapshotFrame()) as StreamFrame;
      if (snap.type === 'snapshot' && Array.isArray(snap.controllers)) {
        this.hints = snap.controllers.map(c => {
          const f = blankFacts();
          identityFacts(f, c.identity);
          return { id: c.id, systemId: f.systemId, generation: f.generation, robotWare: f.robotWare };
        });
      }
    } catch { /* the hint is only a hint */ }
    await this.writer.open();
  }

  /** Begin observing: the first snapshot, then every frame; the tap; the duration. */
  begin(): void {
    const { cfg } = this;
    this.live = true;
    // The duration counts from here, where its timer starts (making the first part took time).
    this.endsAt = new Date(cfg.wall() + cfg.limits.durationS * 1000).toISOString();
    cfg.log.info({
      session: cfg.name, folder: cfg.dir, content: cfg.content, limits: cfg.limits, endsAt: this.endsAt,
    }, 'recording started');
    this.timer = cfg.timers.set(() => { void this.end('duration'); }, cfg.limits.durationS * 1000);
    try {
      this.obs = cfg.observer.observe(text => this.onFrame(text));
      this.onFrame(this.obs.first);
    } catch (e) {
      this.fail(e);
      return;
    }
    if (cfg.tap && this.live) {
      try {
        cfg.tap.setTap(this);
        this.tapInstalled = true;
      } catch (e) {
        this.fail(e);
      }
    }
  }

  /**
   * End the recording: no more capture, the tap and the observer let go, the
   * last part closed with its end record. With `waitMs`, waits at most that
   * long for the files to be written.
   */
  end(reason: RecordingEndReason, waitMs?: number, message: string | null = null): Promise<void> {
    if (!this.ending) {
      this.live = false;
      try { this.obs?.stop(); } catch { /* gone */ }
      this.obs = null;
      if (this.tapInstalled) {
        this.tapInstalled = false;
        try { this.cfg.tap?.setTap(null); } catch { /* the fleet's own problem */ }
      }
      if (this.timer !== null) {
        this.cfg.timers.clear(this.timer);
        this.timer = null;
      }
      this.endedAt = new Date(this.cfg.wall()).toISOString();
      if (message && !this.problem) { this.problem = message; }
      this.ending = this.writer.finish(reason).then(() => {
        const endReason = this.writer.endReason ?? reason;
        const fields = {
          session: this.cfg.name, reason: endReason, records: this.writer.records, bytes: this.writer.bytes,
          dropped: this.writer.dropped, ...(this.error ? { error: this.error } : {}),
        };
        if (endReason === 'error' || endReason === 'mask-check' || endReason === 'writer-behind') {
          this.cfg.log.error(fields, 'recording stopped');
        } else {
          this.cfg.log.info(fields, 'recording stopped');
        }
      });
    }
    if (waitMs === undefined) { return this.ending; }
    return Promise.race([this.ending, new Promise<void>(resolve => { this.cfg.timers.set(resolve, waitMs); })]);
  }

  private get error(): string | null { return this.writer.error ?? this.problem; }

  status(): RecordingStatus {
    const live = this.live;
    return {
      active: live,
      session: this.cfg.name,
      label: this.cfg.label,
      content: [...this.cfg.content],
      startedAt: this.startedAt,
      endsAt: live ? this.endsAt : null,
      endedAt: this.endedAt,
      folder: this.cfg.folder,
      files: this.writer.files,
      records: this.writer.records,
      bytes: this.writer.bytes,
      dropped: this.writer.dropped,
      masking: this.masking(),
      limits: { ...this.cfg.limits },
      endReason: live ? null : this.writer.endReason,
      error: this.error,
    };
  }

  // --- ClientTapSink ---------------------------------------------------------

  call(target: CallTarget, id: string | null, method: string, args: readonly unknown[]): PendingCall | null {
    if (!this.live) { return null; }
    try {
      const started = this.cfg.mono();
      // Masked now, before anything else can happen; the secret values join the masking now too.
      const masked = maskCallArgs(method, args, this.secrets, id ?? undefined);
      if (!this.content.has('calls')) { return null; }
      const seq = ++this.seq;
      let settled = false;
      return {
        done: outcome => {
          if (settled || !this.live) { return; }
          settled = true;
          try {
            this.callDone(target, id, method, masked, seq, started, outcome);
          } catch (e) {
            this.fail(e);
          }
        },
      };
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  state(id: string, manager: TappedManagerView | null): void {
    if (!this.live) { return; }
    try {
      if (manager === null) {
        this.states.delete(id);
        return;
      }
      let base = this.states.get(id);
      if (!base) {
        base = { view: manager, keys: new Map(), manager: null, io: null, needFull: true, fullPart: 0 };
        this.states.set(id, base);
      } else {
        base.view = manager;
      }
      if (!this.content.has('state')) { return; }
      if (!this.writer.admit('state', id)) {
        base.needFull = true;
        return;
      }
      const t = this.now();
      const r = this.stateLines(id, base, base.needFull || base.fullPart !== this.partNo, t);
      // One block: a split record or a chunked signal table never straddles a rotation.
      if (!this.writer.pushBlock(r.lines.map(line => ({ kind: 'state' as const, line })))) { return; }
      if (r.refused) {
        base.needFull = true;
        this.writer.gap('mask-check', { state: 1 });
      }
    } catch (e) {
      this.fail(e);
    }
  }

  sub(id: string, event: SubscriptionEvent): void {
    if (!this.live || !this.content.has('calls')) { return; }
    try {
      if (!this.writer.admit('sub')) { return; }
      const t = this.now();
      const r = this.finalize({ kind: 'sub', t, id, event: toPlainJson(event) }, undefined, ['event']);
      if (!r) {
        this.writer.gap('mask-check', { sub: 1 });
        return;
      }
      this.writer.push('sub', r);
    } catch (e) {
      this.fail(e);
    }
  }

  // --- capture -----------------------------------------------------------------

  /** ms since the recording began, never decreasing. */
  private now(): number {
    const t = Math.max(this.lastT, Math.floor(this.cfg.mono() - this.t0));
    this.lastT = t;
    return t;
  }

  private onFrame(text: string): void {
    if (!this.live) { return; }
    try {
      const t = this.now();
      // The frame and the controller records it brought are one block, so a
      // rotation never comes between them (t stays in order within a part).
      const block: WriterLine[] = [];
      if (this.content.has('frames')) {
        const r = this.frameLine(text, t, false);
        if ('stop' in r) {
          void this.end(r.stop, undefined, r.message);
          return;
        }
        block.push({ kind: 'frame', line: r.line });
      }
      let frame: StreamFrame | null = null;
      try { frame = JSON.parse(text) as StreamFrame; } catch { frame = null; }
      let refused = false;
      if (frame) {
        for (const id of this.noteFrame(frame)) {
          const line = this.controllerLine(id, t);
          if (line === null) {
            refused = true;
            continue;
          }
          block.push({ kind: 'controller', line });
        }
      }
      if (!this.writer.pushBlock(block)) { return; }
      if (refused) { this.writer.gap('mask-check', {}); }
    } catch (e) {
      this.fail(e);
    }
  }

  /** A frame record's line, or why the recording must stop instead. A frame is never shortened or left out. */
  private frameLine(text: string, t: number, resync: boolean): { line: string } | { stop: RecordingEndReason; message: string } {
    const m = maskFrame(text, this.secrets);
    if (m.held) {
      return { stop: 'mask-check', message: 'a frame still held a known secret after masking; the recording stopped rather than leave it out' };
    }
    if (m.masked > 0) {
      this.counts.maskedRecords++;
      this.counts.droppedKeys += m.droppedKeys;
    }
    const line = `{"kind":"frame","t":${t}${resync ? ',"resync":true' : ''},"frame":${m.text}${m.masked > 0 ? `,"masked":${m.masked}` : ''}}`;
    if (lineBytes(line) > FRAME_LINE_MAX_BYTES) {
      return { stop: 'error', message: `a frame was larger than ${FRAME_LINE_MAX_BYTES} bytes` };
    }
    return { line };
  }

  /** Keep each controller's identity as the frames give it; the ids whose identity became known or changed. */
  private noteFrame(frame: StreamFrame): string[] {
    const changed: string[] = [];
    const set = (id: string, f: ControllerFacts): void => {
      const old = this.ctl.get(id);
      if (!old || !sameFacts(old, f)) {
        this.ctl.set(id, f);
        changed.push(id);
      }
    };
    if (frame.type === 'snapshot' && Array.isArray(frame.controllers)) {
      const seen = new Set<string>();
      for (const c of frame.controllers) {
        if (typeof c?.id !== 'string') { continue; }
        seen.add(c.id);
        const f = blankFacts();
        identityFacts(f, c.identity);
        linkFacts(f, c.link);
        set(c.id, f);
      }
      for (const id of [...this.ctl.keys()]) {
        if (!seen.has(id)) { this.forget(id); }
      }
    } else if (frame.type === 'delta' && typeof frame.id === 'string') {
      const groups = frame.groups ?? {};
      const f = { ...(this.ctl.get(frame.id) ?? blankFacts()) };
      if ('identity' in groups) { identityFacts(f, groups.identity); }
      if (groups.link) { linkFacts(f, groups.link); }
      set(frame.id, f);
    } else if (frame.type === 'removed' && typeof frame.id === 'string') {
      this.forget(frame.id);
    }
    return changed;
  }

  private forget(id: string): void {
    this.ctl.delete(id);
    this.states.delete(id);
  }

  private controllerLine(id: string, t: number): string | null {
    const f = this.ctl.get(id) ?? blankFacts();
    return this.finalize({
      kind: 'controller', t, id, systemId: f.systemId, generation: f.generation, robotWare: f.robotWare, identityCheck: f.identityCheck,
    });
  }

  private callDone(
    target: CallTarget, id: string | null, method: string, masked: ReturnType<typeof maskCallArgs>, seq: number, started: number,
    outcome: { ok: true; result: unknown } | { ok: false; error: unknown },
  ): void {
    if (!this.writer.admit('call')) { return; }
    const t = this.now();
    const ms = Math.max(0, Math.round(this.cfg.mono() - started));
    const rec: { [key: string]: Json } = {
      kind: 'call', t, target, id, gen: id === null ? null : this.ctl.get(id)?.generation ?? null, seq, method,
      args: masked.args as Json, ms, ok: outcome.ok,
    };
    if (outcome.ok) {
      rec.result = isSecretMethod(method) || isSecretRapidValue(method, masked.args)
        ? { $omitted: 'secret' } : toPlainJson(outcome.result);
    } else {
      // The daemon's own shape for a failure, typed and masked as on the wire.
      rec.error = toPlainJson(groupError(outcome.error));
    }
    const line = this.finalize(rec, { masked: masked.tally.replaced, droppedKeys: masked.tally.droppedKeys }, ['result', 'args']);
    if (line === null) {
      this.writer.gap('mask-check', { call: 1 });
      return;
    }
    this.writer.push('call', line);
  }

  /**
   * Mask a record (rules 1-4, then the final check) and make its line: null
   * when the final check refuses it (counted). A line over `maxRecordBytes`
   * keeps its envelope: the fields named in `shrink`, in order, are replaced
   * by their size until it fits.
   */
  private finalize(
    rec: { [key: string]: Json }, extra: { masked: number; droppedKeys: number } = { masked: 0, droppedKeys: 0 }, shrink: string[] = [],
  ): string | null {
    const m = maskRecordValue(rec, this.secrets);
    if (m.refused) {
      this.counts.refusedLines++;
      return null;
    }
    const out = m.value as { [key: string]: Json };
    const n = m.masked + extra.masked;
    if (n > 0) {
      out.masked = n;
      this.counts.maskedRecords++;
      this.counts.droppedKeys += m.droppedKeys + extra.droppedKeys;
    }
    let line = JSON.stringify(out);
    for (const key of shrink) {
      if (lineBytes(line) <= this.cfg.limits.maxRecordBytes) { break; }
      if (!(key in out) || typeof out[key] === 'string') { continue; }
      const omitted = { $omitted: { bytes: jsonBytes(out[key]!) } };
      out[key] = key === 'args' ? [omitted] : omitted;
      line = JSON.stringify(out);
    }
    return line;
  }

  /**
   * The state records for one controller: the top-level keys that changed
   * (all of them when `full`), compared by reference first and then by
   * value; the manager's connection when it changed; the I/O signal table by
   * signal (whole, in chunks, when `full`). The event log is never recorded
   * here. A record over `maxRecordBytes` is split by key, and a key still
   * over it is replaced by its size; the signal table is chunked instead.
   */
  private stateLines(id: string, base: StateBase, full: boolean, t: number): { lines: string[]; refused: boolean } {
    const began = this.cfg.mono();
    const lines: string[] = [];
    let refused = false;
    const state = (viewField(() => base.view.state) ?? {}) as unknown as Record<string, unknown>;
    const budget = Math.max(1024, this.cfg.limits.maxRecordBytes - ENVELOPE_BYTES);

    // The signal table first: a table with a name twice cannot be diffed, and is written whole.
    const sigs = state.ioSignals;
    let io: Map<string, { plain: Json; json: string }> | null = null;
    if (Array.isArray(sigs) && (full || sigs !== base.io?.ref)) {
      io = new Map();
      let twice = false;
      for (const s of sigs) {
        const plain = toPlainJson(s);
        const json = JSON.stringify(plain);
        const name = typeof (s as { name?: unknown } | null)?.name === 'string' ? (s as { name: string }).name : json;
        if (io.has(name)) { twice = true; }
        io.set(name, { plain, json });
      }
      if (twice && !full) { full = true; }
    }

    // Top-level keys.
    const keys = Object.keys(state).filter(k => k !== 'eventLog' && k !== 'ioSignals');
    const changed: Array<[string, Json]> = [];
    for (const k of keys) {
      const v = state[k];
      const prev = base.keys.get(k);
      if (!full && prev && prev.ref === v) { continue; }
      const plain = toPlainJson(v);
      const json = JSON.stringify(plain);
      if (!full && prev && prev.json === json) {
        prev.ref = v;
        continue;
      }
      base.keys.set(k, { ref: v, json });
      changed.push([k, plain]);
    }
    for (const k of [...base.keys.keys()]) {
      if (!keys.includes(k)) {
        base.keys.delete(k);
        changed.push([k, null]);
      }
    }
    const info = {
      port: viewField(() => base.view.currentPort),
      useHttps: viewField(() => base.view.currentUseHttps),
      groupPath: viewField(() => base.view.subscriptionGroupPath),
    };
    const infoJson = JSON.stringify(info);
    const withManager = full || infoJson !== base.manager;
    base.manager = infoJson;

    if (changed.length > 0 || withManager) {
      const items: Array<{ k: string; v: Json; masked: number; droppedKeys: number }> = [];
      for (const [k, v] of changed) {
        const m = maskRecordValue({ [k]: v }, this.secrets);
        if (m.refused) { refused = true; break; }
        const out = m.value as { [key: string]: Json };
        if (!(k in out)) {
          this.counts.droppedKeys += m.droppedKeys;
          continue;   // the key itself was secret-shaped: dropped
        }
        let value = out[k]!;
        if (Buffer.byteLength(k) + jsonBytes(value) + 4 > budget) { value = { $omitted: { bytes: jsonBytes(value) } }; }
        items.push({ k, v: value, masked: m.masked, droppedKeys: m.droppedKeys });
      }
      const mgr = withManager && !refused ? maskRecordValue(info as unknown as Json, this.secrets) : null;
      if (mgr?.refused) { refused = true; }
      if (!refused) {
        const groups = pack(items, x => Buffer.byteLength(x.k) + jsonBytes(x.v) + 4, budget);
        groups.forEach((group, i) => {
          const rec: { [key: string]: Json } = { kind: 'state', t, id };
          if (full) { rec.full = true; }
          if (group.length > 0) { rec.changed = Object.fromEntries(group.map(x => [x.k, x.v])); }
          let masked = group.reduce((n, x) => n + x.masked, 0);
          let dropped = group.reduce((n, x) => n + x.droppedKeys, 0);
          if (i === 0 && mgr) {
            rec.manager = mgr.value;
            masked += mgr.masked;
            dropped += mgr.droppedKeys;
          }
          if (group.length === 0 && !(i === 0 && mgr)) { return; }
          if (masked > 0) {
            rec.masked = masked;
            this.counts.maskedRecords++;
            this.counts.droppedKeys += dropped;
          }
          lines.push(JSON.stringify(rec));
        });
      } else {
        this.counts.refusedLines++;
      }
    }

    if (io && !refused) {
      const prevByName = base.io?.byName ?? new Map<string, string>();
      const maskOne = (v: Json): { v: Json; masked: number; droppedKeys: number } | null => {
        const m = maskRecordValue(v, this.secrets);
        return m.refused ? null : { v: m.value, masked: m.masked, droppedKeys: m.droppedKeys };
      };
      const fit = (x: { v: Json }): { v: Json } => (jsonBytes(x.v) + 2 > budget ? { ...x, v: { $omitted: { bytes: jsonBytes(x.v) } } } : x);
      const emit = (rec: { [key: string]: Json }, masked: number, dropped: number): void => {
        if (masked > 0) {
          rec.masked = masked;
          this.counts.maskedRecords++;
          this.counts.droppedKeys += dropped;
        }
        lines.push(JSON.stringify(rec));
      };
      if (full) {
        const all: Array<{ v: Json; masked: number; droppedKeys: number }> = [];
        for (const { plain } of io.values()) {
          const m = maskOne(plain);
          if (!m) { refused = true; break; }
          all.push({ ...m, ...fit(m) });
        }
        if (!refused) {
          const chunks = pack(all, x => jsonBytes(x.v), budget);
          chunks.forEach((chunk, i) => emit(
            { kind: 'state', t, id, full: true, ioSignals: { chunk: i + 1, chunks: chunks.length, full: chunk.map(x => x.v) } },
            chunk.reduce((n, x) => n + x.masked, 0), chunk.reduce((n, x) => n + x.droppedKeys, 0),
          ));
        }
      } else {
        const items: Array<{ list: 'added' | 'changed' | 'removed'; v: Json; masked: number; droppedKeys: number }> = [];
        for (const [name, { plain, json }] of io) {
          const before = prevByName.get(name);
          if (before === json) { continue; }
          const m = maskOne(plain);
          if (!m) { refused = true; break; }
          items.push({ list: before === undefined ? 'added' : 'changed', ...m, ...fit(m) });
        }
        for (const name of prevByName.keys()) {
          if (refused || io.has(name)) { continue; }
          const m = maskOne(name);
          if (!m) { refused = true; break; }
          items.push({ list: 'removed', ...m });
        }
        if (!refused && items.length > 0) {
          for (const group of pack(items, x => jsonBytes(x.v), budget)) {
            const diff = {
              added: group.filter(x => x.list === 'added').map(x => x.v),
              changed: group.filter(x => x.list === 'changed').map(x => x.v),
              removed: group.filter(x => x.list === 'removed').map(x => x.v),
            };
            emit({ kind: 'state', t, id, ioSignals: diff }, group.reduce((n, x) => n + x.masked, 0), group.reduce((n, x) => n + x.droppedKeys, 0));
          }
        }
      }
      if (refused) { this.counts.refusedLines++; }
      base.io = { ref: sigs, byName: new Map([...io].map(([name, x]) => [name, x.json])) };
    }

    if (full && !refused) {
      base.needFull = false;
      base.fullPart = this.partNo;
    }
    this.stateDiffMsMax = Math.max(this.stateDiffMsMax, Math.round(this.cfg.mono() - began));
    return { lines, refused };
  }

  // --- the writer's hooks ----------------------------------------------------------

  private headerLine(part: number, _name: string, previous: string | null): string {
    if (part > 1) {
      this.partNo = part;
      this.hints = [...this.ctl].map(([id, f]) => ({ id, systemId: f.systemId, generation: f.generation, robotWare: f.robotWare }));
    }
    const counts = this.secrets.counts();
    return JSON.stringify({
      kind: 'header',
      format: RECORDING_FORMAT,
      formatVersion: RECORDING_FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      source: 'daemon',
      session: this.cfg.name,
      part,
      previous,
      startedAt: part === 1 ? this.startedAt : new Date(this.cfg.wall()).toISOString(),
      sessionStartedAt: this.startedAt,
      label: this.cfg.label,
      content: [...this.cfg.content],
      daemon: { version: this.cfg.daemonVersion },
      client: { version: this.cfg.clientVersion },
      controllers: this.hints,
      limits: { ...this.cfg.limits },
      masking: { rules: [...MASKING_RULES], values: counts.values, derived: counts.derived, weakValues: counts.weakValues },
    });
  }

  /**
   * The lines that let a reader start here, captured now: at a part's top
   * the controller records, a resync snapshot and full state records; after
   * a gap the snapshot, the full state records and the controller records.
   */
  private resync(cause: 'part' | 'gap'): WriterLine[] {
    this.inResync = true;
    try {
      const t = this.now();
      let snap: string | null = null;
      try { snap = this.cfg.observer.snapshotFrame(); } catch { snap = null; }
      if (snap !== null) {
        try { this.noteFrame(JSON.parse(snap) as StreamFrame); } catch { /* not JSON: nothing learned */ }
      }
      const controllers: WriterLine[] = [];
      for (const id of this.ctl.keys()) {
        const line = this.controllerLine(id, t);
        if (line !== null) { controllers.push({ kind: 'controller', line }); }
      }
      const frames: WriterLine[] = [];
      if (snap !== null && this.content.has('frames')) {
        const r = this.frameLine(snap, t, true);
        if ('stop' in r) {
          queueMicrotask(() => { void this.end(r.stop, undefined, r.message); });
        } else {
          frames.push({ kind: 'frame', line: r.line });
        }
      }
      const states: WriterLine[] = [];
      if (this.content.has('state')) {
        for (const [id, base] of this.states) {
          if (!this.ctl.has(id)) { continue; }
          const r = this.stateLines(id, base, true, t);
          if (r.refused) {
            base.needFull = true;
            continue;
          }
          for (const line of r.lines) { states.push({ kind: 'state', line }); }
        }
      }
      return cause === 'part' ? [...controllers, ...frames, ...states] : [...frames, ...states, ...controllers];
    } finally {
      this.inResync = false;
    }
  }

  /** Before the next part: the folder is still owner-only, the disk has room, the folder is under its limit. */
  private async checkBeforePart(): Promise<WriterStop | null> {
    const { files, dir, limits } = this.cfg;
    let problem: string | null;
    try {
      problem = await files.folderProblem(dir);
    } catch (e) {
      problem = `it could not be checked (${plainError(e)})`;
    }
    if (problem) { return { reason: 'error', message: `the recordings folder is not this account's alone: ${plainError(problem)}` }; }
    const free = await files.freeBytes(dir);
    if (free < limits.minFreeBytes) {
      return { reason: 'disk-space', message: `free disk space fell to ${free} bytes, below minFreeBytes (${limits.minFreeBytes})` };
    }
    const used = await files.folderBytes(dir) + this.writer.queued;
    if (used >= limits.maxDirBytes) {
      return { reason: 'dir-limit', message: `the recordings folder reached maxDirBytes (${limits.maxDirBytes})` };
    }
    return null;
  }

  private masking(): RecordingMasking {
    return { ...this.secrets.counts(), ...this.counts };
  }

  /** A recorder fault: the recording stops; the daemon carries on. */
  private fail(e: unknown): void {
    this.cfg.log.error({ session: this.cfg.name, err: e instanceof Error ? e.message : String(e) }, 'recording failed');
    void this.end('error', undefined, `the recorder failed (${plainError(e)})`);
  }
}


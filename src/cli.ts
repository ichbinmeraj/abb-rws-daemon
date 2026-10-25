#!/usr/bin/env node
import { resolve } from 'node:path';
import { flagsOf, helpText, parseArgv, switchFlags, valueFlags, versionText } from './cliOptions.js';
import {
  emptyDiscoverySettings, loadConfigFile, saveConfig, saveDiscoverySettings, type ControllerConfig, type DiscoverySettings,
} from './config.js';
import { discover } from './discovery.js';
import { ControllerFleet } from './fleet.js';
import { hostAllowlist } from './localGuard.js';
import { readPassport } from './passport.js';
import type { ClientTapSink, TapHost } from './recording/contract.js';
import { Recorder, defaultRecordingDir } from './recording/recorder.js';
import { tapFunction } from './recording/tap.js';
import { RECORDING_LIMIT_BOUNDS } from './recording/writer.js';
import { registerRecordingRoutes } from './recordingRoutes.js';
import { parsePartRange, type PartRange } from './replay/reader.js';
import { createReplayDaemon, type ReplayDaemon } from './replayDaemon.js';
import { registerAdminRoutes, registerControllerRoutes } from './routes.js';
import { DaemonStop, onStopSignals } from './stop.js';
import { SnapshotStream, registerStreamRoute } from './stream.js';
import { SocketHub } from './wsHub.js';
import { BIND_HOST, DAEMON_VERSION, DEFAULT_PORT, NO_RECORDING, createServer, logFatalErrors } from './server.js';
import {
  RECORDING_LABEL_PATTERN, REPLAY_SPEED_MAX, REPLAY_SPEED_MIN, TOKEN_HEADER,
  type RecordingContent, type RecordingLimits, type ReplayTimeMode,
} from './schema/v0.js';
import { defaultTokenPath, loadOrCreateToken } from './token.js';

const DEFAULT_CONFIG = 'abb-rws-daemon.config.json';
const MIB = 1024 * 1024;

/**
 * Stop at launch, saying why. Only for what is wrong with how the daemon was
 * started. A command line or an environment it does not understand is
 * refused before anything is read, made or opened; a token file or a
 * recording it cannot use, when it is read.
 */
function refuse(message: string): never {
  process.stderr.write(`abb-rws-daemon: ${message}\n`);
  process.exit(1);
}

const parsed = parseArgv(process.argv.slice(2));
const argv = parsed.argv;
// --help and --version answer and end here, whatever else was given and
// whatever the environment holds: nothing has been read, made or opened.
// The exit waits for the text to be handed over: a console or a pipe may take it later.
async function answer(text: string): Promise<never> {
  await new Promise<void>(written => { process.stdout.write(text, () => written()); });
  process.exit(0);
}
if (parsed.help) { await answer(helpText(DAEMON_VERSION)); }
if (parsed.version) { await answer(versionText(DAEMON_VERSION)); }
const env = process.env;

// No environment variable starts a recording: one set in a shell profile, a
// service definition or a compose file would record on every restart without
// anyone seeing it. A recording starts with --record (visible in whatever
// starts the daemon) or POST /v0/recording/start. A variable someone expects
// to record never silently does nothing either: the daemon does not start.
if (env.ABB_RWS_DAEMON_RECORD !== undefined) {
  refuse('ABB_RWS_DAEMON_RECORD is set, but no environment variable starts a recording: a recording starts only with '
    + '--record or POST /v0/recording/start. Unset ABB_RWS_DAEMON_RECORD to start the daemon.');
}

// The options are one table (cliOptions.ts): the ones that take a value, the
// switches, the recorder's (a replaying daemon refuses them) and the replay's
// (they need --replay). Nothing misspelt, valueless, repeated or stray is
// passed over: a recording someone asked for must not silently not happen.
const VALUE_OPTIONS = valueFlags();
const SWITCHES = switchFlags();
const RECORD_OPTIONS = flagsOf('record');
const REPLAY_OPTIONS = flagsOf('replay');
if (parsed.problem) { refuse(parsed.problem); }

function arg(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const given = (name: string): boolean => argv.includes(name);
/** An environment variable, unless it is unset or empty. */
const fromEnv = (name: string): string | undefined => (env[name] !== undefined && env[name] !== '' ? env[name] : undefined);

function portFrom(raw: string | undefined): number {
  if (raw === undefined) { return DEFAULT_PORT; }
  const port = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(port) || port < 1 || port > 65535) { refuse(`invalid port: ${raw}`); }
  return port;
}

/** A switch from the environment: 1/true/yes or 0/false/no. */
function envSwitch(name: string): boolean {
  const raw = fromEnv(name)?.trim().toLowerCase();
  if (raw === undefined) { return false; }
  if (['1', 'true', 'yes', 'on'].includes(raw)) { return true; }
  if (['0', 'false', 'no', 'off'].includes(raw)) { return false; }
  return refuse(`${name} must be 1, true, yes, 0, false or no, not "${env[name]}"`);
}

/** A whole number of `unit` from `--name`, within `min` to `max` of it. */
function wholeNumber(name: string, raw: string, min: number, max: number, unit: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < min || n > max) {
    refuse(`${name} takes a whole number of ${unit} from ${min} to ${max}, not "${raw}"`);
  }
  return n;
}

/** A byte limit given in MiB, held to the recorder's bounds for it. */
function mibLimit(name: string, key: keyof RecordingLimits): number | undefined {
  const raw = arg(name);
  if (raw === undefined) { return undefined; }
  const { min, max } = RECORDING_LIMIT_BOUNDS[key];
  return wholeNumber(name, raw, Math.ceil(min / MIB), Math.floor(max / MIB), 'MiB') * MIB;
}

const port = portFrom(arg('--port') ?? fromEnv('ABB_RWS_DAEMON_PORT'));
// Where the panel is served from, comma-separated, replacing the defaults
// (its dev server on 127.0.0.1:5173 and localhost:5173).
const panelOrigins = (arg('--panel-origins') ?? fromEnv('ABB_RWS_DAEMON_PANEL_ORIGINS'))
  ?.split(',').map(o => o.trim()).filter(o => o.length > 0);
// The access token's file: made on the first start in the per-user folder
// (%APPDATA%\abb-rws-daemon\token; $XDG_CONFIG_HOME or ~/.config elsewhere).
/** A default path, or the reason there is none (an account without a home folder) as a refusal. */
const orRefuse = (path: () => string): string => {
  try { return path(); } catch (e) { return refuse(e instanceof Error ? e.message : String(e)); }
};
const tokenPath = resolve(arg('--token-file') ?? fromEnv('ABB_RWS_DAEMON_TOKEN_FILE') ?? orRefuse(defaultTokenPath));
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const logLevel = fromEnv('ABB_RWS_DAEMON_LOG') ?? 'info';
if (!LOG_LEVELS.includes(logLevel)) { refuse(`ABB_RWS_DAEMON_LOG must be one of ${LOG_LEVELS.join(', ')}, not "${logLevel}"`); }
const logger = { level: logLevel };

/** The extra host names --allowed-hosts or its variable named, and which of the two did. */
interface AllowedHosts {
  hosts: string[];
  source: '--allowed-hosts' | 'ABB_RWS_DAEMON_ALLOWED_HOSTS';
}

/**
 * Host names accepted in the Host header besides the loopback names,
 * comma-separated; none unless given (the option wins over the variable).
 * For a consumer that reaches this loopback port under another name, as a
 * container does. A bad entry stops the launch.
 */
function allowedHostsLaunch(): AllowedHosts | null {
  const option = arg('--allowed-hosts');
  const raw = option ?? fromEnv('ABB_RWS_DAEMON_ALLOWED_HOSTS');
  if (raw === undefined) { return null; }
  const source = option !== undefined ? '--allowed-hosts' : 'ABB_RWS_DAEMON_ALLOWED_HOSTS';
  try {
    return { hosts: [...hostAllowlist(raw.split(','))], source };
  } catch (e) {
    return refuse(`${source}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const allowedHosts = allowedHostsLaunch();

/** The one line that says the Host rule takes more names, which ones and what named them; nothing when it does not. */
function logAllowedHosts(log: { warn(obj: object, msg?: string): void }): void {
  if (!allowedHosts) { return; }
  log.warn({ allowedHosts: allowedHosts.hosts, source: allowedHosts.source },
    `extra host names accepted in the Host header (${allowedHosts.source}): ${allowedHosts.hosts.join(', ')}; `
    + `the access token is still required, and the daemon still listens on ${BIND_HOST} only`);
}

/** What --replay asked for. */
interface ReplayLaunch {
  target: string;
  speed: number;
  loop: boolean;
  paused: boolean;
  skipBad: boolean;
  time: ReplayTimeMode;
  parts: PartRange | undefined;
}

/** What a live daemon was started with. */
interface LiveLaunch {
  configPath: string;
  /** Start a recording at launch (--record). */
  record: boolean;
  label: string | undefined;
  content: RecordingContent[] | undefined;
  /** The daemon's own recording limits; a start request may only tighten them. */
  limits: Partial<RecordingLimits>;
  /** The recordings folder, and whether it was given (custom) or is the default. */
  recordDir: string;
  recordFolder: 'default' | 'custom';
}

function replayLaunch(target: string): ReplayLaunch {
  // A replaying daemon reaches no controller and holds no credential: it
  // reads no config file, and it records nothing.
  if (given('--record')) {
    refuse('--record cannot be used with --replay: a replaying daemon reaches no controller and records nothing');
  }
  for (const o of RECORD_OPTIONS) {
    if (given(o)) { refuse(`${o} cannot be used with --replay: a replaying daemon records nothing`); }
  }
  if (given('--config')) {
    refuse('--config cannot be used with --replay: a replaying daemon reads no config file and holds no controller password');
  }
  let speed = 1;
  const rawSpeed = arg('--replay-speed') ?? fromEnv('ABB_RWS_DAEMON_REPLAY_SPEED');
  if (rawSpeed !== undefined) {
    speed = Number(rawSpeed);
    if (!/^(\d+\.?\d*|\.\d+)$/.test(rawSpeed.trim()) || !Number.isFinite(speed) || speed < REPLAY_SPEED_MIN || speed > REPLAY_SPEED_MAX) {
      refuse(`the replay speed must be a number from ${REPLAY_SPEED_MIN} to ${REPLAY_SPEED_MAX}, not "${rawSpeed}"`);
    }
  }
  const rawTime = arg('--replay-time') ?? 'shifted';
  if (rawTime !== 'shifted' && rawTime !== 'recorded') {
    refuse(`--replay-time takes shifted or recorded, not "${rawTime}"`);
  }
  let parts: PartRange | undefined;
  const rawParts = arg('--replay-parts') ?? fromEnv('ABB_RWS_DAEMON_REPLAY_PARTS');
  if (rawParts !== undefined) {
    try { parts = parsePartRange(rawParts); } catch (e) { refuse(e instanceof Error ? e.message : String(e)); }
  }
  return {
    target: resolve(target), speed, time: rawTime, parts,
    loop: given('--replay-loop') || envSwitch('ABB_RWS_DAEMON_REPLAY_LOOP'),
    paused: given('--replay-paused'),
    skipBad: given('--replay-skip-bad'),
  };
}

function liveLaunch(): LiveLaunch {
  for (const o of REPLAY_OPTIONS) {
    if (given(o)) { refuse(`${o} needs --replay`); }
  }
  const record = given('--record');
  for (const o of ['--record-label', '--record-content']) {
    if (given(o) && !record) { refuse(`${o} applies only to the recording --record starts`); }
  }
  const label = arg('--record-label');
  if (label !== undefined && !new RegExp(RECORDING_LABEL_PATTERN).test(label)) {
    refuse(`--record-label takes 1 to 32 lowercase letters, digits or hyphens, not "${label}"`);
  }
  let content: RecordingContent[] | undefined;
  const rawContent = arg('--record-content');
  if (rawContent !== undefined) {
    const asked = rawContent.split(',').map(c => c.trim()).filter(c => c.length > 0);
    const known: RecordingContent[] = ['frames', 'calls', 'state'];
    const unknown = asked.filter(c => !(known as string[]).includes(c));
    if (asked.length === 0 || unknown.length > 0) {
      refuse(`--record-content takes frames, calls and state, comma-separated (at least one), not "${rawContent}"`);
    }
    content = known.filter(c => asked.includes(c));
  }
  const limits: Partial<RecordingLimits> = {};
  const rawFor = arg('--record-for');
  if (rawFor !== undefined) {
    const { min, max } = RECORDING_LIMIT_BOUNDS.durationS;
    limits.durationS = wholeNumber('--record-for', rawFor, min, max, 'seconds');
  }
  const file = mibLimit('--record-max-file-mb', 'maxFileBytes');
  const total = mibLimit('--record-max-total-mb', 'maxTotalBytes');
  const dir = mibLimit('--record-max-dir-mb', 'maxDirBytes');
  if (file !== undefined) { limits.maxFileBytes = file; }
  if (total !== undefined) { limits.maxTotalBytes = total; }
  if (dir !== undefined) { limits.maxDirBytes = dir; }
  const customDir = arg('--record-dir') ?? fromEnv('ABB_RWS_DAEMON_RECORD_DIR');
  return {
    configPath: resolve(arg('--config') ?? fromEnv('ABB_RWS_DAEMON_CONFIG') ?? DEFAULT_CONFIG),
    record, label, content, limits,
    recordDir: customDir !== undefined ? resolve(customDir) : orRefuse(defaultRecordingDir),
    recordFolder: customDir !== undefined ? 'custom' : 'default',
  };
}

const replayTarget = arg('--replay') ?? fromEnv('ABB_RWS_DAEMON_REPLAY');
const replay = replayTarget !== undefined ? replayLaunch(replayTarget) : null;
const live = replay ? null : liveLaunch();

// The token comes before the server: a server without it is never built.
// Its warnings wait for the server's log.
const tokenWarnings: string[] = [];
let access: { token: string; created: boolean };
try {
  access = await loadOrCreateToken(tokenPath, { warn: m => tokenWarnings.push(m) });
} catch (e) {
  refuse(e instanceof Error ? e.message : String(e));
}

/** The token lines of the daemon's log: where consumers read the token, never the token itself. */
function logToken(log: { warn(obj: object, msg?: string): void; info(obj: object, msg?: string): void }): void {
  for (const m of tokenWarnings) { log.warn({ tokenFile: tokenPath }, m); }
  log.info({ tokenFile: tokenPath },
    `access token ${access.created ? 'created' : 'loaded'}; every request but GET /v0/health carries it in the ${TOKEN_HEADER} header`);
}

/** Replay mode: no config, no fleet, no client object; the recording is served as if it were live. */
async function runReplay(o: ReplayLaunch): Promise<void> {
  let daemon: ReplayDaemon;
  try {
    daemon = await createReplayDaemon({
      target: o.target, parts: o.parts, skipBad: o.skipBad, speed: o.speed, loop: o.loop, paused: o.paused, time: o.time,
      server: { logger, port, panelOrigins, allowedHosts: allowedHosts?.hosts, accessToken: access.token },
      exit: code => process.exit(code),
    });
  } catch (e) {
    refuse(`the recording cannot be replayed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { app, stop } = daemon;
  logFatalErrors(app.log);
  logToken(app.log);
  logAllowedHosts(app.log);
  const stopOn = onStopSignals(signal => void stop.stop(signal));
  app.log.debug({ signals: stopOn }, 'stop signals handled');
  try {
    await app.listen({ host: BIND_HOST, port });
  } catch (e) {
    app.log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

/** Live mode: the controllers of the config file, the recorder off unless started. */
async function runLive(o: LiveLaunch): Promise<void> {
  let recorder: Recorder | null = null;
  const app = createServer({
    logger, port, panelOrigins, allowedHosts: allowedHosts?.hosts, accessToken: access.token,
    health: { mode: 'live', recording: () => recorder?.health() ?? { ...NO_RECORDING }, replay: () => null },
  });
  logFatalErrors(app.log);
  logToken(app.log);
  logAllowedHosts(app.log);

  // Config writes are queued so two changes in quick succession (an add, then
  // the controller moving port; a fleet change and saved discovery inputs) can
  // never interleave and lose one. `writes` itself never rejects.
  let writes = Promise.resolve();
  const queueWrite = (job: () => Promise<void>): Promise<void> => {
    const done = writes.then(job);
    writes = done.catch(e => app.log.error({ err: e instanceof Error ? e.message : String(e) }, 'could not save config'));
    return done;
  };
  const persist = (all: ControllerConfig[]): void => { queueWrite(() => saveConfig(o.configPath, all)).catch(() => {}); };

  let fleet: ControllerFleet;
  // Saved discovery inputs: they pre-fill a scan, and are never scanned on their own.
  let savedInputs: DiscoverySettings = emptyDiscoverySettings();
  try {
    const initial = await loadConfigFile(o.configPath, { warn: m => app.log.warn({ config: o.configPath }, m) });
    fleet = new ControllerFleet(initial.controllers, app.log, persist);
    savedInputs = initial.discovery;
    app.log.info({ config: o.configPath, controllers: initial.controllers.length }, 'config loaded');
  } catch (e) {
    app.log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // While a recording runs, its sink hears what crosses to the client: the
  // fleet's calls, state and I/O events, and the setup steps (discovery, a
  // passport read), which take credentials and are masked like the rest.
  let tapSink: ClientTapSink | null = null;
  const tapHost: TapHost = {
    setTap: sink => {
      tapSink = sink;
      fleet.setTap(sink);
    },
  };
  const currentSink = (): ClientTapSink | null => tapSink;

  await registerControllerRoutes(app, {
    fleet,
    discover: tapFunction(discover, { target: 'setup', method: 'discover', sink: currentSink }),
    readPassport: tapFunction(readPassport, { target: 'setup', method: 'readPassport', sink: currentSink }),
    savedDiscovery: {
      get: () => savedInputs,
      set: async settings => {
        let kept = settings;
        await queueWrite(async () => { kept = await saveDiscoverySettings(o.configPath, settings, { controllers: fleet.all() }); });
        savedInputs = kept;
        return kept;
      },
    },
  });
  const stream = new SnapshotStream(fleet, new SocketHub());
  await registerStreamRoute(app, stream);

  // Off unless started: --record, or POST /v0/recording/start with the token.
  // The recordings folder is logged; no answer ever names it.
  recorder = new Recorder({
    observer: stream, tap: tapHost, controllers: () => fleet.all(), token: access.token,
    dir: o.recordDir, folder: o.recordFolder, limits: o.limits, log: app.log, daemonVersion: DAEMON_VERSION,
  });
  app.log.info({ recordings: o.recordDir, folder: o.recordFolder, limits: recorder.limits },
    'recordings folder; a recording starts only with --record or POST /v0/recording/start');
  await registerRecordingRoutes(app, { recorder });

  // One stop, however it is asked for: a stop signal (Ctrl+C, a service
  // wrapper, a closed console window on Windows) or POST /v0/admin/shutdown.
  // It logs out of every controller - never leave sessions on a controller -
  // ends a recording that runs, and exits within STOP_WAIT_MS, naming each
  // controller and what became of its session.
  const stopper = new DaemonStop({
    log: app.log, stream, fleet, recorder, server: app, writes: () => writes, exit: code => process.exit(code),
  });
  await registerAdminRoutes(app, { stop: stopper });
  const stopOn = onStopSignals(signal => void stopper.stop(signal));
  app.log.debug({ signals: stopOn }, 'stop signals handled');

  try {
    await app.listen({ host: BIND_HOST, port });
  } catch (e) {
    app.log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // A recording asked for at launch starts before the first connect, so the
  // connects are in it. One that cannot start leaves the daemon running
  // without one; GET /v0/recording says why.
  if (o.record) {
    app.log.warn({ label: o.label ?? null, content: o.content ?? ['frames', 'calls', 'state'], durationS: recorder.limits.durationS },
      'recording from launch (--record): controller data goes to the recordings folder until the duration ends '
      + 'or POST /v0/recording/stop');
    try {
      await recorder.start({ ...(o.label !== undefined ? { label: o.label } : {}), ...(o.content ? { content: o.content } : {}) });
    } catch (e) {
      app.log.error({ err: e instanceof Error ? e.message : String(e) },
        'the recording --record asked for did not start; the daemon runs without one');
    }
  }

  void fleet.connectAll();
  fleet.startSupervisor();
  fleet.startPointerPoller();
  fleet.startMotionSampler();   // samples only controllers someone is watching
  fleet.startIoPoller();        // likewise: polls only leased signal watches
  fleet.startEventReader();     // every controller's event log
  fleet.startAccessReader();    // who holds write access and mastership: status reads only
}

if (replay) {
  await runReplay(replay);
} else if (live) {
  await runLive(live);
}

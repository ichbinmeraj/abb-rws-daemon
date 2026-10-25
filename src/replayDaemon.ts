import type { FastifyInstance } from 'fastify';
import { emptyDiscoverySettings } from './config.js';
import { ReplayModeError } from './recording/contract.js';
import { registerRecordingRoutes } from './recordingRoutes.js';
import { ReplayFleet } from './replay/fleet.js';
import { readRecording, type PartRange, type Recording } from './replay/reader.js';
import { ReplayStream } from './replay/stream.js';
import { registerReplayRoutes } from './replayRoutes.js';
import { registerAdminRoutes, registerControllerRoutes } from './routes.js';
import type { ReplayTimeMode } from './schema/v0.js';
import { NO_RECORDING, createServer, type ServerOptions } from './server.js';
import { DaemonStop } from './stop.js';
import { registerStreamRoute } from './stream.js';
import { SocketHub } from './wsHub.js';

/**
 * The daemon in replay mode (`--replay`): it serves a recording as if it were
 * live, and reaches no controller. It reads no config file and builds no
 * fleet: there is no client object, no controller credential and no session
 * in the process, so nothing it does can reach a controller. What it holds:
 *
 * - the recording (ReplayReader), read and checked before anything is served;
 * - a ReplayStream on its own hub: `WS /v0/stream` sends the recorded frames
 *   on the recorded schedule (speed, pause, step, loop);
 * - a ReplayFleet: the controller routes answer from the recording at the
 *   replay's position;
 * - the routes that would reach a controller or change the setup answer 409
 *   `REPLAY_MODE` (REPLAY_REFUSED_ROUTES, and deps that refuse besides);
 *   `POST /v0/recording/start` too, and `GET /v0/recording` answers inactive;
 * - `GET /v0/replay`, `POST /v0/replay/control`, and health with
 *   `mode: "replay"` and the replay's position;
 * - the same stop as live (`POST /v0/admin/shutdown`, stop signals), with no
 *   session to log out of.
 */

export interface ReplayDaemonOptions {
  /** The recording: a part file, a folder holding one recording, or `<folder>/<recording name>`. */
  target: string;
  /** Which parts to replay (`--replay-parts`); default every part. */
  parts?: PartRange;
  /** Skip bad lines instead of refusing the recording (`--replay-skip-bad`). */
  skipBad?: boolean;
  /** Playback speed, REPLAY_SPEED_MIN to REPLAY_SPEED_MAX; default 1. */
  speed?: number;
  /** Start over at the end; default false. */
  loop?: boolean;
  /** Start paused; default false. */
  paused?: boolean;
  /** How times are served; default `shifted`. */
  time?: ReplayTimeMode;
  /** The HTTP server; its health is the replay's. */
  server: Omit<ServerOptions, 'health'>;
  /** Ends the process once a stop has run: process.exit in production. */
  exit(code: number): void;
  /** The stream's hub (tests set its heartbeat). */
  hub?: SocketHub;
  /** Clocks and the loop's pause, for tests. */
  wallNow?: () => number;
  monoNow?: () => number;
  loopDelayMs?: number;
}

/** A replaying daemon, built and not yet listening. */
export interface ReplayDaemon {
  app: FastifyInstance;
  recording: Recording;
  stream: ReplayStream;
  fleet: ReplayFleet;
  /** The daemon's stop (signals and `POST /v0/admin/shutdown`). */
  stop: DaemonStop;
}

/** Every route that would reach a controller or change the setup gets this: a replaying daemon has none to reach. */
const refuse = async (): Promise<never> => { throw new ReplayModeError(); };

/**
 * Read the recording and build the replaying daemon around it: the server,
 * every route, the stream and the stop. Throws when the recording cannot be
 * replayed (ReplayReadError, naming files by base name), and then nothing is
 * left open. The caller listens (`app.listen`) and hands stop signals to
 * `stop`.
 */
export async function createReplayDaemon(opts: ReplayDaemonOptions): Promise<ReplayDaemon> {
  let stream: ReplayStream | null = null;
  const app = createServer({
    ...opts.server,
    health: { mode: 'replay', recording: () => ({ ...NO_RECORDING }), replay: () => stream?.health() ?? null },
  });
  try {
    const recording = await readRecording(opts.target, { parts: opts.parts, skipBad: opts.skipBad, log: app.log });
    // `replayTime`, not `time`: the log line's own `time` is its timestamp.
    app.log.info({
      session: recording.session, files: recording.files, frames: recording.frames.length, gaps: recording.gaps,
      recordedAt: recording.sessionStartedAt, source: recording.source, schemaVersion: recording.schemaVersion,
      speed: opts.speed ?? 1, loop: opts.loop ?? false, paused: opts.paused ?? false, replayTime: opts.time ?? 'shifted',
    }, 'replaying a recording: no controller is reached, and nothing can be written');
    stream = new ReplayStream(recording, opts.hub ?? new SocketHub(), {
      speed: opts.speed, loop: opts.loop, paused: opts.paused, time: opts.time, log: app.log,
      wallNow: opts.wallNow, monoNow: opts.monoNow, loopDelayMs: opts.loopDelayMs,
    });
    const fleet = new ReplayFleet(stream, recording.index, { wallNow: opts.wallNow });

    // Before the controller routes: the refusals run ahead of every handler.
    await registerReplayRoutes(app, { replay: stream, recordedSchemaVersion: recording.schemaVersion });
    await registerControllerRoutes(app, {
      fleet,
      discover: refuse,
      readPassport: refuse,
      savedDiscovery: { get: () => emptyDiscoverySettings(), set: refuse },
      now: () => fleet.now(),
    });
    await registerRecordingRoutes(app, { recorder: null });
    await registerStreamRoute(app, stream);
    const stop = new DaemonStop({
      log: app.log, mode: 'replay', stream, fleet, server: app, writes: async () => {}, exit: code => opts.exit(code),
    });
    await registerAdminRoutes(app, { stop });
    return { app, recording, stream, fleet, stop };
  } catch (e) {
    stream?.close();
    await app.close().catch(() => {});
    throw e;
  }
}

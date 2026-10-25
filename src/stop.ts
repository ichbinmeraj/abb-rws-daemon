import type { ControllerLogout, Log } from './fleet.js';
import { STOP_WAIT_MS, type DaemonMode } from './schema/v0.js';

/**
 * Stopping the daemon. A daemon that exits without logging out leaves its
 * session on every controller until the controller times it out, and a
 * controller takes only a few sessions from one address: a daemon restarted
 * a few times in a row (by a service wrapper, say) can lock the PC it runs
 * on out of a controller for minutes, other tools on that PC included. So
 * every way the daemon is asked to stop - a stop signal, a closed console
 * window, the shutdown route - runs the same stop, once, and within
 * STOP_WAIT_MS.
 */

/**
 * Of STOP_WAIT_MS, what the stop keeps back from the logouts for closing the
 * server and saving the config after them.
 */
export const STOP_RESERVE_MS = 1_500;

/**
 * Of STOP_RESERVE_MS, the most a recording that runs while the daemon stops
 * gets to write what it still holds and close its part with its end record;
 * the rest is kept for closing the server and saving the config.
 */
export const STOP_RECORDING_MS = 1_000;

/**
 * The signals that stop the daemon on `platform`: SIGINT (Ctrl+C) and
 * SIGTERM everywhere; on Windows also SIGBREAK (Ctrl+Break) and SIGHUP, which
 * Node raises there when the console window is closed. Windows ends the
 * process some seconds after its console closes, whatever it is doing, so
 * that stop can be cut short. Windows itself never raises SIGTERM, but
 * listening costs nothing. Service wrappers on Windows (NSSM, WinSW) stop a
 * console program with Ctrl+C, which arrives as SIGINT; systemd and launchd
 * send SIGTERM. SIGHUP elsewhere is left alone: a daemon started under nohup
 * keeps running when its terminal closes (a listener here would undo nohup's
 * ignore), and one started in a plain terminal ends with it, without the
 * logout; the README says so.
 */
export function stopSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
  return platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM'];
}

/**
 * Call `stop` with the signal's name on each stop signal of `platform`.
 * `proc` is the process, a fake in tests. Returns the signals handled.
 */
export function onStopSignals(
  stop: (signal: NodeJS.Signals) => void,
  proc: Pick<NodeJS.EventEmitter, 'on'> = process,
  platform: NodeJS.Platform = process.platform,
): NodeJS.Signals[] {
  const signals = stopSignals(platform);
  for (const signal of signals) { proc.on(signal, () => stop(signal)); }
  return signals;
}

/** What a stop closes, in this order: the daemon's own parts in production, fakes in tests. */
export interface StopParts {
  log: Log;
  /**
   * `replay`: the daemon replays a recording and holds no controller
   * session, so the stop says so and has no logout step. Default `live`.
   */
  mode?: DaemonMode;
  /** The stream: every consumer is closed as going away (SnapshotStream.close). */
  stream: { close(): void };
  /** Logs out of every controller within the wait it is given (ControllerFleet.disconnectAll). */
  fleet: { disconnectAll(opts: { waitMs: number }): Promise<ControllerLogout[]> };
  /**
   * The recorder, where one may run (RecorderControl.stop): a recording that
   * runs is ended after the logouts, so they are in it, and before the server
   * closes. The recorder observes the stream from inside the daemon, so
   * closing the stream's consumers does not end it.
   */
  recorder?: { stop(reason: 'daemon-stop', opts: { waitMs: number }): Promise<unknown> };
  /** The HTTP server (Fastify's close). */
  server: { close(): Promise<unknown> };
  /** Settles once the config writes already queued are done. */
  writes(): Promise<unknown>;
  /** Ends the process: process.exit in production. */
  exit(code: number): void;
}

export interface StopOptions {
  /** The whole stop's bound, from its start to exit. Default STOP_WAIT_MS. */
  waitMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The daemon's one stop. The first request starts it, whoever sends it; a
 * later one is logged and changes nothing. In order: stream consumers are
 * closed as going away, every controller is logged out (the log names each
 * one and what became of its session; a replaying daemon has no session to
 * log out of and skips this step), a recording that runs ends (within
 * STOP_RECORDING_MS, its logouts in it), the server closes, the config writes
 * already queued finish, and the process exits 0. The logouts get all of the
 * wait but STOP_RESERVE_MS. Whatever is still running when the whole wait is
 * over, the process exits 1, naming the step it was on.
 */
export class DaemonStop {
  /** The whole stop's bound (ms). */
  readonly waitMs: number;
  private readonly now: () => number;
  private startedAt: number | null = null;
  private running: Promise<void> | null = null;
  private step = 'not started';
  private exited = false;

  constructor(private readonly parts: StopParts, opts: StopOptions = {}) {
    this.waitMs = opts.waitMs ?? STOP_WAIT_MS;
    this.now = opts.now ?? Date.now;
  }

  /** A stop has begun. */
  get stopping(): boolean { return this.running !== null; }

  /** At most how long (ms) until the process exits: the whole wait before the stop begins, what is left of it after. */
  exitWithinMs(): number {
    if (this.startedAt === null) { return this.waitMs; }
    return Math.max(0, this.startedAt + this.waitMs - this.now());
  }

  /**
   * Stop the daemon, saying why (a signal's name, the route). Settles when
   * the stop has run; never rejects. A second request joins the first.
   */
  stop(reason: string): Promise<void> {
    if (this.running) {
      this.parts.log.info({ reason, step: this.step, exitWithinMs: this.exitWithinMs() }, 'already stopping');
      return this.running;
    }
    this.startedAt = this.now();
    this.running = this.run(reason).catch(e => {
      this.parts.log.error({ reason, err: messageOf(e) }, 'the stop failed; exiting');
      this.exit(1);
    });
    return this.running;
  }

  private exit(code: number): void {
    if (this.exited) { return; }
    this.exited = true;
    this.parts.exit(code);
  }

  private async run(reason: string): Promise<void> {
    const { log } = this.parts;
    const waitS = this.waitMs / 1000;
    // The bound on everything below: a step that hangs must not keep the
    // process - and whatever wrapper waits on it - from ending.
    const backstop = setTimeout(() => {
      log.error({ reason, step: this.step, waitS }, `the stop did not finish within ${waitS} s; exiting while ${this.step}`);
      this.exit(1);
    }, this.waitMs);
    try {
      const replaying = this.parts.mode === 'replay';
      log.info({ reason, waitS },
        replaying ? 'stopping: replaying a recording, no controller session to log out of' : 'stopping: logging out of every controller');
      this.step = 'closing the stream';
      try { this.parts.stream.close(); } catch (e) { log.warn({ err: messageOf(e) }, 'closing the stream failed'); }

      if (!replaying) {
        this.step = 'logging out of the controllers';
        try {
          logLogouts(log, await this.parts.fleet.disconnectAll({ waitMs: Math.max(0, this.waitMs - STOP_RESERVE_MS) }));
        } catch (e) {
          log.error({ err: messageOf(e) }, 'logging out of the controllers failed');
        }
      }

      if (this.parts.recorder) {
        this.step = 'ending the recording';
        // What is left of the reserve, less what closing the server and saving the config keep.
        const waitMs = Math.max(0, Math.min(STOP_RECORDING_MS, this.exitWithinMs() - (STOP_RESERVE_MS - STOP_RECORDING_MS)));
        try {
          await this.parts.recorder.stop('daemon-stop', { waitMs });
        } catch (e) {
          log.warn({ err: messageOf(e) }, 'ending the recording failed');
        }
      }

      this.step = 'closing the server';
      try { await this.parts.server.close(); } catch (e) { log.warn({ err: messageOf(e) }, 'closing the server failed'); }

      this.step = 'saving the config';
      try { await this.parts.writes(); } catch (e) { log.warn({ err: messageOf(e) }, 'saving the config failed'); }
    } finally {
      clearTimeout(backstop);
    }
    this.step = 'stopped';
    log.info({ reason, tookMs: this.now() - (this.startedAt ?? this.now()) }, 'stopped');
    this.exit(0);
  }
}

/**
 * Put what became of each controller's session in the log: one line per
 * controller (a warning when its logout did not finish or failed), then one
 * line that names them all by outcome.
 */
export function logLogouts(log: Log, report: ControllerLogout[]): void {
  for (const r of report) {
    const at = { controller: r.id, host: r.host, port: r.port };
    switch (r.outcome) {
      case 'logged-out': log.info(at, 'logged out'); break;
      case 'connect-cancelled': log.info(at, 'connect in progress cancelled; any session it had opened was logged out'); break;
      case 'not-connected': log.info(at, 'not connected; no session to log out'); break;
      case 'timed-out': log.warn(at, 'logout did not finish in time; the controller ends the session when it times out'); break;
      case 'failed': log.warn({ ...at, err: r.error }, 'logout failed; the controller ends the session when it times out'); break;
    }
  }
  const named = (...outcomes: ControllerLogout['outcome'][]) => report.filter(r => outcomes.includes(r.outcome)).map(r => r.id);
  const summary = {
    loggedOut: named('logged-out'),
    connectCancelled: named('connect-cancelled'),
    notConnected: named('not-connected'),
    unfinished: named('timed-out', 'failed'),
  };
  if (report.length === 0) { log.info(summary, 'no controllers configured; nothing to log out'); return; }
  const text = `logged out of ${summary.loggedOut.length} of ${report.length} controller(s)`
    + (summary.connectCancelled.length > 0 ? `, ${summary.connectCancelled.length} connect(s) cancelled` : '')
    + (summary.notConnected.length > 0 ? `, ${summary.notConnected.length} not connected` : '');
  if (summary.unfinished.length > 0) {
    log.warn(summary, `${text}; ${summary.unfinished.length} logout(s) not confirmed: ${summary.unfinished.join(', ')}`);
  } else {
    log.info(summary, text);
  }
}

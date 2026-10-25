import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { RwsError } from 'abb-rws-client';
import { httpStatusFor, errorBody, redactSecrets } from './errorMap.js';
import { DEFAULT_PANEL_ORIGINS, hostAllowlist, isAllowedHostHeader, isAllowedOrigin, originAllowlist } from './localGuard.js';
import { ReadLimitError } from './readBudget.js';
import {
  NotRecordedError, RecordingActiveError, RecordingBoundsError, RecordingFailedError, ReplayModeError,
} from './recording/contract.js';
import type { DaemonMode, HealthAnswer, RecordingHealth, ReplayHealth } from './schema/v0.js';
import { TOKEN_PATTERN, tokenMatcher, tokenRefusal } from './token.js';

/** Default loopback port. Chosen clear of every port abb-rws-client probes for RWS. */
export const DEFAULT_PORT = 7810;

/** The daemon only ever binds loopback; there is deliberately no option to widen it. */
export const BIND_HOST = '127.0.0.1';

// Read once at startup. Works from both src/ (tests) and dist/ (built), which sit
// at the same depth below the package root.
/** The daemon's version, from its package.json. */
export const DAEMON_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/**
 * What `GET /v0/health` says beyond the server's own fields: whether the
 * daemon reads controllers or replays a recording, and how its recording and
 * its replay stand. Read on every request, so it may name parts made after
 * the server. Never a file name or a path: health needs no token.
 */
export interface HealthStatus {
  mode: DaemonMode;
  /** The recording (RecorderControl.health); none runs when absent. */
  recording?: () => RecordingHealth;
  /** The replay (ReplayControl.health); null in live mode, and when absent. */
  replay?: () => ReplayHealth | null;
}

/** No recording runs: what health says without a recorder, and in replay mode. */
export const NO_RECORDING: Readonly<RecordingHealth> = Object.freeze({ active: false, since: null });

export interface ServerOptions {
  /** Passed to Fastify; tests pass `false`. */
  logger?: FastifyServerOptions['logger'];
  /** Clock, injectable so tests can pin uptime. */
  now?: () => number;
  /** The port the daemon listens on: a page it serves itself is same-origin. Default DEFAULT_PORT. */
  port?: number;
  /** Origins the panel is served from, scheme, host and port exactly. Default DEFAULT_PANEL_ORIGINS. */
  panelOrigins?: readonly string[];
  /**
   * Host names accepted in the Host header besides 127.0.0.1, localhost and
   * ::1, each a DNS host name in full (hostAllowlist): for a consumer that
   * reaches the loopback port under another name, as a container does.
   * Default none. The bind, the Origin and Sec-Fetch-Site rules and the
   * access token are the same with it.
   */
  allowedHosts?: readonly string[];
  /**
   * The access token every request but `GET /v0/health` must carry
   * (TOKEN_HEADER, or a subprotocol on the stream's upgrade; see token.ts),
   * or null for none - only for a server behind a gate of its own, or a test
   * about something else. There is no default: a server nobody said should
   * run open never does.
   */
  accessToken: string | null;
  /** The mode, recording and replay `GET /v0/health` reports. Default: live, no recording, no replay. */
  health?: HealthStatus;
}

/** The one route a consumer reaches without the token: it tells "no daemon" apart from "no token". */
export const HEALTH_PATH = '/v0/health';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The route must never run open: a server built without an access token
     * refuses it 403 TOKEN_REQUIRED instead of serving it to anyone on
     * loopback. For routes that change what the daemon does (stopping it).
     */
    tokenRequired?: boolean;
    /**
     * The route is for native clients only: a request that carries an Origin
     * or Sec-Fetch-Site (a browser page, whichever origin it is from, the
     * panel's included) is refused 403 ORIGIN_NOT_ALLOWED. For the admin
     * routes, which no page has any use for.
     */
    nativeOnly?: boolean;
  }
}

/**
 * Build the daemon's HTTP server without starting it. Callers add routes and
 * then `listen()`; tests use `inject()` and never open a socket.
 */
export function createServer(opts: ServerOptions): FastifyInstance {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const allowedOrigins = originAllowlist(opts.port ?? DEFAULT_PORT, opts.panelOrigins ?? DEFAULT_PANEL_ORIGINS);
  const allowedHosts = hostAllowlist(opts.allowedHosts ?? []);
  if (opts.accessToken === undefined) {
    throw new Error('createServer needs an accessToken: the token, or null for a server that checks none');
  }
  if (opts.accessToken !== null && !TOKEN_PATTERN.test(opts.accessToken)) {
    throw new Error("the access token must be 32 to 256 letters, digits, '-' or '_'");
  }
  const tokenMatches = opts.accessToken === null ? null : tokenMatcher(opts.accessToken);
  // Per-request lines are off: a panel polling twice a second would bury every
  // controller event in the log. Failures still reach the log via the error handler.
  // Through a LogController: Fastify 5.12 deprecates the top-level
  // `disableRequestLogging` (FSTDEP023, a warning on every start).
  const app = Fastify({
    logger: opts.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
  });

  // Every connection keeps an 'error' listener for its whole life. Node drops
  // its own when a request asks for a WebSocket upgrade, and the stream adds
  // one only once it accepts the socket: a reset landing in between, or on an
  // upgrade that is refused, would otherwise be an unhandled 'error' that ends
  // the process. The socket is already destroyed by then; nothing else to do.
  app.server.on('connection', (socket: Socket) => {
    socket.on('error', e => app.log.debug({ err: e.message }, 'client connection error'));
  });

  // Every check runs before any route: first what keeps browser pages out,
  // then the access token. Host defeats DNS rebinding. Origin is checked on
  // EVERY request, the WebSocket upgrade included: a cross-origin page cannot
  // read our responses (CORS), but a "simple" cross-origin POST still
  // executes - which matters once writes exist. Only the daemon's own origin
  // and the panel's pass, port included. Host names the daemon was told to
  // accept besides loopback (allowedHosts) pass the Host check and nothing
  // else: they are no origin, and the token is asked for all the same.
  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHostHeader(req.headers.host, allowedHosts)) {
      return reply.code(421).send({ error: 'host not allowed', code: 'HOST_NOT_ALLOWED' });
    }
    if (!isAllowedOrigin(req.headers.origin, allowedOrigins)) {
      return reply.code(403).send({ error: 'origin not allowed', code: 'ORIGIN_NOT_ALLOWED' });
    }
    // A page on another site reaches us with no Origin at all through an
    // <img>, a <script> or a navigation, and each such GET can still make the
    // daemon read from a controller. Browsers label every request with
    // Sec-Fetch-Site; native clients never send it. A site ignores the port,
    // so a page on another loopback port is `same-site`: foreign unless it
    // names itself with an Origin, which has passed the allowlist above.
    // Only our own pages (`same-origin`) and an address typed by hand (`none`)
    // come without one.
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || (site !== undefined && site !== 'same-origin' && site !== 'none' && !req.headers.origin)) {
      return reply.code(403).send({ error: 'cross-site request not allowed', code: 'CROSS_SITE_NOT_ALLOWED' });
    }
    // A route no page needs takes no browser request at all, so a panel
    // origin (a dev server any local account can reach) never gets that far.
    if (req.routeOptions.config?.nativeOnly === true && (req.headers.origin !== undefined || site !== undefined)) {
      return reply.code(403).send({ error: 'this route is for native clients: no browser page may call it', code: 'ORIGIN_NOT_ALLOWED' });
    }
    // Loopback is shared by every account signed in to this PC, so past the
    // browser checks a request needs the access token, which only the account
    // running the daemon can read. The health route stays open; which route
    // matched decides that, never how the path is spelled. An unknown path
    // needs the token too, so without it nothing says which paths exist.
    if (tokenMatches && req.routeOptions.url !== HEALTH_PATH) {
      const refused = tokenRefusal(req.headers, tokenMatches);
      if (refused) { return reply.code(refused.status).send(refused.body); }
    }
    // A server without a token serves everything else open; a route that
    // must not run open is refused outright there.
    if (!tokenMatches && req.routeOptions.config?.tokenRequired === true) {
      return reply.code(403).send({
        error: 'this route needs the access token, and this daemon runs without one', code: 'TOKEN_REQUIRED',
      });
    }
  });

  // A refused WebSocket upgrade - by the checks above, or any answer but the
  // stream's own - has already left HTTP: nothing reads its socket for a next
  // request, so it would stay open until the peer hangs up, and a peer that
  // never does would hold up the daemon's shutdown. The answer goes out, then
  // the socket closes. An accepted upgrade belongs to the stream and never
  // gets here.
  app.addHook('onResponse', async (req, reply) => {
    if ((req.raw as { upgrade?: boolean }).upgrade !== true) { return; }
    reply.raw.socket?.destroySoon();
  });

  // Controller failures carry their taxonomy code and what the controller
  // answered (errorBody); a read refused by the controller's read budget is a
  // 429; anything else is the daemon's own bug and is the only thing that may
  // produce a 500. No body carries a credential: the request
  // parser's and validator's messages name fields rather than quote values,
  // and are masked like every other message all the same.
  app.setErrorHandler(async (err, _req, reply) => {
    if (err instanceof RwsError) {
      return reply.code(httpStatusFor(err.code)).send(errorBody(err));
    }
    // A read on demand the controller's budget has no room for: nothing was
    // sent to the controller, and asking again after Retry-After may succeed.
    if (err instanceof ReadLimitError) {
      return reply.code(429).header('Retry-After', String(err.retryAfterS)).send({ error: err.message, code: 'READ_LIMIT' });
    }
    // Replaying a recording: a route that would reach a controller is
    // refused, and a request the recording holds no answer to says so.
    if (err instanceof ReplayModeError) { return reply.code(409).send({ error: redactSecrets(err.message), code: err.code }); }
    if (err instanceof NotRecordedError) { return reply.code(404).send({ error: redactSecrets(err.message), code: err.code }); }
    // The recorder: one recording at a time, and one that cannot start says
    // why in plain words (never a path; the daemon's log names the folder).
    if (err instanceof RecordingActiveError) { return reply.code(409).send({ error: redactSecrets(err.message), code: err.code }); }
    if (err instanceof RecordingFailedError) { return reply.code(503).send({ error: redactSecrets(err.message), code: err.code }); }
    if (err instanceof RecordingBoundsError) { return reply.code(400).send({ error: redactSecrets(err.message), code: err.code }); }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {        // Fastify's own validation/parse errors
      return reply.code(status).send({ error: redactSecrets((err as Error).message), code: 'BAD_REQUEST' });
    }
    reply.log.error({ err: redactSecrets(err instanceof Error ? err.message : String(err)), url: redactSecrets(_req.url) }, 'daemon error');
    return reply.code(500).send(errorBody(err));
  });

  app.setNotFoundHandler(async (req, reply) =>
    reply.code(404).send({ error: redactSecrets(`no route: ${req.method} ${req.url}`), code: 'NO_ROUTE' }));

  // The panel polls this every 2 s. A part that cannot say how it stands
  // never fails it: health answers, with that part idle.
  const health: HealthStatus = opts.health ?? { mode: 'live' };
  const ask = <T>(read: (() => T) | undefined, idle: T): T => {
    if (!read) { return idle; }
    try {
      return read() ?? idle;
    } catch (e) {
      app.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'health: a part could not say how it stands');
      return idle;
    }
  };
  app.get(HEALTH_PATH, async (): Promise<HealthAnswer> => ({
    status: 'ok',
    version: DAEMON_VERSION,
    startedAt: new Date(startedAt).toISOString(),
    uptimeS: Math.floor((now() - startedAt) / 1000),
    mode: health.mode,
    recording: ask<RecordingHealth>(health.recording, { ...NO_RECORDING }),
    replay: ask<ReplayHealth | null>(health.replay, null),
  }));

  return app;
}

/**
 * Put an error that is about to end the process into the daemon's own log.
 * A monitor, not a handler: Node still exits non-zero afterwards. An error
 * nothing caught leaves the daemon in an unknown state, and one that kept
 * running would serve stale values as current.
 */
export function logFatalErrors(
  log: { fatal(obj: object, msg?: string): void },
  proc: Pick<NodeJS.EventEmitter, 'on'> = process,
): void {
  proc.on('uncaughtExceptionMonitor', (err: unknown, origin: string) => {
    const e = err instanceof Error ? err : null;
    log.fatal({ err: e?.message ?? String(err), code: (err as { code?: unknown })?.code, stack: e?.stack, origin },
      'uncaught error; the daemon exits');
  });
}

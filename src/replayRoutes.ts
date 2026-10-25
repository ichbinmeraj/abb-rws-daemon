import type { FastifyInstance } from 'fastify';
import { ReplayModeError, type ReplayControl } from './recording/contract.js';
import {
  REPLAY_SPEED_MAX, REPLAY_SPEED_MIN, type ReplayAction, type ReplayControlRequest, type ReplayStatus,
} from './schema/v0.js';

/** `GET /v0/replay` (schema 0.12, replay mode only). */
export const REPLAY_PATH = '/v0/replay';
/** `POST /v0/replay/control` (schema 0.12, replay mode only). */
export const REPLAY_CONTROL_PATH = '/v0/replay/control';

const REPLAY_ACTIONS: ReplayAction[] = ['play', 'pause', 'step', 'restart'];

/**
 * The routes a replaying daemon refuses 409 `REPLAY_MODE`, by method and
 * route: each would reach a controller (discovery, a passport read, adding
 * one) or change the daemon's setup (the saved discovery inputs). They are
 * refused before anything else runs, whatever the request carries.
 * `DELETE /v0/controllers/:id` is not among them: it is refused for a
 * controller the recording holds and answers 404 for any other, as live.
 */
export const REPLAY_REFUSED_ROUTES: ReadonlyArray<readonly [method: string, url: string]> = Object.freeze([
  ['POST', '/v0/setup/discover'],
  ['POST', '/v0/setup/passport'],
  ['POST', '/v0/controllers'],
  ['PUT', '/v0/setup/discover/saved'],
  ['DELETE', '/v0/setup/discover/saved'],
  ['DELETE', '/v0/setup/discover/saved/manual'],
  ['DELETE', '/v0/setup/discover/saved/ranges'],
  ['DELETE', '/v0/setup/discover/saved/ports'],
] as const);

/** What the replay routes need: the replay, and the snapshot schema version its recording was made with. */
export interface ReplayRouteDeps {
  replay: ReplayControl;
  /** `GET /v0/controllers` answers with it, as the replayed frames carry it. */
  recordedSchemaVersion: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A replaying daemon's own routes and rules (schema 0.12), registered before
 * the controller routes:
 *
 * - The routes of REPLAY_REFUSED_ROUTES answer 409 `REPLAY_MODE` once the
 *   request has passed the loopback checks and the token.
 * - `GET /v0/controllers` carries the recording's snapshot schema version.
 * - `GET /v0/replay`: `ReplayStatus`.
 * - `POST /v0/replay/control` `{action, speed?}`: play, pause, send the next
 *   frame at once (`step`, which pauses), or start over (`restart`: every
 *   stream consumer is closed with 1012 and reconnects); answers
 *   `ReplayStatus`. A speed outside REPLAY_SPEED_MIN to REPLAY_SPEED_MAX, or
 *   another action, is 400.
 *
 * Both routes need the access token (403 `TOKEN_REQUIRED` on a daemon that
 * runs without one). A live daemon does not have them (404 `NO_ROUTE`).
 */
export async function registerReplayRoutes(app: FastifyInstance, deps: ReplayRouteDeps): Promise<void> {
  const refused = new Set(REPLAY_REFUSED_ROUTES.map(([method, url]) => `${method} ${url}`));
  app.addHook('onRequest', async req => {
    if (refused.has(`${req.method} ${req.routeOptions.url}`)) { throw new ReplayModeError(); }
  });

  app.addHook('preSerialization', async (req, _reply, payload: unknown) => {
    if (req.method === 'GET' && req.routeOptions.url === '/v0/controllers'
      && isObj(payload) && typeof payload.schemaVersion === 'string') {
      return { ...payload, schemaVersion: deps.recordedSchemaVersion };
    }
    return payload;
  });

  app.get(REPLAY_PATH, { config: { tokenRequired: true } }, async (): Promise<ReplayStatus> => deps.replay.status());

  app.post<{ Body: ReplayControlRequest }>(REPLAY_CONTROL_PATH, {
    config: { tokenRequired: true },
    schema: {
      body: {
        type: 'object', required: ['action'], additionalProperties: false,
        properties: {
          action: { type: 'string', enum: REPLAY_ACTIONS },
          speed: { type: 'number', minimum: REPLAY_SPEED_MIN, maximum: REPLAY_SPEED_MAX },
        },
      },
    },
  }, async (req, reply): Promise<ReplayStatus | void> => {
    try {
      return deps.replay.control(req.body);
    } catch (e) {
      if (e instanceof RangeError) { return reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' }); }
      throw e;
    }
  });
}

import type { FastifyInstance } from 'fastify';
import { ReplayModeError, type RecorderControl } from './recording/contract.js';
import type { RecordingFolder, RecordingStartRequest, RecordingStatus } from './schema/v0.js';

/** `GET /v0/recording` (schema 0.12): the recording running now, or the last one. */
export const RECORDING_PATH = '/v0/recording';
/** `POST /v0/recording/start` (schema 0.12). */
export const RECORDING_START_PATH = '/v0/recording/start';
/** `POST /v0/recording/stop` (schema 0.12). */
export const RECORDING_STOP_PATH = '/v0/recording/stop';

/** How long a stop request waits at most for the recording's files to be written before it answers. */
export const RECORDING_STOP_WAIT_MS = 5_000;

/** What the recording routes need: the daemon's recorder, or null when the daemon replays a recording. */
export interface RecordingRouteDeps {
  recorder: RecorderControl | null;
}

/**
 * The status of a daemon where no recording has run - and, in replay mode,
 * none can (no folder, no limits).
 */
export function noRecordingStatus(folder: RecordingFolder | null = null): RecordingStatus {
  return {
    active: false, session: null, label: null, content: [], startedAt: null, endsAt: null, endedAt: null,
    folder, files: [], records: 0, bytes: 0, dropped: { call: 0, state: 0, sub: 0 },
    masking: { values: 0, derived: 0, weakValues: 0, maskedRecords: 0, droppedKeys: 0, refusedLines: 0 },
    limits: null, endReason: null, error: null,
  };
}

/**
 * The recorder's routes (schema 0.12). Every one needs the access token, and
 * a daemon that runs without one refuses them 403 `TOKEN_REQUIRED`: a
 * recording writes controller data to disk, so starting one is never open to
 * anyone on loopback, and neither is what it holds.
 *
 * - `GET /v0/recording`: `RecordingStatus`. File names are base names and
 *   the folder is only `default` or `custom`; no answer carries a path (the
 *   daemon's log names the folder).
 * - `POST /v0/recording/start` `{label?, content?, durationS?, limits?}`:
 *   201 `RecordingStatus`. A value out of the daemon's bounds is 400
 *   `BAD_REQUEST`; within them a request only tightens the daemon's own
 *   limits. 409 `RECORDING_ACTIVE` when one runs, 503 `RECORDING_FAILED` when
 *   the folder or the first part cannot be made or a limit is already
 *   reached, 409 `REPLAY_MODE` in replay mode.
 * - `POST /v0/recording/stop`: `RecordingStatus`; stopping when none runs is
 *   not an error.
 */
export async function registerRecordingRoutes(app: FastifyInstance, deps: RecordingRouteDeps): Promise<void> {
  const { recorder } = deps;

  app.get(RECORDING_PATH, { config: { tokenRequired: true } }, async (): Promise<RecordingStatus> =>
    recorder ? recorder.status() : noRecordingStatus());

  app.post<{ Body: RecordingStartRequest }>(RECORDING_START_PATH, {
    config: { tokenRequired: true },
    // No body is a start with the daemon's own settings; the recorder checks the rest (400 for anything else).
    preValidation: async req => {
      if (req.body === null || req.body === undefined) { req.body = {}; }
    },
  }, async (req, reply): Promise<RecordingStatus> => {
    if (!recorder) { throw new ReplayModeError('the daemon is replaying a recording and records nothing'); }
    const status = await recorder.start(req.body);
    reply.code(201);
    return status;
  });

  app.post(RECORDING_STOP_PATH, { config: { tokenRequired: true } }, async (): Promise<RecordingStatus> =>
    recorder ? recorder.stop('stopped', { waitMs: RECORDING_STOP_WAIT_MS }) : noRecordingStatus());
}

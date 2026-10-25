import { RwsError } from 'abb-rws-client';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  idFromName, ID_PATTERN, DISCOVERY_MANUAL_MAX, DISCOVERY_PORTS_MAX, DISCOVERY_RANGES_MAX, DISCOVERY_RANGE_TEXT_MAX,
  type ControllerConfig, type DiscoverySettings,
} from './config.js';
import { RANGE_SCAN_INTERVAL_MS, type DiscoverRequest, type DiscoveryAnswer } from './discovery.js';
import { redactSecrets } from './errorMap.js';
import { sameSystemId, type FleetLike } from './fleet.js';
import { IO_LEASE_MS, IO_TABLE_RETRY_AFTER_S } from './io.js';
import { LEASE_ID } from './lease.js';
import { MOTION_LEASE_MS } from './motion.js';
import type { Passport, PassportTarget } from './passport.js';
import { ReplayModeError } from './recording/contract.js';
import {
  EVENTS_PAGE_DEFAULT, EVENTS_PAGE_MAX, SCHEMA_VERSION, WATCH_LEASES_MAX,
  type ControllerList, type ControllerSnapshot, type EventsPage, type IoWatch, type IoWatchRequest, type MotionWatch,
  type MotionWatchRequest, type RapidModuleSource, type ShutdownAnswer,
} from './schema/v0.js';

export interface RouteDeps {
  fleet: FleetLike;
  /**
   * One discovery run (discovery.ts `discover`). `signal` aborts when the
   * caller hangs up. Bad input rejects with the client's INVALID_ARGUMENT
   * error before anything is sent.
   */
  discover(request: DiscoverRequest, configured: ControllerConfig[], signal: AbortSignal): Promise<DiscoveryAnswer>;
  readPassport(target: PassportTarget): Promise<Passport>;
  /** The discovery inputs saved in the config file; without it the saved-inputs routes are not served. */
  savedDiscovery?: SavedDiscovery;
  now?: () => number;
}

/** Saved discovery inputs: they pre-fill a scan, and the daemon never scans them on its own. */
export interface SavedDiscovery {
  get(): DiscoverySettings | Promise<DiscoverySettings>;
  /** Save, replacing what was saved, and answer what was saved. Rejects when the config could not be written. */
  set(settings: DiscoverySettings): Promise<DiscoverySettings>;
}

// A host name or an IPv4 literal.
const HOST = { type: 'string', minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9.-]+$' } as const;
const PORT = { type: 'integer', minimum: 1, maximum: 65535 } as const;

// What a scan may name besides this PC: addresses (a host, optionally a port
// and a scheme), IPv4 ranges and extra ports. Only syntax and counts are
// checked here; the client checks the rest (range sizes, address classes),
// and its refusal comes back as a 400 naming the field.
const DISCOVERY_INPUTS = {
  manual: {
    type: 'array', maxItems: DISCOVERY_MANUAL_MAX,
    items: {
      type: 'object', required: ['host'], additionalProperties: false,
      properties: { host: HOST, port: PORT, https: { type: 'boolean' } },
    },
  },
  ranges: { type: 'array', maxItems: DISCOVERY_RANGES_MAX, items: { type: 'string', minLength: 1, maxLength: DISCOVERY_RANGE_TEXT_MAX } },
  ports: { type: 'array', maxItems: DISCOVERY_PORTS_MAX, items: PORT },
} as const;

/**
 * The client's refusal of a discovery input as a 400 body: the message, the
 * code, and the field, value and cap it names. `hosts` ride after `manual`
 * in the client's list, so a field there is named as the caller sent it.
 */
function invalidDiscoveryInput(e: RwsError, request: DiscoverRequest): Record<string, unknown> {
  const detail = e as RwsError & { field?: unknown; value?: unknown; limit?: unknown };
  let message = e.message.replace(/^findControllers:\s*/, '');
  let field = typeof detail.field === 'string' ? detail.field : undefined;
  const manual = request.manual?.length ?? 0;
  const at = field ? /^manual\[(\d+)\](.*)$/.exec(field) : null;
  if (field && at && Number(at[1]) >= manual) {
    const named = `hosts[${Number(at[1]) - manual}]${at[2]}`;
    message = message.replace(field, named);
    field = named;
  }
  return {
    error: redactSecrets(message),
    code: 'INVALID_ARGUMENT',
    ...(field !== undefined ? { field } : {}),
    ...(typeof detail.value === 'string' ? { value: redactSecrets(detail.value) } : {}),
    ...(typeof detail.limit === 'number' || typeof detail.limit === 'string' ? { limit: detail.limit } : {}),
  };
}

const TARGET = {
  type: 'object',
  required: ['host', 'port', 'useHttps', 'username', 'password'],
  additionalProperties: false,
  properties: {
    host: HOST, port: PORT, useHttps: { type: 'boolean' },
    username: { type: 'string', maxLength: 128 }, password: { type: 'string', maxLength: 128 },
  },
} as const;

/** Controller list, controller detail, and the first-run setup flow. */
export async function registerControllerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const notFound = (id: string) => ({ error: `no controller with id "${id}"`, code: 'NO_CONTROLLER' });
  const mismatch = (snap: ControllerSnapshot) => ({
    error: `${snap.link.host}:${snap.link.port} answers as a different controller`
      + ` (system id ${snap.link.identityCheck.actual}, expected ${snap.link.identityCheck.expected})`,
    code: 'IDENTITY_MISMATCH',
  });

  app.get('/v0/controllers', async (): Promise<ControllerList> => ({
    schemaVersion: SCHEMA_VERSION,
    observedAt: new Date(now()).toISOString(),
    controllers: deps.fleet.list(),
  }));

  app.get<{ Params: { id: string } }>('/v0/controllers/:id', async (req, reply) => {
    const c = deps.fleet.get(req.params.id);
    return c ?? reply.code(404).send(notFound(req.params.id));
  });

  // A module's source, read from the controller on request - on its
  // read budget (schema 0.7): 429 READ_LIMIT with a Retry-After when the
  // budget has no room, and the same request while one is out shares it.
  // A RAPID task or module name: an identifier of at most 32 characters.
  const RAPID_NAME = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,31}$' } as const;
  app.get<{ Params: { id: string; task: string; module: string } }>('/v0/controllers/:id/rapid/tasks/:task/modules/:module', {
    schema: {
      params: {
        type: 'object', required: ['id', 'task', 'module'],
        properties: { id: { type: 'string' }, task: RAPID_NAME, module: RAPID_NAME },
      },
    },
  }, async (req, reply): Promise<RapidModuleSource | void> => {
    const snap = deps.fleet.get(req.params.id);
    if (!snap) { return reply.code(404).send(notFound(req.params.id)); }
    // Never read a program from the wrong robot: the link is refused for
    // values, so it is refused for source too.
    if (snap.link.identityCheck.status === 'mismatch') { return reply.code(409).send(mismatch(snap)); }
    const src = await deps.fleet.moduleSource(req.params.id, req.params.task, req.params.module);
    return src ?? reply.code(404).send(notFound(req.params.id));
  });

  // A watch lease's id (schema 0.6): NEW_LEASE, or one a grant returned.
  const LEASE_ID_FIELD = { type: 'string', pattern: LEASE_ID.source } as const;
  const leaseLimit = (reply: FastifyReply, id: string, what: string, leaseMs: number) =>
    reply.code(429).header('Retry-After', String(Math.ceil(leaseMs / 1000))).send({
      error: `"${id}" already holds ${WATCH_LEASES_MAX} ${what} watch leases with an id; one frees when it is not renewed`,
      code: 'LEASE_LIMIT',
    });

  // Start or renew a motion watch lease. Joint positions are polled
  // only while a lease is held; renew it at least every leaseMs / 2. A lease
  // may be taken while the controller is disconnected: sampling starts when the
  // link is healthy. Never on a link to the wrong controller. The body is
  // optional: without a `leaseId` the request renews the shared anonymous
  // lease; `leaseId` NEW_LEASE opens the caller's own, whose id the answer
  // carries for the renewals.
  app.post<{ Params: { id: string }; Body: MotionWatchRequest }>('/v0/controllers/:id/motion/watch', {
    // A request with no body (or one that is not a JSON object) is a renewal
    // of the anonymous lease, as before leases had ids.
    preValidation: async req => {
      if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) { req.body = {}; }
    },
    schema: {
      body: { type: 'object', additionalProperties: false, properties: { leaseId: LEASE_ID_FIELD } },
    },
  }, async (req, reply): Promise<MotionWatch | void> => {
    const snap = deps.fleet.get(req.params.id);
    if (!snap) { return reply.code(404).send(notFound(req.params.id)); }
    if (snap.link.identityCheck.status === 'mismatch') { return reply.code(409).send(mismatch(snap)); }
    const watch = deps.fleet.watchMotion(req.params.id, req.body.leaseId);
    if (watch === 'lease-limit') { return leaseLimit(reply, req.params.id, 'motion', MOTION_LEASE_MS); }
    return watch ?? reply.code(404).send(notFound(req.params.id));
  });

  // Start or renew an I/O watch lease. The request REPLACES the set
  // of the lease it renews - renew by sending the same list; an empty list
  // leaves the lease holding none. Without a `leaseId` that is the shared
  // anonymous lease; with one, the caller's own (NEW_LEASE opens it), and the
  // daemon watches the union of every lease's set. Names that are not signal
  // names, not in the controller's loaded signal table, or over the lease's or
  // the controller's cap come back in `rejected`, with the reason.
  app.post<{ Params: { id: string }; Body: IoWatchRequest }>('/v0/controllers/:id/io/watch', {
    schema: {
      body: {
        type: 'object', required: ['signals'], additionalProperties: false,
        properties: {
          signals: { type: 'array', maxItems: 256, items: { type: 'string', minLength: 1, maxLength: 160 } },
          leaseId: LEASE_ID_FIELD,
        },
      },
    },
  }, async (req, reply): Promise<IoWatch | void> => {
    const snap = deps.fleet.get(req.params.id);
    if (!snap) { return reply.code(404).send(notFound(req.params.id)); }
    if (snap.link.identityCheck.status === 'mismatch') { return reply.code(409).send(mismatch(snap)); }
    const watch = deps.fleet.watchIo(req.params.id, req.body.signals, req.body.leaseId);
    if (watch === 'lease-limit') { return leaseLimit(reply, req.params.id, 'I/O', IO_LEASE_MS); }
    return watch ?? reply.code(404).send(notFound(req.params.id));
  });

  // The controller's signal table: server-side search when criteria
  // are given, the cached full table otherwise. Values here are a directory
  // for picking signals to watch - the watched, live values ride the io group.
  // While the cached table is not read on the current connection (the link is
  // down, or just came up) the answer is 503 NOT_READY with a Retry-After, never
  // an empty list a consumer could take for "no signals". A search goes to the
  // controller on its read budget (schema 0.7): 429 READ_LIMIT with a
  // Retry-After when the budget has no room; the table itself costs nothing.
  app.get<{ Params: { id: string }; Querystring: { name?: string; device?: string; network?: string; category?: string; type?: string } }>(
    '/v0/controllers/:id/io/signals', {
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 160 }, device: { type: 'string', maxLength: 160 },
            network: { type: 'string', maxLength: 160 }, category: { type: 'string', maxLength: 160 },
            type: { type: 'string', maxLength: 16 },
          },
        },
      },
    }, async (req, reply) => {
      const snap = deps.fleet.get(req.params.id);
      if (!snap) { return reply.code(404).send(notFound(req.params.id)); }
      if (snap.link.identityCheck.status === 'mismatch') { return reply.code(409).send(mismatch(snap)); }
      const signals = await deps.fleet.searchIoSignals(req.params.id, req.query);
      if (!signals) { return reply.code(404).send(notFound(req.params.id)); }
      if (signals === 'not-loaded') {
        return reply.code(503).header('Retry-After', String(IO_TABLE_RETRY_AFTER_S)).send({
          error: `the signal table of "${req.params.id}" has not been read on its current connection yet`,
          code: 'NOT_READY',
        });
      }
      return { signals: signals.map(s => ({ name: s.name, type: s.type ?? null, value: s.lvalue ?? s.value ?? null })) };
    });

  // The controller's event log, served from the daemon's memory: no
  // request reaches the controller. Without `since`: the newest `limit`
  // events. With it: the events after that seq, oldest first, at most
  // `limit`; `more` says another page follows, `gap` that events after
  // `since` were dropped from memory before this read. Like every other
  // route, never for a link on the wrong controller.
  app.get<{ Params: { id: string }; Querystring: { since?: number; limit?: number } }>('/v0/controllers/:id/events', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          since: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          limit: { type: 'integer', minimum: 1, maximum: EVENTS_PAGE_MAX },
        },
      },
    },
  }, async (req, reply): Promise<EventsPage | void> => {
    const snap = deps.fleet.get(req.params.id);
    if (!snap) { return reply.code(404).send(notFound(req.params.id)); }
    if (snap.link.identityCheck.status === 'mismatch') { return reply.code(409).send(mismatch(snap)); }
    const page = deps.fleet.events(req.params.id, req.query.since, req.query.limit ?? EVENTS_PAGE_DEFAULT);
    return page ?? reply.code(404).send(notFound(req.params.id));
  });

  // Discovery (setup): this PC always; the service address and mDNS unless
  // the request turns them off; named addresses, ranges and extra ports only
  // when the request names them - saved inputs are never scanned on their
  // own. One run at a time (409 DISCOVERY_RUNNING), and a run with ranges
  // only RANGE_SCAN_INTERVAL_MS after the previous one with ranges ended
  // (429 DISCOVERY_LIMIT with a Retry-After): a range scan opens connections
  // across the network, and its IT can see them. A caller that hangs up
  // cancels the run.
  let discovering = false;
  let rangeScanEndedAt: number | null = null;
  app.post<{ Body: DiscoverRequest }>('/v0/setup/discover', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          hosts: { type: 'array', maxItems: DISCOVERY_MANUAL_MAX, items: HOST },
          ...DISCOVERY_INPUTS,
          serviceAddress: { type: 'boolean' },
          mdns: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply): Promise<DiscoveryAnswer | void> => {
    const request: DiscoverRequest = req.body ?? {};
    // The client caps the named addresses as one list (`hosts` ride after
    // `manual`); the schema caps each alone, so the sum is checked here and
    // named as the caller sent it.
    const named = (request.manual?.length ?? 0) + (request.hosts?.length ?? 0);
    if (named > DISCOVERY_MANUAL_MAX) {
      return reply.code(400).send({
        error: `manual, hosts: at most ${DISCOVERY_MANUAL_MAX} entries together (got ${named}). Nothing was sent.`,
        code: 'INVALID_ARGUMENT', field: 'manual, hosts', value: String(named), limit: DISCOVERY_MANUAL_MAX,
      });
    }
    if (discovering) {
      return reply.code(409).send({ error: 'a discovery is already running; ask again when it has finished', code: 'DISCOVERY_RUNNING' });
    }
    const ranged = (request.ranges?.length ?? 0) > 0;
    const waitMs = ranged && rangeScanEndedAt !== null ? rangeScanEndedAt + RANGE_SCAN_INTERVAL_MS - now() : 0;
    if (waitMs > 0) {
      const retryS = Math.max(1, Math.ceil(waitMs / 1000));
      return reply.code(429).header('Retry-After', String(retryS)).send({
        error: `a range scan ended less than ${RANGE_SCAN_INTERVAL_MS / 1000} s ago; try again in ${retryS} s`,
        code: 'DISCOVERY_LIMIT',
      });
    }
    discovering = true;
    const cancel = new AbortController();
    const hungUp = (): void => { if (!reply.raw.writableFinished) { cancel.abort(); } };
    reply.raw.once('close', hungUp);
    let sent = true;
    try {
      return await deps.discover(request, deps.fleet.all(), cancel.signal);
    } catch (e) {
      if (e instanceof RwsError && e.code === 'INVALID_ARGUMENT') {
        sent = false;   // refused before anything was sent
        return reply.code(400).send(invalidDiscoveryInput(e, request));
      }
      throw e;
    } finally {
      discovering = false;
      reply.raw.off('close', hungUp);
      if (ranged && sent) { rangeScanEndedAt = now(); }
    }
  });

  // The discovery inputs saved in the config file, to pre-fill a scan.
  // Saving replaces them; DELETE removes one entry (by value) or every address
  // and range (the extra ports stay). The daemon
  // never scans them on its own. Changes run one after another, so a removal
  // always applies to what the change before it saved.
  const saved = deps.savedDiscovery;
  if (saved) {
    let changes: Promise<unknown> = Promise.resolve();
    const change = (next: (current: DiscoverySettings) => DiscoverySettings | null, reply: FastifyReply) => {
      const run = changes.then(async (): Promise<DiscoverySettings | FastifyReply> => {
        const current = await saved.get();
        const wanted = next(current);
        if (wanted === null) { return reply; }   // refused: `next` has sent the answer
        try {
          return await saved.set(wanted);
        } catch (e) {
          // A replaying daemon saves nothing: 409 REPLAY_MODE, not a failed write.
          if (e instanceof ReplayModeError) { throw e; }
          return reply.code(503).send({ error: redactSecrets(e instanceof Error ? e.message : String(e)), code: 'NOT_SAVED' });
        }
      });
      changes = run.catch(() => {});
      return run;
    };
    app.get('/v0/setup/discover/saved', async (): Promise<DiscoverySettings> => saved.get());
    app.put<{ Body: Partial<DiscoverySettings> }>('/v0/setup/discover/saved', {
      schema: { body: { type: 'object', additionalProperties: false, properties: DISCOVERY_INPUTS } },
    }, async (req, reply): Promise<DiscoverySettings | FastifyReply> => {
      const b = req.body ?? {};
      return change(() => ({ manual: b.manual ?? [], ranges: b.ranges ?? [], ports: b.ports ?? [] }), reply);
    });
    // Clear the saved addresses and ranges (schema 0.11). The extra ports
    // stay: they are settings, not something a scan found or was typed.
    app.delete('/v0/setup/discover/saved', async (_req, reply): Promise<DiscoverySettings | FastifyReply> =>
      change(current => ({ manual: [], ranges: [], ports: [...current.ports] }), reply));
    // Remove one saved entry by its value, never by position: a change made
    // meanwhile (another tab, another consumer) cannot shift it onto the wrong
    // entry (schema 0.11). Every equal entry goes; answers what is saved
    // afterwards; 404 NO_SAVED_ENTRY when nothing equal is saved, and nothing
    // is written.
    const removeEqual = <K extends keyof DiscoverySettings>(
      list: K, equal: (e: DiscoverySettings[K][number]) => boolean, what: string, reply: FastifyReply,
    ) => change(current => {
      const entries = current[list] as DiscoverySettings[K][number][];
      const kept = entries.filter(e => !equal(e));
      if (kept.length === entries.length) {
        reply.code(404).send({ error: `no saved ${list} entry ${what}`, code: 'NO_SAVED_ENTRY' });
        return null;
      }
      return { ...current, [list]: kept };
    }, reply);
    // An address: its host (letter case aside), and its port and scheme exactly, a missing one matching only a missing one.
    app.delete<{ Querystring: { host: string; port?: number; https?: boolean } }>('/v0/setup/discover/saved/manual', {
      schema: {
        querystring: {
          type: 'object', required: ['host'], additionalProperties: false,
          properties: { host: HOST, port: PORT, https: { type: 'boolean' } },
        },
      },
    }, async (req, reply): Promise<DiscoverySettings | FastifyReply> => {
      const { host, port, https } = req.query;
      const label = `${host}${port !== undefined ? `:${port}` : ''}${https !== undefined ? ` (${https ? 'HTTPS' : 'HTTP'})` : ''}`;
      return removeEqual('manual',
        e => e.host.toLowerCase() === host.toLowerCase() && e.port === port && e.https === https, `for ${label}`, reply);
    });
    app.delete<{ Querystring: { range: string } }>('/v0/setup/discover/saved/ranges', {
      schema: {
        querystring: {
          type: 'object', required: ['range'], additionalProperties: false,
          properties: { range: { type: 'string', minLength: 1, maxLength: DISCOVERY_RANGE_TEXT_MAX } },
        },
      },
    }, async (req, reply): Promise<DiscoverySettings | FastifyReply> =>
      removeEqual('ranges', e => e === req.query.range, `equal to ${req.query.range}`, reply));
    app.delete<{ Querystring: { port: number } }>('/v0/setup/discover/saved/ports', {
      schema: {
        querystring: { type: 'object', required: ['port'], additionalProperties: false, properties: { port: PORT } },
      },
    }, async (req, reply): Promise<DiscoverySettings | FastifyReply> =>
      removeEqual('ports', e => e === req.query.port, `equal to ${req.query.port}`, reply));
  }

  // Reads identity with the given credentials. Returns nothing secret.
  app.post<{ Body: PassportTarget }>('/v0/setup/passport', { schema: { body: TARGET } },
    async req => deps.readPassport(req.body));

  app.post<{ Body: PassportTarget & { id?: string; name?: string; systemId?: string } }>('/v0/controllers', {
    schema: {
      body: {
        ...TARGET,
        properties: {
          ...TARGET.properties,
          id: { type: 'string', pattern: ID_PATTERN.source },
          systemId: { type: 'string', minLength: 1, maxLength: 64 },
          name: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body;
    const all = deps.fleet.all();
    // A controller is identified by its system id, not its address: virtual
    // controllers move and swap ports, so an address saved for one controller
    // can later belong to another. An address only blocks an add when the two
    // cannot be told apart.
    const sameSystem = b.systemId
      ? all.find(c => c.systemId && sameSystemId(c.systemId, b.systemId!))
      : undefined;
    if (sameSystem) {
      return reply.code(409).send({ error: `already added as "${sameSystem.id}"`, code: 'ALREADY_ADDED' });
    }
    const sameAddress = all.find(c => c.host === b.host && c.port === b.port);
    if (sameAddress && (!b.systemId || !sameAddress.systemId)) {
      return reply.code(409).send({
        error: `address already used by "${sameAddress.id}" and the controllers cannot be told apart without system ids`,
        code: 'ALREADY_ADDED',
      });
    }
    if (b.id && deps.fleet.has(b.id)) {
      return reply.code(409).send({ error: `id "${b.id}" is taken`, code: 'ID_TAKEN' });
    }
    const name = b.name ?? `${b.host}:${b.port}`;
    const cfg: ControllerConfig = {
      id: b.id ?? idFromName(name, new Set(all.map(c => c.id))),
      name, host: b.host, port: b.port, useHttps: b.useHttps, username: b.username, password: b.password,
      ...(b.systemId ? { systemId: b.systemId } : {}),
    };
    deps.fleet.add(cfg);
    return reply.code(201).send(deps.fleet.get(cfg.id));
  });

  app.delete<{ Params: { id: string } }>('/v0/controllers/:id', async (req, reply) => {
    if (!deps.fleet.has(req.params.id)) { return reply.code(404).send(notFound(req.params.id)); }
    await deps.fleet.remove(req.params.id);
    return reply.code(204).send();
  });
}

/** Stops the daemon (schema 0.9). */
export const SHUTDOWN_PATH = '/v0/admin/shutdown';

/** What the admin routes need of the daemon's stop (DaemonStop). */
export interface AdminDeps {
  stop: {
    /** A stop has begun. */
    readonly stopping: boolean;
    /** At most how long (ms) until the process exits. */
    exitWithinMs(): number;
    /** Start the stop (once; a later call joins it). Never rejects. */
    stop(reason: string): Promise<void>;
  };
}

/**
 * `POST /v0/admin/shutdown` (schema 0.9): stop the daemon as a stop signal
 * does - log out of every controller, close, exit. It needs the access
 * token, takes no browser request (a page has no use for it), and a server
 * that checks no token refuses it (TOKEN_REQUIRED). The
 * answer goes out first and the stop begins once it has left, so the caller
 * always hears back and the server's close never waits on this request.
 */
export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  app.post(SHUTDOWN_PATH, { config: { tokenRequired: true, nativeOnly: true } }, async (_req, reply): Promise<ShutdownAnswer> => {
    const alreadyStopping = deps.stop.stopping;
    reply.raw.once('close', () => { void deps.stop.stop(`POST ${SHUTDOWN_PATH}`); });
    reply.code(202);
    return { stopping: true, alreadyStopping, exitWithinMs: deps.stop.exitWithinMs() };
  });
}

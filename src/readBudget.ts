import { READS_IN_FLIGHT_MAX } from './schema/v0.js';

/**
 * The on-demand read budget: reads a route makes of a controller because a
 * consumer asked for them (a module's source, a signal search), as opposed to
 * the daemon's own sampling. Every request to a controller rides one paced
 * queue in its session, shared with the samplers and with no priorities, so
 * each on-demand read pushes the samplers' reads back. Per controller:
 *  - at most READS_IN_FLIGHT_MAX reads are out at a time, so at most that many
 *    requests wait in the queue ahead of a sampler's read;
 *  - together they make at most READ_RATE_PER_S controller requests a second
 *    on average, in bursts of up to READ_BURST: the room the samplers' budget
 *    (IO_CEILING_REQ_S) leaves below the queue's pace;
 *  - a request identical to one in flight (the same key) joins it instead of
 *    sending another;
 *  - an answer whose data is stable is kept for a short while (READ_CACHE_MS,
 *    or as long as the caller knows it stays valid) and served from memory.
 * A read the budget cannot take now is refused with ReadLimitError, which the
 * server answers 429 READ_LIMIT with a Retry-After. Joining a read in flight
 * and an answer from memory cost nothing and are never refused.
 * READS_IN_FLIGHT_MAX and READ_CACHE_MS are part of the schema (0.7).
 */

/** Controller requests a second the on-demand reads of one controller may make, on average. */
export const READ_RATE_PER_S = 2;

/** The most controller requests the on-demand reads of one controller may make in a burst, after a quiet spell. */
export const READ_BURST = 4;

/** Seconds a caller refused because the reads in flight are at their limit is told to wait: about one read's time. */
export const READ_IN_FLIGHT_RETRY_AFTER_S = 1;

/** A read the controller's budget has no room for now. The server answers it 429 READ_LIMIT with `Retry-After: retryAfterS`. */
export class ReadLimitError extends Error {
  constructor(
    readonly controller: string,
    /** Whole seconds, at least 1, before asking again has a chance. */
    readonly retryAfterS: number,
    /** What is used up: the reads in flight, or the request rate. */
    readonly limit: 'in-flight' | 'rate',
  ) {
    super(limit === 'in-flight'
      ? `"${controller}" already has ${READS_IN_FLIGHT_MAX} on-demand reads in flight, the most it takes at a time; try again in ${retryAfterS} s`
      : `on-demand reads of "${controller}" are over their rate (about ${READ_RATE_PER_S} controller requests a second); try again in ${retryAfterS} s`);
    this.name = 'ReadLimitError';
  }
}

export interface ReadOptions {
  /** The controller requests the read makes: what it takes from the rate (default 1). */
  cost?: number;
  /** Keep a successful answer this long (ms) under its key; 0 (the default) keeps none. A failure is never kept. */
  cacheMs?: number;
}

/** One controller's share: the reads out by key, the answers kept by key, and the rate's bucket. */
interface ControllerReads {
  inFlight: Map<string, Promise<unknown>>;
  kept: Map<string, { value: unknown; until: number }>;
  tokens: number;
  refilledAt: number;
}

/**
 * The budget of every controller. Keys are the caller's: a key names one
 * answer, so two requests with the same key must want the same thing - the
 * caller puts into it whatever the answer depends on (the connection, the
 * criteria). Answers are shared between callers as they are; none may change
 * one it is given.
 */
export class ReadBudget {
  private readonly controllers = new Map<string, ControllerReads>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * `read` on `controller`'s budget: an answer kept under `key` if there is
   * one, else the read in flight under `key` if there is one, else a new read
   * if the budget has room - else a rejection with ReadLimitError, and `read`
   * is not called. A new read is called at once; it may use `peek` and `keep`
   * but must not start another read of its own through `run`.
   */
  run<T>(controller: string, key: string, read: () => Promise<T>, opts: ReadOptions = {}): Promise<T> {
    const c = this.stateOf(controller);
    const t = this.now();
    this.dropExpired(c, t);
    const kept = c.kept.get(key);
    if (kept) { return Promise.resolve(kept.value as T); }
    const out = c.inFlight.get(key);
    if (out) { return out as Promise<T>; }
    if (c.inFlight.size >= READS_IN_FLIGHT_MAX) {
      return Promise.reject(new ReadLimitError(controller, READ_IN_FLIGHT_RETRY_AFTER_S, 'in-flight'));
    }
    // A read dearer than a whole burst is charged a burst, or it could never run.
    const cost = Math.min(READ_BURST, Math.max(1, opts.cost ?? 1));
    this.refill(c, t);
    if (c.tokens < cost) {
      const waitS = (cost - c.tokens) / READ_RATE_PER_S;
      return Promise.reject(new ReadLimitError(controller, Math.max(1, Math.ceil(waitS)), 'rate'));
    }
    c.tokens -= cost;
    const cacheMs = opts.cacheMs ?? 0;
    // Started at once, so its first request joins the controller's queue now.
    let started: Promise<T>;
    try { started = read(); } catch (e) { started = Promise.reject(e); }   // a read that throws at once is a rejection like any other
    const tracked: Promise<T> = Promise.resolve(started)
      .then(value => {
        if (cacheMs > 0) { c.kept.set(key, { value, until: this.now() + cacheMs }); }
        return value;
      })
      .finally(() => { if (c.inFlight.get(key) === tracked) { c.inFlight.delete(key); } });
    c.inFlight.set(key, tracked);
    return tracked;
  }

  /** The answer kept under `key`, if it is still fresh. */
  peek<T>(controller: string, key: string): T | undefined {
    const c = this.controllers.get(controller);
    if (!c) { return undefined; }
    this.dropExpired(c, this.now());
    return c.kept.get(key)?.value as T | undefined;
  }

  /** Keep an answer read as part of another read (see `peek`) for `ms`. */
  keep(controller: string, key: string, value: unknown, ms: number): void {
    this.stateOf(controller).kept.set(key, { value, until: this.now() + ms });
  }

  /** The reads in flight - of one controller, or of all - so a teardown can wait for them. */
  inFlight(controller?: string): Array<Promise<unknown>> {
    const of = controller === undefined ? [...this.controllers.values()] : [this.controllers.get(controller)];
    return of.flatMap(c => (c ? [...c.inFlight.values()] : []));
  }

  /** Forget a controller: its kept answers and its share. Reads still in flight settle as usual. */
  forget(controller: string): void {
    this.controllers.delete(controller);
  }

  private stateOf(controller: string): ControllerReads {
    let c = this.controllers.get(controller);
    if (!c) {
      c = { inFlight: new Map(), kept: new Map(), tokens: READ_BURST, refilledAt: this.now() };
      this.controllers.set(controller, c);
    }
    return c;
  }

  private refill(c: ControllerReads, t: number): void {
    const elapsed = Math.max(0, t - c.refilledAt);
    c.tokens = Math.min(READ_BURST, c.tokens + (elapsed / 1_000) * READ_RATE_PER_S);
    c.refilledAt = t;
  }

  private dropExpired(c: ControllerReads, t: number): void {
    for (const [key, e] of c.kept) { if (e.until <= t) { c.kept.delete(key); } }
  }
}

import type { Signal } from 'abb-rws-client';
import type { ControllerConfig } from '../config.js';
import { moduleKind, type ControllerLogout, type FleetLike } from '../fleet.js';
import { IO_LEASE_MS, IO_WATCH_LEASE_MAX, ioLeaseGrant, type IoLease } from '../io.js';
import { ANONYMOUS_LEASE, leaseIdField, leaseKeyFor, leaseLimitReached } from '../lease.js';
import { MOTION_LEASE_MS, motionTargetHz } from '../motion.js';
import { NotRecordedError, ReplayModeError } from '../recording/contract.js';
import type { StreamSource } from '../stream.js';
import type {
  ControllerSnapshot, EventsPage, IoWatch, LinkQuality, MotionWatch, RapidModuleSource,
} from '../schema/v0.js';
import type { RecordingIndex } from './reader.js';
import type { ReplayStream } from './stream.js';

/** Why a replayed I/O watch refuses a signal. */
export const NOT_IN_RECORDING = 'not in this recording';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A recorded value left out of the recording, or an array cut short: not an answer. */
const incomplete = (v: unknown): boolean =>
  (isObj(v) && ('$omitted' in v || '$truncated' in v)) || (Array.isArray(v) && v.some(incomplete));

/**
 * The fleet of a replaying daemon: every route answers from the recording at
 * the replay's position, and nothing can reach a controller - there is no
 * client, no configuration and no credential in the process.
 *
 * - Controllers, one controller: the replay's state at the position (times
 *   and event feed as the replay serves them).
 * - A module's source: the last recorded read of that module (with the
 *   task's module listing, for its kind) at or before the position; else
 *   NotRecordedError (404 `NOT_RECORDED`).
 * - The signal table: the client's table as recorded at the position (or
 *   `not-loaded`, as live); a search: a recorded search with equal criteria.
 *   Never an older answer than the position: NotRecordedError instead.
 * - Watches are granted as live and change nothing; an I/O watch accepts
 *   the signals the recording's io group carries anywhere.
 * - Events: from every event the recording carried, `gap` where it never
 *   carried some.
 * - Adding or removing a controller throws ReplayModeError (409 `REPLAY_MODE`).
 */
export class ReplayFleet implements FleetLike, StreamSource {
  private readonly motionLeases = new Map<string, Map<string, number>>();
  private readonly ioLeases = new Map<string, Map<string, IoLease>>();
  private readonly changeHandlers: Array<(id: string) => void> = [];
  private readonly wallNow: () => number;

  constructor(
    private readonly replay: ReplayStream,
    private readonly index: RecordingIndex,
    opts: { wallNow?: () => number } = {},
  ) {
    this.wallNow = opts.wallNow ?? (() => Date.now());
    replay.onApplied(ids => {
      for (const id of ids) {
        for (const cb of this.changeHandlers) { cb(id); }
      }
    });
  }

  has(id: string): boolean { return this.replay.state.has(id); }

  /** No configured controllers: a replay holds no configuration. */
  all(): ControllerConfig[] { return []; }

  list(): ControllerSnapshot[] {
    return this.replay.state.list().map(c => this.replay.mapAnswer('ControllerSnapshot', structuredClone(c)));
  }

  get(id: string): ControllerSnapshot | null {
    const c = this.replay.state.get(id);
    return c ? this.replay.mapAnswer('ControllerSnapshot', structuredClone(c)) : null;
  }

  /** The moment a list answer made now stands for (ms since the epoch), for its `observedAt`. */
  now(): number { return this.replay.answerNowMs(); }

  onChanged(cb: (id: string) => void): void { this.changeHandlers.push(cb); }

  add(_cfg: ControllerConfig): void { throw new ReplayModeError(); }

  async remove(_id: string): Promise<void> { throw new ReplayModeError(); }

  /** Nothing to log out of: the daemon's stop finds no session. */
  async disconnectAll(_opts: { waitMs?: number } = {}): Promise<ControllerLogout[]> { return []; }

  async moduleSource(id: string, task: string, module: string): Promise<RapidModuleSource | null> {
    if (!this.has(id)) { return null; }
    const at = this.replay.positionMs();
    const read = this.index.latestCall(id, 'getModuleText', [task, module], at);
    const result = read?.result;
    if (!read || !read.ok || !isObj(result) || typeof result.text !== 'string' || incomplete(result)) {
      throw new NotRecordedError(!read
        ? `the recording holds no source of module ${module} in task ${task} of "${id}" at this point`
        : `the recording holds no readable source of module ${module} in task ${task} of "${id}" at this point (the last read failed or was left out)`);
    }
    const listing = this.index.latestCall(id, 'listModulesDetailed', [task], at);
    const entry = listing?.ok && Array.isArray(listing.result)
      ? listing.result.find((m): m is Obj => isObj(m) && m.name === module)
      : undefined;
    return {
      task, module,
      kind: moduleKind(typeof entry?.type === 'string' ? entry.type : null),
      text: result.text,
      changeCount: typeof result.changeCount === 'number' ? result.changeCount : null,
    };
  }

  watchMotion(id: string, leaseId?: string): MotionWatch | null | 'lease-limit' {
    const c = this.replay.state.get(id);
    if (!c) { return null; }
    const leases = this.leasesOf(this.motionLeases, id);
    const now = this.wallNow();
    for (const [key, until] of leases) { if (until <= now) { leases.delete(key); } }
    const key = leaseKeyFor(leaseId);
    if (leaseLimitReached(leases, key)) { return 'lease-limit'; }
    leases.set(key, now + MOTION_LEASE_MS);
    const quality = (c.link as { quality?: LinkQuality } | undefined)?.quality;
    const targetHz = this.replay.state.lastTargetHz(id) ?? motionTargetHz(quality);
    return { leaseMs: MOTION_LEASE_MS, targetHz, ...leaseIdField(key) };
  }

  watchIo(id: string, signals: string[], leaseId?: string): IoWatch | null | 'lease-limit' {
    if (!this.has(id)) { return null; }
    const leases = this.leasesOf(this.ioLeases, id);
    const now = this.wallNow();
    for (const [key, l] of leases) { if (l.until <= now) { leases.delete(key); } }
    const key = leaseKeyFor(leaseId);
    if (leaseLimitReached(leases, key)) { return 'lease-limit'; }
    const others = new Set<string>();
    for (const [k, l] of leases) { if (k !== key) { for (const n of l.names) { others.add(n); } } }
    const recorded = this.index.ioSignalNames(id);
    const { accepted, rejected } = ioLeaseGrant(signals, name => (recorded.has(name) ? null : NOT_IN_RECORDING), others,
      key === ANONYMOUS_LEASE ? null : IO_WATCH_LEASE_MAX);
    leases.set(key, { until: now + IO_LEASE_MS, names: accepted });
    return { leaseMs: IO_LEASE_MS, accepted, rejected, ...leaseIdField(key) };
  }

  async searchIoSignals(
    id: string, criteria: { name?: string; device?: string; network?: string; category?: string; type?: string },
  ): Promise<Signal[] | null | 'not-loaded'> {
    if (!this.has(id)) { return null; }
    const at = this.replay.positionMs();
    const some = Object.values(criteria).some(v => typeof v === 'string' && v.length > 0);
    if (!some) {
      const table = this.index.ioTableAt(id, at);
      if (table.status === 'not-loaded') { return 'not-loaded'; }
      if (table.status === 'not-recorded') {
        throw new NotRecordedError(`the recording does not hold the whole signal table of "${id}" at this point`);
      }
      return structuredClone([...table.signals]) as Signal[];
    }
    const search = this.index.latestCall(id, 'searchSignals', [criteria], at);
    if (!search || !search.ok || !Array.isArray(search.result) || incomplete(search.result)) {
      throw new NotRecordedError(`the recording holds no whole search of the signals of "${id}" with these criteria at this point`);
    }
    return structuredClone(search.result) as Signal[];
  }

  events(id: string, since: number | undefined, limit: number): EventsPage | null {
    const page = this.replay.state.eventsPage(id, since, limit);
    if (!page) { return null; }
    const answer: EventsPage = { ...page, feed: this.replay.feedName(page.feed), events: structuredClone(page.events) };
    return this.replay.mapAnswer('EventsPage', answer);
  }

  private leasesOf<V>(all: Map<string, Map<string, V>>, id: string): Map<string, V> {
    let leases = all.get(id);
    if (!leases) { leases = new Map(); all.set(id, leases); }
    return leases;
  }
}

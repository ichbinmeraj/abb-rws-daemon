import {
  EVENTS_KEEP_MAX, EVENTS_PAGE_MAX,
  type CapabilityId, type ControllerEvent, type ControllerSnapshot, type DeltaFrame, type EventsGroup, type RemovedFrame,
} from '../schema/v0.js';

/**
 * What a replay knows at its position: the controllers as a stream consumer
 * holding every frame sent so far would have them, every event any frame
 * carried, and the client's I/O signal table over the recording's time.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The order of a controller's groups on the wire (ControllerSnapshot). */
const GROUP_ORDER = ['identity', 'link', 'panel', 'rapid', 'motion', 'io', 'events', 'access', 'capabilities', 'freshness'] as const;

/** The rows of a capability table, in wire order (CapabilityId). */
const CAPABILITY_IDS: readonly CapabilityId[] = [
  'status-push', 'events-push', 'event-times', 'io-push', 'io-table', 'joint-limits', 'mastership', 'write-access', 'rmmp',
];

/** The link reason of a controller that was never reached. */
const NOT_CONNECTED = 'not connected';

/**
 * The groups of a controller the recording introduced without them (a delta
 * for an unknown controller that did not carry every group, which the daemon
 * never sends): each as the daemon serves a controller it has not read yet.
 * Since schema 0.13 that includes `access` (nothing read), `capabilities`
 * (every row not determined) and `freshness` (no link, nothing read), and
 * the link's `downSince`.
 */
function unreadGroups(observedAt: string): Omit<ControllerSnapshot, 'id' | 'name'> {
  return {
    identity: null,
    link: {
      connected: false, quality: 'disconnected', qualityReason: NOT_CONNECTED, since: observedAt, downSince: observedAt,
      host: '', port: 0, useHttps: false,
      subscriptions: { active: false }, identityCheck: { status: 'unverified', expected: null, actual: null }, reconnect: null,
      // As a recording carries it; the replay marks every link it serves.
      mode: 'live', recordedAt: null,
    },
    panel: { ctrlState: null, opMode: null, speedRatio: null, collisionDetection: null, asOf: null },
    rapid: { execState: null, cycle: null, tasks: [], asOf: null },
    motion: { watching: false, units: [], rate: { targetHz: null, achievedHz: null, via: null }, asOf: null },
    io: { watching: false, signals: [], asOf: null },
    events: {
      feed: null, lastSeq: 0, recent: [], via: null, clock: { offsetMs: null, measuredAt: null, problem: null }, asOf: null, error: null,
    },
    access: {
      generation: null, model: null, locks: [], remoteAccessEnabled: null,
      rmmp: { supported: null, privilege: null, asOf: null, error: null }, via: null, problem: null, asOf: null,
    },
    capabilities: {
      protocol: null, generation: null, robotWare: null, tested: null,
      entries: CAPABILITY_IDS.map(id => ({ id, state: 'unknown', reason: NOT_CONNECTED })), asOf: null,
    },
    freshness: {
      level: 'down', reasons: [`link: ${NOT_CONNECTED}`],
      groups: [
        { group: 'identity', state: 'unread', asOf: null, reason: NOT_CONNECTED },
        { group: 'panel', state: 'unread', asOf: null, reason: NOT_CONNECTED },
        { group: 'rapid', state: 'unread', asOf: null, reason: NOT_CONNECTED },
        { group: 'motion', state: 'idle', asOf: null, reason: 'no consumer is watching' },
        { group: 'io', state: 'idle', asOf: null, reason: 'no consumer is watching' },
        { group: 'events', state: 'unread', asOf: null, reason: NOT_CONNECTED },
        { group: 'access', state: 'unread', asOf: null, reason: NOT_CONNECTED },
      ],
    },
  };
}

/**
 * The same for a recording made before schema 0.13: without the three groups
 * and the link field that version added, so a replay of it serves no group
 * the recording never held.
 */
function unreadGroupsBefore013(observedAt: string): Obj {
  const { access: _access, capabilities: _capabilities, freshness: _freshness, ...older } = unreadGroups(observedAt);
  const { downSince: _downSince, mode: _mode, recordedAt: _recordedAt, ...link } = older.link;
  return { ...older, link };
}

/**
 * Whether frames of a snapshot schema version carry what 0.13 added (the
 * three groups, and the link's `downSince`, `mode` and `recordedAt`). A
 * version that cannot be read counts as the daemon's own.
 */
export function carriesAccess(schemaVersion: unknown): boolean {
  const m = typeof schemaVersion === 'string' ? /^(\d+)\.(\d+)$/.exec(schemaVersion) : null;
  return !m || Number(m[1]) > 0 || Number(m[2]) >= 13;
}

/** One controller's events as the recording carried them, under the feed that numbers them. */
interface EventHistory {
  /** The last feed a frame named for this controller; null before the first. */
  feed: string | null;
  /** By `seq`; at most EVENTS_KEEP_MAX, the newest. */
  bySeq: Map<number, ControllerEvent>;
}

/** An events page (EventsPage) before the replay names its feed (a loop renames it). */
export interface ReplayEventsPage {
  feed: string;
  firstSeq: number;
  lastSeq: number;
  gap: boolean;
  more: boolean;
  events: ControllerEvent[];
}

/**
 * The controllers at a replay's position, from the frames applied so far,
 * applied exactly as a stream consumer applies them: a snapshot replaces
 * everything; a delta replaces each group it names whole, updates the name
 * and adds a controller it does not know; `removed` drops one. Frames of a
 * type it does not know are ignored. Every event that any frame's
 * `events.recent` carried is kept, by `seq`, for the events route.
 *
 * `apply` takes ownership of the frame object it is given: the state keeps
 * its groups, so a caller passes a frame it will not change afterwards.
 */
export class ReplayState {
  private controllers = new Map<string, ControllerSnapshot>();
  private readonly history = new Map<string, EventHistory>();
  /** The last motion target rate a frame carried per controller (a watch running), for a replayed motion watch. */
  private readonly targetHz = new Map<string, number>();
  /**
   * Whether the recording's frames carry what schema 0.13 added, as the last
   * snapshot applied names its version: a controller filled in from a partial
   * delta gets the groups of the recording's own version, no others.
   */
  private withAccess = true;

  /** Apply one frame; returns the ids of the controllers it touched (removed ones included). */
  apply(frame: unknown): string[] {
    if (!isObj(frame)) { return []; }
    switch (frame.type) {
      case 'snapshot': return this.applySnapshot(frame);
      case 'delta': return this.applyDelta(frame);
      case 'removed': return this.applyRemoved(frame);
      default: return [];
    }
  }

  /** Forget everything: before the first frame of the recording is applied again. */
  reset(): void {
    this.controllers = new Map();
    this.history.clear();
    this.targetHz.clear();
    this.withAccess = true;
  }

  has(id: string): boolean { return this.controllers.has(id); }
  ids(): string[] { return [...this.controllers.keys()]; }

  /** The controllers, as held: callers copy before they change anything. */
  list(): ControllerSnapshot[] { return [...this.controllers.values()]; }

  /** One controller, as held (see list). */
  get(id: string): ControllerSnapshot | null { return this.controllers.get(id) ?? null; }

  /** The last motion target rate a frame carried for a controller; null when none ever did. */
  lastTargetHz(id: string): number | null { return this.targetHz.get(id) ?? null; }

  /**
   * The frames that take a consumer holding this state to `snapshot`: a
   * delta for every controller whose name or any group differs (every group
   * for one it lacks), then `removed` for every controller the snapshot
   * lacks; all stamped with the snapshot's `observedAt`. A replay sends a
   * snapshot the recorder took in the middle of a recording (a part's start,
   * after a gap) this way, so that each consumer sees one snapshot, as on the
   * live stream. The frames share objects with `snapshot`: copy them before
   * changing them.
   */
  resyncFrames(snapshot: unknown): Array<DeltaFrame | RemovedFrame> {
    if (!isObj(snapshot) || !Array.isArray(snapshot.controllers)) { return []; }
    const observedAt = typeof snapshot.observedAt === 'string' ? snapshot.observedAt : '';
    const frames: Array<DeltaFrame | RemovedFrame> = [];
    const kept = new Set<string>();
    for (const c of snapshot.controllers) {
      if (!isObj(c) || typeof c.id !== 'string') { continue; }
      kept.add(c.id);
      const held = this.controllers.get(c.id) as unknown as Obj | undefined;
      const groups: Obj = {};
      for (const key of Object.keys(c)) {
        if (key === 'id' || key === 'name') { continue; }
        if (!held || JSON.stringify(held[key]) !== JSON.stringify(c[key])) { groups[key] = c[key]; }
      }
      const name = typeof c.name === 'string' ? c.name : c.id;
      if (!held || held.name !== name || Object.keys(groups).length > 0) {
        frames.push({ type: 'delta', observedAt, id: c.id, name, groups: groups as DeltaFrame['groups'] });
      }
    }
    for (const id of this.controllers.keys()) {
      if (!kept.has(id)) { frames.push({ type: 'removed', observedAt, id }); }
    }
    return frames;
  }

  /**
   * A page of a controller's events from what the recording carried (as
   * EventFeed.page: without `since` the newest `limit`, with it those after
   * it, oldest first). `gap` is true wherever the recording never carried
   * some `seq` the page spans: before its first event (after `since`), or
   * between two of its events. Null for a controller the state lacks.
   */
  eventsPage(id: string, since: number | undefined, limit: number): ReplayEventsPage | null {
    const c = this.controllers.get(id);
    if (!c) { return null; }
    const h = this.history.get(id);
    const held = h ? [...h.bySeq.values()].sort((a, b) => a.seq - b.seq) : [];
    const group = isObj(c.events) ? c.events as Partial<EventsGroup> : null;
    const lastSeq = Math.max(typeof group?.lastSeq === 'number' ? group.lastSeq : 0, held.at(-1)?.seq ?? 0);
    const n = Math.min(EVENTS_PAGE_MAX, Math.max(1, Math.floor(limit)));
    const base = { feed: h?.feed ?? (typeof group?.feed === 'string' ? group.feed : ''), firstSeq: held[0]?.seq ?? 0, lastSeq };
    const holes = (events: ControllerEvent[]) => events.some((e, i) => i > 0 && e.seq !== events[i - 1].seq + 1);
    if (since === undefined) {
      const events = held.slice(-n);
      return { ...base, gap: holes(events), more: false, events };
    }
    const after = held.filter(e => e.seq > since);
    const events = after.slice(0, n);
    const missingFirst = lastSeq > since && (events.length === 0 || events[0].seq > since + 1);
    return { ...base, gap: missingFirst || holes(events), more: after.length > n, events };
  }

  private applySnapshot(frame: Obj): string[] {
    this.withAccess = carriesAccess(frame.schemaVersion);
    const before = [...this.controllers.keys()];
    const next = new Map<string, ControllerSnapshot>();
    for (const c of Array.isArray(frame.controllers) ? frame.controllers : []) {
      if (!isObj(c) || typeof c.id !== 'string') { continue; }
      next.set(c.id, c as unknown as ControllerSnapshot);
    }
    for (const id of before) {
      if (!next.has(id)) { this.forget(id); }
    }
    this.controllers = next;
    for (const c of next.values()) { this.note(c.id, c as unknown as Obj); }
    return [...new Set([...before, ...next.keys()])];
  }

  private applyDelta(frame: Obj): string[] {
    if (typeof frame.id !== 'string' || !isObj(frame.groups)) { return []; }
    const id = frame.id;
    const groups = frame.groups;
    const held = this.controllers.get(id) as unknown as Obj | undefined;
    const name = typeof frame.name === 'string' ? frame.name : (held?.name as string | undefined) ?? id;
    if (held) {
      held.name = name;
      for (const key of Object.keys(groups)) { held[key] = groups[key]; }
    } else {
      // A controller's first delta carries every group; one that does not
      // still yields a whole controller, its missing groups unread.
      const observedAt = typeof frame.observedAt === 'string' ? frame.observedAt : '';
      const fresh: Obj = { id, name, ...(this.withAccess ? unreadGroups(observedAt) : unreadGroupsBefore013(observedAt)) };
      for (const key of Object.keys(groups)) { fresh[key] = groups[key]; }
      const ordered: Obj = { id, name };
      for (const key of GROUP_ORDER) { if (key in fresh) { ordered[key] = fresh[key]; } }
      for (const key of Object.keys(fresh)) { if (!(key in ordered)) { ordered[key] = fresh[key]; } }
      this.controllers.set(id, ordered as unknown as ControllerSnapshot);
    }
    this.note(id, groups);
    return [id];
  }

  private applyRemoved(frame: Obj): string[] {
    if (typeof frame.id !== 'string') { return []; }
    const had = this.controllers.delete(frame.id);
    this.forget(frame.id);
    return had ? [frame.id] : [];
  }

  /** A controller removed: what was recorded of it goes too (an id added again is a new feed, as live). */
  private forget(id: string): void {
    this.history.delete(id);
    this.targetHz.delete(id);
  }

  /** Keep what a frame's groups carried for later answers: the events, the motion target rate. */
  private note(id: string, groups: Obj): void {
    const motion = groups.motion;
    if (isObj(motion) && isObj(motion.rate) && typeof motion.rate.targetHz === 'number') {
      this.targetHz.set(id, motion.rate.targetHz);
    }
    const events = groups.events;
    if (!isObj(events)) { return; }
    let h = this.history.get(id);
    if (!h) { h = { feed: null, bySeq: new Map() }; this.history.set(id, h); }
    if (typeof events.feed === 'string' && events.feed !== h.feed) {
      // Another numbering: what was kept under the old feed means nothing under it.
      if (h.feed !== null) { h.bySeq.clear(); }
      h.feed = events.feed;
    }
    if (typeof events.feed !== 'string' || !Array.isArray(events.recent)) { return; }
    for (const e of events.recent) {
      // The latest carrying of an event wins: its time may have been corrected since.
      if (isObj(e) && typeof e.seq === 'number') { h.bySeq.set(e.seq, e as unknown as ControllerEvent); }
    }
    if (h.bySeq.size > EVENTS_KEEP_MAX) {
      const oldest = [...h.bySeq.keys()].sort((a, b) => a - b).slice(0, h.bySeq.size - EVENTS_KEEP_MAX);
      for (const seq of oldest) { h.bySeq.delete(seq); }
    }
  }
}

/** The client's I/O signal table for one controller at a point of the recording, as a replay can answer for it. */
export type IoTableAnswer =
  | { status: 'ready'; signals: readonly unknown[] }
  /** The client had not loaded the table on its connection then: 503 NOT_READY, as live. */
  | { status: 'not-loaded' }
  /** The recording does not hold the whole table then (not recorded, chunks missing, a part omitted, a gap). */
  | { status: 'not-recorded' };

/** What a state record carries that the table needs (StateRecord, checked by the reader). */
export interface IoStateInput {
  t: number;
  id: string;
  changed?: Record<string, unknown>;
  ioSignals?: unknown;
}

interface IoVersion {
  t: number;
  connected: boolean | undefined;
  loaded: boolean | undefined;
  /** The whole table; null when the recording does not hold all of it. */
  table: readonly unknown[] | null;
}

interface IoTrack {
  versions: IoVersion[];
  /** The chunks of a whole table being read: how many, which comes next, the rows so far, whether every row is whole. */
  pending: { chunks: number; next: number; rows: unknown[]; whole: boolean } | null;
}

/** A signal row the table can hold: an object with a name, not a placeholder for something left out. */
const wholeRow = (row: unknown): row is Obj =>
  isObj(row) && typeof row.name === 'string' && !('$omitted' in row) && !('$truncated' in row);

const isChunk = (v: unknown): v is { chunk: number; chunks: number; full: unknown[] } =>
  isObj(v) && Number.isInteger(v.chunk) && Number.isInteger(v.chunks) && Array.isArray(v.full)
  && (v.chunk as number) >= 1 && (v.chunk as number) <= (v.chunks as number);

const isDiff = (v: unknown): v is { added: unknown[]; changed: unknown[]; removed: unknown[] } =>
  isObj(v) && Array.isArray(v.added) && Array.isArray(v.changed) && Array.isArray(v.removed);

/** A table with a diff applied (removed by name, changed replaced in place, added at the end); null when the diff is not whole. */
function applyDiff(table: readonly unknown[], diff: { added: unknown[]; changed: unknown[]; removed: unknown[] }): unknown[] | null {
  if (!diff.added.every(wholeRow) || !diff.changed.every(wholeRow) || !diff.removed.every(n => typeof n === 'string')) { return null; }
  const removed = new Set(diff.removed as string[]);
  const changed = new Map((diff.changed as Obj[]).map(r => [r.name as string, r]));
  const next = table
    .filter(r => !removed.has((r as Obj).name as string))
    .map(r => changed.get((r as Obj).name as string) ?? r);
  for (const row of diff.added as Obj[]) {
    const at = next.findIndex(r => (r as Obj).name === row.name);
    if (at >= 0) { next[at] = row; } else { next.push(row); }
  }
  return next;
}

/**
 * The client's I/O signal table per controller over the recording's time,
 * from its `state` records in order: a whole table from chunks 1 to n (each
 * part, and after every gap, begins with one), changed by the diffs between,
 * and whether the client had loaded it on its connection (`connected`,
 * `ioSignalsLoaded`). Whatever is uncertain answers `not-recorded`, never an
 * older table: a chunk missing or out of order, a row left out, a diff on a
 * table not held, a gap that dropped state records.
 */
export class IoTableTimeline {
  private readonly tracks = new Map<string, IoTrack>();

  /** One state record, in recording order. */
  apply(rec: IoStateInput): void {
    const track = this.track(rec.id);
    const last = track.versions.at(-1);
    let connected = last?.connected;
    let loaded = last?.loaded;
    let table = last ? last.table : null;
    if (rec.changed) {
      if (typeof rec.changed.connected === 'boolean') { connected = rec.changed.connected; }
      if (typeof rec.changed.ioSignalsLoaded === 'boolean') { loaded = rec.changed.ioSignalsLoaded; }
    }
    const io = rec.ioSignals;
    if (io !== undefined) {
      if (isChunk(io)) {
        if (io.chunk === 1) { track.pending = { chunks: io.chunks, next: 1, rows: [], whole: true }; }
        const p = track.pending;
        if (!p || io.chunk !== p.next || io.chunks !== p.chunks) {
          track.pending = null;
          table = null;
        } else {
          for (const row of io.full) { p.rows.push(row); if (!wholeRow(row)) { p.whole = false; } }
          p.next++;
          if (io.chunk === io.chunks) {
            table = p.whole ? p.rows : null;
            track.pending = null;
          }
        }
      } else if (isDiff(io)) {
        table = table === null ? null : applyDiff(table, io);
      } else {
        table = null;   // left out, or a shape this daemon does not know
      }
    }
    if (!last || last.connected !== connected || last.loaded !== loaded || last.table !== table) {
      track.versions.push({ t: rec.t, connected, loaded, table });
    }
  }

  /** State records were left out at `t` (a gap, a missing part): no table is known until the next whole one. */
  gap(t: number): void {
    for (const track of this.tracks.values()) {
      track.pending = null;
      const last = track.versions.at(-1);
      if (last && last.table !== null) { track.versions.push({ ...last, t, table: null }); }
    }
  }

  /** The table of a controller as of `t` (the last record at or before it). */
  at(id: string, t: number): IoTableAnswer {
    const versions = this.tracks.get(id)?.versions;
    if (!versions) { return { status: 'not-recorded' }; }
    let lo = 0;
    let hi = versions.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (versions[mid].t <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (found < 0) { return { status: 'not-recorded' }; }
    const v = versions[found];
    // As ioTableLoaded: the client's flag when it gives one; else a connected link with a non-empty table.
    const loaded = typeof v.loaded === 'boolean' ? v.loaded
      : v.connected === false ? false
        : v.table === null ? null : v.table.length > 0;
    if (loaded === false) { return { status: 'not-loaded' }; }
    if (loaded === null || v.table === null) { return { status: 'not-recorded' }; }
    return { status: 'ready', signals: v.table };
  }

  private track(id: string): IoTrack {
    let track = this.tracks.get(id);
    if (!track) { track = { versions: [], pending: null }; this.tracks.set(id, track); }
    return track;
  }
}

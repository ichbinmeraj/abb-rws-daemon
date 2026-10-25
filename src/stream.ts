import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { FrameObservation, FrameObserver, StreamEndpoint } from './recording/contract.js';
import type { SocketHub, SocketLike } from './wsHub.js';
import { SCHEMA_VERSION, type ControllerSnapshot, type GroupName, type StreamFrame } from './schema/v0.js';
import { selectStreamProtocol } from './token.js';

/** What the stream reads from - the fleet in production, a fake in tests. */
export interface StreamSource {
  list(): ControllerSnapshot[];
  get(id: string): ControllerSnapshot | null;
  onChanged(cb: (id: string) => void): void;
}

// `motion`, `io` and `events` are coalesced like the value groups (at most one
// frame per window, 4 frames/s per controller at the default 250 ms) however
// fast they are sampled or messages arrive. So are `access`, `capabilities`
// and `freshness` (schema 0.13); one that changed with the link rides the
// link's own frame.
const GROUPS: GroupName[] = ['identity', 'link', 'panel', 'rapid', 'motion', 'io', 'events', 'access', 'capabilities', 'freshness'];

/** The largest message a stream consumer may send before it is cut off (it may send none). */
export const STREAM_MAX_PAYLOAD = 4096;

/**
 * A group's content, with each freshness stamp reduced to whether it is set.
 * `panel.asOf` advances every time a healthy link is read, and each watched io
 * signal carries its own `asOf` that advances on every confirming poll; a stamp
 * moving on is not news, and sending it would turn the stream into a clock. A
 * stamp appearing or clearing is: it separates "not read yet" from a value. A
 * consumer that attached while a group was still unread (a daemon restarted
 * under an open panel) would otherwise wait for its first read for as long as
 * the controller stays quiet.
 */
function content(group: unknown): string {
  return JSON.stringify(group, (key, value) => (key === 'asOf' ? value !== null && value !== undefined : value));
}

/**
 * Turns fleet changes into `WS /v0/stream` frames.
 *
 * - A new consumer gets a full `snapshot`, then `delta` frames carrying only the
 *   groups that changed, each replaced whole.
 * - Link changes go out immediately, every one: a reconnect that lasts less
 *   than a polling interval is exactly what an engineer needs to see.
 * - Other groups are throttled to one frame per `debounceMs` per controller: a
 *   busy controller notifies on every poll and event, and for values only the
 *   latest matters. A change after a quiet spell goes out at once (live: the
 *   old trailing-only window was ~250 of the ~290 ms from write to frame).
 */
export class SnapshotStream implements StreamEndpoint, FrameObserver {
  /** What was last broadcast, per controller and group, as comparable content. */
  private readonly sent = new Map<string, Map<GroupName, string>>();
  /** A booked trailing send per controller; it flushes whatever is latest when it fires. */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** When a delta last went out per controller (this.now() ms), link or value. */
  private readonly lastFlushAt = new Map<string, number>();
  /** In-process observers (observe()): not consumers, never closed by the hub. */
  private readonly observers = new Set<(frame: string) => void>();
  private readonly debounceMs: number;

  constructor(
    private readonly source: StreamSource,
    private readonly hub: SocketHub,
    opts: { debounceMs?: number; now?: () => number } = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 250;
    this.now = opts.now ?? Date.now;
    source.onChanged(id => this.onChanged(id));
  }

  private readonly now: () => number;

  /** Add a consumer and send it a snapshot; false when the hub refused it (full, or stopping) and closed it. */
  attach(socket: SocketLike): boolean {
    // Deliberately NOT recorded as sent: this snapshot reaches one consumer, and
    // marking its content as broadcast would swallow a change the others are
    // still waiting for. At worst the newcomer later receives a group it has.
    return this.hub.attach(socket, this.snapshotFrame());
  }

  detach(socket: SocketLike): void { this.hub.detach(socket); }

  /**
   * A snapshot frame string, as a consumer attaching now would get it, made
   * without touching the hub or what was last broadcast.
   */
  snapshotFrame(): string {
    const frame: StreamFrame = {
      type: 'snapshot', schemaVersion: SCHEMA_VERSION, observedAt: this.stamp(), controllers: this.source.list(),
    };
    return JSON.stringify(frame);
  }

  /**
   * Observe the stream from inside the daemon (the recorder): `fn` gets every
   * broadcast frame string, the very string the hub sends, from now on;
   * `first` is the snapshot a consumer attaching now would get. An observer
   * is not a consumer: it takes no consumer slot, the hub never closes it
   * (not when full, not on close()), and it never slows a broadcast down - a
   * throwing observer is ignored. Nothing can come between `first` and the
   * frames that follow it.
   */
  observe(fn: (frame: string) => void): FrameObservation {
    const first = this.snapshotFrame();
    // One entry per observation, so the same function observing twice is stopped once per stop().
    const entry = (frame: string): void => { fn(frame); };
    this.observers.add(entry);
    return { first, stop: () => { this.observers.delete(entry); } };
  }

  /** Close every consumer as going away. Observers keep observing: frames made while the daemon stops still reach them. */
  close(): void {
    for (const t of this.pending.values()) { clearTimeout(t); }
    this.pending.clear();
    this.hub.close();
  }

  private onChanged(id: string): void {
    const snap = this.source.get(id);
    if (!snap) {
      // Always announced: a consumer may know this controller from its snapshot
      // alone, without any delta ever having been broadcast for it.
      this.cancel(id);
      this.sent.delete(id);
      this.lastFlushAt.delete(id);
      this.broadcast({ type: 'removed', observedAt: this.stamp(), id });
      return;
    }
    if (this.changed(snap).includes('link')) {
      // Immediately, with everything else that changed alongside it.
      this.cancel(id);
      this.flush(snap);
      return;
    }
    // A trailing send is already booked: it flushes whatever is latest when it
    // fires, so this change rides along (nothing is lost, one frame per window).
    if (this.pending.has(id)) { return; }
    const since = this.now() - (this.lastFlushAt.get(id) ?? Number.NEGATIVE_INFINITY);
    // Quiet for a whole window: send at once (measured live 2026-09-24: with a
    // trailing-only window, ~250 of the ~290 ms from write to frame was the wait).
    if (since >= this.debounceMs) { this.flush(snap); return; }
    // Inside the window: book one send for when it closes.
    this.schedule(id, this.debounceMs - since);
  }

  /** Book the trailing send for `id` in `delayMs`; it sends whatever is latest then. */
  private schedule(id: string, delayMs: number): void {
    this.pending.set(id, setTimeout(() => {
      this.pending.delete(id);
      const latest = this.source.get(id);
      if (latest) { this.flush(latest); }
    }, Math.max(0, delayMs)));
  }

  private flush(snap: ControllerSnapshot): void {
    const groups = this.changed(snap);
    if (groups.length === 0) { return; }
    const frame: StreamFrame = {
      type: 'delta', observedAt: this.stamp(), id: snap.id, name: snap.name,
      groups: Object.fromEntries(groups.map(g => [g, snap[g]])),
    };
    this.remember(snap, groups);
    this.lastFlushAt.set(snap.id, this.now());
    this.broadcast(frame);
  }

  /** Groups whose content differs from what was last broadcast (all of them for a new controller). */
  private changed(snap: ControllerSnapshot): GroupName[] {
    const last = this.sent.get(snap.id);
    return GROUPS.filter(g => !last || last.get(g) !== content(snap[g]));
  }

  private remember(snap: ControllerSnapshot, groups: GroupName[]): void {
    const last = this.sent.get(snap.id) ?? new Map<GroupName, string>();
    for (const g of groups) { last.set(g, content(snap[g])); }
    this.sent.set(snap.id, last);
  }

  private cancel(id: string): void {
    const t = this.pending.get(id);
    if (t) { clearTimeout(t); this.pending.delete(id); }
  }

  private broadcast(frame: StreamFrame): void {
    const text = JSON.stringify(frame);
    this.hub.broadcast(text);
    for (const fn of [...this.observers]) {
      try { fn(text); } catch { /* an observer never changes what consumers get */ }
    }
  }
  private stamp(): string { return new Date(this.now()).toISOString(); }
}

/**
 * `GET /v0/stream` as a WebSocket. The loopback guard's Host and Origin checks
 * and the access token run on the upgrade request like on any other, so a
 * page from any origin but the daemon's own and the panel's - another
 * loopback port included - cannot open the stream, and neither can a
 * consumer without the token. The token comes in its header, or as a
 * subprotocol offered next to STREAM_PROTOCOL; the handshake selects
 * STREAM_PROTOCOL when offered, never the token's (selectStreamProtocol).
 *
 * The stream only sends. The hub closes a consumer on its first message, and
 * nothing larger than STREAM_MAX_PAYLOAD is even read (the WebSocket library
 * would otherwise buffer up to 100 MiB of a message nobody wants).
 *
 * `stream` is the live stream (SnapshotStream) or, in replay mode, the
 * replay's: the route, its checks and its limits are the same either way.
 */
export async function registerStreamRoute(app: FastifyInstance, stream: StreamEndpoint): Promise<void> {
  await app.register(websocket, { options: { maxPayload: STREAM_MAX_PAYLOAD, handleProtocols: selectStreamProtocol } });
  app.get('/v0/stream', { websocket: true }, socket => {
    // A refused consumer is closed already (full, or stopping); its close detaches nothing.
    stream.attach(socket);
    socket.on('close', () => stream.detach(socket));
  });
}

import type { ReplayHub } from './recording/contract.js';

/** Minimal WebSocket surface (ws.WebSocket and @fastify/websocket both satisfy it). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  /** Bytes sent but not yet written to the network (ws.WebSocket reports it). */
  bufferedAmount?: number;
  ping?: () => void;
  terminate?: () => void;
  close?: (code?: number, reason?: string) => void;
  on?: (event: string, cb: () => void) => void;
}

const OPEN = 1;

/** How many consumers may hold the stream at once. */
export const MAX_STREAM_CONSUMERS = 32;
/** A consumer with more than this many bytes still unsent has stopped reading and is dropped. */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Close code (RFC 6455) for a consumer that sent something: the stream accepts no messages. */
export const CLOSE_POLICY = 1008;
/** Close code (RFC 6455) when every consumer slot is taken: try again later. */
export const CLOSE_TRY_LATER = 1013;
/** Close code (RFC 6455) when the daemon stops: going away. */
export const CLOSE_GOING_AWAY = 1001;
const STOPPING_REASON = 'the daemon is stopping';

/**
 * The connected consumers: who is attached, a heartbeat that drops half-open
 * sockets, and broadcast. It knows nothing about what it sends - that is the
 * stream's job.
 *
 * The stream only sends, so it is bounded on every side: a consumer that sends
 * anything is closed, a consumer that stops reading is dropped before its
 * backlog outgrows MAX_BUFFERED_BYTES (a stalled tab would otherwise have the
 * daemon buffer every frame for it until the heartbeat notices), and at most
 * `maxClients` consumers are attached at once.
 *
 * The heartbeat is extracted from the abb-rws-panel gateway's WsHub.
 */
export class SocketHub implements ReplayHub {
  private readonly clients = new Set<SocketLike>();
  /** Sockets that have not answered a ping since the last heartbeat sweep. */
  private readonly awaitingPong = new WeakSet<SocketLike>();
  private readonly heartbeat: ReturnType<typeof setInterval> | null;
  private readonly maxClients: number;
  private readonly maxBufferedBytes: number;
  /** Set by close(): the daemon is stopping, and a consumer that arrives now is closed at once. */
  private closed = false;

  constructor(opts: { heartbeatMs?: number; maxClients?: number; maxBufferedBytes?: number } = {}) {
    const heartbeatMs = opts.heartbeatMs ?? 30000;
    this.maxClients = opts.maxClients ?? MAX_STREAM_CONSUMERS;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    this.heartbeat = heartbeatMs > 0 ? setInterval(() => this.sweep(), heartbeatMs) : null;
    // Do not keep the process alive just to run the heartbeat.
    (this.heartbeat as { unref?: () => void } | null)?.unref?.();
  }

  get size(): number { return this.clients.size; }

  /**
   * Add a consumer and send it its first frame - or, when `maxClients` are
   * already attached, close it with a reason it can show and retry on.
   */
  attach(socket: SocketLike, firstFrame: string): boolean {
    // A failed socket leaves the hub; its error never goes unhandled, whatever
    // else is listening.
    socket.on?.('error', () => this.detach(socket));
    if (this.closed) {
      socket.close?.(CLOSE_GOING_AWAY, STOPPING_REASON);
      return false;
    }
    if (this.clients.size >= this.maxClients) {
      socket.close?.(CLOSE_TRY_LATER, `too many stream consumers (at most ${this.maxClients}); retry later`);
      return false;
    }
    this.clients.add(socket);
    // A socket that answers pings clears its pending flag.
    socket.on?.('pong', () => this.awaitingPong.delete(socket));
    socket.on?.('message', () => {
      this.detach(socket);
      socket.close?.(CLOSE_POLICY, 'the stream accepts no messages');
    });
    this.safeSend(socket, firstFrame);
    return true;
  }

  detach(socket: SocketLike): void {
    this.clients.delete(socket);
    this.awaitingPong.delete(socket);
  }

  broadcast(frame: string): void {
    for (const client of this.clients) { this.safeSend(client, frame); }
  }

  /**
   * The daemon is stopping (or a test is done): stop the heartbeat and close
   * every consumer with CLOSE_GOING_AWAY, so each one can tell a stop from a
   * lost connection. A consumer that arrives afterwards is closed the same
   * way.
   */
  close(): void {
    this.closed = true;
    if (this.heartbeat) { clearInterval(this.heartbeat); }
    for (const socket of [...this.clients]) {
      this.detach(socket);
      try { socket.close?.(CLOSE_GOING_AWAY, STOPPING_REASON); } catch { /* already gone */ }
    }
  }

  /**
   * Close every consumer with `code` and `reason`, and keep accepting new
   * ones (unlike close(), which ends the hub). A replay that starts over
   * closes its consumers with 1012 this way: each reconnects and gets a fresh
   * snapshot.
   */
  closeAll(code: number, reason: string): void {
    for (const socket of [...this.clients]) {
      this.detach(socket);
      try { socket.close?.(code, reason); } catch { /* already gone */ }
    }
  }

  /**
   * Ping every client; a client that missed the previous ping is half-open
   * (a consumer killed without a close frame) and gets terminated so it
   * stops accumulating in the client set.
   */
  private sweep(): void {
    for (const socket of this.clients) {
      if (this.awaitingPong.has(socket)) {
        this.detach(socket);
        socket.terminate?.();
        continue;
      }
      if (socket.ping) {
        this.awaitingPong.add(socket);
        try { socket.ping(); } catch { this.detach(socket); }
      }
    }
  }

  private safeSend(socket: SocketLike, data: string): void {
    try {
      if (socket.readyState !== OPEN) { return; }
      if ((socket.bufferedAmount ?? 0) > this.maxBufferedBytes) {
        // Not reading: a close frame would only queue behind the backlog.
        this.detach(socket);
        socket.terminate?.();
        return;
      }
      socket.send(data);
    } catch { /* dead socket - detach happens on its close event */ }
  }
}

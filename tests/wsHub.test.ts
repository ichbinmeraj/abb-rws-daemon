import { describe, it, expect, vi, afterEach } from 'vitest';
import { CLOSE_POLICY, CLOSE_TRY_LATER, MAX_BUFFERED_BYTES, MAX_STREAM_CONSUMERS, SocketHub } from '../src/wsHub.js';

export class FakeSocket {
  sent: string[] = [];
  readyState = 1;
  bufferedAmount = 0;
  pings = 0;
  terminated = false;
  closed: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Array<() => void>>();
  send(data: string): void { this.sent.push(data); }
  ping(): void { this.pings++; }
  terminate(): void { this.terminated = true; }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  on(event: string, cb: () => void): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]); }
  emit(event: string): void { (this.listeners.get(event) ?? []).forEach(cb => cb()); }
  emitPong(): void { this.emit('pong'); }
  frames(): Array<Record<string, unknown>> { return this.sent.map(s => JSON.parse(s)); }
}

afterEach(() => { vi.useRealTimers(); });

describe('SocketHub', () => {
  it('sends the first frame on attach and broadcasts to every client', () => {
    const hub = new SocketHub({ heartbeatMs: 0 });
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.attach(a, '"hello-a"');
    hub.attach(b, '"hello-b"');
    hub.broadcast('"all"');
    expect(a.sent).toEqual(['"hello-a"', '"all"']);
    expect(b.sent).toEqual(['"hello-b"', '"all"']);
  });

  it('stops sending to detached clients and to closed sockets', () => {
    const hub = new SocketHub({ heartbeatMs: 0 });
    const gone = new FakeSocket();
    const closed = new FakeSocket();
    hub.attach(gone, '"x"');
    hub.attach(closed, '"x"');
    hub.detach(gone);
    closed.readyState = 3;
    hub.broadcast('"later"');
    expect(gone.sent).toEqual(['"x"']);
    expect(closed.sent).toEqual(['"x"']);
  });

  it('drops a client whose socket fails, and handles the error', () => {
    const hub = new SocketHub({ heartbeatMs: 0 });
    const failed = new FakeSocket();
    const fine = new FakeSocket();
    hub.attach(failed, '"x"');
    hub.attach(fine, '"x"');
    expect(() => failed.emit('error')).not.toThrow();
    hub.broadcast('"later"');
    expect(hub.size).toBe(1);
    expect(failed.sent).toEqual(['"x"']);
    expect(fine.sent).toEqual(['"x"', '"later"']);
  });

  it('closes a client that sends anything, and sends it nothing more', () => {
    const hub = new SocketHub({ heartbeatMs: 0 });
    const chatty = new FakeSocket();
    const quiet = new FakeSocket();
    hub.attach(chatty, '"x"');
    hub.attach(quiet, '"x"');
    chatty.emit('message');
    hub.broadcast('"later"');
    expect(chatty.closed).toEqual({ code: CLOSE_POLICY, reason: 'the stream accepts no messages' });
    expect(chatty.sent).toEqual(['"x"']);
    expect(quiet.sent).toEqual(['"x"', '"later"']);
    expect(hub.size).toBe(1);
  });

  it('drops a client whose unsent backlog passes the limit, keeps the others', () => {
    const hub = new SocketHub({ heartbeatMs: 0 });
    const stalled = new FakeSocket();
    const reading = new FakeSocket();
    hub.attach(stalled, '"x"');
    hub.attach(reading, '"x"');
    stalled.bufferedAmount = MAX_BUFFERED_BYTES;          // at the limit: still sent to
    hub.broadcast('"a"');
    stalled.bufferedAmount = MAX_BUFFERED_BYTES + 1;      // past it: dropped
    hub.broadcast('"b"');
    hub.broadcast('"c"');
    expect(stalled.sent).toEqual(['"x"', '"a"']);
    expect(stalled.terminated).toBe(true);
    expect(reading.sent).toEqual(['"x"', '"a"', '"b"', '"c"']);
    expect(hub.size).toBe(1);
    expect(MAX_BUFFERED_BYTES).toBe(4 * 1024 * 1024);
  });

  it('refuses a client over the cap with a reason to retry on, and has room again once one leaves', () => {
    expect(MAX_STREAM_CONSUMERS).toBe(32);
    const hub = new SocketHub({ heartbeatMs: 0, maxClients: 2 });
    const [a, b, c, d] = [new FakeSocket(), new FakeSocket(), new FakeSocket(), new FakeSocket()];
    expect(hub.attach(a, '"x"')).toBe(true);
    expect(hub.attach(b, '"x"')).toBe(true);
    expect(hub.attach(c, '"x"')).toBe(false);
    expect(c.closed).toEqual({ code: CLOSE_TRY_LATER, reason: 'too many stream consumers (at most 2); retry later' });
    hub.broadcast('"later"');
    expect(c.sent).toEqual([]);
    hub.detach(a);
    expect(hub.attach(d, '"x"')).toBe(true);
    expect(hub.size).toBe(2);
  });

  it('terminates a client that misses a heartbeat, keeps a responsive one', async () => {
    vi.useFakeTimers();
    const hub = new SocketHub({ heartbeatMs: 100 });
    const healthy = new FakeSocket();
    const dead = new FakeSocket();
    hub.attach(healthy, '"x"');
    hub.attach(dead, '"x"');

    await vi.advanceTimersByTimeAsync(100);   // first sweep pings both
    expect(healthy.pings).toBe(1);
    expect(dead.pings).toBe(1);

    healthy.emitPong();
    await vi.advanceTimersByTimeAsync(100);
    expect(dead.terminated).toBe(true);
    expect(healthy.terminated).toBe(false);
    expect(hub.size).toBe(1);
    hub.close();
  });
});

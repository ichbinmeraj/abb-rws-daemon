import { describe, it, expect } from 'vitest';
import { CLOSE_GOING_AWAY, SocketHub } from '../src/wsHub.js';

/** A consumer's socket: what it was sent, and how it was closed. */
class FakeSocket {
  sent: string[] = [];
  readyState = 1;
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  on(): void {}
}

const RESTART = 1012;
const REASON = 'the recording starts over';

describe('SocketHub.closeAll', () => {
  it('closes every consumer with the code and reason given, and none of them gets another frame', () => {
    const hub = new SocketHub({ heartbeatMs: 0 });
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
    for (const s of sockets) { hub.attach(s, '"first"'); }
    hub.closeAll(RESTART, REASON);
    for (const s of sockets) { expect(s.closed).toEqual({ code: RESTART, reason: REASON }); }
    expect(hub.size).toBe(0);
    hub.broadcast('"after"');
    for (const s of sockets) { expect(s.sent).toEqual(['"first"']); }
  });

  it('keeps accepting: a consumer that reconnects gets its first frame and every broadcast after', () => {
    const hub = new SocketHub({ heartbeatMs: 0 });
    const old = new FakeSocket();
    hub.attach(old, '"first"');
    hub.closeAll(RESTART, REASON);
    const again = new FakeSocket();
    expect(hub.attach(again, '"fresh snapshot"')).toBe(true);
    hub.broadcast('"delta"');
    expect(again.sent).toEqual(['"fresh snapshot"', '"delta"']);
    expect(again.closed).toBeNull();
    expect(hub.size).toBe(1);
  });

  it('frees every slot: a full hub takes as many consumers again', () => {
    const hub = new SocketHub({ heartbeatMs: 0, maxClients: 2 });
    hub.attach(new FakeSocket(), '"a"');
    hub.attach(new FakeSocket(), '"b"');
    const third = new FakeSocket();
    expect(hub.attach(third, '"c"')).toBe(false);
    hub.closeAll(RESTART, REASON);
    expect(hub.attach(new FakeSocket(), '"a"')).toBe(true);
    expect(hub.attach(new FakeSocket(), '"b"')).toBe(true);
    expect(hub.size).toBe(2);
  });

  it('a socket whose close throws does not keep the others open', () => {
    const hub = new SocketHub({ heartbeatMs: 0 });
    const broken = new FakeSocket();
    broken.close = () => { throw new Error('already gone'); };
    const fine = new FakeSocket();
    hub.attach(broken, '"x"');
    hub.attach(fine, '"x"');
    expect(() => hub.closeAll(RESTART, REASON)).not.toThrow();
    expect(fine.closed).toEqual({ code: RESTART, reason: REASON });
    expect(hub.size).toBe(0);
  });

  it('is not close(): after the daemon stops, a consumer is still turned away as going away', () => {
    const hub = new SocketHub({ heartbeatMs: 0 });
    hub.closeAll(RESTART, REASON);   // nothing attached: nothing happens
    hub.close();
    const late = new FakeSocket();
    expect(hub.attach(late, '"x"')).toBe(false);
    expect(late.closed?.code).toBe(CLOSE_GOING_AWAY);
    hub.closeAll(RESTART, REASON);
    expect(late.closed?.code).toBe(CLOSE_GOING_AWAY);
  });
});

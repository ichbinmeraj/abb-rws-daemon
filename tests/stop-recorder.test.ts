import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControllerConfig } from '../src/config.js';
import { ControllerFleet, type ControllerLogout } from '../src/fleet.js';
import { Recorder } from '../src/recording/recorder.js';
import { DaemonStop, STOP_RECORDING_MS, STOP_RESERVE_MS, type StopParts } from '../src/stop.js';
import { SnapshotStream } from '../src/stream.js';
import { CLOSE_GOING_AWAY, SocketHub } from '../src/wsHub.js';
import { ManualTimers, MemoryFiles, MemoryLog, parseJsonl } from './helpers/recording-fakes.js';

const SECRET = 'stop-test-password-2026';
const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';

/** A consumer's socket: what it was sent and how it was closed. */
class FakeSocket {
  sent: string[] = [];
  readyState = 1;
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  on(): void {}
}

const cfgs: ControllerConfig[] = [
  { id: 'rw7', name: 'RW7', host: '127.0.0.1', port: 9403, useHttps: true, username: 'Default User', password: SECRET },
  { id: 'rw6', name: 'RW6', host: '127.0.0.1', port: 39127, useHttps: false, username: 'Default User', password: SECRET },
];

let fleets: ControllerFleet[] = [];
afterEach(() => {
  for (const f of fleets) { f.stopSupervisor(); f.stopPointerPoller(); f.stopMotionSampler(); f.stopIoPoller(); f.stopEventReader(); }
  fleets = [];
});

/**
 * The daemon's stop with its real parts - the fleet (whose logouts are
 * faked, so nothing leaves the test), the stream with a consumer, the
 * recorder writing to memory - recording when the stop begins.
 */
async function recordingDaemon() {
  const log = new MemoryLog();
  const order: string[] = [];
  const fleet = new ControllerFleet(cfgs, log);
  fleets.push(fleet);
  const multi = (fleet as unknown as { multi: { disconnectRobot: (id: string) => Promise<void> } }).multi;
  multi.disconnectRobot = async id => { order.push(`logout ${id}`); };
  const stream = new SnapshotStream(fleet, new SocketHub({ heartbeatMs: 0 }));
  const consumer = new FakeSocket();
  stream.attach(consumer);
  const files = new MemoryFiles();
  const recorder = new Recorder({
    observer: stream, tap: fleet, controllers: () => fleet.all(), token: TOKEN, dir: '/recordings', folder: 'custom',
    log, daemonVersion: '0.0.0-test', clientVersion: '0.0.0-test', files, timers: new ManualTimers(),
  });
  await recorder.start({ label: 'stop' });
  /** Every part's text when the process was told to exit. */
  let atExit: string[] | null = null;
  const exits: number[] = [];
  const stopper = new DaemonStop({
    log, stream, fleet, recorder,
    server: { close: async () => { order.push(`server (recording ${recorder.active ? 'running' : 'ended'})`); } },
    writes: async () => { order.push('writes'); },
    exit: code => { atExit = files.texts(); exits.push(code); order.push(`exit ${code}`); },
  });
  return { stopper, recorder, files, consumer, order, exits, log, atExit: () => atExit };
}

describe('the stop ends a recording that runs', () => {
  it('after the logouts, which are in it, and before the server closes; its end record is written before the exit', async () => {
    const d = await recordingDaemon();
    expect(d.recorder.active).toBe(true);
    await d.stopper.stop('SIGINT');

    expect(d.consumer.closed?.code).toBe(CLOSE_GOING_AWAY);
    expect(d.order).toEqual(['logout rw7', 'logout rw6', 'server (recording ended)', 'writes', 'exit 0']);
    expect(d.exits).toEqual([0]);

    const written = d.atExit();
    expect(written).not.toBeNull();
    const lines = written!.flatMap(parseJsonl);
    const last = lines.at(-1)!;
    expect(last).toMatchObject({ kind: 'end', reason: 'daemon-stop', next: null });
    const logouts = lines.filter(r => r.kind === 'call' && r.method === 'disconnectRobot');
    expect(logouts.map(r => [r.target, r.id, r.args, r.ok])).toEqual([
      ['multi', 'rw7', ['rw7'], true],
      ['multi', 'rw6', ['rw6'], true],
    ]);
    // The consumer was closed first; the recorder, an observer, kept every frame.
    expect(lines.filter(r => r.kind === 'frame').length).toBeGreaterThanOrEqual(1);
    expect(written!.join('')).not.toContain(SECRET);
    expect(written!.join('')).not.toContain(TOKEN);
    expect(d.recorder.status()).toMatchObject({ active: false, endReason: 'daemon-stop' });
  });

  it('no recording starts once the stop has begun', async () => {
    const d = await recordingDaemon();
    await d.stopper.stop('SIGTERM');
    await expect(d.recorder.start({})).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
  });
});

describe('DaemonStop with a recorder (fakes)', () => {
  function parts(recorder: StopParts['recorder']) {
    const order: string[] = [];
    const exits: number[] = [];
    const log = new MemoryLog();
    const p: StopParts = {
      log,
      stream: { close: () => { order.push('stream'); } },
      fleet: { disconnectAll: async (): Promise<ControllerLogout[]> => { order.push('logout'); return []; } },
      recorder,
      server: { close: async () => { order.push('server'); } },
      writes: async () => { order.push('writes'); },
      exit: code => { exits.push(code); order.push(`exit ${code}`); },
    };
    return { p, order, exits, log };
  }

  it('the recording gets at most STOP_RECORDING_MS of the reserve, the rest stays for the server and the config', async () => {
    const waits: number[] = [];
    const reasons: string[] = [];
    const { p, order } = parts({ stop: async (reason, opts) => { reasons.push(reason); waits.push(opts.waitMs); order.push('recording'); } });
    await new DaemonStop(p).stop('SIGINT');
    expect(order).toEqual(['stream', 'logout', 'recording', 'server', 'writes', 'exit 0']);
    expect(reasons).toEqual(['daemon-stop']);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[0]).toBeLessThanOrEqual(STOP_RECORDING_MS);
    expect(STOP_RECORDING_MS).toBeLessThan(STOP_RESERVE_MS);
  });

  it('after logouts that took their whole wait, the recording gets what is left, never more', async () => {
    vi.useFakeTimers();
    try {
      const waits: number[] = [];
      const { p } = parts({ stop: async (_r, opts) => { waits.push(opts.waitMs); } });
      p.fleet = { disconnectAll: async ({ waitMs }) => { await new Promise(r => setTimeout(r, waitMs + 300)); return []; } };
      const done = new DaemonStop(p, { waitMs: 8_000 }).stop('SIGINT');
      await vi.advanceTimersByTimeAsync(8_000);
      await done;
      // 8 000 - 6 500 - 300 = 1 200 ms left; 500 of them stay for the server and the config.
      expect(waits).toEqual([700]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a recorder that fails is logged and the stop goes on to exit 0', async () => {
    const { p, order, exits, log } = parts({ stop: async () => { throw new Error('disk gone'); } });
    await new DaemonStop(p).stop('SIGINT');
    expect(order).toEqual(['stream', 'logout', 'server', 'writes', 'exit 0']);
    expect(exits).toEqual([0]);
    expect(log.text()).toMatch(/ending the recording failed/);
  });
});

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { RwsClient2, type RobotState } from 'abb-rws-client';
import { ControllerFleet } from '../src/fleet.js';
import { createServer, logFatalErrors } from '../src/server.js';
import { SnapshotStream, registerStreamRoute } from '../src/stream.js';
import { SocketHub } from '../src/wsHub.js';
import type { ControllerConfig } from '../src/config.js';

/**
 * A connection reset must end one request, never the daemon. Every test here
 * uses real sockets and fails on an uncaught exception, which is what an
 * unhandled socket 'error' becomes.
 */

const SYSID = '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}';
const ID = 'irb1600-6-120-1';
const cfg: ControllerConfig = {
  id: ID, name: 'IRB1600_6_120_1', host: '127.0.0.1', port: 9403, useHttps: true,
  username: 'Default User', password: 'x', systemId: SYSID,
};

const uncaught: unknown[] = [];
const onUncaught = (e: unknown): void => { uncaught.push(e); };
beforeAll(() => { process.on('uncaughtException', onUncaught); });
afterAll(() => { process.off('uncaughtException', onUncaught); });
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) { await f(); }
});

/**
 * Waits for `pred` on the wall clock. The budget is generous: the first case
 * drives a real socket through the client (a 2 s client timeout, a reset read
 * mid-body, then a retry), and on a loaded machine or a shared CI runner the
 * read can take several seconds. Each case has its own test timeout below.
 */
const WAIT_MS = 15_000;
async function until(pred: () => boolean, ms = WAIT_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) { throw new Error('timed out waiting'); }
    await new Promise(r => setTimeout(r, 10));
  }
}

/** A six-axis robot's motion configuration, as the axis-configuration walk reads it. */
const MOC: Record<string, Record<string, string>> = {
  'MECHANICAL_UNIT/ROB_1': { name: 'ROB_1', use_robot: 'ROB_1' },
  'ROBOT/ROB_1': Object.fromEntries([0, 1, 2, 3, 4, 5].map(i => [`use_joint_${i}`, `rob1_${i + 1}`])),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].flatMap(n => [
    [`JOINT/rob1_${n}`, { logical_axis: String(n), use_arm: `rob1_${n}`, use_transmission: `rob1_${n}` }],
    [`TRANSMISSION/rob1_${n}`, { rotating_move: 'TRUE' }],
    [`ARM/rob1_${n}`, { lower_joint_bound: '-1.099558', upper_joint_bound: '2.3736479' }],
  ])),
};

const xhtml = (attrs: Record<string, string>): string =>
  '<html><body><div class="state"><ul><li class="cfg-dt-instance-li" title="x"><ul>'
  + Object.entries(attrs).map(([k, v]) => `<li class="cfg-ia-t" title="${k}"><span class="value">${v}</span></li>`).join('')
  + '</ul></li></ul></div></body></html>';

describe('a connection reset', () => {
  it('in the middle of an axis-configuration read fails that read, and the sampler carries on', async () => {
    // A controller that answers the motion configuration over RWS 2.0, and
    // while `resetting` cuts every answer off halfway through its body with a
    // TCP reset - the client reads ECONNRESET mid-body.
    let resetting = true;
    let resets = 0;
    const controller = http.createServer((req, res) => {
      const m = /^\/rw\/cfg\/MOC\/([^/]+)\/instances\/([^/?]+)/.exec(req.url ?? '');
      const body = xhtml(m ? MOC[`${m[1]}/${decodeURIComponent(m[2])}`] ?? {} : {});
      res.writeHead(200, { 'Content-Type': 'application/xhtml+xml;v=2.0', 'Content-Length': String(Buffer.byteLength(body)) });
      if (!resetting) { res.end(body); return; }
      resets++;
      res.write(body.slice(0, body.length >> 1));
      setTimeout(() => req.socket.resetAndDestroy(), 5);
    });
    await new Promise<void>(r => controller.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise(r => { controller.closeAllConnections(); controller.close(r); }));
    const client = new RwsClient2(`http://127.0.0.1:${(controller.address() as AddressInfo).port}`, 'u', 'p', { timeout: 2_000 });

    // The controller's manager: the axis configuration through the real client
    // transport above, everything else answered at once.
    const manager = {
      currentPort: 9403, currentUseHttps: true,
      state: {
        connected: true, quality: 'live', qualityReason: 'x', identity: null,
        systemInfo: { name: 'x', rwVersion: '7.21.0', sysid: SYSID, startTime: '', options: [] },
        mechunits: ['ROB_1'], execstate: null, tasks: [],
      } as unknown as RobotState,
      getMechunitDetails: async (name: string) => ({
        name, type: 'TCPRobot', axes: 6, axesTotal: 6, task: 'T_ROB1', mode: 'Activated', status: 'Synchronized',
        coordSystem: 'World', tool: 'tool0', wobj: 'wobj0', isIntegratedUnit: null, hasIntegratedUnit: null, raw: {},
      }),
      getJointTargetFull: async () => ({ rax: [10, -10, 20, 0, 30, 0], eax: [0, 0, 0, 0, 0, 0] }),
      getCartesianFull: async () => ({ x: 806.3, y: 0, z: 1015, q1: 0.5, q2: 0, q3: 0.866, q4: 0, j1: 0, j4: 0, j6: 0, jx: 0 }),
      getCfgInstance: (domain: string, type: string, instance: string) => client.getCfgInstance(domain, type, instance),
    };
    const logged: Array<{ level: string; msg?: string; obj: object }> = [];
    const capture = (level: string) => (obj: object, msg?: string) => { logged.push({ level, obj, msg }); };
    const fleet = new ControllerFleet([cfg], { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') });
    (fleet as unknown as { managerOf: () => unknown }).managerOf = () => manager;
    let skew = 0;
    fleet.watchMotion(ID);
    fleet.startMotionSampler(10, () => Date.now() + skew);
    cleanup.push(() => fleet.stopMotionSampler());

    // The walk fails on the reset; the joints are still sampled, without units.
    const walkFailed = () => logged.find(l => l.level === 'warn' && l.msg?.startsWith('axis configuration not read'));
    await until(() => !!walkFailed());
    expect((walkFailed()!.obj as { err: string }).err).toMatch(/ECONNRESET|closed|cut off/);
    await until(() => (fleet.get(ID)?.motion.units[0]?.joints.length ?? 0) === 6);
    expect(fleet.get(ID)!.motion.units[0].joints[0]).toMatchObject({ value: 10, unit: null });
    expect(resets).toBeGreaterThan(0);

    // Once the controller answers again, the walk's retry (its 5 s backoff
    // skipped here, inside the lease) reads the configuration on the same client.
    resetting = false;
    skew = 6_000;
    fleet.watchMotion(ID);
    await until(() => fleet.get(ID)?.motion.units[0]?.joints[0]?.unit === 'deg');
    expect(uncaught).toEqual([]);
  }, 3 * WAIT_MS + 5_000);   // three waits on a real socket; the load-sensitive case of this suite

  it('while a WebSocket upgrade is still being routed is handled, and the server keeps answering', async () => {
    const app = createServer({ accessToken: null });
    const stream = new SnapshotStream({ list: () => [], get: () => null, onChanged() {} }, new SocketHub({ heartbeatMs: 0 }));
    await registerStreamRoute(app, stream);
    // Node has removed its own listener from an upgrade socket by the time
    // 'upgrade' fires, and the stream has not adopted it yet: a reset read in
    // that gap is emitted here, as the socket would.
    let outcome: 'pending' | 'handled' | unknown = 'pending';
    app.server.on('upgrade', (_req: http.IncomingMessage, socket: Socket) => {
      try {
        socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
        outcome = 'handled';
      } catch (e) { outcome = e; }
      socket.destroy();
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(async () => { stream.close(); await app.close(); });
    const port = (app.server.address() as AddressInfo).port;

    const peer = net.connect(port, '127.0.0.1');
    peer.on('error', () => { /* the server drops it */ });
    cleanup.push(() => peer.destroy());
    peer.write(`GET /v0/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
      + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    await until(() => outcome !== 'pending');

    expect(outcome).toBe('handled');
    const health = await fetch(`http://127.0.0.1:${port}/v0/health`);
    expect(health.status).toBe(200);
    expect(uncaught).toEqual([]);
  }, WAIT_MS + 5_000);
});

describe('logFatalErrors', () => {
  it('logs an uncaught error through the daemon log, and leaves the exit to Node', () => {
    const proc = new EventEmitter();
    const lines: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    logFatalErrors({ fatal: (obj, msg) => { lines.push({ obj: obj as Record<string, unknown>, msg }); } }, proc);

    proc.emit('uncaughtExceptionMonitor', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'uncaughtException');

    expect(lines).toHaveLength(1);
    expect(lines[0].obj).toMatchObject({ err: 'read ECONNRESET', code: 'ECONNRESET', origin: 'uncaughtException' });
    // A monitor only: nothing that would catch the error and keep the process alive.
    expect(proc.listenerCount('uncaughtException')).toBe(0);
    expect(proc.listenerCount('unhandledRejection')).toBe(0);
  });
});

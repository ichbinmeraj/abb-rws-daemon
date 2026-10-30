/**
 * A controller and the client in front of it, faked, under a real
 * ControllerFleet: what the fleet tests (the recording tap, the frames the
 * daemon serves, the access reader) drive the fleet's whole lifetime with.
 */
import { RwsError, type SubscriptionEvent, type SubscriptionResource } from 'abb-rws-client';
import { ControllerFleet } from '../../src/fleet.js';
import type { ControllerConfig } from '../../src/config.js';

export const RW7_ID = '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}';
export const ID = 'irb1600-6-120-1';
export const T0 = Date.parse('2026-10-04T12:00:00Z');
export const SECRET = 'tap-test-not-a-password';
export const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Added without a system id: the fleet learns it on the first read and tells the client (updateConfig). */
export const cfg = (): ControllerConfig => ({
  id: ID, name: 'IRB1600_6_120_1', host: '127.0.0.1', port: 9403, useHttps: true, username: 'Default User', password: SECRET,
});

/** What the controller's clock reads at a UTC moment, as the controllers write it. */
export const controllerTime = (utcMs: number) => new Date(utcMs).toISOString().slice(0, 19).replace('T', ' T ');

/** One unit's motion configuration, as the axis-configuration walk reads it. */
const MOC: Record<string, Record<string, string>> = {
  'MECHANICAL_UNIT/ROB_1': { name: 'ROB_1', use_robot: 'ROB_1' },
  'ROBOT/ROB_1': { use_joint_0: 'rob1_1' },
  'JOINT/rob1_1': { logical_axis: '1', use_arm: 'rob1_1', use_transmission: 'rob1_1' },
  'TRANSMISSION/rob1_1': { rotating_move: 'TRUE' },
  'ARM/rob1_1': { lower_joint_bound: '-3.0', upper_joint_bound: '3.0' },
};

/** The access generations a fake client can report. */
export type FakeGeneration = 'rw6' | 'rw7' | 'rw8';

/** The locks the client lists for a generation, in its own order. */
const LOCKS: Record<FakeGeneration, string[]> = { rw6: ['cfg', 'motion', 'rapid'], rw7: ['edit', 'motion'], rw8: ['writeaccess'] };

/** The RobotWare version a fake controller of a generation reports. */
const RW_VERSION: Record<FakeGeneration, string> = { rw6: '6.16.3007', rw7: '7.21.4', rw8: '8.2.1+1023' };

/** How a fake world's client and controller stand towards access (schema 0.13). */
export interface WorldOptions {
  /**
   * The access generation the client reports once connected: `rw6` (an RWS
   * 1.0 link), `rw7` or `rw8`, or null for a client that could not determine
   * it (the controller reported no RobotWare version). Left out: the client's
   * state carries no `access` at all, and nothing about access is ever asked.
   */
  generation?: FakeGeneration | null;
  /** The client has the RobotWare 8 write-access status read (`getWriteAccessStatus`). */
  writeAccessReader?: boolean;
  /** Stands in front of every manager the world makes (a guard that refuses calls, say); the world itself uses the manager behind it. */
  wrap?: <T extends object>(manager: T) => T;
}

/**
 * A controller and the client in front of it, faked: every request the
 * daemon makes is logged as `<target>:<method>:<arguments>@<ms since T0>`,
 * and each takes a few milliseconds. The managers reach their own helpers
 * through `this` (`request`), as the client does - those are not the
 * daemon's calls.
 *
 * With `opts.generation` the client also reports an access generation and
 * its own lock states, and the status reads answer what `access` holds at
 * the moment each one lands.
 */
export function world(opts: WorldOptions = {}) {
  const log: string[] = [];
  const at = () => Date.now() - T0;
  const wait = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

  /**
   * What the access status reads answer: a value, or a function giving one;
   * an Error is thrown instead. `mastership` by the domain asked for.
   */
  const access = {
    mastership: {
      cfg: { mastership: 'nomaster' }, motion: { mastership: 'nomaster' }, rapid: { mastership: 'nomaster' },
    } as Record<string, unknown>,
    rmmp: 'none' as unknown,
    writeAccess: { held: false, heldByMe: false, heldByName: null, externalControlEnabled: true } as unknown,
    /** How long one status read takes (ms). */
    ms: 5,
    /** While set, every status read waits for it before it answers. */
    gate: null as Promise<void> | null,
    /** Status reads out now, and the most that were out at once. */
    out: 0,
    maxOut: 0,
  };

  /**
   * Where the controller answers the client's next connect: the port the
   * client lands on (its own port recovery, when the saved port stops
   * answering) and the system id it reads there (null: not read yet).
   */
  const controller = { port: 9403, sysid: RW7_ID as string | null };

  /**
   * What a RAPID value read answers, by `task/module/symbol`: the value text
   * the client hands back, or an Error to throw. A symbol not listed reads `0`.
   */
  const rapid = { values: {} as Record<string, string | Error>, ms: 5 };

  /** The client's own account of access once connected, as `RobotState.access` carries it. */
  const clientAccess = (generation: FakeGeneration | null) => ({
    generation,
    locks: generation ? LOCKS[generation].map(lock => ({ lock, state: 'idle', count: 0, since: null })) : [],
    watchdog: null,
    rw8: generation === 'rw8' ? { registered: false, stationName: 'fake-station' } : null,
  });

  class Manager {
    taps: Array<(e: SubscriptionEvent) => void> = [];
    currentPort: number | undefined = undefined;
    currentUseHttps: boolean | undefined = undefined;
    subscriptionGroupPath: string | undefined = undefined;
    state = {
      connected: false, quality: 'disconnected', qualityReason: 'not connected', identity: null, systemInfo: null as object | null,
      tasks: [] as object[], mechunits: [] as string[], modulesByTask: {} as Record<string, string[]>, execstate: null as string | null,
      ioSignals: [] as object[], ioSignalsLoaded: false, eventLog: [] as object[],
    };
    /** Only on a client that has the read. */
    getWriteAccessStatus?: () => Promise<unknown>;

    constructor() {
      if (opts.writeAccessReader) {
        this.getWriteAccessStatus = () => this.status('getWriteAccessStatus', [], () => access.writeAccess);
      }
    }

    private async request<T>(method: string, args: unknown[], value: () => T, ms = 5): Promise<T> {
      log.push(`manager:${method}:${JSON.stringify(args)}@${at()}`);
      await wait(ms);
      return value();
    }
    /** One access status read: logged like every request, answered with what `access` holds when it lands. */
    private async status(method: string, args: unknown[], answer: () => unknown): Promise<unknown> {
      access.out++;
      access.maxOut = Math.max(access.maxOut, access.out);
      try {
        await this.request(method, args, () => undefined, access.ms);
        if (access.gate) { await access.gate; }
        const held = answer();
        const value = typeof held === 'function' ? (held as () => unknown)() : held;
        if (value instanceof Error) { throw value; }
        return value;
      } finally {
        access.out--;
      }
    }
    getMastershipStatus(domain: string = 'rapid') { return this.status('getMastershipStatus', [domain], () => access.mastership[domain]); }
    getRmmpPrivilege() { return this.status('getRmmpPrivilege', [], () => access.rmmp); }
    getProgramPointer(task: string) { return this.request('getProgramPointer', [task], () => ({ module: 'MainModule', routine: 'main', row: 3 })); }
    getMotionPointer(task: string) { return this.request('getMotionPointer', [task], () => ({ module: 'MainModule', routine: 'main', row: 4 })); }
    getModuleText(task: string, module: string) {
      return this.request('getModuleText', [task, module], () => ({ text: `MODULE ${module}\nENDMODULE`, changeCount: 1 }));
    }
    getRapidVariable(task: string, module: string, symbol: string) {
      return this.request('getRapidVariable', [task, module, symbol], () => {
        const v = rapid.values[`${task}/${module}/${symbol}`] ?? '0';
        if (v instanceof Error) { throw v; }
        return v;
      }, rapid.ms);
    }
    listModulesDetailed(task: string) {
      return this.request('listModulesDetailed', [task], () => [{ name: 'BASE', type: 'SysMod' }, { name: 'MainModule', type: 'ProgMod' }]);
    }
    searchSignals(criteria: object) { return this.request('searchSignals', [criteria], () => [{ name: 'do_a', type: 'DO', value: '0', lvalue: '0' }]); }
    readIoSignal(network: string, device: string, name: string) {
      return this.request('readIoSignal', [network, device, name], () => ({ name, value: '0', lvalue: '0', type: 'DO' as const }));
    }
    updateSubscriptionGroup(group: string, resources: SubscriptionResource[]) {
      return this.request('updateSubscriptionGroup', [group, resources], () => group);
    }
    unsubscribeResource(group: string, resource: SubscriptionResource) {
      return this.request('unsubscribeResource', [group, resource], () => undefined);
    }
    getMechunitDetails(name: string) {
      return this.request('getMechunitDetails', [name], () => ({
        name, type: 'TCPRobot', axes: 6, axesTotal: 6, task: 'T_ROB1', mode: 'Activated', status: 'Synchronized',
        coordSystem: 'World', tool: 'tool0', wobj: 'wobj0', isIntegratedUnit: null, hasIntegratedUnit: null, raw: {},
      }));
    }
    getCfgInstance(domain: string, type: string, instance: string) {
      return this.request('getCfgInstance', [domain, type, instance], () => MOC[`${type}/${instance}`] ?? {});
    }
    getJointTargetFull(name: string) { return this.request('getJointTargetFull', [name], () => ({ rax: [10, 0, 0, 0, 0, 0], eax: [0, 0, 0, 0, 0, 0] })); }
    async getCartesianFull(name: string): Promise<never> {
      // A typed failure on the way: the sampler keeps going, and the recording sees the error.
      await this.request('getCartesianFull', [name], () => null);
      throw new RwsError('HTTP 404 - no such resource', 'RESOURCE_NOT_FOUND');
    }
    getEventLog(domain: number, lang: string) { return this.request('getEventLog', [domain, lang], () => []); }
    getControllerClock() { return this.request('getControllerClock', [], () => controllerTime(Date.now())); }
    onSubscriptionEvent(fn: (e: SubscriptionEvent) => void): () => void {
      this.taps.push(fn);
      return () => { this.taps = this.taps.filter(t => t !== fn); };
    }
    fire(resource: string, value: string): SubscriptionEvent {
      const event = { resource, value, timestamp: new Date(Date.now()) };
      for (const t of [...this.taps]) { t(event); }
      return event;
    }
  }

  /** The managers the fleet is handed (behind `opts.wrap`, when given) and the managers themselves. */
  const robots = new Map<string, Manager>();
  const raws = new Map<string, Manager>();
  const configs = new Map<string, { id: string }>();
  const multi = {
    /** The fleet's change handler (wired by fleetOver). */
    changed: (_id: string): void => {},
    get entries() { return [...robots].map(([id, manager]) => ({ id, config: configs.get(id)!, manager })); },
    onError(_fn: unknown): void {},
    onRobotChanged(_fn: unknown): void {},
    addRobot(config: { id: string }) {
      log.push(`multi:addRobot:${JSON.stringify([config])}@${at()}`);
      const manager = new Manager();
      raws.set(config.id, manager);
      robots.set(config.id, opts.wrap ? opts.wrap(manager) : manager);
      configs.set(config.id, config);
      this.changed(config.id);
    },
    updateConfig(id: string, patch: object) { log.push(`multi:updateConfig:${JSON.stringify([id, patch])}@${at()}`); },
    async connectRobot(id: string) {
      log.push(`multi:connectRobot:${JSON.stringify([id])}@${at()}`);
      await wait(10);
      const m = raws.get(id)!;
      const rws1 = opts.generation === 'rw6';
      Object.assign(m.state, {
        connected: true, quality: 'live', qualityReason: 'WebSocket events streaming',
        systemInfo: controller.sysid === null ? null : {
          name: 'IRB1600_6_120_1', rwVersion: opts.generation === undefined ? '7.21.4' : opts.generation === null ? '' : RW_VERSION[opts.generation],
          sysid: controller.sysid, startTime: '', options: [],
        },
        tasks: [{ name: 'T_ROB1', type: 'normal', taskstate: 'started', excstate: 'running', active: true, motiontask: true }],
        execstate: 'running', mechunits: ['ROB_1'], modulesByTask: { T_ROB1: ['BASE', 'MainModule'] },
        ioSignals: [{ name: 'do_a', type: 'DO', value: '0', lvalue: '0' }, { name: 'do_b', type: 'DO', value: '0', lvalue: '0' }],
        ioSignalsLoaded: true,
        ...(opts.generation !== undefined ? { opmode: 'AUTO', access: clientAccess(opts.generation) } : {}),
      });
      m.currentPort = controller.port;
      m.currentUseHttps = !rws1;
      m.subscriptionGroupPath = rws1 ? undefined : '/subscription/1';
      this.changed(id);
    },
    async disconnectRobot(id: string) {
      log.push(`multi:disconnectRobot:${JSON.stringify([id])}@${at()}`);
      await wait(5);
      const m = raws.get(id);
      if (m) {
        Object.assign(m.state, { connected: false, quality: 'disconnected', qualityReason: 'logged out' });
        // The client forgets its own account of access with the session.
        if (opts.generation !== undefined) { Object.assign(m.state, { access: clientAccess(null) }); }
        this.changed(id);
      }
    },
    removeRobot(id: string) {
      log.push(`multi:removeRobot:${JSON.stringify([id])}@${at()}`);
      robots.delete(id);
      raws.delete(id);
      configs.delete(id);
      this.changed(id);
    },
  };

  /** The link's quality changes on the connection it has, as the client reports a failed poll or a lost event stream. */
  const quality = (id: string, to: 'live' | 'polling' | 'stale', reason: string): void => {
    Object.assign(raws.get(id)!.state, { quality: to, qualityReason: reason });
    multi.changed(id);
  };
  /** The link is lost without a logout (the client gave up on it): no session, and the client's account of access is gone. */
  const drop = (id: string): void => {
    const m = raws.get(id)!;
    Object.assign(m.state, { connected: false, quality: 'disconnected', qualityReason: 'connection lost' });
    if (opts.generation !== undefined) { Object.assign(m.state, { access: clientAccess(null) }); }
    multi.changed(id);
  };
  /** A change of the client's state, told as the client tells it. */
  const set = (id: string, patch: object): void => {
    Object.assign(raws.get(id)!.state, patch);
    multi.changed(id);
  };

  return { log, multi, robots, access, controller, rapid, manager: (id: string) => raws.get(id)!, quality, drop, set };
}

export type World = ReturnType<typeof world>;

/**
 * A fleet whose client is the fake world's: the test's MultiRobotManager, whose
 * changes reach the fleet as the client's would. `onConfigChange` is told
 * every config list the fleet would save.
 */
export function fleetOver(
  w: World,
  log: ConstructorParameters<typeof ControllerFleet>[1] = silent,
  onConfigChange?: ConstructorParameters<typeof ControllerFleet>[2],
): ControllerFleet {
  const f = new ControllerFleet([], log, onConfigChange);
  const inner = f as unknown as { multi: unknown; robotChanged: (id: string) => void };
  inner.multi = w.multi;
  w.multi.changed = id => inner.robotChanged(id);
  return f;
}

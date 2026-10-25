import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MultiRobotManager, RWS1Adapter, RWS2Adapter, RobotManager, RwsClient, RwsClient2 } from 'abb-rws-client';
import type { ControllerFleet, Log } from '../src/fleet.js';
import { ACCESS_READ_MS } from '../src/schema/v0.js';
import { ID, T0, cfg, fleetOver, world, type FakeGeneration, type WorldOptions } from './helpers/fake-fleet.js';

// This daemon only reads. Two proofs: (a) under a whole fleet lifetime with
// every poller running, a client that refuses every method outside the read
// list is never refused; (b) no source file calls a client method that
// changes access or anything else on a controller.

/** Every method the daemon may call on a controller's manager: the reads, the tap on its events, and the edits of the daemon's own subscription group. */
const READS: readonly string[] = [
  'getProgramPointer', 'getMotionPointer',            // pointers
  'getModuleText', 'listModulesDetailed',             // module text and listing
  'readIoSignal', 'searchSignals',                    // signal read and search
  'getMechunitDetails',                               // mechanical unit
  'getCfgInstance',                                   // configuration instance
  'getJointTargetFull',                               // joint target
  'getCartesianFull',                                 // pose
  'getEventLog',                                      // event log
  'getControllerClock',                               // clock
  'getMastershipStatus',                              // mastership status
  'getRmmpPrivilege',                                 // RMMP privilege
  'getWriteAccessStatus',                             // write-access status
  'onSubscriptionEvent',                              // the subscription tap
  'updateSubscriptionGroup', 'unsubscribeResource',   // the daemon's own subscription-group edits
  'getSubscriptionGroup',                             // that group's members, read after a refused add
];

/** What the daemon may call to manage its own sessions: adding, connecting, logging out, and listening. No controller state changes with these. */
const SESSION: readonly string[] = [
  'addRobot', 'removeRobot', 'connectRobot', 'disconnectRobot', 'updateConfig', 'onError', 'onRobotChanged',
  'connect', 'disconnect', 'setExpectedSystemId',
];

/** The reads of the setup passport (one session, read and logged out). */
const PASSPORT_READS: readonly string[] = [
  'getControllerIdentity', 'getSystemInfo', 'listControllerOptions', 'getLicenseInfo', 'listProducts', 'getRobotType',
];

/**
 * Methods that are not the client's but share a name with a client method: the daemon's own `notify`
 * (replay/stream.ts) and `fleet.disconnectAll` (stop.ts), and Node's `FileHandle.read` (replay/reader.ts).
 */
const OWN_NAMESAKES: readonly string[] = ['notify', 'read', 'disconnectAll'];

/**
 * The client's methods that change access or anything else on a controller,
 * by name: none of them may be called anywhere under src/.
 */
const CHANGING: readonly string[] = [
  // Mastership, in every form.
  'requestMastership', 'releaseMastership', 'requestMastershipAll', 'releaseMastershipAll', 'requestMastershipWithId',
  'releaseMastershipWithId', 'wireRequestMastership', 'wireReleaseMastership', 'wireRequestMastershipAll', 'wireReleaseMastershipAll',
  'withMastership', 'withAccess', 'withCfgAccess', 'releaseJogMastership',
  // The mastership watchdog.
  'resetMastershipWatchdog', 'wireResetWatchdog',
  // RMMP.
  'requestRmmp', 'pollRmmp', 'cancelRmmp', 'endRmmp',
  // Write access, the appeal, control-station registration, the motion-control declaration, external control.
  'requestWriteAccess', 'releaseWriteAccess', 'acquireWriteAccess', 'dropWriteAccess', 'appealWriteAccessRelease',
  'registerControlStationRemote', 'registerControlStationLocal', 'setControlStation',
  'setAllowMotionControl', 'requireMotionControl', 'disableExternalControl',
  // The common writes: speed ratio, motors, RAPID start / stop / reset, pointers, jog, signals, variables, modules, restart, operating mode.
  'setSpeedRatio', 'setMotorsOn', 'setMotorsOff', 'setControllerState',
  'startRapid', 'stopRapid', 'resetRapid', 'stepRapid', 'holdToRun', 'setExecutionCycle',
  'setProgramPointer', 'setPPToRoutine', 'setPPToCursor', 'resetTaskProgramPointer',
  'jog', 'setMechunitForJogging', 'setRobtargetForJogging', 'teleportMechunit',
  'writeIoSignal', 'writeSignal', 'setSignalSimulated',
  'setRapidVariable',
  'loadModule', 'loadProgram', 'uploadAndLoad', 'uploadModule', 'unloadModule', 'setModuleText', 'setModuleTextRange',
  'restartController',
  'setOperationMode', 'setOpmodeOnce', 'lockOperationMode', 'unlockOperationMode', 'acknowledgeOperationMode',
  // Configuration, files, clock, event log, backups.
  'setCfgInstance', 'createCfgInstance', 'removeCfgInstance', 'loadCfgFile', 'uploadFile', 'deleteFile', 'deleteControllerFile',
  'setControllerClock', 'clearEventLog', 'clearAllEventLogs', 'createBackup', 'restoreBackup',
];

// ---------------------------------------------------------------------------
// (a) A client that refuses everything but the reads.
// ---------------------------------------------------------------------------

/** Every method name of a class, its inherited ones included. */
function methodsOf(cls: { prototype: object }): Set<string> {
  const out = new Set<string>();
  for (let p: object | null = cls.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
    for (const name of Object.getOwnPropertyNames(p)) {
      const d = Object.getOwnPropertyDescriptor(p, name);
      if (name !== 'constructor' && d && typeof d.value === 'function') { out.add(name); }
    }
  }
  return out;
}

const MANAGER_METHODS = methodsOf(RobotManager);
const MULTI_METHODS = methodsOf(MultiRobotManager);

/**
 * A guard in front of a fake client object: it is every method the real
 * class has - so reaching for one is seen even where the fake has none - and
 * refuses each one outside `allowed`, noting it. Allowed methods run on the
 * object behind the guard, as the client's own would.
 */
function guard(real: Set<string>, allowed: ReadonlySet<string>, refused: string[], used: Set<string>) {
  return <T extends object>(target: T): T => new Proxy(target, {
    get(t, prop) {
      const own: unknown = Reflect.get(t, prop, t);
      if (typeof prop !== 'string' || prop in Object.prototype) { return own; }
      if (typeof own !== 'function' && !real.has(prop)) { return own; }   // a field: state, the port, the group path
      if (!allowed.has(prop)) {
        refused.push(prop);
        throw new Error(`the daemon reached for ${prop}, which is not on the read list`);
      }
      if (typeof own !== 'function') { return own; }   // a read this fake client does not have
      used.add(prop);
      return (own as (...a: unknown[]) => unknown).bind(t);
    },
  });
}

let fleets: ControllerFleet[] = [];
afterEach(() => {
  for (const f of fleets) { f.stopAccessReader(); f.stopPointerPoller(); f.stopMotionSampler(); f.stopIoPoller(); f.stopEventReader(); f.stopSupervisor(); }
  fleets = [];
  vi.useRealTimers();
});

/**
 * A controller's whole lifetime with every poller running, behind the guard:
 * connect, pointers, motion, I/O (a watch, an event, a lease that lapses),
 * the event log, the access reader, reads on demand, a mode change, an
 * outage and a reconnect, the logout and the removal.
 */
async function guardedLifetime(opts: WorldOptions) {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const refused: string[] = [];
  const used = new Set<string>();
  const lines: string[] = [];
  const keep = (level: string) => (obj: object, msg?: string): void => { lines.push(`${level} ${msg ?? ''} ${JSON.stringify(obj)}`); };
  const log: Log = { debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') };
  const w = world({ ...opts, wrap: guard(MANAGER_METHODS, new Set(READS), refused, used) });
  const f = fleetOver(w, log);
  fleets.push(f);
  const sessionUsed = new Set<string>();
  const inner = f as unknown as { multi: unknown };
  inner.multi = guard(MULTI_METHODS, new Set([...SESSION, 'changed']), refused, sessionUsed)(w.multi);

  f.add(cfg());
  await vi.advanceTimersByTimeAsync(50);
  f.startPointerPoller();
  f.startMotionSampler();
  f.startIoPoller();
  f.startEventReader();
  f.startAccessReader();
  f.watchMotion(ID);
  f.watchIo(ID, ['do_a', 'do_b']);
  await vi.advanceTimersByTimeAsync(2_000);
  const reads = Promise.all([f.moduleSource(ID, 'T_ROB1', 'MainModule'), f.searchIoSignals(ID, { name: 'do' })]);
  await vi.advanceTimersByTimeAsync(100);
  await reads;
  w.manager(ID).fire('/rw/iosystem/signals/do_a;state', '1');
  w.set(ID, { execstate: 'stopped', opmode: 'MANR' });
  await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + 1_000);
  // The watch leases lapse: the watcher takes its signals out of the subscription group again.
  await vi.advanceTimersByTimeAsync(20_000);
  // An outage and a reconnect, as the supervisor makes one.
  w.drop(ID);
  f.startSupervisor(500);
  await vi.advanceTimersByTimeAsync(3_000);
  f.watchMotion(ID);
  f.watchIo(ID, ['do_a']);
  await vi.advanceTimersByTimeAsync(ACCESS_READ_MS + 2_000);
  const snapshot = f.get(ID)!;
  const stopping = f.disconnectAll({ waitMs: 1_000 });
  await vi.advanceTimersByTimeAsync(1_000);
  await stopping;
  const removing = f.remove(ID);
  await vi.advanceTimersByTimeAsync(1_000);
  await removing;
  return { refused, used, sessionUsed, lines, log: [...w.log], snapshot };
}

/** What a lifetime must have reached for, per generation, to count as "every poller ran". */
const EXPECTED: Record<FakeGeneration, string[]> = {
  rw6: ['getProgramPointer', 'getMotionPointer', 'getModuleText', 'listModulesDetailed', 'readIoSignal', 'searchSignals', 'getMechunitDetails',
    'getCfgInstance', 'getJointTargetFull', 'getCartesianFull', 'getEventLog', 'getControllerClock', 'getMastershipStatus', 'getRmmpPrivilege'],
  rw7: ['getProgramPointer', 'getMotionPointer', 'getModuleText', 'listModulesDetailed', 'readIoSignal', 'searchSignals', 'getMechunitDetails',
    'getCfgInstance', 'getJointTargetFull', 'getCartesianFull', 'getEventLog', 'getControllerClock', 'getMastershipStatus', 'getRmmpPrivilege',
    'onSubscriptionEvent', 'updateSubscriptionGroup', 'unsubscribeResource'],
  rw8: ['getProgramPointer', 'getMotionPointer', 'getModuleText', 'listModulesDetailed', 'readIoSignal', 'searchSignals', 'getMechunitDetails',
    'getCfgInstance', 'getJointTargetFull', 'getCartesianFull', 'getEventLog', 'getControllerClock', 'getWriteAccessStatus',
    'onSubscriptionEvent', 'updateSubscriptionGroup', 'unsubscribeResource'],
};

describe('read-only (a): a client that refuses everything but the reads is never refused', () => {
  it.each(['rw6', 'rw7', 'rw8'] as const)('%s: a whole lifetime with every poller running', async generation => {
    const run = await guardedLifetime({ generation, writeAccessReader: generation === 'rw8' });
    expect(run.refused).toEqual([]);
    expect(run.lines.filter(l => l.includes('not on the read list'))).toEqual([]);
    // Every poller ran: each read of the list was reached for.
    for (const method of EXPECTED[generation]) { expect(run.used, method).toContain(method); }
    for (const method of run.used) { expect(READS, method).toContain(method); }
    // What went to the client, by the fake's own log: reads on the manager, session calls on the fleet's client, nothing else.
    for (const line of run.log) {
      const [target, method] = line.split(':');
      expect(target === 'manager' ? READS : SESSION, line).toContain(method);
    }
    // The reader really read: the status is in the snapshot taken before the shutdown.
    expect(run.snapshot.access.generation).toBe(generation);
    expect(run.snapshot.access.locks.every(l => l.held !== null)).toBe(true);
    expect(run.snapshot.access.locks.every(l => l.heldByDaemon === false)).toBe(true);
  }, 30_000);

  it('RobotWare 8 with a client that lacks the status read: the lifetime runs the same, and no access read is sent at all', async () => {
    const run = await guardedLifetime({ generation: 'rw8' });
    expect(run.refused).toEqual([]);
    for (const method of ['getWriteAccessStatus', 'getMastershipStatus', 'getRmmpPrivilege']) { expect(run.used, method).not.toContain(method); }
    expect(run.snapshot.access.locks.map(l => l.held)).toEqual([null]);
  }, 30_000);

  it('the guard itself refuses: a method off the list throws and is noted, also one the fake does not have', () => {
    const refused: string[] = [];
    const used = new Set<string>();
    const guarded = guard(MANAGER_METHODS, new Set(READS), refused, used)({
      state: { connected: true },
      getMastershipStatus: () => 'asked',
      setSpeedRatio: () => 'written',
    }) as unknown as Record<string, (...a: unknown[]) => unknown> & { state: object };
    expect(guarded.state).toEqual({ connected: true });
    expect(guarded.getMastershipStatus()).toBe('asked');
    expect(typeof guarded.getWriteAccessStatus).toBe('undefined');   // on the list, and this client has none
    expect(() => guarded.setSpeedRatio).toThrow(/not on the read list/);
    expect(() => guarded.requestMastership).toThrow(/not on the read list/);   // the fake has none; the real client does
    expect(() => guarded.requestRmmp).toThrow(/not on the read list/);
    expect(refused).toEqual(['setSpeedRatio', 'requestMastership', 'requestRmmp']);
    expect([...used]).toEqual(['getMastershipStatus']);
  });

  it('the read list holds no method that changes anything, and the client really has the changing ones', () => {
    for (const method of CHANGING) {
      expect(READS, method).not.toContain(method);
      expect(SESSION, method).not.toContain(method);
      expect(PASSPORT_READS, method).not.toContain(method);
    }
    // The names are the client's own (a list of names nobody has would prove nothing).
    for (const method of ['requestMastership', 'releaseMastership', 'resetMastershipWatchdog', 'requestRmmp', 'pollRmmp', 'cancelRmmp',
      'setSpeedRatio', 'setMotorsOn', 'startRapid', 'stopRapid', 'resetRapid', 'jog', 'writeIoSignal', 'setRapidVariable', 'unloadModule',
      'restartController', 'setOperationMode']) {
      expect(MANAGER_METHODS, method).toContain(method);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) No source file calls a client method that changes anything.
// ---------------------------------------------------------------------------

/** Source text with its comments blanked out (strings stay: a call inside a template expression still counts). */
function withoutComments(text: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) { quote = null; }
      i++;
      continue;
    }
    if (c === '"' || c === '\'' || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') { i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The names called as methods in a source text: the form `.name(`, also `.name?.(`. */
function methodCalls(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of withoutComments(text).matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(/g)) { names.add(m[1]); }
  return names;
}

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...sourceFiles(path)); }
    else if (entry.name.endsWith('.ts')) { out.push(path); }
  }
  return out;
}

/** Every method name any class of the client has: the managers, both clients, both adapters. */
const CLIENT_METHODS = new Set<string>(
  [RobotManager, MultiRobotManager, RwsClient, RwsClient2, RWS1Adapter, RWS2Adapter].flatMap(cls => [...methodsOf(cls)]));

describe('read-only (b): no source file calls a client method that changes anything', () => {
  const files = sourceFiles();
  const calls = new Map<string, Set<string>>(files.map(file => [relative(SRC, file).replace(/\\/g, '/'), methodCalls(readFileSync(file, 'utf8'))]));

  it('the scan sees calls and only calls', () => {
    const sample = [
      'await manager.requestMastership(\'rapid\');',
      '// manager.setSpeedRatio(50) in a line comment',
      '/* manager.startRapid() in a block',
      '   comment */',
      'const table = { setRapidVariable: [1], writeIoSignal: [2] };   // a table of names is no call',
      'a.getRobotType?.().catch(() => null);',
      'const text = `${m.jog(1)}`;',
      'const url = "http://host/x"; m . stopRapid ();',
      'm.onSubscriptionEvent(e => e)',
    ].join('\n');
    expect([...methodCalls(sample)].sort()).toEqual(['catch', 'getRobotType', 'jog', 'onSubscriptionEvent', 'requestMastership', 'stopRapid']);
    // Comments are blanked, line for line; the code around them stays.
    const bare = withoutComments('a(); // b()\nc(); /* d()\n e() */ f();');
    expect(bare.split('\n').map(l => l.trim())).toEqual(['a();', 'c();', 'f();']);
    expect(withoutComments('const u = "http://host//x"; g();')).toBe('const u = "http://host//x"; g();');
  });

  it('it read the daemon\'s sources: the fleet, with its reads, is among them', () => {
    expect(files.length).toBeGreaterThan(30);
    expect(calls.get('fleet.ts')).toBeDefined();
    for (const method of ['getMastershipStatus', 'getRmmpPrivilege', 'getWriteAccessStatus', 'getEventLog', 'readIoSignal']) {
      expect(calls.get('fleet.ts'), method).toContain(method);
    }
    expect(CLIENT_METHODS.size).toBeGreaterThan(200);
  });

  it('none of the changing methods is called anywhere under src/', () => {
    const found: string[] = [];
    for (const [file, names] of calls) {
      for (const method of CHANGING) {
        if (names.has(method)) { found.push(`${file}: .${method}(`); }
      }
    }
    expect(found).toEqual([]);
  });

  it('every client method the sources call is a read, a session call or a passport read: anything else the client offers is refused here', () => {
    const allowed = new Set([...READS, ...SESSION, ...PASSPORT_READS, ...OWN_NAMESAKES]);
    const found: string[] = [];
    for (const [file, names] of calls) {
      for (const name of names) {
        if (CLIENT_METHODS.has(name) && !allowed.has(name)) { found.push(`${file}: .${name}(`); }
      }
    }
    expect(found).toEqual([]);
  });

  it('the manager\'s methods are called from the fleet alone, and only its reads', () => {
    const elsewhere: string[] = [];
    for (const [file, names] of calls) {
      if (file === 'fleet.ts') { continue; }
      for (const name of READS) {
        if (names.has(name)) { elsewhere.push(`${file}: .${name}(`); }
      }
    }
    expect(elsewhere).toEqual([]);
    const fleetCalls = [...calls.get('fleet.ts')!].filter(name => CLIENT_METHODS.has(name));
    for (const name of fleetCalls) { expect([...READS, ...SESSION], name).toContain(name); }
  });

  /** Every `app.<verb>(<path>, ...)` in a source text, as `VERB <path as written>` (a text, or the name of a constant). */
  function routesIn(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/\bapp\s*\.\s*(get|post|put|patch|delete)\b/g)) {
      let i = m.index + m[0].length;
      while (/\s/.test(text[i] ?? '')) { i++; }
      if (text[i] === '<') {
        // The type arguments, to their closing bracket.
        let depth = 0;
        for (; i < text.length; i++) {
          if (text[i] === '<') { depth++; }
          else if (text[i] === '>' && text[i - 1] !== '=' && --depth === 0) { i++; break; }
        }
        while (/\s/.test(text[i] ?? '')) { i++; }
      }
      if (text[i] !== '(') { continue; }
      const first = /^\(\s*(?:(['"`])([^'"`]*)\1|([A-Za-z_$][\w$.]*))/.exec(text.slice(i));
      if (first) { out.push(`${m[1].toUpperCase()} ${first[2] ?? first[3]}`); }
    }
    return out;
  }

  it('no route answers to a request that would write to a controller: only reads, watch leases, setup and the daemon\'s own controls', () => {
    expect(routesIn('app.post<{ Params: { id: string }; Body: Array<X> }>(\'/v0/a/:id\', h); app.get(SOME_PATH, h); app.put  (`/v0/b`, h)'))
      .toEqual(['POST /v0/a/:id', 'GET SOME_PATH', 'PUT /v0/b']);
    const registered = files.flatMap(file => routesIn(withoutComments(readFileSync(file, 'utf8'))));
    // Under a controller's path: reads, the two watch leases, and its removal from the daemon. A route added here is a
    // route that reaches a controller: this list is where it has to be justified.
    expect(registered.filter(r => r.includes('/controllers/:id')).sort()).toEqual([
      'DELETE /v0/controllers/:id',
      'GET /v0/controllers/:id',
      'GET /v0/controllers/:id/events',
      'GET /v0/controllers/:id/io/signals',
      'GET /v0/controllers/:id/rapid/tasks/:task/modules/:module',
      'POST /v0/controllers/:id/io/watch',
      'POST /v0/controllers/:id/motion/watch',
    ]);
    // Everything else: the list, adding a controller, setup (discovery and its saved settings, the passport), the
    // stream, health, and the daemon's own controls (shutdown, recording, replay).
    expect(registered.filter(r => !r.includes('/controllers/:id')).sort()).toEqual([
      'DELETE /v0/setup/discover/saved',
      'DELETE /v0/setup/discover/saved/manual',
      'DELETE /v0/setup/discover/saved/ports',
      'DELETE /v0/setup/discover/saved/ranges',
      'GET HEALTH_PATH',
      'GET RECORDING_PATH',
      'GET REPLAY_PATH',
      'GET /v0/controllers',
      'GET /v0/setup/discover/saved',
      'GET /v0/stream',
      'POST RECORDING_START_PATH',
      'POST RECORDING_STOP_PATH',
      'POST REPLAY_CONTROL_PATH',
      'POST SHUTDOWN_PATH',
      'POST /v0/controllers',
      'POST /v0/setup/discover',
      'POST /v0/setup/passport',
      'PUT /v0/setup/discover/saved',
    ].sort());
    expect(registered.filter(r => /access|mastership|rmmp/i.test(r))).toEqual([]);
  });
});

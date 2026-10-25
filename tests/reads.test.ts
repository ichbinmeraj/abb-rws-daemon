import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RobotState } from 'abb-rws-client';
import type { ControllerConfig } from '../src/config.js';
import { ControllerFleet, MODULE_KINDS_CACHE_MS } from '../src/fleet.js';
import { READ_BURST, READ_RATE_PER_S, ReadLimitError } from '../src/readBudget.js';
import { registerControllerRoutes } from '../src/routes.js';
import { READ_CACHE_MS, READS_IN_FLIGHT_MAX, TOKEN_HEADER } from '../src/schema/v0.js';
import { createServer } from '../src/server.js';

/** The daemon's access token in these tests. */
const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const RW7_ID = '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}';
const ID = 'irb1600-6-120-1';
const T0 = Date.parse('2026-09-29T12:00:00Z');
const SECRET = 'hunter2-not-robotics';

const cfg = (): ControllerConfig => ({
  id: ID, name: 'IRB1600_6_120_1', host: '127.0.0.1', port: 9403, useHttps: true,
  username: 'Default User', password: SECRET, systemId: RW7_ID,
});

const LISTING = [{ name: 'BASE', type: 'SysMod' }, { name: 'MainModule', type: 'ProgMod' }, { name: 'Other', type: 'ProgMod' }];

/**
 * A controller's manager, reduced to what reads on demand touch. Every
 * request is counted while it is out; while `gate` is set each one waits for
 * it, and each takes `requestMs` besides.
 */
function fakeManager() {
  const m = {
    texts: [] as string[],
    listings: [] as string[],
    searches: [] as object[],
    /** Every request as it ended, in order. */
    log: [] as string[],
    out: 0,
    maxOut: 0,
    gate: null as Promise<void> | null,
    requestMs: 0,
    currentPort: 9403 as number | undefined,
    currentUseHttps: true as boolean | undefined,
    state: {
      connected: true, quality: 'live', qualityReason: 'x', identity: null,
      systemInfo: { name: 'x', rwVersion: '7.21.0', sysid: RW7_ID, startTime: '', options: [] },
      tasks: [], mechunits: [], execstate: null,
      modulesByTask: { T_ROB1: ['BASE', 'MainModule', 'Other'] },
      ioSignals: [{ name: 'do_a', type: 'DO', value: '0', lvalue: '0' }], ioSignalsLoaded: true,
    } as unknown as RobotState,
    request: async <T>(what: string, value: () => T): Promise<T> => {
      m.out++;
      m.maxOut = Math.max(m.maxOut, m.out);
      try {
        if (m.gate) { await m.gate; }
        if (m.requestMs > 0) { await new Promise(res => setTimeout(res, m.requestMs)); }
        m.log.push(what);
        return value();
      } finally {
        m.out--;
      }
    },
    getModuleText: (task: string, module: string) => {
      m.texts.push(`${task}/${module}`);
      return m.request(`text:${module}`, () => ({ text: `MODULE ${module}\nENDMODULE`, changeCount: 3 }));
    },
    listModulesDetailed: (task: string) => {
      m.listings.push(task);
      return m.request(`listing:${task}`, () => LISTING.map(x => ({ ...x })));
    },
    searchSignals: (criteria: object) => {
      m.searches.push(criteria);
      return m.request('search', () => [{ name: 'do_found', type: 'DO', value: '0', lvalue: '0' }]);
    },
  };
  return m;
}

/** A gate the test opens by hand. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(res => { open = res; });
  return { promise, open };
}

let fleet: ControllerFleet | null = null;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fleetWith(manager: ReturnType<typeof fakeManager>, fakeTime = true): ControllerFleet {
  if (fakeTime) {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  }
  fleet = new ControllerFleet([cfg()], silent);
  // Route the fleet's reads to the fake instead of a real session.
  (fleet as unknown as { managerOf: () => unknown }).managerOf = () => manager;
  return fleet;
}
afterEach(() => { fleet = null; vi.useRealTimers(); });

/** Let every promise that can settle now settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('module source on the read budget', () => {
  it(`at most ${READS_IN_FLIGHT_MAX} reads out at a time: one more is refused and never reaches the controller`, async () => {
    const mgr = fakeManager();
    const g = gate();
    mgr.gate = g.promise;
    const f = fleetWith(mgr);
    const a = f.moduleSource(ID, 'T_ROB1', 'MainModule');
    const b = f.moduleSource(ID, 'T_ROB1', 'Other');
    await settle();
    const refused = await f.moduleSource(ID, 'T_ROB1', 'BASE').catch(e => e);
    expect(refused).toBeInstanceOf(ReadLimitError);
    expect(refused).toMatchObject({ controller: ID, limit: 'in-flight', retryAfterS: 1 });
    expect(mgr.texts).toEqual(['T_ROB1/MainModule', 'T_ROB1/Other']);
    g.open();
    expect(await a).toMatchObject({ module: 'MainModule', kind: 'program', changeCount: 3 });
    expect(await b).toMatchObject({ module: 'Other', kind: 'program' });
    expect(mgr.maxOut).toBeLessThanOrEqual(READS_IN_FLIGHT_MAX);
  });

  it('the same module asked many times at once is read once; the answer is served from memory for READ_CACHE_MS', async () => {
    const mgr = fakeManager();
    const g = gate();
    mgr.gate = g.promise;
    const f = fleetWith(mgr);
    const asks = Array.from({ length: 8 }, () => f.moduleSource(ID, 'T_ROB1', 'MainModule'));
    await settle();
    g.open();
    const answers = await Promise.all(asks);
    expect(answers.every(x => x!.text === 'MODULE MainModule\nENDMODULE' && x!.kind === 'program')).toBe(true);
    expect(mgr.texts).toEqual(['T_ROB1/MainModule']);
    expect(mgr.listings).toEqual(['T_ROB1']);
    // Each caller gets its own copy: nothing one does to it reaches another.
    answers[0]!.text = 'changed by a caller';
    await vi.advanceTimersByTimeAsync(READ_CACHE_MS - 1);
    expect((await f.moduleSource(ID, 'T_ROB1', 'MainModule'))!.text).toBe('MODULE MainModule\nENDMODULE');
    expect(mgr.texts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await f.moduleSource(ID, 'T_ROB1', 'MainModule');
    expect(mgr.texts).toHaveLength(2);
    expect(mgr.listings).toHaveLength(1);   // the kinds are kept longer: only the text is read again
  });

  it('the task`s module listing is read once: a later module of the task costs one request', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    expect(await f.moduleSource(ID, 'T_ROB1', 'MainModule')).toMatchObject({ kind: 'program' });
    expect(await f.moduleSource(ID, 'T_ROB1', 'BASE')).toMatchObject({ kind: 'system' });
    expect(await f.moduleSource(ID, 'T_ROB1', 'Other')).toMatchObject({ kind: 'program' });
    expect(mgr.log).toEqual(['text:MainModule', 'listing:T_ROB1', 'text:BASE', 'text:Other']);
  });

  it('a module loaded or unloaded, or a new connection, and nothing kept counts any more', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    await f.moduleSource(ID, 'T_ROB1', 'MainModule');
    (mgr.state as unknown as { modulesByTask: Record<string, string[]> }).modulesByTask.T_ROB1 = ['BASE', 'MainModule', 'Other', 'NewMod'];
    await f.moduleSource(ID, 'T_ROB1', 'MainModule');   // at once: the answer kept a moment ago no longer counts
    expect(mgr.texts).toHaveLength(2);
    expect(mgr.listings).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);   // the rate: two requests back
    mgr.currentPort = 9404;   // the VC re-bound; the client followed it
    await f.moduleSource(ID, 'T_ROB1', 'MainModule');
    expect(mgr.texts).toHaveLength(3);
    expect(mgr.listings).toHaveLength(3);
  });

  it(`the kinds are kept at most ${MODULE_KINDS_CACHE_MS / 1000} s even while nothing changes`, async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    await f.moduleSource(ID, 'T_ROB1', 'MainModule');
    await vi.advanceTimersByTimeAsync(MODULE_KINDS_CACHE_MS);
    await f.moduleSource(ID, 'T_ROB1', 'Other');
    expect(mgr.listings).toHaveLength(2);
  });

  it('a failed listing leaves the kind unknown and is not kept', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    const real = mgr.listModulesDetailed;
    mgr.listModulesDetailed = async () => { throw new Error('busy'); };
    expect(await f.moduleSource(ID, 'T_ROB1', 'MainModule')).toMatchObject({ kind: null, text: 'MODULE MainModule\nENDMODULE' });
    mgr.listModulesDetailed = real;
    expect(await f.moduleSource(ID, 'T_ROB1', 'Other')).toMatchObject({ kind: 'program' });
  });

  it(`a caller reading module after module is held to a burst of ${READ_BURST} requests, then ${READ_RATE_PER_S} a second`, async () => {
    const mgr = fakeManager();
    (mgr.state as unknown as { modulesByTask: Record<string, string[]> }).modulesByTask.T_ROB1 = ['A', 'B', 'C', 'D'];
    const f = fleetWith(mgr);
    await f.moduleSource(ID, 'T_ROB1', 'A');   // text and listing: 2
    await f.moduleSource(ID, 'T_ROB1', 'B');   // text: 1
    await f.moduleSource(ID, 'T_ROB1', 'C');   // text: 1
    await expect(f.moduleSource(ID, 'T_ROB1', 'D')).rejects.toMatchObject({ limit: 'rate', retryAfterS: 1 });
    await vi.advanceTimersByTimeAsync(1_000 / READ_RATE_PER_S);
    expect(await f.moduleSource(ID, 'T_ROB1', 'D')).toMatchObject({ module: 'D' });
  });
});

describe('signal search on the read budget', () => {
  it('identical searches at once are one read, whatever the order of their criteria; the answer is kept READ_CACHE_MS', async () => {
    const mgr = fakeManager();
    const g = gate();
    mgr.gate = g.promise;
    const f = fleetWith(mgr);
    const a = f.searchIoSignals(ID, { type: 'DO', name: 'do' });
    const b = f.searchIoSignals(ID, { name: 'do', type: 'DO' });
    await settle();
    g.open();
    expect(await a).toEqual([{ name: 'do_found', type: 'DO', value: '0', lvalue: '0' }]);
    expect(await b).toEqual(await a);
    expect(mgr.searches).toHaveLength(1);
    await f.searchIoSignals(ID, { name: 'do', type: 'DO' });
    expect(mgr.searches).toHaveLength(1);
    await f.searchIoSignals(ID, { name: 'di', type: 'DO' });   // another search is another read
    expect(mgr.searches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(READ_CACHE_MS);
    await f.searchIoSignals(ID, { name: 'do', type: 'DO' });
    expect(mgr.searches).toHaveLength(3);
  });

  it('the full table comes from memory and is served while the budget has no room', async () => {
    const mgr = fakeManager();
    mgr.gate = gate().promise;   // never opened
    const f = fleetWith(mgr);
    void f.searchIoSignals(ID, { type: 'DO' });
    void f.searchIoSignals(ID, { type: 'DI' });
    await settle();
    await expect(f.searchIoSignals(ID, { type: 'AO' })).rejects.toBeInstanceOf(ReadLimitError);
    expect(await f.searchIoSignals(ID, {})).toEqual([{ name: 'do_a', type: 'DO', value: '0', lvalue: '0' }]);
    expect(await f.searchIoSignals(ID, { name: '' })).toHaveLength(1);   // empty criteria are no search
    expect(mgr.searches).toHaveLength(2);
  });

  it('module sources and searches share one budget per controller', async () => {
    const mgr = fakeManager();
    mgr.gate = gate().promise;
    const f = fleetWith(mgr);
    void f.moduleSource(ID, 'T_ROB1', 'MainModule');
    void f.searchIoSignals(ID, { type: 'DO' });
    await settle();
    await expect(f.moduleSource(ID, 'T_ROB1', 'Other')).rejects.toMatchObject({ limit: 'in-flight' });
    await expect(f.searchIoSignals(ID, { type: 'DI' })).rejects.toMatchObject({ limit: 'in-flight' });
  });
});

describe('no caller can flood a controller through the daemon', () => {
  it('a caller firing a new search every 10 ms for 5 s: 2 out at most, and the controller sees a burst plus 2 a second', async () => {
    const mgr = fakeManager();
    mgr.requestMs = 100;
    const f = fleetWith(mgr);
    let refused = 0;
    let answered = 0;
    for (let i = 0; i < 500; i++) {
      f.searchIoSignals(ID, { name: `sig_${i}` }).then(() => { answered++; }, e => {
        if (e instanceof ReadLimitError) { refused++; } else { throw e; }
      });
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mgr.maxOut).toBeLessThanOrEqual(READS_IN_FLIGHT_MAX);
    expect(mgr.searches.length).toBeLessThanOrEqual(READ_BURST + READ_RATE_PER_S * 5);
    expect(mgr.searches.length).toBeGreaterThanOrEqual(READ_RATE_PER_S * 5);   // held back, not shut out
    expect(answered).toBe(mgr.searches.length);
    expect(refused).toBe(500 - answered);
  });

  it('while reads on demand are held back, the I/O poller`s reads go on', async () => {
    const mgr = fakeManager();
    const reads: string[] = [];
    Object.assign(mgr, {
      readIoSignal: async (_n: string, _d: string, name: string) => { reads.push(name); return { name, value: '1', lvalue: '1', type: 'DO' }; },
      onSubscriptionEvent: () => () => {},
      subscriptionGroupPath: undefined,
    });
    mgr.gate = gate().promise;   // reads on demand never come back
    const f = fleetWith(mgr);
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    for (let i = 0; i < 50; i++) { f.searchIoSignals(ID, { name: `x${i}` }).catch(() => {}); }
    await vi.advanceTimersByTimeAsync(2_000);
    f.stopIoPoller();
    expect(mgr.searches).toHaveLength(READS_IN_FLIGHT_MAX);
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(f.get(ID)!.io.signals[0]).toMatchObject({ name: 'do_a', value: '1', via: 'poll' });
  });
});

describe('a controller being removed', () => {
  it('its reads on demand finish before the logout, start no second request, and no new one starts', async () => {
    const mgr = fakeManager();
    const g = gate();
    mgr.gate = g.promise;
    const f = fleetWith(mgr);
    const multi = (f as unknown as { multi: { disconnectRobot: (id: string) => Promise<void> } }).multi;
    const realDisconnect = multi.disconnectRobot.bind(multi);
    multi.disconnectRobot = async (id: string) => { mgr.log.push('logout'); return realDisconnect(id); };
    const read = f.moduleSource(ID, 'T_ROB1', 'MainModule');
    await settle();
    const removing = f.remove(ID);
    await settle();
    expect(await f.moduleSource(ID, 'T_ROB1', 'Other')).toBeNull();
    expect(await f.searchIoSignals(ID, { type: 'DO' })).toBeNull();
    expect(mgr.log).toEqual([]);   // the logout waits for the read out
    g.open();
    expect(await read).toMatchObject({ module: 'MainModule', kind: null });   // the listing would queue behind the logout
    await removing;
    expect(mgr.log).toEqual(['text:MainModule', 'logout']);
    expect(mgr.listings).toEqual([]);
    expect(await f.moduleSource(ID, 'T_ROB1', 'MainModule')).toBeNull();
  });

  it('an id added again starts with nothing kept', async () => {
    const mgr = fakeManager();
    const f = fleetWith(mgr);
    await f.moduleSource(ID, 'T_ROB1', 'MainModule');
    await f.remove(ID);
    // Added again without connecting (add() would start a connect).
    (f as unknown as { addToManager: (c: ControllerConfig) => void }).addToManager(cfg());
    await f.moduleSource(ID, 'T_ROB1', 'MainModule');
    expect(mgr.texts).toHaveLength(2);
    expect(mgr.listings).toHaveLength(2);
  });
});

describe('over HTTP', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  const LOCAL = { host: '127.0.0.1:7810', [TOKEN_HEADER]: TOKEN };
  const url = (module: string) => `/v0/controllers/${ID}/rapid/tasks/T_ROB1/modules/${module}`;

  async function serve(mgr: ReturnType<typeof fakeManager>) {
    const f = fleetWith(mgr, false);
    app = createServer({ accessToken: TOKEN });
    await registerControllerRoutes(app, { fleet: f, discover: async () => ({ entries: [], notes: [] }), readPassport: async () => { throw new Error('not here'); } });
    return app;
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) { await new Promise(res => setTimeout(res, 5)); }
    expect(cond()).toBe(true);
  }

  it('429 READ_LIMIT with a Retry-After once two reads are out; the same module asked again shares a read', async () => {
    const mgr = fakeManager();
    const g = gate();
    mgr.gate = g.promise;
    const server = await serve(mgr);
    const a = server.inject({ method: 'GET', url: url('MainModule'), headers: LOCAL });
    const b = server.inject({ method: 'GET', url: url('Other'), headers: LOCAL });
    await until(() => mgr.texts.length === 2);
    const again = server.inject({ method: 'GET', url: url('MainModule'), headers: LOCAL });
    const refused = await server.inject({ method: 'GET', url: url('BASE'), headers: LOCAL });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
    expect(refused.json()).toEqual({
      error: `"${ID}" already has ${READS_IN_FLIGHT_MAX} on-demand reads in flight, the most it takes at a time; try again in 1 s`,
      code: 'READ_LIMIT',
    });
    expect(refused.body).not.toContain(SECRET);
    const search = await server.inject({ method: 'GET', url: `/v0/controllers/${ID}/io/signals?type=DO`, headers: LOCAL });
    expect(search.statusCode).toBe(429);
    expect(search.json().code).toBe('READ_LIMIT');
    const table = await server.inject({ method: 'GET', url: `/v0/controllers/${ID}/io/signals`, headers: LOCAL });
    expect(table.statusCode).toBe(200);
    g.open();
    const [ra, rb, rAgain] = await Promise.all([a, b, again]);
    expect([ra.statusCode, rb.statusCode, rAgain.statusCode]).toEqual([200, 200, 200]);
    expect(rAgain.json()).toEqual(ra.json());
    expect(ra.json()).toEqual({ task: 'T_ROB1', module: 'MainModule', kind: 'program', text: 'MODULE MainModule\nENDMODULE', changeCount: 3 });
    expect(mgr.texts).toEqual(['T_ROB1/MainModule', 'T_ROB1/Other']);
  });
});

import { describe, it, expect } from 'vitest';
import { MultiRobotManager, RobotManager, RwsError } from 'abb-rws-client';
import type { CallTarget } from '../src/schema/recording.js';
import type { ClientTapSink, PendingCall, TappedManagerView } from '../src/recording/contract.js';
import { ClientTap, isListenerMethod, liveSink, multiCallId, tapFunction, tapObject } from '../src/recording/tap.js';

/** One call as a sink saw it: what it was told at the start, and the outcome once it settled. */
interface SeenCall {
  target: CallTarget;
  id: string | null;
  method: string;
  args: readonly unknown[];
  /** The arguments as JSON when the sink was told (what a recorder masks at that moment). */
  argsAtStart: string;
  outcome?: { ok: true; result: unknown } | { ok: false; error: unknown };
}

/** A sink that keeps everything it is told; `active` may be switched off, and any part may be made to throw. */
class FakeSink implements ClientTapSink {
  active = true;
  calls: SeenCall[] = [];
  states: Array<{ id: string; manager: TappedManagerView | null }> = [];
  subs: Array<{ id: string; event: unknown }> = [];
  /** Shared with the fake controller objects, to see the order of things. */
  order: string[] = [];
  throwOnCall = false;
  throwOnDone = false;
  /** Answer null from `call` (the recording does not record calls). */
  declineCalls = false;

  call(target: CallTarget, id: string | null, method: string, args: readonly unknown[]): PendingCall | null {
    if (this.throwOnCall) { throw new Error('sink failed at the start'); }
    this.order.push(`sink:${method}`);
    if (this.declineCalls) { return null; }
    const seen: SeenCall = { target, id, method, args, argsAtStart: JSON.stringify(args) };
    this.calls.push(seen);
    return {
      done: outcome => {
        if (this.throwOnDone) { throw new Error('sink failed at the end'); }
        this.order.push(`settled:${method}`);
        seen.outcome = outcome;
      },
    };
  }
  state(id: string, manager: TappedManagerView | null): void { this.states.push({ id, manager }); }
  sub(id: string, event: unknown): void { this.subs.push({ id, event: event as never }); }
}

/** A controller's manager, as small as these tests need: sync and async methods, a getter, a private field, a listener. */
class FakeManager {
  readonly #session = 'held privately';
  order: string[] = [];
  listeners: Array<(e: unknown) => void> = [];
  currentPort: number | undefined = 9403;
  private readonly inner = { quality: 'live' };

  get state(): { quality: string } { return this.inner; }
  get subscriptionGroupPath(): string | undefined { return undefined; }

  async read(name: string): Promise<{ name: string; value: number }> {
    this.order.push(`read:${name}`);
    return { name, value: 7 };
  }
  async refuse(): Promise<never> {
    this.order.push('refuse');
    throw new RwsError('HTTP 403 - not allowed', 'GRANT_DENIED');
  }
  add(a: number, b: number): number { this.order.push('add'); return a + b; }
  explode(): never { this.order.push('explode'); throw new RwsError('bad argument', 'INVALID_ARGUMENT'); }
  /** Calls another method of its own: the client's internal calls are not the daemon's. */
  async outer(x: string): Promise<string> {
    this.order.push('outer');
    const r = await this.read(x);
    return `${r.name}:${this.helper()}`;
  }
  helper(): string { this.order.push('helper'); return 'h'; }
  whoAmI(): unknown { return this; }
  secret(): string { return this.#session; }
  /** Changes its argument once it runs (the sink was told before). */
  mutate(o: { n: number }): number { o.n = 99; return o.n; }
  onSubscriptionEvent(fn: (e: unknown) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }
  offEverything(): void { this.listeners = []; }
  fire(e: unknown): void { for (const l of this.listeners) { l(e); } }
}

const tapped = (sink: FakeSink | (() => FakeSink | null), id = 'rw7') => {
  const real = new FakeManager();
  const tap = new ClientTap(sink);
  return { real, tap, view: tap.manager(real, id) };
};

describe('the tap reports each call, and changes nothing about it', () => {
  it('an async result: reported at the start and when it settles; the caller gets the method`s own promise', async () => {
    const sink = new FakeSink();
    const { real, view } = tapped(sink);
    const originalRead = FakeManager.prototype.read;
    let returned: Promise<unknown> | null = null;
    real.read = function (this: FakeManager, name: string) { returned = originalRead.call(this, name); return returned as never; };
    const p = view.read('do_a');
    expect(p).toBe(returned);
    expect(await p).toEqual({ name: 'do_a', value: 7 });
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({ target: 'manager', id: 'rw7', method: 'read', args: ['do_a'] });
    expect(sink.calls[0].outcome).toEqual({ ok: true, result: { name: 'do_a', value: 7 } });
  });

  it('a typed error: the caller gets the very error the client threw, and the sink is told it', async () => {
    const sink = new FakeSink();
    const { view } = tapped(sink);
    const err = await view.refuse().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect((err as RwsError).code).toBe('GRANT_DENIED');
    expect(sink.calls[0].outcome).toEqual({ ok: false, error: err });
    expect((sink.calls[0].outcome as { error: unknown }).error).toBe(err);
  });

  it('a sync result and a sync throw are reported at once, and handed back as they are', () => {
    const sink = new FakeSink();
    const { view } = tapped(sink);
    expect(view.add(2, 3)).toBe(5);
    expect(sink.calls[0]).toMatchObject({ method: 'add', args: [2, 3], outcome: { ok: true, result: 5 } });
    let thrown: unknown = null;
    try { view.explode(); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RwsError);
    expect((thrown as RwsError).code).toBe('INVALID_ARGUMENT');
    expect(sink.calls[1].outcome).toEqual({ ok: false, error: thrown });
  });

  it('the sink is told before the method runs, and the outcome before the caller goes on', async () => {
    const sink = new FakeSink();
    const { real, view } = tapped(sink);
    real.order = sink.order;   // one list for both
    await view.read('x');
    sink.order.push('caller');
    expect(sink.order).toEqual(['sink:read', 'read:x', 'settled:read', 'caller']);
  });

  it('the sink sees the arguments as they were at the start, in a frozen list of its own', () => {
    const sink = new FakeSink();
    const { view } = tapped(sink);
    const arg = { n: 1 };
    expect(view.mutate(arg)).toBe(99);
    expect(sink.calls[0].argsAtStart).toBe('[{"n":1}]');
    expect(Object.isFrozen(sink.calls[0].args)).toBe(true);
    expect(sink.calls[0].args[0]).toBe(arg);   // the caller's own value, shown, never copied into the call
  });
});

describe('the real object, not the view, runs every method', () => {
  it('`this` is the real object: its internal calls are not reported, and its private fields work', async () => {
    const sink = new FakeSink();
    const { real, view } = tapped(sink);
    expect(await view.outer('do_b')).toBe('do_b:h');
    expect(sink.calls.map(c => c.method)).toEqual(['outer']);
    expect(real.order).toEqual(['outer', 'read:do_b', 'helper']);
    expect(view.whoAmI()).toBe(real);
    expect(view.secret()).toBe('held privately');
  });

  it('a method called with another `this` still runs on the real object', () => {
    const sink = new FakeSink();
    const { real, view } = tapped(sink);
    expect(view.whoAmI.call({})).toBe(real);
  });

  it('instanceof holds for the fake and for the client`s own classes', () => {
    const sink = new FakeSink();
    const tap = new ClientTap(sink);
    expect(tap.manager(new FakeManager(), 'a')).toBeInstanceOf(FakeManager);
    expect(tap.manager(new RobotManager(), 'a')).toBeInstanceOf(RobotManager);
    expect(tap.multi(new MultiRobotManager())).toBeInstanceOf(MultiRobotManager);
  });

  it('property reads and writes pass through: the state getter, the port, a field set through the view', () => {
    const sink = new FakeSink();
    const { real, view } = tapped(sink);
    expect(view.state).toBe(real.state);
    expect(view.currentPort).toBe(9403);
    expect(view.subscriptionGroupPath).toBeUndefined();
    view.currentPort = 9404;
    expect(real.currentPort).toBe(9404);
    expect('read' in view).toBe(true);
    expect(sink.calls).toEqual([]);
  });

  it('the client`s real manager reads through the view as itself (getters on the real object)', () => {
    const sink = new FakeSink();
    const real = new RobotManager();
    const view = new ClientTap(sink).manager(real, 'rw7');
    expect(view.state).toBe(real.state);
    expect(view.currentPort).toBe(real.currentPort);
    expect(view.subscriptionGroupPath).toBe(real.subscriptionGroupPath);
    expect(sink.calls).toEqual([]);
  });
});

describe('listener registrations pass through, unreported', () => {
  it('on* registers on the real object; the listener gets its events; the remover works; off* likewise', () => {
    const sink = new FakeSink();
    const { real, view } = tapped(sink);
    const got: unknown[] = [];
    const untap = view.onSubscriptionEvent(e => got.push(e));
    expect(real.listeners).toHaveLength(1);
    real.fire({ resource: 'x', value: '1' });
    expect(got).toEqual([{ resource: 'x', value: '1' }]);
    untap();
    expect(real.listeners).toHaveLength(0);
    view.onSubscriptionEvent(() => {});
    view.offEverything();
    expect(real.listeners).toHaveLength(0);
    expect(sink.calls).toEqual([]);
  });

  it('names: on/off followed by a capital are listeners; anything else is a call', () => {
    expect(isListenerMethod('onSubscriptionEvent')).toBe(true);
    expect(isListenerMethod('offAccessEvent')).toBe(true);
    expect(isListenerMethod('onError')).toBe(true);
    expect(isListenerMethod('online')).toBe(false);
    expect(isListenerMethod('offset')).toBe(false);
    expect(isListenerMethod('getOnline')).toBe(false);
  });
});

describe('no sink, or one that has ended: a plain pass-through', () => {
  it('a sink switched off (the recording ended) is told nothing; the method runs as before', async () => {
    const sink = new FakeSink();
    const { real, view } = tapped(sink);
    sink.active = false;
    expect(await view.read('a')).toEqual({ name: 'a', value: 7 });
    expect(view.add(1, 1)).toBe(2);
    expect(real.order).toEqual(['read:a', 'add']);
    expect(sink.calls).toEqual([]);
    sink.active = true;
    view.add(1, 2);
    expect(sink.calls.map(c => c.method)).toEqual(['add']);
  });

  it('a sink function is asked at each call: none, then one, then another, then none', () => {
    let current: FakeSink | null = null;
    const { view } = tapped(() => current);
    view.add(0, 1);
    const first = new FakeSink();
    current = first;
    view.add(0, 2);
    const second = new FakeSink();
    current = second;
    view.add(0, 3);
    current = null;
    view.add(0, 4);
    expect(first.calls.map(c => c.args)).toEqual([[0, 2]]);
    expect(second.calls.map(c => c.args)).toEqual([[0, 3]]);
  });

  it('a call the sink declines (null) runs untouched', () => {
    const sink = new FakeSink();
    sink.declineCalls = true;
    const { view } = tapped(sink);
    expect(view.add(4, 4)).toBe(8);
    expect(sink.calls).toEqual([]);
  });

  it('liveSink: set and active, else null; a sink whose `active` throws is none', () => {
    const sink = new FakeSink();
    expect(liveSink(sink)).toBe(sink);
    expect(liveSink(() => sink)).toBe(sink);
    expect(liveSink(null)).toBeNull();
    expect(liveSink(() => null)).toBeNull();
    sink.active = false;
    expect(liveSink(sink)).toBeNull();
    const broken = { get active(): boolean { throw new Error('x'); } } as unknown as ClientTapSink;
    expect(liveSink(broken)).toBeNull();
    expect(liveSink(() => { throw new Error('y'); })).toBeNull();
  });
});

describe('a failing sink never changes a call', () => {
  it('a throw at the start: the method runs once, its result handed back', async () => {
    const sink = new FakeSink();
    sink.throwOnCall = true;
    const { real, view } = tapped(sink);
    expect(await view.read('a')).toEqual({ name: 'a', value: 7 });
    expect(view.add(2, 2)).toBe(4);
    expect(real.order).toEqual(['read:a', 'add']);
  });

  it('a throw at the end: results and errors handed back unchanged, no unhandled rejection', async () => {
    const sink = new FakeSink();
    sink.throwOnDone = true;
    const { view } = tapped(sink);
    expect(await view.read('a')).toEqual({ name: 'a', value: 7 });
    expect(view.add(2, 2)).toBe(4);
    const err = await view.refuse().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(() => view.explode()).toThrow(RwsError);
  });
});

describe('views are made once', () => {
  it('the same manager gives the same view; a method read twice is the same function', () => {
    const sink = new FakeSink();
    const tap = new ClientTap(sink);
    const real = new FakeManager();
    const view = tap.manager(real, 'rw7');
    expect(tap.manager(real, 'rw7')).toBe(view);
    expect(view.read).toBe(view.read);
    expect(view.onSubscriptionEvent).toBe(view.onSubscriptionEvent);
    expect(tap.manager(new FakeManager(), 'rw7')).not.toBe(view);
    const multi = new MultiRobotManager();
    expect(tap.multi(multi)).toBe(tap.multi(multi));
  });

  it('a manager under another id gets a view reporting that id', () => {
    const sink = new FakeSink();
    const tap = new ClientTap(sink);
    const real = new FakeManager();
    tap.manager(real, 'a').add(1, 1);
    tap.manager(real, 'b').add(1, 1);
    expect(sink.calls.map(c => c.id)).toEqual(['a', 'b']);
  });

  it('a method replaced on the real object after the view was made is the one that runs', () => {
    const sink = new FakeSink();
    const { real, view } = tapped(sink);
    view.add(1, 1);
    real.add = () => 42;
    expect(view.add(1, 1)).toBe(42);
    expect(sink.calls.map(c => c.outcome)).toEqual([{ ok: true, result: 2 }, { ok: true, result: 42 }]);
  });

  it('a frozen own method is handed back as it is', () => {
    const sink = new FakeSink();
    const frozen = Object.freeze({ ping: () => 'pong' });
    const view = tapObject(frozen, { target: 'manager', id: 'x', sink });
    expect(view.ping).toBe(frozen.ping);
    expect(view.ping()).toBe('pong');
  });

  it('Object.prototype methods and the constructor are not calls', () => {
    const sink = new FakeSink();
    const { view } = tapped(sink);
    expect(view.constructor).toBe(FakeManager);
    expect(typeof view.toString()).toBe('string');
    expect(Object.prototype.hasOwnProperty.call(view, 'currentPort')).toBe(true);
    expect(sink.calls).toEqual([]);
  });
});

describe('the MultiRobotManager view', () => {
  it('reports target `multi` and the controller each call is about', async () => {
    const sink = new FakeSink();
    const calls: string[] = [];
    const multi = {
      addRobot(cfg: { id: string; password: string }) { calls.push(`add:${cfg.id}`); },
      updateConfig(id: string, _patch: object) { calls.push(`update:${id}`); },
      async connectRobot(id: string) { calls.push(`connect:${id}`); },
      async disconnectRobot(id: string) { calls.push(`disconnect:${id}`); },
      removeRobot(id: string) { calls.push(`remove:${id}`); },
      listNothing() { return []; },
    };
    const view = new ClientTap(sink).multi(multi);
    view.addRobot({ id: 'rw8', password: 'not-this-test' });
    view.updateConfig('rw8', { expectedSystemId: 'x' });
    await view.connectRobot('rw8');
    await view.disconnectRobot('rw8');
    view.removeRobot('rw8');
    view.listNothing();
    expect(calls).toEqual(['add:rw8', 'update:rw8', 'connect:rw8', 'disconnect:rw8', 'remove:rw8']);
    expect(sink.calls.map(c => [c.target, c.id, c.method])).toEqual([
      ['multi', 'rw8', 'addRobot'], ['multi', 'rw8', 'updateConfig'], ['multi', 'rw8', 'connectRobot'],
      ['multi', 'rw8', 'disconnectRobot'], ['multi', 'rw8', 'removeRobot'], ['multi', null, 'listNothing'],
    ]);
    // The arguments reach the sink as given: masking them is the recorder's job, at this moment.
    expect(sink.calls[0].args).toEqual([{ id: 'rw8', password: 'not-this-test' }]);
  });

  it('multiCallId: a string first argument, or its object`s string id; else null', () => {
    expect(multiCallId(['rw7'])).toBe('rw7');
    expect(multiCallId([{ id: 'rw8', host: 'h' }])).toBe('rw8');
    expect(multiCallId([{ id: 3 }])).toBeNull();
    expect(multiCallId([])).toBeNull();
    expect(multiCallId([null])).toBeNull();
    const hostile = { get id(): string { throw new Error('no'); } };
    expect(multiCallId([hostile])).toBeNull();
  });
});

describe('tapFunction (setup steps)', () => {
  it('reports target `setup` with no controller; result, `this`, name and length kept', async () => {
    const sink = new FakeSink();
    async function discover(this: unknown, request: object, configured: object[]) {
      return { self: this, request, n: configured.length };
    }
    const wrapped = tapFunction(discover, { target: 'setup', method: 'discover', sink });
    expect(wrapped.name).toBe('discover');
    expect(wrapped.length).toBe(2);
    const self = { deps: true };
    const answer = await wrapped.call(self, { hosts: [] }, [{ id: 'rw7', password: 'p' }]);
    expect(answer).toEqual({ self, request: { hosts: [] }, n: 1 });
    expect(sink.calls[0]).toMatchObject({ target: 'setup', id: null, method: 'discover' });
    expect(sink.calls[0].args).toEqual([{ hosts: [] }, [{ id: 'rw7', password: 'p' }]]);
    expect(sink.calls[0].outcome).toEqual({ ok: true, result: answer });
  });

  it('errors are handed back as thrown; a sink function made once at startup follows the recordings', async () => {
    let current: FakeSink | null = null;
    const passport = tapFunction(async (_target: object) => { throw new RwsError('HTTP 401 - unauthorized', 'AUTH_FAILED'); },
      { target: 'setup', method: 'readPassport', sink: () => current });
    expect(await passport({}).catch((e: unknown) => (e as RwsError).code)).toBe('AUTH_FAILED');
    const sink = new FakeSink();
    current = sink;
    const err = await passport({ host: 'h' }).catch((e: unknown) => e);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].outcome).toEqual({ ok: false, error: err });
    sink.active = false;
    await passport({}).catch(() => null);
    expect(sink.calls).toHaveLength(1);
  });

  it('ClientTap.setup wraps a function as a setup step on its own sink', () => {
    const sink = new FakeSink();
    const read = new ClientTap(sink).setup((x: number) => x * 2, 'readPassport');
    expect(read(21)).toBe(42);
    expect(sink.calls.map(c => [c.target, c.method, c.outcome])).toEqual([['setup', 'readPassport', { ok: true, result: 42 }]]);
  });
});

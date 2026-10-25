import type { CallTarget } from '../schema/recording.js';
import type { ClientTapSink, PendingCall } from './contract.js';

/**
 * The fleet's tap on the client, for a recording: every client method the
 * daemon calls is reported to a sink (ClientTapSink) - when it begins, with
 * its arguments, and when it settles, with its result or error - and nothing
 * else changes. The tap is passive:
 *
 * - The method runs exactly as it would untapped: same arguments, same
 *   order, the real object as `this` (so the client's own internal calls are
 *   not reported), the same result or error object handed back - a promise
 *   is returned as the very promise the method returned.
 * - The sink is told of a call before the method runs (`sink.call`), so it
 *   masks the arguments - and learns the secret values among them - before
 *   anything else can happen to them. What it is shown is a frozen copy of the
 *   argument list; the values themselves are the caller's, never to be
 *   changed.
 * - Property reads (the manager's `state`, `currentPort`,
 *   `subscriptionGroupPath`) and listener registrations (`on...`, `off...`)
 *   pass straight through, unreported: they are not requests to a controller.
 * - With no sink, or one that has ended (`active` false), every call is a
 *   plain pass-through. A sink that throws is ignored: a recording never
 *   changes what the daemon does.
 */

/** Where a tap finds its sink: the sink itself, or a function giving the current one (null or undefined: none). */
export type SinkSource = ClientTapSink | (() => ClientTapSink | null | undefined);

/** A listener registration (`onSubscriptionEvent`, `offSomething`): passed through, never reported. */
const LISTENER_METHOD = /^(on|off)[A-Z]/;

/** Whether a method name is a listener registration, which the tap passes through unreported. */
export function isListenerMethod(name: string): boolean {
  return LISTENER_METHOD.test(name);
}

/**
 * The controller a MultiRobotManager call is about: every one the fleet makes
 * takes the controller's id first (`connectRobot(id)`, `updateConfig(id, …)`),
 * or its config (`addRobot({id, …})`). Null when neither.
 */
export function multiCallId(args: readonly unknown[]): string | null {
  const first = args[0];
  if (typeof first === 'string') { return first; }
  if (first !== null && typeof first === 'object') {
    let id: unknown;
    try { id = (first as { id?: unknown }).id; } catch { id = undefined; }
    if (typeof id === 'string') { return id; }
  }
  return null;
}

/** The sink to report to now: set and still active; null otherwise. Never throws. */
export function liveSink(source: SinkSource | null | undefined): ClientTapSink | null {
  try {
    const sink = typeof source === 'function' ? source() : source;
    return sink && sink.active ? sink : null;
  } catch {
    return null;
  }
}

type Outcome = { ok: true; result: unknown } | { ok: false; error: unknown };

function begin(
  sink: ClientTapSink, target: CallTarget, id: string | null, method: string, args: readonly unknown[],
): PendingCall | null {
  try {
    return sink.call(target, id, method, Object.freeze([...args])) ?? null;
  } catch {
    return null;
  }
}

function settle(pending: PendingCall, outcome: Outcome): void {
  try { pending.done(outcome); } catch { /* a recording never fails a call */ }
}

/**
 * Call `fn` on `self` with `args`, reporting the call to the current sink:
 * at its start, then its outcome once it settles (a promise's, or at once for
 * a value or a throw). Whatever `fn` returns or throws is handed back as is.
 */
function invoke(
  source: SinkSource, target: CallTarget, idOf: (args: readonly unknown[]) => string | null, method: string,
  fn: (...args: unknown[]) => unknown, self: unknown, args: unknown[],
): unknown {
  const sink = liveSink(source);
  if (!sink) { return Reflect.apply(fn, self, args); }
  let id: string | null = null;
  try { id = idOf(args); } catch { id = null; }
  const pending = begin(sink, target, id, method, args);
  if (!pending) { return Reflect.apply(fn, self, args); }
  let result: unknown;
  try {
    result = Reflect.apply(fn, self, args);
  } catch (error) {
    settle(pending, { ok: false, error });
    throw error;
  }
  if (result instanceof Promise) {
    // The caller gets the method's own promise. Told before the caller's own
    // continuation runs (its reaction was registered first), and never
    // rejecting itself: the settle handlers do not throw.
    void result.then(
      value => settle(pending, { ok: true, result: value }),
      error => settle(pending, { ok: false, error }),
    );
    return result;
  }
  settle(pending, { ok: true, result });
  return result;
}

/** What tapObject needs to know: where calls go, the controller they are about, and the sink. */
export interface TapObjectOptions {
  target: CallTarget;
  /** The controller's id, or how to find it in a call's arguments; null for none. */
  id: string | null | ((args: readonly unknown[]) => string | null);
  sink: SinkSource;
}

/**
 * A Proxy over `obj` whose methods report every call to the sink (see the
 * module comment). `instanceof`, property reads and writes, and `in` behave
 * as on `obj` itself; each method's wrapper is made once per function, so a
 * method read twice is the same function. A method replaced on `obj` later is
 * picked up on its next read.
 */
export function tapObject<T extends object>(obj: T, opts: TapObjectOptions): T {
  const { target, sink } = opts;
  const idOf = typeof opts.id === 'function' ? opts.id : ((id: string | null) => () => id)(opts.id);
  const wrappers = new WeakMap<object, unknown>();
  return new Proxy(obj, {
    get(t, prop) {
      // Getters run on the real object, so the client's own fields stay its own.
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== 'function' || typeof prop !== 'string' || prop in Object.prototype) { return value; }
      // A frozen own method must be handed back as it is (a Proxy invariant).
      const own = Object.getOwnPropertyDescriptor(t, prop);
      if (own && 'value' in own && !own.configurable && !own.writable) { return value; }
      const fn = value as (...args: unknown[]) => unknown;
      let wrapped = wrappers.get(fn);
      if (!wrapped) {
        wrapped = isListenerMethod(prop)
          ? fn.bind(t)
          : function tapped(...args: unknown[]): unknown { return invoke(sink, target, idOf, prop, fn, t, args); };
        wrappers.set(fn, wrapped);
      }
      return wrapped;
    },
    set(t, prop, value) {
      return Reflect.set(t, prop, value, t);
    },
  });
}

/** What tapFunction needs to know: where the call goes, under which name, the controller (if any) and the sink. */
export interface TapFunctionOptions {
  target: CallTarget;
  method: string;
  /** The controller's id; null (the default) for a setup step. */
  id?: string | null;
  sink: SinkSource;
}

/**
 * `fn`, reporting every call to the sink as `method` (a setup step such as
 * discovery or a passport read): arguments at the start, the outcome when it
 * settles, the result or error handed back as is, `this` as the caller gave
 * it. With a sink function, the sink is looked up at each call, so a wrapper
 * made once at startup reports to whichever recording runs, and to none
 * between recordings.
 */
export function tapFunction<F extends (...args: never[]) => unknown>(fn: F, opts: TapFunctionOptions): F {
  const id = opts.id ?? null;
  const call = fn as unknown as (...args: unknown[]) => unknown;
  const wrapped = function tapped(this: unknown, ...args: unknown[]): unknown {
    return invoke(opts.sink, opts.target, () => id, opts.method, call, this, args);
  };
  Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true });
  Object.defineProperty(wrapped, 'length', { value: fn.length, configurable: true });
  return wrapped as unknown as F;
}

/**
 * The fleet's tap: tapped views of each controller's manager (target
 * `manager`) and of the MultiRobotManager (target `multi`), each made once
 * per object and kept for as long as the object lives, reporting to the
 * current sink of `source` at each call.
 */
export class ClientTap {
  private readonly managers = new WeakMap<object, { id: string; view: object }>();
  private readonly multis = new WeakMap<object, object>();

  constructor(private readonly source: SinkSource) {}

  /** The sink calls are reported to now; null while there is none or it has ended. */
  current(): ClientTapSink | null {
    return liveSink(this.source);
  }

  /** The tapped view of controller `id`'s manager: the same object every time for the same manager. */
  manager<T extends object>(manager: T, id: string): T {
    const kept = this.managers.get(manager);
    if (kept && kept.id === id) { return kept.view as T; }
    const view = tapObject(manager, { target: 'manager', id, sink: this.source });
    this.managers.set(manager, { id, view });
    return view;
  }

  /** The tapped view of the MultiRobotManager: the same object every time. */
  multi<T extends object>(multi: T): T {
    const kept = this.multis.get(multi);
    if (kept) { return kept as T; }
    const view = tapObject(multi, { target: 'multi', id: multiCallId, sink: this.source });
    this.multis.set(multi, view);
    return view;
  }

  /** `fn` reporting to this tap's sink as a setup step named `method` (tapFunction). */
  setup<F extends (...args: never[]) => unknown>(fn: F, method: string): F {
    return tapFunction(fn, { target: 'setup', method, sink: this.source });
  }
}

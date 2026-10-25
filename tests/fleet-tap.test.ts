import { describe, it, expect, vi, afterEach } from 'vitest';
import { RwsError, type SubscriptionEvent } from 'abb-rws-client';
import type { ControllerFleet } from '../src/fleet.js';
import type { CallTarget } from '../src/schema/recording.js';
import type { ClientTapSink, PendingCall, TappedManagerView } from '../src/recording/contract.js';
import { ID, T0, cfg, fleetOver, world, type World } from './helpers/fake-fleet.js';

/** A sink keeping what it is told, as the recorder would be told it. */
class FakeSink implements ClientTapSink {
  active = true;
  calls: Array<{ target: CallTarget; id: string | null; method: string; args: readonly unknown[]; outcome?: { ok: boolean; result?: unknown; error?: unknown } }> = [];
  states: Array<{ id: string; manager: TappedManagerView | null }> = [];
  subs: Array<{ id: string; event: SubscriptionEvent }> = [];
  call(target: CallTarget, id: string | null, method: string, args: readonly unknown[]): PendingCall {
    const seen: FakeSink['calls'][number] = { target, id, method, args: JSON.parse(JSON.stringify(args)) as unknown[] };
    this.calls.push(seen);
    return { done: outcome => { seen.outcome = outcome; } };
  }
  state(id: string, manager: TappedManagerView | null): void { this.states.push({ id, manager }); }
  sub(id: string, event: SubscriptionEvent): void { this.subs.push({ id, event }); }
}

let fleets: ControllerFleet[] = [];
afterEach(() => {
  for (const f of fleets) { f.stopPointerPoller(); f.stopMotionSampler(); f.stopIoPoller(); f.stopEventReader(); f.stopSupervisor(); }
  fleets = [];
  vi.useRealTimers();
});

/** A fleet over a fresh world, connected to the controller (and, with `sink`, recording from the start). */
async function connected(sink: ClientTapSink | null = null): Promise<{ f: ControllerFleet; w: World }> {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const w = world();
  const f = fleetOver(w);
  fleets.push(f);
  if (sink) { f.setTap(sink); }
  f.add(cfg());
  await vi.advanceTimersByTimeAsync(50);
  return { f, w };
}

/**
 * Everything the fleet does with a controller, start to shutdown: connect,
 * the pointer poller, the motion sampler (with its axis walk and a failing
 * pose read), the I/O watcher (group adds, polls, an event), the event
 * reader (clock and log), reads on demand, a state change, and the logouts.
 */
async function lifetime(sink: ClientTapSink | null) {
  const { f, w } = await connected(sink);
  f.startPointerPoller();
  f.startMotionSampler();
  f.startIoPoller();
  f.startEventReader();
  f.watchMotion(ID);
  f.watchIo(ID, ['do_a', 'do_b']);
  await vi.advanceTimersByTimeAsync(2_000);
  const reads = Promise.all([f.moduleSource(ID, 'T_ROB1', 'MainModule'), f.searchIoSignals(ID, { name: 'do' })]);
  await vi.advanceTimersByTimeAsync(100);
  await reads;
  w.manager(ID).fire('/rw/iosystem/signals/do_a;state', '1');
  w.manager(ID).state.execstate = 'stopped';
  w.multi.changed(ID);
  await vi.advanceTimersByTimeAsync(2_000);
  const stopping = f.disconnectAll({ waitMs: 1_000 });
  await vi.advanceTimersByTimeAsync(1_000);
  const report = await stopping;
  return { log: [...w.log], report, w };
}

describe('recording never changes what the fleet sends', () => {
  it('the same requests, in the same order, at the same times, with the tap on and off', async () => {
    const off = await lifetime(null);
    vi.useRealTimers();
    const sink = new FakeSink();
    const on = await lifetime(sink);
    expect(on.log).toEqual(off.log);
    expect(on.report).toEqual(off.report);
    // Every kind of request was there to compare.
    const methods = new Set(off.log.map(l => l.split(':')[1]));
    for (const m of ['addRobot', 'connectRobot', 'updateConfig', 'disconnectRobot', 'getProgramPointer', 'getMotionPointer',
      'getModuleText', 'listModulesDetailed', 'searchSignals', 'readIoSignal', 'updateSubscriptionGroup', 'getMechunitDetails',
      'getCfgInstance', 'getJointTargetFull', 'getCartesianFull', 'getEventLog', 'getControllerClock']) {
      expect(methods, m).toContain(m);
    }
  });

  it('the recording is told every one of those requests, in order, and nothing else (no internal calls)', async () => {
    const sink = new FakeSink();
    const on = await lifetime(sink);
    const told = sink.calls.map(c => `${c.target}:${c.method}:${JSON.stringify(c.args)}`);
    expect(told).toEqual(on.log.map(l => l.slice(0, l.lastIndexOf('@'))));
    for (const c of sink.calls) {
      expect(c.id).toBe(ID);
      expect(c.outcome).toBeDefined();
    }
    // A typed failure is reported as such; the logouts are `multi` calls.
    const pose = sink.calls.find(c => c.method === 'getCartesianFull')!;
    expect(pose.outcome!.ok).toBe(false);
    expect((pose.outcome!.error as RwsError).code).toBe('RESOURCE_NOT_FOUND');
    expect(sink.calls.filter(c => c.method === 'disconnectRobot').map(c => c.target)).toEqual(['multi']);
  });

  it('a recording that has ended is told nothing more, and the requests go on the same', async () => {
    const sink = new FakeSink();
    const { f, w } = await connected(sink);
    const before = sink.calls.length;
    sink.active = false;
    await Promise.all([f.moduleSource(ID, 'T_ROB1', 'MainModule'), vi.advanceTimersByTimeAsync(50)]);
    expect(sink.calls).toHaveLength(before);
    expect(w.log.some(l => l.startsWith('manager:getModuleText'))).toBe(true);
  });
});

describe('removing a controller', () => {
  it('logs one info line naming the controller, and nothing of its credentials', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const lines: Array<{ level: string; obj: unknown; msg: string }> = [];
    const keep = (level: string) => (obj: unknown, msg?: string) => { lines.push({ level, obj, msg: msg ?? '' }); };
    const w = world();
    const f = fleetOver(w, { debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') });
    fleets.push(f);
    f.add(cfg());
    await vi.advanceTimersByTimeAsync(50);
    lines.length = 0;
    const removing = f.remove(ID);
    await vi.advanceTimersByTimeAsync(100);
    await removing;
    const removed = lines.filter(l => l.level === 'info' && /removed/.test(l.msg));
    expect(removed).toEqual([{ level: 'info', obj: { controller: ID }, msg: 'controller removed' }]);
    const all = JSON.stringify(lines);
    expect(all).not.toContain(cfg().password);
    expect(all).not.toContain(cfg().username);
  });
});

describe('the client state the recording is shown', () => {
  it('every controller at once when the tap is set, then each change; null once removed; nothing after the tap is cleared', async () => {
    const { f, w } = await connected();
    const sink = new FakeSink();
    f.setTap(sink);
    const real = w.manager(ID);
    expect(sink.states).toEqual([{ id: ID, manager: real }]);
    // The manager itself, never the tapped view: reading it records nothing.
    expect(sink.states[0].manager).toBe(real);
    real.state.execstate = 'stopped';
    w.multi.changed(ID);
    expect(sink.states).toHaveLength(2);
    expect(sink.states[1].manager!.state).toMatchObject({ execstate: 'stopped' });
    const removing = f.remove(ID);
    await vi.advanceTimersByTimeAsync(100);
    await removing;
    expect(sink.states.at(-1)).toEqual({ id: ID, manager: null });
    const seen = sink.states.length;
    f.setTap(null);
    f.add(cfg());
    await vi.advanceTimersByTimeAsync(50);
    expect(sink.states).toHaveLength(seen);
  });

  it('a recording started before the controller is added sees it from its first state', async () => {
    const sink = new FakeSink();
    const { w } = await connected(sink);
    expect(sink.states[0]).toEqual({ id: ID, manager: w.manager(ID) });
    expect(sink.states.length).toBeGreaterThanOrEqual(2);   // added, then connected
    expect(sink.calls.map(c => c.method).slice(0, 3)).toEqual(['addRobot', 'connectRobot', 'updateConfig']);
  });

  it('an ended recording is shown no state, even while still set', async () => {
    const sink = new FakeSink();
    const { w } = await connected(sink);
    const seen = sink.states.length;
    sink.active = false;
    w.multi.changed(ID);
    expect(sink.states).toHaveLength(seen);
  });

  it('a sink that throws does not stop the change handlers', async () => {
    const { f, w } = await connected();
    const broken: ClientTapSink = {
      active: true,
      call: () => { throw new Error('call'); },
      state: () => { throw new Error('state'); },
      sub: () => { throw new Error('sub'); },
    };
    f.setTap(broken);
    const changes: string[] = [];
    f.onChanged(id => changes.push(id));
    w.multi.changed(ID);
    expect(changes).toEqual([ID]);
    const answer = Promise.all([f.moduleSource(ID, 'T_ROB1', 'MainModule'), vi.advanceTimersByTimeAsync(50)]);
    expect((await answer)[0]).toMatchObject({ module: 'MainModule', kind: 'program' });
  });
});

describe('raw I/O subscription events', () => {
  /** Watch do_a on a connected controller until the watcher has tapped the manager's events. */
  async function watching(f: ControllerFleet, w: World): Promise<void> {
    f.watchIo(ID, ['do_a']);
    f.startIoPoller();
    await vi.advanceTimersByTimeAsync(500);
    expect(w.manager(ID).taps).toHaveLength(1);
  }
  const valueOf = (f: ControllerFleet, name: string) => f.get(ID)!.io.signals.find(s => s.name === name)!;

  it('a watch begun before the recording is recorded; none after the recording stops', async () => {
    const { f, w } = await connected();
    await watching(f, w);
    const sink = new FakeSink();
    f.setTap(sink);
    const event = w.manager(ID).fire('/rw/iosystem/signals/do_a;state', '1');
    expect(sink.subs).toEqual([{ id: ID, event }]);
    expect(sink.subs[0].event).toBe(event);
    expect(valueOf(f, 'do_a')).toMatchObject({ value: '1', via: 'subscription' });
    sink.active = false;   // the recording ended
    w.manager(ID).fire('/rw/iosystem/signals/do_a;state', '0');
    f.setTap(null);
    w.manager(ID).fire('/rw/iosystem/signals/do_a;state', '1');
    expect(sink.subs).toHaveLength(1);
    expect(valueOf(f, 'do_a').value).toBe('1');   // the fleet still takes every event
  });

  it('a watch begun during a recording keeps working after it; the tap on the events is not a call', async () => {
    const sink = new FakeSink();
    const { f, w } = await connected(sink);
    await watching(f, w);
    expect(sink.calls.map(c => c.method)).not.toContain('onSubscriptionEvent');
    const during = w.manager(ID).fire('/rw/iosystem/signals/do_a;state', '1');
    expect(sink.subs.map(s => s.event)).toEqual([during]);
    sink.active = false;
    f.setTap(null);
    w.manager(ID).fire('/rw/iosystem/signals/do_a;state', '0');
    expect(valueOf(f, 'do_a')).toMatchObject({ value: '0', via: 'subscription' });
    expect(sink.subs).toHaveLength(1);
    // A later recording gets the same watch's events.
    const next = new FakeSink();
    f.setTap(next);
    const later = w.manager(ID).fire('/rw/iosystem/signals/do_a;state', '1');
    expect(next.subs).toEqual([{ id: ID, event: later }]);
  });

  it('events the fleet does not use are recorded too: what the daemon consumed, as it came', async () => {
    const sink = new FakeSink();
    const { f, w } = await connected(sink);
    await watching(f, w);
    const other = w.manager(ID).fire('/rw/iosystem/signals/do_unwatched;state', '1');
    const odd = w.manager(ID).fire('/rw/panel/ctrl-state', 'motoron');
    expect(sink.subs.map(s => s.event)).toEqual([other, odd]);
  });
});

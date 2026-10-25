import { describe, it, expect } from 'vitest';
import {
  IO_CAP_REASON, IO_CEILING_REQ_S, IO_RWS1_TABLE_PAGE, IO_WATCH_LEASE_MAX, IO_WATCH_MAX, ioBudgetHz, ioEditRetryMs, ioGroup, ioLeaseGrant,
  ioLeaseUnion, ioNameProblem, ioPollHz, ioSignature,
  ioTableComplete, ioTableLoaded, signalNameFromResource, watchedSignalFor,
  type IoLoad, type IoView, type WatchedSignal,
} from '../src/io.js';
import { POSE_EVERY_TICKS, motionTargetHz } from '../src/motion.js';

const T0 = Date.parse('2026-09-27T12:00:00Z');

const sig = (over: Partial<WatchedSignal> = {}): WatchedSignal =>
  ({ name: 'do_test', type: 'DO', value: '1', via: 'poll', asOf: T0 - 100, error: null, ...over });

const view = (over: Partial<IoView> = {}): IoView =>
  ({ leaseUntil: T0 + 10_000, signals: [sig()], ...over });

const liveLink = { quality: 'live' as const, connected: true };

const idle: IoLoad = { motionUnits: 0, runningTasks: 0 };
const oneRobot: IoLoad = { motionUnits: 1, runningTasks: 0 };

describe('ioBudgetHz - what the I/O watcher may spend, reads and group edits together', () => {
  it('takes at most 8 req/s on a quiet live link', () => {
    expect(ioBudgetHz('live', idle)).toBe(8);
  });

  it('reserves the manager`s fast cadence while the link polls', () => {
    expect(ioBudgetHz('polling', idle)).toBe(2);   // 14 - 12
  });

  it('reserves each mechanical unit a live motion watch samples, joints and pose', () => {
    expect(ioBudgetHz('live', oneRobot)).toBe(2);                              // 14 - 2 - 10
    expect(ioBudgetHz('live', { motionUnits: 2, runningTasks: 0 })).toBe(1);   // past the ceiling: the floor
    expect(ioBudgetHz('polling', oneRobot)).toBe(1);                           // 14 - 12 - 2.5
  });

  it('reserves two reads a second per running task, not one pair per controller', () => {
    expect(ioBudgetHz('live', { motionUnits: 0, runningTasks: 3 })).toBe(6);   // 14 - 2 - 6
    expect(ioBudgetHz('live', { motionUnits: 0, runningTasks: 5 })).toBe(2);   // 14 - 2 - 10
  });

  it('never starves to zero, and otherwise keeps every spender inside the ceiling', () => {
    for (const quality of ['live', 'polling'] as const) {
      for (let motionUnits = 0; motionUnits <= 3; motionUnits++) {
        for (let runningTasks = 0; runningTasks <= 4; runningTasks++) {
          const io = ioBudgetHz(quality, { motionUnits, runningTasks });
          expect(io).toBeGreaterThanOrEqual(1);
          const reserved = (quality === 'polling' ? 12 : 2)
            + motionUnits * motionTargetHz(quality) * (1 + 1 / POSE_EVERY_TICKS) + 2 * runningTasks;
          if (io > 1) { expect(reserved + io).toBeLessThanOrEqual(IO_CEILING_REQ_S); }
        }
      }
    }
  });
});

describe('ioPollHz - the read rate for polled signals', () => {
  it('spends nothing without signals', () => {
    expect(ioPollHz(0, 'live', idle)).toBe(0);
  });

  it('never exceeds 2 Hz per lamp, nor the I/O budget', () => {
    expect(ioPollHz(1, 'live', idle)).toBe(2);
    expect(ioPollHz(3, 'live', idle)).toBe(6);
    expect(ioPollHz(24, 'live', idle)).toBe(8);
    expect(ioPollHz(3, 'polling', idle)).toBe(2);
    expect(ioPollHz(24, 'live', oneRobot)).toBe(2);
  });

  it('with the manager, one sampled robot and a running task all on a live link, takes only the floor', () => {
    expect(ioPollHz(24, 'live', { motionUnits: 1, runningTasks: 1 })).toBe(1);   // 2 + 10 + 2 = the ceiling
  });
});

describe('ioEditRetryMs - backoff after a failed group add', () => {
  it('never retries faster than once a second, doubles, and caps at a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 12].map(ioEditRetryMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(ioEditRetryMs(0)).toBe(1_000);
  });
});

describe('ioNameProblem - which watch names can reach the controller', () => {
  it('accepts a signal name alone or as network/device/signal', () => {
    expect(ioNameProblem('do_a', null)).toBeNull();
    expect(ioNameProblem('Local/DRV_1/DO_10', null)).toBeNull();
  });

  it('refuses anything that would change a subscription body or a request path', () => {
    for (const bad of ['do_a&x=1', 'do_a=1', 'x?y', 'a#b', '../../rw/panel', 'a/b', 'a/b/c/d', 'do a', 'do;state', '']) {
      expect(ioNameProblem(bad, null)).toMatch(/^not an I\/O signal name/);
    }
  });

  it('with the table loaded, refuses a name the controller does not have, matching a path by its signal part', () => {
    const table = new Set(['do_a', 'di_b']);
    expect(ioNameProblem('do_a', table)).toBeNull();
    expect(ioNameProblem('Local/DRV_1/di_b', table)).toBeNull();
    expect(ioNameProblem('zzNoSuchSignal01', table)).toBe('no such signal on this controller');
    expect(ioNameProblem('DO_A', table)).toBe('no such signal on this controller');   // spelled as the table spells it
  });
});

describe('ioTableComplete - whether a loaded signal table lists every signal', () => {
  it('RWS 2.0 walks every page: complete at any length', () => {
    expect(ioTableComplete('rws2', 0)).toBe(true);
    expect(ioTableComplete('rws2', IO_RWS1_TABLE_PAGE)).toBe(true);
    expect(ioTableComplete('rws2', 1_500)).toBe(true);
  });

  it('RWS 1.0 reads one page: a table shorter than the page is complete, one as long may be cut short', () => {
    expect(IO_RWS1_TABLE_PAGE).toBe(100);
    expect(ioTableComplete('rws1', 62)).toBe(true);
    expect(ioTableComplete('rws1', 99)).toBe(true);
    expect(ioTableComplete('rws1', 100)).toBe(false);
    expect(ioTableComplete(null, 100)).toBe(false);   // generation unknown: the cautious rule
  });
});

describe('ioTableLoaded - whether the cached signal table belongs to this connection', () => {
  it('takes the client`s word when it says', () => {
    expect(ioTableLoaded({ connected: true, ioSignals: [{}], ioSignalsLoaded: false })).toBe(false);
    expect(ioTableLoaded({ connected: true, ioSignals: [], ioSignalsLoaded: true })).toBe(true);   // a controller with no signals
  });

  it('without the flag, trusts a non-empty table on a connected link only', () => {
    expect(ioTableLoaded({ connected: true, ioSignals: [{}] })).toBe(true);
    expect(ioTableLoaded({ connected: true, ioSignals: [] })).toBe(false);
    expect(ioTableLoaded({ connected: false, ioSignals: [{}] })).toBe(false);
  });
});

describe('signalNameFromResource', () => {
  it('reads the RWS 1.0 raw path shape', () => {
    expect(signalNameFromResource('/rw/iosystem/signals/Local/DRV_1/do_x;state')).toBe('Local/DRV_1/do_x');
  });

  it('reads a name-only shape and other value suffixes', () => {
    expect(signalNameFromResource('/rw/iosystem/signals/do_x;lvalue')).toBe('do_x');
  });

  it('is null for anything that is not a signal event', () => {
    expect(signalNameFromResource('speedratio')).toBeNull();
    expect(signalNameFromResource('/rw/panel/ctrl-state;ctrlstate')).toBeNull();
    expect(signalNameFromResource('/rw/iosystem/signals/;state')).toBeNull();
  });
});

describe('watchedSignalFor', () => {
  const a = sig({ name: 'do_a' });
  const b = sig({ name: 'Local/DRV_1/do_b' });

  it('prefers the exact name', () => {
    expect(watchedSignalFor([a, b], 'do_a')).toBe(a);
    expect(watchedSignalFor([a, b], 'Local/DRV_1/do_b')).toBe(b);
  });

  it('accepts a unique path-suffix match in either direction', () => {
    expect(watchedSignalFor([a, b], 'Local/PANEL/do_a')).toBe(a);      // event longer than the watch
    expect(watchedSignalFor([a, b], 'do_b')).toBe(b);                  // event shorter than the watch
  });

  it('returns null for a miss and for an ambiguous suffix', () => {
    expect(watchedSignalFor([a, b], 'do_c')).toBeNull();
    // Two devices carry a signal of the same bare name: an event naming only
    // the bare name must not be guessed onto either of them.
    const one = sig({ name: 'Local/DRV_1/do_x' });
    const two = sig({ name: 'Remote/DRV_9/do_x' });
    expect(watchedSignalFor([one, two], 'do_x')).toBeNull();
  });
});

describe('ioGroup', () => {
  it('is empty and unwatched before anyone watches', () => {
    expect(ioGroup(null, liveLink, true, T0)).toEqual({ watching: false, signals: [], asOf: null });
  });

  it('carries nothing from a link on the wrong controller', () => {
    expect(ioGroup(view(), liveLink, false, T0)).toEqual({ watching: false, signals: [], asOf: null });
  });

  it('serves the watched signals with ISO timestamps while the lease holds', () => {
    const g = ioGroup(view(), liveLink, true, T0);
    expect(g.watching).toBe(true);
    expect(g.signals[0]).toEqual({ name: 'do_test', type: 'DO', value: '1', via: 'poll', asOf: '2026-09-27T11:59:59.900Z', error: null });
    expect(g.asOf).toBe('2026-09-27T11:59:59.900Z');
  });

  it('keeps the last values after the lease lapses, watching false, via null', () => {
    const g = ioGroup(view({ leaseUntil: T0 - 1 }), liveLink, true, T0);
    expect(g.watching).toBe(false);
    expect(g.signals[0]).toMatchObject({ value: '1', via: null, asOf: '2026-09-27T11:59:59.900Z' });
  });

  it('nulls via while the link is down - stale values must look stale, not live', () => {
    const g = ioGroup(view(), { quality: 'disconnected', connected: false }, true, T0);
    expect(g.watching).toBe(true);
    expect(g.signals[0].via).toBeNull();
  });

  it('reports the newest confirmation as the group asOf', () => {
    const v = view({ signals: [sig({ asOf: T0 - 500 }), sig({ name: 'di_b', asOf: T0 - 20 })] });
    expect(ioGroup(v, liveLink, true, T0).asOf).toBe(new Date(T0 - 20).toISOString());
  });
});

describe('ioSignature', () => {
  it('ignores timestamps but catches a value change', () => {
    const g1 = ioGroup(view(), liveLink, true, T0);
    const g2 = ioGroup(view({ signals: [sig({ asOf: T0 - 5 })] }), liveLink, true, T0);
    expect(ioSignature(g1)).toBe(ioSignature(g2));
    const g3 = ioGroup(view({ signals: [sig({ value: '0' })] }), liveLink, true, T0);
    expect(ioSignature(g1)).not.toBe(ioSignature(g3));
  });
});

describe('IO_WATCH_MAX', () => {
  it('stays clear of the RW 7.19/7.20 subscription-body regression per edit, not per watch', () => {
    // The cap bounds the watch; the CHUNK bounds each subscription edit. The
    // watch may exceed 12 signals because edits are chunked - this pins the
    // assumption so a cap change is checked against that regression first.
    expect(IO_WATCH_MAX).toBeLessThanOrEqual(64);
  });
});

describe('ioLeaseUnion - the signals watched for every lease together', () => {
  it('lists each name once: the leases in the order they were opened, each lease`s names in its own order', () => {
    expect(ioLeaseUnion([
      { until: T0, names: ['do_b', 'do_a'] },
      { until: T0, names: ['di_c', 'do_a', 'do_b'] },
      { until: T0, names: [] },
    ])).toEqual(['do_b', 'do_a', 'di_c']);
  });

  it('is a single lease`s set exactly as it asked for it', () => {
    expect(ioLeaseUnion([{ until: T0, names: ['z', 'a', 'm'] }])).toEqual(['z', 'a', 'm']);
  });
});

describe('ioLeaseGrant - what one lease may hold', () => {
  const ok = () => null;
  const names = (n: number, prefix = 'do_') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it('trims, skips blanks and repeats, and refuses by name in the order asked', () => {
    const g = ioLeaseGrant([' do_a ', '', 'do_a', 'bad&x', 'do_b'], n => (n.includes('&') ? 'not an I/O signal name' : null), new Set(), null);
    expect(g).toEqual({ accepted: ['do_a', 'do_b'], rejected: [{ name: 'bad&x', reason: 'not an I/O signal name' }] });
  });

  it('caps a lease with an id at its own cap, with a reason that says so', () => {
    const g = ioLeaseGrant(names(IO_WATCH_LEASE_MAX + 2), ok, new Set(), IO_WATCH_LEASE_MAX);
    expect(g.accepted).toEqual(names(IO_WATCH_LEASE_MAX));
    expect(g.rejected).toEqual(names(IO_WATCH_LEASE_MAX + 2).slice(IO_WATCH_LEASE_MAX).map(name => ({ name, reason: IO_CAP_REASON.lease })));
    expect(IO_CAP_REASON.lease).toContain(`${IO_WATCH_LEASE_MAX}`);
  });

  it('caps the union at the controller`s cap, counting only names no other lease holds', () => {
    const others = new Set(names(IO_WATCH_MAX - 2));
    const g = ioLeaseGrant(['do_0', 'di_a', 'do_1', 'di_b', 'di_c', 'do_2'], ok, others, IO_WATCH_LEASE_MAX);
    expect(g.accepted).toEqual(['do_0', 'di_a', 'do_1', 'di_b', 'do_2']);
    expect(g.rejected).toEqual([{ name: 'di_c', reason: IO_CAP_REASON.controller }]);
    expect(IO_CAP_REASON.controller).toContain(`${IO_WATCH_MAX}`);
  });

  it('gives the anonymous lease no cap of its own: only the controller`s', () => {
    const g = ioLeaseGrant(names(IO_WATCH_MAX + 3), ok, new Set(), null);
    expect(g.accepted).toHaveLength(IO_WATCH_MAX);
    expect(g.rejected.map(r => r.reason)).toEqual([IO_CAP_REASON.controller, IO_CAP_REASON.controller, IO_CAP_REASON.controller]);
  });

  it('a lease with an id always leaves room under the controller`s cap for another', () => {
    expect(IO_WATCH_LEASE_MAX).toBeLessThan(IO_WATCH_MAX);
  });
});

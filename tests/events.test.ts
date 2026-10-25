import { describe, it, expect } from 'vitest';
import type { ElogMessage } from 'abb-rws-client';
import {
  EVENTS_POLL_MS, EVENTS_RECHECK_MS, EVENT_ARGS_MAX, EVENT_KEYS_MIN, EventFeed, clockOffsetMs, compareSeqnum, eventText,
  eventsGroup, eventsReadIntervalMs, eventsReadRequests, eventsRetryMs, eventsSignature, parseControllerTime, severityOf,
  type EventsView,
} from '../src/events.js';
import { EVENTS_KEEP_MAX, EVENTS_RECENT_MAX, EVENT_TEXT_MAX } from '../src/schema/v0.js';

const T0 = Date.parse('2026-09-29T10:00:00Z');

/**
 * A message as the client's RWS 1.0 reader returns it from `GET /rw/elog/0?lang=en`
 * (RW 6.16): the sequence number from the item's title (`/rw/elog/0/18`), empty
 * strings for the parts the controller left out, `args` from `argc`/`argN`.
 */
function rws1(seqnum: number, code: number, tstamp: string, title: string, over: Partial<ElogMessage> = {}): ElogMessage {
  return { seqnum, code, msgtype: 1, timestamp: tstamp, srcName: 'MC0', title, desc: '', causes: '', consequences: '', actions: '', args: [], ...over };
}

/**
 * A message as the client's RWS 2.0 reader returns it (RW 7.21 / 8.1): the
 * sequence number from `_title`, "Event <code>" in place of a title the
 * controller did not send.
 */
function rws2(seqnum: number, code: number, tstamp: string, title: string | null, over: Partial<ElogMessage> = {}): ElogMessage {
  return {
    seqnum, code, msgtype: 1, timestamp: tstamp, srcName: '', title: title ?? `Event ${code}`,
    desc: '', causes: '', consequences: '', actions: '', args: [], ...over,
  };
}

/** RWS 1.0 lists newest first. Recorded on a RW 6.16 virtual controller. */
const RWS1_LOG: ElogMessage[] = [
  rws1(18, 10205, '2026-07-09 T 01:29:56', 'Configuration parameter changed',
    { desc: 'A configuration parameter has been changed in domain: SYS by Default User.' }),
  rws1(17, 10014, '2026-07-09 T 01:18:04', 'System failure state', { msgtype: 2, desc: 'Impossible to continue.' }),
];

/** RWS 2.0 lists oldest first; the numbers have gaps. Shapes recorded on RW 7.21 and 8.1 virtual controllers. */
const RWS2_LOG: ElogMessage[] = [
  rws2(1, 10046, '2026-08-09 T 00:22:09', 'System reset', { desc: 'Loading the original system installation settings.' }),
  rws2(2, 120003, '2026-08-09 T 00:23:41', 'Wrong cfg domain version', {
    msgtype: 2, desc: 'The cfg domain version is wrong in file POWA_ASI_EIO.cfg.',
  }),
  rws2(25, 10056, '2026-08-09 T 00:24:10', 'System shutdown initiated'),
  // No text in the language asked for: the reader made the title from the code.
  rws2(27, 10140, '2026-08-09 T 00:25:02', null, { args: [{ type: 'long', value: '100' }, { type: 'string', value: 'Default User' }] }),
];

const take = (feed: EventFeed, listing: ElogMessage[], over: Partial<Parameters<EventFeed['take']>[1]> = {}) =>
  feed.take(listing, { generation: 'rws1', offsetMs: null, at: T0, complete: false, ...over });

describe('parseControllerTime', () => {
  it('reads the controllers\' own spelling as a wall-clock reading', () => {
    expect(parseControllerTime('2026-07-09 T 01:29:56')).toBe(Date.parse('2026-07-09T01:29:56Z'));
    expect(parseControllerTime('  2026-09-27 T 18:07:30 ')).toBe(Date.parse('2026-09-27T18:07:30Z'));
  });

  it('reads the ISO spellings, a fraction, and applies a zone given', () => {
    expect(parseControllerTime('2026-07-09T01:29:56')).toBe(Date.parse('2026-07-09T01:29:56Z'));
    expect(parseControllerTime('2026-07-09 01:29:56.250')).toBe(Date.parse('2026-07-09T01:29:56.250Z'));
    expect(parseControllerTime('2026-07-09T01:29:56Z')).toBe(Date.parse('2026-07-09T01:29:56Z'));
    expect(parseControllerTime('2026-07-09T03:29:56+02:00')).toBe(Date.parse('2026-07-09T01:29:56Z'));
    expect(parseControllerTime('2026-07-08T20:29:56-0500')).toBe(Date.parse('2026-07-09T01:29:56Z'));
  });

  it('is null for anything that is no date and time', () => {
    for (const bad of ['', 'yesterday', '2026-07-09', '2026-02-30 T 10:00:00', '2026-07-09 T 25:00:00', '2026-07-09 T 10:61:00', null, undefined]) {
      expect(parseControllerTime(bad)).toBeNull();
    }
  });
});

describe('clockOffsetMs', () => {
  it('is the daemon time at the middle of the read minus the reading: zone and error together', () => {
    // A controller two hours ahead (its local zone) and 3 s fast, read in a 200 ms request.
    const sent = T0 - 100;
    const answered = T0 + 100;
    expect(clockOffsetMs('2026-09-29 T 12:00:03', sent, answered)).toBe(-(2 * 3_600_000 + 3_000));
  });

  it('is null for a reading that is no date and time', () => {
    expect(clockOffsetMs('not a time', T0, T0)).toBeNull();
  });
});

describe('compareSeqnum', () => {
  it('RWS 1.0: counts on past 65,535 (16 bits)', () => {
    expect(compareSeqnum(2, 65_534, true)).toBeGreaterThan(0);
    expect(compareSeqnum(65_534, 2, true)).toBeLessThan(0);
    expect(compareSeqnum(0, 65_535, true)).toBeGreaterThan(0);
    expect(compareSeqnum(18, 17, true)).toBeGreaterThan(0);
    expect(compareSeqnum(17, 17, true)).toBe(0);
  });

  it('RWS 2.0: plainly', () => {
    expect(compareSeqnum(2, 65_534, false)).toBeLessThan(0);
    expect(compareSeqnum(70_000, 65_534, false)).toBeGreaterThan(0);
  });

  it('RWS 1.0: a number lower than the last seen by more than 32,768 is the newer one', () => {
    // RW 6.13.02 wraps the count at 2^16: after 65,000 comes 100.
    expect(compareSeqnum(100, 65_000, true)).toBeGreaterThan(0);
    expect(compareSeqnum(65_000, 100, true)).toBeLessThan(0);
    // Lower by exactly half the span is older; by one more it is newer.
    expect(compareSeqnum(0, 32_768, true)).toBeLessThan(0);
    expect(compareSeqnum(0, 32_769, true)).toBeGreaterThan(0);
    // A plain step back is older, not a wrap.
    expect(compareSeqnum(16, 17, true)).toBeLessThan(0);
    // Without wrap the same numbers read plainly.
    expect(compareSeqnum(100, 65_000, false)).toBeLessThan(0);
  });
});

describe('severity', () => {
  it('comes from msgtype alone: 1 info, 2 warning, 3 error', () => {
    expect(severityOf(1)).toBe('info');
    expect(severityOf(2)).toBe('warning');
    expect(severityOf(3)).toBe('error');
  });

  it('msgtype 0 (the client\'s "unknown") is null - never information', () => {
    expect(severityOf(0)).toBeNull();
    const feed = new EventFeed();
    take(feed, [rws1(5, 10002, '2026-09-29 T 08:00:00', 'Program pointer has been reset', { msgtype: 0 })]);
    expect(feed.recent()[0]).toMatchObject({ code: 10002, severity: null });
    const feed2 = new EventFeed();
    take(feed2, [rws2(9, 10002, '2026-09-29 T 08:00:00', 'Program pointer has been reset', { msgtype: 0 })], { generation: 'rws2' });
    expect(feed2.recent()[0]).toMatchObject({ code: 10002, severity: null });
  });

  it('any other type is null as well, and no event code decides it', () => {
    expect(severityOf(4)).toBeNull();
    expect(severityOf(-1)).toBeNull();
    expect(severityOf(NaN)).toBeNull();
    expect(severityOf(undefined)).toBeNull();
    expect(severityOf('2')).toBeNull();
    // 50027 is information before RW 7.20 and an error from it; 90200 was 20200
    // before RW 6.05 - the code says nothing, the type says everything.
    const feed = new EventFeed();
    take(feed, [
      rws2(3, 90_200, '2026-09-29 T 08:00:02', 'Safety', { msgtype: 3 }),
      rws2(2, 50_027, '2026-09-29 T 08:00:01', 'Joint Out of Range', { msgtype: 3 }),
      rws2(1, 50_027, '2026-09-29 T 08:00:00', 'Joint Out of Range', { msgtype: 1 }),
    ], { generation: 'rws2' });
    expect(feed.recent().map(e => [e.code, e.severity])).toEqual([[50_027, 'info'], [50_027, 'error'], [90_200, 'error']]);
  });
});

describe('EventFeed keys', () => {
  it('tells messages apart by sequence number, never by code: alike codes are all kept, one number once', () => {
    const feed = new EventFeed();
    // Three "Motors ON state" with one code and three numbers: three events.
    const listing = [
      rws1(21, 10011, '2026-09-29 T 08:00:03', 'Motors ON state'),
      rws1(20, 10011, '2026-09-29 T 08:00:02', 'Motors ON state'),
      rws1(19, 10011, '2026-09-29 T 08:00:01', 'Motors ON state'),
    ];
    expect(take(feed, listing)).toBe(3);
    // The same numbers listed again, whatever their code would map to: nothing new.
    expect(take(feed, listing, { at: T0 + 5_000 })).toBe(0);
    // A new number with an old code is new; an old number is not, even with fresh text.
    expect(take(feed, [rws1(22, 10011, '2026-09-29 T 08:00:04', 'Motors ON state'), ...listing], { at: T0 + 10_000 })).toBe(1);
    expect(feed.recent().map(e => e.seqnum)).toEqual([19, 20, 21, 22]);
  });
});

describe('read cadence', () => {
  it('polls every EVENTS_POLL_MS, a second per request for a long RWS 2.0 log', () => {
    expect(eventsReadIntervalMs('poll', eventsReadRequests('rws1', 1_000))).toBe(EVENTS_POLL_MS);
    expect(eventsReadIntervalMs('poll', eventsReadRequests('rws2', 146))).toBe(EVENTS_POLL_MS);
    expect(eventsReadRequests('rws2', 1_000)).toBe(20);
    expect(eventsReadIntervalMs('poll', eventsReadRequests('rws2', 1_000))).toBe(20_000);
  });

  it('while subscribed, rechecks every EVENTS_RECHECK_MS, ten seconds per request for a long log', () => {
    expect(eventsReadIntervalMs('subscription', 1)).toBe(EVENTS_RECHECK_MS);
    expect(eventsReadIntervalMs('subscription', 20)).toBe(200_000);
  });

  it('backs failed reads off 5, 10, 20, 40, then 60 s', () => {
    expect([1, 2, 3, 4, 5, 9].map(eventsRetryMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });
});

describe('EventFeed.take', () => {
  it('records an RWS 1.0 listing oldest first, numbered from 1, as backlog', () => {
    const feed = new EventFeed();
    expect(take(feed, RWS1_LOG)).toBe(2);
    const [first, second] = feed.recent();
    expect(first).toMatchObject({
      seq: 1, seqnum: 17, code: 10014, severity: 'warning', title: 'System failure state', titleFromCode: false,
      description: 'Impossible to continue.', causes: null, consequences: null, actions: null, source: 'MC0',
      time: { raw: '2026-07-09 T 01:18:04', utc: '2026-07-09T01:18:04.000Z', corrected: false },
      receivedAt: new Date(T0).toISOString(), backlog: true,
    });
    expect(second).toMatchObject({ seq: 2, seqnum: 18, code: 10205, severity: 'info', backlog: true });
    expect([feed.firstSeq, feed.lastSeq]).toEqual([1, 2]);
  });

  it('a listing read again adds nothing; a new message is recorded once, and is not backlog', () => {
    const feed = new EventFeed();
    take(feed, RWS1_LOG);
    expect(take(feed, RWS1_LOG)).toBe(0);
    const next = [rws1(19, 10011, '2026-07-09 T 01:31:00', 'Motors ON state'), ...RWS1_LOG];
    expect(take(feed, next, { at: T0 + 5_000 })).toBe(1);
    expect(take(feed, next, { at: T0 + 10_000 })).toBe(0);
    expect(feed.recent().map(e => [e.seq, e.seqnum, e.backlog])).toEqual([[1, 17, true], [2, 18, true], [3, 19, false]]);
    expect(feed.recent()[2].receivedAt).toBe(new Date(T0 + 5_000).toISOString());
  });

  it('a listing that comes late - older than one already taken - adds nothing', () => {
    const feed = new EventFeed();
    const newer = [rws1(19, 10011, '2026-07-09 T 01:31:00', 'Motors ON state'), ...RWS1_LOG];
    take(feed, newer);
    expect(take(feed, RWS1_LOG)).toBe(0);
    expect(feed.lastSeq).toBe(3);
  });

  it('orders across the RWS 1.0 16-bit wrap, and follows it', () => {
    const feed = new EventFeed();
    // Newest first, as RWS 1.0 lists it: the count passed 65,535 and started again.
    const wrapped = [
      rws1(1, 10011, '2026-09-29 T 08:00:05', 'Motors ON state'),
      rws1(0, 10012, '2026-09-29 T 08:00:04', 'Safety guard stop state'),
      rws1(65_535, 10010, '2026-09-29 T 08:00:03', 'Motors OFF state'),
      rws1(65_534, 10052, '2026-09-29 T 08:00:02', 'Regain start'),
    ];
    take(feed, wrapped);
    expect(feed.recent().map(e => e.seqnum)).toEqual([65_534, 65_535, 0, 1]);
    expect(feed.recent().map(e => e.seq)).toEqual([1, 2, 3, 4]);
    // The next read: two more after the wrap, the oldest gone from the controller's listing.
    const next = [
      rws1(3, 10053, '2026-09-29 T 08:00:09', 'Regain ready'),
      rws1(2, 10010, '2026-09-29 T 08:00:08', 'Motors OFF state'),
      ...wrapped.slice(0, 3),
    ];
    expect(take(feed, next)).toBe(2);
    expect(feed.recent().map(e => [e.seq, e.seqnum])).toEqual([[1, 65_534], [2, 65_535], [3, 0], [4, 1], [5, 2], [6, 3]]);
  });

  it('a log that starts over after a reset (numbers from 1 again, new times) is recorded as new', () => {
    const feed = new EventFeed();
    take(feed, [rws1(14_073, 10205, '2026-09-28 T 16:00:00', 'Configuration parameter changed')]);
    const restarted = [
      rws1(2, 10056, '2026-09-29 T 08:10:05', 'System shutdown initiated'),
      rws1(1, 10046, '2026-09-29 T 08:10:00', 'System reset'),
    ];
    expect(take(feed, restarted)).toBe(2);
    expect(feed.recent().map(e => [e.seq, e.seqnum, e.title])).toEqual([
      [1, 14_073, 'Configuration parameter changed'], [2, 1, 'System reset'], [3, 2, 'System shutdown initiated'],
    ]);
  });

  it('RWS 2.0: oldest first with gaps; a message without text keeps its code, a title made from it and its values', () => {
    const feed = new EventFeed();
    expect(take(feed, RWS2_LOG, { generation: 'rws2' })).toBe(4);
    const events = feed.recent();
    expect(events.map(e => e.seqnum)).toEqual([1, 2, 25, 27]);
    expect(events[1]).toMatchObject({ code: 120003, severity: 'warning', title: 'Wrong cfg domain version', source: null });
    expect(events[3]).toMatchObject({
      code: 10140, title: 'Event 10140', titleFromCode: true, description: null,
      args: [{ type: 'long', value: '100' }, { type: 'string', value: 'Default User' }],
    });
  });

  it('a title the controller left empty is made from the code, on either generation', () => {
    const feed = new EventFeed();
    take(feed, [rws1(5, 10002, '2026-09-29 T 08:00:00', '')]);
    expect(feed.recent()[0]).toMatchObject({ title: 'Event 10002', titleFromCode: true, code: 10002 });
  });

  it('messages without a sequence number: ordered by time, de-duplicated by content, alike ones in one second each kept', () => {
    const feed = new EventFeed();
    // An RWS 2.0 listing whose messages carry no number (the client reports 0).
    const log = [
      rws2(0, 10010, '2026-09-29 T 08:00:03', 'Motors OFF state'),
      rws2(0, 10011, '2026-09-29 T 08:00:01', 'Motors ON state'),
      rws2(0, 10011, '2026-09-29 T 08:00:01', 'Motors ON state'),
    ];
    expect(take(feed, log, { generation: 'rws2' })).toBe(3);
    expect(feed.recent().map(e => [e.code, e.seqnum])).toEqual([[10011, null], [10011, null], [10010, null]]);
    expect(take(feed, log, { generation: 'rws2' })).toBe(0);
    const more = [...log, rws2(0, 10011, '2026-09-29 T 08:00:01', 'Motors ON state'), rws2(0, 10012, '2026-09-29 T 08:00:07', 'Safety guard stop state')];
    expect(take(feed, more, { generation: 'rws2' })).toBe(2);
    expect(feed.lastSeq).toBe(5);
  });

  it('a message a paged read met twice counts once', () => {
    const feed = new EventFeed();
    const log = [...RWS2_LOG.slice(0, 2), RWS2_LOG[1], RWS2_LOG[2]];
    expect(take(feed, log, { generation: 'rws2' })).toBe(3);
  });

  it('an empty listing from the manager means nothing; an empty log the reader read primes the feed', () => {
    const fromManager = new EventFeed();
    expect(take(fromManager, [])).toBe(0);
    take(fromManager, RWS1_LOG);
    expect(fromManager.recent().every(e => e.backlog)).toBe(true);

    const read = new EventFeed();
    take(read, [], { complete: true });
    expect(read.isPrimed).toBe(true);
    take(read, RWS1_LOG);
    expect(read.recent().some(e => e.backlog)).toBe(false);
  });

  it('keeps the last EVENTS_KEEP_MAX, and of a first listing longer than that only its newest', () => {
    const feed = new EventFeed();
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) =>
      rws2(from + i, 10011, new Date(T0 + (from + i) * 1000).toISOString().slice(0, 19).replace('T', ' T '), 'Motors ON state'));
    expect(take(feed, many(1, 300), { generation: 'rws2' })).toBe(EVENTS_KEEP_MAX);
    expect(feed.size).toBe(EVENTS_KEEP_MAX);
    expect(feed.recent(1)[0].seqnum).toBe(300);
    expect(take(feed, many(1, 310), { generation: 'rws2' })).toBe(10);
    expect(feed.size).toBe(EVENTS_KEEP_MAX);
    expect([feed.firstSeq, feed.lastSeq]).toEqual([266 - EVENTS_KEEP_MAX + 1, 266]);
  });

  it('remembers a bounded number of message keys', () => {
    const feed = new EventFeed();
    for (let i = 0; i < 400; i++) {
      const at = new Date(T0 + i * 10_000).toISOString().slice(0, 19).replace('T', ' T ');
      const listing = Array.from({ length: 10 }, (_, k) => rws2(i * 10 + k + 1, 10011, at, 'Motors ON state'));
      take(feed, listing, { generation: 'rws2' });
    }
    expect(feed.lastSeq).toBe(4_000);
    expect(feed.keysHeld).toBeLessThanOrEqual(EVENT_KEYS_MIN);
    expect(feed.size).toBe(EVENTS_KEEP_MAX);
  });
});

describe('EventFeed times', () => {
  it('are corrected with the offset known when they are recorded', () => {
    const feed = new EventFeed();
    take(feed, RWS1_LOG, { offsetMs: -(2 * 3_600_000 + 3_000) });
    expect(feed.recent()[0].time).toEqual({ raw: '2026-07-09 T 01:18:04', utc: '2026-07-08T23:18:01.000Z', corrected: true });
  });

  it('recorded before the clock was read, are corrected once it is; a time that is no time stays null', () => {
    const feed = new EventFeed();
    take(feed, [...RWS1_LOG, rws1(16, 10002, 'garbled', 'Program pointer has been reset')]);
    const before = feed.recent();
    expect(before.map(e => e.time.corrected)).toEqual([false, false, false]);
    expect(feed.correct(60_000)).toBe(2);
    const after = feed.recent();
    expect(after.find(e => e.seqnum === 17)!.time).toEqual({ raw: '2026-07-09 T 01:18:04', utc: '2026-07-09T01:19:04.000Z', corrected: true });
    expect(after.find(e => e.seqnum === 16)!.time).toEqual({ raw: 'garbled', utc: null, corrected: false });
    // Replaced, never changed: what was handed out before stays as it was.
    expect(before.find(e => e.seqnum === 17)!.time.corrected).toBe(false);
    // Once corrected, a later offset leaves them alone.
    expect(feed.correct(0)).toBe(0);
  });
});

describe('EventFeed text', () => {
  it('drops control characters, keeps line breaks, and cuts long text', () => {
    expect(eventText('  a\u0000b\nc\u0007  ')).toBe('ab\nc');
    const long = 'x'.repeat(EVENT_TEXT_MAX + 50);
    const cut = eventText(long)!;
    expect(cut).toHaveLength(EVENT_TEXT_MAX);
    expect(cut.endsWith('...')).toBe(true);
    expect(eventText('   ')).toBeNull();
    expect(eventText(42)).toBeNull();
  });

  it('caps the values an event carries', () => {
    const feed = new EventFeed();
    const args = Array.from({ length: EVENT_ARGS_MAX + 4 }, (_, i) => ({ type: 'long', value: String(i) }));
    take(feed, [rws1(1, 10140, '2026-09-29 T 08:00:00', 'Speed', { args })]);
    expect(feed.recent()[0].args).toHaveLength(EVENT_ARGS_MAX);
  });
});

describe('EventFeed.page', () => {
  const filled = (n: number) => {
    const feed = new EventFeed('feed-1');
    for (let i = 1; i <= n; i++) {
      take(feed, [rws1(i, 10011, `2026-09-29 T 08:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`, 'Motors ON state')]);
    }
    return feed;
  };

  it('without since: the newest `limit`, oldest first', () => {
    const p = filled(30).page(undefined, 5);
    expect(p).toMatchObject({ feed: 'feed-1', firstSeq: 1, lastSeq: 30, gap: false, more: false });
    expect(p.events.map(e => e.seq)).toEqual([26, 27, 28, 29, 30]);
  });

  it('with since: the events after it, a page at a time', () => {
    const feed = filled(30);
    const first = feed.page(10, 8);
    expect(first.events.map(e => e.seq)).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
    expect(first).toMatchObject({ gap: false, more: true });
    const last = feed.page(first.events.at(-1)!.seq, 50);
    expect(last.events.map(e => e.seq)).toEqual([19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    expect(last.more).toBe(false);
    expect(feed.page(30, 10).events).toEqual([]);
    expect(feed.page(500, 10)).toMatchObject({ events: [], gap: false, more: false, lastSeq: 30 });
  });

  it('says so when events after since were dropped from memory', () => {
    const feed = filled(EVENTS_KEEP_MAX + 20);
    const p = feed.page(3, 5);
    expect(p.gap).toBe(true);
    expect(p.events[0].seq).toBe(21);
    expect(feed.page(20, 5).gap).toBe(false);
  });
});

describe('eventsGroup', () => {
  const view = (over: Partial<EventsView> = {}): EventsView => {
    const feed = new EventFeed('feed-1');
    take(feed, RWS1_LOG, { offsetMs: 0 });
    return { feed, readAt: T0 - 30_000, caughtUp: true, error: null, clock: { offsetMs: 0, measuredAt: T0 - 60_000, problem: null }, ...over };
  };

  it('while the subscription delivers and the log was read since, the list is current now', () => {
    const g = eventsGroup(view(), { quality: 'live', ready: true }, true, T0);
    expect(g).toMatchObject({ feed: 'feed-1', lastSeq: 2, via: 'subscription', asOf: new Date(T0).toISOString(), error: null });
    expect(g.clock).toEqual({ offsetMs: 0, measuredAt: new Date(T0 - 60_000).toISOString(), problem: null });
    expect(g.recent.map(e => e.seq)).toEqual([1, 2]);
  });

  it('before the catch-up read, and while polling, the list is as of the last read', () => {
    expect(eventsGroup(view({ caughtUp: false }), { quality: 'live', ready: true }, true, T0).asOf).toBe(new Date(T0 - 30_000).toISOString());
    expect(eventsGroup(view(), { quality: 'polling', ready: true }, true, T0)).toMatchObject({ via: 'poll', asOf: new Date(T0 - 30_000).toISOString() });
  });

  it('a link that cannot feed the log: no via, the list frozen as of its last read', () => {
    expect(eventsGroup(view(), { quality: 'stale', ready: false }, true, T0)).toMatchObject({ via: null, asOf: new Date(T0 - 30_000).toISOString(), lastSeq: 2 });
  });

  it('carries the newest EVENTS_RECENT_MAX', () => {
    const feed = new EventFeed();
    take(feed, Array.from({ length: 40 }, (_, i) => rws1(40 - i, 10011, `2026-09-29 T 08:00:${String(40 - i).padStart(2, '0')}`, 'Motors ON state')));
    const g = eventsGroup(view({ feed }), { quality: 'live', ready: true }, true, T0);
    expect(g.recent).toHaveLength(EVENTS_RECENT_MAX);
    expect(g.recent.at(-1)!.seq).toBe(40);
  });

  it('carries nothing from a link on the wrong controller, or before the reader exists', () => {
    const empty = { feed: null, lastSeq: 0, recent: [], via: null, clock: { offsetMs: null, measuredAt: null, problem: null }, asOf: null, error: null };
    expect(eventsGroup(view(), { quality: 'live', ready: false }, false, T0)).toEqual(empty);
    expect(eventsGroup(null, { quality: 'live', ready: true }, true, T0)).toEqual(empty);
  });

  it('a signature that ignores asOf moving on, but not its first setting', () => {
    const a = eventsGroup(view(), { quality: 'live', ready: true }, true, T0);
    const b = eventsGroup(view(), { quality: 'live', ready: true }, true, T0 + 5_000);
    expect(eventsSignature(a)).toBe(eventsSignature(b));
    expect(eventsSignature(eventsGroup(view({ readAt: null }), { quality: 'live', ready: true }, true, T0))).not.toBe(eventsSignature(a));
  });
});

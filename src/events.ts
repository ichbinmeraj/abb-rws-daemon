import { randomUUID } from 'node:crypto';
import type { ElogMessage } from 'abb-rws-client';
import {
  EVENTS_KEEP_MAX, EVENTS_PAGE_MAX, EVENTS_RECENT_MAX, EVENT_TEXT_MAX,
  type ControllerEvent, type EventTime, type EventsGroup, type EventsPage, type Generation, type GroupError, type LinkQuality,
} from './schema/v0.js';

/**
 * The controller's event log: the pure half - what the log's
 * listings become in the snapshot and in `GET .../events`. The reader (the
 * clock reads, its own reads of the log, taking the manager's) lives in the
 * fleet (`ControllerFleet`), like the motion sampler and the I/O watcher.
 *
 * Every listing is the whole log as far as the client reads it: the manager
 * reads it again on every message the controller announces and on its slow
 * poll, and the reader reads it once per connection and while no
 * subscription delivers. So a listing that comes late, or repeats one before
 * it, adds nothing twice: each message is recorded once, by its key.
 */

/** While no subscription delivers, the log is read at least this far apart (ms). */
export const EVENTS_POLL_MS = 5_000;

/**
 * While the subscription delivers, the log is read again when no listing has
 * come for this long (ms): a stream that dropped and came back without the
 * link saying so is caught up within about this long.
 */
export const EVENTS_RECHECK_MS = 60_000;

/** RWS 2.0 serves the log this many messages per page, one request per page; RWS 1.0 answers in one request. */
export const EVENTS_RWS2_PAGE = 50;

/** RWS 1.0 counts event sequence numbers in 16 bits: after 65,535 the count starts again. */
export const RWS1_SEQNUM_SPAN = 65_536;

/**
 * Message keys remembered per controller, so a message still listed is never
 * recorded twice: at least this many, and twice the longest listing seen, up
 * to EVENT_KEYS_MAX. The keys of the messages listed last are the last to go.
 */
export const EVENT_KEYS_MIN = 2_048;
export const EVENT_KEYS_MAX = 16_384;

/** An event carries at most this many substituted values, each at most EVENT_ARG_TEXT_MAX characters. */
export const EVENT_ARGS_MAX = 16;
export const EVENT_ARG_TEXT_MAX = 256;

/**
 * How long (ms) until the reader reads the log itself again after a listing,
 * by how new messages reach it (`via`) and how many requests one read costs
 * (eventsReadRequests). While polling: EVENTS_POLL_MS, stretched to a second
 * per request, so a long RWS 2.0 log costs about a request a second at most.
 * While the subscription delivers: EVENTS_RECHECK_MS, stretched to ten
 * seconds per request.
 */
export function eventsReadIntervalMs(via: 'subscription' | 'poll', requests: number): number {
  const n = Math.max(1, requests);
  return via === 'poll' ? Math.max(EVENTS_POLL_MS, n * 1_000) : Math.max(EVENTS_RECHECK_MS, n * 10_000);
}

/** The requests one read of a log this long costs: one page of EVENTS_RWS2_PAGE per request on RWS 2.0, one on RWS 1.0. */
export function eventsReadRequests(generation: Generation | null, listed: number): number {
  return generation === 'rws2' ? Math.max(1, Math.ceil(listed / EVENTS_RWS2_PAGE)) : 1;
}

/** Delay (ms) before a failed read - of the log or the clock - is tried again, after n failures: 5, 10, 20, 40, then every 60 s. */
export function eventsRetryMs(failures: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * A controller's date and time as it reports them, in ms - the reading taken
 * as if the controller's clock ran on UTC - or null when it is no date and
 * time. The controllers seen so far write "2026-07-09 T 01:29:56" (both
 * generations, event times and the clock alike); the ISO 8601 spellings, a
 * fraction of a second and a zone are read as well, and a zone given is
 * applied.
 */
export function parseControllerTime(raw: string | null | undefined): number | null {
  const m = typeof raw === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})\s*T?\s*(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(raw.trim())
    : null;
  if (!m) { return null; }
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, s, m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0);
  const back = new Date(t);
  // A day or an hour out of range rolls over in Date.UTC: refuse it instead.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) { return null; }
  const zone = m[8] ? /^([+-])(\d{2}):?(\d{2})$/.exec(m[8]) : null;
  if (!zone) { return t; }
  const shift = (Number(zone[2]) * 60 + Number(zone[3])) * 60_000;
  return zone[1] === '+' ? t - shift : t + shift;
}

/**
 * The controller clock's offset (ms): the daemon's UTC time minus the
 * controller's reading, taken at the middle of the request that read it; null
 * when the reading is no date and time. It holds the controller's zone and
 * its clock's error together. The reading counts whole seconds, and so do
 * event times: each is cut to the second, which makes the offset up to a
 * second larger than the true one and each event time up to a second
 * smaller. The two cancel on average, so a corrected time is good to about a
 * second.
 */
export function clockOffsetMs(reading: string | null | undefined, sentAt: number, answeredAt: number): number | null {
  const at = parseControllerTime(reading);
  return at === null ? null : Math.round((sentAt + answeredAt) / 2 - at);
}

/**
 * Which of two sequence numbers comes later: negative when `a` is earlier,
 * positive when later, 0 when equal. With `wrap` (RWS 1.0) they are 16-bit
 * serial numbers: `a` is later when it is less than half the span ahead of
 * `b`, counting on past 65,535 - so 2 follows 65,534, and a number lower than
 * the last seen by more than 32,768 is the newer one. RW 6.13.02 wrapped the
 * count at 2^16 in listings and events (ABB tech-community thread 10673; the
 * 6.13.04 notes list "Elog Issue using RWS on IRC5" first under Corrections,
 * title only, with PDD14543 first in the column of ids printed beside the
 * titles - the pairing is by position; ABB RobotWare release notes 6.13.04
 * p.3; release notes, 2026-09-29).
 * Without `wrap`, plainly.
 */
export function compareSeqnum(a: number, b: number, wrap: boolean): number {
  if (!wrap) { return a - b; }
  const ahead = (((a - b) % RWS1_SEQNUM_SPAN) + RWS1_SEQNUM_SPAN) % RWS1_SEQNUM_SPAN;
  if (ahead === 0) { return 0; }
  return ahead < RWS1_SEQNUM_SPAN / 2 ? 1 : -1;
}

/** Control characters other than a tab or a line break; they are dropped from controller text. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Controller text as an event carries it: trimmed, without control characters, cut at `max` (ending "..."); null when there is none. */
export function eventText(text: unknown, max: number = EVENT_TEXT_MAX): string | null {
  if (typeof text !== 'string') { return null; }
  const t = text.replace(CONTROL, '').trim();
  if (t.length === 0) { return null; }
  return t.length > max ? `${t.slice(0, Math.max(0, max - 3))}...` : t;
}

/**
 * Severity comes from the message's `msgtype` alone: 1 info, 2 warning,
 * 3 error, anything else null. The client reports 0 where the controller
 * omitted or mangled the field (inferred, title only: "RWS Elog Message Get
 * missing response parameter" is a 6.15.04 correction, and which parameter
 * or from which build is not stated; ABB RobotWare release notes 6.15.04 §4
 * Corrections, in the cumulative 6.15.08 notes p.10; release notes,
 * 2026-09-29), and 0 is unknown, never information.
 *
 * There is no table from event code to severity, and none may be added:
 * codes and their weights change with the RobotWare version. RW 6.05
 * renumbered 20200-20269 and 20306-20320 to 90200-90269 and 90306-90320,
 * RW 6.09 moved 10274/10275 to 37274/37275, and RW 7.20 reclassified 50027
 * from information to error (ABB RobotWare release notes 6.05.0129 p.21,
 * 6.09.0154 p.11, 7.20.0 §2.10 p.6; release notes, 2026-09-29). For the
 * same reason a message is told from another by its sequence number (with
 * its code and time, against a count that comes round again), never by its
 * code alone: see EventFeed.
 */
const SEVERITY: Record<number, ControllerEvent['severity']> = { 1: 'info', 2: 'warning', 3: 'error' };

/** The severity a message type names, or null for 0 (unknown) and anything else. */
export function severityOf(msgtype: unknown): ControllerEvent['severity'] {
  return typeof msgtype === 'number' ? SEVERITY[msgtype] ?? null : null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A listing's message, reduced to what ordering and keys need. */
interface Listed {
  msg: ElogMessage;
  seqnum: number | null;
  code: number | null;
  raw: string | null;
  /** `raw` as ms (parseControllerTime); null when it is no date and time. */
  at: number | null;
}

/**
 * The sequence number of a listed message, or null when it has none. The
 * client reports a missing one as 0. On RWS 1.0 every message carries one and
 * the count may pass 0 when it starts again, so 0 is a number there.
 */
function seqnumOf(m: ElogMessage, generation: Generation | null): number | null {
  const n = m.seqnum;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) { return null; }
  return n > 0 || generation === 'rws1' ? n : null;
}

/**
 * A listing oldest first. By sequence number when every message has one
 * (wrap-aware on RWS 1.0); else by time when every message has one; else in
 * the order listed - newest first on RWS 1.0, oldest first on RWS 2.0.
 */
function oldestFirst(listing: readonly ElogMessage[], generation: Generation | null): Listed[] {
  const listed = listing.map((msg): Listed => {
    const raw = eventText(msg.timestamp, 64);
    return {
      msg,
      seqnum: seqnumOf(msg, generation),
      code: typeof msg.code === 'number' && Number.isInteger(msg.code) && msg.code > 0 ? msg.code : null,
      raw,
      at: parseControllerTime(raw),
    };
  });
  if (generation === 'rws1') { listed.reverse(); }
  const wrap = generation === 'rws1';
  if (listed.every(l => l.seqnum !== null)) { return listed.sort((a, b) => compareSeqnum(a.seqnum!, b.seqnum!, wrap)); }
  if (listed.every(l => l.at !== null)) { return listed.sort((a, b) => a.at! - b.at!); }
  return listed;
}

/** Event time from a controller reading (ms, or null) and the clock offset known (or null). */
function eventTime(raw: string | null, at: number | null, offsetMs: number | null): EventTime {
  if (at === null) { return { raw, utc: null, corrected: false }; }
  return offsetMs === null ? { raw, utc: iso(at), corrected: false } : { raw, utc: iso(at + offsetMs), corrected: true };
}

/** One recorded event, with its controller time in ms (for a later correction). Never changed once made: replaced. */
interface Held {
  event: ControllerEvent;
  at: number | null;
}

/** How a listing is taken (EventFeed.take). */
export interface TakeContext {
  /** The generation the link speaks: RWS 1.0 numbers wrap, and list newest first. */
  generation: Generation | null;
  /** The controller clock's offset known now (ms); null: events are recorded uncorrected. */
  offsetMs: number | null;
  /** When the listing was received (ms). */
  at: number;
  /**
   * The listing is an answer the reader asked for itself: an empty one means
   * an empty log. The manager's listing is empty before its first read and
   * after a failed one, so an empty one from it means nothing.
   */
  complete: boolean;
}

/**
 * One controller's event history: the events recorded, their numbering
 * (`seq`), and the keys of every message seen. A message's key is its
 * sequence number with its code and time - a number that comes round again
 * (the RWS 1.0 wrap, a log that starts over after a reset) carries another
 * time - or, for a message without a number, its code, time, source and
 * values with how many alike came before it in the listing.
 */
export class EventFeed {
  /** Names this numbering; a new feed starts `seq` at 1 again. */
  readonly id: string;
  private held: Held[] = [];
  private nextSeq = 1;
  /** Message keys seen, the longest-unlisted first. */
  private readonly seen = new Set<string>();
  private keyCap = EVENT_KEYS_MIN;
  private primed = false;

  constructor(id: string = randomUUID()) { this.id = id; }

  /** The `seq` of the newest event recorded; 0 before the first. */
  get lastSeq(): number { return this.nextSeq - 1; }
  /** The oldest `seq` still held; 0 when none is. */
  get firstSeq(): number { return this.held[0]?.event.seq ?? 0; }
  /** How many events are held. */
  get size(): number { return this.held.length; }
  /** How many message keys are remembered. */
  get keysHeld(): number { return this.seen.size; }
  /** A listing has been taken (or an empty log read): what is recorded from now on is no longer backlog. */
  get isPrimed(): boolean { return this.primed; }

  /**
   * Take one listing of the log: record, in the controller's order, every
   * message not seen before, and return how many. The first listing taken is
   * the backlog; only its newest EVENTS_KEEP_MAX are recorded, and so of any
   * listing that brings more new ones than that at once.
   */
  take(listing: readonly ElogMessage[], ctx: TakeContext): number {
    if (listing.length === 0) {
      if (ctx.complete) { this.primed = true; }
      return 0;
    }
    const alike = new Map<string, number>();
    const keyed = oldestFirst(listing, ctx.generation).map(l => {
      if (l.seqnum !== null) { return { l, key: `#${l.seqnum}|${l.code}|${l.raw}` }; }
      const values = Array.isArray(l.msg.args) ? l.msg.args.map(a => String(a?.value ?? '')).join('\u0001') : '';
      const base = `~${l.code}|${l.raw}|${l.msg.srcName ?? ''}|${values}`;
      const n = (alike.get(base) ?? 0) + 1;
      alike.set(base, n);
      return { l, key: `${base}|${n}` };
    });
    const fresh: Listed[] = [];
    const listed = new Set<string>();
    for (const { l, key } of keyed) {
      // A message a paged read met twice (the log moved on under it) counts once.
      if (!this.seen.has(key) && !listed.has(key)) { fresh.push(l); }
      listed.add(key);
    }
    this.remember(keyed.map(k => k.key));
    const backlog = !this.primed;
    this.primed = true;
    const recorded = fresh.slice(-EVENTS_KEEP_MAX);
    for (const l of recorded) {
      this.held.push({ event: this.eventOf(l, backlog, ctx), at: l.at });
    }
    if (this.held.length > EVENTS_KEEP_MAX) { this.held.splice(0, this.held.length - EVENTS_KEEP_MAX); }
    return recorded.length;
  }

  /**
   * Correct the events recorded before the controller's clock could be read
   * (their time taken as if it ran on UTC) with the offset now measured.
   * Returns how many changed.
   */
  correct(offsetMs: number): number {
    let changed = 0;
    this.held = this.held.map(h => {
      if (h.event.time.corrected || h.at === null) { return h; }
      changed++;
      return { at: h.at, event: { ...h.event, time: eventTime(h.event.time.raw, h.at, offsetMs) } };
    });
    return changed;
  }

  /** The newest `n` events, oldest first. */
  recent(n: number = EVENTS_RECENT_MAX): ControllerEvent[] {
    return this.held.slice(-Math.max(0, n)).map(h => h.event);
  }

  /**
   * A page (EventsPage): without `since` the newest `limit` events; with it,
   * the events after that `seq`, oldest first, at most `limit`.
   */
  page(since: number | undefined, limit: number): EventsPage {
    const n = Math.min(EVENTS_PAGE_MAX, Math.max(1, Math.floor(limit)));
    const base = { feed: this.id, firstSeq: this.firstSeq, lastSeq: this.lastSeq };
    if (since === undefined) {
      return { ...base, gap: false, more: false, events: this.recent(n) };
    }
    const after = this.held.filter(h => h.event.seq > since).map(h => h.event);
    return {
      ...base,
      gap: after.length > 0 && after[0].seq > since + 1,
      more: after.length > n,
      events: after.slice(0, n),
    };
  }

  /** Remember a listing's keys, moving those seen before to the newest place; the longest-unlisted go past the cap. */
  private remember(keys: readonly string[]): void {
    this.keyCap = Math.min(EVENT_KEYS_MAX, Math.max(this.keyCap, 2 * keys.length));
    for (const key of keys) { this.seen.delete(key); this.seen.add(key); }
    for (const key of this.seen) {
      if (this.seen.size <= this.keyCap) { break; }
      this.seen.delete(key);
    }
  }

  private eventOf(l: Listed, backlog: boolean, ctx: TakeContext): ControllerEvent {
    const m = l.msg;
    const given = eventText(m.title);
    // The RWS 2.0 reader writes "Event <code>" where the controller sent no title.
    const titleFromCode = given === null || (l.code !== null && given === `Event ${l.code}`);
    return {
      seq: this.nextSeq++,
      seqnum: l.seqnum,
      code: l.code,
      severity: severityOf(m.msgtype),
      title: titleFromCode ? (l.code !== null ? `Event ${l.code}` : 'Event') : given,
      titleFromCode,
      description: eventText(m.desc),
      causes: eventText(m.causes),
      consequences: eventText(m.consequences),
      actions: eventText(m.actions),
      args: (Array.isArray(m.args) ? m.args : []).slice(0, EVENT_ARGS_MAX).map(a => ({
        type: eventText(a?.type, 32) ?? '',
        value: eventText(a?.value, EVENT_ARG_TEXT_MAX) ?? '',
      })),
      source: eventText(m.srcName, 64),
      time: eventTime(l.raw, l.at, ctx.offsetMs),
      receivedAt: iso(ctx.at),
      backlog,
    };
  }
}

/** What the fleet holds per controller for its event log - all a snapshot needs. */
export interface EventsView {
  feed: EventFeed;
  /** When a listing of the log was last taken (ms), the reader's own or the manager's; null before the first. */
  readAt: number | null;
  /** The reader's own read succeeded since the link's event stream last changed (its catch-up). */
  caughtUp: boolean;
  /** The reader's last read failed; null once a listing is taken. */
  error: GroupError | null;
  /** The controller clock's offset as last measured. */
  clock: { offsetMs: number | null; measuredAt: number | null; problem: string | null };
}

/**
 * The events group. `ready`: the link can feed the log now (connected,
 * healthy, and confirmed to be the controller that was added). A link on the
 * WRONG controller carries none of it (as every group).
 */
export function eventsGroup(
  view: EventsView | null,
  link: { quality: LinkQuality | undefined; ready: boolean },
  trusted: boolean,
  now: number,
): EventsGroup {
  if (!view || !trusted) {
    return { feed: null, lastSeq: 0, recent: [], via: null, clock: { offsetMs: null, measuredAt: null, problem: null }, asOf: null, error: null };
  }
  const via = link.ready ? (link.quality === 'live' ? 'subscription' : 'poll') : null;
  const asOf = view.readAt === null ? null : via === 'subscription' && view.caughtUp ? now : view.readAt;
  return {
    feed: view.feed.id,
    lastSeq: view.feed.lastSeq,
    recent: view.feed.recent(EVENTS_RECENT_MAX),
    via,
    clock: {
      offsetMs: view.clock.offsetMs,
      measuredAt: view.clock.measuredAt !== null ? iso(view.clock.measuredAt) : null,
      problem: view.clock.problem,
    },
    asOf: asOf !== null ? iso(asOf) : null,
    error: view.error,
  };
}

/**
 * What counts as an events change worth announcing: everything but the
 * moving of `asOf` (it separates "not read yet" from a list, as in the stream).
 */
export function eventsSignature(g: EventsGroup): string {
  return JSON.stringify(g, (key, value) => (key === 'asOf' ? value !== null : value));
}

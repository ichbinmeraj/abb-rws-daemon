#!/usr/bin/env node
/**
 * Compares the frame sequences of two recordings (a daemon recording, a
 * stream capture, a capture of a replay): did both see the same stream?
 *
 *   node scripts/compare-recordings.mjs <a.jsonl> <b.jsonl> [--ignore-time] [--timing-ms <ms>]
 *
 * - Frames are compared as consumers apply them: `delta` by type, controller
 *   id, name and groups (deep-equal), `removed` by id. A frame's own
 *   `observedAt` is never compared.
 * - Snapshots are compared as state, not as frames: the first one on each
 *   side is the starting state (when the two start at different moments, as a
 *   capture started during a recording does, the later start is found in the
 *   other's sequence, where it may differ only in groups its own stream
 *   replaces within a second: a consumer that attaches while a change waits to
 *   go out gets the daemon's value of that moment, which the stream can
 *   supersede before sending it; those groups are named in the alignment line,
 *   and the frames that replace them are compared like every other); a later
 *   snapshot (a `resync` the recorder took at a part
 *   boundary or after a gap) must match the other side's state at that point,
 *   each group allowing for changes the daemon had not yet sent (a group may
 *   equal the value the other side receives within a second after).
 * - `--ignore-time` leaves every date-time field (`format: date-time` in the
 *   schema: asOf, since, receivedAt, ...) out of the comparison.
 * - Records marked `masked` on either side are reported in their own section,
 *   not as differences: a recorder knows passwords a stream consumer does not.
 * - Timing: for each compared pair, b's time minus a's, both counted from the
 *   aligned start; median, 95th percentile and largest are printed. With
 *   `--timing-ms`, a pair further apart than that is a difference.
 * - A part whose `end` names a `next` part found beside it is followed.
 *
 * Exit status: 0 when the sequences agree, 1 when they differ or cannot be
 * compared.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function loadDist() {
  try {
    return await import('../dist/replay/clock.js');
  } catch (e) {
    throw new Error(`the daemon is not built (${e instanceof Error ? e.message : String(e)}); run npm run build first, or use npm run compare`);
  }
}
const { TIMED_DEFINITIONS } = await loadDist();

/** How long after a resync snapshot the other side may still receive a change the snapshot already held (ms). */
export const RESYNC_WINDOW_MS = 1000;

/** How many differences are printed. */
const SHOWN = 10;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A recording's frames from its text (one part). A cut last line is ignored;
 * any other line that does not parse is an error.
 */
export function parseRecordingText(text, name = 'recording') {
  const lines = text.split('\n');
  const closed = text.endsWith('\n');
  if (closed) { lines.pop(); }
  let header = null;
  let end = null;
  const frames = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.trim() === '') { continue; }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      if (!closed && i === lines.length - 1) { continue; }   // a part whose writer was killed
      throw new Error(`${name}: line ${i + 1} is not JSON`);
    }
    if (i === 0) {
      if (!isObj(rec) || rec.kind !== 'header' || rec.format !== 'abb-rws-recording') {
        throw new Error(`${name}: the first line is not a recording header`);
      }
      if (rec.formatVersion !== 1) { throw new Error(`${name}: recording format ${String(rec.formatVersion)} is not known here`); }
      header = rec;
      continue;
    }
    if (!isObj(rec)) { continue; }
    if (rec.kind === 'end') { end = rec; }
    if (rec.kind !== 'frame' || !isObj(rec.frame) || typeof rec.frame.type !== 'string') { continue; }
    frames.push({
      line: i + 1,
      t: typeof rec.t === 'number' ? rec.t : 0,
      frame: rec.frame,
      masked: typeof rec.masked === 'number' && rec.masked > 0 ? rec.masked : 0,
      resync: rec.resync === true,
    });
  }
  if (!header) { throw new Error(`${name}: it is empty`); }
  return { header, end, frames };
}

/** A recording file, and the parts after it its `end` records name (when they are beside it). */
export function readRecordingFile(path) {
  const parts = [];
  const seen = new Set();
  let current = resolve(path);
  for (;;) {
    if (seen.has(current)) { break; }
    seen.add(current);
    const part = parseRecordingText(readFileSync(current, 'utf8'), basename(current));
    parts.push({ name: basename(current), ...part });
    const next = part.end && typeof part.end.next === 'string' ? join(dirname(current), basename(part.end.next)) : null;
    if (!next || !existsSync(next)) { break; }
    current = next;
  }
  return {
    name: basename(path),
    header: parts[0].header,
    parts: parts.map(p => p.name),
    frames: parts.flatMap(p => p.frames.map(f => ({ ...f, part: p.name }))),
  };
}

/** A copy with every date-time of a definition (TIMED_DEFINITIONS) set aside. */
function withoutTimes(def, value) {
  if (!isObj(value)) { return value; }
  const shape = TIMED_DEFINITIONS[def];
  if (!shape) { return value; }
  const out = { ...value };
  for (const p of shape.times) {
    if (p in out && out[p] !== null) { out[p] = '<time>'; }
  }
  for (const [p, nested] of Object.entries(shape.nested)) {
    const v = out[p];
    if (nested.array) {
      if (Array.isArray(v)) { out[p] = v.map(item => withoutTimes(nested.def, item)); }
    } else if (isObj(v)) {
      out[p] = withoutTimes(nested.def, v);
    }
  }
  return out;
}

/** JSON with object keys sorted, for comparison. */
function canonical(v) {
  if (Array.isArray(v)) { return `[${v.map(canonical).join(',')}]`; }
  if (isObj(v)) {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The first places two values differ, as paths: `groups.panel.speedRatio: 10 vs 20`. */
function differences(a, b, path = '', out = [], max = 3) {
  if (out.length >= max) { return out; }
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!(k in a)) { out.push({ path: `${path}${k}`, a: '(absent)', b: b[k] }); }
      else if (!(k in b)) { out.push({ path: `${path}${k}`, a: a[k], b: '(absent)' }); }
      else if (canonical(a[k]) !== canonical(b[k])) { differences(a[k], b[k], `${path}${k}.`, out, max); }
      if (out.length >= max) { break; }
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length && out.length < max; i++) {
      if (canonical(a[i]) !== canonical(b[i])) { differences(a[i], b[i], `${path.replace(/\.$/, '')}[${i}].`, out, max); }
    }
    return out;
  }
  out.push({ path: path.replace(/\.$/, '') || '(value)', a, b });
  return out;
}

/** The groups of a controller in a snapshot frame (GroupName of the snapshot schema): each one is compared. */
const GROUP_NAMES = ['identity', 'link', 'panel', 'rapid', 'motion', 'io', 'events', 'access', 'capabilities', 'freshness'];

/** What a frame does to a consumer's state, as compared. */
function view(frame, ignoreTime) {
  if (frame.type === 'delta') {
    const groups = ignoreTime ? withoutTimes('DeltaGroups', frame.groups) : frame.groups;
    return { type: 'delta', id: frame.id, name: frame.name, groups };
  }
  if (frame.type === 'removed') { return { type: 'removed', id: frame.id }; }
  return null;
}

/** A consumer's state: controller id -> { name, groups }, each group as canonical text. */
class FleetState {
  constructor(ignoreTime) { this.ignoreTime = ignoreTime; this.controllers = new Map(); }

  replace(snapshot) {
    this.controllers = new Map();
    for (const c of Array.isArray(snapshot.controllers) ? snapshot.controllers : []) {
      if (!isObj(c) || typeof c.id !== 'string') { continue; }
      const groups = {};
      for (const g of GROUP_NAMES) { if (g in c) { groups[g] = c[g]; } }
      this.set(c.id, c.name, groups, true);
    }
  }

  set(id, name, groups, whole) {
    const entry = whole || !this.controllers.has(id) ? { name, groups: new Map() } : this.controllers.get(id);
    entry.name = name;
    const clean = this.ignoreTime ? withoutTimes('DeltaGroups', groups) : groups;
    for (const [g, v] of Object.entries(clean ?? {})) { entry.groups.set(g, canonical(v)); }
    this.controllers.set(id, entry);
  }

  apply(frame) {
    if (frame.type === 'delta' && typeof frame.id === 'string') { this.set(frame.id, frame.name, frame.groups, false); }
    else if (frame.type === 'removed' && typeof frame.id === 'string') { this.controllers.delete(frame.id); }
    else if (frame.type === 'snapshot') { this.replace(frame); }
  }

  /** A comparable copy. */
  copy() {
    const out = new Map();
    for (const [id, e] of this.controllers) { out.set(id, { name: e.name, groups: new Map(e.groups) }); }
    return out;
  }
}

/**
 * Where two states differ: `rw7.panel`, `rw6 (only in a)`. Empty when they are the same.
 * `laterB`: changes (with their values, changesAfter) the state `a` may already hold.
 * `replaced`: groups (`id#group`, any value; replacedAfter) the state `b`'s own stream
 * replaces soon after, so they may differ; each one let through is added to `allowed`.
 */
function stateDiff(a, b, laterB = null, replaced = null, allowed = null) {
  const out = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id);
    const y = b.get(id);
    if (!x || !y) {
      // A controller added or removed right after the snapshot is a change not yet sent.
      const change = x ? `${id}#appears` : `${id}#disappears`;
      if (laterB?.has(change)) { continue; }
      if (replaced?.has(change)) { allowed?.push(id); continue; }
      out.push(`${id} (only in ${x ? 'a' : 'b'})`);
      continue;
    }
    if (x.name !== y.name && !laterB?.has(`${id}#name:${x.name}`)) {
      if (replaced?.has(`${id}#name`)) { allowed?.push(`${id}.name`); } else { out.push(`${id}.name`); }
    }
    for (const g of new Set([...x.groups.keys(), ...y.groups.keys()])) {
      const xv = x.groups.get(g);
      if (xv === y.groups.get(g)) { continue; }
      if (xv !== undefined && laterB?.has(`${id}#${g}:${xv}`)) { continue; }
      if (replaced?.has(`${id}#${g}`)) { allowed?.push(`${id}.${g}`); continue; }
      out.push(`${id}.${g}`);
    }
  }
  return out;
}

const statesEqual = (a, b) => stateDiff(a, b).length === 0;

/** A recording split into its starting snapshot, the frames that change state, and its later snapshots. */
function sequence(rec, ignoreTime) {
  const events = [];
  const checkpoints = [];
  let start = null;
  let other = 0;
  for (const f of rec.frames) {
    if (f.frame.type === 'snapshot') {
      if (start === null && events.length === 0) { start = f; } else { checkpoints.push({ at: events.length, rec: f }); }
      continue;
    }
    const v = view(f.frame, ignoreTime);
    if (!v) { other++; continue; }
    events.push({ ...f, view: v, key: canonical(v) });
  }
  return { start, events, checkpoints, other };
}

/** Where to start comparing: the states after `p` frames of a and `q` of b agree. */
function align(sa, sb, ignoreTime) {
  const stateAfter = (seq) => {
    const s = new FleetState(ignoreTime);
    if (seq.start) { s.replace(seq.start.frame); }
    return s;
  };
  const a0 = stateAfter(sa);
  const b0 = stateAfter(sb);
  if (statesEqual(a0.controllers, b0.controllers)) { return { p: 0, q: 0, how: 'at the start' }; }
  // One side started later: find its starting state in the other's sequence.
  const search = (seq, state, target) => {
    for (let i = 0; i < seq.events.length; i++) {
      state.apply(seq.events[i].frame);
      if (statesEqual(state.controllers, target.controllers)) { return i + 1; }
    }
    return -1;
  };
  const p = search(sa, stateAfter(sa), b0);
  if (p >= 0) { return { p, q: 0, how: `b starts after a's frame ${p} (b's first snapshot equals a's state there)` }; }
  const q = search(sb, stateAfter(sb), a0);
  if (q >= 0) { return { p: 0, q, how: `a starts after b's frame ${q} (a's first snapshot equals b's state there)` }; }
  // The later start attached while a change waited to go out: its snapshot may hold a value
  // the stream superseded before sending it (a group goes out at most every 250 ms, with its
  // latest value), so no state of the other side equals it. It is found where the other
  // side's state differs only in groups the later side's own stream replaces within
  // RESYNC_WINDOW_MS, and where the other side's next frame is the later side's first.
  const windowed = (seq, later) => {
    const first = later.events[0];
    if (!later.start || !first) { return null; }
    const target = stateAfter(later);
    const replaced = replacedAfter(later, 0, later.start.t, RESYNC_WINDOW_MS);
    const state = stateAfter(seq);
    for (let i = 0; i < seq.events.length; i++) {
      if (i > 0) { state.apply(seq.events[i - 1].frame); }
      if (seq.events[i].key !== first.key) { continue; }
      const allowed = [];
      if (stateDiff(state.controllers, target.controllers, null, replaced, allowed).length === 0) { return { i, allowed }; }
    }
    return null;
  };
  const settled = (list, side) => (list.length > 0
    ? `, except ${list.join(', ')}, which ${side}'s stream replaced within ${RESYNC_WINDOW_MS} ms` : '');
  const wb = windowed(sa, sb);
  if (wb) {
    return { p: wb.i, q: 0, replaced: wb.allowed, how: `b starts after a's frame ${wb.i} (b's first snapshot equals a's state there${settled(wb.allowed, 'b')})` };
  }
  const wa = windowed(sb, sa);
  if (wa) {
    return { p: 0, q: wa.i, replaced: wa.allowed, how: `a starts after b's frame ${wa.i} (a's first snapshot equals b's state there${settled(wa.allowed, 'a')})` };
  }
  // Last resort: the first frame both have.
  if (sb.events.length > 0) {
    const i = sa.events.findIndex(e => e.key === sb.events[0].key);
    if (i >= 0) { return { p: i, q: 0, how: `on b's first frame (found as a's frame ${i + 1}); the starting states differ`, loose: true } }
  }
  if (sa.events.length > 0) {
    const j = sb.events.findIndex(e => e.key === sa.events[0].key);
    if (j >= 0) { return { p: 0, q: j, how: `on a's first frame (found as b's frame ${j + 1}); the starting states differ`, loose: true } }
  }
  return null;
}

/** The changes one side receives within `windowMs` after time `t` (from its event `from` on), as keys stateDiff knows. */
function changesAfter(seq, from, t, windowMs) {
  const keys = new Set();
  for (let i = from; i < seq.events.length && seq.events[i].t <= t + windowMs; i++) {
    const f = seq.events[i].frame;
    if (f.type === 'removed') { keys.add(`${f.id}#disappears`); continue; }
    keys.add(`${f.id}#appears`);
    keys.add(`${f.id}#name:${f.name}`);
    const groups = seq.events[i].view.groups ?? {};
    for (const [g, v] of Object.entries(groups)) { keys.add(`${f.id}#${g}:${canonical(v)}`); }
  }
  return keys;
}

/** The groups one side's stream replaces within `windowMs` after time `t` (from its event `from` on), whatever their value. */
function replacedAfter(seq, from, t, windowMs) {
  const keys = new Set();
  for (let i = from; i < seq.events.length && seq.events[i].t <= t + windowMs; i++) {
    const f = seq.events[i].frame;
    if (f.type === 'removed') { keys.add(`${f.id}#disappears`); continue; }
    keys.add(`${f.id}#appears`);
    keys.add(`${f.id}#name`);
    for (const g of Object.keys(seq.events[i].view.groups ?? {})) { keys.add(`${f.id}#${g}`); }
  }
  return keys;
}

const percentile = (sorted, p) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))]);

/**
 * Compare two read recordings (readRecordingFile / parseRecordingText with a
 * name). Returns everything the report prints; `same` is the verdict.
 */
export function compareRecordings(a, b, opts = {}) {
  const ignoreTime = opts.ignoreTime === true;
  const timingMs = typeof opts.timingMs === 'number' ? opts.timingMs : null;
  const sa = sequence(a, ignoreTime);
  const sb = sequence(b, ignoreTime);
  const result = {
    a: summary(a, sa), b: summary(b, sb),
    aligned: null, startReplaced: [], compared: 0, equal: 0, exact: 0,
    differences: [], masked: [], resync: { checked: 0, failed: 0 },
    extra: { a: 0, b: 0 },
    timing: null, same: false, problem: null,
  };
  const at = align(sa, sb, ignoreTime);
  if (!at) {
    result.problem = 'no common starting point: neither starting state is found in the other recording, and they share no frame';
    return result;
  }
  result.aligned = at.how;
  result.startReplaced = at.replaced ?? [];
  if (at.loose) {
    result.differences.push({ index: 0, what: 'start', detail: 'the starting states differ (aligned on the first frame both have)' });
  }

  // Both states, walked in step, for the later snapshots.
  const stA = new FleetState(ignoreTime);
  const stB = new FleetState(ignoreTime);
  if (sa.start) { stA.replace(sa.start.frame); }
  if (sb.start) { stB.replace(sb.start.frame); }
  for (let i = 0; i < at.p; i++) { stA.apply(sa.events[i].frame); }
  for (let j = 0; j < at.q; j++) { stB.apply(sb.events[j].frame); }

  const n = Math.min(sa.events.length - at.p, sb.events.length - at.q);
  const anchorA = at.p === 0 && at.q === 0 && sa.start && sb.start ? sa.start.t : sa.events[at.p]?.t ?? 0;
  const anchorB = at.p === 0 && at.q === 0 && sa.start && sb.start ? sb.start.t : sb.events[at.q]?.t ?? 0;
  const offsets = [];
  let overTiming = 0;
  const cpA = sa.checkpoints.filter(c => c.at >= at.p);
  const cpB = sb.checkpoints.filter(c => c.at >= at.q);

  const checkpoint = (cp, own, other, otherSeq, otherFrom, side, index) => {
    own.replace(cp.rec.frame);
    result.resync.checked++;
    // The other side's time at this moment, by the aligned clocks.
    const t = side === 'a' ? cp.rec.t - anchorA + anchorB : cp.rec.t - anchorB + anchorA;
    const later = changesAfter(otherSeq, otherFrom, t, RESYNC_WINDOW_MS);
    const diff = stateDiff(own.copy(), other.copy(), later);
    if (diff.length > 0) {
      result.resync.failed++;
      result.differences.push({
        index, what: 'resync', side, line: cp.rec.line, part: cp.rec.part,
        detail: `${side}'s snapshot (line ${cp.rec.line}) does not match ${side === 'a' ? 'b' : 'a'}'s state there: ${diff.slice(0, 5).join(', ')}`,
      });
    }
  };

  for (let k = 0; k <= n; k++) {
    for (const cp of cpA.filter(c => c.at === at.p + k)) { checkpoint(cp, stA, stB, sb, at.q + k, 'a', k); }
    for (const cp of cpB.filter(c => c.at === at.q + k)) { checkpoint(cp, stB, stA, sa, at.p + k, 'b', k); }
    if (k === n) { break; }
    const x = sa.events[at.p + k];
    const y = sb.events[at.q + k];
    stA.apply(x.frame);
    stB.apply(y.frame);
    result.compared++;
    const d = (y.t - anchorB) - (x.t - anchorA);
    offsets.push(d);
    if (timingMs !== null && Math.abs(d) > timingMs) { overTiming++; }
    const equal = x.key === y.key;
    if (JSON.stringify(x.frame) === JSON.stringify(y.frame)) { result.exact++; }
    if (x.masked || y.masked) {
      result.masked.push({
        index: k + 1, type: x.view.type, id: x.view.id, aLine: x.line, bLine: y.line,
        sides: x.masked && y.masked ? 'both' : x.masked ? 'a' : 'b', equal,
      });
      continue;
    }
    if (equal) { result.equal++; continue; }
    const where = x.view.type !== y.view.type || x.view.id !== y.view.id
      ? [{ path: 'frame', a: `${x.view.type} ${x.view.id}`, b: `${y.view.type} ${y.view.id}` }]
      : differences(x.view, y.view);
    result.differences.push({
      index: k + 1, what: 'frame', aLine: x.line, bLine: y.line, type: x.view.type, id: x.view.id,
      detail: where.map(w => `${w.path}: a ${short(w.a)}, b ${short(w.b)}`).join('; '),
    });
  }
  result.extra.a = sa.events.length - at.p - n;
  result.extra.b = sb.events.length - at.q - n;

  const abs = offsets.map(Math.abs).sort((p, q) => p - q);
  const lastA = sa.events[at.p + n - 1];
  const lastB = sb.events[at.q + n - 1];
  result.timing = {
    pairs: offsets.length,
    medianMs: percentile(abs, 0.5),
    p95Ms: percentile(abs, 0.95),
    maxMs: abs.at(-1) ?? 0,
    meanMs: offsets.length ? Math.round((offsets.reduce((s, v) => s + v, 0) / offsets.length) * 10) / 10 : 0,
    over: timingMs === null ? null : overTiming,
    thresholdMs: timingMs,
    totalA: lastA ? lastA.t - anchorA : 0,
    totalB: lastB ? lastB.t - anchorB : 0,
  };
  if (timingMs !== null && overTiming > 0) {
    result.differences.push({ index: 0, what: 'timing', detail: `${overTiming} frame(s) more than ${timingMs} ms apart` });
  }
  result.same = result.differences.length === 0;
  return result;
}

function summary(rec, seq) {
  const count = (type) => rec.frames.filter(f => f.frame.type === type).length;
  return {
    name: rec.name ?? 'recording',
    source: typeof rec.header.source === 'string' ? rec.header.source : 'unknown',
    session: typeof rec.header.session === 'string' ? rec.header.session : 'unknown',
    parts: rec.parts?.length ?? 1,
    frames: rec.frames.length,
    snapshots: count('snapshot'),
    deltas: count('delta'),
    removed: count('removed'),
    resync: rec.frames.filter(f => f.resync).length,
    masked: rec.frames.filter(f => f.masked).length,
    otherTypes: seq.other,
  };
}

function short(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/** The report as lines of text. */
export function formatReport(r) {
  const out = [];
  const side = (k, s) => `${k}: ${s.name} (${s.source}, ${s.session}${s.parts > 1 ? `, ${s.parts} parts` : ''}): ${s.frames} frames`
    + ` - ${s.snapshots} snapshots (${s.resync} resync), ${s.deltas} deltas, ${s.removed} removed, ${s.masked} masked`
    + (s.otherTypes ? `, ${s.otherTypes} of other types (ignored)` : '');
  out.push(side('a', r.a), side('b', r.b));
  if (r.problem) {
    out.push(`cannot compare: ${r.problem}`, 'result: differ');
    return out;
  }
  out.push(`aligned ${r.aligned}`);
  out.push(`compared ${r.compared} frame pairs: ${r.equal} equal (${r.exact} identical as sent), ${r.differences.filter(d => d.what === 'frame').length} differ, ${r.masked.length} masked`);
  if (r.extra.a > 0) { out.push(`a has ${r.extra.a} more frame(s) after b's last`); }
  if (r.extra.b > 0) { out.push(`b has ${r.extra.b} more frame(s) after a's last`); }
  out.push(`resync snapshots compared as state: ${r.resync.checked}, not matching: ${r.resync.failed}`);
  const t = r.timing;
  if (t && t.pairs > 0) {
    out.push(`timing, b - a from the aligned start (ms): median ${t.medianMs}, p95 ${t.p95Ms}, max ${t.maxMs}, mean ${t.meanMs >= 0 ? '+' : ''}${t.meanMs}`
      + (t.over !== null ? `; over ${t.thresholdMs} ms: ${t.over}` : ''));
    const pct = t.totalA > 0 ? ` (${((t.totalB / t.totalA) * 100).toFixed(2)} %)` : '';
    out.push(`span of the compared frames: a ${t.totalA} ms, b ${t.totalB} ms${pct}`);
  }
  if (r.differences.length > 0) {
    out.push('', `differences (first ${Math.min(SHOWN, r.differences.length)} of ${r.differences.length}):`);
    for (const d of r.differences.slice(0, SHOWN)) {
      out.push(d.what === 'frame'
        ? `  #${d.index} ${d.type} ${d.id} (a line ${d.aLine}, b line ${d.bLine}): ${d.detail}`
        : `  ${d.what}${d.index ? ` before #${d.index + 1}` : ''}: ${d.detail}`);
    }
  }
  if (r.masked.length > 0) {
    out.push('', `masked records (reported apart, not differences): ${r.masked.length}`);
    for (const m of r.masked.slice(0, SHOWN)) {
      out.push(`  #${m.index} ${m.type} ${m.id} (a line ${m.aLine}, b line ${m.bLine}): masked in ${m.sides === 'both' ? 'both' : m.sides}`
        + `, ${m.equal ? 'equal' : 'not equal'} as recorded`);
    }
  }
  out.push('', `result: ${r.same ? 'same' : 'differ'}`);
  return out;
}

const USAGE = 'usage: node scripts/compare-recordings.mjs <a.jsonl> <b.jsonl> [--ignore-time] [--timing-ms <ms>]';

/** Run from the command line: returns the exit code. `write` prints a line. */
export function main(argv, write = (line) => process.stdout.write(`${line}\n`)) {
  const files = [];
  let ignoreTime = false;
  let timingMs;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ignore-time') { ignoreTime = true; continue; }
    if (arg === '--timing-ms') {
      timingMs = Number(argv[++i]);
      if (!Number.isFinite(timingMs) || timingMs < 0) { write('--timing-ms needs a number of milliseconds'); write(USAGE); return 1; }
      continue;
    }
    if (arg.startsWith('--')) { write(`unknown argument ${arg}`); write(USAGE); return 1; }
    files.push(arg);
  }
  if (files.length !== 2) { write(USAGE); return 1; }
  let a;
  let b;
  try {
    a = readRecordingFile(files[0]);
    b = readRecordingFile(files[1]);
  } catch (e) {
    write(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const r = compareRecordings(a, b, { ignoreTime, timingMs });
  for (const line of formatReport(r)) { write(line); }
  return r.same ? 0 : 1;
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) { return false; }
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const run = realpathSync(isAbsolute(arg) ? arg : resolve(arg));
    return process.platform === 'win32' ? self.toLowerCase() === run.toLowerCase() : self === run;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}

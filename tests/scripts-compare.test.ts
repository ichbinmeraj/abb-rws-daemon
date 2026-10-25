import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControllerSnapshot, GroupName } from '../src/schema/v0.js';
import { snapshotOf } from './helpers/recording-fakes.js';

interface Read { name: string; header: Record<string, unknown>; frames: unknown[]; parts?: string[] }
interface Report {
  same: boolean; problem: string | null; aligned: string | null; compared: number; equal: number; exact: number;
  differences: { what: string; detail: string; index: number }[];
  masked: { sides: string; equal: boolean; type: string; id: string }[];
  resync: { checked: number; failed: number };
  extra: { a: number; b: number };
  timing: { pairs: number; medianMs: number; maxMs: number; over: number | null } | null;
}
interface CompareModule {
  parseRecordingText(text: string, name?: string): Omit<Read, 'name'>;
  readRecordingFile(path: string): Read;
  compareRecordings(a: Read, b: Read, opts?: { ignoreTime?: boolean; timingMs?: number }): Report;
  formatReport(r: Report): string[];
  main(argv: string[], write?: (line: string) => void): number;
}

let cmp: CompareModule;
let root: string;
beforeAll(async () => {
  cmp = await import('../scripts/compare-recordings.mjs' as string) as CompareModule;
  root = await mkdtemp(join(tmpdir(), 'daemon-compare-'));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const AT = '2026-10-04T15:30:12.345Z';
const later = (ms: number): string => new Date(Date.parse(AT) + ms).toISOString();

interface Line { t: number; frame: Record<string, unknown>; masked?: number; resync?: boolean }

function header(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'header', format: 'abb-rws-recording', formatVersion: 1, schemaVersion: '0.12', source: 'daemon', session: 'rec-test',
    part: 1, previous: null, startedAt: AT, sessionStartedAt: AT, label: null, content: ['frames'], daemon: { version: 't' },
    client: { version: 't' }, controllers: [], limits: null, masking: { rules: [], values: 0, derived: 0, weakValues: 0 }, ...over,
  };
}

const snap = (controllers: ControllerSnapshot[], observedAt = AT) => ({ type: 'snapshot', schemaVersion: '0.12', observedAt, controllers });
const delta = (c: ControllerSnapshot, groups: GroupName[], observedAt = AT) => ({
  type: 'delta', observedAt, id: c.id, name: c.name, groups: Object.fromEntries(groups.map(g => [g, c[g]])),
});
const removed = (id: string) => ({ type: 'removed', observedAt: AT, id });

function text(lines: Line[], over: Record<string, unknown> = {}, end?: Record<string, unknown>): string {
  const recs = [header(over), ...lines.map(l => ({ kind: 'frame', t: l.t, frame: l.frame, ...(l.masked ? { masked: l.masked } : {}), ...(l.resync ? { resync: true } : {}) }))];
  if (end) { recs.push({ kind: 'end', t: lines.at(-1)?.t ?? 0, ...end }); }
  return recs.map(r => JSON.stringify(r)).join('\n') + '\n';
}
const read = (name: string, lines: Line[], over: Record<string, unknown> = {}): Read => ({ name, ...cmp.parseRecordingText(text(lines, over), name) });

const c7 = (speed: number, over: Parameters<typeof snapshotOf>[1] = {}) => snapshotOf('rw7', { sysId: 'SYS-7', check: 'confirmed', speed, ...over });

/** A short stream: a snapshot, then three panel changes 250 ms apart. */
function stream(): Line[] {
  return [
    { t: 3, frame: snap([c7(100)]) },
    { t: 250, frame: delta(c7(10), ['panel'], later(250)) },
    { t: 500, frame: delta(c7(20), ['panel'], later(500)) },
    { t: 750, frame: delta(c7(30), ['panel'], later(750)) },
  ];
}

describe('compare-recordings.mjs', () => {
  it('finds two copies of a stream the same, every frame identical as sent', () => {
    const r = cmp.compareRecordings(read('a', stream()), read('b', stream(), { source: 'stream-capture' }));
    expect(r).toMatchObject({ same: true, problem: null, compared: 3, equal: 3, exact: 3, aligned: 'at the start' });
    expect(r.timing).toMatchObject({ pairs: 3, medianMs: 0, maxMs: 0 });
    expect(cmp.formatReport(r).at(-1)).toBe('result: same');
  });

  it('aligns a capture that started later on the state its first snapshot holds', () => {
    const a = stream();
    const b: Line[] = [
      { t: 2, frame: snap([c7(10)], later(400)) },   // a consumer attaching after a's first delta
      { t: 102, frame: a[2]!.frame },
      { t: 354, frame: a[3]!.frame },
    ];
    const r = cmp.compareRecordings(read('a', a), read('b', b, { source: 'stream-capture' }));
    expect(r.same).toBe(true);
    expect(r.aligned).toMatch(/^b starts after a's frame 1/);
    expect(r.compared).toBe(2);
    expect(r.timing!.maxMs).toBe(2);
  });

  it('aligns a capture whose first snapshot holds a value the stream superseded before sending it', () => {
    // b attached while a panel change waited to go out (15); the stream sent the newer value (20) instead.
    const a = stream();
    const b: Line[] = [
      { t: 2, frame: snap([c7(15)], later(400)) },
      { t: 102, frame: a[2]!.frame },
      { t: 354, frame: a[3]!.frame },
    ];
    const r = cmp.compareRecordings(read('a', a), read('b', b, { source: 'stream-capture' }));
    expect(r.same).toBe(true);
    expect(r.aligned).toMatch(/^b starts after a's frame 1 \(.*except rw7\.panel, which b's stream replaced within 1000 ms\)$/);
    expect(r).toMatchObject({ compared: 2, equal: 2, startReplaced: ['rw7.panel'] });
    expect(r.differences).toEqual([]);

    // The same the other way round.
    const back = cmp.compareRecordings(read('b', b, { source: 'stream-capture' }), read('a', a));
    expect(back).toMatchObject({ same: true, compared: 2, startReplaced: ['rw7.panel'] });
    expect(back.aligned).toMatch(/^a starts after b's frame 1 /);

    // A starting value the stream does not replace soon after is a difference.
    const slow: Line[] = [b[0]!, { t: 2_000, frame: a[2]!.frame }, { t: 2_250, frame: a[3]!.frame }];
    const r2 = cmp.compareRecordings(read('a', a), read('b', slow, { source: 'stream-capture' }));
    expect(r2.same).toBe(false);
    expect(r2.differences[0]).toMatchObject({ what: 'start' });

    // So is a starting group the stream never touches.
    const other: Line[] = [{ t: 2, frame: snap([c7(15, { eventTitle: 'never sent' })], later(400)) }, b[1]!, b[2]!];
    const r3 = cmp.compareRecordings(read('a', a), read('b', other, { source: 'stream-capture' }));
    expect(r3.same).toBe(false);
  });

  it('reports masked records apart, not as differences', () => {
    const a = stream();
    a[2] = { t: 500, frame: delta(c7(20, { eventTitle: 'User logged in with Secret-Pass-1 refused' }), ['panel', 'events'], later(500)) };
    const b = stream();
    b[2] = { t: 500, frame: delta(c7(20, { eventTitle: 'User logged in with *** refused' }), ['panel', 'events'], later(500)), masked: 1 };
    const r = cmp.compareRecordings(read('a', a), read('b', b));
    expect(r.same).toBe(true);
    expect(r.masked).toEqual([expect.objectContaining({ sides: 'b', equal: false, type: 'delta', id: 'rw7' })]);
    expect(r.differences).toEqual([]);
    expect(cmp.formatReport(r).join('\n')).toMatch(/masked records \(reported apart, not differences\): 1/);
  });

  it('compares a resync snapshot as state, not as a frame', () => {
    const plain = stream();
    // The recorder's resync after the first delta: the state then, as a snapshot.
    const withResync: Line[] = [plain[0]!, plain[1]!, { t: 260, frame: snap([c7(10)], later(260)), resync: true }, plain[2]!, plain[3]!];
    const r = cmp.compareRecordings(read('a', withResync), read('b', plain));
    expect(r).toMatchObject({ same: true, compared: 3, resync: { checked: 1, failed: 0 } });

    // A snapshot may already hold a change that goes out a moment later.
    const ahead: Line[] = [plain[0]!, plain[1]!, { t: 400, frame: snap([c7(20)], later(400)), resync: true }, plain[2]!, plain[3]!];
    expect(cmp.compareRecordings(read('a', ahead), read('b', plain))).toMatchObject({ same: true, resync: { checked: 1, failed: 0 } });

    // A snapshot whose state the other side never had is a difference.
    const wrong: Line[] = [plain[0]!, plain[1]!, { t: 260, frame: snap([c7(99)], later(260)), resync: true }, plain[2]!, plain[3]!];
    const r2 = cmp.compareRecordings(read('a', wrong), read('b', plain));
    expect(r2).toMatchObject({ same: false, resync: { checked: 1, failed: 1 } });
    expect(r2.differences[0]).toMatchObject({ what: 'resync' });
    expect(r2.differences[0]!.detail).toMatch(/rw7\.panel/);
  });

  it('compares access, capabilities and freshness of a snapshot like every other group', () => {
    const plain = stream();
    const changes: Record<'access' | 'capabilities' | 'freshness', (c: ControllerSnapshot) => ControllerSnapshot> = {
      access: c => ({ ...c, access: { ...c.access, locks: c.access.locks.map(l => ({ ...l, held: true })) } }),
      capabilities: c => ({ ...c, capabilities: { ...c.capabilities, tested: false } }),
      freshness: c => ({ ...c, freshness: { ...c.freshness, level: 'degraded', reasons: ['access: edit: not read yet'] } }),
    };
    for (const [group, change] of Object.entries(changes)) {
      // A first snapshot that differs in that group alone: the two recordings are not the same.
      const b = stream();
      b[0] = { t: 3, frame: snap([change(c7(100))]) };
      expect(cmp.compareRecordings(read('a', plain), read('b', b)).same, group).toBe(false);
      // A resync snapshot that differs in that group alone: the state the other side never had.
      const withResync: Line[] = [plain[0]!, plain[1]!, { t: 260, frame: snap([change(c7(10))], later(260)), resync: true }, plain[2]!, plain[3]!];
      const r = cmp.compareRecordings(read('a', withResync), read('b', plain));
      expect(r, group).toMatchObject({ same: false, resync: { checked: 1, failed: 1 } });
      expect(r.differences[0]!.detail, group).toContain(`rw7.${group}`);
    }
    // And a delta that carries them is compared whole.
    const a2 = stream();
    a2[2] = { t: 500, frame: delta(c7(20), ['panel', 'access', 'freshness'], later(500)) };
    const b2 = stream();
    b2[2] = { t: 500, frame: delta(changes.access(c7(20)), ['panel', 'access', 'freshness'], later(500)) };
    const r2 = cmp.compareRecordings(read('a', a2), read('b', b2));
    expect(r2.same).toBe(false);
    expect(r2.differences[0]!.detail).toMatch(/^groups\.access\.locks/);
  });

  it('accounts for a controller added or removed, and a resync on either side', () => {
    const c6 = snapshotOf('rw6');
    const a: Line[] = [
      { t: 0, frame: snap([c7(100)]) },
      { t: 100, frame: delta(c6, ['identity', 'link', 'panel', 'rapid', 'motion', 'io', 'events', 'access', 'capabilities', 'freshness']) },
      { t: 200, frame: removed('rw6') },
    ];
    const b: Line[] = [a[0]!, a[1]!, { t: 150, frame: snap([c7(100), c6]), resync: true }, a[2]!];
    const r = cmp.compareRecordings(read('a', a), read('b', b));
    expect(r).toMatchObject({ same: true, compared: 2, resync: { checked: 1, failed: 0 } });
  });

  it('leaves date-times out with --ignore-time', () => {
    const a = stream();
    const b = stream().map((l, i) => (i === 0 ? l : { ...l, frame: delta(c7(i * 10, { observedAt: later(i * 250 + 7) }), ['panel'], later(i * 250 + 7)) }));
    const strict = cmp.compareRecordings(read('a', a), read('b', b));
    expect(strict.same).toBe(false);
    expect(strict.differences[0]!.detail).toMatch(/groups\.panel\.asOf/);
    expect(cmp.compareRecordings(read('a', a), read('b', b), { ignoreTime: true }).same).toBe(true);
  });

  it('names where a frame differs', () => {
    const b = stream();
    b[2] = { t: 500, frame: delta(c7(25), ['panel'], later(500)) };
    const r = cmp.compareRecordings(read('a', stream()), read('b', b));
    expect(r.same).toBe(false);
    expect(r.differences).toHaveLength(1);
    expect(r.differences[0]!.detail).toBe('groups.panel.speedRatio: a 20, b 25');
    expect(r).toMatchObject({ compared: 3, equal: 2 });
  });

  it('prints timing statistics, and fails on them only with --timing-ms', () => {
    const b = stream().map((l, i) => (i >= 2 ? { ...l, t: l.t + 80 } : l));
    const r = cmp.compareRecordings(read('a', stream()), read('b', b));
    expect(r.same).toBe(true);
    expect(r.timing).toMatchObject({ pairs: 3, maxMs: 80, over: null });
    const strict = cmp.compareRecordings(read('a', stream()), read('b', b), { timingMs: 50 });
    expect(strict.same).toBe(false);
    expect(strict.timing!.over).toBe(2);
  });

  it('says so when the two share no starting point', () => {
    const other = [{ t: 0, frame: snap([snapshotOf('rw6')]) }, { t: 10, frame: removed('rw6') }];
    const r = cmp.compareRecordings(read('a', stream()), read('b', other));
    expect(r.same).toBe(false);
    expect(r.problem).toMatch(/no common starting point/);
  });

  it('runs from the command line: files, parts followed, a cut last line, exit 0 or 1', async () => {
    const all = stream();
    const p1 = join(root, 'rec-x-p0001.jsonl');
    const p2 = join(root, 'rec-x-p0002.jsonl');
    await writeFile(p1, text(all.slice(0, 2), { session: 'rec-x' }, { reason: 'rotated', next: 'rec-x-p0002.jsonl' }));
    await writeFile(p2, text([{ t: 300, frame: snap([c7(10)], later(300)), resync: true }, ...all.slice(2)], { session: 'rec-x', part: 2 }));
    const capture = join(root, 'capture.jsonl');
    await writeFile(capture, `${text(all, { source: 'stream-capture' })}{"kind":"frame","t":9`);
    const printed: string[] = [];
    expect(cmp.main([p1, capture, '--ignore-time'], l => printed.push(l))).toBe(0);
    expect(printed.join('\n')).toMatch(/2 parts/);
    expect(printed.at(-1)).toBe('result: same');

    const changed = join(root, 'changed.jsonl');
    const b = stream();
    b[3] = { t: 750, frame: delta(c7(31), ['panel'], later(750)) };
    await writeFile(changed, text(b));
    const out: string[] = [];
    expect(cmp.main([p1, changed], l => out.push(l))).toBe(1);
    expect(out.join('\n')).toMatch(/groups\.panel\.speedRatio: a 30, b 31/);
    expect(cmp.main([p1], () => {})).toBe(1);
    expect(cmp.main([p1, join(root, 'missing.jsonl')], () => {})).toBe(1);
  });
});

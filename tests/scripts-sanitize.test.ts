import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControllerSnapshot } from '../src/schema/v0.js';
import { parseRecording } from '../src/replay/reader.js';
import { redactSecrets } from '../src/errorMap.js';
import { snapshotOf } from './helpers/recording-fakes.js';

interface Sanitized {
  ok: boolean; text?: string; problems?: string[]; warnings?: string[];
  kept?: Record<string, number>; dropped?: Record<string, number>; placeholders?: Record<string, number>;
}
type SanitizeOpts = { keepCalls?: boolean; users?: string[]; own?: { hostname?: string; username?: string } };
interface SanitizeModule {
  sanitizeRecording(text: string, opts?: SanitizeOpts): Sanitized;
  sanitizeParts(texts: string[], opts?: SanitizeOpts): Sanitized & { parts?: { text: string }[] };
  main(argv: string[], write?: (line: string) => void, opts?: { own?: { hostname?: string; username?: string } }): number;
}

let san: SanitizeModule;
let root: string;
beforeAll(async () => {
  san = await import('../scripts/sanitize-recording.mjs' as string) as SanitizeModule;
  root = await mkdtemp(join(tmpdir(), 'daemon-sanitize-'));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

/** The own names the leftover scan looks for, fixed so the tests do not depend on this computer. */
const OWN = { hostname: 'bench-host-42', username: 'tester9' };

const AT = '2026-10-04T15:30:12.345Z';
/** Identifiers a real recording would hold (documentation addresses only). */
const ID = {
  daemonId: 'cellseven', name: 'Cell Seven', controllerName: 'CELL7-CTRL', controllerId: '12-34567', mac: '00-11-22-33-44-55',
  systemName: 'CellSevenSystem', sysId: '{AB12-CD34-EF56}', host: '192.0.2.7', user: 'Operator Anna', discovered: '192.0.2.50',
};

function controller(over: Partial<{ title: string; description: string }> = {}): ControllerSnapshot {
  const c = snapshotOf(ID.daemonId, { sysId: ID.sysId, check: 'confirmed', eventTitle: over.title, eventDescription: over.description });
  c.name = ID.name;
  c.identity = { ...c.identity!, controllerName: ID.controllerName, controllerId: ID.controllerId, mac: ID.mac, systemName: ID.systemName };
  c.link = { ...c.link, host: ID.host, port: 443 };
  return c;
}

function recording(opts: { masking?: unknown; endWeak?: number; title?: string; description?: string } = {}): string {
  const header: Record<string, unknown> = {
    kind: 'header', format: 'abb-rws-recording', formatVersion: 1, schemaVersion: '0.12', source: 'daemon',
    session: 'rec-20261004T153012Z-bench', part: 1, previous: null, startedAt: AT, sessionStartedAt: AT, label: 'bench',
    content: ['frames', 'calls', 'state'], daemon: { version: '0.1.0-dev' }, client: { version: '1.4.0' },
    controllers: [{ id: ID.daemonId, systemId: null, generation: null, robotWare: null }], limits: null,
    masking: { rules: ['keys', 'args', 'text', 'rapid', 'values', 'final'], values: 1, derived: 3, weakValues: 0 },
  };
  if (opts.masking === undefined) { /* as above */ } else if (opts.masking === null) { delete header.masking; } else { header.masking = opts.masking; }
  const c = controller();
  const changed = controller({
    title: opts.title ?? `${ID.systemName} restarted on ${ID.controllerName} at ${ID.host}`,
    description: opts.description ?? `Seen from https://${ID.host}:443/rw/system by ${ID.user}`,
  });
  const recs: Record<string, unknown>[] = [
    header,
    { kind: 'frame', t: 3, frame: { type: 'snapshot', schemaVersion: '0.12', observedAt: AT, controllers: [c] } },
    { kind: 'controller', t: 3, id: ID.daemonId, systemId: ID.sysId, generation: 'rws2', robotWare: '7.21.4+417', identityCheck: 'confirmed' },
    { kind: 'call', t: 20, target: 'setup', id: null, gen: null, seq: 1, method: 'discover', args: [{}, []], ms: 5, ok: true,
      result: { found: [{ host: ID.discovered, port: 443, name: 'Other Cell' }] } },
    { kind: 'call', t: 40, target: 'manager', id: ID.daemonId, gen: 'rws2', seq: 2, method: 'connect',
      args: [ID.host, ID.user, '***', 443, true], ms: 9, ok: true, result: null, masked: 1 },
    { kind: 'call', t: 60, target: 'manager', id: ID.daemonId, gen: 'rws2', seq: 3, method: 'getSystemInfo', args: [], ms: 9, ok: true,
      result: { name: ID.systemName, licencesRaw: 'LICENCE-TEXT-1', productsRaw: 'PRODUCT-TEXT-1', options: ['RobotWare Base'] } },
    { kind: 'state', t: 61, id: ID.daemonId, full: true, changed: { quality: 'live', systemName: ID.systemName } },
    { kind: 'sub', t: 70, id: ID.daemonId, event: { resource: '/rw/iosystem/signals/doA', value: '1' } },
    { kind: 'frame', t: 250, frame: { type: 'delta', observedAt: AT, id: ID.daemonId, name: ID.name, groups: { events: changed.events } } },
    { kind: 'gap', t: 300, why: 'writer-behind', kinds: { call: 1, state: 0, sub: 0 } },
    { kind: 'note', t: 301, text: `recording of ${ID.controllerName}` },
    { kind: 'end', t: 400, reason: 'stopped', records: 12, bytes: 1, dropped: { call: 1, state: 0, sub: 0 },
      masking: { values: 1, derived: 3, weakValues: opts.endWeak ?? 0, maskedRecords: 1, droppedKeys: 0, refusedLines: 0 },
      stats: { stateDiffMsMax: 0 }, next: null },
  ];
  return recs.map(r => JSON.stringify(r)).join('\n') + '\n';
}

const linesOf = (text: string): Record<string, any>[] => text.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));

const EV_AT = { raw: '2026-10-04 15:30:00', utc: '2026-10-04T15:30:00.000Z', corrected: false };
/** One event-log message, as a frame carries it. */
const ev = (seq: number, code: number, title: string, description: string, args: [string, string][]) => ({
  seq, seqnum: seq, code, severity: 'info', title, titleFromCode: false, description, causes: null, consequences: null,
  actions: null, args: args.map(([type, value]) => ({ type, value })), source: null, time: EV_AT, receivedAt: AT, backlog: false,
});

/** A daemon recording part whose one snapshot carries these events, with other records after it. */
function eventPart(events: unknown[], opts: { part?: number; more?: Record<string, unknown>[] } = {}): string {
  const c = controller();
  c.events = { ...c.events!, recent: events as any };
  return [
    { kind: 'header', format: 'abb-rws-recording', formatVersion: 1, schemaVersion: '0.12', source: 'daemon',
      session: 'rec-20261004T153012Z-bench', part: opts.part ?? 1, previous: null, startedAt: AT, sessionStartedAt: AT, label: 'bench',
      content: ['frames', 'calls', 'state'], daemon: { version: '0.1.0-dev' }, client: { version: '1.4.0' },
      controllers: [{ id: ID.daemonId, systemId: null, generation: null, robotWare: null }], limits: null,
      masking: { rules: ['keys', 'args', 'text', 'rapid', 'values', 'final'], values: 1, derived: 3, weakValues: 0 } },
    { kind: 'frame', t: 3, frame: { type: 'snapshot', schemaVersion: '0.12', observedAt: AT, controllers: [c] } },
    ...(opts.more ?? []),
    { kind: 'end', t: 400, reason: 'stopped', records: 4, bytes: 1, dropped: { call: 0, state: 0, sub: 0 },
      masking: { values: 1, derived: 3, weakValues: 0, maskedRecords: 1, droppedKeys: 0, refusedLines: 0 },
      stats: { stateDiffMsMax: 0 }, next: null },
  ].map(r => JSON.stringify(r)).join('\n') + '\n';
}

describe('sanitize-recording.mjs', () => {
  it('keeps frames only by default, with consistent placeholders everywhere, and stays replayable', () => {
    const r = san.sanitizeRecording(recording(), { own: OWN });
    expect(r.problems).toBeUndefined();
    expect(r.ok).toBe(true);
    const out = linesOf(r.text!);
    expect(out.map(l => l.kind)).toEqual(['header', 'frame', 'frame', 'end']);
    expect(r.dropped).toEqual({ controller: 1, call: 3, state: 1, sub: 1, gap: 1, note: 1 });
    const [header, snapshot, delta, end] = out;
    expect(header).toMatchObject({ sanitized: true, content: ['frames'], session: 'rec-20261004T153012Z-bench', label: 'bench' });

    // No identifier is left, in any case.
    const lower = r.text!.toLowerCase();
    for (const v of Object.values(ID)) { expect(lower, v).not.toContain(v.toLowerCase()); }

    // The same placeholder wherever a value occurred.
    const c = snapshot!.frame.controllers[0];
    expect(c.id).toMatch(/^ctrl-\d+$/);
    expect(header!.controllers[0].id).toBe(c.id);
    expect(delta!.frame.id).toBe(c.id);
    expect(c.name).toMatch(/^controller-\d+$/);
    expect(delta!.frame.name).toBe(c.name);
    expect(c.identity).toMatchObject({
      controllerName: expect.stringMatching(/^controller-\d+$/), controllerId: expect.stringMatching(/^controller-id-\d+$/),
      mac: expect.stringMatching(/^mac-\d+$/), systemName: expect.stringMatching(/^system-\d+$/), sysId: expect.stringMatching(/^sysid-\d+$/),
    });
    expect(c.identity.controllerName).not.toBe(c.name);
    expect(c.link.host).toMatch(/^host-\d+$/);
    expect(c.link.identityCheck).toMatchObject({ expected: c.identity.sysId, actual: c.identity.sysId });
    const event = delta!.frame.groups.events.recent[0];
    expect(event.title).toBe(`${c.identity.systemName} restarted on ${c.identity.controllerName} at ${c.link.host}`);
    expect(event.description).toBe(`Seen from https://${c.link.host}:443/rw/system by user-1`);

    // The end record counts the file as written.
    const text = r.text!;
    expect(end).toMatchObject({ kind: 'end', records: 4, bytes: Buffer.byteLength(text.slice(0, text.lastIndexOf('{"kind":"end"')), 'utf8') });

    const rec = parseRecording([{ name: 'fixture.jsonl', text }]);
    expect(rec.frames).toHaveLength(2);
  });

  it('with --keep-calls keeps the other kinds but never setup calls or licence and product texts', () => {
    const r = san.sanitizeRecording(recording(), { keepCalls: true, own: OWN });
    expect(r.ok).toBe(true);
    const out = linesOf(r.text!);
    expect(out.map(l => l.kind)).toEqual(['header', 'frame', 'controller', 'call', 'call', 'state', 'sub', 'frame', 'gap', 'note', 'end']);
    expect(r.dropped).toEqual({ call: 1 });
    expect(out.filter(l => l.kind === 'call').map(l => l.method)).toEqual(['connect', 'getSystemInfo']);
    expect(out[0]).toMatchObject({ sanitized: true, content: ['frames', 'calls', 'state'] });
    expect(r.text).not.toMatch(/licencesRaw|productsRaw|LICENCE-TEXT|PRODUCT-TEXT/);
    const connect = out[3]!;
    expect(connect.args).toEqual([expect.stringMatching(/^host-\d+$/), 'user-1', '***', 443, true]);
    expect(out[2]!.systemId).toBe(out[1]!.frame.controllers[0].identity.sysId);
    expect(out[9]!.text).toBe(`recording of ${out[1]!.frame.controllers[0].identity.controllerName}`);
    const lower = r.text!.toLowerCase();
    for (const v of Object.values(ID)) { expect(lower, v).not.toContain(v.toLowerCase()); }
  });

  it('replaces login names from event-log args, credentials and passport reads everywhere, free text included', async () => {
    const recent = [
      ev(1, 10400, 'User Admin logged on', 'User Admin logged on using RobAPI2-Client.', [['string', 'Admin'], ['string', 'RobAPI2-Client']]),
      ev(2, 10040, 'Program loaded', 'A program has been loaded into task T_ROB1by Default User.',
        [['string', 'T_ROB1'], ['string', 'Default User'], ['long', '3936']]),
      ev(3, 10064, 'A module has been erased.', 'Module ZZ_TEST in task T_ROB1 has been erased by DEFAULT USER.',
        [['string', 'ZZ_TEST'], ['string', 'T_ROB1'], ['string', 'Default User']]),
      ev(4, 10140, 'Parameter changed', 'A configuration parameter has been changed in domain: SYS by Default User.',
        [['long', '100'], ['string', 'Default User']]),
      ev(5, 10401, 'User Admin logged off', 'User Admin using RobAPI2-Client logged off. Administrators were told.',
        [['string', 'Admin'], ['string', 'RobAPI2-Client']]),
      ev(6, 10010, 'Motors ON state', 'Set by Night Shift.', []),
    ];
    const c = controller();
    c.events = { ...c.events!, recent: recent as any };
    const text = [
      { kind: 'header', format: 'abb-rws-recording', formatVersion: 1, schemaVersion: '0.12', source: 'stream-capture', startedAt: AT,
        content: ['frames'], controllers: [{ id: ID.daemonId, systemId: null, generation: null, robotWare: null }],
        masking: { rules: ['text', 'values', 'final'], values: 0, derived: 0, weakValues: 0 } },
      { kind: 'frame', t: 3, frame: { type: 'snapshot', schemaVersion: '0.12', observedAt: AT, controllers: [c] } },
      { kind: 'call', t: 20, target: 'setup', id: null, gen: null, seq: 1, method: 'identifyCandidate',
        args: [ID.host, 443, 'Passport Reader', '***', true], ms: 5, ok: true, result: null, masked: 1 },
      { kind: 'end', t: 400, reason: 'duration', records: 4, bytes: 1 },
    ].map(r => JSON.stringify(r)).join('\n') + '\n';

    const r = san.sanitizeRecording(text, { own: OWN });
    expect(r.problems).toBeUndefined();
    expect(r.placeholders).toMatchObject({ user: 3 });
    for (const name of ['admin', 'default user', 'passport reader']) {
      expect(r.text!.toLowerCase(), name).not.toMatch(new RegExp(`(?<![a-z0-9])${name}(?![a-z0-9])`));
    }
    const events = linesOf(r.text!)[1]!.frame.controllers[0].events.recent;
    const users = new Set<string>();
    for (const e of events) { for (const a of e.args) { if (/^user-\d+$/.test(a.value)) { users.add(a.value); } } }
    expect([...users].sort()).toEqual(['user-1', 'user-2']);
    const admin = events[0].args[0].value;
    const def = events[1].args[1].value;
    expect(events[0]).toMatchObject({ title: `User ${admin} logged on`, description: `User ${admin} logged on using RobAPI2-Client.` });
    expect(events[1].description).toBe(`A program has been loaded into task T_ROB1by ${def}.`);
    expect(events[2].description).toBe(`Module ZZ_TEST in task T_ROB1 has been erased by ${def}.`);
    expect(events[2].args[2].value).toBe(def);
    expect(events[3].args[1].value).toBe(def);
    expect(events[4].description).toBe(`User ${admin} using RobAPI2-Client logged off. Administrators were told.`);
    // A name in an event the sanitizer cannot place stays, unless it is named with --user.
    expect(events[5].description).toBe('Set by Night Shift.');
    const named = san.sanitizeRecording(text, { own: OWN, users: ['night shift'] });
    expect(linesOf(named.text!)[1]!.frame.controllers[0].events.recent[5].description).toMatch(/^Set by user-\d+\.$/);

    const input = join(root, 'logins.jsonl');
    await writeFile(input, text);
    const printed: string[] = [];
    expect(san.main([input, '--out', join(root, 'logins-clean.jsonl'), '--user', 'Night Shift'], l => printed.push(l), { own: OWN })).toBe(0);
    expect(printed[0]).toMatch(/placeholders .*user 4/);
    expect(await readFile(join(root, 'logins-clean.jsonl'), 'utf8')).not.toMatch(/Night Shift|Admin\b|Default User/i);
    expect(san.main([input, '--out', join(root, 'x.jsonl'), '--user'], () => {}, { own: OWN })).toBe(1);
  });

  it('never rewrites keys, and replaces a login name that is a common word only where a whole text is that name', () => {
    const text = eventPart([
      ev(1, 10400, 'User service logged on', 'User service logged on using RobAPI2-Client.', [['string', 'service'], ['string', 'RobAPI2-Client']]),
      ev(2, 10010, 'Motors ON state', 'The service interval is due.', []),
    ], { more: [
      { kind: 'call', t: 40, target: 'manager', id: ID.daemonId, gen: 'rws2', seq: 2, method: 'connect',
        args: [ID.host, 'service', '***', 443, true], ms: 9, ok: true, result: null, masked: 1 },
      { kind: 'state', t: 61, id: ID.daemonId, full: true, changed: { service: 'due', quality: 'live' } },
    ] });
    const r = san.sanitizeRecording(text, { keepCalls: true, own: OWN });
    expect(r.problems).toBeUndefined();
    const out = linesOf(r.text!);
    const events = out[1]!.frame.controllers[0].events.recent;
    expect(events[0].args[0].value).toMatch(/^user-\d+$/);
    expect(out.find(l => l.kind === 'call')!.args[1]).toBe(events[0].args[0].value);
    expect(events[1].description).toBe('The service interval is due.');
    expect(out.find(l => l.kind === 'state')!.changed).toEqual({ service: 'due', quality: 'live' });
    // Left in its own message, and said so: naming it with --user replaces it inside texts too.
    expect(events[0].title).toBe('User service logged on');
    expect(r.warnings!.join('\n')).toMatch(/"service" .*--user/);
    const named = san.sanitizeRecording(text, { keepCalls: true, users: ['service'], own: OWN });
    const namedOut = linesOf(named.text!);
    expect(namedOut[1]!.frame.controllers[0].events.recent[0].title).toMatch(/^User user-\d+ logged on$/);
    expect(namedOut.find(l => l.kind === 'state')!.changed).toEqual({ service: 'due', quality: 'live' });
    expect(named.warnings ?? []).toEqual([]);
    // A one-letter login name is treated the same way.
    const short = san.sanitizeRecording(eventPart([ev(1, 10400, 'User a logged on', 'a b c', [['string', 'a']])]), { own: OWN });
    expect(linesOf(short.text!)[1]!.frame.controllers[0].events.recent[0]).toMatchObject({ title: 'User a logged on', description: 'a b c' });
    expect(short.warnings!.join('\n')).toMatch(/"a" /);
  });

  it('a number where an event carries a login name is not a login name', () => {
    // One controller's 10040 carries numbers ahead of the task name.
    const text = eventPart([ev(1, 10040, 'Program loaded', 'Loaded into T_ROB1 by 0.', [['long', '0'], ['long', '0'], ['string', 'T_ROB1']])]);
    const r = san.sanitizeRecording(text, { own: OWN });
    expect(r.problems).toBeUndefined();
    expect(r.warnings).toEqual([]);
    expect(r.placeholders!.user).toBeUndefined();
    const e = linesOf(r.text!)[1]!.frame.controllers[0].events.recent[0];
    expect(e.args.map((a: { value: string }) => a.value)).toEqual(['0', '0', 'T_ROB1']);
    expect(e.description).toBe('Loaded into T_ROB1 by 0.');
  });

  it('replaces a RobotWare 8 holder`s station name, in the lock and in every text', () => {
    const station = 'Line Three Station';
    const c = controller({ description: `Write access taken by ${station}` });
    c.access = {
      ...c.access!, generation: 'rw8', model: 'writeaccess',
      locks: [{ ...c.access!.locks[0]!, lock: 'writeaccess', held: true, holder: { kind: 'station', name: station, application: null, flexPendant: false } }],
    };
    const text = eventPart([], { more: [{ kind: 'frame', t: 9, frame: { type: 'delta', observedAt: AT, id: ID.daemonId, name: ID.name,
      groups: { access: c.access, events: c.events } } }] });
    const r = san.sanitizeRecording(text, { own: OWN });
    expect(r.problems).toBeUndefined();
    expect(r.placeholders).toMatchObject({ station: 1 });
    expect(r.text!.toLowerCase()).not.toContain(station.toLowerCase());
    const delta = linesOf(r.text!)[2]!.frame.groups;
    expect(delta.access.locks[0].holder).toEqual({ kind: 'station', name: 'station-1', application: null, flexPendant: false });
    expect(delta.events.recent[0].description).toBe('Write access taken by station-1');
  });

  it('refuses a key that still holds an identifier, since keys are never rewritten', () => {
    const text = eventPart([], { more: [{ kind: 'note', t: 301, text: 'x', [`seen-${ID.controllerName}`]: true }] });
    const r = san.sanitizeRecording(text, { keepCalls: true, own: OWN });
    expect(r.ok).toBe(false);
    expect(r.problems!.join('\n')).toMatch(/a note record has a key holding an identifier/);
  });

  it('numbers placeholders the same across the parts of one recording', async () => {
    const admin = ev(1, 10400, 'User Admin logged on', 'User Admin logged on.', [['string', 'Admin']]);
    const def = ev(2, 10040, 'Program loaded', 'Loaded by Default User.', [['string', 'T_ROB1'], ['string', 'Default User']]);
    const part1 = eventPart([admin, def], { part: 1 });
    const part2 = eventPart([def], { part: 2 });
    const r = san.sanitizeParts([part2, part1], { own: OWN });   // in any order
    expect(r.problems).toBeUndefined();
    expect(r.placeholders).toMatchObject({ user: 2 });
    const [out2, out1] = r.parts!.map(p => linesOf(p.text)[1]!.frame.controllers[0]);
    expect(out1.events.recent[0].args[0].value).toBe('user-1');
    expect(out1.events.recent[1].args[1].value).toBe('user-2');
    expect(out2.events.recent[0].args[1].value).toBe('user-2');
    expect(out2.events.recent[0].description).toBe('Loaded by user-2.');
    expect(out2.id).toBe(out1.id);

    // From the command line: several parts in, a new folder out.
    const dir = await mkdtemp(join(tmpdir(), 'daemon-sanitize-parts-'));
    try {
      await writeFile(join(dir, 'p1.jsonl'), part1);
      await writeFile(join(dir, 'p2.jsonl'), part2);
      const outDir = join(dir, 'clean');
      const printed: string[] = [];
      expect(san.main([join(dir, 'p2.jsonl'), join(dir, 'p1.jsonl'), '--out', outDir], l => printed.push(l), { own: OWN })).toBe(0);
      expect(printed[0]).toMatch(/placeholders .*user 2/);
      const second = linesOf(await readFile(join(outDir, 'p2.jsonl'), 'utf8'))[1]!.frame.controllers[0];
      expect(second.events.recent[0].args[1].value).toBe('user-2');
      expect(linesOf(await readFile(join(outDir, 'p1.jsonl'), 'utf8'))[0]).toMatchObject({ sanitized: true, part: 1 });
      // The folder is never written into twice.
      expect(san.main([join(dir, 'p1.jsonl'), join(dir, 'p2.jsonl'), '--out', outDir], () => {}, { own: OWN })).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('says in its usage that other event codes need --user', () => {
    const printed: string[] = [];
    expect(san.main(['--help'], l => printed.push(l))).toBe(0);
    expect(printed.join('\n')).toMatch(/--user/);
    expect(printed.join('\n')).toMatch(/other event codes/i);
  });

  it('refuses a recording without a masking header, or with weak secret values', () => {
    const missing = san.sanitizeRecording(recording({ masking: null }), { own: OWN });
    expect(missing.ok).toBe(false);
    expect(missing.problems!.join('\n')).toMatch(/no masking section/);
    const weak = san.sanitizeRecording(recording({ masking: { rules: [], values: 1, derived: 0, weakValues: 1 } }), { own: OWN });
    expect(weak.ok).toBe(false);
    expect(weak.problems!.join('\n')).toMatch(/1 weak secret value/);
    const weakEnd = san.sanitizeRecording(recording({ endWeak: 2 }), { own: OWN });
    expect(weakEnd.ok).toBe(false);
    expect(weakEnd.problems!.join('\n')).toMatch(/end record \(line 12\) counts 2 weak/);
    expect(san.sanitizeRecording('{"kind":"frame"}\n', { own: OWN }).ok).toBe(false);
  });

  it('refuses a daemon part without an end record (a hard stop): a weak value may have joined after its header', () => {
    const full = recording();
    const killed = full.slice(0, full.lastIndexOf('{"kind":"end"'));
    const r = san.sanitizeRecording(killed, { own: OWN });
    expect(r.ok).toBe(false);
    expect(r.problems!.join('\n')).toMatch(/no end record/);
    // A killed capture knew all its values at its start: its header counts stand.
    const capture = killed.replace('"source":"daemon"', '"source":"stream-capture"');
    expect(san.sanitizeRecording(capture, { own: OWN }).problems ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/no end record/)]));
  });

  it('masks for credentials once more, and refuses what that would change', () => {
    for (const text of ['retry; Cookie: -http-session-=abc123', 'login password=hunter2hunter2', 'Authorization: Basic dXNlcjpwYXNzd29yZA==']) {
      const r = san.sanitizeRecording(recording({ description: text }), { own: OWN });
      expect(r.ok, text).toBe(false);
      expect(r.problems!.join('\n')).toMatch(/credential-shaped text/);
    }
    // What the recorder already masked passes unchanged.
    for (const text of ['retry; Cookie: -http-session-=abc123', 'login password=hunter2hunter2 then', 'got Bearer dXNlcjpwYXNzd29yZA== back',
      'Digest username="u", response="0123abcd"', 'https://admin:secret@127.0.0.1/rw', '{"password": "hunter2"}']) {
      const masked = redactSecrets(text);
      expect(masked).not.toBe(text);
      expect(san.sanitizeRecording(recording({ description: masked }), { own: OWN }).ok, masked).toBe(true);
    }
  });

  it('fails the leftover scan on each identifying pattern', () => {
    const planted: [string, RegExp][] = [
      ['link 0a:1b:2c:3d:4e:5f up', /a MAC address/],
      ['peer 198.51.100.23 answered', /an IPv4 address other than loopback/],
      ['peer 2001:db8::5 answered', /an IPv6 address other than ::1/],
      ['peer fe80::1%eth0 answered', /an IPv6 address other than ::1/],
      ['found bench-cell.local', /a \.local name/],
      ['file C:\\Users\\someone\\robot.mod', /a Windows user folder/],
      ['file /home/someone/robot.mod', /a home folder/],
      ['file /Users/someone/robot.mod', /a home folder/],
      ['file /root/robot.mod', /a home folder/],
      ['kept in /root', /a home folder/],
      ['from DESKTOP-ABC1234', /a machine name/],
      ['from LAPTOP-Q9W8E7R', /a machine name/],
      ['made on bench-host-42 today', /this computer's name/],
      ['made by TESTER9', /this computer's user name/],
    ];
    for (const [text, why] of planted) {
      const r = san.sanitizeRecording(recording({ description: text }), { own: OWN });
      expect(r.ok, text).toBe(false);
      expect(r.problems!.join('\n'), text).toMatch(why);
    }
    // Loopback, times and versions are not identifying.
    const fine = 'at 127.0.0.1 and ::1 on 2026-10-04 15:30:00, RobotWare 7.21.4+417, 6.16.3007, the tree/root/node and /rootfs';
    expect(san.sanitizeRecording(recording({ description: fine }), { own: OWN }).ok).toBe(true);
  });

  it('runs from the command line: writes only when every check passes, never over a file', async () => {
    const input = join(root, 'rec.jsonl');
    await writeFile(input, recording());
    const out = join(root, 'fixture.jsonl');
    const printed: string[] = [];
    expect(san.main([input, '--out', out], l => printed.push(l), { own: OWN })).toBe(0);
    expect(printed.join('\n')).toMatch(/kept header 1, frame 2, end 1/);
    expect(linesOf(await readFile(out, 'utf8'))[0]).toMatchObject({ sanitized: true });
    expect(san.main([input, '--out', out], () => {}, { own: OWN })).toBe(1);

    const bad = join(root, 'bad.jsonl');
    await writeFile(bad, recording({ description: 'peer 198.51.100.23' }));
    const badOut = join(root, 'bad-fixture.jsonl');
    const lines: string[] = [];
    expect(san.main([bad, '--out', badOut], l => lines.push(l), { own: OWN })).toBe(1);
    expect(lines[0]).toMatch(/nothing was written/);
    await expect(readFile(badOut, 'utf8')).rejects.toThrow();
    expect(san.main([input], () => {})).toBe(1);
    expect(san.main([input, '--out', input], () => {})).toBe(1);
  });
});

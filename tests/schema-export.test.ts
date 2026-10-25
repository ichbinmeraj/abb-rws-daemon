import { beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import * as v0 from '../src/schema/v0.js';
import * as recording from '../src/schema/recording.js';
// @ts-expect-error - plain ESM script without type declarations
import { CUSTOM_KEYWORDS, ROOT, SchemaExportError, generate, outOfDate, rosName, sha256 } from '../scripts/export-schema.mjs';

// The generator builds a TypeScript program: allow it more than the default 5 s.
const SLOW = 60_000;

type Schema = Record<string, any>;
type Generated = { version: string; files: Record<string, string>; frozen: string[]; problems: string[] };

const lf = (s: string) => s.replace(/\r\n?/g, '\n');
const read = (p: string) => lf(readFileSync(join(ROOT, p), 'utf8'));

let gen: Generated;
let main: Schema;
let history: Schema;
let rec: Schema;

beforeAll(() => {
  gen = generate();
  main = JSON.parse(gen.files['schema/v0.schema.json']);
  // A released version's history file is frozen: the generator checks it and leaves it on disk as it is.
  const historyPath = `schema/history/v${gen.version}.schema.json`;
  history = JSON.parse(gen.files[historyPath] ?? read(historyPath));
  rec = JSON.parse(gen.files['schema/recording.schema.json']);
}, SLOW);

/** Every exported interface and type alias of a source file, in declaration order. */
function exportedTypeNames(path: string): string[] {
  const sf = ts.createSourceFile(path, readFileSync(join(ROOT, path), 'utf8'), ts.ScriptTarget.Latest, true);
  const exported = (s: ts.Statement) =>
    ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  return sf.statements
    .filter((s) => (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) && exported(s))
    .map((s) => (s as ts.InterfaceDeclaration | ts.TypeAliasDeclaration).name.text);
}

/** Every inline object type, mapped type, intersection or generic other than Array/ReadonlyArray/Record. */
function unnamedTypes(path: string): string[] {
  const sf = ts.createSourceFile(path, readFileSync(join(ROOT, path), 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (n: ts.Node) => `${path}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n: ts.Node): void => {
    if (ts.isTypeLiteralNode(n) || ts.isMappedTypeNode(n) || ts.isIntersectionTypeNode(n)) found.push(`${at(n)} ${ts.SyntaxKind[n.kind]}`);
    if (ts.isTypeReferenceNode(n) && n.typeArguments?.length && !['Array', 'ReadonlyArray', 'Record'].includes(n.typeName.getText(sf))) {
      found.push(`${at(n)} ${n.typeName.getText(sf)}<...>`);
    }
    ts.forEachChild(n, visit);
  };
  for (const s of sf.statements) if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) visit(s);
  return found;
}

/** [definition, property, schema] for every property of every object definition. */
/** Properties whose ROS name is given by @rosName instead of their snake-case name. */
const ROS_RENAMED: Record<string, string> = { 'IdentityGroup.virtual': 'is_virtual' };

/** Names a field cannot have in a C or C++ message header or in Python. */
const ROS_FORBIDDEN = new Set(`
  alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t
  char16_t char32_t class compl concept const consteval constexpr constinit const_cast
  continue co_await co_return co_yield decltype default delete do double dynamic_cast else
  enum explicit export extern false float for friend goto if inline int long mutable
  namespace new noexcept not not_eq nullptr operator or or_eq private protected public
  register reinterpret_cast requires restrict return short signed sizeof static
  static_assert static_cast struct switch template this thread_local throw true try
  typedef typeid typename typeof union unsigned using virtual void volatile wchar_t while
  xor xor_eq
  as assert async await def del elif except finally from global import in is lambda
  nonlocal pass raise with yield
`.split(/\s+/).filter(Boolean));

function properties(schema: Schema): Array<[string, string, Schema]> {
  const out: Array<[string, string, Schema]> = [];
  for (const [def, d] of Object.entries<Schema>(schema.definitions)) {
    for (const [prop, p] of Object.entries<Schema>(d.properties ?? {})) out.push([def, prop, p]);
  }
  return out;
}

function types(s: Schema): string[] {
  return s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
}

/** The property holds a number somewhere: itself, its items, or a branch (references excluded). */
function isNumeric(s: Schema): boolean {
  const t = types(s);
  if (t.includes('number') || t.includes('integer')) return true;
  if (t.includes('array')) {
    const items = Array.isArray(s.items) ? s.items : s.items ? [s.items] : [];
    return items.some(isNumeric);
  }
  if (s.anyOf) return s.anyOf.some(isNumeric);
  if (s.oneOf) return s.oneOf.some(isNumeric);
  return false;
}

function isStringValued(s: Schema): boolean {
  const t = types(s);
  return t.includes('string') && t.every((x) => x === 'string' || x === 'null');
}

/** Every value of `key` anywhere in a JSON tree, with its JSON path. */
function collect(node: unknown, key: string, path = '#'): Array<[string, unknown]> {
  if (!node || typeof node !== 'object') return [];
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push([path, v]);
    out.push(...collect(v, key, `${path}/${k}`));
  }
  return out;
}

/** Definitions reachable from a definition through local references. */
function reachable(schema: Schema, from: string[]): Set<string> {
  const seen = new Set<string>();
  const todo = [...from];
  while (todo.length) {
    const name = todo.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const [, ref] of collect(schema.definitions[name], '$ref')) {
      const m = /^#\/definitions\/(.+)$/.exec(String(ref));
      if (m) todo.push(m[1]);
    }
  }
  return seen;
}

describe('schema export: the checked-in files', () => {
  it('are what the generator makes from the TypeScript (run npm run schema when this fails)', () => {
    expect(gen.problems).toEqual([]);
    expect(outOfDate(gen.files)).toEqual([]);
    for (const [p, content] of Object.entries(gen.files)) expect(read(p), p).toBe(content);
  });

  it('cover the snapshot schema, its history copy, the manifest and the recording format', () => {
    // The history copy is written while its version is unreleased, and frozen (checked, never written) once it is released.
    const current = `schema/history/v${v0.SCHEMA_VERSION}.schema.json`;
    expect([...Object.keys(gen.files), ...gen.frozen.filter(p => p === current)].sort()).toEqual(
      ['schema/history/index.json', current, 'schema/recording.schema.json', 'schema/v0.schema.json'].sort(),
    );
    expect(gen.problems).toEqual([]);
  });

  it('are LF-terminated, two-space JSON', () => {
    for (const [p, content] of Object.entries(gen.files)) {
      expect(content.includes('\r'), p).toBe(false);
      expect(content.endsWith('\n'), p).toBe(true);
      expect(content).toBe(JSON.stringify(JSON.parse(content), null, 2) + '\n');
    }
  });
});

describe('schema export: v0.schema.json', () => {
  it('is draft-07 with the major-line id, the exact version and the root type', () => {
    expect(main.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(main.$id).toBe('urn:abb-rws-daemon:schema:v0');
    expect(main['x-schema-version']).toBe(v0.SCHEMA_VERSION);
    expect(main.$ref).toBe('#/definitions/ControllerSnapshot');
    expect(main.$defs).toBeUndefined();
    expect(main.description).toMatch(/breaking changes inside 0\.x are possible/);
  });

  it('has every exported interface and type of v0.ts, in declaration order', () => {
    expect(Object.keys(main.definitions)).toEqual(exportedTypeNames('src/schema/v0.ts'));
  });

  it('is made from named types only (no inline object, mapped, intersection or utility type)', () => {
    expect(unnamedTypes('src/schema/v0.ts')).toEqual([]);
    expect(unnamedTypes('src/schema/recording.ts')).toEqual([]);
  });

  it('lists every exported constant of v0.ts in x-constants, evaluated', () => {
    expect(main['x-constants']).toEqual({ ...v0 });
  });

  it('lists breaking changes inside 0.x in x-breaking, the 0.11 rename first', () => {
    expect(Array.isArray(main['x-breaking'])).toBe(true);
    expect(main['x-breaking'][0]).toMatchObject({ version: '0.11' });
    expect(main['x-breaking'][0].change).toMatch(/entered/);
    expect(main['x-breaking'][0].change).toMatch(/manual/);
    for (const b of main['x-breaking']) expect(b.version).toMatch(/^0\.\d+$/);
  });

  it('exports schemaVersion as a pattern, not a constant, so an older minor still validates', () => {
    const found = properties(main).filter(([, prop]) => prop === 'schemaVersion');
    expect(found.map(([def]) => def)).toEqual(expect.arrayContaining(['ControllerList', 'SnapshotFrame']));
    for (const [, , p] of found) {
      expect(p.type).toBe('string');
      expect(p.pattern).toBe('^0\\.[0-9]+$');
      expect(p.const).toBeUndefined();
      expect(new RegExp(p.pattern).test('0.12')).toBe(true);
      expect(new RegExp(p.pattern).test('1.0')).toBe(false);
    }
  });

  it('frames are a oneOf of the three named frame types', () => {
    expect(main.definitions.StreamFrame.oneOf).toEqual([
      { $ref: '#/definitions/SnapshotFrame' },
      { $ref: '#/definitions/DeltaFrame' },
      { $ref: '#/definitions/RemovedFrame' },
    ]);
  });

  it('keeps objects strict except index-signature types', () => {
    for (const [name, d] of Object.entries<Schema>(main.definitions)) {
      if (d.type !== 'object') continue;
      if (name === 'RefusalDetails') expect(d.additionalProperties, name).toBe(true);
      else expect(d.additionalProperties, name).toBe(false);
    }
  });

  it('gives the pose quaternion as a bounded 4-tuple, w first', () => {
    const q = main.definitions.MotionPose.properties.q;
    expect(q.type).toBe('array');
    expect(q.items).toHaveLength(4);
    expect(q.additionalItems).toBe(false);
    expect(q.minItems).toBe(4);
    expect(q.maxItems).toBe(4);
    expect(q['x-unit']).toBe('quaternion-wxyz');
  });

  it('names the units the ROS side converts with', () => {
    const d = main.definitions;
    expect(d.PanelGroup.properties.speedRatio['x-unit']).toBe('percent');
    for (const k of ['value', 'min', 'max']) expect(d.MotionJoint.properties[k]['x-unit-from'], k).toBe('unit');
    expect(d.MotionJoint.properties.unit.enum).toEqual(['deg', 'mm', null]);
    for (const k of ['x', 'y', 'z']) expect(d.MotionPose.properties[k]['x-unit'], k).toBe('mm');
    for (const k of ['targetHz', 'achievedHz']) expect(d.MotionRate.properties[k]['x-unit'], k).toBe('Hz');
    expect(d.MotionWatch.properties.targetHz['x-unit']).toBe('Hz');
    for (const [def, k] of [['MotionWatch', 'leaseMs'], ['IoWatch', 'leaseMs'], ['EventClock', 'offsetMs'], ['ShutdownAnswer', 'exitWithinMs']]) {
      expect(d[def].properties[k]['x-unit'], `${def}.${k}`).toBe('ms');
    }
    expect(d.HealthAnswer.properties.uptimeS['x-unit']).toBe('s');
    for (const def of ['ReplayHealth', 'ReplayStatus']) {
      for (const k of ['positionMs', 'durationMs']) expect(d[def].properties[k]['x-unit'], `${def}.${k}`).toBe('ms');
    }
    for (const def of ['RecordingLimits', 'RecordingStartRequest']) expect(d[def].properties.durationS['x-unit'], def).toBe('s');
    for (const def of ['RecordingLimits', 'RecordingLimitsRequest']) {
      for (const [k, p] of Object.entries<Schema>(d[def].properties)) {
        if (k.endsWith('Bytes')) expect(p['x-unit'], `${def}.${k}`).toBe('bytes');
      }
    }
    expect(d.RecordingStatus.properties.bytes['x-unit']).toBe('bytes');
  });

  it('lists the 0.12 error codes beside the older ones', () => {
    for (const code of ['RECORDING_ACTIVE', 'RECORDING_FAILED', 'REPLAY_MODE', 'NOT_RECORDED']) {
      expect(main.definitions.ErrorBody.description, code).toContain(code);
    }
  });

  it('has the access, capabilities and freshness groups of 0.13: on every snapshot, optional in a delta', () => {
    const d = main.definitions;
    const added = [
      'AccessGeneration', 'AccessModel', 'AccessLockName', 'AccessHolder', 'AccessLockInfo', 'RmmpPrivilege', 'RmmpInfo', 'AccessGroup',
      'CapabilityId', 'CapabilityState', 'Capability', 'CapabilitiesGroup',
      'FreshnessLevel', 'GroupFreshnessState', 'FreshGroupName', 'GroupFreshness', 'FreshnessGroup',
    ];
    for (const name of added) expect(d[name], name).toBeDefined();
    for (const g of ['access', 'capabilities', 'freshness']) {
      expect(d.ControllerSnapshot.required, g).toContain(g);
      expect(d.DeltaGroups.properties[g], g).toBeDefined();
      expect(d.DeltaGroups.required ?? [], g).not.toContain(g);
      expect(d.GroupName.enum, g).toContain(g);
    }
    expect(d.ControllerSnapshot.properties.access.allOf).toEqual([{ $ref: '#/definitions/AccessGroup' }]);
    expect(d.ControllerSnapshot.properties.capabilities.allOf).toEqual([{ $ref: '#/definitions/CapabilitiesGroup' }]);
    expect(d.ControllerSnapshot.properties.freshness.allOf).toEqual([{ $ref: '#/definitions/FreshnessGroup' }]);
    expect(d.LinkGroup.required).toContain('downSince');
    expect(d.LinkGroup.properties.downSince).toMatchObject({ type: ['string', 'null'], format: 'date-time' });

    // The words of the wire, in the order the types give them.
    expect(d.AccessGeneration.enum).toEqual(['rw6', 'rw7', 'rw8']);
    expect(d.AccessModel.enum).toEqual(['mastership', 'writeaccess']);
    expect(d.AccessLockName.enum).toEqual(['cfg', 'motion', 'rapid', 'edit', 'writeaccess']);
    expect(d.AccessHolder.properties.kind.enum).toEqual(['local', 'remote', 'internal', 'station']);
    expect(d.RmmpPrivilege.enum).toEqual(['none', 'pending modify', 'pending exec', 'modify', 'exec']);
    expect(d.RmmpInfo.properties.privilege.anyOf).toEqual([{ $ref: '#/definitions/RmmpPrivilege' }, { type: 'null' }]);
    expect(d.AccessGroup.properties.via.enum).toEqual(['poll', null]);
    expect(d.CapabilityId.enum).toEqual([
      'status-push', 'events-push', 'event-times', 'io-push', 'io-table', 'joint-limits', 'mastership', 'write-access', 'rmmp',
    ]);
    expect(d.CapabilityState.enum).toEqual(['available', 'unavailable', 'degraded', 'unknown']);
    expect(d.FreshnessLevel.enum).toEqual(['current', 'degraded', 'down', 'wrong-controller']);
    expect(d.GroupFreshnessState.enum).toEqual(['current', 'partial', 'stale', 'idle', 'unread', 'unavailable', 'withheld']);
    expect(d.FreshGroupName.enum).toEqual(['identity', 'panel', 'rapid', 'motion', 'io', 'events', 'access']);

    // What was not read is null, never false: every yes-or-no of these groups admits null.
    for (const [def, prop] of [
      ['AccessLockInfo', 'held'], ['AccessLockInfo', 'heldByDaemon'], ['AccessGroup', 'remoteAccessEnabled'], ['RmmpInfo', 'supported'],
      ['CapabilitiesGroup', 'tested'], ['AccessHolder', 'flexPendant'],
    ]) {
      expect(d[def].properties[prop].type, `${def}.${prop}`).toEqual(['boolean', 'null']);
    }
    // A holder is named, never identified: no property for a user id or a station id.
    expect(Object.keys(d.AccessHolder.properties)).toEqual(['kind', 'name', 'application', 'flexPendant']);
    for (const name of added) {
      for (const prop of Object.keys(d[name].properties ?? {})) expect(prop, `${name}.${prop}`).not.toMatch(/^uid$|user.?id|held.?by.?id|station.?id/i);
    }
    // None of them holds a number, so none needs a unit.
    for (const name of added) {
      for (const [prop, p] of Object.entries<Schema>(d[name].properties ?? {})) expect(isNumeric(p), `${name}.${prop}`).toBe(false);
    }
    expect(main['x-constants']).toMatchObject({ ACCESS_LOCKS_MAX: 3, ACCESS_READ_MS: 5_000, ACCESS_READ_SLOW_MS: 15_000 });
  });

  it('tags the ROS message root and the free-form refusal', () => {
    expect(main.definitions.ControllerSnapshot['x-ros']).toBe('msg');
    for (const [def, prop, p] of properties(main)) {
      if (prop === 'refusal') expect(p['x-ros'], `${def}.${prop}`).toBe('json');
    }
  });

  it('marks a definition that only renames another as an alias', () => {
    expect(main.definitions.ControllerSummary).toMatchObject({ $ref: '#/definitions/ControllerSnapshot', 'x-ros': 'alias' });
  });
});

/** Rules for every generated file. */
describe.each([
  ['v0.schema.json', () => main],
  ['recording.schema.json', () => rec],
])('schema export: %s field rules', (_file, schemaOf) => {
  const DATE_TIME = new Set(['asOf', 'observedAt', 'since', 'downSince', 'startedAt', 'nextAttemptAt', 'receivedAt', 'measuredAt', 'recordedAt', 'endsAt', 'sessionStartedAt']);
  const INTEGER = /Seq$|^seq|^port$|^code$|^line$|Count$|^failures$|^loops$|^part$/;

  it('gives every ISO time format date-time', () => {
    const schema = schemaOf();
    for (const [def, prop, p] of properties(schema)) {
      if (!isStringValued(p)) continue;
      // The listed names, and any new `...At` time, so an untagged one fails.
      const isTime = DATE_TIME.has(prop) || /[a-z]At$/.test(prop) || (def === 'EventTime' && prop === 'utc');
      if (isTime) expect(p.format, `${def}.${prop} needs @format date-time`).toBe('date-time');
    }
    if (schema === main) expect(main.definitions.EventTime.properties.utc.format).toBe('date-time');
  });

  it('gives every number exactly one of x-unit or x-unit-from', () => {
    for (const [def, prop, p] of properties(schemaOf())) {
      if (!isNumeric(p)) continue;
      const tagged = ('x-unit' in p ? 1 : 0) + ('x-unit-from' in p ? 1 : 0);
      expect(tagged, `${def}.${prop} needs @unit or @unitFrom`).toBe(1);
    }
  });

  it('makes sequence numbers, counts, ports, codes and lines integers', () => {
    for (const [def, prop, p] of properties(schemaOf())) {
      if (!isNumeric(p) || !INTEGER.test(prop)) continue;
      expect(types(p), `${def}.${prop} needs @integer`).toContain('integer');
      expect(types(p), `${def}.${prop} needs @integer`).not.toContain('number');
    }
  });

  it('names every property for ROS in snake case, unique within its type', () => {
    const schema = schemaOf();
    for (const [def, d] of Object.entries<Schema>(schema.definitions)) {
      const names = Object.entries<Schema>(d.properties ?? {}).map(([prop, p]) => {
        expect(p['x-ros-name'], `${def}.${prop}`).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(p['x-ros-name'], `${def}.${prop}`).toBe(ROS_RENAMED[`${def}.${prop}`] ?? rosName(prop));
        return p['x-ros-name'];
      });
      expect(new Set(names).size, def).toBe(names.length);
    }
  });

  it('gives no property a ROS name that is a C, C++ or Python keyword: @rosName renames it', () => {
    for (const [def, prop, p] of properties(schemaOf())) {
      expect(ROS_FORBIDDEN.has(p['x-ros-name']), `${def}.${prop} is ${p['x-ros-name']}: give it @rosName`).toBe(false);
    }
  });

  it('follows draft-07: nothing beside a $ref but an alias marker', () => {
    const schema = schemaOf();
    for (const [path, ref] of collect(schema.definitions, '$ref', '#/definitions')) {
      const node = path.split('/').slice(1).reduce((n: any, k) => n[k], schema);
      const extra = Object.keys(node).filter((k) => k !== '$ref');
      const isAlias = /^#\/definitions\/[^/]+$/.test(path) && node['x-ros'] === 'alias';
      expect(isAlias ? extra.filter((k) => k !== 'description' && k !== 'x-ros') : extra, path).toEqual([]);
      const local = /^#\/definitions\/(.+)$/.exec(String(ref));
      if (local) expect(schema.definitions[local[1]], `${path} -> ${ref}`).toBeDefined();
      else {
        const ext = /^urn:abb-rws-daemon:schema:v0#\/definitions\/(.+)$/.exec(String(ref));
        expect(ext, `${path} -> ${ref}`).not.toBeNull();
        expect(main.definitions[ext![1]], `${path} -> ${ref}`).toBeDefined();
      }
    }
  });

  it('uses only the declared custom keywords', () => {
    const used = new Set<string>();
    const visit = (n: unknown, inProps: boolean): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach((x) => visit(x, false));
      for (const [k, v] of Object.entries(n)) {
        if (!inProps && k.startsWith('x-')) used.add(k);
        if (k === 'x-constants' || k === 'x-breaking' || k === 'enum' || k === 'const') continue;
        visit(v, k === 'properties' || k === 'definitions');
      }
    };
    visit(schemaOf(), false);
    for (const k of used) expect(CUSTOM_KEYWORDS, k).toContain(k);
  });

  it('bounds every capped list by its constant: maxItems with the constant named in x-max-items-from', () => {
    const capped = properties(main).filter(([, , p]) => p['x-max-items-from'] !== undefined || (p.maxItems !== undefined && !Array.isArray(p.items)));
    expect(capped.map(([d, prop]) => `${d}.${prop}`).sort()).toEqual(['AccessGroup.locks', 'EventsGroup.recent', 'EventsPage.events', 'IoGroup.signals']);
    for (const [d, prop, p] of capped) {
      const where = `${d}.${prop}`;
      expect(types(p), where).toContain('array');
      expect(main['x-constants'][p['x-max-items-from']], where).toBe(p.maxItems);
    }
    expect(main.definitions.EventsGroup.properties.recent).toMatchObject({ maxItems: v0.EVENTS_RECENT_MAX, 'x-max-items-from': 'EVENTS_RECENT_MAX' });
    expect(main.definitions.IoGroup.properties.signals).toMatchObject({ maxItems: v0.IO_WATCH_MAX, 'x-max-items-from': 'IO_WATCH_MAX' });
    expect(main.definitions.AccessGroup.properties.locks).toMatchObject({ maxItems: v0.ACCESS_LOCKS_MAX, 'x-max-items-from': 'ACCESS_LOCKS_MAX' });
  });
});

describe('schema export: ROS mapping', () => {
  const refName = (ref: string) => /^#\/definitions\/(.+)$/.exec(ref)![1];
  const isEnumDef = (ref: string) => {
    const d = main.definitions[refName(ref)];
    return Array.isArray(d.enum) && isStringValued(d);
  };

  /**
   * The ROS type a property maps to, by the rules of schema/README.md: a
   * reference to a named string enum is a string with constants (empty when
   * null), not a nested message; a capped list is bounded.
   */
  function rosType(p: Schema): string {
    if (p['x-ros'] === 'json') return 'string(json)';
    const ref = p.$ref ?? p.allOf?.[0]?.$ref;
    if (ref) return isEnumDef(ref) ? 'string(enum)' : refName(ref);
    if (p.anyOf) {
      const r = p.anyOf.find((b: Schema) => b.$ref).$ref;
      return isEnumDef(r) ? 'string(enum, empty when null)' : `${refName(r)}[<=1]`;
    }
    const t = types(p).filter((x) => x !== 'null');
    if (t[0] === 'array') {
      if (Array.isArray(p.items)) return `float64[${p.items.length}]`;
      const item = rosType(p.items);
      return p['x-max-items-from'] ? `${item}[<=${p.maxItems}]` : `${item}[]`;
    }
    return t[0] === 'string' && p.enum ? 'string(enum)' : t[0];
  }

  it('maps a reference to a named string enum to a string with constants, not to a nested message', () => {
    expect(main.definitions.RobotWareVersion.properties.generation.anyOf[0].$ref).toBe('#/definitions/Generation');
    expect(rosType(main.definitions.RobotWareVersion.properties.generation)).toBe('string(enum, empty when null)');
    expect(rosType(main.definitions.LinkGroup.properties.quality)).toBe('string(enum)');
    expect(rosType(main.definitions.EventsGroup.properties.recent)).toBe(`ControllerEvent[<=${v0.EVENTS_RECENT_MAX}]`);
    expect(rosType(main.definitions.IoGroup.properties.signals)).toBe(`IoWatchedSignal[<=${v0.IO_WATCH_MAX}]`);
    expect(rosType(main.definitions.MotionPose.properties.q)).toBe('float64[4]');
    // No nested message is made from an enum: every message a field names is an object.
    const roots = Object.entries<Schema>(main.definitions).filter(([, d]) => d['x-ros'] === 'msg').map(([n]) => n);
    for (const name of reachable(main, roots)) {
      const d = main.definitions[name];
      if (d.type !== 'object' || d['x-ros'] === 'json') continue;
      for (const [prop, p] of Object.entries<Schema>(d.properties)) {
        const m = /^([A-Za-z]+)(\[|$)/.exec(rosType(p));
        if (m && main.definitions[m[1]]) expect(main.definitions[m[1]].type, `${name}.${prop} -> ${m[1]}`).toBe('object');
      }
    }
  });

  it('can map every field reachable from a message root', () => {
    const roots = Object.entries<Schema>(main.definitions).filter(([, d]) => d['x-ros'] === 'msg').map(([n]) => n);
    expect(roots).toContain('ControllerSnapshot');
    const isNull = (s: Schema) => s.type === 'null';
    for (const name of reachable(main, roots)) {
      const d = main.definitions[name];
      if (d['x-ros'] === 'json') continue;
      if (d.type !== 'object') {
        // A named enum (Generation, LinkQuality) maps to string constants.
        expect(isStringValued(d) && Array.isArray(d.enum), name).toBe(true);
        continue;
      }
      for (const [prop, p] of Object.entries<Schema>(d.properties)) {
        const where = `${name}.${prop}`;
        if (p['x-ros'] === 'json') continue;
        if (p.anyOf) {
          const rest = p.anyOf.filter((b: Schema) => !isNull(b));
          expect(rest.length, `${where}: one type or null`).toBe(1);
          expect(rest[0].$ref, `${where}: nullable reference`).toBeDefined();
          continue;
        }
        if (p.allOf) {
          expect(p.allOf.length, where).toBe(1);
          expect(p.allOf[0].$ref, where).toBeDefined();
          continue;
        }
        expect(p.oneOf, where).toBeUndefined();
        const t = types(p).filter((x) => x !== 'null');
        expect(t.length, `${where}: one JSON type`).toBe(1);
        if (t[0] === 'object') throw new Error(`${where}: free-form object without @ros json`);
        if (t[0] === 'array') {
          const items = Array.isArray(p.items) ? p.items : [p.items];
          for (const it of items) expect(it.$ref ?? it.type, where).toBeDefined();
        }
      }
    }
  });
});

describe('schema export: history', () => {
  it('keeps a copy of the current version that differs from v0.schema.json only in $id', () => {
    expect(history.$id).toBe(`urn:abb-rws-daemon:schema:${v0.SCHEMA_VERSION}`);
    expect({ ...history, $id: main.$id }).toEqual(main);
  });

  it('records the sha256 of every history file, and every file matches', () => {
    const index = JSON.parse(read('schema/history/index.json')) as Array<{ version: string; sha256: string }>;
    expect(index.map((e) => e.version)).toContain(v0.SCHEMA_VERSION);
    expect(index.map((e) => e.version)[0]).toBe('0.12');
    for (const e of index) {
      const p = `schema/history/v${e.version}.schema.json`;
      expect(existsSync(join(ROOT, p)), p).toBe(true);
      expect(sha256(read(p)), p).toBe(e.sha256);
      expect(JSON.parse(read(p)).$id).toBe(`urn:abb-rws-daemon:schema:${e.version}`);
    }
  });
});

describe('schema export: recording.schema.json', () => {
  it('is draft-07 with the format version in its id', () => {
    expect(rec.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(rec.$id).toBe(`urn:abb-rws-daemon:recording:${rec['x-format-version']}`);
    expect(Number.isInteger(rec['x-format-version'])).toBe(true);
  });

  it('has every exported interface and type of recording.ts, in declaration order', () => {
    expect(Object.keys(rec.definitions)).toEqual(exportedTypeNames('src/schema/recording.ts'));
  });

  it('lists every exported constant of recording.ts in x-constants', () => {
    expect(rec['x-constants']).toEqual({ ...recording });
  });

  it('refers to stream frames by the major-line id, so a new snapshot minor does not change it', () => {
    const refs = collect(rec.definitions, '$ref').map(([, r]) => String(r));
    expect(refs).toContain('urn:abb-rws-daemon:schema:v0#/definitions/StreamFrame');
    for (const r of refs.filter((x) => x.startsWith('urn:'))) expect(r).toMatch(/^urn:abb-rws-daemon:schema:v0#/);
  });

  it('refers to the snapshot schema for frames only: its other types are its own, fixed by its format version', () => {
    const external = new Set(collect(rec.definitions, '$ref').map(([, r]) => String(r)).filter((x) => x.startsWith('urn:')));
    expect([...external]).toEqual(['urn:abb-rws-daemon:schema:v0#/definitions/StreamFrame']);
    // The format's own copies match the wire types they were taken from, for now (descriptions aside).
    const strip = (x: Schema): Schema => JSON.parse(JSON.stringify(x, (k, v) => (k === 'description' ? undefined : v)));
    for (const [a, b] of [['RecordedContent', 'RecordingContent'], ['RecordedEndReason', 'RecordingEndReason'],
      ['RecordedLimits', 'RecordingLimits'], ['RecordedDropped', 'RecordingDropped'], ['RecordedMasking', 'RecordingMasking']]) {
      expect(strip(rec.definitions[a]), a).toEqual(strip(main.definitions[b]));
    }
  });
});

describe('schema export: the generator', () => {
  it('names properties in snake case for ROS', () => {
    expect(rosName('observedAt')).toBe('observed_at');
    expect(rosName('sysId')).toBe('sys_id');
    expect(rosName('useHttps')).toBe('use_https');
    expect(rosName('uptimeS')).toBe('uptime_s');
    expect(rosName('httpStatus')).toBe('http_status');
    expect(rosName('HTTPStatus')).toBe('http_status');
    expect(rosName('q')).toBe('q');
    expect(rosName('maxFileBytes')).toBe('max_file_bytes');
  });

  describe('on a copy of the sources', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'schema-export-'));
      cpSync(join(ROOT, 'tsconfig.json'), join(dir, 'tsconfig.json'));
      mkdirSync(join(dir, 'src/schema'), { recursive: true });
      for (const f of ['v0.ts', 'recording.ts']) cpSync(join(ROOT, 'src/schema', f), join(dir, 'src/schema', f));
      return () => rmSync(dir, { recursive: true, force: true });
    });

    const v0Path = () => join(dir, 'src/schema/v0.ts');
    const original = () => readFileSync(join(ROOT, 'src/schema/v0.ts'), 'utf8');

    function withV0(extra: string, run: () => void) {
      writeFileSync(v0Path(), original() + '\n' + extra + '\n');
      try {
        run();
      } finally {
        writeFileSync(v0Path(), original());
      }
    }

    function failure(): string {
      try {
        generate({ root: dir });
      } catch (err) {
        expect(err).toBeInstanceOf(SchemaExportError);
        return (err as Error).message;
      }
      throw new Error('the generator did not refuse');
    }

    it('makes the same files as from the repository', () => {
      // The frozen history belongs to the sources: the manifest and every history file the generator never writes.
      mkdirSync(join(dir, 'schema/history'), { recursive: true });
      for (const p of ['schema/history/index.json', ...gen.frozen]) cpSync(join(ROOT, p), join(dir, p));
      expect(gen.frozen).toContain('schema/history/v0.12.schema.json');
      const copy = generate({ root: dir });
      expect(copy.problems).toEqual([]);
      expect(copy.frozen).toEqual(gen.frozen);
      expect(copy.files).toEqual(gen.files);
      // Without them the copy would know of no earlier version: its manifest would list the current one alone.
      rmSync(join(dir, 'schema'), { recursive: true, force: true });
      const bare = JSON.parse(generate({ root: dir }).files['schema/history/index.json']) as Array<{ version: string }>;
      expect(bare.map((e) => e.version)).toEqual([gen.version]);
    }, SLOW);

    function writeAll(files: Record<string, string>, eol = '\n') {
      for (const [p, c] of Object.entries(files)) {
        mkdirSync(join(dir, p, '..'), { recursive: true });
        writeFileSync(join(dir, p), c.replace(/\n/g, eol));
      }
    }

    it('reports a checked-in file that is out of date, whatever its line ends', () => {
      const copy = generate({ root: dir });
      writeAll(copy.files, '\r\n');
      expect(outOfDate(copy.files, dir)).toEqual([]);
      writeFileSync(join(dir, 'schema/v0.schema.json'), '{}\n');
      expect(outOfDate(copy.files, dir)).toEqual(['schema/v0.schema.json']);
      rmSync(join(dir, 'schema'), { recursive: true, force: true });
    }, SLOW);

    it('keeps earlier history files frozen and reports one that changed', () => {
      const copy = generate({ root: dir });
      writeAll(copy.files);
      const older = { version: '0.1', sha256: sha256('{"frozen":true}\n') };
      writeFileSync(join(dir, 'schema/history/index.json'), JSON.stringify([older, ...JSON.parse(copy.files['schema/history/index.json'])], null, 2) + '\n');
      writeFileSync(join(dir, 'schema/history/v0.1.schema.json'), '{"frozen":true}\r\n');
      const again = generate({ root: dir });
      expect(again.problems).toEqual([]);
      expect(again.frozen).toEqual(['schema/history/v0.1.schema.json']);
      expect(again.files['schema/history/v0.1.schema.json']).toBeUndefined();
      expect(JSON.parse(again.files['schema/history/index.json'])[0]).toEqual(older);
      writeFileSync(join(dir, 'schema/history/v0.1.schema.json'), '{"frozen":false}\n');
      expect(generate({ root: dir }).problems).toEqual([
        'schema/history/v0.1.schema.json does not match its sha256 in schema/history/index.json: history files are frozen',
      ]);
      rmSync(join(dir, 'schema'), { recursive: true, force: true });
    }, SLOW);

    it('keeps a released version frozen even while it is the current one: a wire change needs a new minor', () => {
      const copy = generate({ root: dir });
      writeAll(copy.files);
      const index = JSON.parse(copy.files['schema/history/index.json']) as Array<Record<string, unknown>>;
      for (const e of index) if (e.version === copy.version) e.released = true;
      writeFileSync(join(dir, 'schema/history/index.json'), JSON.stringify(index, null, 2) + '\n');
      const again = generate({ root: dir });
      expect(again.problems).toEqual([]);
      expect(again.frozen).toContain(`schema/history/v${copy.version}.schema.json`);
      expect(again.files[`schema/history/v${copy.version}.schema.json`]).toBeUndefined();
      expect(JSON.parse(again.files['schema/history/index.json']).at(-1)).toMatchObject({ version: copy.version, released: true });
      withV0('export interface Added {\n  a: string;\n}', () => {
        expect(generate({ root: dir }).problems).toEqual([
          `${copy.version} is released and the TypeScript no longer makes its schema: raise SCHEMA_VERSION for a wire change`,
        ]);
      });
      rmSync(join(dir, 'schema'), { recursive: true, force: true });
    }, SLOW);

    it('refuses an inline object type, naming the file and line', () => {
      withV0('export interface Bad {\n  inner: { a: string };\n}', () => {
        expect(failure()).toMatch(/^src\/schema\/v0\.ts:\d+: inline object type/);
      });
    }, SLOW);

    it('refuses utility types', () => {
      withV0('export type Bad = Partial<ControllerSnapshot>;', () => {
        expect(failure()).toMatch(/^src\/schema\/v0\.ts:\d+: Partial<\.\.\.> is not supported/);
      });
      withV0('export interface Bad {\n  /** @unit none */\n  p: Pick<ControllerSnapshot, "id">;\n}', () => {
        expect(failure()).toMatch(/Pick<\.\.\.> is not supported/);
      });
    }, SLOW);

    it('refuses an unknown JSDoc tag and a misplaced one', () => {
      withV0('export interface Bad {\n  /** @units ms */\n  a: number;\n}', () => {
        expect(failure()).toMatch(/unknown JSDoc tag @units/);
      });
      withV0('export interface Bad {\n  /** @integer */\n  a: string;\n}', () => {
        expect(failure()).toMatch(/@integer on a, which is not a number/);
      });
      withV0('export interface Bad {\n  /** @unitFrom nothing */\n  a: number;\n}', () => {
        expect(failure()).toMatch(/@unitFrom names nothing/);
      });
      withV0('export interface Bad {\n  /** @maxItems EVENTS_RECENT_MAX */\n  a: string;\n}', () => {
        expect(failure()).toMatch(/@maxItems on a, which is not a list/);
      });
      withV0('export interface Bad {\n  /** @maxItems NO_SUCH_MAX */\n  a: string[];\n}', () => {
        expect(failure()).toMatch(/@maxItems names NO_SUCH_MAX, which is no exported constant/);
      });
      withV0('export interface Bad {\n  /** @rosName isVirtual */\n  a: string;\n}', () => {
        expect(failure()).toMatch(/@rosName needs a snake-case name, got "isVirtual"/);
      });
      withV0('/** @rosName bad */\nexport interface Bad {\n  a: string;\n}', () => {
        expect(failure()).toMatch(/ROS name tags belong on properties/);
      });
    }, SLOW);

    it('turns tags into keywords', () => {
      withV0(
        'export interface Tagged {\n  /**\n   * When.\n   * @format date-time\n   */\n  at: string | null;\n  /** @integer @unit count */\n  n: number;\n  /** @ros json */\n  r?: RefusalDetails;\n  /** @rosName is_virtual */\n  virtual: boolean;\n}',
        () => {
          const s = JSON.parse(generate({ root: dir }).files['schema/v0.schema.json']);
          expect(s.definitions.Tagged).toEqual({
            type: 'object',
            properties: {
              at: { description: 'When.', type: ['string', 'null'], format: 'date-time', 'x-ros-name': 'at' },
              n: { type: 'integer', 'x-unit': 'count', 'x-ros-name': 'n' },
              r: { allOf: [{ $ref: '#/definitions/RefusalDetails' }], 'x-ros': 'json', 'x-ros-name': 'r' },
              virtual: { type: 'boolean', 'x-ros-name': 'is_virtual' },
            },
            required: ['at', 'n', 'virtual'],
            additionalProperties: false,
          });
        },
      );
    }, SLOW);
  });
});

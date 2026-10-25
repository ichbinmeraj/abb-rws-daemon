#!/usr/bin/env node
/**
 * Exports the daemon's wire types as JSON Schema (draft-07).
 *
 *   node scripts/export-schema.mjs           writes schema/ (npm run schema)
 *   node scripts/export-schema.mjs --check   writes nothing; exits 1 when schema/ is out of date
 *
 * Reads src/schema/v0.ts and src/schema/recording.ts with the TypeScript
 * compiler API and writes:
 *
 *   schema/v<major>.schema.json            every exported type of v0.ts, root ControllerSnapshot
 *   schema/history/v<version>.schema.json  the same, as of this exact version (earlier ones are frozen)
 *   schema/history/index.json              [{version, sha256, released?}] of every history file
 *
 * A version is released when its index entry has `released: true` (set by
 * hand when it ships). Its history file is then frozen even while it is
 * SCHEMA_VERSION: a wire change that would alter it fails generation until
 * SCHEMA_VERSION is raised.
 *   schema/recording.schema.json           the recording file format (recording.ts)
 *
 * Only named types are exported. An inline object type, a utility type
 * (Partial, Pick, Omit, ...) or any other construct this generator does not
 * know stops it with the file and line, so nothing vague or unnamed reaches
 * the schema. JSDoc tags on the TypeScript side:
 *
 *   @integer             the number is a whole number (type "integer")
 *   @unit <u>            x-unit (e.g. ms, s, Hz, mm, percent, bytes, count, none)
 *   @unitFrom <prop>     x-unit-from: the sibling property that names the unit
 *   @format date-time    format (ISO 8601, UTC)
 *   @ros json|msg        x-ros: carried as JSON text | a ROS message root
 *   @rosName <name>      a property's x-ros-name, when its snake-case name will not
 *                        do on the ROS side (a C, C++ or Python keyword)
 *   @maxItems <CONST>    an array capped by an exported constant of the same
 *                        file: maxItems (its value) and x-max-items-from (its name)
 *   @breaking <v> <text> (header comment) an entry of x-breaking
 */
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
export const SNAPSHOT_ID_PREFIX = 'urn:abb-rws-daemon:schema:';
export const RECORDING_ID_PREFIX = 'urn:abb-rws-daemon:recording:';

/** The JSON Schema keywords of our own that the schema files use (declare them to a strict validator). */
export const CUSTOM_KEYWORDS = Object.freeze([
  'x-unit',
  'x-unit-from',
  'x-ros',
  'x-ros-name',
  'x-constants',
  'x-schema-version',
  'x-format-version',
  'x-breaking',
  'x-max-items-from',
]);

const V0_SOURCE = 'src/schema/v0.ts';
const RECORDING_SOURCE = 'src/schema/recording.ts';

const KNOWN_TAGS = new Set(['integer', 'unit', 'unitFrom', 'format', 'ros', 'rosName', 'maxItems', 'breaking', 'deprecated', 'see', 'example']);
const FORMATS = new Set(['date-time']);

export class SchemaExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaExportError';
  }
}

/** `observedAt` -> `observed_at`, `sysId` -> `sys_id`, `useHttps` -> `use_https`, `HTTPStatus` -> `http_status`. */
export function rosName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** Same text on every platform: a checkout with CRLF line ends must not change the output. */
function lf(text) {
  return text.replace(/\r\n?/g, '\n');
}

export function sha256(text) {
  return createHash('sha256').update(lf(text), 'utf8').digest('hex');
}

function stringify(schema) {
  return JSON.stringify(schema, null, 2) + '\n';
}

function samePath(a, b) {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function compareVersions(a, b) {
  const [am, an] = a.split('.').map(Number);
  const [bm, bn] = b.split('.').map(Number);
  return am - bm || an - bn;
}

// ---------------------------------------------------------------------------
// Converting one source file
// ---------------------------------------------------------------------------

class SourceConverter {
  /**
   * @param {ts.Program} program
   * @param {ts.SourceFile} sf
   * @param {{root: string, externalFile?: string, externalId?: string, versionConstant?: {file: string, name: string, pattern: string}}} opts
   */
  constructor(program, sf, opts) {
    this.program = program;
    this.checker = program.getTypeChecker();
    this.sf = sf;
    this.root = opts.root;
    this.externalFile = opts.externalFile ?? null;
    this.externalId = opts.externalId ?? null;
    this.versionConstant = opts.versionConstant ?? null;
    this.constCache = new Map();
  }

  where(node) {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return `${relative(this.root, sf.fileName).split('\\').join('/')}:${line + 1}`;
  }

  fail(node, message) {
    throw new SchemaExportError(`${this.where(node)}: ${message}`);
  }

  isExported(node) {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  }

  isDefaultExport(node) {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return !!mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  }

  // --- JSDoc ---------------------------------------------------------------

  docText(node) {
    const docs = ts.getJSDocCommentsAndTags(node).filter((d) => ts.isJSDoc(d));
    const doc = docs[docs.length - 1];
    if (!doc) return undefined;
    const text = lf(ts.getTextOfJSDocComment(doc.comment) ?? '').trim();
    return text === '' ? undefined : text;
  }

  tags(node) {
    const out = {};
    for (const tag of ts.getJSDocTags(node)) {
      const name = tag.tagName.text;
      const value = lf(ts.getTextOfJSDocComment(tag.comment) ?? '').replace(/\s+/g, ' ').trim();
      if (!KNOWN_TAGS.has(name)) this.fail(tag, `unknown JSDoc tag @${name}`);
      if (name === 'breaking' || name === 'deprecated' || name === 'see' || name === 'example') continue;
      if (name in out) this.fail(tag, `@${name} given twice`);
      if (name === 'integer') {
        if (value !== '') this.fail(tag, '@integer takes no value');
        out.integer = true;
      } else if (name === 'unit' || name === 'unitFrom') {
        if (!/^[A-Za-z0-9%/_.-]+$/.test(value)) this.fail(tag, `@${name} needs one word, got "${value}"`);
        out[name] = value;
      } else if (name === 'format') {
        if (!FORMATS.has(value)) this.fail(tag, `@format ${value} is not supported (supported: ${[...FORMATS].join(', ')})`);
        out.format = value;
      } else if (name === 'maxItems') {
        if (!/^[A-Z][A-Z0-9_]*$/.test(value)) this.fail(tag, `@maxItems names an exported constant (e.g. EVENTS_RECENT_MAX), got "${value}"`);
        out.maxItems = value;
      } else if (name === 'ros') {
        if (value !== 'json' && value !== 'msg') this.fail(tag, `@ros takes json or msg, got "${value}"`);
        out.ros = value;
      } else if (name === 'rosName') {
        if (!/^[a-z][a-z0-9_]*$/.test(value)) this.fail(tag, `@rosName needs a snake-case name, got "${value}"`);
        out.rosName = value;
      }
    }
    if (out.unit !== undefined && out.unitFrom !== undefined) this.fail(node, '@unit and @unitFrom together: give one');
    return out;
  }

  /** `@breaking <version> <text>` tags anywhere in the file, in source order. */
  breaking() {
    const out = [];
    const seen = new Set();
    const visit = (node) => {
      for (const doc of ts.getJSDocCommentsAndTags(node)) {
        if (!ts.isJSDoc(doc) || seen.has(doc)) continue;
        seen.add(doc);
        for (const tag of doc.tags ?? []) {
          if (tag.tagName.text !== 'breaking') continue;
          const text = lf(ts.getTextOfJSDocComment(tag.comment) ?? '').replace(/\s+/g, ' ').trim();
          const m = /^(\d+\.\d+)\s+(.+)$/.exec(text);
          if (!m) this.fail(tag, '@breaking needs "<version> <what changed>"');
          out.push({ version: m[1], change: m[2] });
        }
      }
    };
    for (const st of this.sf.statements) {
      visit(st);
      if (ts.isVariableStatement(st)) st.declarationList.declarations.forEach(visit);
    }
    return out;
  }

  // --- Declarations --------------------------------------------------------

  /** Exported declarations in declaration order. */
  convert() {
    const definitions = {};
    const constants = {};
    for (const st of this.sf.statements) {
      if (ts.isImportDeclaration(st)) continue;
      if (ts.isExportDeclaration(st) || ts.isExportAssignment(st)) this.fail(st, 're-exports are not supported in a schema file');
      if (!this.isExported(st)) continue;
      if (this.isDefaultExport(st)) this.fail(st, 'default exports are not supported in a schema file');
      if (ts.isInterfaceDeclaration(st)) {
        this.addDefinition(definitions, st, this.interfaceSchema(st));
      } else if (ts.isTypeAliasDeclaration(st)) {
        this.addDefinition(definitions, st, this.aliasSchema(st));
      } else if (ts.isVariableStatement(st)) {
        if (!(st.declarationList.flags & ts.NodeFlags.Const)) this.fail(st, 'an exported variable must be const');
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) this.fail(d, 'destructuring is not supported in a schema file');
          if (!d.initializer) this.fail(d, 'an exported const needs a value');
          constants[d.name.text] = this.evaluate(d.initializer);
        }
      } else {
        this.fail(st, `${ts.SyntaxKind[st.kind]} is not supported in a schema file: export interfaces, type aliases and constants only`);
      }
    }
    return { definitions, constants };
  }

  addDefinition(definitions, decl, schema) {
    const name = decl.name.text;
    if (name in definitions) this.fail(decl, `${name} is declared twice`);
    definitions[name] = schema;
  }

  interfaceSchema(decl) {
    if (decl.typeParameters?.length) this.fail(decl, `${decl.name.text}: generic interfaces are not supported`);
    const tags = this.tags(decl);
    if (tags.integer || tags.unit || tags.unitFrom || tags.format || tags.maxItems || tags.rosName) this.fail(decl, 'number, format, array and ROS name tags belong on properties');
    const members = this.members(decl, new Set());
    const names = new Set(members.filter((m) => ts.isPropertySignature(m)).map((m) => this.memberName(m)));
    const properties = {};
    const required = [];
    let additional = false;
    for (const m of members) {
      if (ts.isPropertySignature(m)) {
        const name = this.memberName(m);
        if (!m.type) this.fail(m, `${name} has no type`);
        properties[name] = this.propertySchema(m, name, names);
        if (!m.questionToken) required.push(name);
      } else if (ts.isIndexSignatureDeclaration(m)) {
        const key = m.parameters[0]?.type;
        if (!key || key.kind !== ts.SyntaxKind.StringKeyword) this.fail(m, 'only string index signatures are supported');
        additional = m.type.kind === ts.SyntaxKind.UnknownKeyword ? true : this.typeSchema(m.type, {});
      } else {
        this.fail(m, `${ts.SyntaxKind[m.kind]} is not supported in a schema interface (properties only)`);
      }
    }
    const out = {};
    const description = this.docText(decl);
    if (description) out.description = description;
    out.type = 'object';
    out.properties = properties;
    if (required.length) out.required = required;
    out.additionalProperties = additional;
    if (tags.ros) out['x-ros'] = tags.ros;
    return out;
  }

  /** Own members after those of the interfaces it extends; an own member replaces an inherited one. */
  members(decl, seen) {
    if (seen.has(decl)) this.fail(decl, 'circular extends');
    seen.add(decl);
    const byName = new Map();
    for (const clause of decl.heritageClauses ?? []) {
      for (const base of clause.types) {
        if (base.typeArguments?.length) this.fail(base, 'extending a generic type is not supported');
        const target = this.resolveDeclaration(base.expression, base);
        if (!ts.isInterfaceDeclaration(target)) this.fail(base, 'an interface may extend only interfaces');
        for (const m of this.members(target, seen)) byName.set(this.memberKey(m), m);
      }
    }
    for (const m of decl.members) {
      byName.delete(this.memberKey(m));
      byName.set(this.memberKey(m), m);
    }
    return [...byName.values()];
  }

  memberKey(m) {
    return ts.isIndexSignatureDeclaration(m) ? '[index]' : m.name ? this.memberName(m) : `[${m.pos}]`;
  }

  memberName(m) {
    const n = m.name;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
    this.fail(m, 'computed property names are not supported');
  }

  aliasSchema(decl) {
    if (decl.typeParameters?.length) this.fail(decl, `${decl.name.text}: generic type aliases are not supported`);
    const tags = this.tags(decl);
    if (tags.integer || tags.unit || tags.unitFrom || tags.format || tags.maxItems || tags.rosName) this.fail(decl, 'number, format, array and ROS name tags belong on properties');
    const description = this.docText(decl);
    const type = unparen(decl.type);
    // An alias that only renames another definition.
    if (ts.isTypeReferenceNode(type) && !type.typeArguments?.length && !BUILTIN_GENERICS.has(type.typeName.getText())) {
      const ref = this.refSchema(type);
      return { ...(description ? { description } : {}), $ref: ref.$ref, 'x-ros': 'alias' };
    }
    const schema = this.typeSchema(decl.type, {});
    const out = { ...(description ? { description } : {}), ...schema };
    if (tags.ros) out['x-ros'] = tags.ros;
    return out;
  }

  propertySchema(m, name, siblings) {
    const tags = this.tags(m);
    const ctx = { integer: !!tags.integer, sawNumber: false, sawString: false };
    const schema = this.typeSchema(m.type, ctx);
    if (tags.integer && !ctx.sawNumber) this.fail(m, `@integer on ${name}, which is not a number`);
    if (tags.format && !(ctx.sawString && isStringish(schema))) this.fail(m, `@format on ${name}, which is not a string`);
    if (tags.unitFrom !== undefined && !siblings.has(tags.unitFrom)) this.fail(m, `@unitFrom names ${tags.unitFrom}, which is no property of the same type`);
    let capped = schema;
    if (tags.maxItems !== undefined) {
      const isArray = schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'));
      if (!isArray || Array.isArray(schema.items)) this.fail(m, `@maxItems on ${name}, which is not a list`);
      capped = { ...schema, maxItems: this.capConstant(m, tags.maxItems) };
    }
    const description = this.docText(m);
    return annotate(capped, {
      description,
      format: tags.format,
      'x-unit': tags.unit,
      'x-unit-from': tags.unitFrom,
      'x-ros': tags.ros,
      'x-max-items-from': tags.maxItems,
      'x-ros-name': tags.rosName ?? rosName(name),
    });
  }

  /** The value of the exported constant `name` of this file, a whole number of at least 1 (an array cap). */
  capConstant(at, name) {
    const decl = this.sf.statements
      .filter((st) => ts.isVariableStatement(st) && this.isExported(st))
      .flatMap((st) => [...st.declarationList.declarations])
      .find((d) => ts.isIdentifier(d.name) && d.name.text === name);
    if (!decl) this.fail(at, `@maxItems names ${name}, which is no exported constant of this file`);
    const value = this.evaluateDeclaration(decl);
    if (!Number.isInteger(value) || value < 1) this.fail(at, `@maxItems names ${name}, which is not a whole number of at least 1`);
    return value;
  }

  // --- Types ---------------------------------------------------------------

  typeSchema(node, ctx) {
    node = unparen(node);
    switch (node.kind) {
      case ts.SyntaxKind.StringKeyword:
        ctx.sawString = true;
        return { type: 'string' };
      case ts.SyntaxKind.NumberKeyword:
        ctx.sawNumber = true;
        return { type: ctx.integer ? 'integer' : 'number' };
      case ts.SyntaxKind.BooleanKeyword:
        return { type: 'boolean' };
      case ts.SyntaxKind.UnknownKeyword:
        return {};
      case ts.SyntaxKind.TypeLiteral:
        return this.fail(node, 'inline object type: give it a name (an exported interface) so the schema can name it');
      case ts.SyntaxKind.MappedType:
        return this.fail(node, 'mapped type: use a named interface');
      case ts.SyntaxKind.IntersectionType:
        return this.fail(node, 'intersection type: use a named interface (extends) instead');
      case ts.SyntaxKind.AnyKeyword:
        return this.fail(node, '`any` has no schema: use unknown or a named type');
      case ts.SyntaxKind.ArrayType:
        return { type: 'array', items: this.typeSchema(node.elementType, ctx) };
      case ts.SyntaxKind.TupleType:
        return this.tupleSchema(node, ctx);
      case ts.SyntaxKind.TypeOperator:
        if (node.operator === ts.SyntaxKind.ReadonlyKeyword) return this.typeSchema(node.type, ctx);
        return this.fail(node, `${ts.tokenToString(node.operator)} types are not supported`);
      case ts.SyntaxKind.LiteralType:
        return this.literalSchema(node, ctx);
      case ts.SyntaxKind.UnionType:
        return this.unionSchema(node, ctx);
      case ts.SyntaxKind.TypeQuery:
        return this.typeQuerySchema(node, ctx);
      case ts.SyntaxKind.TypeReference:
        return this.referenceSchema(node, ctx);
      default:
        return this.fail(node, `${ts.SyntaxKind[node.kind]} is not supported in a schema type`);
    }
  }

  literalSchema(node, ctx) {
    const lit = node.literal;
    switch (lit.kind) {
      case ts.SyntaxKind.NullKeyword:
        return { type: 'null' };
      case ts.SyntaxKind.TrueKeyword:
        return { type: 'boolean', const: true };
      case ts.SyntaxKind.FalseKeyword:
        return { type: 'boolean', const: false };
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        ctx.sawString = true;
        return { type: 'string', const: lit.text };
      case ts.SyntaxKind.NumericLiteral: {
        ctx.sawNumber = true;
        const value = Number(lit.text.replace(/_/g, ''));
        return { type: ctx.integer || Number.isInteger(value) ? 'integer' : 'number', const: value };
      }
      case ts.SyntaxKind.PrefixUnaryExpression: {
        if (lit.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(lit.operand)) {
          ctx.sawNumber = true;
          const value = -Number(lit.operand.text.replace(/_/g, ''));
          return { type: ctx.integer || Number.isInteger(value) ? 'integer' : 'number', const: value };
        }
        return this.fail(node, 'unsupported literal type');
      }
      default:
        return this.fail(node, 'unsupported literal type');
    }
  }

  tupleSchema(node, ctx) {
    const items = node.elements.map((el) => {
      if (ts.isNamedTupleMember(el)) {
        if (el.questionToken || el.dotDotDotToken) this.fail(el, 'optional and rest tuple members are not supported');
        return this.typeSchema(el.type, ctx);
      }
      if (ts.isOptionalTypeNode(el) || ts.isRestTypeNode(el)) this.fail(el, 'optional and rest tuple members are not supported');
      return this.typeSchema(el, ctx);
    });
    return { type: 'array', items, additionalItems: false, minItems: items.length, maxItems: items.length };
  }

  unionSchema(node, ctx) {
    const members = node.types.map(unparen);
    for (const m of members) {
      if (m.kind === ts.SyntaxKind.UndefinedKeyword) this.fail(m, 'undefined in a union: make the property optional instead');
    }
    const isNull = (m) => ts.isLiteralTypeNode(m) && m.literal.kind === ts.SyntaxKind.NullKeyword;
    const nullable = members.some(isNull);
    const rest = members.filter((m) => !isNull(m));
    if (rest.length === 0) return { type: 'null' };

    // Literals of one primitive type -> enum.
    const literals = rest.map((m) => (ts.isLiteralTypeNode(m) && !isNull(m) ? this.literalSchema(m, ctx) : null));
    if (literals.every((l) => l !== null)) {
      const types = new Set(literals.map((l) => l.type));
      if (types.size === 2 && types.has('integer') && types.has('number')) types.delete('integer');
      if (types.size === 1) {
        const [type] = types;
        if (type === 'boolean' && literals.length === 2 && new Set(literals.map((l) => l.const)).size === 2) {
          return nullable ? { type: ['boolean', 'null'] } : { type: 'boolean' };
        }
        const values = literals.map((l) => l.const);
        if (new Set(values).size !== values.length) this.fail(node, 'a literal is listed twice');
        return nullable ? { type: [type, 'null'], enum: [...values, null] } : { type, enum: values };
      }
    }

    if (rest.length === 1) {
      const schema = this.typeSchema(rest[0], ctx);
      return nullable ? withNull(schema) : schema;
    }

    const branches = rest.map((m) => this.typeSchema(m, ctx));
    const key = this.discriminant(rest);
    const out = key ? { oneOf: branches } : { anyOf: branches };
    if (nullable) out[key ? 'oneOf' : 'anyOf'].push({ type: 'null' });
    return out;
  }

  /** The property every member names with a distinct string literal (`type` of StreamFrame), or null. */
  discriminant(members) {
    const decls = [];
    for (const m of members) {
      if (!ts.isTypeReferenceNode(m) || m.typeArguments?.length) return null;
      const decl = this.resolveDeclaration(m.typeName, m);
      if (!ts.isInterfaceDeclaration(decl)) return null;
      decls.push(decl);
    }
    const literalOf = (decl, name) => {
      const prop = this.members(decl, new Set()).find((p) => ts.isPropertySignature(p) && this.memberName(p) === name);
      if (!prop || prop.questionToken || !prop.type) return null;
      const t = unparen(prop.type);
      return ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : null;
    };
    const candidates = this.members(decls[0], new Set())
      .filter((p) => ts.isPropertySignature(p))
      .map((p) => this.memberName(p));
    const ordered = ['type', 'kind', ...candidates.filter((n) => n !== 'type' && n !== 'kind')];
    for (const name of ordered) {
      const values = decls.map((d) => literalOf(d, name));
      if (values.every((v) => v !== null) && new Set(values).size === values.length) return name;
    }
    return null;
  }

  typeQuerySchema(node, ctx) {
    if (!ts.isIdentifier(node.exprName)) this.fail(node, 'typeof works on a constant name only');
    const decl = this.resolveDeclaration(node.exprName, node);
    if (!ts.isVariableDeclaration(decl)) this.fail(node, 'typeof works on a constant name only');
    const vc = this.versionConstant;
    if (vc && decl.name.getText() === vc.name && samePath(decl.getSourceFile().fileName, vc.file)) {
      ctx.sawString = true;
      return { type: 'string', pattern: vc.pattern };
    }
    const value = this.evaluateDeclaration(decl);
    if (typeof value === 'string') {
      ctx.sawString = true;
      return { type: 'string', const: value };
    }
    if (typeof value === 'number') {
      ctx.sawNumber = true;
      return { type: ctx.integer || Number.isInteger(value) ? 'integer' : 'number', const: value };
    }
    if (typeof value === 'boolean') return { type: 'boolean', const: value };
    return this.fail(node, 'typeof works on a string, number or boolean constant only');
  }

  referenceSchema(node, ctx) {
    const name = node.typeName.getText();
    const args = node.typeArguments ?? [];
    if (name === 'Array' || name === 'ReadonlyArray') {
      if (args.length !== 1) this.fail(node, `${name} needs one type argument`);
      return { type: 'array', items: this.typeSchema(args[0], ctx) };
    }
    if (name === 'Record') {
      if (args.length !== 2 || unparen(args[0]).kind !== ts.SyntaxKind.StringKeyword) {
        this.fail(node, 'only Record<string, T> is supported');
      }
      const value = unparen(args[1]);
      return {
        type: 'object',
        additionalProperties: value.kind === ts.SyntaxKind.UnknownKeyword ? true : this.typeSchema(value, ctx),
      };
    }
    if (args.length) this.fail(node, `${name}<...> is not supported: name the type (an exported interface)`);
    return this.refSchema(node);
  }

  refSchema(node) {
    const decl = this.resolveDeclaration(node.typeName, node);
    if (!ts.isInterfaceDeclaration(decl) && !ts.isTypeAliasDeclaration(decl)) {
      this.fail(node, `${node.typeName.getText()} is not an interface or a type alias`);
    }
    const name = decl.name.text;
    const file = decl.getSourceFile().fileName;
    if (!this.isExported(decl)) this.fail(node, `${name} is not exported, so the schema cannot name it`);
    if (samePath(file, this.sf.fileName)) return { $ref: `#/definitions/${name}` };
    if (this.externalFile && samePath(file, this.externalFile)) return { $ref: `${this.externalId}#/definitions/${name}` };
    return this.fail(node, `${name} comes from ${relative(this.root, file)}, which is not a schema file`);
  }

  resolveDeclaration(nameNode, at) {
    let sym = this.checker.getSymbolAtLocation(nameNode);
    if (!sym) this.fail(at, `cannot resolve ${nameNode.getText()}`);
    if (sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
    const decl = sym.declarations?.[0];
    if (!decl) this.fail(at, `cannot resolve ${nameNode.getText()}`);
    if (sym.declarations.length > 1 && !sym.declarations.every((d) => ts.isInterfaceDeclaration(d))) {
      this.fail(at, `${nameNode.getText()} has more than one declaration`);
    }
    if (sym.declarations.length > 1) this.fail(at, `${nameNode.getText()}: merged interface declarations are not supported`);
    return decl;
  }

  // --- Constants -----------------------------------------------------------

  evaluateDeclaration(decl) {
    if (this.constCache.has(decl)) {
      const v = this.constCache.get(decl);
      if (v === IN_PROGRESS) this.fail(decl, 'constant refers to itself');
      return v;
    }
    if (!(decl.parent.flags & ts.NodeFlags.Const) || !decl.initializer) this.fail(decl, 'only const values can be evaluated');
    this.constCache.set(decl, IN_PROGRESS);
    const value = this.evaluate(decl.initializer);
    this.constCache.set(decl, value);
    return value;
  }

  evaluate(expr) {
    while (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isSatisfiesExpression(expr)
    ) {
      expr = expr.expression;
    }
    if (ts.isNumericLiteral(expr)) return Number(expr.text.replace(/_/g, ''));
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPrefixUnaryExpression(expr)) {
      const v = this.evaluate(expr.operand);
      if (typeof v !== 'number') this.fail(expr, 'unary operator on a non-number');
      if (expr.operator === ts.SyntaxKind.MinusToken) return -v;
      if (expr.operator === ts.SyntaxKind.PlusToken) return v;
      this.fail(expr, 'unsupported unary operator');
    }
    if (ts.isBinaryExpression(expr)) {
      const a = this.evaluate(expr.left);
      const b = this.evaluate(expr.right);
      const op = expr.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken && (typeof a === 'string' || typeof b === 'string')) return `${a}${b}`;
      if (typeof a !== 'number' || typeof b !== 'number') this.fail(expr, 'arithmetic on a non-number');
      switch (op) {
        case ts.SyntaxKind.PlusToken: return a + b;
        case ts.SyntaxKind.MinusToken: return a - b;
        case ts.SyntaxKind.AsteriskToken: return a * b;
        case ts.SyntaxKind.SlashToken: return a / b;
        case ts.SyntaxKind.PercentToken: return a % b;
        case ts.SyntaxKind.AsteriskAsteriskToken: return a ** b;
        default: this.fail(expr, 'unsupported operator');
      }
    }
    if (ts.isTemplateExpression(expr)) {
      let s = expr.head.text;
      for (const span of expr.templateSpans) s += `${this.evaluate(span.expression)}${span.literal.text}`;
      return s;
    }
    if (ts.isIdentifier(expr)) {
      const decl = this.resolveDeclaration(expr, expr);
      if (!ts.isVariableDeclaration(decl)) this.fail(expr, `${expr.text} is not a constant`);
      return this.evaluateDeclaration(decl);
    }
    if (ts.isArrayLiteralExpression(expr)) {
      return expr.elements.map((e) => {
        if (ts.isSpreadElement(e)) this.fail(e, 'spread is not supported in a constant');
        return this.evaluate(e);
      });
    }
    if (ts.isObjectLiteralExpression(expr)) {
      const out = {};
      for (const p of expr.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) out[p.name.text] = this.evaluate(p.initializer);
        else if (ts.isShorthandPropertyAssignment(p)) out[p.name.text] = this.evaluate(p.name);
        else this.fail(p, 'only plain properties are supported in a constant object');
      }
      return out;
    }
    return this.fail(expr, 'cannot evaluate this constant (literals and simple arithmetic over other constants only)');
  }
}

const IN_PROGRESS = Symbol('in progress');
const BUILTIN_GENERICS = new Set(['Array', 'ReadonlyArray', 'Record']);

function unparen(node) {
  while (ts.isParenthesizedTypeNode(node)) node = node.type;
  return node;
}

function isStringish(schema) {
  const t = schema.type;
  return t === 'string' || (Array.isArray(t) && t.includes('string') && t.every((x) => x === 'string' || x === 'null'));
}

/** `T | null`. */
function withNull(schema) {
  if ('$ref' in schema || 'oneOf' in schema || 'allOf' in schema) return { anyOf: [schema, { type: 'null' }] };
  if ('anyOf' in schema) return { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] };
  if (schema.type === undefined) return schema; // unknown already admits null
  const out = { ...schema };
  out.type = Array.isArray(schema.type) ? [...new Set([...schema.type, 'null'])] : [schema.type, 'null'];
  if ('const' in out) {
    out.enum = [out.const, null];
    delete out.const;
    return reorder(out);
  }
  if (out.enum) out.enum = [...out.enum, null];
  return out;
}

const KEY_ORDER = ['description', 'type', 'const', 'enum', 'pattern', 'format', 'items', 'additionalItems', 'minItems', 'maxItems'];
function reorder(schema) {
  const out = {};
  for (const k of KEY_ORDER) if (k in schema) out[k] = schema[k];
  for (const k of Object.keys(schema)) if (!(k in out)) out[k] = schema[k];
  return out;
}

/**
 * Annotations beside a schema. Draft-07 ignores every keyword beside `$ref`,
 * so an annotated reference becomes `allOf: [{$ref}]` with them beside it.
 */
function annotate(schema, annotations) {
  const ann = Object.fromEntries(Object.entries(annotations).filter(([, v]) => v !== undefined));
  const { description, ...rest } = ann;
  const head = description ? { description } : {};
  if ('$ref' in schema) return { ...head, allOf: [schema], ...rest };
  const { format, ...xs } = rest;
  return { ...head, ...reorder({ ...schema, ...(format ? { format } : {}) }), ...xs };
}

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

function compilerOptions(root) {
  const configPath = join(root, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new SchemaExportError(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  return { ...parsed.options, noEmit: true, declaration: false, declarationMap: false, sourceMap: false };
}

function sourceFileOf(program, path, root) {
  const sf = program.getSourceFile(path) ?? program.getSourceFiles().find((f) => samePath(f.fileName, path));
  if (!sf) throw new SchemaExportError(`${relative(root, path)}: not found`);
  const diags = program.getSyntacticDiagnostics(sf);
  if (diags.length) {
    const d = diags[0];
    const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    throw new SchemaExportError(`${relative(root, path)}:${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
  }
  return sf;
}

function snapshotDescription(major, version) {
  return [
    `The abb-rws-daemon wire format, major line ${major}, generated from the daemon's TypeScript types.`,
    `Root: one ControllerSnapshot. Every type of the wire is under definitions (stream frames: StreamFrame).`,
    `This file is the schema of version ${version} exactly (x-schema-version). Validating strictly against it means "this version exactly":`,
    `objects allow no other properties. A consumer built against an older version must not validate a newer daemon strictly.`,
    `Changes within ${major}.x are usually additive, but breaking changes inside ${major}.x are possible; each is listed in x-breaking.`,
    `Validate a recording or a fixture against the history file of the version it names (history/v<version>.schema.json).`,
    `Units: x-unit on a number names its unit; x-unit-from names the sibling property that holds it. Times are ISO 8601 UTC (format date-time).`,
    `x-ros-name is each property's field name on the ROS side.`,
  ].join(' ');
}

function recordingDescription(formatVersion, major) {
  return [
    `The abb-rws-daemon recording file, format version ${formatVersion}: JSON Lines (UTF-8, one JSON object per line, LF),`,
    `a header line first, then records, each with \`kind\` as its first member.`,
    `Frame records carry /v${major}/stream frames, defined by the snapshot schema (${SNAPSHOT_ID_PREFIX}v${major});`,
    `validate them against the snapshot schema history file of the header's schemaVersion.`,
    `Readers ignore unknown kinds and unknown fields, and refuse a formatVersion they do not know.`,
  ].join(' ');
}

/**
 * Builds every file under schema/ from the TypeScript sources.
 * @param {{root?: string}} [opts]
 * @returns {{version: string, files: Record<string, string>, frozen: string[], problems: string[]}}
 *   `files`: path (relative to root, `/`-separated) -> content (LF).
 *   `frozen`: history files of earlier versions, never written.
 *   `problems`: frozen history files that changed or are not listed, and a
 *   released version whose TypeScript no longer makes its history file.
 */
export function generate(opts = {}) {
  const root = opts.root ?? ROOT;
  const v0Path = join(root, V0_SOURCE);
  const recPath = join(root, RECORDING_SOURCE);
  const hasRecording = existsSync(recPath);
  const program = ts.createProgram(hasRecording ? [v0Path, recPath] : [v0Path], compilerOptions(root));

  // v0.ts
  const v0Sf = sourceFileOf(program, v0Path, root);
  const versionDecl = v0Sf.statements
    .filter((s) => ts.isVariableStatement(s))
    .flatMap((s) => [...s.declarationList.declarations])
    .find((d) => ts.isIdentifier(d.name) && d.name.text === 'SCHEMA_VERSION');
  if (!versionDecl) throw new SchemaExportError(`${V0_SOURCE}: no SCHEMA_VERSION`);
  const probe = new SourceConverter(program, v0Sf, { root });
  const version = probe.evaluate(versionDecl.initializer);
  const vm = /^(\d+)\.(\d+)$/.exec(String(version));
  if (!vm) throw new SchemaExportError(`${V0_SOURCE}: SCHEMA_VERSION must look like <major>.<minor>, got ${version}`);
  const major = vm[1];
  const versionConstant = { file: v0Path, name: 'SCHEMA_VERSION', pattern: `^${major}\\.[0-9]+$` };
  const majorId = `${SNAPSHOT_ID_PREFIX}v${major}`;

  const v0 = new SourceConverter(program, v0Sf, { root, versionConstant });
  const { definitions, constants } = v0.convert();
  const rootType = 'ControllerSnapshot';
  if (!(rootType in definitions)) throw new SchemaExportError(`${V0_SOURCE}: no ${rootType}`);

  const snapshot = (id) => ({
    $schema: DRAFT_07,
    $id: id,
    title: rootType,
    description: snapshotDescription(major, version),
    'x-schema-version': version,
    'x-breaking': v0.breaking(),
    'x-constants': constants,
    $ref: `#/definitions/${rootType}`,
    definitions,
  });

  const files = {};
  const mainPath = `schema/v${major}.schema.json`;
  const historyPath = `schema/history/v${version}.schema.json`;
  files[mainPath] = stringify(snapshot(majorId));
  files[historyPath] = stringify(snapshot(`${SNAPSHOT_ID_PREFIX}${version}`));

  // History: earlier versions are frozen; the manifest keeps their hashes.
  const problems = [];
  const frozen = [];
  const indexPath = 'schema/history/index.json';
  const indexFile = join(root, indexPath);
  let entries = [];
  if (existsSync(indexFile)) {
    try {
      entries = JSON.parse(readFileSync(indexFile, 'utf8'));
      if (!Array.isArray(entries)) throw new Error('not a list');
    } catch (err) {
      problems.push(`${indexPath} cannot be read (${err.message})`);
      entries = [];
    }
  }
  const kept = [];
  let current = null;
  const entryOf = (e) => ({ version: e.version, sha256: e.sha256, ...(e.released === true ? { released: true } : {}) });
  for (const e of entries) {
    if (!e || typeof e.version !== 'string' || typeof e.sha256 !== 'string') {
      problems.push(`${indexPath} has an entry without version and sha256`);
      continue;
    }
    if (e.version === version) {
      current = e;
      continue;
    }
    const p = `schema/history/v${e.version}.schema.json`;
    frozen.push(p);
    kept.push(entryOf(e));
    const abs = join(root, p);
    if (!existsSync(abs)) problems.push(`${p} is listed in ${indexPath} but missing`);
    else if (sha256(readFileSync(abs, 'utf8')) !== e.sha256) problems.push(`${p} does not match its sha256 in ${indexPath}: history files are frozen`);
  }
  const historyDir = join(root, 'schema/history');
  if (existsSync(historyDir)) {
    for (const f of readdirSync(historyDir)) {
      const m = /^v(\d+\.\d+)\.schema\.json$/.exec(f);
      if (m && m[1] !== version && !kept.some((e) => e.version === m[1])) problems.push(`schema/history/${f} is not listed in ${indexPath}`);
    }
  }
  if (current?.released === true) {
    // Released: its history file is frozen like any earlier one.
    const made = files[historyPath];
    delete files[historyPath];
    frozen.push(historyPath);
    kept.push(entryOf(current));
    const abs = join(root, historyPath);
    if (!existsSync(abs)) problems.push(`${historyPath} is listed in ${indexPath} but missing`);
    else if (sha256(readFileSync(abs, 'utf8')) !== current.sha256) problems.push(`${historyPath} does not match its sha256 in ${indexPath}: history files are frozen`);
    if (sha256(made) !== current.sha256) {
      problems.push(`${version} is released and the TypeScript no longer makes its schema: raise SCHEMA_VERSION for a wire change`);
    }
  } else {
    kept.push({ version, sha256: sha256(files[historyPath]) });
  }
  kept.sort((a, b) => compareVersions(a.version, b.version));
  files[indexPath] = stringify(kept);

  // recording.ts
  if (hasRecording) {
    const recSf = sourceFileOf(program, recPath, root);
    const rec = new SourceConverter(program, recSf, { root, externalFile: v0Path, externalId: majorId, versionConstant });
    const out = rec.convert();
    const fvName = Object.keys(out.constants).find((n) => /FORMAT_VERSION$/.test(n));
    if (!fvName || !Number.isInteger(out.constants[fvName])) {
      throw new SchemaExportError(`${RECORDING_SOURCE}: no integer constant named *FORMAT_VERSION`);
    }
    const formatVersion = out.constants[fvName];
    files['schema/recording.schema.json'] = stringify({
      $schema: DRAFT_07,
      $id: `${RECORDING_ID_PREFIX}${formatVersion}`,
      title: 'abb-rws-daemon recording',
      description: recordingDescription(formatVersion, major),
      'x-format-version': formatVersion,
      'x-constants': out.constants,
      definitions: out.definitions,
    });
  }

  return { version, files, frozen, problems };
}

/** Paths whose checked-in content differs from `files` (line ends ignored). */
export function outOfDate(files, root = ROOT) {
  const stale = [];
  for (const [p, content] of Object.entries(files)) {
    const abs = join(root, p);
    if (!existsSync(abs) || lf(readFileSync(abs, 'utf8')) !== content) stale.push(p);
  }
  return stale;
}

function main(argv) {
  const check = argv.includes('--check');
  const unknown = argv.filter((a) => a !== '--check');
  if (unknown.length) {
    console.error(`export-schema: unknown argument ${unknown[0]} (usage: export-schema.mjs [--check])`);
    return 2;
  }
  let result;
  try {
    result = generate();
  } catch (err) {
    if (err instanceof SchemaExportError) {
      console.error(`export-schema: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const stale = outOfDate(result.files);
  for (const p of result.problems) console.error(`export-schema: ${p}`);
  if (check) {
    for (const p of stale) console.error(`${p} is out of date: run npm run schema`);
    return stale.length || result.problems.length ? 1 : 0;
  }
  for (const p of stale) {
    const abs = join(ROOT, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, result.files[p]);
    console.log(`wrote ${p}`);
  }
  if (!stale.length) console.log(`schema/ is up to date (${result.version})`);
  return result.problems.length ? 1 : 0;
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const run = realpathSync(isAbsolute(arg) ? arg : resolve(arg));
    return samePath(self, run);
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));

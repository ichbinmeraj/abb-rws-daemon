import { isSecretKey, groupError, redactSecrets } from '../errorMap.js';
import type { SecretSource } from './contract.js';

/**
 * Masking for recordings. Nothing secret reaches a recording file: every
 * record is masked when it is written, on a plain-JSON copy (the daemon's and
 * the client's own objects are never touched), by these rules in order:
 *
 *   1. keys      a value whose key names a secret (isSecretKey) becomes `***`;
 *   2. args      a client method's secret parameter that has no key (SECRET_ARGS);
 *   3. text      every string goes through redactSecrets (header lines,
 *                Basic/Bearer/Digest credentials, URL credentials, `key=value`
 *                pairs), and a key it would change is dropped;
 *   3b. rapid    in RAPID source, the string literals assigned (`:=`) to an
 *                identifier that names a secret become `"***"`;
 *   4. values    every known secret value (the configured passwords, the access
 *                token, every value rules 1 and 2 masked in a call's arguments,
 *                and their encoded forms) is masked wherever it occurs - in a
 *                frame only as a whole token, so ordinary text is not rewritten;
 *                a key holding one is dropped;
 *   5. final     every string and key of what is about to be written is checked
 *                for a known value once more (SecretValues.foundIn): any other
 *                record that fails is not written; a frame is masked by value
 *                anywhere and checked again (maskFrame).
 *
 * A method that is secret as a whole (isSecretMethod) is recorded with
 * arguments `***` and no result. The recorded result of a method listed in
 * CALL_RESULT_DROPPED_KEYS loses the keys listed for it before the rules run.
 *
 * A value too short or too common to mask by value (`weak`: under
 * STRONG_MIN_LENGTH characters, all digits, or found in the controllers' own
 * texts) is counted and left to rules 1-3, which cover every place the daemon
 * itself puts a credential.
 */

/** What a masked value is replaced by. */
export const MASK = '***';

/** The serializer goes at most this deep; deeper values are written as DEPTH_MARK. */
export const SERIAL_DEPTH_MAX = 8;
/** An array keeps at most this many items, then `{"$truncated": <how many more>}`. */
export const SERIAL_ARRAY_MAX = 2_000;
const DEPTH_MARK = '[depth-limit]';

/** A known value shorter than this is weak: masking it by value would rewrite ordinary text. */
export const STRONG_MIN_LENGTH = 8;

/** Plain JSON, as written to a recording. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isPlainObject = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * A fresh plain-JSON copy of `value`, safe to mask and write: plain objects by
 * their own enumerable properties, arrays (at most SERIAL_ARRAY_MAX items),
 * `Date` as ISO text, `Map` as an object, `Set` as an array, an error as the
 * daemon serves one (groupError: code, message masked, the controller's
 * answer), a function as `"[function]"`, a cycle as `"[circular]"`, and any
 * other class instance as `"[object <Name>]"` - never walked, so a session,
 * an adapter or a manager in a result never reaches a file field by field.
 * At most SERIAL_DEPTH_MAX levels deep.
 */
export function toPlainJson(value: unknown): Json {
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): Json | undefined => {
    switch (typeof v) {
      case 'string': return v;
      case 'number': return Number.isFinite(v) ? v : null;
      case 'boolean': return v;
      case 'bigint': return v.toString();
      case 'undefined': return undefined;
      case 'function': return '[function]';
      case 'symbol': return undefined;
    }
    if (v === null) { return null; }
    const o = v as object;
    if (seen.has(o)) { return '[circular]'; }
    if (depth >= SERIAL_DEPTH_MAX) { return DEPTH_MARK; }
    if (o instanceof Date) { return Number.isNaN(o.getTime()) ? null : o.toISOString(); }
    if (o instanceof Error) {
      // The daemon's own shape for a failure: the message and the controller's
      // answer masked, a refusal stripped of anything secret.
      return walk(groupError(o), depth);
    }
    seen.add(o);
    try {
      if (Array.isArray(o)) {
        const out: Json[] = o.slice(0, SERIAL_ARRAY_MAX).map(x => walk(x, depth + 1) ?? null);
        if (o.length > SERIAL_ARRAY_MAX) { out.push({ $truncated: o.length - SERIAL_ARRAY_MAX }); }
        return out;
      }
      if (o instanceof Map) {
        const out: { [key: string]: Json } = {};
        for (const [k, x] of o) {
          const c = walk(x, depth + 1);
          if (c !== undefined) { out[String(k)] = c; }
        }
        return out;
      }
      if (o instanceof Set) {
        return walk([...o], depth);
      }
      if (!isPlainObject(o)) {
        const name = (Object.getPrototypeOf(o) as { constructor?: { name?: unknown } } | null)?.constructor?.name;
        return `[object ${typeof name === 'string' && name ? name : 'Object'}]`;
      }
      const out: { [key: string]: Json } = {};
      for (const k of Object.keys(o)) {
        let x: unknown;
        try { x = (o as Record<string, unknown>)[k]; } catch { x = '[unreadable]'; }
        const c = walk(x, depth + 1);
        if (c !== undefined) { out[k] = c; }
      }
      return out;
    } finally {
      seen.delete(o);
    }
  };
  return walk(value, 0) ?? null;
}

/**
 * Client methods whose result (and whose arguments, whole) are never
 * recorded: anything about cookies, sessions, tokens, credentials,
 * authorization or the control station, and any name that names a secret.
 * Recorded as arguments `***` and result `{"$omitted": "secret"}`.
 */
const SECRET_METHOD = /cookie|session|token|credential|auth|station/i;

/** True for a method whose arguments and result are never recorded. */
export function isSecretMethod(name: string): boolean {
  return SECRET_METHOD.test(name) || isSecretKey(name);
}

/**
 * Client methods with a secret parameter that has no key: the parameter's
 * position. Checked against the client's own parameter names by a test, so a
 * new method with a secret parameter cannot slip through.
 */
export const SECRET_ARGS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  connect: [2],
  startConnect: [2],
  doConnect: [2],
  identifyCandidate: [3],
  lockOperationMode: [0],
  unlockOperationMode: [0],
  changePassword: [0, 1],
  saveSessionCookie: [1],
  forgetSessionCookie: [1],
});

/** A RAPID assignment (declarations included) to an identifier, optionally with array dimensions: `pwd :=`, `ftpPassword{2} :=`. */
const RAPID_ASSIGN = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{[^}\n]*\})?\s*:=/g;

/**
 * Rule 3b: in RAPID source, every string literal assigned to an identifier
 * that names a secret (`VAR string ftpPassword := "...";`, `pwd := "...";`)
 * becomes `"***"`, from the `:=` up to the `;` that ends the statement.
 * Everything else is left exactly as it was. Returns how many literals it
 * masked along with the text.
 */
export function maskRapidSecrets(text: string): { text: string; masked: number } {
  if (!text.includes(':=')) { return { text, masked: 0 }; }
  let out = '';
  let from = 0;
  let masked = 0;
  RAPID_ASSIGN.lastIndex = 0;
  for (let m = RAPID_ASSIGN.exec(text); m; m = RAPID_ASSIGN.exec(text)) {
    if (!isSecretKey(m[1]!)) { continue; }
    let i = m.index + m[0].length;
    out += text.slice(from, i);
    // To the end of the statement: string literals replaced, the rest kept.
    while (i < text.length && text[i] !== ';') {
      if (text[i] === '"') {
        let j = i + 1;
        while (j < text.length) {
          if (text[j] === '"' && text[j + 1] === '"') { j += 2; continue; }   // "" is a quote inside a RAPID string
          if (text[j] === '\\' && j + 1 < text.length) { j += 2; continue; }
          if (text[j] === '"') { break; }
          j++;
        }
        out += `"${MASK}"`;
        masked++;
        i = j + 1;
        continue;
      }
      out += text[i];
      i++;
    }
    from = i;
    RAPID_ASSIGN.lastIndex = i;
  }
  out += text.slice(from);
  return { text: out, masked };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How a known value was added. */
export type SecretKind = 'password' | 'token';

/**
 * The secret values a recording knows, append-only for the whole recording
 * (a controller removed mid-recording keeps its password here while records
 * about it may still be queued). Each value is classified when it is added:
 * strong (masked by value) or weak (counted, and left to the rules by key and
 * by shape). A password also adds its encoded forms: base64 of
 * `user:password` (Basic credentials), base64 of the password, and its
 * percent-encoding.
 */
export class SecretValues implements SecretSource {
  /** Strong values given directly (passwords, the token). */
  private readonly primary = new Set<string>();
  /** Strong encoded forms. */
  private readonly derived = new Set<string>();
  /** Values too short or too common to mask by value. */
  private readonly weak = new Set<string>();
  /** Every strong value, longest first, and the regular expressions over them. */
  private ordered: string[] = [];
  private anyRe: RegExp | null = null;
  private tokenRe: RegExp | null = null;

  /**
   * `commonText` gives the controllers' own texts at the moment (a snapshot
   * frame): a value found there is weak, because masking it would rewrite
   * what the controller says. `onWeak` is told each weak value's controller
   * (never the value).
   */
  constructor(private readonly opts: {
    commonText?: () => string;
    onWeak?: (controller: string | undefined) => void;
  } = {}) {}

  /**
   * Add a known secret value (and, for a password, its encoded forms).
   * Returns whether the value itself is masked by value (strong).
   */
  add(value: string, opts: { user?: string; controller?: string; kind?: SecretKind } = {}): boolean {
    if (typeof value !== 'string' || value.length === 0 || value === MASK) { return false; }
    // The controllers' texts are read at most once per value added, and only
    // when a value is new.
    let common: string | null = null;
    const commonText = (): string => {
      if (common === null) {
        try { common = this.opts.commonText?.() ?? ''; } catch { common = ''; }
      }
      return common;
    };
    const strong = this.addOne(value, 'primary', opts.controller, commonText);
    if ((opts.kind ?? 'password') === 'password') {
      const forms = new Set<string>([
        Buffer.from(value, 'utf8').toString('base64'),
        encodeURIComponent(value),
      ]);
      if (typeof opts.user === 'string' && opts.user.length > 0) {
        forms.add(Buffer.from(`${opts.user}:${value}`, 'utf8').toString('base64'));
      }
      forms.delete(value);
      for (const f of forms) { this.addOne(f, 'derived', opts.controller, commonText); }
    }
    return strong;
  }

  private addOne(value: string, as: 'primary' | 'derived', controller: string | undefined, commonText: () => string): boolean {
    if (this.primary.has(value) || this.derived.has(value)) { return true; }
    if (this.weak.has(value)) { return false; }
    if (this.isWeak(value, commonText)) {
      this.weak.add(value);
      this.opts.onWeak?.(controller);
      return false;
    }
    (as === 'primary' ? this.primary : this.derived).add(value);
    this.ordered = [...this.primary, ...this.derived].sort((a, b) => b.length - a.length);
    const alt = this.ordered.map(escapeRe).join('|');
    this.anyRe = new RegExp(alt, 'g');
    this.tokenRe = new RegExp(`(?<![A-Za-z0-9])(?:${alt})(?![A-Za-z0-9])`, 'g');
    return true;
  }

  private isWeak(value: string, commonText: () => string): boolean {
    if (value.length < STRONG_MIN_LENGTH || /^\d+$/.test(value)) { return true; }
    const common = commonText();
    return common.length > 0 && (common.includes(value) || common.includes(JSON.stringify(value).slice(1, -1)));
  }

  /** The counts a header and an `end` record carry. */
  counts(): { values: number; derived: number; weakValues: number } {
    return { values: this.primary.size, derived: this.derived.size, weakValues: this.weak.size };
  }

  /** Whether any value is masked by value. */
  get empty(): boolean { return this.ordered.length === 0; }

  /**
   * `text` with every strong value masked: anywhere (`wholeTokens` false), or
   * only where no letter or digit is directly before or after it.
   */
  maskIn(text: string, wholeTokens: boolean): { text: string; masked: number } {
    const re = wholeTokens ? this.tokenRe : this.anyRe;
    if (!re || text.length === 0) { return { text, masked: 0 }; }
    let masked = 0;
    re.lastIndex = 0;
    const out = text.replace(re, () => { masked++; return MASK; });
    return { text: out, masked };
  }

  /** Whether `text` holds any strong value anywhere. */
  foundIn(text: string): boolean {
    if (text.length === 0) { return false; }
    for (const v of this.ordered) {
      if (text.includes(v)) { return true; }
    }
    return false;
  }

  /**
   * Whether serialized JSON text may hold a strong value: a cheap first look
   * before the walk of rule 5 (JSON escapes a value character by character,
   * so a value inside a string or key shows up as its escaped form).
   */
  mayBeIn(jsonText: string): boolean {
    for (const v of this.ordered) {
      if (jsonText.includes(v) || jsonText.includes(JSON.stringify(v).slice(1, -1))) { return true; }
    }
    return false;
  }
}

/** What masking did to one record. */
export interface MaskTally {
  /** Values replaced (by any rule). */
  replaced: number;
  /** Keys dropped (rules 3 and 4). */
  droppedKeys: number;
}

/** The user name next to a password, for its Basic form. */
const USER_KEY = /^(user(name)?|login|account)$/i;

/**
 * Apply rules 1, 3, 3b and 4 to a plain-JSON copy, in place (it is the
 * caller's own copy), and count what changed. With `feed`, every string a
 * rule-1 key masks joins `secrets` first (arguments, at a call's start).
 * `frame` masks known values only as whole tokens.
 */
export function maskJson(value: Json, secrets: SecretValues, opts: { frame: boolean; feed?: boolean; controller?: string }): { value: Json; tally: MaskTally } {
  const tally: MaskTally = { replaced: 0, droppedKeys: 0 };
  const maskString = (s: string): string => {
    let out = redactSecrets(s);
    out = maskRapidSecrets(out).text;
    out = secrets.maskIn(out, opts.frame).text;
    if (out !== s) { tally.replaced++; }
    return out;
  };
  const feedFrom = (v: Json, user: string | undefined): void => {
    if (typeof v === 'string') { secrets.add(v, { user, controller: opts.controller, kind: 'password' }); return; }
    if (Array.isArray(v)) { for (const x of v) { feedFrom(x, user); } return; }
    if (v && typeof v === 'object') { for (const x of Object.values(v)) { feedFrom(x, user); } }
  };
  const walk = (v: Json): Json => {
    if (typeof v === 'string') { return maskString(v); }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { v[i] = walk(v[i]!); }
      return v;
    }
    if (v === null || typeof v !== 'object') { return v; }
    const o = v as { [key: string]: Json };
    // Rule 1 first across the object, so a password feeds the values before
    // its siblings are masked by value.
    const userEntry = Object.entries(o).find(([k, x]) => USER_KEY.test(k) && typeof x === 'string');
    const user = userEntry ? (userEntry[1] as string) : undefined;
    for (const k of Object.keys(o)) {
      if (!isSecretKey(k)) { continue; }
      const x = o[k]!;
      // null and a flag (`tokenRequired: true`) carry no credential: kept.
      if (x === null || x === MASK || typeof x === 'boolean') { continue; }
      if (opts.feed) { feedFrom(x, user); }
      o[k] = MASK;
      tally.replaced++;
    }
    for (const k of Object.keys(o)) {
      // A key is dropped, never renamed: a renamed key would show what was
      // masked. A secret-named key is checked too: its name may hold a value.
      if (redactSecrets(k) !== k || secrets.foundIn(k)) {
        delete o[k];
        tally.droppedKeys++;
        continue;
      }
      if (isSecretKey(k)) { continue; }   // masked above
      o[k] = walk(o[k]!);
    }
    return o;
  };
  return { value: walk(value), tally };
}

/**
 * Where the user name sits next to a SECRET_ARGS password, for the password's
 * Basic form (base64 of `user:password`).
 */
export const SECRET_ARG_USER: Readonly<Record<string, number>> = Object.freeze({
  connect: 1,
  startConnect: 1,
  doConnect: 1,
  identifyCandidate: 2,
});

/**
 * Rule 2 and rule 1 on a call's arguments, at the call's start: a fresh copy
 * with every secret parameter (SECRET_ARGS) and every value under a secret
 * key masked, those values added to `secrets` first; then rules 3, 3b and 4.
 * A method that is secret as a whole (isSecretMethod) is recorded with
 * arguments `***`; its secret parameters and secret-keyed values still join
 * `secrets`, so they are masked wherever else they turn up.
 */
export function maskCallArgs(
  method: string, args: readonly unknown[], secrets: SecretValues, controller?: string,
): { args: Json[] | typeof MASK; tally: MaskTally } {
  const copy = args.map(a => toPlainJson(a));
  let replaced = 0;
  const userAt = SECRET_ARG_USER[method];
  const user = userAt !== undefined && typeof copy[userAt] === 'string' ? copy[userAt] as string : undefined;
  for (const i of SECRET_ARGS[method] ?? []) {
    if (i >= copy.length) { continue; }
    const v = copy[i]!;
    if (typeof v === 'string') { secrets.add(v, { user, controller, kind: 'password' }); }
    if (v !== null) { copy[i] = MASK; replaced++; }
  }
  const { value, tally } = maskJson(copy, secrets, { frame: false, feed: true, controller });
  if (isSecretMethod(method)) {
    return { args: MASK, tally: { replaced: Math.max(1, args.length), droppedKeys: 0 } };
  }
  return { args: value as Json[], tally: { replaced: tally.replaced + replaced, droppedKeys: tally.droppedKeys } };
}

/**
 * Rule 5 for a record about to be written: does any string or key still hold
 * a strong value? Numbers are never looked at, so a value can never be
 * "found" inside a time or a count.
 */
export function holdsSecret(value: Json, secrets: SecretValues): boolean {
  if (secrets.empty) { return false; }
  const walk = (v: Json): boolean => {
    if (typeof v === 'string') { return secrets.foundIn(v); }
    if (Array.isArray(v)) { return v.some(walk); }
    if (v === null || typeof v !== 'object') { return false; }
    for (const [k, x] of Object.entries(v)) {
      if (secrets.foundIn(k) || walk(x)) { return true; }
    }
    return false;
  };
  return walk(value);
}

/** Mask every strong value anywhere in a plain-JSON copy (in place): the fallback for a frame rule 5 caught. */
export function maskValuesEverywhere(value: Json, secrets: SecretValues): { value: Json; tally: MaskTally } {
  const tally: MaskTally = { replaced: 0, droppedKeys: 0 };
  const walk = (v: Json): Json => {
    if (typeof v === 'string') {
      const r = secrets.maskIn(v, false);
      if (r.masked > 0) { tally.replaced++; }
      return r.text;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { v[i] = walk(v[i]!); }
      return v;
    }
    if (v === null || typeof v !== 'object') { return v; }
    const o = v as { [key: string]: Json };
    for (const k of Object.keys(o)) {
      if (secrets.foundIn(k)) { delete o[k]; tally.droppedKeys++; continue; }
      o[k] = walk(o[k]!);
    }
    return o;
  };
  return { value: walk(value), tally };
}

/** A frame as it is to be written. */
export interface MaskedFrame {
  /** The frame text: the observed string itself when nothing changed. */
  text: string;
  /** Values replaced plus keys dropped; 0 when `text` is the observed string. */
  masked: number;
  droppedKeys: number;
  /** A known value survived even masking by value: the frame must not be written. */
  held: boolean;
}

/**
 * Rules 1, 3, 3b and 4 (known values as whole tokens) on a stream frame, then
 * rule 5: a frame that still holds a known value is masked by value anywhere
 * and checked again; `held` when even that left one. A frame nothing changed
 * comes back as the very string observed.
 */
export function maskFrame(text: string, secrets: SecretValues): MaskedFrame {
  let parsed: Json;
  try { parsed = JSON.parse(text) as Json; } catch {
    // Not JSON (never a frame the daemon makes): masked as one string.
    const { value, tally } = maskJson(text, secrets, { frame: false });
    const out = value as string;
    return { text: JSON.stringify(out), masked: tally.replaced, droppedKeys: 0, held: secrets.foundIn(out) };
  }
  const first = maskJson(parsed, secrets, { frame: true });
  let masked = first.tally.replaced + first.tally.droppedKeys;
  let droppedKeys = first.tally.droppedKeys;
  let value = first.value;
  if (holdsSecret(value, secrets)) {
    const again = maskValuesEverywhere(value, secrets);
    value = again.value;
    masked += again.tally.replaced + again.tally.droppedKeys;
    droppedKeys += again.tally.droppedKeys;
    if (holdsSecret(value, secrets)) { return { text: '', masked, droppedKeys, held: true }; }
  }
  return masked === 0 ? { text, masked: 0, droppedKeys: 0, held: false } : { text: JSON.stringify(value), masked, droppedKeys, held: false };
}

/** Any other record's payload as it is to be written. */
export interface MaskedValue {
  value: Json;
  /** Values replaced plus keys dropped. */
  masked: number;
  droppedKeys: number;
  /** Rule 5 found a known value: the record must not be written. */
  refused: boolean;
}

/**
 * Keys that are never recorded from the result of one client method, by
 * method name: an id the answer carries under a key too common to mask
 * everywhere. `getMastershipStatus`: the user id of whoever holds mastership
 * (a holder is named, never identified). The call itself is still recorded,
 * with the rest of its result.
 */
export const CALL_RESULT_DROPPED_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  getMastershipStatus: ['uid'],
});

/**
 * Rules 1, 3, 3b and 4 (known values anywhere) on a plain-JSON copy, then
 * the final check (rule 5). `value` must be the caller's own copy
 * (toPlainJson): it is masked in place. A `call` record of a method listed
 * in CALL_RESULT_DROPPED_KEYS first loses those keys of its result, counted
 * with the dropped keys.
 */
export function maskRecordValue(value: Json, secrets: SecretValues): MaskedValue {
  let dropped = 0;
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && value.kind === 'call'
    && typeof value.method === 'string' && Object.hasOwn(CALL_RESULT_DROPPED_KEYS, value.method)) {
    const result = value.result;
    if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
      for (const k of CALL_RESULT_DROPPED_KEYS[value.method]!) {
        if (Object.hasOwn(result, k)) {
          delete result[k];
          dropped++;
        }
      }
    }
  }
  const { value: out, tally } = maskJson(value, secrets, { frame: false });
  return {
    value: out,
    masked: tally.replaced + tally.droppedKeys + dropped,
    droppedKeys: tally.droppedKeys + dropped,
    refused: holdsSecret(out, secrets),
  };
}

/** The masking rules a header lists, in the order they apply. */
export const MASKING_RULES = ['keys', 'args', 'text', 'rapid', 'values', 'final'] as const;

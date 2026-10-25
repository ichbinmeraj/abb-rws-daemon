#!/usr/bin/env node
/**
 * Makes a recording (or a stream capture) fit to be a test fixture: frames
 * only, every identifier of a controller, a machine or a person replaced by a
 * placeholder, then checked for anything left over.
 *
 *   node scripts/sanitize-recording.mjs <in.jsonl> --out <out.jsonl> [--keep-calls] [--user <name>]...
 *   node scripts/sanitize-recording.mjs <part1.jsonl> <part2.jsonl>... --out <new folder> [...]
 *
 * The parts of one recording are sanitized together, so an identifier gets
 * the same placeholder in every part; each part is written to the new folder
 * under its own file name.
 *
 * - Refuses a recording without a `masking` header, or one with a known secret
 *   value too weak to have been masked by value (`weakValues` above 0 in the
 *   header or in any `end` record), and a daemon recording's part without an
 *   `end` record (a hard stop: its final masking counts are unknown).
 * - Keeps the header, the `frame` records and the `end` record (its counts
 *   made right); with --keep-calls every other kind as well, except `setup`
 *   calls (discovery results, passport reads), which are always left out.
 *   Fields named `licencesRaw` and `productsRaw` are left out wherever they
 *   occur.
 * - Every distinct controller name, system name, system id, controller id
 *   (the controller's own and the daemon's), MAC address, host other than
 *   this machine and RobotWare 8 lock holder's station name becomes a
 *   placeholder (`controller-1`, `system-1`, `sysid-1`, `controller-id-1`,
 *   `ctrl-1`, `mac-1`, `host-1`, `station-1`), the same one
 *   everywhere it occurs, in every string of the file: a controller may
 *   report the computer it runs on as its own name, so that name can turn up
 *   in texts too. Keys are never rewritten (they are the records'
 *   structure); a key still holding one of these identifiers refuses the
 *   recording. Login names become `user-1`, `user-2`...: those passed with a
 *   password (connections, passport reads), those under a user-name key,
 *   those an event-log message carries as an argument (log on and off,
 *   program loaded, module erased, parameter changed; see EVENT_USER_ARGS),
 *   and each one named with --user. They are replaced as whole words inside
 *   titles, descriptions and every other text as well, except a name shorter
 *   than 3 characters or a common word (COMMON_LOGIN_WORDS): that one is
 *   replaced only where a whole text is the name, with a warning, unless it
 *   is named with --user. A name in any other event code is replaced only
 *   when named with --user. A number where an event carries a login name
 *   is a value, not a name, and stays.
 * - Every string is then masked once more for credential-shaped text; if that
 *   would change anything, the recording is refused.
 * - A last scan refuses the result if it still holds a MAC address, an IPv4
 *   address other than loopback, an IPv6 address other than ::1, a `.local`
 *   name, a `C:\Users\<name>`, `/home/<name>`, `/Users/<name>` or `/root`
 *   path, a DESKTOP-, LAPTOP- or WIN- machine name, or this computer's own
 *   name or user name.
 * - The header gets `sanitized: true`. Nothing is written unless every check
 *   passes; an existing --out is never overwritten.
 *
 * Review every sanitized recording before it is committed anywhere.
 *
 * Exit status: 0 when the sanitized file was written, 1 otherwise.
 */
import { isIPv6 } from 'node:net';
import { hostname, userInfo } from 'node:os';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function loadDist() {
  try {
    const [errorMap, mask] = await Promise.all([import('../dist/errorMap.js'), import('../dist/recording/mask.js')]);
    return { ...errorMap, ...mask };
  } catch (e) {
    throw new Error(`the daemon is not built (${e instanceof Error ? e.message : String(e)}); run npm run build first, or use npm run sanitize`);
  }
}
const { redactSecrets, SECRET_ARG_USER } = await loadDist();

/** Fields left out of every sanitized recording, wherever they occur. */
export const DROPPED_FIELDS = Object.freeze(['licencesRaw', 'productsRaw']);

/** What each kind of identifier becomes (numbered per distinct value). */
export const PLACEHOLDERS = Object.freeze({
  ctrl: 'ctrl', name: 'controller', system: 'system', sysid: 'sysid', cid: 'controller-id', mac: 'mac', host: 'host', user: 'user', station: 'station',
});

/**
 * Event-log codes whose arguments hold a login name, by argument position:
 * 10400 user logged on, 10401 user logged off, 10040 program loaded by,
 * 10064 module erased by, 10140 configuration parameter changed by.
 */
export const EVENT_USER_ARGS = Object.freeze({
  10040: [1], 10064: [2], 10140: [1], 10400: [0], 10401: [0],
});

const MASK = '***';
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '::']);
const isLoopback = (h) => LOOPBACK.has(h.toLowerCase()) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);

/** Keys whose string value is an identifier of the kind named. */
const KEY_KINDS = Object.assign(Object.create(null), {
  host: 'host', hostname: 'host', address: 'host', ip: 'host',
  username: 'user', user: 'user', login: 'user',
  systemid: 'sysid', sysid: 'sysid',
  mac: 'mac', macaddress: 'mac',
  controllername: 'name', systemname: 'system', controllerid: 'cid',
});

/** A URL's host: `scheme://[user@]host`. */
const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?(\[[0-9A-Fa-f:.]+\]|[^\s/:?#"'\\]+)/gi;

/** The identifiers a record holds, by kind, in the order found. */
function collect(rec, found) {
  const add = (kind, v) => {
    if (typeof v !== 'string') { return; }
    const s = v.trim();
    if (s.length === 0 || s === MASK) { return; }
    if (kind === 'host' && isLoopback(s.replace(/^\[|\]$/g, ''))) { return; }
    // A number where a login name was expected is a value, not a name (one controller's 10040 has one there).
    if (kind === 'user' && /^\d+$/.test(s)) { return; }
    found.push({ kind, value: s });
  };
  const controller = (c) => {
    if (!isObj(c)) { return; }
    add('ctrl', c.id);
    add('name', c.name);
    if (isObj(c.identity)) { identity(c.identity); }
    if (isObj(c.link)) { link(c.link); }
    if (isObj(c.access)) { access(c.access); }
  };
  const identity = (g) => {
    add('name', g.controllerName); add('cid', g.controllerId); add('mac', g.mac); add('system', g.systemName); add('sysid', g.sysId);
  };
  // A RobotWare 8 lock holder is a control station, named as its owner named it.
  const access = (g) => {
    for (const l of Array.isArray(g.locks) ? g.locks : []) {
      if (isObj(l) && isObj(l.holder)) { add('station', l.holder.name); }
    }
  };
  const link = (g) => {
    add('host', g.host);
    if (isObj(g.identityCheck)) { add('sysid', g.identityCheck.expected); add('sysid', g.identityCheck.actual); }
  };
  switch (rec.kind) {
    case 'header':
      for (const c of Array.isArray(rec.controllers) ? rec.controllers : []) { if (isObj(c)) { add('ctrl', c.id); add('sysid', c.systemId); } }
      break;
    case 'controller': add('ctrl', rec.id); add('sysid', rec.systemId); break;
    case 'call': {
      add('ctrl', rec.id);
      // A user name passed by position, next to a (masked) password.
      const at = typeof rec.method === 'string' && Object.hasOwn(SECRET_ARG_USER, rec.method) ? SECRET_ARG_USER[rec.method] : undefined;
      if (at !== undefined && Array.isArray(rec.args)) { add('user', rec.args[at]); }
      break;
    }
    case 'state': case 'sub': add('ctrl', rec.id); break;
    case 'frame': {
      const f = rec.frame;
      if (!isObj(f)) { break; }
      if (f.type === 'snapshot' && Array.isArray(f.controllers)) { f.controllers.forEach(controller); }
      if (f.type === 'delta') {
        add('ctrl', f.id); add('name', f.name);
        if (isObj(f.groups) && isObj(f.groups.identity)) { identity(f.groups.identity); }
        if (isObj(f.groups) && isObj(f.groups.link)) { link(f.groups.link); }
        if (isObj(f.groups) && isObj(f.groups.access)) { access(f.groups.access); }
      }
      if (f.type === 'removed') { add('ctrl', f.id); }
      break;
    }
    default: break;
  }
  // Anywhere else: identifiers by their key, the hosts of URLs, and the login
  // names an event-log message carries.
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(URL_HOST)) { add('host', m[1]); }
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObj(v)) { return; }
    if (typeof v.code === 'number' && Array.isArray(v.args) && Object.hasOwn(EVENT_USER_ARGS, v.code)) {
      for (const i of EVENT_USER_ARGS[v.code]) {
        const a = v.args[i];
        add('user', isObj(a) ? a.value : a);
      }
    }
    for (const [k, x] of Object.entries(v)) {
      const kind = KEY_KINDS[k.toLowerCase()];
      if (kind && typeof x === 'string') { add(kind, x); }
      walk(x);
    }
  };
  walk(rec);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Login names too short or too common to replace inside texts: replacing them
 * there would change ordinary words. Such a name is replaced only where a
 * whole text is that name, unless it is named with --user.
 */
export const COMMON_LOGIN_WORDS = Object.freeze(new Set([
  'user', 'users', 'service', 'operator', 'mode', 'default', 'system', 'guest', 'test', 'robot', 'auto', 'manual',
  'program', 'task', 'module', 'motion', 'rapid', 'local', 'remote', 'internal', 'station', 'controller', 'event',
  'none', 'null', 'true', 'false', 'off', 'all', 'any', 'the', 'and', 'for',
]));

/** Words alternated in one pattern that matches them only whole, longest first. */
function wordPattern(values) {
  const sorted = [...values].sort((a, b) => b.length - a.length);
  return sorted.length === 0 ? null
    : new RegExp(`(?<![A-Za-z0-9])(?:${sorted.map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'gi');
}

/**
 * The placeholder for each distinct identifier (compared without case), a
 * replacer for strings, a test for keys still holding an identifier, and a
 * warning for each login name replaced only where a whole text is that name.
 * `named`: the login names given with --user, always replaced inside texts.
 */
function placeholders(found, named = new Set()) {
  const map = new Map();
  const counts = {};
  const inText = [];
  const inKeys = [];
  const warnings = [];
  for (const { kind, value } of found) {
    const key = value.toLowerCase();
    if (map.has(key)) { continue; }
    counts[kind] = (counts[kind] ?? 0) + 1;
    map.set(key, `${PLACEHOLDERS[kind]}-${counts[kind]}`);
    if (kind !== 'user') { inText.push(key); inKeys.push(key); continue; }
    if (named.has(key) || (key.length >= 3 && !COMMON_LOGIN_WORDS.has(key))) { inText.push(key); continue; }
    warnings.push(`the login name "${value}" is short or a common word: it was replaced only where a whole text is that name, `
      + 'not inside other texts; name it with --user to replace it there too');
  }
  const re = wordPattern(inText);
  const keyRe = wordPattern(inKeys);
  const replace = (s) => {
    const whole = map.get(s.trim().toLowerCase());
    if (whole !== undefined) { return whole; }
    return re === null ? s : s.replace(re, m => map.get(m.toLowerCase()) ?? m);
  };
  const keyHolds = (k) => keyRe !== null && k.search(keyRe) >= 0;
  return { replace, keyHolds, counts, warnings };
}

/** A deep copy with every string replaced, and the dropped fields left out. Keys are never rewritten: they are the frame's structure. */
function rewrite(v, replace) {
  if (typeof v === 'string') { return replace(v); }
  if (Array.isArray(v)) { return v.map(x => rewrite(x, replace)); }
  if (!isObj(v)) { return v; }
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (DROPPED_FIELDS.includes(k)) { continue; }
    out[k] = rewrite(x, replace);
  }
  return out;
}

/** Every key of a value, at any depth. */
function* keysOf(v) {
  if (Array.isArray(v)) { for (const x of v) { yield* keysOf(x); } return; }
  if (!isObj(v)) { return; }
  for (const [k, x] of Object.entries(v)) { yield k; yield* keysOf(x); }
}

/** Every string and key of a value. */
function* strings(v) {
  if (typeof v === 'string') { yield v; return; }
  if (Array.isArray(v)) { for (const x of v) { yield* strings(x); } return; }
  if (!isObj(v)) { return; }
  for (const [k, x] of Object.entries(v)) { yield k; yield* strings(x); }
}

/** What the leftover scan refuses, by name. */
export function leftoverPatterns(own = {}) {
  const host = own.hostname ?? hostname();
  const user = own.username ?? safeUser();
  const token = (s) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(s)}(?![A-Za-z0-9])`, 'i');
  const patterns = [
    { name: 'a MAC address', re: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}(?![0-9A-Fa-f])/ },
    { name: 'an IPv4 address other than loopback', test: (s) => ipv4Leftover(s) },
    { name: 'an IPv6 address other than ::1', test: (s) => ipv6Leftover(s) },
    { name: 'a .local name', re: /(?<![A-Za-z0-9-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.local(?![A-Za-z0-9-])/i },
    { name: 'a Windows user folder', re: /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/i },
    { name: 'a home folder', re: /\/home\/[^/\s"']+/ },
    // A macOS home folder and the root account's, only where a path starts: `C:/Users/...` stays the rule above's.
    { name: 'a home folder', re: /(?<![A-Za-z0-9:\\/.])\/Users\/[^/\s"']+/ },
    { name: 'a home folder', re: /(?<![A-Za-z0-9:\\/.])\/root(?![A-Za-z0-9_.-])/ },
    { name: 'a machine name', re: /(?<![A-Za-z0-9])(?:DESKTOP|LAPTOP|WIN)-[A-Z0-9]{5,}(?![A-Za-z0-9])/i },
  ];
  // This computer's own names, unless they are words every file holds anyway.
  const generic = new Set(['', 'user', 'localhost', 'root']);
  if (host && host.length >= 2 && !generic.has(host.toLowerCase())) { patterns.push({ name: "this computer's name", re: token(host) }); }
  if (user && user.length >= 2 && !generic.has(user.toLowerCase())) { patterns.push({ name: "this computer's user name", re: token(user) }); }
  return patterns;
}

function safeUser() {
  try { return userInfo().username; } catch { return ''; }
}

function ipv4Leftover(s) {
  for (const m of s.matchAll(/(?<![0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g)) {
    const octets = m.slice(1, 5).map(Number);
    if (octets.some(o => o > 255)) { continue; }
    if (octets[0] === 127 || octets.every(o => o === 0)) { continue; }
    return m[0];
  }
  return null;
}

function ipv6Leftover(s) {
  for (const m of s.matchAll(/(?<![0-9A-Za-z:.%])[0-9A-Fa-f]*:[0-9A-Fa-f:]*(?:%[0-9A-Za-z._-]+)?/g)) {
    const candidate = m[0];
    const bare = candidate.replace(/%.*$/, '');
    if (bare === '::1' || bare === '::' || !bare.includes(':')) { continue; }
    if (isIPv6(bare)) { return candidate; }
  }
  return null;
}

function scan(value, patterns) {
  for (const s of strings(value)) {
    for (const p of patterns) {
      const hit = p.test ? p.test(s) : p.re.exec(s)?.[0] ?? null;
      if (hit) { return { pattern: p.name, text: hit }; }
    }
  }
  return null;
}

/** A part's records, or the problems that refuse it. */
function readPart(text) {
  const problems = [];
  const lines = text.split('\n');
  const closed = text.endsWith('\n');
  if (closed) { lines.pop(); }
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.trim() === '') { continue; }
    try {
      records.push({ line: i + 1, rec: JSON.parse(line) });
    } catch {
      if (!closed && i === lines.length - 1) { continue; }   // a part whose writer was killed
      problems.push(`line ${i + 1} is not JSON`);
    }
  }
  const header = records[0]?.rec;
  if (!isObj(header) || header.kind !== 'header' || header.format !== 'abb-rws-recording') {
    return { problems: ['the first line is not a recording header'] };
  }
  if (!isObj(header.masking) || typeof header.masking.weakValues !== 'number') {
    problems.push('the header has no masking section: the recording was not masked when it was written');
  } else if (header.masking.weakValues > 0) {
    problems.push(`the header counts ${header.masking.weakValues} weak secret value(s): they were not masked by value, so this recording cannot be sanitized`);
  }
  for (const { line, rec } of records) {
    if (isObj(rec) && rec.kind === 'end' && isObj(rec.masking) && typeof rec.masking.weakValues === 'number' && rec.masking.weakValues > 0) {
      problems.push(`the end record (line ${line}) counts ${rec.masking.weakValues} weak secret value(s)`);
    }
  }
  // Secret values can join a daemon recording's masking after a part's header
  // (a controller added, a password used); only the end record has the final
  // counts. A part without one (its daemon was stopped hard) cannot show that
  // no weak value joined. A stream capture knows all its values at its start.
  if (header.source !== 'stream-capture' && !records.some(({ rec }) => isObj(rec) && rec.kind === 'end')) {
    problems.push('the part has no end record (its daemon was stopped hard), so its final masking counts are unknown: '
      + 'a weak secret value may have joined after its header; sanitize a part that ended normally');
  }
  return { header, records, problems };
}

/**
 * Sanitize the parts of one recording together, so each identifier gets the
 * same placeholder in every part. Placeholders are numbered in part order (the
 * headers' `part`), whatever order the texts are given in; the results come
 * back in the order given. Returns `{ ok: true, parts: [{ text, kept, dropped
 * }], kept, dropped, placeholders, warnings }` or `{ ok: false, problems }`;
 * never writes.
 * opts: { keepCalls?: boolean, users?: string[], own?: { hostname?, username? } }
 */
export function sanitizeParts(texts, opts = {}) {
  const keepCalls = opts.keepCalls === true;
  const many = texts.length > 1;
  const at = (i, p) => (many ? `part ${i + 1}: ${p}` : p);
  const parts = texts.map(readPart);
  const problems = parts.flatMap((p, i) => p.problems.map(x => at(i, x)));
  if (problems.length > 0) { return { ok: false, problems }; }

  // Identifiers from every record of every part, kept or not, so none can slip through a text.
  const order = parts.map((p, i) => ({ p, i }))
    .sort((a, b) => (Number.isInteger(a.p.header.part) ? a.p.header.part : 0) - (Number.isInteger(b.p.header.part) ? b.p.header.part : 0) || a.i - b.i);
  const found = [];
  for (const { p } of order) { for (const { rec } of p.records) { if (isObj(rec)) { collect(rec, found); } } }
  const named = new Set();
  for (const u of opts.users ?? []) {
    if (typeof u !== 'string' || u.trim().length === 0) { continue; }
    found.push({ kind: 'user', value: u.trim() });
    named.add(u.trim().toLowerCase());
  }
  const { replace, keyHolds, counts, warnings } = placeholders(found, named);
  const patterns = leftoverPatterns(opts.own);

  const kept = {};
  const dropped = {};
  const outParts = [];
  parts.forEach(({ records }, i) => {
    const partKept = {};
    const partDropped = {};
    const out = [];
    for (const { line, rec } of records) {
      if (!isObj(rec) || typeof rec.kind !== 'string') { partDropped.other = (partDropped.other ?? 0) + 1; continue; }
      const keep = rec.kind === 'header' || rec.kind === 'frame' || rec.kind === 'end'
        || (keepCalls && !(rec.kind === 'call' && rec.target === 'setup'));
      if (!keep) { partDropped[rec.kind] = (partDropped[rec.kind] ?? 0) + 1; continue; }
      partKept[rec.kind] = (partKept[rec.kind] ?? 0) + 1;
      const copy = rewrite(rec, replace);
      if (rec.kind === 'header') {
        if (!keepCalls) { copy.content = ['frames']; }
        copy.sanitized = true;
      }
      out.push({ line, rec: copy });
    }

    // The checks run on what would be written.
    for (const { line, rec } of out) {
      for (const s of strings(rec)) {
        if (redactSecrets(s) !== s) {
          problems.push(at(i, `line ${line}: a ${rec.kind} record still holds credential-shaped text`));
          break;
        }
      }
      for (const k of keysOf(rec)) {
        if (keyHolds(k)) { problems.push(at(i, `line ${line}: a ${rec.kind} record has a key holding an identifier`)); break; }
      }
      const hit = scan(rec, patterns);
      if (hit) { problems.push(at(i, `line ${line}: a ${rec.kind} record still holds ${hit.pattern}: ${hit.text}`)); }
    }

    // The end record's counts describe the file as written.
    let bytes = 0;
    const lines = [];
    for (const { rec } of out) {
      if (rec.kind === 'end') {
        rec.records = lines.length + 1;
        rec.bytes = bytes;
      }
      const t = `${JSON.stringify(rec)}\n`;
      lines.push(t);
      bytes += Buffer.byteLength(t, 'utf8');
    }
    for (const [k, n] of Object.entries(partKept)) { kept[k] = (kept[k] ?? 0) + n; }
    for (const [k, n] of Object.entries(partDropped)) { dropped[k] = (dropped[k] ?? 0) + n; }
    outParts.push({ text: lines.join(''), kept: partKept, dropped: partDropped });
  });
  if (problems.length > 0) { return { ok: false, problems }; }
  return { ok: true, parts: outParts, kept, dropped, placeholders: counts, warnings };
}

/**
 * Sanitize a recording's text (one part). Returns `{ ok: true, text, kept,
 * dropped, placeholders, warnings }` or `{ ok: false, problems }`; never
 * writes. A recording of several parts goes through sanitizeParts, so its
 * placeholders agree from part to part.
 * opts: { keepCalls?: boolean, users?: string[], own?: { hostname?, username? } }
 */
export function sanitizeRecording(text, opts = {}) {
  const r = sanitizeParts([text], opts);
  if (!r.ok) { return r; }
  return { ok: true, text: r.parts[0].text, kept: r.kept, dropped: r.dropped, placeholders: r.placeholders, warnings: r.warnings };
}

const USAGE = [
  'usage: node scripts/sanitize-recording.mjs <in.jsonl> --out <out.jsonl> [--keep-calls] [--user <name>]...',
  '       node scripts/sanitize-recording.mjs <part1.jsonl> <part2.jsonl>... --out <new folder> [--keep-calls] [--user <name>]...',
  'Several parts of one recording are sanitized together, so their placeholders agree; each is written to the new folder under its own name.',
  `Login names are found in credentials, passport reads and event codes ${Object.keys(EVENT_USER_ARGS).join(', ')}; `
    + 'a name in other event codes is replaced only when named with --user.',
];

/** Run from the command line: returns the exit code. `write` prints a line. */
export function main(argv, write = (line) => process.stderr.write(`${line}\n`), opts = {}) {
  const usage = () => { for (const l of USAGE) { write(l); } };
  const inputs = [];
  let out = null;
  let keepCalls = false;
  const users = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { usage(); return 0; }
    if (arg === '--keep-calls') { keepCalls = true; continue; }
    if (arg === '--user') {
      const name = argv[++i];
      if (typeof name !== 'string' || name.trim() === '') { write('--user needs a name'); usage(); return 1; }
      users.push(name);
      continue;
    }
    if (arg === '--out') { out = argv[++i] ?? null; continue; }
    if (arg.startsWith('--')) { write(`unexpected argument ${arg}`); usage(); return 1; }
    inputs.push(arg);
  }
  if (inputs.length === 0 || !out) { usage(); return 1; }
  if (inputs.some(f => resolve(f) === resolve(out))) { write('--out must be another file than the input'); return 1; }
  const names = inputs.map(f => basename(f));
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length) { write('two parts have the same file name'); return 1; }
  const texts = [];
  for (const f of inputs) {
    try {
      texts.push(readFileSync(f, 'utf8'));
    } catch (e) {
      write(`the recording cannot be read (${e && e.code ? e.code : 'error'}): ${f}`);
      return 1;
    }
  }
  const r = sanitizeParts(texts, { keepCalls, users, own: opts.own });
  if (!r.ok) {
    write('not sanitized; nothing was written:');
    for (const p of r.problems) { write(`  ${p}`); }
    return 1;
  }
  try {
    if (inputs.length === 1) {
      writeFileSync(out, r.parts[0].text, { encoding: 'utf8', flag: 'wx' });
    } else {
      mkdirSync(out);
      r.parts.forEach((p, i) => writeFileSync(join(out, names[i]), p.text, { encoding: 'utf8', flag: 'wx' }));
    }
  } catch (e) {
    write(e && e.code === 'EEXIST' ? 'the output already exists; it is never overwritten' : `the output could not be written (${e && e.code ? e.code : 'error'})`);
    return 1;
  }
  const list = (o) => Object.entries(o).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  write(`sanitized: kept ${list(r.kept)}; left out ${list(r.dropped)}; placeholders ${list(r.placeholders)}`);
  for (const w of r.warnings) { write(`warning: ${w}`); }
  write('review it before it is committed anywhere');
  return 0;
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

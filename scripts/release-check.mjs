#!/usr/bin/env node
/**
 * Checks that this checkout is fit to be pushed and, with --release, fit to
 * be published. RELEASING.md says when to run which.
 *
 *   node scripts/release-check.mjs                     every-day checks (npm run release:check, CI)
 *   node scripts/release-check.mjs --release           those, and the release rules (prepublishOnly)
 *   node scripts/release-check.mjs --commits <range>   those, and the commits of <range> (before a push)
 *   --deny-file <path>                                 a private list, kept outside the repository: one
 *                                                      entry per line, an exact string (matched whole,
 *                                                      in any case) or a regular expression written
 *                                                      /.../ with its flags (i, m, s, u) after the
 *                                                      closing slash; a line starting with # is a
 *                                                      comment. The environment variable
 *                                                      ABB_RWS_RELEASE_DENY_FILE names a list too.
 *
 * Prints one `ok` or `FAIL` line per check, the details of a FAIL indented
 * under it. Exit status: 0 when every check passed, 1 when one failed, 2 for
 * a command line it does not understand.
 *
 * Always:
 * - Public content. Every text file that could be committed (tracked files
 *   and untracked ones that are not ignored, the lock file left out) is
 *   read for what does not belong in a public repository: authoring-tool and
 *   vendor names, attribution trailers, private-range addresses, machine
 *   names, Windows profile paths and e-mail addresses. The few texts of those
 *   shapes that are meant to be here are listed below, each with its reason.
 *   The tool names are put together when the script runs, so neither this
 *   file nor its test holds one. Names that are private to whoever publishes
 *   (a network, a machine, the folders, documents and trackers of their own
 *   notes) are not in this file: they go in the private list, which this
 *   script never prints.
 * - Package sanity: the bin target, built files without a source, the
 *   `files` entries, the documents, the manifest fields.
 * - Consistency: README, CHANGELOG, the schema history and the schema export
 *   agree with the package version and the schema version.
 *
 * With --release in addition: not private, a plain version, a dated
 * CHANGELOG heading, a README without release leftovers, the client taken
 * from the registry in a range the installed client satisfies, a lock file
 * without links, the schema version marked released, the list of packed
 * files, and the built command and library started once each.
 *
 * No rule looks at a file mode: npm reports 0644 for every file on Windows,
 * and it makes the bin target executable when it installs the package.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGE_NAME = 'abb-rws-daemon';
export const CLIENT_NAME = 'abb-rws-client';
/** Where the compiler writes, and what the bin target must start with. */
export const BUILD_DIR = 'dist';
export const BIN_TARGET = 'dist/cli.js';
export const BIN_FIRST_LINE = '#!/usr/bin/env node';

/** The one question the content scan asks git: tracked files, and untracked ones that are not ignored. */
export const GIT_LIST_ARGS = Object.freeze(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);

/** Listed files the content scan leaves out, each with its reason. */
export const UNSCANNED_FILES = Object.freeze([
  { path: 'package-lock.json', reason: 'written by npm: registry addresses and hashes, no text of ours' },
]);

// ---------------------------------------------------------------------------
// Allow lists. Every entry is a text of a refused shape that is meant to be in
// the repository, with the reason it is harmless.
// ---------------------------------------------------------------------------

/** Private-range addresses that may appear. */
export const ALLOWED_ADDRESSES = Object.freeze([
  { exact: '192.168.125.1', reason: "the controllers' service-port address: the same on every controller and printed in the vendor's manuals" },
  { prefix: '10.0.0.', reason: 'a made-up network the tests and examples use' },
  { prefix: '10.0.5.', reason: 'a made-up network the tests and examples use' },
  { prefix: '10.0.6.', reason: 'a made-up network the tests and examples use' },
  { prefix: '10.0.7.', reason: 'a made-up network the tests and examples use' },
]);

/** Machine names of the Windows default form that may appear: made up for tests. */
export const ALLOWED_MACHINE_NAMES = Object.freeze([
  { name: 'DESKTOP-ABC1234', reason: 'made up: the recording sanitizer test plants it to see it refused' },
  { name: 'LAPTOP-Q9W8E7R', reason: 'made up: the recording sanitizer test plants it to see it refused' },
  { name: 'DESKTOP-AB12CDE', reason: 'made up: the recording writer test checks that an error text loses it' },
]);

/** Names that may follow `<drive>:\Users\`: placeholders, never an account. */
export const ALLOWED_PROFILE_NAMES = Object.freeze([
  { name: 'someone', reason: 'placeholder account in tests' },
  { name: 'jane', reason: 'placeholder account in tests' },
  { name: 'jsmith', reason: 'placeholder account in tests' },
  { name: 'John', reason: 'first word of a made-up two-word account name in the recording writer test' },
  { name: 'First', reason: 'first word of a made-up two-word account name in a comment and its test' },
  { name: 'you', reason: 'the reader, in documentation' },
  { name: 'Public', reason: 'a folder every Windows machine has, not an account' },
]);

/** Texts shaped like an e-mail address that may appear. */
export const ALLOWED_EMAIL_SHAPES = Object.freeze([
  { domain: 'example.com', reason: 'reserved for examples: no real address is there' },
  { domain: 'example.org', reason: 'reserved for examples: no real address is there' },
  { domain: 'example.net', reason: 'reserved for examples: no real address is there' },
  { domain: 'example', reason: 'a top-level name reserved for examples (RFC 2606): no real address is there' },
  { domain: 'invalid', reason: 'a top-level name reserved as never valid (RFC 2606): no real address is there' },
  { domain: 'test', reason: 'a top-level name reserved for tests (RFC 2606): no real address is there' },
  { text: 'validusers@robapi.abb', reason: 'not an address: the authentication realm the controllers announce, which two tests quote' },
  { text: 'git@github.com', reason: 'not an address: the start of an SSH clone URL' },
]);

// ---------------------------------------------------------------------------
// Content rules
// ---------------------------------------------------------------------------

/** Joins fragments. The refused words exist only as pieces in this file, so the scan can read the file itself. */
const w = (...parts) => parts.join('');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LEFT = '(?<![A-Za-z0-9])';
const RIGHT = '(?![A-Za-z0-9])';
const sameWord = (a, b) => a.toLowerCase() === b.toLowerCase();

function patternRule(id, name, patterns) {
  return {
    id,
    name,
    * find(text) {
      for (const re of patterns) {
        for (const m of text.matchAll(re)) { yield { index: m.index, text: m[0] }; }
      }
    },
  };
}

function* privateAddresses(text) {
  for (const m of text.matchAll(/(?<![0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g)) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) { continue; }
    const isPrivate = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
    if (!isPrivate) { continue; }
    const address = o.join('.');
    if (ALLOWED_ADDRESSES.some((a) => (a.exact !== undefined ? a.exact === address : address.startsWith(a.prefix)))) { continue; }
    yield { index: m.index, text: m[0] };
  }
}

function* machineNames(text) {
  const re = new RegExp(`${LEFT}(?:(?:DESKTOP|LAPTOP)-[A-Z0-9]{6,}|WIN-[A-Z0-9]{8,})${RIGHT}`, 'gi');
  for (const m of text.matchAll(re)) {
    const found = m[0];
    // Windows makes these names in capitals with digits. A lower-case pair of
    // plain words in the same shape is prose, not a machine.
    if (found !== found.toUpperCase() && !/\d/.test(found.slice(found.indexOf('-') + 1))) { continue; }
    if (ALLOWED_MACHINE_NAMES.some((a) => sameWord(a.name, found))) { continue; }
    yield { index: m.index, text: found };
  }
}

function* profilePaths(text) {
  // The name ends at the next separator, blank or character no account name can hold;
  // `<name>` and `%USERNAME%` are placeholders by their form and never match.
  for (const m of text.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`<>:|?*%$,;()[\]{}]+)/gi)) {
    const name = m[1].replace(/\.+$/, '');
    if (name === '' || ALLOWED_PROFILE_NAMES.some((a) => sameWord(a.name, name))) { continue; }
    yield { index: m.index, text: m[0] };
  }
}

const LOCAL_PART = /[A-Za-z0-9._%+-]/;
const DOMAIN_PART = /[A-Za-z0-9.-]/;
const DOMAIN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

function* emailShapes(text) {
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    let start = at;
    while (start > 0 && LOCAL_PART.test(text[start - 1])) { start--; }
    let end = at + 1;
    while (end < text.length && DOMAIN_PART.test(text[end])) { end++; }
    const domain = text.slice(at + 1, end).replace(/[.-]+$/, '');
    if (start === at || !DOMAIN.test(domain)) { continue; }
    const found = `${text.slice(start, at)}@${domain}`;
    const allowed = ALLOWED_EMAIL_SHAPES.some((a) => (a.text !== undefined
      ? sameWord(a.text, found)
      : sameWord(a.domain, domain) || domain.toLowerCase().endsWith(`.${a.domain}`)));
    if (!allowed) { yield { index: start, text: found }; }
  }
}

function buildRules() {
  const tools = [w('cl', 'aude'), w('anth', 'ropic'), w('chat', 'gpt'), w('open', 'ai'), w('cop', 'ilot'), w('gem', 'ini')];
  const helper = `(?:${w('assis', 'tant')}|${w('age', 'nt')})`;
  return [
    patternRule('tools', 'an authoring-tool or vendor name', [
      new RegExp(`${LEFT}(?:${tools.join('|')})`, 'gi'),
      new RegExp(`${LEFT}${w('g', 'pt')}-?\\d`, 'gi'),
      new RegExp(`${LEFT}${w('l', 'lm')}s?${RIGHT}`, 'gi'),
      new RegExp(`${LEFT}${w('a', 'i')}[ -](?:${helper}|generated|assisted|written)s?${RIGHT}`, 'gi'),
      new RegExp(`${LEFT}(?:large\\s+)?${w('lang', 'uage')}\\s+model`, 'gi'),
      new RegExp(`${LEFT}coding\\s+${helper}`, 'gi'),
    ]),
    patternRule('attribution', 'an attribution trailer', [
      new RegExp(w('co-', 'authored', '-by'), 'gi'),
      new RegExp(`${w('gener', 'ated')}\\s+with\\s+\\[`, 'gi'),
      new RegExp(String.fromCodePoint(0x1f916), 'gu'),
    ]),
    { id: 'address', name: 'a private-range address', find: privateAddresses },
    { id: 'machine', name: 'a machine name', find: machineNames },
    { id: 'profile', name: 'a Windows profile path', find: profilePaths },
    { id: 'email', name: 'an e-mail address', find: emailShapes },
  ];
}

const RULES = Object.freeze(buildRules());

/** The ids of every content rule, in the order they run. */
export const RULE_IDS = Object.freeze(RULES.map((r) => r.id));
/**
 * The rules for a commit's author, committer and sign-off lines. Such a line
 * carries a person's real address by design, so the e-mail rule (and the
 * other shape rules) do not run there; the private list always does.
 */
export const IDENTITY_RULES = Object.freeze(['tools', 'attribution']);
/** How a hit on the private list is named. The string itself is never printed. */
export const PRIVATE_LIST_RULE = 'private-list';

/**
 * The entries of a private list: one per line, trimmed; blank lines and
 * lines that start with `#` (comments) left out. An entry is an exact string,
 * or a regular expression written `/.../` with its flags after the closing
 * slash (see denyPattern); the entries are returned as written.
 */
export function parseDenyList(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
}

/** `/body/flags` of an entry written as a regular expression, or null for an exact string. */
const DENY_PATTERN = /^\/(.+)\/([imsu]*)$/s;

/**
 * The regular expression an entry of the private list is matched with. An
 * exact string is matched whole (not inside a longer word) in any case. A
 * pattern is matched as written, with the flags it carries (i, m, s, u) and
 * always globally; one that does not compile is reported by its number,
 * never by its text.
 */
function denyPattern(entry, number) {
  const m = DENY_PATTERN.exec(entry);
  if (m === null) {
    const left = /^[A-Za-z0-9]/.test(entry) ? LEFT : '';
    const right = /[A-Za-z0-9]$/.test(entry) ? RIGHT : '';
    return new RegExp(`${left}${escapeRe(entry)}${right}`, 'gi');
  }
  try {
    return new RegExp(m[1], `g${m[2]}`);
  } catch {
    throw new Error(`entry ${number} of the private list is not a valid regular expression`);
  }
}

function lineOf(text, index) {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) { line++; }
  return line;
}

/**
 * What does not belong in public text: `[{ rule, name, text, line }]`, in the
 * order found. opts.rules limits the scan to those rule ids; opts.deny is a
 * private list (parseDenyList), applied whatever opts.rules says.
 */
export function scanText(text, opts = {}) {
  const found = [];
  for (const rule of RULES) {
    if (opts.rules && !opts.rules.includes(rule.id)) { continue; }
    for (const hit of rule.find(text)) { found.push({ rule: rule.id, name: rule.name, text: hit.text, index: hit.index }); }
  }
  (opts.deny ?? []).forEach((entry, i) => {
    for (const m of text.matchAll(denyPattern(entry, i + 1))) {
      if (m[0] === '') { continue; }   // a pattern that admits nothing at all names nothing
      found.push({ rule: PRIVATE_LIST_RULE, name: 'a string of the private list', text: `entry ${i + 1}`, index: m.index });
    }
  });
  found.sort((a, b) => a.index - b.index);
  return found.map((h) => ({ rule: h.rule, name: h.name, text: h.text, line: lineOf(text, h.index) }));
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Runs git in `cwd` and returns what it printed; throws when git is missing or refuses. */
export function runGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) {
    throw new Error(String(r.stderr || r.error?.message || 'git failed').trim().split('\n')[0]);
  }
  return r.stdout;
}

/** Every path that could be committed from `root`, as git names it. */
export function listFiles(root, git = runGit) {
  return git([...GIT_LIST_ARGS], root).split('\0').filter((p) => p !== '');
}

const looksBinary = (buffer) => buffer.subarray(0, 8000).includes(0);

/**
 * Scans the listed files under `root`. A path that is left out by name, is
 * not on disk (deleted but still tracked), is not a file or is not text is
 * counted, not read. Returns `{ scanned, unscanned, missing, notText, hits }`
 * with hits as `{ file, rule, name, text, line }`.
 */
export function scanFiles(root, paths, opts = {}) {
  const result = { scanned: 0, unscanned: [], missing: [], notText: [], hits: [] };
  for (const path of paths) {
    if (UNSCANNED_FILES.some((u) => u.path === path)) { result.unscanned.push(path); continue; }
    const abs = join(root, path);
    let buffer;
    try {
      if (!statSync(abs).isFile()) { result.missing.push(path); continue; }
      buffer = readFileSync(abs);
    } catch {
      result.missing.push(path);
      continue;
    }
    if (looksBinary(buffer)) { result.notText.push(path); continue; }
    result.scanned++;
    for (const hit of scanText(buffer.toString('utf8'), { deny: opts.deny, rules: opts.rules })) {
      result.hits.push({ file: path, ...hit });
    }
  }
  return result;
}

/** Lists what could be committed from `root` and scans it. Throws when `root` is not in a git checkout. */
export function scanCheckout(root, opts = {}) {
  const listed = listFiles(root, opts.git ?? runGit);
  return { listed, ...scanFiles(root, listed, opts) };
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

/** hash, author, committer and the whole message of each commit, in separators no message holds. */
export const COMMIT_FORMAT = '%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B%x1e';

export function parseCommitLog(text) {
  return text.split('\x1e').map((part) => part.replace(/^\s+/, '')).filter((part) => part !== '').map((part) => {
    const [hash = '', author = '', committer = '', message = ''] = part.split('\x1f');
    return { hash, author, committer, message };
  });
}

/**
 * The full scan over each commit's message; the identity rules and the
 * private list over its author and committer lines and over a sign-off line
 * of the message. Returns `[{ commit, where, rule, name, text }]`.
 */
export function scanCommits(commits, opts = {}) {
  const hits = [];
  for (const c of commits) {
    const commit = c.hash.slice(0, 9);
    const identity = { deny: opts.deny, rules: IDENTITY_RULES };
    for (const [where, line] of [['author', c.author], ['committer', c.committer]]) {
      for (const h of scanText(line, identity)) { hits.push({ commit, where, rule: h.rule, name: h.name, text: h.text }); }
    }
    c.message.split('\n').forEach((line, i) => {
      const how = /^\s*signed-off-by:/i.test(line) ? identity : { deny: opts.deny };
      for (const h of scanText(line, how)) { hits.push({ commit, where: `message line ${i + 1}`, rule: h.rule, name: h.name, text: h.text }); }
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Package rules (pure: the caller reads the files)
// ---------------------------------------------------------------------------

const show = (v) => (v === undefined ? 'not set' : JSON.stringify(v));
const posix = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** `0.1.0` of `0.1.0-dev`: the version a development build is on its way to. */
export function baseVersion(version) {
  return String(version ?? '').replace(/[-+].*$/, '');
}

/** The file the package's command runs, or null when the manifest names none. */
export function binTarget(manifest) {
  const bin = manifest?.bin;
  const target = typeof bin === 'string' ? bin : bin?.[PACKAGE_NAME];
  return typeof target === 'string' && target.trim() !== '' ? posix(target.trim()) : null;
}

function firstLineProblem(target, head) {
  if (head === null) { return `${target} is not there`; }
  if (head.startsWith(`${BIN_FIRST_LINE}\n`)) { return null; }
  if (head.startsWith(`${BIN_FIRST_LINE}\r`)) { return `the first line of ${target} ends in CR LF, not LF`; }
  return `${target} does not start with the line ${BIN_FIRST_LINE}`;
}

/** `head` is the start of the bin file as text, or null when the file is missing; it is not looked at before a build. */
export function binProblems(manifest, { built, head }) {
  const target = binTarget(manifest);
  if (target === null) { return [`package.json names no bin target for ${PACKAGE_NAME}`]; }
  if (!built) { return []; }
  const problem = firstLineProblem(target, head);
  return problem ? [problem] : [];
}

/**
 * Built files whose source is gone. The compiler never deletes an output, so
 * a module that was renamed or removed leaves its old `.js` and `.d.ts`
 * behind, and the package ships the whole build folder. Paths are relative to
 * the build folder and to `src/`, with forward slashes.
 */
export function staleDistFiles(distFiles, srcFiles) {
  const sources = new Set(srcFiles);
  return distFiles.filter((file) => {
    const m = /^(.+?)(?:\.d\.ts|\.js)$/.exec(file);
    return m !== null && !sources.has(`${m[1]}.ts`);
  }).sort();
}

/**
 * Shipped files that still end in a source-map comment, sorted. The maps are
 * not shipped, so such a comment points at nothing; the build
 * (tsconfig.build.json) writes neither maps nor comments.
 */
export function sourceMapCommentFiles(files) {
  return files.filter(({ text }) => /^\/\/# sourceMappingURL=/m.test(text)).map(({ path }) => path).sort();
}

/** `files` entries that name nothing on disk. Exclusions and patterns are not looked up; nor is the build folder before a build. */
export function filesEntryProblems(manifest, has, built) {
  const files = manifest?.files;
  if (!Array.isArray(files) || files.length === 0) { return ['package.json has no files list']; }
  const problems = [];
  for (const entry of files) {
    if (typeof entry !== 'string' || entry.startsWith('!')) { continue; }
    const fixed = [];
    for (const part of posix(entry).split('/')) {
      if (/[*?[\]{}]/.test(part)) { break; }
      fixed.push(part);
    }
    const path = fixed.join('/').replace(/\/+$/, '');
    if (path === '' || has(path)) { continue; }
    if (!built && (path === BUILD_DIR || path.startsWith(`${BUILD_DIR}/`))) { continue; }
    problems.push(`files names ${entry}, which does not exist`);
  }
  return problems;
}

export const REQUIRED_DOCUMENTS = Object.freeze(['LICENSE', 'NOTICE', 'README.md', 'CHANGELOG.md']);

export function documentProblems(has) {
  return REQUIRED_DOCUMENTS.filter((doc) => !has(doc)).map((doc) => `${doc} is missing`);
}

export function manifestProblems(manifest) {
  if (!manifest) { return ['package.json is missing or is not JSON']; }
  const problems = [];
  if (manifest.license !== 'Apache-2.0') { problems.push(`license is ${show(manifest.license)}, not "Apache-2.0"`); }
  if (manifest.engines?.node !== '>=22') { problems.push(`engines.node is ${show(manifest.engines?.node)}, not ">=22"`); }
  const isSet = (v) => (typeof v === 'string' ? v.trim() !== ''
    : Array.isArray(v) ? v.length > 0
      : v !== null && typeof v === 'object' && Object.keys(v).length > 0);
  for (const field of ['repository', 'homepage', 'bugs', 'keywords', 'author']) {
    if (!isSet(manifest[field])) { problems.push(`${field} is not set`); }
  }
  return problems;
}

/** Is `value` in `text` as a whole version: not inside a longer number, not followed by a suffix. */
function namesVersion(text, value) {
  return new RegExp(`(?<![0-9.])${escapeRe(value)}(?![0-9A-Za-z]|\\.[0-9]|[-+][0-9A-Za-z])`).test(text);
}

/**
 * The newest version whose CHANGELOG heading carries a date
 * (`## [0.1.0] - 2026-01-31`): the last release, or null when there is none.
 */
export function latestReleased(changelog) {
  let newest = null;
  for (const m of String(changelog ?? '').matchAll(/^##\s+\[?v?(\d+\.\d+\.\d+)\]?\s*-\s*\d{4}-\d{2}-\d{2}\s*$/gm)) {
    if (newest === null || compareParts(versionParts(m[1]), versionParts(newest)) > 0) { newest = m[1]; }
  }
  return newest;
}

/**
 * README against the package version (compared without a development suffix)
 * and the schema version: both are named, every `abb-rws-daemon@<version>` is
 * that version, and no install line leaves the version out (the name alone
 * would fetch whatever the registry calls latest). While the package version
 * carries a development suffix, README may name `released` instead, the last
 * released version: that is the one the registry has until the next release.
 */
export function readmeProblems(readme, { version, schemaVersion, released = null }) {
  if (readme === null) { return ['README.md is missing']; }
  const base = baseVersion(version);
  const wanted = released && released !== base && String(version ?? '') !== base ? [base, released] : [base];
  const problems = [];
  if (base === '' || !wanted.some((v) => namesVersion(readme, v))) { problems.push(`README.md does not name version ${wanted.join(' or ') || '(none)'}`); }
  if (!schemaVersion) { problems.push('the schema version cannot be read from src/schema/v0.ts'); }
  else if (!namesVersion(readme, schemaVersion)) { problems.push(`README.md does not name schema ${schemaVersion}`); }
  for (const m of readme.matchAll(new RegExp(`${escapeRe(PACKAGE_NAME)}@([^\\s\`"'()<>\\[\\],;]*)`, 'g'))) {
    const named = m[1].replace(/[.:]+$/, '');
    if (!wanted.includes(named)) { problems.push(`README.md line ${lineOf(readme, m.index)} names ${PACKAGE_NAME}@${named}, not @${wanted.join(' or @')}`); }
  }
  const bare = new RegExp(`\\b(?:npx|npm\\s+(?:install|i|add))(?:\\s+-{1,2}[A-Za-z][A-Za-z-]*)*\\s+${escapeRe(PACKAGE_NAME)}(?![@A-Za-z0-9_-])`, 'g');
  for (const m of readme.matchAll(bare)) {
    problems.push(`README.md line ${lineOf(readme, m.index)} installs ${PACKAGE_NAME} without a version`);
  }
  return problems;
}

/** What follows the version in its CHANGELOG heading (`## [0.1.0] - 2026-01-31` gives `- 2026-01-31`), or null without a heading. */
export function changelogHeading(changelog, version) {
  const m = new RegExp(`^##\\s+\\[?v?${escapeRe(baseVersion(version))}\\]?(?![0-9A-Za-z.+-])(.*)$`, 'm').exec(changelog ?? '');
  return m ? m[1].trim() : null;
}

export function changelogProblems(changelog, version, { release = false } = {}) {
  if (changelog === null) { return ['CHANGELOG.md is missing']; }
  const base = baseVersion(version);
  const rest = changelogHeading(changelog, version);
  if (rest === null) { return [`CHANGELOG.md has no section for ${base}`]; }
  if (!release) { return []; }
  const m = /^-\s*(\d{4})-(\d{2})-(\d{2})$/.exec(rest);
  const real = m !== null && !Number.isNaN(Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`));
  return real ? [] : [`the CHANGELOG.md heading for ${base} carries no date (it reads "${rest}")`];
}

/** `export const SCHEMA_VERSION = '<v>'` of the schema source, or null. */
export function schemaVersionIn(source) {
  return /export const SCHEMA_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(source ?? '')?.[1] ?? null;
}

export function historyProblems(index, schemaVersion, { release = false } = {}) {
  if (!schemaVersion) { return ['the schema version cannot be read from src/schema/v0.ts']; }
  if (!Array.isArray(index)) { return ['schema/history/index.json is missing or is not a list']; }
  const entry = index.find((e) => e?.version === schemaVersion);
  if (!entry) { return [`schema/history/index.json does not list ${schemaVersion}`]; }
  if (release && entry.released !== true) { return [`schema ${schemaVersion} is not marked released in schema/history/index.json`]; }
  return [];
}

export function privateProblems(manifest) {
  if (!manifest) { return ['package.json is missing or is not JSON']; }
  return manifest.private === undefined || manifest.private === false ? [] : [`private is ${show(manifest.private)}`];
}

export function versionProblems(manifest) {
  if (!manifest) { return ['package.json is missing or is not JSON']; }
  return /^\d+\.\d+\.\d+$/.test(String(manifest.version ?? '')) ? [] : [`version is ${show(manifest.version)}, not x.y.z`];
}

/** What a README must have lost before a release: the wording of an unreleased state and the marked sibling-checkout block. */
export function readmeReleaseProblems(readme) {
  if (readme === null) { return ['README.md is missing']; }
  const problems = [];
  const unreleased = /\bnot\s+(?:yet\s+)?released\b|\bunreleased\b/i.exec(readme);
  if (unreleased) { problems.push(`README.md line ${lineOf(readme, unreleased.index)} says "${unreleased[0]}"`); }
  const marker = /<!--\s*sibling-client:[^>]*-->/.exec(readme);
  if (marker) { problems.push(`README.md line ${lineOf(readme, marker.index)} still has the sibling-client block (RELEASING.md step 1 deletes it)`); }
  return problems;
}

function versionParts(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}
const compareParts = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Does the plain version `x.y.z` satisfy `^x.y.z` or `~x.y.z`? Any other form of either gives false. */
export function satisfies(version, range) {
  const v = versionParts(version);
  const low = versionParts(String(range ?? '').slice(1));
  if (v === null || low === null || !/^[~^]/.test(String(range))) { return false; }
  let high;
  if (range[0] === '~') { high = [low[0], low[1] + 1, 0]; }
  else if (low[0] > 0) { high = [low[0] + 1, 0, 0]; }
  else if (low[1] > 0) { high = [0, low[1] + 1, 0]; }
  else { high = [0, 0, low[2] + 1]; }
  return compareParts(v, low) >= 0 && compareParts(v, high) < 0;
}

/**
 * Why the client dependency is not fit for a release, or null. It must be a
 * registry range that starts with ^ or ~ and that the installed client
 * satisfies. A bare `1.4.0` is refused on purpose: that is what a range looks
 * like after a shell has eaten its caret.
 */
export function clientRangeProblem(spec, installed) {
  if (typeof spec !== 'string' || spec.trim() === '') { return `${CLIENT_NAME} is not in dependencies`; }
  const range = spec.trim();
  if (/^[a-z+]+:/i.test(range) || /[\\/]/.test(range) || range.startsWith('.')) { return `"${range}" is not a registry range`; }
  if (!/^[~^]/.test(range)) { return `"${range}" does not start with ^ or ~ (an exact pin; a shell may have eaten the first character)`; }
  if (versionParts(range.slice(1)) === null) { return `"${range}" is not ^x.y.z or ~x.y.z`; }
  if (!installed) { return `"${range}", and ${CLIENT_NAME} is not installed in node_modules`; }
  if (!satisfies(installed, range)) { return `"${range}" is not satisfied by the installed ${CLIENT_NAME} ${installed}`; }
  return null;
}

/** Linked packages and paths that leave the package, in a parsed package-lock.json. */
export function lockProblems(lock) {
  if (!lock || typeof lock !== 'object') { return ['package-lock.json is missing or is not JSON']; }
  const problems = [];
  const packages = lock.packages ?? {};
  for (const [key, entry] of Object.entries(packages)) {
    const name = key === '' ? 'the package itself' : key;
    if (key.startsWith('..') || key.includes('../')) { problems.push(`${name} is outside the package`); }
    if (entry?.link === true) { problems.push(`${name} is a link`); }
    else if (typeof entry?.resolved === 'string' && /^(?:file:|link:|\.\.?[\\/])/.test(entry.resolved)) { problems.push(`${name} resolves to ${entry.resolved}`); }
  }
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(packages['']?.[group] ?? {})) {
      if (typeof spec === 'string' && (/^(?:file:|link:)/.test(spec) || spec.includes('../'))) { problems.push(`${group}.${name} is ${spec}`); }
    }
  }
  // Whatever the rules above did not name: no value of a lock file may point out of the folder.
  if (problems.length === 0 && JSON.stringify(lock).includes('../')) { problems.push('package-lock.json holds a ../ path'); }
  return problems;
}

/** What may be in the tarball, and what may never be. */
export const PACK_TOP_FILES = Object.freeze(['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'TRADEMARKS.md']);
export const PACK_FOLDERS = Object.freeze(['dist', 'schema']);
export const PACK_REFUSED_ENDINGS = Object.freeze(['.map', '.jsonl', '.tgz', '.config.json']);
export const PACK_REFUSED_FOLDERS = Object.freeze(['tests', 'scripts', '.github', 'recordings']);
export const PACK_MAX_UNPACKED_BYTES = 2_000_000;

/** `[{ path, size, mode }]` and the unpacked size, from what `npm pack --dry-run --json` printed. */
export function parsePackOutput(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end < start) { throw new Error('npm pack printed no file list'); }
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) { throw new Error('npm pack printed no file list'); }
  return {
    files: entry.files.map((f) => ({ path: posix(String(f.path)), size: f.size, mode: f.mode })),
    unpackedSize: Number(entry.unpackedSize),
  };
}

/**
 * The rules for the list of packed files. `binHead` is the start of the bin
 * file as text (null when it is missing). The `mode` npm reports is not
 * looked at: it is 0644 for every file on Windows.
 */
export function packProblems(pack, manifest, { binHead = null } = {}) {
  const problems = [];
  const paths = pack.files.map((f) => f.path);
  for (const path of paths) {
    const parts = path.split('/');
    if (!PACK_TOP_FILES.includes(path) && !(parts.length > 1 && PACK_FOLDERS.includes(parts[0]))) { problems.push(`${path} is not part of the package`); }
    const ending = PACK_REFUSED_ENDINGS.find((e) => path.endsWith(e));
    if (ending) { problems.push(`${path} ends in ${ending}`); }
    if (parts.at(-1) === 'token') { problems.push(`${path} is named token`); }
    const folder = parts.slice(0, -1).find((part) => PACK_REFUSED_FOLDERS.includes(part));
    if (folder) { problems.push(`${path} is under ${folder}/`); }
  }
  const target = binTarget(manifest);
  if (target !== BIN_TARGET) { problems.push(`bin names ${target ?? 'nothing'}, not ${BIN_TARGET}`); }
  if (!paths.includes(BIN_TARGET)) { problems.push(`${BIN_TARGET} is not in the package`); }
  else {
    const first = firstLineProblem(BIN_TARGET, binHead);
    if (first) { problems.push(first); }
  }
  if (!(pack.unpackedSize < PACK_MAX_UNPACKED_BYTES)) { problems.push(`the unpacked size is ${pack.unpackedSize} bytes, not under ${PACK_MAX_UNPACKED_BYTES}`); }
  return problems;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

export const DENY_FILE_ENV = 'ABB_RWS_RELEASE_DENY_FILE';

export const USAGE = Object.freeze([
  'usage: node scripts/release-check.mjs [--release] [--commits <range>] [--deny-file <path>]',
  '',
  '  --release           also the rules a published package must meet',
  '  --commits <range>   also the messages and identity lines of those commits (for example origin/master..HEAD)',
  `  --deny-file <path>  a private list, one entry per line: an exact string, or /.../ with flags (or ${DENY_FILE_ENV})`,
]);

/** `{ release, commits, denyFile, help, problem }`; problem is null or what is wrong with the command line. */
export function parseArgs(argv, env = process.env) {
  const out = { release: false, commits: null, denyFile: env[DENY_FILE_ENV] ? env[DENY_FILE_ENV] : null, help: false, problem: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--release') { out.release = true; }
    else if (a === '--help' || a === '-h') { out.help = true; }
    else if (a === '--commits' || a === '--deny-file') {
      const value = argv[++i];
      if (value === undefined || value.trim() === '' || value.startsWith('-')) { out.problem = `${a} needs a value`; break; }
      if (a === '--commits') { out.commits = value; } else { out.denyFile = value; }
    } else { out.problem = `unknown argument ${a}`; break; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running it (everything below reads files or starts a process)
// ---------------------------------------------------------------------------

const message = (e) => (e instanceof Error ? e.message : String(e));

function walk(dir, prefix = '') {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) { out.push(...walk(join(dir, entry.name), rel)); }
    else { out.push(rel); }
  }
  return out;
}

/** The first bytes of a file as text, or null when it cannot be read. */
function headOf(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(64);
    return buffer.toString('latin1', 0, readSync(fd, buffer, 0, buffer.length, 0));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { closeSync(fd); }
  }
}

function gather(root) {
  const text = (rel) => {
    try { return readFileSync(join(root, rel), 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
  };
  const json = (rel) => {
    try { return JSON.parse(text(rel) ?? ''); } catch { return null; }
  };
  const isDir = (rel) => {
    try { return statSync(join(root, rel)).isDirectory(); } catch { return false; }
  };
  const manifest = json('package.json');
  const built = isDir(BUILD_DIR);
  const target = binTarget(manifest);
  return {
    manifest,
    readme: text('README.md'),
    changelog: text('CHANGELOG.md'),
    schemaVersion: schemaVersionIn(text('src/schema/v0.ts')),
    history: json('schema/history/index.json'),
    lock: json('package-lock.json'),
    built,
    binHead: built && target !== null ? headOf(join(root, target)) : null,
    distFiles: built ? walk(join(root, BUILD_DIR)) : [],
    srcFiles: walk(join(root, 'src')),
    has: (rel) => existsSync(join(root, rel)),
    installedClient: json(`node_modules/${CLIENT_NAME}/package.json`)?.version ?? null,
  };
}

/** The packed file list, as npm sees it. On Windows npm is a command script, which only a shell starts; the arguments are fixed. */
function npmPackList(root) {
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 180_000 };
  const r = process.platform === 'win32'
    ? spawnSync('npm pack --dry-run --json --ignore-scripts', { ...options, shell: true })
    : spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], options);
  if (r.error || r.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${String(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n')[0]}`);
  }
  return parsePackOutput(r.stdout);
}

/** Runs this Node with `args` in `cwd`: `{ status, stdout, stderr, timedOut }`. */
function runNode(args, cwd, env = process.env) {
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error?.code === 'ETIMEDOUT' };
}

const firstLine = (text) => text.trim().split('\n')[0]?.trim() ?? '';

function describeHits(hits, where) {
  const SHOWN = 40;
  const lines = hits.slice(0, SHOWN).map((h) => `${where(h)} ${h.name}: ${h.text}`);
  if (hits.length > SHOWN) { lines.push(`and ${hits.length - SHOWN} more`); }
  return lines;
}

function checksFor(root, args, tools) {
  let facts;
  const f = () => (facts ??= gather(root));

  // The private list is read once; a list that cannot be read fails every check that would have used it.
  let denyState;
  const deny = () => {
    if (denyState === undefined) {
      if (args.denyFile === null) { denyState = { list: [], given: false }; }
      else {
        try { denyState = { list: parseDenyList(readFileSync(args.denyFile, 'utf8')), given: true }; }
        catch { denyState = { error: 'the private list cannot be read' }; }
      }
    }
    if (denyState.error) { throw new Error(denyState.error); }
    return denyState;
  };
  const denyNote = () => (deny().given ? `private list of ${deny().list.length} entries` : 'no private list given');

  let packState;
  const pack = () => {
    if (packState === undefined) {
      try { packState = { value: tools.npmPack(root) }; } catch (e) { packState = { error: message(e) }; }
    }
    if (packState.error) { throw new Error(packState.error); }
    return packState.value;
  };

  const checks = [
    ['public content', () => {
      const { list } = deny();
      let listed;
      try { listed = listFiles(root, tools.git); }
      catch { return { problems: ['the content scan needs a git checkout'] }; }
      // A private list kept inside the checkout could be committed with it: that is the failure, and the list is not read as content.
      const inside = args.denyFile === null ? null : posix(relative(root, resolve(args.denyFile)));
      const scan = { listed, ...scanFiles(root, listed.filter((path) => path !== inside), { deny: list }) };
      const problems = describeHits(scan.hits, (h) => `${h.file}:${h.line}`);
      if (inside !== null && listed.includes(inside)) { problems.unshift(`the private list (${inside}) is inside the checkout and not ignored: keep it outside`); }
      const aside = [
        scan.unscanned.length ? `${scan.unscanned.join(', ')} left out` : '',
        scan.missing.length ? `${scan.missing.length} not on disk` : '',
        scan.notText.length ? `${scan.notText.length} not text` : '',
      ].filter((s) => s !== '').join(', ');
      return { problems, note: `${scan.scanned} of ${scan.listed.length} listed files scanned${aside ? ` (${aside})` : ''}; ${denyNote()}` };
    }],
    ['bin target', () => ({
      problems: binProblems(f().manifest, { built: f().built, head: f().binHead }),
      note: f().built ? `${binTarget(f().manifest)} starts with ${BIN_FIRST_LINE}` : `${BUILD_DIR}/ is not built: the file was not read`,
    })],
    ['built files have a source', () => {
      const stale = f().built ? staleDistFiles(f().distFiles, f().srcFiles) : [];
      return {
        problems: stale.map((file) => `${BUILD_DIR}/${file} has no source under src/ (delete ${BUILD_DIR}/ and build again)`),
        note: f().built ? `${f().distFiles.filter((file) => /(?:\.d\.ts|\.js)$/.test(file)).length} files` : `${BUILD_DIR}/ is not built`,
      };
    }],
    ['files entries', () => ({ problems: filesEntryProblems(f().manifest, f().has, f().built) })],
    ['documents', () => ({ problems: documentProblems(f().has), note: REQUIRED_DOCUMENTS.join(', ') })],
    ['manifest fields', () => ({ problems: manifestProblems(f().manifest) })],
    ['README versions', () => ({
      problems: readmeProblems(f().readme, { version: f().manifest?.version, schemaVersion: f().schemaVersion, released: latestReleased(f().changelog) }),
      note: `version ${baseVersion(f().manifest?.version)}, schema ${f().schemaVersion}`,
    })],
    ['CHANGELOG section', () => ({ problems: changelogProblems(f().changelog, f().manifest?.version), note: baseVersion(f().manifest?.version) })],
    ['schema history', () => ({ problems: historyProblems(f().history, f().schemaVersion), note: `lists ${f().schemaVersion}` })],
    ['schema export', () => {
      const r = tools.node([join(root, 'scripts', 'export-schema.mjs'), '--check'], root);
      return { problems: r.status === 0 ? [] : [`export-schema --check: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.status}`}`], note: 'up to date' };
    }],
  ];

  if (args.commits !== null) {
    checks.push([`commits ${args.commits}`, () => {
      const { list } = deny();
      let log;
      try { log = tools.git(['log', `--format=${COMMIT_FORMAT}`, args.commits, '--'], root); }
      catch (e) { return { problems: [`git log failed: ${message(e)}`] }; }
      const commits = parseCommitLog(log);
      return {
        problems: describeHits(scanCommits(commits, { deny: list }), (h) => `${h.commit} ${h.where}:`),
        note: `${commits.length} commits; ${denyNote()}`,
      };
    }]);
  }

  if (!args.release) { return checks; }

  const spec = () => f().manifest?.dependencies?.[CLIENT_NAME];
  // The command is started with ABB_RWS_DAEMON_RECORD set. The daemon refuses to
  // start with that variable, while --help and --version answer whatever the
  // environment holds: a build that does not know them stops at once instead
  // of starting a daemon here.
  const guarded = { ...(tools.env ?? process.env), ABB_RWS_DAEMON_RECORD: '1' };
  checks.push(
    ['release: not private', () => ({ problems: privateProblems(f().manifest) })],
    ['release: version', () => ({ problems: versionProblems(f().manifest), note: String(f().manifest?.version) })],
    ['release: CHANGELOG date', () => ({
      problems: changelogProblems(f().changelog, f().manifest?.version, { release: true }),
      note: changelogHeading(f().changelog, f().manifest?.version) ?? '',
    })],
    ['release: README', () => ({ problems: readmeReleaseProblems(f().readme) })],
    ['release: client dependency', () => {
      const problem = clientRangeProblem(spec(), f().installedClient);
      return { problems: problem ? [problem] : [], note: `${show(spec())}, installed ${f().installedClient}` };
    }],
    ['release: lock file', () => ({ problems: lockProblems(f().lock) })],
    ['release: schema released', () => ({ problems: historyProblems(f().history, f().schemaVersion, { release: true }), note: String(f().schemaVersion) })],
    ['release: packed files', () => ({
      problems: packProblems(pack(), f().manifest, { binHead: headOf(join(root, BIN_TARGET)) }),
      note: `${pack().files.length} files, ${pack().unpackedSize} bytes unpacked`,
    })],
    ['release: no source-map comments', () => {
      const code = pack().files.map((file) => file.path).filter((path) => /\.(?:js|d\.ts)$/.test(path));
      const left = sourceMapCommentFiles(code.map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') })));
      return { problems: left.map((path) => `${path} still points at a source map (delete ${BUILD_DIR}/ and build again)`), note: `${code.length} files` };
    }],
    ['release: packed content', () => {
      const { list } = deny();
      const scan = scanFiles(root, pack().files.map((file) => file.path), { deny: list });
      const problems = describeHits(scan.hits, (h) => `${h.file}:${h.line}`);
      if (scan.missing.length) { problems.push(`not on disk: ${scan.missing.join(', ')}`); }
      return { problems, note: `${scan.scanned} files scanned` };
    }],
    ['release: command', () => {
      const version = String(f().manifest?.version ?? '');
      const problems = [];
      if (!f().has(BIN_TARGET)) { return { problems: [`${BIN_TARGET} is not built`] }; }
      const v = tools.node([join(root, BIN_TARGET), '--version'], root, guarded);
      if (v.timedOut) { problems.push('--version did not end'); }
      else if (v.status !== 0) { problems.push(`--version ended with ${v.status}: ${firstLine(v.stderr)}`); }
      else if (version === '' || !namesVersion(v.stdout, version)) { problems.push(`--version printed "${firstLine(v.stdout)}", which does not name ${version}`); }
      const h = tools.node([join(root, BIN_TARGET), '--help'], root, guarded);
      if (h.timedOut) { problems.push('--help did not end'); }
      else if (h.status !== 0) { problems.push(`--help ended with ${h.status}: ${firstLine(h.stderr)}`); }
      return { problems, note: firstLine(v.stdout) };
    }],
    ['release: library', () => {
      const main = posix(String(f().manifest?.main ?? `${BUILD_DIR}/index.js`));
      if (!f().has(main)) { return { problems: [`${main} is not built`] }; }
      const r = tools.node(['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(root, main)).href)});`], root);
      return { problems: r.status === 0 && !r.timedOut ? [] : [`${main} does not import: ${firstLine(r.stderr) || 'it did not end'}`], note: `${main} imports` };
    }],
  );
  return checks;
}

/** Runs the checks and prints their lines. opts replaces what talks to the outside: `{ root, env, write, error, git, npmPack, node }`. */
export function main(argv, opts = {}) {
  const write = opts.write ?? ((line) => process.stdout.write(`${line}\n`));
  const error = opts.error ?? ((line) => process.stderr.write(`${line}\n`));
  const env = opts.env ?? process.env;
  const args = parseArgs(argv, env);
  if (args.help) {
    for (const line of USAGE) { write(line); }
    return 0;
  }
  if (args.problem) {
    error(`release-check: ${args.problem}`);
    error(USAGE[0]);
    return 2;
  }
  const tools = { git: opts.git ?? runGit, npmPack: opts.npmPack ?? npmPackList, node: opts.node ?? runNode, env };
  let failed = 0;
  const checks = checksFor(opts.root ?? ROOT, args, tools);
  for (const [name, run] of checks) {
    let result;
    try { result = run(); } catch (e) { result = { problems: [`could not run: ${message(e)}`] }; }
    if (result.problems.length === 0) {
      write(`ok    ${name}${result.note ? `: ${result.note}` : ''}`);
      continue;
    }
    failed++;
    if (result.problems.length === 1) { write(`FAIL  ${name}: ${result.problems[0]}`); continue; }
    write(`FAIL  ${name}: ${result.problems.length} problems`);
    for (const problem of result.problems) { write(`        ${problem}`); }
  }
  write(`release-check: ${checks.length} checks, ${failed} failed${args.release ? ' (release rules on)' : ''}`);
  return failed === 0 ? 0 : 1;
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

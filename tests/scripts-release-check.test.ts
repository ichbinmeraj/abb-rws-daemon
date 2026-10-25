import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Hit { rule: string; name: string; text: string; line: number }
interface FileHit extends Hit { file: string }
interface Scan { scanned: number; unscanned: string[]; missing: string[]; notText: string[]; hits: FileHit[] }
interface Commit { hash: string; author: string; committer: string; message: string }
interface CommitHit { commit: string; where: string; rule: string; name: string; text: string }
interface PackFile { path: string; size?: number; mode?: number }
interface Pack { files: PackFile[]; unpackedSize: number }
type Manifest = Record<string, unknown>;
type Git = (args: string[], cwd: string) => string;
interface NodeResult { status: number | null; stdout: string; stderr: string; timedOut: boolean }
type NodeTool = (args: string[], cwd: string, env?: Record<string, string | undefined>) => NodeResult;
interface ScanOptions { deny?: string[]; rules?: readonly string[]; git?: Git }
interface Args { release: boolean; commits: string | null; denyFile: string | null; help: boolean; problem: string | null }
interface MainOptions {
  root?: string; env?: Record<string, string | undefined>; write?: (line: string) => void; error?: (line: string) => void;
  git?: Git; npmPack?: (root: string) => Pack; node?: NodeTool;
}
interface ReleaseCheck {
  GIT_LIST_ARGS: readonly string[];
  RULE_IDS: readonly string[];
  IDENTITY_RULES: readonly string[];
  PRIVATE_LIST_RULE: string;
  BIN_FIRST_LINE: string;
  PACK_MAX_UNPACKED_BYTES: number;
  DENY_FILE_ENV: string;
  UNSCANNED_FILES: readonly { path: string; reason: string }[];
  ALLOWED_ADDRESSES: readonly { exact?: string; prefix?: string; reason: string }[];
  ALLOWED_MACHINE_NAMES: readonly { name: string; reason: string }[];
  ALLOWED_PROFILE_NAMES: readonly { name: string; reason: string }[];
  ALLOWED_EMAIL_SHAPES: readonly { domain?: string; text?: string; reason: string }[];
  scanText(text: string, opts?: ScanOptions): Hit[];
  parseDenyList(text: string): string[];
  listFiles(root: string, git?: Git): string[];
  scanFiles(root: string, paths: string[], opts?: ScanOptions): Scan;
  scanCheckout(root: string, opts?: ScanOptions): Scan & { listed: string[] };
  parseCommitLog(text: string): Commit[];
  scanCommits(commits: Commit[], opts?: { deny?: string[] }): CommitHit[];
  baseVersion(version: unknown): string;
  binTarget(manifest: Manifest | null): string | null;
  binProblems(manifest: Manifest | null, facts: { built: boolean; head: string | null }): string[];
  staleDistFiles(distFiles: string[], srcFiles: string[]): string[];
  sourceMapCommentFiles(files: Array<{ path: string; text: string }>): string[];
  filesEntryProblems(manifest: Manifest | null, has: (path: string) => boolean, built: boolean): string[];
  documentProblems(has: (path: string) => boolean): string[];
  manifestProblems(manifest: Manifest | null): string[];
  latestReleased(changelog: string | null): string | null;
  readmeProblems(readme: string | null, versions: { version: unknown; schemaVersion: string | null; released?: string | null }): string[];
  changelogHeading(changelog: string | null, version: unknown): string | null;
  changelogProblems(changelog: string | null, version: unknown, opts?: { release?: boolean }): string[];
  schemaVersionIn(source: string | null): string | null;
  historyProblems(index: unknown, schemaVersion: string | null, opts?: { release?: boolean }): string[];
  privateProblems(manifest: Manifest | null): string[];
  versionProblems(manifest: Manifest | null): string[];
  readmeReleaseProblems(readme: string | null): string[];
  satisfies(version: string, range: string): boolean;
  clientRangeProblem(spec: unknown, installed: string | null): string | null;
  lockProblems(lock: unknown): string[];
  parsePackOutput(stdout: string): Pack;
  packProblems(pack: Pack, manifest: Manifest | null, facts?: { binHead?: string | null }): string[];
  parseArgs(argv: string[], env?: Record<string, string | undefined>): Args;
  main(argv: string[], opts?: MainOptions): number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'release-check.mjs');

let rc: ReleaseCheck;
let scratch: string;
beforeAll(async () => {
  rc = await import('../scripts/release-check.mjs' as string) as ReleaseCheck;
  scratch = mkdtempSync(join(tmpdir(), 'daemon-release-check-'));
});
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

/** A fresh folder under the scratch folder with these files in it. */
let folders = 0;
function folder(files: Record<string, string | Buffer> = {}): string {
  const dir = join(scratch, `f${++folders}`);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

// Everything the scan refuses is put together here, when the test runs: this
// file is one of the files the scan reads, and it must pass.
const w = (...parts: string[]): string => parts.join('');
const address = (...octets: number[]): string => octets.join('.');
const mail = (local: string, domain: string): string => [local, domain].join('@');
const profile = (name: string): string => ['C:', 'Users', name, 'AppData'].join('\\');

// Made-up names throughout: none of them names a real machine, address or person.
const TOOL = w('Cl', 'aude');
const VENDOR = w('Anth', 'ropic');
const TRAILER = `${w('Co-', 'Authored', '-By')}: Someone Else`;
const LAN = address(192, 168, 1, 50);
const MACHINE = `${w('DESK', 'TOP')}-K3J9X2A`;
const REAL_MAIL = mail('jane.roe', 'factory-mail.net');

const rulesOf = (hits: { rule: string }[]): string[] => [...new Set(hits.map(h => h.rule))].sort();

describe('release check: content rules', () => {
  it('has the generic rules only: what is private to a publisher goes in the private list', () => {
    expect([...rc.RULE_IDS]).toEqual(['tools', 'attribution', 'address', 'machine', 'profile', 'email']);
  });

  const planted: [string, string][] = [
    ['tools', `written with ${TOOL}`],
    ['tools', `a product of ${VENDOR}`],
    ['tools', `asked ${w('Chat', 'GPT')} about it`],
    ['tools', `an ${w('L', 'LM')} wrote this`],
    ['tools', `the ${w('A', 'I')} ${w('assis', 'tant')} suggested it`],
    ['tools', `a large ${w('lang', 'uage')} model`],
    ['attribution', TRAILER],
    ['attribution', `${String.fromCodePoint(0x1f916)} made by a tool`],
    ['address', `the cell network is ${LAN}`],
    ['address', `http://${address(10, 1, 2, 3)}:80/rw`],
    ['address', `gateway ${address(172, 20, 0, 4)}`],
    ['machine', `recorded on ${MACHINE}`],
    ['machine', `recorded on ${w('LAP', 'TOP')}-AB12CD34`],
    ['profile', `saved to ${profile('mreal')}`],
    ['email', `write to ${REAL_MAIL}`],
  ];

  it.each(planted)('the %s rule finds "%s"', (rule, text) => {
    expect(rc.RULE_IDS).toContain(rule);
    const hits = rc.scanText(text);
    expect(rulesOf(hits)).toContain(rule);
  });

  it('names the line of each hit', () => {
    const hits = rc.scanText(`first line\nsecond line\nthird: ${LAN}\nfourth\nfifth: ${TOOL}\n`);
    expect(hits.map(h => [h.rule, h.line])).toEqual([['address', 3], ['tools', 5]]);
    expect(hits[0].text).toBe(LAN);
  });

  it('leaves ordinary product text alone', () => {
    const clean = [
      'DI | DO | AI | AO | GI | GO as reported',
      'set ABB_RWS_DAEMON_PORT, then run abb-rws-daemon --port 7811',
      'npm install -g abb-rws-daemon@0.1.0 (needs abb-rws-client@1.4.0)',
      'uses: actions/checkout@v4',
      'http://admin:secret@127.0.0.1:8080/rw/system',
      '/// <reference types="node" />',
      'the documentation addresses 192.0.2.10, 198.51.100.7 and 203.0.113.9',
      'RobotWare 6.16.03, 7.21.4 and 8.2.1; Windows 10.0.26200',
      'a desktop-application and a laptop-keyboard',
      'DESKTOP-1 is too short to be a default name',
      'https://github.com/someone/project/actions/runs/1/job/2',
      'a cross-reference/index and the API reference.',
      'the backlog of event-log messages, at no risk',
      'this agent of change, a helpful assistant, a model of the cell',
      'the path C:\\Users\\<name>\\AppData and %USERPROFILE%',
      'Signed-off-by: Your Name <your.email@example.com>',
    ];
    for (const text of clean) { expect(rc.scanText(text), text).toEqual([]); }
  });

  it('allows what the allow lists name, each with a reason', () => {
    for (const a of rc.ALLOWED_ADDRESSES) {
      expect(rc.scanText(`at ${a.exact ?? `${a.prefix}20`}`), JSON.stringify(a)).toEqual([]);
    }
    for (const a of rc.ALLOWED_MACHINE_NAMES) { expect(rc.scanText(`from ${a.name}`), a.name).toEqual([]); }
    for (const a of rc.ALLOWED_PROFILE_NAMES) { expect(rc.scanText(`in ${profile(a.name)}`), a.name).toEqual([]); }
    for (const a of rc.ALLOWED_EMAIL_SHAPES) {
      expect(rc.scanText(`see ${a.text ?? mail('your.name', a.domain ?? '')}`), JSON.stringify(a)).toEqual([]);
    }
    expect(rc.scanText(`see ${mail('someone', 'docs.example.com')}`)).toEqual([]);
    // The reserved top-level names (RFC 2606) under a host name: test inputs, never a mailbox.
    for (const domain of ['host.example', 'attacker.example', 'mail.invalid', 'box.test']) {
      expect(rc.scanText(`Host: ${mail('user', domain)}`), domain).toEqual([]);
    }
    expect(rc.scanText(`write to ${mail('someone', 'examples.org')}`)).toHaveLength(1);
    const all = [...rc.ALLOWED_ADDRESSES, ...rc.ALLOWED_MACHINE_NAMES, ...rc.ALLOWED_PROFILE_NAMES, ...rc.ALLOWED_EMAIL_SHAPES, ...rc.UNSCANNED_FILES];
    for (const entry of all) { expect(entry.reason.length, JSON.stringify(entry)).toBeGreaterThan(10); }
  });

  it('allows the realm the controllers announce and nothing else at that name', () => {
    const realm = rc.ALLOWED_EMAIL_SHAPES.find(a => a.text?.endsWith('.abb'))?.text ?? '';
    expect(realm).not.toBe('');
    expect(rc.scanText(`WWW-Authenticate: Digest realm="${realm}"`)).toEqual([]);
    expect(rulesOf(rc.scanText(`write to ${mail('someone', realm.split('@')[1])}`))).toEqual(['email']);
  });

  it('refuses what is only near an allowed text', () => {
    expect(rulesOf(rc.scanText(`at ${address(192, 168, 125, 2)}`))).toEqual(['address']);
    expect(rulesOf(rc.scanText(`at ${address(10, 0, 1, 20)}`))).toEqual(['address']);
    expect(rulesOf(rc.scanText(`from ${w('DESK', 'TOP')}-ABC1235`))).toEqual(['machine']);
    expect(rulesOf(rc.scanText(`in ${profile('janet')}`))).toEqual(['profile']);
    expect(rulesOf(rc.scanText(`see ${mail('someone', 'example.co')}`))).toEqual(['email']);
  });

  it('reads a private list: exact strings, whole, in any case, never printed; comments left out', () => {
    const deny = rc.parseDenyList('\uFEFF# names of the plant\nalpha-site\r\n\r\n   Cell Seven  \n  # not an entry\n');
    expect(deny).toEqual(['alpha-site', 'Cell Seven']);
    const hits = rc.scanText('line one\nmoved to CELL SEVEN today', { deny });
    expect(hits).toEqual([{ rule: rc.PRIVATE_LIST_RULE, name: expect.any(String), text: 'entry 2', line: 2 }]);
    expect(JSON.stringify(hits).toLowerCase()).not.toContain('cell seven');
    expect(rc.scanText('the alpha-sites and an alpha-site2', { deny })).toEqual([]);
    expect(rulesOf(rc.scanText('at alpha-site.', { deny, rules: rc.IDENTITY_RULES }))).toEqual([rc.PRIVATE_LIST_RULE]);
  });

  it('takes a regular expression in the private list, written /.../ with its flags, matched as written', () => {
    // Made-up shapes: a ticket id, a document name in one case only, a path at a line start.
    const deny = rc.parseDenyList([
      '/(?<![A-Za-z0-9])XK-\\d{1,3}(?![A-Za-z0-9])/',
      '/(?<![A-Za-z0-9])(?:LEDGER|TALLY)\\.md(?![A-Za-z0-9])/',
      '/^(?:\\.\\.\\/)*vault\\/[A-Za-z0-9_]+/m',
      '/shop[ -]?floor/i',
      'plain-word',
    ].join('\n'));
    expect(deny).toHaveLength(5);
    const found = (text: string): string[] => rc.scanText(text, { deny }).map(h => h.text);
    expect(found('see XK-7 and XK-123')).toEqual(['entry 1', 'entry 1']);
    expect(found('XK-1234 and AXK-7 and xk-7')).toEqual([]);                       // the pattern is case-sensitive as written
    expect(found('kept in LEDGER.md')).toEqual(['entry 2']);
    expect(found('kept in ledger.md')).toEqual([]);
    expect(found('first\nvault/notes\n  ../vault/x')).toEqual(['entry 3']);         // ^ at a line start (flag m); not after blanks
    expect(found('the Shop Floor and the shopfloor')).toEqual(['entry 4', 'entry 4']);
    expect(found('a plain-word here')).toEqual(['entry 5']);
    expect(rc.scanText('nothing of it', { deny })).toEqual([]);
    // A hit is named by its number; the pattern's text is never printed.
    expect(JSON.stringify(rc.scanText('XK-7', { deny }))).not.toContain('XK');
  });

  it('refuses a pattern that does not compile, by its number', () => {
    const deny = rc.parseDenyList('fine\n/(unclosed/\n');
    expect(() => rc.scanText('any text', { deny })).toThrow('entry 2 of the private list is not a valid regular expression');
    // A pattern that matches nothing but the empty string names nothing.
    expect(rc.scanText('any words', { deny: ['/x*/'] })).toEqual([]);
  });

  it('holds none of the refused words itself, and neither does this test', () => {
    expect(rc.scanText(readFileSync(SCRIPT, 'utf8'))).toEqual([]);
    expect(rc.scanText(readFileSync(fileURLToPath(import.meta.url), 'utf8'))).toEqual([]);
  });
});

describe('release check: which files are read', () => {
  it('asks git for tracked and untracked files, minus the ignored ones, in one call', () => {
    expect([...rc.GIT_LIST_ARGS]).toEqual(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    const calls: { args: string[]; cwd: string }[] = [];
    const git: Git = (args, cwd) => { calls.push({ args, cwd }); return 'a.md\0sub/b.md\0'; };
    expect(rc.listFiles('/some/root', git)).toEqual(['a.md', 'sub/b.md']);
    expect(calls).toEqual([{ args: ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd: '/some/root' }]);
  });

  it('scans an untracked file and not an ignored one (a folder with git init alone)', () => {
    const dir = folder({
      '.gitignore': 'kept-out.md\n',
      'notes.md': `fine\nbut ${MACHINE} is not\n`,
      'kept-out.md': `never listed: ${MACHINE} and ${LAN}\n`,
      'sub/inner.txt': 'nothing to see\n',
    });
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
    const scan = rc.scanCheckout(dir);
    expect([...scan.listed].sort()).toEqual(['.gitignore', 'notes.md', 'sub/inner.txt']);
    expect(scan.scanned).toBe(3);
    expect(scan.hits).toEqual([{ file: 'notes.md', rule: 'machine', name: expect.any(String), text: MACHINE, line: 2 }]);
  });

  it('skips a listed path that is not on disk, the lock file and what is not text', () => {
    const dir = folder({
      'a.md': `on ${MACHINE}\n`,
      'package-lock.json': `{"note":"${REAL_MAIL}"}\n`,
      'image.bin': Buffer.concat([Buffer.from([0x89, 0x50, 0x00, 0x01]), Buffer.from(LAN)]),
      'dir/inside.md': 'clean\n',
    });
    const calls: string[][] = [];
    const git: Git = (args) => { calls.push(args); return ['a.md', 'gone.md', 'package-lock.json', 'image.bin', 'dir', 'dir/inside.md'].join('\0') + '\0'; };
    const scan = rc.scanCheckout(dir, { git });
    expect(calls).toEqual([[...rc.GIT_LIST_ARGS]]);
    expect(scan.scanned).toBe(2);
    expect(scan.missing).toEqual(['gone.md', 'dir']);
    expect(scan.unscanned).toEqual(['package-lock.json']);
    expect(scan.notText).toEqual(['image.bin']);
    expect(scan.hits.map(h => [h.file, h.rule])).toEqual([['a.md', 'machine']]);
  });

  it('applies a private list to every file', () => {
    const dir = folder({ 'a.md': 'the Cell Seven line\n', 'b.md': 'nothing\n' });
    const scan = rc.scanFiles(dir, ['a.md', 'b.md'], { deny: ['cell seven'] });
    expect(scan.hits).toEqual([{ file: 'a.md', rule: rc.PRIVATE_LIST_RULE, name: expect.any(String), text: 'entry 1', line: 1 }]);
  });
});

describe('release check: commits', () => {
  const commit = (over: Partial<Commit> = {}): Commit => ({
    hash: '0123456789abcdef0123456789abcdef01234567',
    author: `Jane Roe <${REAL_MAIL}>`,
    committer: `Jane Roe <${REAL_MAIL}>`,
    message: 'Refuse a port outside 1 to 65535\n\nThe check ran after the token file was made.\n',
    ...over,
  });

  it('reads the log format back', () => {
    const text = ['aaa1', 'A <a>', 'C <c>', 'Subject one\n\nBody.\n'].join('\x1f') + '\x1e\n'
      + ['bbb2', 'B <b>', 'D <d>', 'Subject two\n'].join('\x1f') + '\x1e\n';
    expect(rc.parseCommitLog(text)).toEqual([
      { hash: 'aaa1', author: 'A <a>', committer: 'C <c>', message: 'Subject one\n\nBody.\n' },
      { hash: 'bbb2', author: 'B <b>', committer: 'D <d>', message: 'Subject two\n' },
    ]);
    expect(rc.parseCommitLog('')).toEqual([]);
  });

  it('passes an author and a committer line with a real-looking address', () => {
    expect(rc.IDENTITY_RULES).not.toContain('email');
    expect(rc.scanCommits([commit()])).toEqual([]);
  });

  it('fails an identity line that names an authoring tool', () => {
    const hits = rc.scanCommits([commit({ author: `${TOOL} <${mail('noreply', `${VENDOR.toLowerCase()}.com`)}>` })]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => h.where === 'author' && h.commit === '012345678')).toBe(true);
    expect(rulesOf(hits)).toEqual(['tools']);
    const byCommitter = rc.scanCommits([commit({ committer: `${TOOL} Code <${REAL_MAIL}>` })]);
    expect(byCommitter.map(h => [h.where, h.rule])).toEqual([['committer', 'tools']]);
  });

  it('runs the whole scan over the message, the e-mail rule included', () => {
    const hits = rc.scanCommits([commit({ message: `Subject\n\nAsk ${REAL_MAIL} about it.\nMade on ${MACHINE}.\n` })]);
    expect(hits.map(h => [h.where, h.rule])).toEqual([['message line 3', 'email'], ['message line 4', 'machine']]);
  });

  it('treats a sign-off line as an identity line and refuses an attribution trailer', () => {
    expect(rc.scanCommits([commit({ message: `Subject\n\nSigned-off-by: Jane Roe <${REAL_MAIL}>\n` })])).toEqual([]);
    const hits = rc.scanCommits([commit({ message: `Subject\n\n${TRAILER} <${mail('someone', 'example.com')}>\n` })]);
    expect(hits.map(h => [h.where, h.rule])).toEqual([['message line 3', 'attribution']]);
    expect(rulesOf(rc.scanCommits([commit({ message: `Subject\n\nSigned-off-by: ${TOOL} <${REAL_MAIL}>\n` })]))).toEqual(['tools']);
  });

  it('holds identity lines to the private list', () => {
    const hits = rc.scanCommits([commit()], { deny: ['jane roe'] });
    expect(hits.map(h => [h.where, h.rule, h.text])).toEqual([
      ['author', rc.PRIVATE_LIST_RULE, 'entry 1'], ['committer', rc.PRIVATE_LIST_RULE, 'entry 1'],
    ]);
  });
});

const GOOD_MANIFEST: Manifest = {
  name: 'abb-rws-daemon',
  version: '0.1.0-dev',
  private: true,
  license: 'Apache-2.0',
  author: { name: 'Jane Roe', url: 'https://github.com/someone' },
  homepage: 'https://github.com/someone/abb-rws-daemon#readme',
  bugs: { url: 'https://github.com/someone/abb-rws-daemon/issues' },
  keywords: ['abb', 'robot'],
  repository: { type: 'git', url: 'git+https://github.com/someone/abb-rws-daemon.git' },
  main: 'dist/index.js',
  files: ['dist', '!dist/**/*.map', 'schema', 'LICENSE', 'NOTICE', 'TRADEMARKS.md', 'README.md', 'CHANGELOG.md'],
  engines: { node: '>=22' },
  dependencies: { 'abb-rws-client': 'file:../abb-rws-client', fastify: '^5.12.5' },
  bin: { 'abb-rws-daemon': 'dist/cli.js' },
};
const RELEASE_MANIFEST: Manifest = (() => {
  const { private: _private, ...rest } = GOOD_MANIFEST;
  return { ...rest, version: '0.1.0', dependencies: { 'abb-rws-client': '^1.4.0', fastify: '^5.12.5' } };
})();
const HEAD_LF = '#!/usr/bin/env node\nimport { resolve } from "node:path";\n';
const HEAD_CRLF = '#!/usr/bin/env node\r\nimport { resolve } from "node:path";\r\n';

const GOOD_README = [
  '# abb-rws-daemon',
  '',
  '> **Status:** 0.1.0. Read-only. Snapshot schema 0.13.',
  '',
  '    npx abb-rws-daemon@0.1.0 --config ./abb-rws-daemon.config.json',
  '    npm install -g abb-rws-daemon@0.1.0',
  '',
  'Then run `abb-rws-daemon --help`. The package is abb-rws-daemon@0.1.0.',
  '',
].join('\n');
const SIBLING_BLOCK = ['<!-- sibling-client:start -->', 'Clone abb-rws-client beside this folder first.', '<!-- sibling-client:end -->', ''].join('\n');

describe('release check: package rules, every day', () => {
  it('accepts a complete manifest and names what is missing from one', () => {
    expect(rc.manifestProblems(GOOD_MANIFEST)).toEqual([]);
    expect(rc.manifestProblems(null)).toEqual(['package.json is missing or is not JSON']);
    const { homepage: _h, bugs: _b, ...rest } = GOOD_MANIFEST;
    const problems = rc.manifestProblems({ ...rest, license: 'MIT', engines: { node: '>=20' }, keywords: [], author: '' });
    expect(problems).toEqual([
      'license is "MIT", not "Apache-2.0"',
      'engines.node is ">=20", not ">=22"',
      'homepage is not set',
      'bugs is not set',
      'keywords is not set',
      'author is not set',
    ]);
  });

  it('checks the bin target, and its first line only once it is built', () => {
    expect(rc.binTarget(GOOD_MANIFEST)).toBe('dist/cli.js');
    expect(rc.binTarget({ bin: './dist/cli.js' })).toBe('dist/cli.js');
    expect(rc.binProblems(GOOD_MANIFEST, { built: true, head: HEAD_LF })).toEqual([]);
    expect(rc.binProblems(GOOD_MANIFEST, { built: false, head: null })).toEqual([]);
    expect(rc.binProblems(GOOD_MANIFEST, { built: true, head: null })).toEqual(['dist/cli.js is not there']);
    expect(rc.binProblems(GOOD_MANIFEST, { built: true, head: HEAD_CRLF })).toEqual(['the first line of dist/cli.js ends in CR LF, not LF']);
    expect(rc.binProblems(GOOD_MANIFEST, { built: true, head: 'import x from "y";\n' })[0]).toMatch(/does not start with the line #!/);
    expect(rc.binProblems({ ...GOOD_MANIFEST, bin: {} }, { built: false, head: null })[0]).toMatch(/names no bin target/);
  });

  it('fails a built file whose source is gone, and names each', () => {
    const dist = ['index.js', 'index.d.ts', 'index.js.map', 'index.d.ts.map', 'recording/mask.js', 'recording/mask.d.ts', 'old/gone.js', 'old/gone.d.ts', 'renamed.js'];
    const src = ['index.ts', 'recording/mask.ts', 'schema/v0.ts'];
    expect(rc.staleDistFiles(dist, src)).toEqual(['old/gone.d.ts', 'old/gone.js', 'renamed.js']);
    expect(rc.staleDistFiles(['index.js', 'index.d.ts'], src)).toEqual([]);
    expect(rc.staleDistFiles(['Index.js'], src)).toEqual(['Index.js']);
  });

  it('ships every file the NOTICE points to, and the pack rules let it through', () => {
    const root = join(HERE, '..');
    const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
    const named = [...new Set(notice.match(/\b[A-Z][A-Z0-9_-]*\.md\b/g) ?? [])];
    expect(named).toContain('TRADEMARKS.md');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    for (const file of named) {
      expect(manifest.files, file).toContain(file);
      expect(readFileSync(join(root, file), 'utf8').length, file).toBeGreaterThan(0);
      expect(rc.packProblems(withFiles(file), RELEASE_MANIFEST, { binHead: HEAD_LF }), file).toEqual([]);
    }
  });

  it('names each shipped file that still points at a source map', () => {
    const files = [
      { path: 'dist/index.js', text: 'export {};\n//# sourceMappingURL=index.js.map\n' },
      { path: 'dist/index.d.ts', text: 'export {};\n//# sourceMappingURL=index.d.ts.map' },
      { path: 'dist/cli.js', text: '#!/usr/bin/env node\nexport {};\n' },
      { path: 'dist/notes.js', text: 'const s = "//# sourceMappingURL= inside a string";\n' },
    ];
    expect(rc.sourceMapCommentFiles(files)).toEqual(['dist/index.d.ts', 'dist/index.js']);
    expect(rc.sourceMapCommentFiles([files[2]!])).toEqual([]);
  });

  it('builds without source maps or their comments: the shipped files point at nothing', () => {
    const root = join(HERE, '..');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(manifest.scripts.build).toMatch(/^tsc -p tsconfig\.build\.json\b/);
    const build = JSON.parse(readFileSync(join(root, 'tsconfig.build.json'), 'utf8')) as { extends: string; compilerOptions: Record<string, unknown> };
    expect(build).toMatchObject({ extends: './tsconfig.json', compilerOptions: { sourceMap: false, declarationMap: false } });
  });

  it('wants every files entry and every document on disk', () => {
    const present = new Set(['dist', 'schema', 'LICENSE', 'NOTICE', 'TRADEMARKS.md', 'README.md', 'CHANGELOG.md']);
    const has = (p: string): boolean => present.has(p);
    expect(rc.filesEntryProblems(GOOD_MANIFEST, has, true)).toEqual([]);
    expect(rc.documentProblems(has)).toEqual([]);
    present.delete('CHANGELOG.md');
    present.delete('dist');
    expect(rc.filesEntryProblems(GOOD_MANIFEST, has, false)).toEqual(['files names CHANGELOG.md, which does not exist']);
    expect(rc.filesEntryProblems(GOOD_MANIFEST, has, true)).toEqual([
      'files names dist, which does not exist', 'files names CHANGELOG.md, which does not exist',
    ]);
    expect(rc.documentProblems(has)).toEqual(['CHANGELOG.md is missing']);
    expect(rc.filesEntryProblems({ ...GOOD_MANIFEST, files: [] }, has, true)).toEqual(['package.json has no files list']);
  });

  it('holds README to the package version and the schema version', () => {
    const versions = { version: '0.1.0-dev', schemaVersion: '0.13' };
    expect(rc.baseVersion('0.1.0-dev')).toBe('0.1.0');
    expect(rc.readmeProblems(GOOD_README, versions)).toEqual([]);
    expect(rc.readmeProblems(GOOD_README, { version: '0.1.0', schemaVersion: '0.13' })).toEqual([]);
    expect(rc.readmeProblems(null, versions)).toEqual(['README.md is missing']);
    expect(rc.readmeProblems('Version 0.1.0-dev, schema 0.130 and 10.13.\n', versions)).toEqual([
      'README.md does not name version 0.1.0', 'README.md does not name schema 0.13',
    ]);
    expect(rc.readmeProblems(GOOD_README, { version: '0.2.0-dev', schemaVersion: '0.13' })).toEqual([
      'README.md does not name version 0.2.0',
      'README.md line 5 names abb-rws-daemon@0.1.0, not @0.2.0',
      'README.md line 6 names abb-rws-daemon@0.1.0, not @0.2.0',
      'README.md line 8 names abb-rws-daemon@0.1.0, not @0.2.0',
    ]);
    expect(rc.readmeProblems(`${GOOD_README}Or the newest: abb-rws-daemon@latest\n`, versions)).toEqual([
      'README.md line 9 names abb-rws-daemon@latest, not @0.1.0',
    ]);
  });

  it('lets a development version keep naming the last release, and only a development version', () => {
    const log = '# Changelog\n\n## [0.2.0] - unreleased\n\n## [0.1.1] - 2026-11-20\n\n## [0.1.0] - 2026-10-31\n\n## 0.0.9 - 2026-01-31\n';
    expect(rc.latestReleased(log)).toBe('0.1.1');
    expect(rc.latestReleased('# Changelog\n\n## [0.1.0] - unreleased\n')).toBeNull();
    expect(rc.latestReleased('## [0.10.0] - 2026-12-01\n## [0.9.0] - 2026-11-01\n')).toBe('0.10.0');
    expect(rc.latestReleased(null)).toBeNull();
    // The next version is being worked on: README still names 0.1.0, which is what the registry has.
    const next = { version: '0.2.0-dev', schemaVersion: '0.13', released: '0.1.0' };
    expect(rc.readmeProblems(GOOD_README, next)).toEqual([]);
    expect(rc.readmeProblems(GOOD_README.replaceAll('0.1.0', '0.2.0'), next)).toEqual([]);
    expect(rc.readmeProblems(GOOD_README.replaceAll('0.1.0', '0.0.9'), next)).toEqual([
      'README.md does not name version 0.2.0 or 0.1.0',
      'README.md line 5 names abb-rws-daemon@0.0.9, not @0.2.0 or @0.1.0',
      'README.md line 6 names abb-rws-daemon@0.0.9, not @0.2.0 or @0.1.0',
      'README.md line 8 names abb-rws-daemon@0.0.9, not @0.2.0 or @0.1.0',
    ]);
    // At the release itself the version is plain, and README must name it.
    expect(rc.readmeProblems(GOOD_README, { version: '0.2.0', schemaVersion: '0.13', released: '0.1.0' })).toHaveLength(4);
    // Before the first release there is nothing else to name.
    expect(rc.readmeProblems(GOOD_README, { version: '0.2.0-dev', schemaVersion: '0.13', released: null })).toHaveLength(4);
  });

  it('refuses an install line without a version', () => {
    const versions = { version: '0.1.0-dev', schemaVersion: '0.13' };
    const lines = ['npx abb-rws-daemon --help', 'npm install -g abb-rws-daemon', 'npm i --global abb-rws-daemon', 'npx --yes abb-rws-daemon'];
    for (const line of lines) {
      expect(rc.readmeProblems(`${GOOD_README}    ${line}\n`, versions), line).toEqual(['README.md line 9 installs abb-rws-daemon without a version']);
    }
    expect(rc.readmeProblems(`${GOOD_README}    npm install abb-rws-daemon-extras\n    npm view abb-rws-daemon\n`, versions)).toEqual([]);
  });

  it('wants a CHANGELOG section for the version, dated only for a release', () => {
    const open = '# Changelog\n\n## [0.1.0] - unreleased\n\n### Added\n';
    expect(rc.changelogProblems(open, '0.1.0-dev')).toEqual([]);
    expect(rc.changelogHeading(open, '0.1.0-dev')).toBe('- unreleased');
    expect(rc.changelogProblems('# Changelog\n\n## [0.0.9] - 2026-01-31\n\n## [0.1.0-rc] - 2026-02-01\n', '0.1.0')).toEqual(['CHANGELOG.md has no section for 0.1.0']);
    expect(rc.changelogProblems(null, '0.1.0')).toEqual(['CHANGELOG.md is missing']);
    expect(rc.changelogProblems(open, '0.1.0', { release: true })).toEqual(['the CHANGELOG.md heading for 0.1.0 carries no date (it reads "- unreleased")']);
    expect(rc.changelogProblems('## [0.1.0] - 2026-10-31\n', '0.1.0', { release: true })).toEqual([]);
    expect(rc.changelogProblems('## 0.1.0 - 2026-10-31\n', '0.1.0', { release: true })).toEqual([]);
    expect(rc.changelogProblems('## [0.1.0] - 2026-13-45\n', '0.1.0', { release: true })).toHaveLength(1);
  });

  it('reads the schema version and looks it up in the history index', () => {
    expect(rc.schemaVersionIn("/** doc */\nexport const SCHEMA_VERSION = '0.13' as const;\n")).toBe('0.13');
    expect(rc.schemaVersionIn('nothing here')).toBeNull();
    const index = [{ version: '0.12', sha256: 'x' }, { version: '0.13', sha256: 'y' }];
    expect(rc.historyProblems(index, '0.13')).toEqual([]);
    expect(rc.historyProblems(index, '0.14')).toEqual(['schema/history/index.json does not list 0.14']);
    expect(rc.historyProblems(null, '0.13')).toHaveLength(1);
    expect(rc.historyProblems(index, null)).toHaveLength(1);
    expect(rc.historyProblems(index, '0.13', { release: true })).toEqual(['schema 0.13 is not marked released in schema/history/index.json']);
    expect(rc.historyProblems([{ version: '0.13', sha256: 'y', released: true }], '0.13', { release: true })).toEqual([]);
  });
});

describe('release check: package rules, for a release', () => {
  it('wants the package public and its version plain', () => {
    expect(rc.privateProblems(GOOD_MANIFEST)).toEqual(['private is true']);
    expect(rc.privateProblems(RELEASE_MANIFEST)).toEqual([]);
    expect(rc.privateProblems({ ...RELEASE_MANIFEST, private: false })).toEqual([]);
    expect(rc.versionProblems(GOOD_MANIFEST)).toEqual(['version is "0.1.0-dev", not x.y.z']);
    expect(rc.versionProblems(RELEASE_MANIFEST)).toEqual([]);
    expect(rc.versionProblems({ ...RELEASE_MANIFEST, version: '0.1' })).toHaveLength(1);
  });

  it('wants README without the wording of an unreleased state and without the sibling block', () => {
    expect(rc.readmeReleaseProblems(GOOD_README)).toEqual([]);
    expect(rc.readmeReleaseProblems(`${GOOD_README}\n${SIBLING_BLOCK}`)).toEqual([
      'README.md line 10 still has the sibling-client block (RELEASING.md step 1 deletes it)',
    ]);
    expect(rc.readmeReleaseProblems('> Not released and not on npm: build it from source.\n')).toEqual(['README.md line 1 says "Not released"']);
    expect(rc.readmeReleaseProblems('It is not yet released.\n')).toHaveLength(1);
    expect(rc.readmeReleaseProblems('Not yet run against a real controller.\n')).toEqual([]);
    expect(rc.readmeReleaseProblems(null)).toEqual(['README.md is missing']);
  });

  it('takes ^1.4.0 and ~1.4.0, and refuses 1.4.0, a file: path and a range the installed client does not satisfy', () => {
    expect(rc.clientRangeProblem('^1.4.0', '1.4.0')).toBeNull();
    expect(rc.clientRangeProblem('~1.4.0', '1.4.0')).toBeNull();
    expect(rc.clientRangeProblem('^1.4.0', '1.9.3')).toBeNull();
    expect(rc.clientRangeProblem('1.4.0', '1.4.0')).toMatch(/"1\.4\.0" does not start with \^ or ~/);
    expect(rc.clientRangeProblem('file:../x', '1.4.0')).toBe('"file:../x" is not a registry range');
    expect(rc.clientRangeProblem('^1.5.0', '1.4.0')).toBe('"^1.5.0" is not satisfied by the installed abb-rws-client 1.4.0');
    expect(rc.clientRangeProblem('^1.4.0', '2.0.0')).toMatch(/not satisfied/);
    expect(rc.clientRangeProblem('~1.4.0', '1.5.0')).toMatch(/not satisfied/);
    expect(rc.clientRangeProblem('^1.4.0', '1.4.0-dev')).toMatch(/not satisfied/);
    expect(rc.clientRangeProblem('^1.4.0', null)).toMatch(/not installed/);
    expect(rc.clientRangeProblem(undefined, '1.4.0')).toMatch(/not in dependencies/);
    for (const spec of ['link:../abb-rws-client', '../abb-rws-client', 'someone/abb-rws-client', 'git+https://host.example/x.git', 'https://host.example/x.tgz', 'npm:other@^1.4.0', 'workspace:*']) {
      expect(rc.clientRangeProblem(spec, '1.4.0'), spec).toMatch(/is not a registry range/);
    }
    for (const spec of ['^1.4', '~1', '^1.4.0 || ^2.0.0', '>=1.4.0', '*', 'latest']) {
      expect(rc.clientRangeProblem(spec, '1.4.0'), spec).not.toBeNull();
    }
  });

  it('knows what a caret and a tilde admit', () => {
    expect(rc.satisfies('1.4.0', '^1.4.0')).toBe(true);
    expect(rc.satisfies('1.3.9', '^1.4.0')).toBe(false);
    expect(rc.satisfies('1.4.7', '~1.4.0')).toBe(true);
    expect(rc.satisfies('0.2.9', '^0.2.3')).toBe(true);
    expect(rc.satisfies('0.3.0', '^0.2.3')).toBe(false);
    expect(rc.satisfies('0.0.3', '^0.0.3')).toBe(true);
    expect(rc.satisfies('0.0.4', '^0.0.3')).toBe(false);
    expect(rc.satisfies('1.4.0', '1.4.0')).toBe(false);
  });

  it('refuses a lock file with a link or a path that leaves the package', () => {
    const linked = {
      packages: {
        '': { name: 'abb-rws-daemon', dependencies: { 'abb-rws-client': 'file:../abb-rws-client', fastify: '^5.12.5' } },
        '../abb-rws-client': { version: '1.4.0' },
        'node_modules/abb-rws-client': { resolved: '../abb-rws-client', link: true },
        'node_modules/fastify': { version: '5.12.5', resolved: 'https://registry.npmjs.org/fastify/-/fastify-5.12.5.tgz' },
      },
    };
    expect(rc.lockProblems(linked)).toEqual([
      '../abb-rws-client is outside the package',
      'node_modules/abb-rws-client is a link',
      'dependencies.abb-rws-client is file:../abb-rws-client',
    ]);
    const clean = {
      packages: {
        '': { name: 'abb-rws-daemon', dependencies: { 'abb-rws-client': '^1.4.0' } },
        'node_modules/abb-rws-client': { version: '1.4.0', resolved: 'https://registry.npmjs.org/abb-rws-client/-/abb-rws-client-1.4.0.tgz' },
      },
    };
    expect(rc.lockProblems(clean)).toEqual([]);
    expect(rc.lockProblems(null)).toEqual(['package-lock.json is missing or is not JSON']);
    expect(rc.lockProblems({ packages: { 'node_modules/x': { resolved: 'file:../x' } } })).toEqual(['node_modules/x resolves to file:../x']);
    expect(rc.lockProblems({ packages: { 'node_modules/x': { version: '1.0.0', bin: { x: '../../elsewhere/x.js' } } } })).toEqual(['package-lock.json holds a ../ path']);
  });
});

const GOOD_PACK: Pack = {
  unpackedSize: 1_200_000,
  files: [
    { path: 'CHANGELOG.md', size: 4300, mode: 0o644 },
    { path: 'LICENSE', size: 11543, mode: 0o644 },
    { path: 'NOTICE', size: 1014, mode: 0o644 },
    { path: 'TRADEMARKS.md', size: 4000, mode: 0o644 },
    { path: 'README.md', size: 30000, mode: 0o644 },
    { path: 'package.json', size: 2000, mode: 0o644 },
    { path: 'dist/cli.js', size: 20000, mode: 0o644 },
    { path: 'dist/cli.d.ts', size: 30, mode: 0o644 },
    { path: 'dist/index.js', size: 900, mode: 0o644 },
    { path: 'dist/recording/mask.js', size: 9000, mode: 0o644 },
    { path: 'schema/v0.schema.json', size: 90000, mode: 0o644 },
    { path: 'schema/history/index.json', size: 200, mode: 0o644 },
  ],
};
const withFiles = (...paths: string[]): Pack => ({ ...GOOD_PACK, files: [...GOOD_PACK.files, ...paths.map(path => ({ path, size: 1, mode: 0o644 }))] });

describe('release check: the packed files', () => {
  it('passes a list whose bin has mode 0644: no rule looks at a mode', () => {
    expect(GOOD_PACK.files.find(f => f.path === 'dist/cli.js')?.mode).toBe(0o644);
    expect(rc.packProblems(GOOD_PACK, RELEASE_MANIFEST, { binHead: HEAD_LF })).toEqual([]);
    const executable: Pack = { ...GOOD_PACK, files: GOOD_PACK.files.map(f => ({ ...f, mode: 0o755 })) };
    const modeless: Pack = { ...GOOD_PACK, files: GOOD_PACK.files.map(f => ({ path: f.path })) };
    expect(rc.packProblems(executable, RELEASE_MANIFEST, { binHead: HEAD_LF })).toEqual([]);
    expect(rc.packProblems(modeless, RELEASE_MANIFEST, { binHead: HEAD_LF })).toEqual([]);
  });

  it('refuses what does not belong in the package', () => {
    const cases: [string, RegExp[]][] = [
      ['dist/index.js.map', [/ends in \.map/]],
      ['dist/recordings/rec-1.jsonl', [/ends in \.jsonl/, /is under recordings\//]],
      ['abb-rws-daemon-0.1.0.tgz', [/is not part of the package/, /ends in \.tgz/]],
      ['abb-rws-daemon.config.json', [/is not part of the package/, /ends in \.config\.json/]],
      ['token', [/is not part of the package/, /is named token/]],
      ['dist/token', [/is named token/]],
      ['tests/cli.test.ts', [/is not part of the package/, /is under tests\//]],
      ['scripts/release-check.mjs', [/is not part of the package/, /is under scripts\//]],
      ['.github/workflows/ci.yml', [/is not part of the package/, /is under \.github\//]],
      ['RELEASING.md', [/is not part of the package/]],
      ['src/cli.ts', [/is not part of the package/]],
    ];
    for (const [path, expected] of cases) {
      const problems = rc.packProblems(withFiles(path), RELEASE_MANIFEST, { binHead: HEAD_LF });
      expect(problems, path).toHaveLength(expected.length);
      expected.forEach((re, i) => { expect(problems[i], path).toMatch(re); });
      expect(problems.every(p => p.startsWith(path)), path).toBe(true);
    }
  });

  it('wants the bin target listed, named by bin, and starting with the #! line in LF', () => {
    const without: Pack = { ...GOOD_PACK, files: GOOD_PACK.files.filter(f => f.path !== 'dist/cli.js') };
    expect(rc.packProblems(without, RELEASE_MANIFEST, { binHead: HEAD_LF })).toEqual(['dist/cli.js is not in the package']);
    expect(rc.packProblems(GOOD_PACK, { ...RELEASE_MANIFEST, bin: { 'abb-rws-daemon': 'dist/main.js' } }, { binHead: HEAD_LF }))
      .toEqual(['bin names dist/main.js, not dist/cli.js']);
    expect(rc.packProblems(GOOD_PACK, RELEASE_MANIFEST, { binHead: HEAD_CRLF })).toEqual(['the first line of dist/cli.js ends in CR LF, not LF']);
    expect(rc.packProblems(GOOD_PACK, RELEASE_MANIFEST, { binHead: null })).toEqual(['dist/cli.js is not there']);
    expect(rc.packProblems(GOOD_PACK, RELEASE_MANIFEST, { binHead: '"use strict";\n' })[0]).toMatch(/does not start with the line/);
  });

  it('wants the unpacked size under the limit', () => {
    expect(rc.PACK_MAX_UNPACKED_BYTES).toBe(2_000_000);
    expect(rc.packProblems({ ...GOOD_PACK, unpackedSize: 1_999_999 }, RELEASE_MANIFEST, { binHead: HEAD_LF })).toEqual([]);
    expect(rc.packProblems({ ...GOOD_PACK, unpackedSize: 2_000_000 }, RELEASE_MANIFEST, { binHead: HEAD_LF })).toHaveLength(1);
    expect(rc.packProblems({ ...GOOD_PACK, unpackedSize: Number.NaN }, RELEASE_MANIFEST, { binHead: HEAD_LF })).toHaveLength(1);
  });

  it('reads what npm prints', () => {
    const printed = JSON.stringify([{ id: 'abb-rws-daemon@0.1.0', unpackedSize: 1234, files: [{ path: 'dist\\cli.js', size: 5, mode: 420 }, { path: 'LICENSE', size: 6, mode: 420 }] }]);
    expect(rc.parsePackOutput(`\n${printed}\n`)).toEqual({
      unpackedSize: 1234, files: [{ path: 'dist/cli.js', size: 5, mode: 420 }, { path: 'LICENSE', size: 6, mode: 420 }],
    });
    expect(() => rc.parsePackOutput('npm error something')).toThrow(/no file list/);
  });
});

describe('release check: command line', () => {
  it('reads its options', () => {
    expect(rc.parseArgs([], {})).toEqual({ release: false, commits: null, denyFile: null, help: false, problem: null });
    expect(rc.parseArgs(['--release', '--commits', 'origin/master..HEAD', '--deny-file', 'x.txt'], {})).toEqual({
      release: true, commits: 'origin/master..HEAD', denyFile: 'x.txt', help: false, problem: null,
    });
    expect(rc.parseArgs([], { [rc.DENY_FILE_ENV]: 'from-env.txt' }).denyFile).toBe('from-env.txt');
    expect(rc.parseArgs(['--deny-file', 'named.txt'], { [rc.DENY_FILE_ENV]: 'from-env.txt' }).denyFile).toBe('named.txt');
    expect(rc.parseArgs([], { [rc.DENY_FILE_ENV]: '' }).denyFile).toBeNull();
    expect(rc.parseArgs(['--help'], {}).help).toBe(true);
  });

  it('refuses what it does not know', () => {
    expect(rc.parseArgs(['--commits'], {}).problem).toBe('--commits needs a value');
    expect(rc.parseArgs(['--commits', '--release'], {}).problem).toBe('--commits needs a value');
    expect(rc.parseArgs(['--deny-file', ''], {}).problem).toBe('--deny-file needs a value');
    expect(rc.parseArgs(['--bogus'], {}).problem).toBe('unknown argument --bogus');
    expect(rc.parseArgs(['release'], {}).problem).toBe('unknown argument release');
    const errors: string[] = [];
    const lines: string[] = [];
    expect(rc.main(['--bogus'], { env: {}, write: l => lines.push(l), error: l => errors.push(l) })).toBe(2);
    expect(lines).toEqual([]);
    expect(errors[0]).toBe('release-check: unknown argument --bogus');
    expect(rc.main(['--help'], { env: {}, write: l => lines.push(l), error: l => errors.push(l) })).toBe(0);
    expect(lines[0]).toMatch(/^usage: /);
  });
});

/** A small checkout: every file the checks read, in the state `manifest`, `readme`, `changelog` and `released` give. */
function checkout(over: { manifest?: Manifest; readme?: string; changelog?: string; released?: boolean; lock?: unknown; extra?: Record<string, string> } = {}): { dir: string; files: string[] } {
  const manifest = over.manifest ?? GOOD_MANIFEST;
  const linkedLock = {
    packages: {
      '': { name: 'abb-rws-daemon', dependencies: manifest.dependencies },
      '../abb-rws-client': { version: '1.4.0' },
      'node_modules/abb-rws-client': { resolved: '../abb-rws-client', link: true },
    },
  };
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify(over.lock ?? linkedLock, null, 2)}\n`,
    'README.md': over.readme ?? `${GOOD_README}\n${SIBLING_BLOCK}`,
    'CHANGELOG.md': over.changelog ?? '# Changelog\n\n## [0.1.0] - unreleased\n',
    LICENSE: 'Apache License\n',
    NOTICE: 'abb-rws-daemon\n',
    'TRADEMARKS.md': '# Trademarks and project names\n',
    'src/cli.ts': HEAD_LF,
    'src/index.ts': 'export const x = 1;\n',
    'src/schema/v0.ts': "export const SCHEMA_VERSION = '0.13' as const;\n",
    'schema/v0.schema.json': '{}\n',
    'schema/history/index.json': `${JSON.stringify([{ version: '0.13', sha256: 'y', ...(over.released ? { released: true } : {}) }])}\n`,
    'dist/cli.js': HEAD_LF,
    'dist/cli.d.ts': 'export {};\n',
    'dist/index.js': 'export const x = 1;\n',
    'dist/index.d.ts': 'export declare const x = 1;\n',
    'dist/schema/v0.js': "export const SCHEMA_VERSION = '0.13';\n",
    'node_modules/abb-rws-client/package.json': '{"name":"abb-rws-client","version":"1.4.0"}\n',
    ...over.extra,
  };
  const dir = folder(files);
  // What git would list: not the build folder, not node_modules.
  return { dir, files: Object.keys(files).filter(p => !p.startsWith('dist/') && !p.startsWith('node_modules/')) };
}

interface Run { code: number; lines: string[]; verdicts: string[]; failed: string[]; nodeCalls: { args: string[]; env?: Record<string, string | undefined> }[] }

function run(argv: string[], co: { dir: string; files: string[] }, over: Partial<MainOptions> & { version?: string } = {}): Run {
  const lines: string[] = [];
  const nodeCalls: Run['nodeCalls'] = [];
  const version = over.version ?? String(JSON.parse(readFileSync(join(co.dir, 'package.json'), 'utf8')).version);
  const node: NodeTool = (args, _cwd, env) => {
    nodeCalls.push({ args, env });
    return { status: 0, stdout: args.includes('--version') ? `abb-rws-daemon ${version}\nsnapshot schema 0.13\n` : '', stderr: '', timedOut: false };
  };
  const packed = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'TRADEMARKS.md', 'dist/cli.js', 'dist/cli.d.ts', 'dist/index.js', 'dist/index.d.ts', 'schema/v0.schema.json'];
  const code = rc.main(argv, {
    root: co.dir,
    env: {},
    write: l => lines.push(l),
    error: l => lines.push(`error: ${l}`),
    git: () => `${co.files.join('\0')}\0`,
    npmPack: () => ({ unpackedSize: 5000, files: packed.map(path => ({ path, size: 1, mode: 0o644 })) }),
    node,
    ...over,
  });
  const verdicts = lines.filter(l => /^(ok|FAIL) {2,}/.test(l));
  return { code, lines, verdicts, failed: verdicts.filter(l => l.startsWith('FAIL')).map(l => l.replace(/^FAIL\s+/, '').split(':').slice(0, l.includes('release:') ? 2 : 1).join(':')), nodeCalls };
}

describe('release check: the whole run', () => {
  it('prints one ok line per check for a development checkout', () => {
    const r = run([], checkout());
    expect(r.code).toBe(0);
    expect(r.verdicts.length).toBe(10);
    expect(r.failed).toEqual([]);
    expect(r.lines.at(-1)).toBe('release-check: 10 checks, 0 failed');
    expect(r.lines.length).toBe(11);
    expect(r.lines[0]).toMatch(/^ok {4}public content: 11 of 12 listed files scanned \(package-lock\.json left out\); no private list given$/);
  });

  it('with --release fails a development checkout on the release steps and on nothing else', () => {
    const r = run(['--release'], checkout());
    expect(r.code).toBe(1);
    expect(r.failed).toEqual([
      'release: not private', 'release: version', 'release: CHANGELOG date', 'release: README',
      'release: client dependency', 'release: lock file', 'release: schema released',
    ]);
    expect(r.lines.at(-1)).toBe('release-check: 22 checks, 7 failed (release rules on)');
    expect(r.lines.join('\n')).not.toMatch(/mode/i);
  });

  it('with --release passes a checkout the procedure has been through, and prints the client range', () => {
    const cleanLock = { packages: { '': { name: 'abb-rws-daemon', dependencies: RELEASE_MANIFEST.dependencies }, 'node_modules/abb-rws-client': { version: '1.4.0' } } };
    const co = checkout({ manifest: RELEASE_MANIFEST, readme: GOOD_README, changelog: '# Changelog\n\n## [0.1.0] - 2026-10-31\n', released: true, lock: cleanLock });
    const r = run(['--release'], co);
    expect(r.failed).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.verdicts.length).toBe(22);
    expect(r.lines.find(l => l.includes('release: client dependency'))).toBe('ok    release: client dependency: "^1.4.0", installed 1.4.0');
  });

  it('sees an exact pin where the range should be', () => {
    const pinned = { ...RELEASE_MANIFEST, dependencies: { 'abb-rws-client': '1.4.0' } };
    const r = run(['--release'], checkout({ manifest: pinned, readme: GOOD_README, changelog: '## [0.1.0] - 2026-10-31\n', released: true, lock: { packages: {} } }));
    expect(r.failed).toEqual(['release: client dependency']);
    expect(r.lines.find(l => l.includes('client dependency'))).toMatch(/"1\.4\.0" does not start with \^ or ~/);
  });

  it('starts the built command only with the variable that makes a daemon refuse to start', () => {
    const r = run(['--release'], checkout());
    const cli = r.nodeCalls.filter(c => c.args.some(a => a.endsWith('cli.js')));
    expect(cli.map(c => c.args.at(-1))).toEqual(['--version', '--help']);
    for (const call of cli) { expect(call.env?.ABB_RWS_DAEMON_RECORD).toBe('1'); }
  });

  it('fails the command check when the version printed is another one, or the command does not end', () => {
    const co = checkout();
    const other = run(['--release'], co, { version: '0.0.1' });
    expect(other.lines.find(l => l.includes('release: command'))).toMatch(/^FAIL {2}release: command: --version printed "abb-rws-daemon 0\.0\.1", which does not name 0\.1\.0-dev$/);
    const hangs = run(['--release'], co, { node: () => ({ status: null, stdout: '', stderr: '', timedOut: true }) });
    expect(hangs.lines.find(l => l.includes('release: command'))).toMatch(/^FAIL {2}release: command: 2 problems$/);
    expect(hangs.lines).toContain('        --version did not end');
  });

  it('reports planted text in an untracked file, a stale built file and a private-list hit', () => {
    const co = checkout({ extra: { 'notes/todo.md': `ask ${REAL_MAIL}\nabout Cell Seven\n`, 'dist/old/gone.js': 'export {};\n' } });
    const list = join(folder({ 'deny.txt': 'cell seven\n' }), 'deny.txt');
    const r = run(['--deny-file', list], co);
    expect(r.code).toBe(1);
    expect(r.failed).toEqual(['public content', 'built files have a source']);
    expect(r.lines).toContain(`        notes/todo.md:1 an e-mail address: ${REAL_MAIL}`);
    expect(r.lines).toContain('        notes/todo.md:2 a string of the private list: entry 1');
    expect(r.lines.find(l => l.includes('built files'))).toBe('FAIL  built files have a source: dist/old/gone.js has no source under src/ (delete dist/ and build again)');
    expect(r.lines.join('\n').toLowerCase()).not.toContain('cell seven');
    // The environment variable names the list as well; a clean checkout then says how long the list is.
    const byEnv = run([], co, { env: { [rc.DENY_FILE_ENV]: list } });
    expect(byEnv.lines).toContain('        notes/todo.md:2 a string of the private list: entry 1');
    expect(run([], checkout(), { env: { [rc.DENY_FILE_ENV]: list } }).lines[0]).toMatch(/^ok {4}public content: .*; private list of 1 entries$/);
  });

  it('catches a shape only the private list knows, in a file and in a commit, and names the entry alone', () => {
    // A made-up ticket shape and a made-up folder: nothing in the script's own rules knows them.
    const list = join(folder({ 'deny.txt': '# tickets and the notes folder\n/(?<![A-Za-z0-9])XK-\\d{1,3}(?![A-Za-z0-9])/\n/^(?:\\.\\.\\/)*vault\\/[A-Za-z0-9_]+/m\n' }), 'deny.txt');
    const co = checkout({ extra: { 'notes/todo.md': 'see XK-42\n../vault/plans\n' } });
    const r = run(['--deny-file', list], co);
    expect(r.failed).toEqual(['public content']);
    expect(r.lines).toContain('        notes/todo.md:1 a string of the private list: entry 1');
    expect(r.lines).toContain('        notes/todo.md:2 a string of the private list: entry 2');
    expect(r.lines.join('\n')).not.toMatch(/XK|vault/);
    const log = ['0123456789abcdef', `Jane Roe <${REAL_MAIL}>`, `Jane Roe <${REAL_MAIL}>`, 'Close XK-7\n'].join('\x1f') + '\x1e\n';
    const commits = run(['--commits', 'origin/master..HEAD', '--deny-file', list], checkout(), { git: (args) => (args[0] === 'log' ? log : `${checkout().files.join('\0')}\0`) });
    expect(commits.failed).toEqual(['commits origin/master..HEAD']);
    expect(commits.lines).toContain('FAIL  commits origin/master..HEAD: 012345678 message line 1: a string of the private list: entry 1');
    // Without the list the same checkout passes: the shapes are the publisher's to name.
    expect(run([], co).failed).toEqual([]);
  });

  it('refuses a private list kept inside the checkout, one it cannot read, and one with a pattern that does not compile', () => {
    const co = checkout({ extra: { 'deny.txt': 'cell seven\n' } });
    const inside = run(['--deny-file', join(co.dir, 'deny.txt')], co);
    expect(inside.lines.find(l => l.includes('public content'))).toMatch(/^FAIL {2}public content: the private list \(deny\.txt\) is inside the checkout/);
    const unread = run(['--deny-file', join(co.dir, 'no-such-list.txt')], co);
    expect(unread.lines[0]).toBe('FAIL  public content: could not run: the private list cannot be read');
    expect(unread.code).toBe(1);
    const broken = run(['--deny-file', join(folder({ 'deny.txt': 'fine\n/(unclosed/\n' }), 'deny.txt')], checkout());
    expect(broken.lines[0]).toBe('FAIL  public content: could not run: entry 2 of the private list is not a valid regular expression');
    expect(broken.code).toBe(1);
  });

  it('scans the commits of a range when asked', () => {
    const log = (author: string, message: string): string => ['0123456789abcdef', author, author, message].join('\x1f') + '\x1e\n';
    const co = checkout();
    const asked: string[][] = [];
    const git = (answer: string): Git => (args) => {
      asked.push(args);
      return args[0] === 'log' ? answer : `${co.files.join('\0')}\0`;
    };
    const good = run(['--commits', 'origin/master..HEAD'], co, { git: git(log(`Jane Roe <${REAL_MAIL}>`, 'Fix the port check\n')) });
    expect(good.code).toBe(0);
    expect(good.lines.at(-2)).toBe('ok    commits origin/master..HEAD: 1 commits; no private list given');
    expect(asked.find(a => a[0] === 'log')).toEqual(['log', expect.stringMatching(/^--format=%H%x1f/), 'origin/master..HEAD', '--']);
    const bad = run(['--commits', 'origin/master..HEAD'], co, { git: git(log(`${TOOL} <${REAL_MAIL}>`, `Fix\n\n${TRAILER}\n`)) });
    expect(bad.code).toBe(1);
    expect(bad.failed).toEqual(['commits origin/master..HEAD']);
    expect(bad.lines.filter(l => l.startsWith('        ')).map(l => l.trim().split(':')[0])).toEqual([
      '012345678 author', '012345678 committer', '012345678 message line 3',
    ]);
  });

  it('never throws: an empty folder outside any checkout gets a FAIL line per check', () => {
    const dir = folder();
    const lines: string[] = [];
    const code = rc.main(['--release'], {
      root: dir, env: {}, write: l => lines.push(l), error: l => lines.push(l),
      git: () => { throw new Error('fatal: not a git repository'); },
      npmPack: () => { throw new Error('npm pack --dry-run failed: no package.json'); },
      node: () => ({ status: 1, stdout: '', stderr: 'Cannot find module', timedOut: false }),
    });
    expect(code).toBe(1);
    expect(lines[0]).toBe('FAIL  public content: the content scan needs a git checkout');
    const verdicts = lines.filter(l => /^(ok|FAIL) {2,}/.test(l));
    expect(verdicts.length).toBe(22);
    expect(lines.at(-1)).toMatch(/^release-check: 22 checks, \d+ failed \(release rules on\)$/);
    expect(lines).toContain('FAIL  release: packed files: could not run: npm pack --dry-run failed: no package.json');
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FLAGS, HELP_FLAGS, VERSION_FLAGS, flagsOf, helpText, parseArgv, switchFlags, valueFlags, versionText,
  type FlagGroup,
} from '../src/cliOptions.js';
import { DEFAULT_PANEL_ORIGINS } from '../src/localGuard.js';
import { RECORDING_LIMIT_BOUNDS, RECORDING_LIMIT_DEFAULTS } from '../src/recording/writer.js';
import { REPLAY_SPEED_MAX, REPLAY_SPEED_MIN, SCHEMA_VERSION, TOKEN_HEADER } from '../src/schema/v0.js';
import { DEFAULT_PORT } from '../src/server.js';

/**
 * The command line as data (src/cliOptions.ts): the table of options, the
 * one function that reads the raw arguments, and the help and version texts.
 * Nothing here starts anything: every function under test is pure.
 */

const MIB = 1024 * 1024;
const UNKNOWN_TAIL = '; abb-rws-daemon --help lists the options';

/** The options this release has: flag, value, environment variable, group. Another option is another row of FLAGS. */
const ROWS: Array<[string, string | null, string | null, FlagGroup]> = [
  ['--config', '<file>', 'ABB_RWS_DAEMON_CONFIG', 'general'],
  ['--port', '<n>', 'ABB_RWS_DAEMON_PORT', 'general'],
  ['--panel-origins', '<list>', 'ABB_RWS_DAEMON_PANEL_ORIGINS', 'general'],
  ['--token-file', '<file>', 'ABB_RWS_DAEMON_TOKEN_FILE', 'general'],
  ['--record', null, null, 'record'],
  ['--record-label', '<label>', null, 'record'],
  ['--record-content', '<list>', null, 'record'],
  ['--record-for', '<s>', null, 'record'],
  ['--record-max-file-mb', '<n>', null, 'record'],
  ['--record-max-total-mb', '<n>', null, 'record'],
  ['--record-max-dir-mb', '<n>', null, 'record'],
  ['--record-dir', '<folder>', 'ABB_RWS_DAEMON_RECORD_DIR', 'record'],
  ['--replay', '<file-or-folder>', 'ABB_RWS_DAEMON_REPLAY', 'replay'],
  ['--replay-speed', '<x>', 'ABB_RWS_DAEMON_REPLAY_SPEED', 'replay'],
  ['--replay-loop', null, 'ABB_RWS_DAEMON_REPLAY_LOOP', 'replay'],
  ['--replay-parts', '<n>[-<m>]', 'ABB_RWS_DAEMON_REPLAY_PARTS', 'replay'],
  ['--replay-time', '<shifted|recorded>', null, 'replay'],
  ['--replay-paused', null, null, 'replay'],
  ['--replay-skip-bad', null, null, 'replay'],
];

/** `text` holds `word` as a whole word: not as the start of a longer option or variable name. */
function count(text: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'g'))].length;
}

describe('the table of options', () => {
  it('holds every option of this release with its value, variable and group', () => {
    for (const [flag, value, env, group] of ROWS) {
      const row = FLAGS.find(f => f.flag === flag);
      expect(row, flag).toBeDefined();
      expect({ value: row!.value, env: row!.env, group: row!.group }, flag).toEqual({ value, env, group });
      expect(row!.help.trim().length, `${flag} has a help text`).toBeGreaterThan(0);
    }
  });

  it('names no option and no environment variable twice', () => {
    const flags = FLAGS.map(f => f.flag);
    expect(new Set(flags).size).toBe(flags.length);
    const envs = FLAGS.map(f => f.env).filter((e): e is string => e !== null);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it('spells every option --lower-case and every variable ABB_RWS_DAEMON_UPPER_CASE', () => {
    for (const f of FLAGS) {
      expect(f.flag, f.flag).toMatch(/^--[a-z]+(-[a-z]+)*$/);
      if (f.env !== null) { expect(f.env, f.flag).toMatch(/^ABB_RWS_DAEMON_[A-Z]+(_[A-Z]+)*$/); }
      if (f.value !== null) { expect(f.value, f.flag).toMatch(/^<[^<>\s]+>(\[\S+\])?$/); }
    }
  });

  it('keeps the help and version flags out of the table, and has no variable that starts a recording', () => {
    expect(HELP_FLAGS).toEqual(['--help', '-h']);
    expect(VERSION_FLAGS).toEqual(['--version', '-v']);
    for (const f of [...HELP_FLAGS, ...VERSION_FLAGS]) { expect(FLAGS.some(row => row.flag === f), f).toBe(false); }
    expect(FLAGS.some(row => row.env === 'ABB_RWS_DAEMON_RECORD')).toBe(false);
    expect(FLAGS.find(row => row.flag === '--record')!.env).toBeNull();
  });

  it('gives the lists the command line works with', () => {
    const values = valueFlags();
    const switches = switchFlags();
    expect([...values].filter(f => switches.has(f))).toEqual([]);
    expect(new Set([...values, ...switches])).toEqual(new Set(FLAGS.map(f => f.flag)));
    expect([...switches].sort()).toEqual(['--record', '--replay-loop', '--replay-paused', '--replay-skip-bad']);
    for (const f of ['--config', '--port', '--panel-origins', '--token-file']) { expect(flagsOf('general'), f).toContain(f); }
    // The recorder's options, which a replaying daemon refuses.
    expect(flagsOf('record').sort()).toEqual([
      '--record', '--record-content', '--record-dir', '--record-for', '--record-label',
      '--record-max-dir-mb', '--record-max-file-mb', '--record-max-total-mb',
    ]);
    // The options that need --replay: not --replay itself.
    expect(flagsOf('replay').sort()).toEqual([
      '--replay-loop', '--replay-parts', '--replay-paused', '--replay-skip-bad', '--replay-speed', '--replay-time',
    ]);
    expect(values.has('--replay')).toBe(true);
  });
});

describe('parseArgv: what is accepted', () => {
  it('nothing given', () => {
    expect(parseArgv([])).toEqual({ argv: [], problem: null, help: false, version: false });
  });

  it('options with their values and switches pass as given', () => {
    const raw = ['--config', 'cell.json', '--port', '7811', '--record', '--record-for', '60', '--record-label', 'cell-7'];
    expect(parseArgv(raw)).toEqual({ argv: raw, problem: null, help: false, version: false });
  });

  it('--port=7811 is --port, 7811', () => {
    expect(parseArgv(['--port=7811'])).toEqual({ argv: ['--port', '7811'], problem: null, help: false, version: false });
  });

  it('only the first = splits, and only an option that takes a value is split', () => {
    expect(parseArgv(['--config=a=b.json', '--record']).argv).toEqual(['--config', 'a=b.json', '--record']);
    expect(parseArgv(['--config', 'a=b.json'])).toMatchObject({ argv: ['--config', 'a=b.json'], problem: null });
    expect(parseArgv(['--config', '--port=1'])).toMatchObject({ problem: '--config needs a value' });
  });

  it('--port -1 takes -1 as the value (the port check refuses it later)', () => {
    expect(parseArgv(['--port', '-1'])).toEqual({ argv: ['--port', '-1'], problem: null, help: false, version: false });
    expect(parseArgv(['--port=-1'])).toMatchObject({ argv: ['--port', '-1'], problem: null });
  });

  it('every option of the table is accepted once, in both spellings', () => {
    for (const f of FLAGS) {
      if (f.value === null) {
        expect(parseArgv([f.flag]), f.flag).toMatchObject({ argv: [f.flag], problem: null });
      } else {
        expect(parseArgv([f.flag, 'x']), f.flag).toMatchObject({ argv: [f.flag, 'x'], problem: null });
        expect(parseArgv([`${f.flag}=x`]), f.flag).toMatchObject({ argv: [f.flag, 'x'], problem: null });
      }
    }
  });

  it('does not change what it was given', () => {
    const raw = Object.freeze(['--port=7811', '--record']);
    parseArgv(raw);
    expect(raw).toEqual(['--port=7811', '--record']);
  });
});

describe('parseArgv: what is refused, with the exact message', () => {
  const cases: Array<[string, string[], string]> = [
    // A token starting with - that is no known flag.
    ['an unknown option', ['--bogus'], `unknown option --bogus${UNKNOWN_TAIL}`],
    ['an unknown option with a value: named without it', ['--bogus=1'], `unknown option --bogus${UNKNOWN_TAIL}`],
    ['a misspelt recorder option', ['--record-forr', '60'], `unknown option --record-forr${UNKNOWN_TAIL}`],
    ['a misspelt replay option', ['--replay-speeds', '2'], `unknown option --replay-speeds${UNKNOWN_TAIL}`],
    ['a single-dash option', ['-x'], `unknown option -x${UNKNOWN_TAIL}`],
    ['a single-dash option with a value', ['-p=7811'], `unknown option -p${UNKNOWN_TAIL}`],
    ['a help flag spelt another way', ['-help'], `unknown option -help${UNKNOWN_TAIL}`],
    ['a question mark', ['-?'], `unknown option -?${UNKNOWN_TAIL}`],
    ['two dashes alone', ['--'], `unknown option --${UNKNOWN_TAIL}`],
    ['one dash alone', ['-'], `unknown option -${UNKNOWN_TAIL}`],
    ['an option in capitals', ['--PORT', '7811'], `unknown option --PORT${UNKNOWN_TAIL}`],
    // A value flag at the end, or followed by an empty value or by a token starting with --; --flag=.
    ['a value flag at the end', ['--port'], '--port needs a value'],
    ['a value flag at the end, after others', ['--record', '--record-for'], '--record-for needs a value'],
    ['a value flag followed by an empty value', ['--port', ''], '--port needs a value'],
    ['a value flag followed by blanks', ['--config', '   '], '--config needs a value'],
    ['a value flag followed by an option', ['--replay', '--record'], '--replay needs a value'],
    ['a value flag followed by an unknown option', ['--token-file', '--bogus'], '--token-file needs a value'],
    ['--flag= with nothing after it', ['--port='], '--port needs a value'],
    ['--flag= with blanks after it', ['--port=  '], '--port needs a value'],
    ['--flag=--other', ['--port=--record'], '--port needs a value'],
    // A switch written --switch=value.
    ['a switch with a value', ['--record=1'], '--record takes no value'],
    ['a switch with a word', ['--replay-loop=true'], '--replay-loop takes no value'],
    ['a switch with an empty value', ['--replay-paused='], '--replay-paused takes no value'],
    ['the help flag with a value', ['--help=1'], '--help takes no value'],
    ['the short help flag with a value', ['-h=1'], '-h takes no value'],
    ['the version flag with a value', ['--version=x'], '--version takes no value'],
    // The same flag twice, in either spelling.
    ['a value flag twice', ['--port', '1', '--port', '2'], '--port is given twice'],
    ['a value flag twice, = then spaced', ['--port=1', '--port', '2'], '--port is given twice'],
    ['a value flag twice, spaced then =', ['--port', '1', '--port=2'], '--port is given twice'],
    ['a value flag twice, both =', ['--port=1', '--port=2'], '--port is given twice'],
    ['a switch twice', ['--record', '--record'], '--record is given twice'],
    ['a switch twice, apart', ['--replay-loop', '--port', '1', '--replay-loop'], '--replay-loop is given twice'],
    // A token that is neither a flag nor a flag's value.
    ['a bare word', ['start'], 'unexpected argument "start"; options start with --'],
    ['a word after a switch', ['--record', 'yes'], 'unexpected argument "yes"; options start with --'],
    ['a second value', ['--port', '1', '2'], 'unexpected argument "2"; options start with --'],
    ['a file name without its option', ['cell.json'], 'unexpected argument "cell.json"; options start with --'],
    ['a Windows help switch', ['/?'], 'unexpected argument "/?"; options start with --'],
    ['the word help', ['help'], 'unexpected argument "help"; options start with --'],
    ['an empty argument', [''], 'unexpected argument ""; options start with --'],
    // The first problem in command-line order.
    ['unknown before valueless', ['--bogus', '--port'], `unknown option --bogus${UNKNOWN_TAIL}`],
    ['valueless before unknown', ['--port', '--bogus'], '--port needs a value'],
    ['stray before unknown', ['x', '--bogus'], 'unexpected argument "x"; options start with --'],
    ['takes no value before twice', ['--record=1', '--port', '1', '--port', '2'], '--record takes no value'],
  ];

  for (const [name, raw, message] of cases) {
    it(`${name}: ${raw.map(t => (t === '' ? '""' : t)).join(' ')}`, () => {
      const parsed = parseArgv(raw);
      expect(parsed.problem).toBe(message);
      expect(parsed.help).toBe(false);
      expect(parsed.version).toBe(false);
    });
  }

  it('--record=1 is "takes no value", never a stray 1', () => {
    expect(parseArgv(['--record=1'])).toEqual({
      argv: ['--record=1'], problem: '--record takes no value', help: false, version: false,
    });
  });

  it('argv comes back whole beside a problem', () => {
    expect(parseArgv(['--bogus', '--port=7811', 'x', '--record'])).toEqual({
      argv: ['--bogus', '--port', '7811', 'x', '--record'],
      problem: `unknown option --bogus${UNKNOWN_TAIL}`, help: false, version: false,
    });
    expect(parseArgv(['--port', '--record', '--config', 'a.json']).argv).toEqual(['--port', '--record', '--config', 'a.json']);
    expect(parseArgv(['--port', '', '--record']).argv).toEqual(['--port', '', '--record']);
  });

  it('with no problem, a value never stands where an option is looked for', () => {
    // cli.ts looks options up by name in argv: an accepted value never starts with --.
    for (const raw of [['--config', 'a', '--port=1', '--record'], ['--record-label=x', '--record'], ['--replay=r', '--replay-speed', '2']]) {
      const parsed = parseArgv(raw);
      expect(parsed.problem).toBeNull();
      const values = parsed.argv.filter((_, i) => i > 0 && valueFlags().has(parsed.argv[i - 1]));
      for (const v of values) { expect(v.startsWith('--'), v).toBe(false); }
    }
  });
});

describe('parseArgv: help and version', () => {
  it('a help flag counts wherever it stands, also beside a problem', () => {
    expect(parseArgv(['--help'])).toEqual({ argv: ['--help'], problem: null, help: true, version: false });
    expect(parseArgv(['-h'])).toMatchObject({ problem: null, help: true });
    expect(parseArgv(['--port', '7811', '--help'])).toMatchObject({ problem: null, help: true });
    expect(parseArgv(['--bogus', '--help'])).toMatchObject({ problem: `unknown option --bogus${UNKNOWN_TAIL}`, help: true });
    expect(parseArgv(['--help', 'start'])).toMatchObject({ help: true });
  });

  it('a help flag counts where a value was expected', () => {
    expect(parseArgv(['--config', '--help'])).toMatchObject({ problem: '--config needs a value', help: true });
    expect(parseArgv(['--config', '-h'])).toMatchObject({ argv: ['--config', '-h'], help: true });
  });

  it('a version flag counts the same way', () => {
    expect(parseArgv(['--version'])).toEqual({ argv: ['--version'], problem: null, help: false, version: true });
    expect(parseArgv(['-v'])).toMatchObject({ problem: null, version: true });
    expect(parseArgv(['--bogus', '-v'])).toMatchObject({ version: true });
    expect(parseArgv(['--port', '--version'])).toMatchObject({ problem: '--port needs a value', version: true });
    expect(parseArgv(['--help', '--version'])).toMatchObject({ help: true, version: true });
  });

  it('only the exact flag counts', () => {
    for (const raw of [['--help=1'], ['--helpx'], ['help'], ['-help'], ['--Help'], ['--config=--help'], ['--record-label=-h']]) {
      expect(parseArgv(raw).help, raw.join(' ')).toBe(false);
    }
    for (const raw of [['--version=1'], ['version'], ['-V'], ['--record-label=-v']]) {
      expect(parseArgv(raw).version, raw.join(' ')).toBe(false);
    }
    // The = spelling passes a value that looks like a flag of these.
    expect(parseArgv(['--record', '--record-label=-v'])).toEqual({
      argv: ['--record', '--record-label', '-v'], problem: null, help: false, version: false,
    });
  });
});

describe('the help text', () => {
  const text = helpText('9.8.7');
  const lines = text.split('\n');
  const flat = text.replace(/\s+/g, ' ');

  it('begins with the name and the version, and ends with one line end', () => {
    expect(lines[0]).toBe('abb-rws-daemon 9.8.7');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('stays within 80 columns, without a tab, a carriage return or a blank at a line end', () => {
    for (const line of lines) {
      expect(line.length, line).toBeLessThanOrEqual(80);
      expect(line, line).not.toMatch(/\s$/);
    }
    expect(text).not.toContain('\t');
    expect(text).not.toContain('\r');
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('has one entry for every option, with its value', () => {
    for (const f of FLAGS) {
      const left = f.value === null ? f.flag : `${f.flag} ${f.value}`;
      const entries = lines.filter(l => l === `  ${left}` || l.startsWith(`  ${left}  `));
      expect(entries.length, left).toBe(1);
    }
  });

  it('names every environment variable once, in brackets with its option', () => {
    for (const f of FLAGS) {
      if (f.env === null) { continue; }
      expect(count(text, f.env), f.env).toBe(1);
      expect(text, f.env).toContain(`[${f.env}]`);
      // The bracket stands in the entry of its option: after that entry's first line, before the next entry.
      const start = lines.findIndex(l => l.startsWith(`  ${f.flag}`) && (l.length === f.flag.length + 2 || l[f.flag.length + 2] === ' '));
      const next = lines.findIndex((l, i) => i > start && !l.startsWith('    '));
      expect(lines.slice(start, next).join('\n'), f.env).toContain(`[${f.env}]`);
    }
    expect(count(text, 'ABB_RWS_DAEMON_LOG')).toBe(1);
  });

  it('names no variable that would start a recording', () => {
    expect(count(text, 'ABB_RWS_DAEMON_RECORD')).toBe(0);
    expect(flat).toContain('No environment variable starts one.');
  });

  it('has the usage lines, the help and version flags, and the sections', () => {
    expect(text).toContain('\nUsage:\n  abb-rws-daemon [--config <file>] [--port <n>] [options]\n');
    expect(text).toContain('\n  abb-rws-daemon --replay <file-or-folder> [--port <n>] [replay options]\n');
    expect(text).toContain('\n  abb-rws-daemon --help | --version\n');
    expect(lines.filter(l => l.startsWith('  -h, --help  ')).length).toBe(1);
    expect(lines.filter(l => l.startsWith('  -v, --version  ')).length).toBe(1);
    for (const heading of ['Options:', 'Recording (live mode):', 'Replay:', 'Environment only:']) {
      expect(lines, heading).toContain(heading);
    }
    expect(flat).toContain('Read-only: it changes nothing on a controller.');
  });

  it('says that an empty variable counts as unset', () => {
    expect(flat).toContain('An option on the command line wins over its environment variable.');
    expect(flat).toContain('An empty variable counts as unset.');
    expect(flat).not.toContain('still counts as given');
  });

  it('says where the token goes and what the exit codes mean', () => {
    expect(flat).toContain(`Every request but GET /v0/health needs the access token in the ${TOKEN_HEADER} header.`);
    expect(flat).toContain('Exit codes: 0 after --help, --version and a clean stop; 1 when the daemon did not start '
      + '(the message says why) or a stop was cut short.');
  });

  it('gives the defaults and bounds the daemon really has', () => {
    const entryOf = (flag: string): string => {
      const start = lines.findIndex(l => l.startsWith(`  ${flag} `) || l === `  ${flag}`);
      const next = lines.findIndex((l, i) => i > start && !l.startsWith('    '));
      return lines.slice(start, next).join(' ').replace(/\s+/g, ' ');
    };
    expect(entryOf('--port')).toContain(`Default: ${DEFAULT_PORT}.`);
    expect(entryOf('--config')).toContain('Default: abb-rws-daemon.config.json in the current folder.');
    expect(entryOf('--panel-origins')).toContain(`Default: ${DEFAULT_PANEL_ORIGINS.join(',')}.`);
    const d = RECORDING_LIMIT_DEFAULTS;
    const b = RECORDING_LIMIT_BOUNDS;
    expect(entryOf('--record-for')).toContain(`${b.durationS.min} to ${b.durationS.max}. Default: ${d.durationS}.`);
    expect(entryOf('--record-max-file-mb'))
      .toContain(`${Math.ceil(b.maxFileBytes.min / MIB)} to ${Math.floor(b.maxFileBytes.max / MIB)},`);
    expect(entryOf('--record-max-file-mb')).toContain(`Default: ${d.maxFileBytes / MIB}.`);
    expect(entryOf('--record-max-total-mb'))
      .toContain(`${Math.ceil(b.maxTotalBytes.min / MIB)} to ${Math.floor(b.maxTotalBytes.max / MIB)},`);
    expect(entryOf('--record-max-total-mb')).toContain(`Default: ${d.maxTotalBytes / MIB}.`);
    expect(entryOf('--record-max-dir-mb'))
      .toContain(`${Math.ceil(b.maxDirBytes.min / MIB)} to ${Math.floor(b.maxDirBytes.max / MIB)},`);
    expect(entryOf('--record-max-dir-mb')).toContain(`Default: ${d.maxDirBytes / MIB}.`);
    expect(entryOf('--replay-speed')).toContain(`${REPLAY_SPEED_MIN} to ${REPLAY_SPEED_MAX}.`);
    expect(entryOf('--token-file')).toContain('%APPDATA%\\abb-rws-daemon\\token');
    expect(entryOf('--token-file')).toContain('$XDG_CONFIG_HOME/abb-rws-daemon/token');
    expect(entryOf('--token-file')).toContain('~/.config/abb-rws-daemon/token');
  });

  it('is the same text every time', () => {
    expect(helpText('9.8.7')).toBe(text);
  });
});

describe('the version text', () => {
  it('is two lines: the daemon, then the schema, the client and Node.js', () => {
    expect(versionText('1.2.3', '4.5.6', 'v22.1.0'))
      .toBe(`abb-rws-daemon 1.2.3\nsnapshot schema ${SCHEMA_VERSION}, abb-rws-client 4.5.6, Node.js v22.1.0\n`);
  });

  it('reads the client and Node.js versions itself when they are not given', () => {
    const [first, second, rest] = versionText('1.2.3').split('\n');
    expect(first).toBe('abb-rws-daemon 1.2.3');
    expect(second).toMatch(new RegExp(`^snapshot schema ${SCHEMA_VERSION.replace('.', '\\.')}, abb-rws-client \\d+\\.\\d+\\.\\d+\\S*, Node\\.js v\\d+\\.\\d+\\.\\d+`));
    expect(second).toContain(`Node.js ${process.version}`);
    expect(rest).toBe('');
  });
});

describe('the README', () => {
  it('names every option of the table', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const missing = FLAGS.map(f => f.flag).filter(flag => count(readme, flag) === 0);
    expect(missing).toEqual([]);
  });
});

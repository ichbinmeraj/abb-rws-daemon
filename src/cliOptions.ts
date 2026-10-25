import { clientVersion } from './recording/recorder.js';
import { SCHEMA_VERSION, TOKEN_HEADER } from './schema/v0.js';

/**
 * The daemon's command line as data: every option with its value, its
 * environment variable and its help text; the views cli.ts needs of that
 * table; and the one function that reads the raw arguments. Importing this
 * file reads nothing and changes nothing, and none of its functions exits or
 * prints: cli.ts decides what to do with what they return.
 */

/** The part of the help text an option stands in. */
export type FlagGroup = 'general' | 'record' | 'replay';

/** One option of the command line. */
export interface FlagSpec {
  /** The option as typed, for example `--port`. */
  flag: string;
  /** What the help text calls its value, for example `<n>`; null for a switch, which takes none. */
  value: string | null;
  /** The environment variable that gives the same setting; null when there is none. */
  env: string | null;
  group: FlagGroup;
  /** What the help text says about it, as one paragraph. */
  help: string;
}

/**
 * Every option. A new option is one more row here: the argument check, the
 * option lists of cli.ts and the help text all follow from it.
 */
export const FLAGS: readonly FlagSpec[] = Object.freeze([
  {
    flag: '--config', value: '<file>', env: 'ABB_RWS_DAEMON_CONFIG', group: 'general',
    help: 'The controllers and their credentials (JSON). Default: abb-rws-daemon.config.json in the current folder. '
      + 'A file that is not there means no controllers; the daemon makes it when one is added.',
  },
  {
    flag: '--port', value: '<n>', env: 'ABB_RWS_DAEMON_PORT', group: 'general',
    help: 'The port to listen on, 1 to 65535, on 127.0.0.1 only. Default: 7810.',
  },
  {
    flag: '--panel-origins', value: '<list>', env: 'ABB_RWS_DAEMON_PANEL_ORIGINS', group: 'general',
    help: 'The origins (scheme, host and port) a browser page may call the daemon from, besides its own, '
      + 'comma-separated. Default: http://127.0.0.1:5173,http://localhost:5173.',
  },
  {
    flag: '--allowed-hosts', value: '<list>', env: 'ABB_RWS_DAEMON_ALLOWED_HOSTS', group: 'general',
    help: 'Host names the daemon also accepts in the Host header, besides 127.0.0.1, localhost and ::1, '
      + 'comma-separated: names only, no addresses, ports or wildcards. For a client that reaches this loopback '
      + 'port under another name, such as a container on Docker Desktop (host.docker.internal). Default: none. '
      + 'The daemon still listens on 127.0.0.1 only, and every route but GET /v0/health still needs the access token.',
  },
  {
    flag: '--token-file', value: '<file>', env: 'ABB_RWS_DAEMON_TOKEN_FILE', group: 'general',
    help: 'The access token\'s file, made on the first start. Default: %APPDATA%\\abb-rws-daemon\\token on Windows; '
      + '$XDG_CONFIG_HOME/abb-rws-daemon/token elsewhere, ~/.config/abb-rws-daemon/token without it.',
  },
  {
    flag: '--record', value: null, env: null, group: 'record',
    help: 'Start a recording when the daemon starts.',
  },
  {
    flag: '--record-label', value: '<label>', env: null, group: 'record',
    help: 'Part of the file names of that recording: 1 to 32 lowercase letters, digits or hyphens. Needs --record.',
  },
  {
    flag: '--record-content', value: '<list>', env: null, group: 'record',
    help: 'What that recording holds: frames, calls and state, comma-separated. Default: all three. Needs --record.',
  },
  {
    flag: '--record-for', value: '<s>', env: null, group: 'record',
    help: 'The longest a recording runs, in seconds, 1 to 86400. Default: 3600.',
  },
  {
    flag: '--record-max-file-mb', value: '<n>', env: null, group: 'record',
    help: 'A recording file of this size, in MiB, 1 to 256, is closed and the recording goes on in the next. Default: 64.',
  },
  {
    flag: '--record-max-total-mb', value: '<n>', env: null, group: 'record',
    help: 'A recording of this size, in MiB, 1 to 8192, stops. Default: 256.',
  },
  {
    flag: '--record-max-dir-mb', value: '<n>', env: null, group: 'record',
    help: 'When the recordings in the folder together are this size, in MiB, 1 to 65536, none starts and one that '
      + 'runs stops. Default: 4096.',
  },
  {
    flag: '--record-dir', value: '<folder>', env: 'ABB_RWS_DAEMON_RECORD_DIR', group: 'record',
    help: 'The recordings folder. Default: recordings beside the default token file.',
  },
  {
    flag: '--replay', value: '<file-or-folder>', env: 'ABB_RWS_DAEMON_REPLAY', group: 'replay',
    help: 'Serve a recording instead of reading controllers: one of its files, or the folder that holds it. '
      + 'Nothing is sent to a controller and no config file is read.',
  },
  {
    flag: '--replay-speed', value: '<x>', env: 'ABB_RWS_DAEMON_REPLAY_SPEED', group: 'replay',
    help: 'Playback speed, 0.1 to 50. Default: 1, as recorded.',
  },
  {
    flag: '--replay-loop', value: null, env: 'ABB_RWS_DAEMON_REPLAY_LOOP', group: 'replay',
    help: 'Start over when the recording ends. The variable takes 1 or 0.',
  },
  {
    flag: '--replay-parts', value: '<n>[-<m>]', env: 'ABB_RWS_DAEMON_REPLAY_PARTS', group: 'replay',
    help: 'Replay these parts of the recording only: 3, 2-4 or 3- (from part 3 on). Default: every part.',
  },
  {
    flag: '--replay-time', value: '<shifted|recorded>', env: null, group: 'replay',
    help: 'shifted (the default) moves every time by the same amount, so values are as old as they were in the '
      + 'recording; recorded serves the times as they were recorded.',
  },
  {
    flag: '--replay-paused', value: null, env: null, group: 'replay',
    help: 'Start paused; POST /v0/replay/control plays.',
  },
  {
    flag: '--replay-skip-bad', value: null, env: null, group: 'replay',
    help: 'Skip a line that cannot be read and the frames after it up to the next snapshot, instead of refusing '
      + 'the recording.',
  },
] satisfies FlagSpec[]);

/** The flags that print the help text. They are not options of the table: they take no value and start nothing. */
export const HELP_FLAGS: readonly string[] = Object.freeze(['--help', '-h']);
/** The flags that print the versions. */
export const VERSION_FLAGS: readonly string[] = Object.freeze(['--version', '-v']);

/** `--replay` picks the mode: it stands with the replay options in the help text and is not one of those that need it. */
const REPLAY_FLAG = '--replay';

/** The options that take a value. */
export function valueFlags(): Set<string> {
  return new Set(FLAGS.filter(f => f.value !== null).map(f => f.flag));
}

/** The options that are switches. */
export function switchFlags(): Set<string> {
  return new Set(FLAGS.filter(f => f.value === null).map(f => f.flag));
}

/**
 * The options of one group. For `record`: the recorder's options, which a
 * replaying daemon refuses. For `replay`: the options that need `--replay`,
 * so not `--replay` itself.
 */
export function flagsOf(group: FlagGroup): string[] {
  return FLAGS.filter(f => f.group === group && f.flag !== REPLAY_FLAG).map(f => f.flag);
}

/** What the command line holds, as parseArgv read it. */
export interface ParsedArgv {
  /**
   * The arguments as cli.ts looks options up in them: every
   * `--option=value` of an option that takes a value as two entries,
   * everything else as given. Whole also when there is a problem.
   */
  argv: string[];
  /** Why the daemon must not start with these arguments (the first reason, in command-line order), or null. */
  problem: string | null;
  /** One of HELP_FLAGS was given, wherever it stands. */
  help: boolean;
  /** One of VERSION_FLAGS was given, wherever it stands. */
  version: boolean;
}

/** A value that is none: absent, empty, or the next option. */
function isMissing(value: string | undefined): boolean {
  return value === undefined || value.trim() === '' || value.startsWith('--');
}

/**
 * Read the raw arguments (`process.argv.slice(2)`), once, left to right.
 * This is the only place that splits or judges an argument: nothing
 * misspelt, valueless, repeated or stray is passed over, because an option
 * someone typed must never silently do nothing.
 *
 * - An option that takes a value takes the next argument, or the text after
 *   its first `=`. A value that is absent, empty or starts with `--` is
 *   "needs a value" in both spellings; a value may start with a single `-`.
 * - A switch, a help flag or a version flag written with `=` "takes no value".
 * - Anything else that starts with `-` is an unknown option, named without
 *   what follows its `=`.
 * - An option may be given once, in either spelling.
 * - An argument that is neither an option nor an option's value is unexpected.
 */
export function parseArgv(raw: readonly string[]): ParsedArgv {
  const values = valueFlags();
  const switches = switchFlags();
  const info = (t: string): boolean => HELP_FLAGS.includes(t) || VERSION_FLAGS.includes(t);
  const argv: string[] = [];
  const seen = new Set<string>();
  let problem: string | null = null;
  const note = (p: string): void => { problem ??= p; };
  /** An option of the table was given: a second time is a problem. */
  const met = (flag: string): void => {
    if (seen.has(flag)) { note(`${flag} is given twice`); }
    seen.add(flag);
  };
  const unknown = (name: string): string => `unknown option ${name}; abb-rws-daemon --help lists the options`;

  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    const eq = token.startsWith('-') ? token.indexOf('=') : -1;
    if (eq > 0) {
      // --name=rest, looked up by --name.
      const name = token.slice(0, eq);
      const rest = token.slice(eq + 1);
      if (values.has(name)) {
        met(name);
        if (isMissing(rest)) { note(`${name} needs a value`); }
        argv.push(name, rest);
      } else if (switches.has(name) || info(name)) {
        if (switches.has(name)) { met(name); }
        note(`${name} takes no value`);
        argv.push(token);
      } else {
        note(unknown(name));
        argv.push(token);
      }
    } else if (values.has(token)) {
      met(token);
      argv.push(token);
      const next = raw[i + 1];
      if (isMissing(next)) {
        note(`${token} needs a value`);
        // An empty value is still this option's; the next option is judged on its own.
        if (next !== undefined && !next.startsWith('--')) { argv.push(next); i++; }
      } else {
        argv.push(next);
        i++;
      }
    } else if (switches.has(token)) {
      met(token);
      argv.push(token);
    } else if (info(token)) {
      argv.push(token);
    } else if (token.startsWith('-')) {
      note(unknown(token));
      argv.push(token);
    } else {
      note(`unexpected argument "${token}"; options start with --`);
      argv.push(token);
    }
  }

  return {
    argv,
    problem,
    help: raw.some(t => HELP_FLAGS.includes(t)),
    version: raw.some(t => VERSION_FLAGS.includes(t)),
  };
}

/** The help text is at most this wide. */
const HELP_WIDTH = 80;
/** Where the text of an option begins. */
const HELP_COLUMN = 28;

/** `text` in lines of at most `width` characters, broken at spaces. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(w => w.length > 0)) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length > 0 ? `${line} ${word}` : word;
    }
  }
  if (line.length > 0) { lines.push(line); }
  return lines;
}

/** A paragraph, every line indented by `indent`. */
function paragraph(text: string, indent = 0): string[] {
  const pad = ' '.repeat(indent);
  return wrap(text, HELP_WIDTH - indent).map(l => pad + l);
}

/** One entry of the help text: what is typed on the left, its text beside it, its environment variable in brackets. */
function entry(left: string, help: string, env: string | null): string[] {
  const text = wrap(help, HELP_WIDTH - HELP_COLUMN);
  if (env !== null) {
    const tag = `[${env}]`;
    const last = text.length - 1;
    if (last >= 0 && text[last].length + 2 + tag.length <= HELP_WIDTH - HELP_COLUMN) {
      text[last] = `${text[last]}  ${tag}`;
    } else {
      text.push(tag);
    }
  }
  const head = `  ${left}`;
  const pad = ' '.repeat(HELP_COLUMN);
  // An entry too long for its column stands alone, with its text below it.
  if (head.length + 2 > HELP_COLUMN) { return [head, ...text.map(l => pad + l)]; }
  return [head.padEnd(HELP_COLUMN) + (text[0] ?? ''), ...text.slice(1).map(l => pad + l)].map(l => l.trimEnd());
}

/** The entries of one group of the table. */
function entriesOf(group: FlagGroup): string[] {
  return FLAGS.filter(f => f.group === group)
    .flatMap(f => entry(f.value === null ? f.flag : `${f.flag} ${f.value}`, f.help, f.env));
}

/**
 * What `--help` prints, made from the table: at most 80 columns, no tab,
 * every option and every environment variable in it. Default paths are
 * written out for both platforms, never computed: a help text looks nothing up.
 */
export function helpText(version: string): string {
  return [
    `abb-rws-daemon ${version}`,
    '',
    'Reads ABB robot controllers over Robot Web Services (RobotWare 6, 7 and 8)',
    'and serves them as one typed snapshot over HTTP and WebSocket on',
    'http://127.0.0.1:<port>. Read-only: it changes nothing on a controller.',
    '',
    'Usage:',
    '  abb-rws-daemon [--config <file>] [--port <n>] [options]',
    '  abb-rws-daemon --replay <file-or-folder> [--port <n>] [replay options]',
    '  abb-rws-daemon --help | --version',
    '',
    'Options:',
    ...entriesOf('general'),
    ...entry(`${HELP_FLAGS[1]}, ${HELP_FLAGS[0]}`, 'Print this text and exit.', null),
    ...entry(`${VERSION_FLAGS[1]}, ${VERSION_FLAGS[0]}`,
      'Print the versions of the daemon, its snapshot schema, abb-rws-client and Node.js, and exit.', null),
    '',
    'Recording (live mode):',
    ...paragraph('A recording runs only when it is started: with --record, or with POST /v0/recording/start. '
      + 'No environment variable starts one.', 2),
    ...entriesOf('record'),
    '',
    'Replay:',
    ...paragraph('The options below --replay need it. A replaying daemon takes no recording option and no --config.', 2),
    ...entriesOf('replay'),
    '',
    'Environment only:',
    ...entry('ABB_RWS_DAEMON_LOG',
      'Log level: fatal, error, warn, info, debug, trace or silent. Default: info.', null),
    '',
    'An option on the command line wins over its environment variable. An',
    'empty variable counts as unset.',
    '',
    'Every request but GET /v0/health needs the access token in the',
    `${TOKEN_HEADER} header. The daemon names its token file when it starts.`,
    '',
    'Exit codes: 0 after --help, --version and a clean stop; 1 when the daemon',
    'did not start (the message says why) or a stop was cut short.',
    '',
  ].join('\n');
}

/**
 * What `--version` prints: the daemon's version, then the snapshot schema it
 * serves, the abb-rws-client it runs on and the Node.js that runs it.
 */
export function versionText(daemonVersion: string, client: string = clientVersion(), node: string = process.version): string {
  return `abb-rws-daemon ${daemonVersion}\nsnapshot schema ${SCHEMA_VERSION}, abb-rws-client ${client}, Node.js ${node}\n`;
}

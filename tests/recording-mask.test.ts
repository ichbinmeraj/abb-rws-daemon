import { describe, it, expect } from 'vitest';
import { MultiRobotManager, RobotManager, RwsError } from 'abb-rws-client';
import { isSecretKey } from '../src/errorMap.js';
import {
  CALL_RESULT_DROPPED_KEYS, MASK, RAPID_VALUE_READS, SECRET_ARGS, SERIAL_ARRAY_MAX, SecretValues, holdsSecret, isSecretMethod, isSecretRapidValue,
  maskCallArgs, maskFrame, maskJson, maskRapidSecrets, maskRecordValue, maskValuesEverywhere, toPlainJson, type Json,
} from '../src/recording/mask.js';
import { snapshotOf } from './helpers/recording-fakes.js';

const PASSWORD = 'Rob0t-Cell-Secret';
const USER = 'Default User';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** A class like the client's HTTP session: credentials and cookies as ordinary properties. */
class HttpSessionLike {
  password = PASSWORD;
  cookies = new Map([['-http-session-', 'abc123cookievalue']]);
  digestChallenge = { realm: 'x', nonce: 'y' };
}

describe('toPlainJson (the copy masking works on)', () => {
  it('copies plain data and writes everything else by its kind', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const out = toPlainJson({
      n: 1, s: 'x', b: true, nul: null, und: undefined, nan: NaN,
      d: new Date('2026-10-04T15:30:12.345Z'), m: new Map([['k', 1]]), set: new Set([1, 2]),
      f: () => 1, cyc, session: new HttpSessionLike(), big: 10n,
    });
    expect(out).toEqual({
      n: 1, s: 'x', b: true, nul: null, nan: null, d: '2026-10-04T15:30:12.345Z', m: { k: 1 }, set: [1, 2],
      f: '[function]', cyc: { a: 1, self: '[circular]' }, session: '[object HttpSessionLike]', big: '10',
    });
    expect(JSON.stringify(out)).not.toContain(PASSWORD);
    expect(JSON.stringify(out)).not.toContain('abc123cookievalue');
  });

  it('bounds arrays and depth', () => {
    const arr = toPlainJson(Array.from({ length: SERIAL_ARRAY_MAX + 5 }, (_, i) => i)) as Json[];
    expect(arr).toHaveLength(SERIAL_ARRAY_MAX + 1);
    expect(arr[SERIAL_ARRAY_MAX]).toEqual({ $truncated: 5 });
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 12; i++) { deep = { d: deep }; }
    expect(JSON.stringify(toPlainJson(deep))).toContain('[depth-limit]');
  });

  it('writes a client error as the daemon serves one, the controller answer masked', () => {
    const e = new RwsError(`login failed, Authorization: Basic ${b64(`${USER}:${PASSWORD}`)}`, 'AUTH_FAILED', 401, undefined, -1, 'Cookie: ABBCX=zzz');
    const out = toPlainJson({ cause: e }) as { cause: Record<string, unknown> };
    expect(out.cause.code).toBe('AUTH_FAILED');
    expect(out.cause.controller).toEqual({ httpStatus: 401, code: -1, message: 'Cookie: ***' });
    expect(JSON.stringify(out)).not.toContain(b64(`${USER}:${PASSWORD}`));
    expect(toPlainJson(new Error('plain'))).toEqual({ code: 'DAEMON_ERROR', message: 'plain' });
  });
});

describe('rule 1: secret keys', () => {
  it('masks a value under a secret key, keeps flags and nulls', () => {
    const secrets = new SecretValues();
    const { value, tally } = maskJson(toPlainJson({
      password: 'x', stationId: 'st-1', Cookie: 'a=b', pin: 1234, tokenRequired: true, apiKey: null, host: '127.0.0.1',
      nested: [{ newPassword: 'y' }],
    }), secrets, { frame: false });
    expect(value).toEqual({
      password: MASK, stationId: MASK, Cookie: MASK, pin: MASK, tokenRequired: true, apiKey: null, host: '127.0.0.1',
      nested: [{ newPassword: MASK }],
    });
    expect(tally.replaced).toBe(5);
  });

  it('feeds every value it masks in call arguments to the known values, with the user name beside it', () => {
    const secrets = new SecretValues();
    const { args } = maskCallArgs('addRobot', [{ id: 'rw7', host: '127.0.0.1', username: USER, password: PASSWORD }], secrets, 'rw7');
    expect(args).toEqual([{ id: 'rw7', host: '127.0.0.1', username: USER, password: MASK }]);
    expect(secrets.foundIn(`x ${PASSWORD} x`)).toBe(true);
    expect(secrets.foundIn(b64(`${USER}:${PASSWORD}`))).toBe(true);
    expect(secrets.foundIn(b64(PASSWORD))).toBe(true);
  });
});

describe('rule 2: secret arguments by position', () => {
  it('masks and learns a PIN and a connect password', () => {
    const secrets = new SecretValues();
    const pin = maskCallArgs('lockOperationMode', ['PinCode-7788', false], secrets, 'rw7');
    expect(pin.args).toEqual([MASK, false]);
    expect(secrets.foundIn('PinCode-7788')).toBe(true);
    const c = maskCallArgs('connect', ['127.0.0.1', USER, PASSWORD, 9403, true], secrets, 'rw7');
    expect(c.args).toEqual(['127.0.0.1', USER, MASK, 9403, true]);
    expect(secrets.foundIn(b64(`${USER}:${PASSWORD}`))).toBe(true);
  });

  it('masks the PIN of an operation-mode unlock (client 1.4.0)', () => {
    const secrets = new SecretValues();
    const r = maskCallArgs('unlockOperationMode', ['Unlock-Pin-4711'], secrets, 'rw7');
    expect(r.args).toEqual([MASK]);
    expect(secrets.foundIn('Unlock-Pin-4711')).toBe(true);
    expect(maskCallArgs('unlockOperationMode', [], secrets, 'rw7').args).toEqual([]);
  });

  it('records a method secret as a whole with arguments *** and still learns its secrets', () => {
    const secrets = new SecretValues();
    expect(isSecretMethod('setControlStation')).toBe(true);
    expect(maskCallArgs('setControlStation', [{ name: 'x', id: 'y' }], secrets).args).toBe(MASK);
    expect(maskCallArgs('changePassword', ['Old-Password-1', 'New-Password-2'], secrets).args).toBe(MASK);
    expect(secrets.foundIn('Old-Password-1')).toBe(true);
    expect(secrets.foundIn('New-Password-2')).toBe(true);
    expect(isSecretMethod('getJointTargetFull')).toBe(false);
  });
});

/** Every method name on a prototype chain (own and inherited, public and private), with its function. */
function methods(proto: object): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (let p: object | null = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (k === 'constructor' || out.has(k)) { continue; }
      const d = Object.getOwnPropertyDescriptor(p, k)!;
      if (typeof d.value === 'function') { out.set(k, d.value); }
    }
  }
  return out;
}

/** A method's parameter names, read from its compiled source (defaults and rest dots left out). */
function paramNames(fn: unknown): string[] {
  const src = Function.prototype.toString.call(fn);
  const open = src.indexOf('(');
  const parts: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\') { i++; } else if (ch === quote) { quote = null; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { parts.push(src.slice(start, i)); break; }
      continue;
    }
    if (ch === ',' && depth === 1) { parts.push(src.slice(start, i)); start = i + 1; }
  }
  return parts.map(p => p.trim().replace(/^\.\.\./, '').replace(/\s*=[\s\S]*$/, '').trim()).filter(p => p.length > 0);
}

const SECRET_PART = /^(sessions?|stations?|auth\w*)$/i;
const camelParts = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').split(/[-_]/);

describe('the client surface: no new method can slip through', () => {
  const surfaces = [['RobotManager', RobotManager.prototype], ['MultiRobotManager', MultiRobotManager.prototype]] as const;

  it.each(surfaces)('%s: every secret-shaped method name is on the deny-list', (_label, proto) => {
    const names = [...methods(proto).keys()];
    expect(names.length).toBeGreaterThan(10);
    const missing = names.filter(n => (isSecretKey(n) || camelParts(n).some(p => isSecretKey(p) || SECRET_PART.test(p))) && !isSecretMethod(n));
    expect(missing).toEqual([]);
  });

  it.each(surfaces)('%s: every secret-shaped parameter is in SECRET_ARGS', (_label, proto) => {
    const missing: string[] = [];
    let seen = 0;
    for (const [name, fn] of methods(proto)) {
      paramNames(fn).forEach((p, i) => {
        seen++;
        if (/^[{[]/.test(p) || !isSecretKey(p)) { return; }
        if (!(SECRET_ARGS[name] ?? []).includes(i)) { missing.push(`${name}(${p} at ${i})`); }
      });
    }
    expect(seen).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });

  it('the parameter reader reads the client the way it is compiled', () => {
    expect(paramNames(RobotManager.prototype.connect)).toEqual(['host', 'username', 'password', 'port', 'useHttps']);
    expect(paramNames(RobotManager.prototype.lockOperationMode)).toEqual(['pin', 'permanent']);
  });
});

describe('rule 3: credential-shaped text', () => {
  it('masks header lines, schemes, URL credentials and key=value pairs in any string', () => {
    const secrets = new SecretValues();
    const texts = {
      a: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      b: 'Cookie: -http-session-=abc123; ABBCX=def456',
      c: 'Set-Cookie: ABBCX=def456; path=/',
      d: 'Digest username="u", realm="r", response="0123456789abcdef"',
      e: 'https://user:Hunter2pass@127.0.0.1:9403/rw',
      f: 'retry with password=Hunter2pass now',
      g: 'Bearer abcdefgh1234567890',
    };
    const { value } = maskJson(toPlainJson(texts), secrets, { frame: false });
    const out = JSON.stringify(value);
    for (const s of ['dXNlcjpwYXNzd29yZA==', 'abc123', 'def456', '0123456789abcdef', 'Hunter2pass', 'abcdefgh1234567890']) {
      expect(out).not.toContain(s);
    }
  });

  it('drops a key the redaction would change, never renames it', () => {
    const secrets = new SecretValues();
    const { value, tally } = maskJson({ 'Authorization: Basic dXNlcjpwYXNzd29yZA==': 1, ok: 2 }, secrets, { frame: false });
    expect(value).toEqual({ ok: 2 });
    expect(tally.droppedKeys).toBe(1);
  });
});

describe('rule 3b: RAPID literals', () => {
  it('masks string literals assigned to secret-named identifiers, and nothing else', () => {
    const src = [
      'MODULE Cell',
      '  VAR string ftpPassword := "ftp-secret-01";',
      '  CONST string password{2} := ["first-secret", "second-secret"];',
      '  VAR string name := "Robot ""One""";',
      '  PERS num pin := 1234;',
      '  pwd := "late-secret" + "x";',
      'ENDMODULE',
    ].join('\n');
    const { text, masked } = maskRapidSecrets(src);
    expect(text).toContain('VAR string ftpPassword := "***";');
    expect(text).toContain('CONST string password{2} := ["***", "***"];');
    expect(text).toContain('VAR string name := "Robot ""One""";');
    expect(text).toContain('PERS num pin := 1234;');
    expect(text).toContain('pwd := "***" + "***";');
    expect(masked).toBe(5);
    for (const s of ['ftp-secret-01', 'first-secret', 'second-secret', 'late-secret']) { expect(text).not.toContain(s); }
  });

  it('a RAPID value read from a secret-named symbol is left out whole; other reads and other methods are not', () => {
    expect(RAPID_VALUE_READS).toEqual({ getRapidVariable: 2 });
    for (const symbol of ['ftpPassword', 'password', 'pwd', 'adminPin', 'apiKey']) {
      expect(isSecretRapidValue('getRapidVariable', ['T_ROB1', 'Cell', symbol]), symbol).toBe(true);
    }
    for (const symbol of ['partPresent', 'spin', 'reg1', 'tokenizer']) {
      expect(isSecretRapidValue('getRapidVariable', ['T_ROB1', 'Cell', symbol]), symbol).toBe(false);
    }
    expect(isSecretRapidValue('getModuleText', ['T_ROB1', 'password'])).toBe(false);   // a module's text: rule 3b
    expect(isSecretRapidValue('getRapidVariable', MASK)).toBe(false);
    expect(isSecretRapidValue('getRapidVariable', ['T_ROB1'])).toBe(false);
  });
});

describe('rule 4: known values', () => {
  it('classifies: strong values are masked by value, weak ones counted and warned about by controller only', () => {
    const warned: Array<string | undefined> = [];
    const secrets = new SecretValues({ commonText: () => 'Option list: RobotStudio Connect, Robotics', onWeak: c => warned.push(c) });
    expect(secrets.add(PASSWORD, { user: USER, controller: 'rw7' })).toBe(true);
    expect(secrets.add('short', { controller: 'rw6' })).toBe(false);
    expect(secrets.add('20261004', { controller: 'rw6' })).toBe(false);
    expect(secrets.add('Robotics', { controller: 'rw8' })).toBe(false);
    expect(secrets.counts().weakValues).toBe(3);
    expect(warned).toEqual(['rw6', 'rw6', 'rw8']);
    expect(secrets.counts().values).toBe(1);
    // Each encoded form is classified on its own: base64(password) and base64(user:password) (the
    // percent-encoding equals the password), and the base64 of each weak value, which is long and
    // unusual enough to mask by value.
    expect(secrets.counts().derived).toBe(5);
    expect(secrets.foundIn(b64('Robotics'))).toBe(true);
    expect(secrets.foundIn('Robotics')).toBe(false);
  });

  it('drops a secret-named key whose name holds a known value', () => {
    const secrets = new SecretValues();
    secrets.add(PASSWORD);
    const { value } = maskJson({ [`k-${PASSWORD}`]: 'v', [`password-${PASSWORD}`]: 'w', ok: 1 }, secrets, { frame: false });
    expect(value).toEqual({ ok: 1 });
  });

  it('adds the percent-encoded form when it differs', () => {
    const secrets = new SecretValues();
    secrets.add('p@ss word+x', { user: 'u' });
    expect(secrets.foundIn(encodeURIComponent('p@ss word+x'))).toBe(true);
    expect(secrets.counts().derived).toBe(3);
  });

  it('masks strong values anywhere outside frames, only as whole tokens in frames, and drops keys holding one', () => {
    const secrets = new SecretValues();
    secrets.add(PASSWORD, { user: USER });
    const rec = maskJson({ text: `x${PASSWORD}y`, [`k-${PASSWORD}`]: 1, other: b64(`${USER}:${PASSWORD}`) }, secrets, { frame: false });
    expect(rec.value).toEqual({ text: `x${MASK}y`, other: MASK });
    expect(rec.tally.droppedKeys).toBe(1);
    const fr = maskJson({ a: `x${PASSWORD}y`, b: `said ${PASSWORD}.` }, secrets, { frame: true });
    expect(fr.value).toEqual({ a: `x${PASSWORD}y`, b: `said ${MASK}.` });
  });

  it('never touches a number, and a weak value is not masked by value', () => {
    const secrets = new SecretValues();
    secrets.add('2026');
    const v = toPlainJson({ year: 2026, at: '2026-10-04T15:30:12.345Z', text: 'code 2026' });
    const before = JSON.stringify(v);
    expect(JSON.stringify(maskJson(v, secrets, { frame: false }).value)).toBe(before);
    expect(holdsSecret(v, secrets)).toBe(false);
  });
});

describe('rule 5: the final check', () => {
  it('looks at every string and key, never at numbers', () => {
    const secrets = new SecretValues();
    secrets.add('12345678-but-not-digits');
    expect(holdsSecret({ a: ['x 12345678-but-not-digits'] }, secrets)).toBe(true);
    expect(holdsSecret({ '12345678-but-not-digits': 1 }, secrets)).toBe(true);
    expect(holdsSecret({ n: 12345678 }, secrets)).toBe(false);
  });

  it('a record the check finds a value in is refused', () => {
    // A known value the earlier rules cannot remove: masking by value is switched off here.
    class Leaky extends SecretValues { override maskIn(text: string): { text: string; masked: number } { return { text, masked: 0 }; } }
    const secrets = new Leaky();
    secrets.add(PASSWORD);
    expect(maskRecordValue({ t: `x ${PASSWORD}` }, secrets).refused).toBe(true);
    expect(maskFrame(JSON.stringify({ type: 'delta', note: PASSWORD }), secrets).held).toBe(true);
  });
});

describe('frames', () => {
  it('a frame masking does not change is the observed string itself', () => {
    const secrets = new SecretValues();
    secrets.add(PASSWORD, { user: USER });
    secrets.add('2026');
    const text = JSON.stringify({ type: 'snapshot', schemaVersion: '0.13', observedAt: '2026-10-04T15:30:12.345Z', controllers: [snapshotOf('rw7', { sysId: 'abc' })] });
    const r = maskFrame(text, secrets);
    expect(r).toEqual({ text, masked: 0, droppedKeys: 0, held: false });
  });

  it('masks a known value in an event text and counts it; a value glued to other text is masked by the final check', () => {
    const secrets = new SecretValues();
    secrets.add(PASSWORD);
    const c = snapshotOf('rw7', { eventTitle: `Login with ${PASSWORD} refused`, eventDescription: `x${PASSWORD}x` });
    const text = JSON.stringify({ type: 'delta', observedAt: 'x', id: 'rw7', name: 'RW7', groups: { events: c.events } });
    const r = maskFrame(text, secrets);
    expect(r.held).toBe(false);
    expect(r.masked).toBeGreaterThanOrEqual(2);
    expect(r.text).not.toContain(PASSWORD);
    expect(r.text).toContain(`Login with ${MASK} refused`);
  });
});

/**
 * A holder of mastership or of write access is named, never identified: the
 * user id and the control-station id the client's status reads may carry are
 * not in the line a recording writes.
 */
describe('a holder`s ids: never in a recorded status', () => {
  const USER_ID = 'user-id-4471-of-the-holder';
  const STATION_ID = '{6F1C0E2A-8B3D-4E5F-9A7B-1C2D3E4F5A6B}';
  /** A `call` record as the recorder makes it, and the line it writes of it (JSON of the masked copy, `masked` last). */
  const written = (method: string, result: unknown, args: unknown[] = []) => {
    const rec = toPlainJson({ kind: 'call', t: 1200, target: 'manager', id: 'rw7', gen: 'rws2', seq: 7, method, args, ms: 12, ok: true, result });
    const m = maskRecordValue(rec, new SecretValues());
    const out = m.value as { [key: string]: Json };
    if (m.masked > 0) { out.masked = m.masked; }
    return { m, out, line: JSON.stringify(out) };
  };

  it('the user id of a mastership status is dropped from the written line; the record says it was masked', () => {
    const status = { mastership: 'remote', uid: USER_ID, application: 'RobotStudio' };
    const { m, out, line } = written('getMastershipStatus', status, ['rapid']);
    expect(line).not.toContain(USER_ID);
    expect(line).not.toContain('"uid"');
    expect(out.result).toEqual({ mastership: 'remote', application: 'RobotStudio' });
    expect(m).toMatchObject({ masked: 1, droppedKeys: 1, refused: false });
    expect(out).toMatchObject({ kind: 'call', method: 'getMastershipStatus', args: ['rapid'], ok: true, masked: 1 });
    // The client's own object is never touched: the drop is on the copy.
    expect(status).toEqual({ mastership: 'remote', uid: USER_ID, application: 'RobotStudio' });
  });

  it('the station id of a write-access status is masked by its key, in every spelling', () => {
    const { m, out, line } = written('getWriteAccessStatus', {
      held: true, heldByMe: false, heldByName: 'RobotStudio', heldById: STATION_ID, externalControlEnabled: true,
    });
    expect(line).not.toContain(STATION_ID);
    expect(line).not.toContain('6F1C0E2A');
    expect(out.result).toEqual({ held: true, heldByMe: false, heldByName: 'RobotStudio', heldById: MASK, externalControlEnabled: true });
    expect(m).toMatchObject({ masked: 1, droppedKeys: 0, refused: false });
    for (const key of ['heldById', 'held-by-id', 'held_by_id', 'HeldByID']) {
      const other = written('getWriteAccessStatus', { held: true, [key]: STATION_ID });
      expect(other.line, key).not.toContain(STATION_ID);
      expect(isSecretKey(key), key).toBe(true);
    }
    // In a text as well (an error message that quotes the answer).
    expect(written('getDiagnostics', { note: `status heldById=${STATION_ID} heldByName=RobotStudio` }).line).not.toContain(STATION_ID);
    // The holder's name and the other fields are no ids: kept.
    for (const key of ['heldByName', 'heldByMe', 'held', 'heldByDaemon']) { expect(isSecretKey(key), key).toBe(false); }
  });

  it('a `uid` key in the result of any other method is left alone, and so is one outside a call`s result', () => {
    const other = written('getSystemInfo', { uid: USER_ID, name: 'x' });
    expect(other.out.result).toEqual({ uid: USER_ID, name: 'x' });
    expect(other.m).toMatchObject({ masked: 0, droppedKeys: 0 });
    expect(other.out).not.toHaveProperty('masked');
    expect(other.line).toContain(USER_ID);
    // The rule is for a call record: another kind of record with the same members is not one.
    const state = maskRecordValue({ kind: 'state', t: 1, id: 'rw7', method: 'getMastershipStatus', result: { uid: USER_ID } }, new SecretValues());
    expect(JSON.stringify(state.value)).toContain(USER_ID);
    expect(state.masked).toBe(0);
  });

  it('a mastership status without a result object, or without the key, is written as it is', () => {
    expect(written('getMastershipStatus', null).out).toMatchObject({ result: null });
    expect(written('getMastershipStatus', null).m.masked).toBe(0);
    expect(written('getMastershipStatus', ['uid', USER_ID]).out.result).toEqual(['uid', USER_ID]);
    expect(written('getMastershipStatus', { mastership: 'nomaster' }).m.masked).toBe(0);
    // A method named like something every object has is not in the table.
    for (const method of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(written(method, { uid: USER_ID }).out.result, method).toEqual({ uid: USER_ID });
    }
  });

  it('the table names the mastership status and its user id, nothing else', () => {
    expect(CALL_RESULT_DROPPED_KEYS).toEqual({ getMastershipStatus: ['uid'] });
    expect(Object.isFrozen(CALL_RESULT_DROPPED_KEYS)).toBe(true);
    // Neither status read is secret as a whole: the call and what it said are recorded.
    for (const method of ['getMastershipStatus', 'getWriteAccessStatus', 'getRmmpPrivilege']) { expect(isSecretMethod(method), method).toBe(false); }
  });
});

describe('never on the source', () => {
  it('leaves every object it is given exactly as it was', () => {
    const secrets = new SecretValues();
    const config = { id: 'rw7', username: USER, password: PASSWORD, nested: { token: 'a'.repeat(40), list: [new Date(0)] } };
    const rapid = { text: 'VAR string ftpPassword := "ftp-secret-01";' };
    const state = { ioSignals: [{ name: 'doX', value: PASSWORD }], cookies: new Map([['ABBCX', 'v']]) };
    const before = structuredClone({ config, rapid, state });
    maskCallArgs('addRobot', [config], secrets, 'rw7');
    maskRecordValue(toPlainJson(rapid), secrets);
    maskRecordValue(toPlainJson(state), secrets);
    maskValuesEverywhere(toPlainJson(state), secrets);
    expect({ config, rapid, state }).toEqual(before);
  });
});

describe('an operation-mode PIN in a recorded request body or URL', () => {
  // The client's lock and unlock send the PIN in the body of
  // POST /rw/panel/opmode/lock and /unlock: form-encoded on RWS 1.0, as fields
  // on RWS 2.0. A PIN is short and all digits (weak), so it is never masked by
  // value: the rules by key and by shape must catch it wherever it is written.
  const bodies = [
    'POST /rw/panel/opmode/unlock pin=4711',
    'POST /rw/panel/opmode/lock body pin=4711&permanent=0',
    'POST /rw/panel/opmode/unlock?pin=4711 failed',
    'request body {"pin": "4711", "permanent": "0"}',
    'pincode=4711',
    '{"pincode":4711}',
  ];

  it.each(bodies)('a call record does not keep the PIN: %s', (body) => {
    const secrets = new SecretValues();
    const args = maskCallArgs('unlockOperationMode', ['4711'], secrets, 'rw7');
    expect(args.args).toEqual([MASK]);
    const e = new RwsError(`unlock failed: ${body}`, 'UNKNOWN', 400, body, -1, body, undefined, body);
    const record = toPlainJson({ kind: 'call', method: 'unlockOperationMode', args: args.args, error: e, detail: body, url: body });
    const out = maskRecordValue(record, secrets);
    expect(out.refused).toBe(false);
    expect(JSON.stringify(out.value)).not.toContain('4711');
  });

  it('a stream frame does not keep the PIN either', () => {
    const secrets = new SecretValues();
    const frame = JSON.stringify({ type: 'delta', note: 'POST /rw/panel/opmode/unlock pin=4711', body: { pin: '4711', pincode: 4711 } });
    expect(maskFrame(frame, secrets).text).not.toContain('4711');
  });
});

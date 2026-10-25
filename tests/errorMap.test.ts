import { describe, it, expect } from 'vitest';
import { RwsError, type RwsErrorCode } from 'abb-rws-client';
import { httpStatusFor, errorBody, groupError, isSecretKey, redactSecrets } from '../src/errorMap.js';
import { CONTROLLER_MESSAGE_MAX } from '../src/schema/v0.js';

const PASSWORD = 'hunter2-not-robotics';
/** base64("Default User:hunter2-not-robotics"), as a Basic authorization would carry it. */
const BASIC = Buffer.from(`Default User:${PASSWORD}`).toString('base64');
const STATION = '{6F1C0E2A-8B3D-4E5F-9A7B-1C2D3E4F5A6B}';

/** A controller refusal as the client raises it: status, raw body, controller code and message. */
const refused = (over: Partial<{ message: string; msg: string; body: string }> = {}) => new RwsError(
  over.message ?? 'Write access is held by another control station: 403 - release it there, then retry',
  'MASTERSHIP_REQUIRED', 403, over.body ?? '{"status":{"code":-1073435870,"msg":"held"}}', -1073435870,
  over.msg ?? 'Write access held by another control station',
);

/** Every RwsErrorCode as of client 1.3.1. A union has no runtime form, so it is listed. */
const ALL_CODES: RwsErrorCode[] = [
  'SESSION_EXPIRED', 'AUTH_FAILED', 'MOTORS_OFF', 'MODULE_NOT_FOUND', 'RESOURCE_NOT_FOUND',
  'MASTERSHIP_REQUIRED', 'GRANT_DENIED', 'WRONG_MODE', 'UNSUPPORTED_OPERATION',
  'INVALID_ARGUMENT', 'NOT_CONNECTED', 'RATE_LIMITED', 'CONTROLLER_BUSY', 'NETWORK_ERROR',
  'PARSE_ERROR', 'PROTOCOL_DETECT_FAILED', 'UNKNOWN',
];

describe('httpStatusFor', () => {
  it('keeps the six statuses the panel gateway already serves', () => {
    expect(httpStatusFor('GRANT_DENIED')).toBe(403);
    expect(httpStatusFor('MASTERSHIP_REQUIRED')).toBe(409);
    expect(httpStatusFor('WRONG_MODE')).toBe(409);
    expect(httpStatusFor('MOTORS_OFF')).toBe(409);
    expect(httpStatusFor('RESOURCE_NOT_FOUND')).toBe(404);
    expect(httpStatusFor('MODULE_NOT_FOUND')).toBe(404);
  });

  it('tells a caller not to retry a request that can never succeed', () => {
    expect(httpStatusFor('INVALID_ARGUMENT')).toBe(400);
    expect(httpStatusFor('UNSUPPORTED_OPERATION')).toBe(501);
  });

  it('marks transient controller states as retryable (503)', () => {
    for (const c of ['SESSION_EXPIRED', 'NOT_CONNECTED', 'RATE_LIMITED', 'CONTROLLER_BUSY'] as const) {
      expect(httpStatusFor(c), c).toBe(503);
    }
  });

  it('separates an unreachable controller (504) from an unusable answer (502)', () => {
    expect(httpStatusFor('NETWORK_ERROR')).toBe(504);
    for (const c of ['PARSE_ERROR', 'PROTOCOL_DETECT_FAILED', 'UNKNOWN'] as const) {
      expect(httpStatusFor(c), c).toBe(502);
    }
  });

  it('never answers 401 for the daemon\'s own failed login to the controller', () => {
    expect(httpStatusFor('AUTH_FAILED')).toBe(502);
  });

  it('maps every code to a 4xx or 5xx, and never to 500 (reserved for daemon bugs)', () => {
    for (const code of ALL_CODES) {
      const s = httpStatusFor(code);
      expect(s, code).toBeGreaterThanOrEqual(400);
      expect(s, code).toBeLessThan(600);
      expect(s, code).not.toBe(500);
    }
  });
});

describe('errorBody', () => {
  it('carries the client code through for a controller failure', () => {
    expect(errorBody(new RwsError('motors are off', 'MOTORS_OFF')))
      .toEqual({ error: 'motors are off', code: 'MOTORS_OFF' });
  });

  it('labels anything else as the daemon\'s own error', () => {
    expect(errorBody(new Error('boom'))).toEqual({ error: 'boom', code: 'DAEMON_ERROR' });
    expect(errorBody('plain')).toEqual({ error: 'plain', code: 'DAEMON_ERROR' });
  });

  it('keeps what the controller answered: its HTTP status, code and message', () => {
    expect(errorBody(refused())).toEqual({
      error: 'Write access is held by another control station: 403 - release it there, then retry',
      code: 'MASTERSHIP_REQUIRED',
      controller: { httpStatus: 403, code: -1073435870, message: 'Write access held by another control station' },
    });
  });

  it('never serves the raw response body the client kept', () => {
    const body = JSON.stringify(errorBody(refused({ body: '<html>raw controller page</html>' })));
    expect(body).not.toContain('raw controller page');
  });

  it('carries the status alone when the controller sent no error body, and nothing when it never answered', () => {
    expect(errorBody(new RwsError('Controller busy (503) - retry later', 'CONTROLLER_BUSY', 503)).controller)
      .toEqual({ httpStatus: 503, code: null, message: null });
    const unreached = errorBody(new RwsError('Network error: connect ECONNREFUSED', 'NETWORK_ERROR'));
    expect(unreached).toEqual({ error: 'Network error: connect ECONNREFUSED', code: 'NETWORK_ERROR' });
    expect('controller' in unreached).toBe(false);
  });

  it('drops values that are not a status, a code or a message', () => {
    const odd = new RwsError('odd', 'UNKNOWN', 42, undefined, 1.5, '   ');
    expect(errorBody(odd)).toEqual({ error: 'odd', code: 'UNKNOWN' });
    const half = new RwsError('half', 'UNKNOWN', Number.NaN, undefined, -1073445862);
    expect(errorBody(half).controller).toEqual({ httpStatus: null, code: -1073445862, message: null });
  });

  it('serves the controller message on one line, capped', () => {
    const multi = errorBody(refused({ msg: 'Operation\r\n\tnot allowed\u0000 now' }));
    expect(multi.controller!.message).toBe('Operation not allowed now');
    const long = errorBody(refused({ msg: 'x'.repeat(CONTROLLER_MESSAGE_MAX * 3) })).controller!.message!;
    expect(long).toHaveLength(CONTROLLER_MESSAGE_MAX);
    expect(long.endsWith('...')).toBe(true);
  });

  it('masks credentials and headers in the message and the controller message', () => {
    const e = refused({
      message: `RWS2 POST https://admin:${PASSWORD}@10.0.0.5/users?password=${PASSWORD} failed`,
      msg: `Authorization: Basic ${BASIC}\r\nCookie: -http-session-=abc123; ABBCX=42\r\npincode=1234`,
    });
    const b = errorBody(e);
    const served = JSON.stringify(b);
    for (const secret of [PASSWORD, BASIC, 'abc123', '1234']) { expect(served).not.toContain(secret); }
    expect(b.error).toBe('RWS2 POST https://***@10.0.0.5/users?password=*** failed');
    expect(b.controller!.message).toBe('Authorization: *** Cookie: *** pincode=***');
    expect(b.controller!.code).toBe(-1073435870);
  });

  it('passes the client`s structured refusal on, when the client gives one', () => {
    const e = Object.assign(refused(), {
      refusal: {
        kind: 'held-by-other', generation: 'rw8', missing: 'write access', grantor: 'current-holder',
        fix: 'Release write access in RobotStudio, then retry.',
        grants: [{ id: 'UAS_RAPID_EXECUTE', label: 'Execute program' }],
        holder: { kind: 'remote', name: 'RobotStudio', id: STATION },
        controller: { http: 403, code: -1073435870, hex: '0xC004AB22', message: 'held' },
        evidence: 'vc',
      },
    });
    expect(errorBody(e).refusal).toEqual({
      kind: 'held-by-other', generation: 'rw8', missing: 'write access', grantor: 'current-holder',
      fix: 'Release write access in RobotStudio, then retry.',
      grants: [{ id: 'UAS_RAPID_EXECUTE', label: 'Execute program' }],
      holder: { kind: 'remote', name: 'RobotStudio' },
      controller: { http: 403, code: -1073435870, hex: '0xC004AB22', message: 'held' },
      evidence: 'vc',
    });
  });

  it('never passes on a station id, a secret, headers or anything that is not plain data from a refusal', () => {
    const e = Object.assign(refused(), {
      refusal: {
        kind: 'not-registered', stationId: STATION, 'control-station-id': STATION, pincode: '1234',
        password: PASSWORD, newPassword: PASSWORD, sessionToken: PASSWORD, apiKey: PASSWORD, spinCount: 3,
        headers: { authorization: `Basic ${BASIC}` }, request: { path: '/x' },
        fix: `Register again (control-station-id=${STATION}, Authorization: Basic ${BASIC})`,
        callback: () => PASSWORD, big: 10n, sym: Symbol('x'), missing: undefined, nan: Number.NaN,
        deep: { a: { b: { c: { d: PASSWORD } } } },
      },
    });
    const r = errorBody(e).refusal!;
    const served = JSON.stringify(r);
    for (const secret of [STATION, PASSWORD, BASIC, '1234', '/x']) { expect(served).not.toContain(secret); }
    expect(r).toEqual({
      kind: 'not-registered',
      spinCount: 3,
      fix: 'Register again (control-station-id=***, Authorization: ***',
      deep: { a: { b: {} } },
    });
  });

  it('never passes on the id of the station that holds write access, under any spelling of its key', () => {
    const e = Object.assign(refused({ message: `Write access is held (heldById=${STATION}, heldByName=RobotStudio)` }), {
      refusal: {
        kind: 'held-by-other', heldByName: 'RobotStudio', heldByMe: false,
        heldById: STATION, 'held-by-id': STATION, held_by_id: STATION, status: { heldById: STATION, held: true },
        fix: `Ask the holder ("heldById": "${STATION}") to release write access.`,
      },
    });
    const b = errorBody(e);
    expect(JSON.stringify(b)).not.toContain(STATION);
    expect(b.error).toBe('Write access is held (heldById=***, heldByName=RobotStudio)');
    expect(b.refusal).toEqual({
      kind: 'held-by-other', heldByName: 'RobotStudio', heldByMe: false, status: { held: true },
      fix: 'Ask the holder ("heldById": "***") to release write access.',
    });
  });

  it('works on a client without refusals, and on a refusal that cannot be read', () => {
    expect('refusal' in errorBody(refused())).toBe(false);
    expect('refusal' in errorBody(Object.assign(refused(), { refusal: 'held' }))).toBe(false);
    expect('refusal' in errorBody(Object.assign(refused(), { refusal: {} }))).toBe(false);
    const throwing = refused();
    Object.defineProperty(throwing, 'refusal', { get() { throw new Error('boom'); } });
    expect(errorBody(throwing)).toMatchObject({ code: 'MASTERSHIP_REQUIRED', controller: { httpStatus: 403 } });
  });
});

describe('groupError', () => {
  it('is the error body as a group carries it: message instead of error', () => {
    expect(groupError(refused())).toEqual({
      code: 'MASTERSHIP_REQUIRED',
      message: 'Write access is held by another control station: 403 - release it there, then retry',
      controller: { httpStatus: 403, code: -1073435870, message: 'Write access held by another control station' },
    });
    expect(groupError(new RwsError('controller busy', 'CONTROLLER_BUSY'))).toEqual({ code: 'CONTROLLER_BUSY', message: 'controller busy' });
    expect(groupError(new Error('boom'))).toEqual({ code: 'DAEMON_ERROR', message: 'boom' });
  });
});

describe('isSecretKey', () => {
  it('names the id of a write-access holder, in camel case, with hyphens and with underscores', () => {
    for (const key of ['heldById', 'HeldById', 'heldByID', 'held-by-id', 'held_by_id', 'heldbyid', 'writeAccessHeldById', 'rmmp-held-by-id']) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('keeps what names a holder or says whether a lock is held', () => {
    for (const key of ['held', 'heldBy', 'heldByName', 'heldByMe', 'heldByDaemon', 'holder', 'upheldById', 'heldByIdentity', 'uid', 'id']) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it('still names a control-station id, a credential and a session cookie', () => {
    for (const key of ['stationId', 'control-station-id', 'password', 'newPassword', 'pincode', 'sessionToken', 'api-key', 'ABBCX', '-http-session-']) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ['spin', 'tokenizer', 'station', 'name']) { expect(isSecretKey(key), key).toBe(false); }
  });
});

describe('redactSecrets', () => {
  it('leaves ordinary controller text exactly as it was', () => {
    for (const text of [
      'Write access is held by another control station: 403 - release it there (RobotStudio: Release Write Access)',
      'Digest qop "auth-int" is not supported - only qop=auth',
      'Unsupported auth scheme: "Digest realm="validusers@robapi.abb", nonce="MTc1", qop="auth""',
      'RWS 2.0 answers with Basic authentication',
      'RWS2 POST /rw/rapid/execution/start?mastership=implicit: HTTP 400 (spin=3, execmode=stepin)',
      'Module not found: 404 - it is not loaded on the controller',
      'https://10.0.0.5:443/rw/panel/ctrl-state',
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  it('masks credentials in headers, auth schemes, URLs and secret-named fields', () => {
    expect(redactSecrets(`Authorization: Basic ${BASIC}`)).toBe('Authorization: ***');
    expect(redactSecrets(`sent Basic ${BASIC} to the controller`)).toBe('sent Basic *** to the controller');
    expect(redactSecrets('Digest username="Default User", realm="x", response="9f86d0"')).toBe('Digest ***');
    expect(redactSecrets('set-cookie: ABBCX=42; path=/')).toBe('set-cookie: ***');
    expect(redactSecrets('-http-session-=abc; ABBCX=42')).toBe('-http-session-=***; ABBCX=***');
    expect(redactSecrets(`http://Default:${PASSWORD}@host/`)).toBe('http://***@host/');
    expect(redactSecrets(`old-password=${PASSWORD}&new-password=x&name=ok`)).toBe('old-password=***&new-password=***&name=ok');
    expect(redactSecrets(`{"password": "${PASSWORD}", "user": "ok", "pin": 1234}`)).toBe('{"password": "***", "user": "ok", "pin": "***"}');
  });
});

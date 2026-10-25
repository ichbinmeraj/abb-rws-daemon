import { RwsError, type RwsErrorCode } from 'abb-rws-client';
import {
  CONTROLLER_MESSAGE_MAX,
  type ControllerAnswer, type ErrorBody, type GroupError, type RefusalDetails,
} from './schema/v0.js';

/**
 * HTTP status for a controller-level failure, from the client's error taxonomy.
 *
 * Every status here describes the CONTROLLER or the request, never the daemon:
 * 500 is reserved for the daemon's own bugs, so a consumer seeing 500 knows to
 * file an issue rather than retry.
 */
export function httpStatusFor(code: RwsErrorCode): number {
  switch (code) {
    // Carried over from the panel gateway's statusForCode.
    case 'GRANT_DENIED':        return 403;   // needs RMMP / UAS grant
    case 'MASTERSHIP_REQUIRED':
    case 'WRONG_MODE':
    case 'MOTORS_OFF':          return 409;   // controller-state conflict
    case 'RESOURCE_NOT_FOUND':
    case 'MODULE_NOT_FOUND':    return 404;

    // The request itself can never succeed - do not retry.
    case 'INVALID_ARGUMENT':    return 400;   // bad value; nothing was sent to the controller
    case 'UNSUPPORTED_OPERATION': return 501; // this controller generation has no such operation

    // Transient - the same request may succeed shortly.
    case 'SESSION_EXPIRED':                   // the daemon re-logs-in by itself
    case 'NOT_CONNECTED':                     // the daemon is (re)connecting
    case 'RATE_LIMITED':                      // the shared controller budget, not the caller's
    case 'CONTROLLER_BUSY':     return 503;

    // The controller could not be reached at all.
    case 'NETWORK_ERROR':       return 504;

    // The controller was reached but its answer was unusable, or it refused the
    // DAEMON's credentials. Never 401: the caller did not fail to authenticate,
    // and a 401 would send a panel back to its own login screen for nothing.
    case 'AUTH_FAILED':
    case 'PARSE_ERROR':
    case 'PROTOCOL_DETECT_FAILED':
    case 'UNKNOWN':             return 502;
  }
  // No `default`: a code added to RwsErrorCode fails the build above until it is
  // given a status here, instead of silently becoming a 502.
  const unhandled: never = code;
  return unhandled;
}

/**
 * A key that names a secret: a password, PIN, token, credential, cookie or an
 * authorization header, alone or as one part of a hyphenated, underscored or
 * camelCase name (`new-password`, `pincode`, `set-cookie`, `sessionToken`).
 * Anchored at the part's ends, so a word that merely contains one (`spin`,
 * `tokenizer`) is not matched.
 */
const SECRET_KEY = /(^|[-_])(pin|pincode|passcode|password|passwd|pwd|secret|token|credentials?|api-?key|cookie|authorization)([-_]|$)/i;

/** The session cookies the controllers set (RWS 1.0 and 2.0). */
const SESSION_COOKIE = /^(-?http-session-?|abbcx)$/i;

/** A control-station id is compared, never shown (`control-station-id`, `stationId`). */
const STATION_ID_KEY = /station[-_]?id$/i;

/** The id of the control station that holds write access: a holder is named, never identified (`heldById`, `held-by-id`, `held_by_id`). */
const HOLDER_ID_KEY = /(^|[-_])held[-_]?by[-_]?id$/i;

/** A key whose value is never served (nor recorded). */
export function isSecretKey(key: string): boolean {
  const parts = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2');   // newPassword -> new-Password
  return SECRET_KEY.test(parts) || SESSION_COOKIE.test(key) || STATION_ID_KEY.test(parts) || HOLDER_ID_KEY.test(parts);
}

/** A mixed token that looks like encoded credentials, not a word ("Basic auth"). */
const looksEncoded = (t: string) => /[0-9+/=]/.test(t) || (/[A-Z]/.test(t.slice(1)) && /[a-z]/.test(t));

/**
 * Mask anything credential-like in a text that is about to be served: header
 * lines that carry credentials or cookies, the credentials of a Basic, Bearer
 * or client Digest authorization, a password in a URL, and the value of any
 * `key=value` or `"key": value` pair whose key names a secret, a session
 * cookie or a control-station id. Everything else is left exactly as it was.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)(\s*:\s*)[^\r\n]*/gi, '$1$2***')
    .replace(/\b(Basic|Bearer)(\s+)([A-Za-z0-9+/._~-]{8,}=*)/g,
      (whole, scheme: string, gap: string, token: string) => (looksEncoded(token) ? `${scheme}${gap}***` : whole))
    // A client's Digest answer names the user and the response hash; the
    // controller's challenge (realm, nonce) carries neither and is kept.
    .replace(/\bDigest\s+[^\r\n]*\b(?:username|response)\s*=[^\r\n]*/gi, 'Digest ***')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, '$1***@')
    .replace(/"([^"\s]{1,64})"(\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,}\]]*)/g,
      (whole, key: string, sep: string) => (isSecretKey(key) ? `"${key}"${sep}"***"` : whole))
    .replace(/([A-Za-z0-9_.-]{1,64})=("[^"]*"|'[^']*'|\{[^}\s]*\}|[^\s&;,"'})\]]*)/g,
      (whole, key: string) => (isSecretKey(key) ? `${key}=***` : whole));
}

/** Controller text as served: credentials masked, on one line, at most `max` characters. */
function servedText(text: string, max: number): string {
  const one = redactSecrets(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

/**
 * What the controller answered, from the client's error: its HTTP status, and
 * the code and message of its error body. Null when the error carries none of
 * them (the controller was never reached, or the failure is the client's own).
 */
export function controllerAnswerOf(e: RwsError): ControllerAnswer | null {
  const status = e.httpStatus;
  const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const code = typeof e.controllerCode === 'number' && Number.isSafeInteger(e.controllerCode) ? e.controllerCode : null;
  const raw = typeof e.controllerMsg === 'string' ? servedText(e.controllerMsg, CONTROLLER_MESSAGE_MAX) : '';
  const message = raw.length > 0 ? raw : null;
  if (httpStatus === null && code === null && message === null) { return null; }
  return { httpStatus, code, message };
}

/** Keys never passed on from a refusal besides the secret ones: transport objects and raw headers. */
const TRANSPORT_KEY = /^(raw-?headers|headers|req|request|res|response|socket|agent)$/i;

const REFUSAL_DEPTH = 4;
const REFUSAL_ITEMS = 32;
const REFUSAL_TEXT_MAX = 1_000;

/** A refusal's value as plain, bounded JSON data with nothing secret in it; undefined drops it. */
function refusalValue(v: unknown, depth: number, parent: string | null): unknown {
  if (v === null) { return null; }
  switch (typeof v) {
    case 'string': return servedText(v, REFUSAL_TEXT_MAX);
    case 'number': return Number.isFinite(v) ? v : undefined;
    case 'boolean': return v;
    case 'object': {
      if (depth >= REFUSAL_DEPTH) { return undefined; }
      if (Array.isArray(v)) {
        return v.slice(0, REFUSAL_ITEMS).map(x => refusalValue(x, depth + 1, parent)).filter(x => x !== undefined);
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v).slice(0, REFUSAL_ITEMS)) {
        if (isSecretKey(k) || TRANSPORT_KEY.test(k)) { continue; }
        // The holder of write access is named, never identified by its id.
        if (parent === 'holder' && k === 'id') { continue; }
        const c = refusalValue(x, depth + 1, k);
        if (c !== undefined) { out[k] = c; }
      }
      return out;
    }
    default: return undefined;   // functions, symbols, bigints, undefined
  }
}

/**
 * The client's structured refusal (`RwsError.refusal`), where the client
 * gives one - looked up at run time, so a client release without it simply
 * yields null. Passed on as plain data, minus control-station ids and
 * anything credential-like.
 */
export function refusalOf(e: RwsError): RefusalDetails | null {
  try {
    const raw: unknown = (e as { refusal?: unknown }).refusal;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
    const clean = refusalValue(raw, 0, null);
    return clean && typeof clean === 'object' && Object.keys(clean).length > 0 ? clean as RefusalDetails : null;
  } catch {
    return null;   // a getter that throws is no reason to lose the error itself
  }
}

/**
 * The JSON body for a failed request: the message, the machine-readable code
 * and - for a controller failure - what the controller answered and the
 * client's account of a refusal, when there are any. Nothing credential-like
 * is served, from the message either.
 */
export function errorBody(e: unknown): ErrorBody & { code: RwsErrorCode | 'DAEMON_ERROR' } {
  if (e instanceof RwsError) {
    const controller = controllerAnswerOf(e);
    const refusal = refusalOf(e);
    return {
      error: redactSecrets(e.message),
      code: e.code,
      ...(controller ? { controller } : {}),
      ...(refusal ? { refusal } : {}),
    };
  }
  return { error: redactSecrets(e instanceof Error ? e.message : String(e)), code: 'DAEMON_ERROR' };
}

/** The same failure as it rides inside a snapshot group (a motion unit's, a watched signal's). */
export function groupError(e: unknown): GroupError {
  const { error, code, controller, refusal } = errorBody(e);
  return {
    code,
    message: error,
    ...(controller ? { controller } : {}),
    ...(refusal ? { refusal } : {}),
  };
}

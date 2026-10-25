/**
 * The daemon binds 127.0.0.1, and a browser can punch through loopback two
 * ways (what keeps other accounts on the same PC out is the access token,
 * token.ts):
 *   - DNS rebinding: a remote page whose DNS flips to 127.0.0.1 makes the
 *     victim's browser hit the daemon as "same-origin". The Host header still
 *     carries the attacker's name, so non-local Host values are rejected.
 *   - Cross-origin requests and WebSocket hijacking: WS handshakes ignore CORS,
 *     so any page can open ws://127.0.0.1/v0/stream, and a "simple" request is
 *     sent whatever CORS later hides. The Origin header names the page, so only
 *     the daemon's own origin and the panel's are accepted, scheme, host and
 *     port exactly: a page on another loopback port (another dev server, a
 *     notebook, a local admin UI) is as foreign as a remote one.
 * Native consumers (the ROS 2 bridge, curl, the MCP server) send no Origin and
 * a host they control, so they are unaffected.
 *
 * The Host check is extracted unchanged from the abb-rws-panel gateway. A
 * consumer that reaches the loopback port under another name (a container,
 * through the name its runtime gives the host) is refused by it; the daemon
 * can be told to accept such names too, each one in full (hostAllowlist).
 * Nothing else widens with that: not the bind, not the Origin rule, not the
 * token.
 */

import { isIP } from 'node:net';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/** The most extra host names a daemon accepts in the Host header (hostAllowlist). */
const ALLOWED_HOSTS_MAX = 8;
/** The longest DNS host name, in characters. */
const HOST_NAME_MAX = 253;
/** A DNS label: letters and digits, hyphens only inside, 1 to 63 characters. */
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** A last label that reads as a number: all digits, or `0x` followed by hexadecimal digits or by nothing. */
const NUMBER_LABEL = /^(?:[0-9]+|0x[0-9a-f]*)$/;

/** Where the panel is served from unless configured otherwise: its dev server, under either loopback name. */
export const DEFAULT_PANEL_ORIGINS: readonly string[] = ['http://127.0.0.1:5173', 'http://localhost:5173'];

/** Extract the hostname from a Host authority, stripping port and brackets. */
function hostnameOf(value: string): string {
  let v = value.trim();
  // Strip a scheme (a Host header should carry none)
  v = v.replace(/^[a-z]+:\/\//i, '');
  // IPv6 in brackets: [::1]:8080
  const bracket = v.match(/^\[([^\]]+)\]/);
  if (bracket) { return bracket[1].toLowerCase(); }
  // Bare IPv6 literal (no brackets, no port) - more than one colon
  if ((v.match(/:/g)?.length ?? 0) > 1) { return v.toLowerCase(); }
  return v.split(':')[0].toLowerCase();
}

/** True when a Host header names a loopback address. Empty/absent Host is rejected. */
export function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) { return false; }
  return LOCAL_HOSTNAMES.has(hostnameOf(host));
}

/** One entry of the extra host names, checked: the name in lower case, or a throw that says what is wrong with it. */
function allowedHostEntry(raw: string): string {
  if (typeof raw !== 'string') { throw new Error('an allowed host is not text: name a DNS host name'); }
  const name = raw.trim();
  const lower = name.toLowerCase();
  // What a message quotes of the entry: its start, and nothing a terminal or a log would act on.
  const shown = (name.length > 80 ? `${name.slice(0, 80)}...` : name).replace(/[^\x20-\x7e]/g, '?');
  if (name === '') { throw new Error('an allowed host is empty: name a DNS host name, such as host.docker.internal'); }
  if (name.includes('://')) { throw new Error(`allowed host "${shown}" carries a scheme: name the host alone`); }
  if (name.includes('/') || name.includes('\\')) { throw new Error(`allowed host "${shown}" carries a path: name the host alone`); }
  if (name.includes('*')) { throw new Error(`allowed host "${shown}" is a wildcard: name every host in full`); }
  // An address may come in brackets, as a URL writes IPv6.
  const bare = /^\[[^\]]*\]$/.test(lower) ? lower.slice(1, -1) : lower;
  if (LOCAL_HOSTNAMES.has(bare)) {
    throw new Error(`allowed host "${shown}" is a loopback name, which is always accepted: leave it out`);
  }
  if (isIP(bare) !== 0) {
    throw new Error(`allowed host "${shown}" is an IP address: only DNS host names are taken `
      + '(an address other than loopback as Host means a forwarder in front of the daemon, which this is not for)');
  }
  if (name.includes(':')) {
    throw new Error(`allowed host "${shown}" carries a port: name the host alone (it is accepted whatever the port)`);
  }
  if (name.endsWith('.')) {
    throw new Error(`allowed host "${shown}" ends in a dot: write it without (a Host header that ends in one is matched all the same)`);
  }
  if (name.length > HOST_NAME_MAX) { throw new Error(`allowed host "${shown}" is longer than ${HOST_NAME_MAX} characters`); }
  const labels = name.split('.');
  if (!labels.every(label => DNS_LABEL.test(label))) {
    throw new Error(`allowed host "${shown}" is not a DNS host name: `
      + 'labels of letters, digits and inner hyphens, 1 to 63 characters each, separated by dots');
  }
  // Resolvers and the URL standard read a name whose last label is a number
  // as an IPv4 address, whatever the labels before it: 2130706433, 0x7f.1 and
  // 0x7f000001 are all 127.0.0.1 written another way.
  if (NUMBER_LABEL.test(labels[labels.length - 1].toLowerCase())) {
    throw new Error(`allowed host "${shown}" ends in a number, which is read as an IP address: only DNS host names are taken`);
  }
  return lower;
}

/**
 * The host names accepted in the Host header besides the three loopback
 * names: none unless given. For a consumer that reaches the daemon's loopback
 * port under another name, as a container does through the name its runtime
 * gives the host. Each entry is one DNS host name in full (trimmed, kept in
 * lower case), at most 8 of them. Throws on anything else - an empty entry, a
 * port, a scheme, a path, a wildcard, a trailing dot, an IP address, a name
 * that ends in a number, a loopback name - so a typo stops the daemon at
 * startup instead of becoming a rule nobody meant.
 */
export function hostAllowlist(extra: readonly string[] = []): ReadonlySet<string> {
  if (extra.length > ALLOWED_HOSTS_MAX) {
    throw new Error(`at most ${ALLOWED_HOSTS_MAX} allowed hosts are taken, not ${extra.length}`);
  }
  const allowed = new Set<string>();
  for (const raw of extra) { allowed.add(allowedHostEntry(raw)); }
  return allowed;
}

/**
 * True when a Host header names a loopback address (isLocalHostHeader), or
 * names one of `extra` (hostAllowlist): the same host name the loopback check
 * reads, with one trailing dot removed, matched in full and whatever the port.
 * An extra name is taken only as `name` or `name:port`: brackets are for IPv6
 * addresses and a scheme has no place in a Host header, so a header that
 * carries either is left to the loopback check alone.
 */
export function isAllowedHostHeader(host: string | undefined, extra: ReadonlySet<string>): boolean {
  if (isLocalHostHeader(host)) { return true; }
  if (!host || extra.size === 0) { return false; }
  const value = host.trim();
  if (value.startsWith('[') || value.includes('://')) { return false; }
  return extra.has(hostnameOf(value).replace(/\.$/, ''));
}

/**
 * An http(s) origin as a browser serialises it (`scheme://host[:port]`,
 * lowercase, default port dropped), or null when the value is not one - an
 * opaque `null` origin, another scheme, or anything with a path, query or
 * credentials.
 */
export function canonicalOrigin(value: string): string | null {
  let u: URL;
  try { u = new URL(value.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { return null; }
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) { return null; }
  return u.origin;
}

/**
 * The origins a browser page may call the daemon from: the daemon's own (a page
 * it serves, under either loopback name) and the panel's. Throws on a
 * configured panel origin that is not an http(s) origin, so a typo fails at
 * startup instead of locking the panel out.
 */
export function originAllowlist(port: number, panelOrigins: readonly string[] = DEFAULT_PANEL_ORIGINS): Set<string> {
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`].map(o => canonicalOrigin(o)!));
  for (const raw of panelOrigins) {
    const o = canonicalOrigin(raw);
    if (!o) { throw new Error(`panel origin "${raw}" is not an http(s) origin (scheme://host[:port], no path)`); }
    allowed.add(o);
  }
  return allowed;
}

/**
 * True when an Origin is acceptable: absent (a native client), or exactly one
 * of `allowed` (originAllowlist). Anything else - another port, another
 * scheme, another host, `null` - is a cross-origin attempt and is rejected.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!origin) { return true; }
  const o = canonicalOrigin(origin);
  return o !== null && allowed.has(o);
}

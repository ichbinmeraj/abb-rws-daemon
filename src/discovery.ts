import { discoveryKey, findControllers } from 'abb-rws-client';
import type {
  DiscoveredController, FindControllersOptions, FindControllersResult, FoundController, ManualTarget, MdnsController,
} from 'abb-rws-client';
import type { ControllerConfig } from './config.js';
import { sameSystemId } from './fleet.js';
import type { Generation } from './schema/v0.js';

/**
 * How a controller was found. One controller can be found several ways.
 * `manual`: an address the caller named (`manual` or `hosts`); `range`: an
 * address inside a range the caller asked for.
 */
export type DiscoverySource = 'this-pc' | 'service-address' | 'manual' | 'range' | 'mdns';

export interface DiscoveryEntry {
  host: string;
  port: number;
  useHttps: boolean | null;
  /**
   * From the protocol probe. `generationGuessed` is true when the controller
   * was not confirmed as an ABB controller: mDNS alone (the generation is the
   * announcement's guess), or a login challenge that is not ABB's.
   */
  generation: Generation | null;
  generationGuessed: boolean;
  systemName: string | null;
  rwVersion: string | null;
  sources: DiscoverySource[];
  /** The configured controller at this address (or with this system id), if it is already in the fleet. */
  alreadyAdded: string | null;
  /** The host name the caller named, when `host` is the address it resolved to; null otherwise. */
  name: string | null;
}

/** A run with ranges is refused (429) until this long after the previous one with ranges ended. */
export const RANGE_SCAN_INTERVAL_MS = 30_000;

/** One address the caller named: a host, optionally with a port and a scheme. */
export interface DiscoveryTarget {
  host: string;
  port?: number;
  https?: boolean;
}

/**
 * What one discovery run looks at. Only what the request names leaves this
 * PC: the service address and mDNS when asked for (both default on, as a
 * setup scan asks), the named addresses, and ranges only when given.
 */
export interface DiscoverRequest {
  /** Host names or IPv4 addresses, each probed like a `manual` entry without a port. */
  hosts?: string[];
  /** Addresses to probe; without a port, the ports for that kind of host. At most 16 (with `hosts`). */
  manual?: DiscoveryTarget[];
  /** IPv4 ranges, CIDR `10.0.5.0/24` or `10.0.5.20-10.0.5.60`. At most 16 entries, 256 hosts in all. */
  ranges?: string[];
  /** Extra ports probed on every other host. At most 8. */
  ports?: number[];
  /** Probe the ABB service address, 192.168.125.1. Default true. */
  serviceAddress?: boolean;
  /** Send one mDNS query and list the announcements. Default true. */
  mdns?: boolean;
}

/** What a discovery run found, and notes for the person running it. */
export interface DiscoveryAnswer {
  entries: DiscoveryEntry[];
  /** Plain notes from the run, e.g. a name that resolved only to an IPv6 address. */
  notes: string[];
}

/** The client's options for a request; `hosts` are appended to `manual`, in order. */
export function discoveryOptions(request: DiscoverRequest, signal?: AbortSignal): FindControllersOptions {
  const manual: ManualTarget[] = [
    ...(request.manual ?? []).map(t => ({ ...t })),
    ...(request.hosts ?? []).map(host => ({ host })),
  ];
  return {
    local: true,
    serviceAddress: request.serviceAddress ?? true,
    mdns: request.mdns ?? true,
    ...(manual.length > 0 ? { manual } : {}),
    ...(request.ranges && request.ranges.length > 0 ? { ranges: [...request.ranges] } : {}),
    ...(request.ports && request.ports.length > 0 ? { ports: [...request.ports] } : {}),
    identify: 'anonymous',
    ...(signal ? { signal } : {}),
  };
}

/** One merged controller from the client as the daemon serves it, `alreadyAdded` still unset. */
export function toDiscoveryEntry(c: FoundController): DiscoveryEntry {
  return {
    host: c.host,
    port: c.port,
    useHttps: c.https,
    generation: c.generation,
    generationGuessed: !c.identified,
    systemName: c.systemName ?? null,
    rwVersion: c.rwVersion ?? null,
    sources: [...c.sources],
    alreadyAdded: null,
    name: c.name ?? null,
  };
}

/**
 * Which configured controller a found one already is: the same address (every
 * address of this PC counts as one, and so does every address folded into the
 * entry), or the host name the caller typed for it (a controller configured
 * as `cell-7` and scanned as `cell-7` is found at the address the name
 * resolved to), else the same system id - the add route refuses that one too.
 */
export function configuredMatcher(configured: ControllerConfig[]): (c: FoundController) => ControllerConfig | undefined {
  const byKey = new Map<string, ControllerConfig>();
  for (const cfg of configured) {
    const k = discoveryKey(cfg.host, cfg.port);
    if (!byKey.has(k)) { byKey.set(k, cfg); }
  }
  return c => {
    const keys = [
      c.key, discoveryKey(c.host, c.port),
      ...(c.name ? [discoveryKey(c.name, c.port)] : []),
      ...(c.addresses ?? []).map(a => discoveryKey(a.host, a.port)),
    ];
    for (const k of keys) {
      const hit = byKey.get(k);
      if (hit) { return hit; }
    }
    const id = c.systemId;
    return id ? configured.find(cfg => cfg.systemId && sameSystemId(cfg.systemId, id)) : undefined;
  };
}

/** The daemon's answer: entries sorted for display, by system name (or host), then port. */
export function toDiscoveryAnswer(result: FindControllersResult, configured: ControllerConfig[]): DiscoveryAnswer {
  const match = configuredMatcher(configured);
  const entries = result.controllers.map(c => ({ ...toDiscoveryEntry(c), alreadyAdded: match(c)?.id ?? null }));
  entries.sort((a, b) => (a.systemName ?? a.host).localeCompare(b.systemName ?? b.host) || a.port - b.port);
  return { entries, notes: [...result.notes] };
}

/** The ABB service address for a directly cabled controller. */
const SERVICE_ADDRESS = '192.168.125.1';

/**
 * Merge port-probe results and mDNS answers into one entry per controller,
 * keyed by address and port, with every address in `opts.local` counting as
 * this PC.
 *
 * @deprecated Kept for one release so the package's exports do not shrink;
 * `discover` (through the client's `findControllers`) does the merge now. A
 * probed address that is neither this PC nor the service address is tagged
 * `manual`; `opts.entered` is not used.
 */
export function mergeDiscovery(
  tcp: DiscoveredController[],
  mdns: MdnsController[],
  opts: { local: Set<string>; entered: Set<string>; configured: ControllerConfig[] },
): DiscoveryEntry[] {
  const isLocal = (h: string): boolean => opts.local.has(h);
  const key = (host: string, port: number): string => `${isLocal(host) ? 'local' : host}:${port}`;
  const byKey = new Map<string, DiscoveryEntry>();
  for (const c of tcp) {
    byKey.set(key(c.host, c.port), {
      host: c.host, port: c.port, useHttps: c.useHttps,
      generation: c.authType === 'digest' ? 'rws1' : 'rws2', generationGuessed: false,
      systemName: null, rwVersion: null,
      sources: [isLocal(c.host) ? 'this-pc' : c.host === SERVICE_ADDRESS ? 'service-address' : 'manual'],
      alreadyAdded: null, name: null,
    });
  }
  for (const m of mdns) {
    const k = key(m.host, m.port);
    const hit = byKey.get(k);
    if (hit) {
      hit.systemName = m.systemName;
      hit.rwVersion = m.rwVersion ?? null;
      if (!hit.sources.includes('mdns')) { hit.sources.push('mdns'); }
      continue;
    }
    byKey.set(k, {
      host: m.host, port: m.port, useHttps: null,
      generation: m.probableProtocol === 'unknown' ? null : m.probableProtocol, generationGuessed: true,
      systemName: m.systemName, rwVersion: m.rwVersion ?? null, sources: ['mdns'], alreadyAdded: null, name: null,
    });
  }
  for (const e of byKey.values()) {
    e.alreadyAdded = opts.configured.find(c => key(c.host, c.port) === key(e.host, e.port))?.id ?? null;
  }
  return [...byKey.values()].sort((a, b) =>
    (a.systemName ?? a.host).localeCompare(b.systemName ?? b.host) || a.port - b.port);
}

/**
 * Find controllers through the client's `findControllers`: the RWS listening
 * ports of this PC, plus whatever the request asks for - the service address,
 * mDNS, named addresses and ranges. Never logs in. Bad input (an address,
 * range or count the client refuses) rejects with the client's
 * INVALID_ARGUMENT error before anything is sent; a source that fails on its
 * own is not an error. `signal` cancels the run: the answer then holds what
 * was found so far.
 */
export async function discover(
  request: DiscoverRequest,
  configured: ControllerConfig[],
  signal?: AbortSignal,
  find: (options: FindControllersOptions) => Promise<FindControllersResult> = findControllers,
): Promise<DiscoveryAnswer> {
  return toDiscoveryAnswer(await find(discoveryOptions(request, signal)), configured);
}

import { describe, it, expect } from 'vitest';
import { RwsError, findControllers } from 'abb-rws-client';
import type { FindControllersOptions, FindControllersResult, FoundController } from 'abb-rws-client';
import { discover, discoveryOptions, mergeDiscovery, toDiscoveryEntry } from '../src/discovery.js';
import * as daemon from '../src/index.js';
import type { ControllerConfig } from '../src/config.js';

// Documentation addresses (RFC 5737) stand for controllers on other machines.
const RW7_SYSID = '{A3BE1993-3FA0-4D46-93FF-7FA2D8086C81}';

/** A merged controller as the client's findControllers returns it. */
function found(over: Partial<FoundController> & Pick<FoundController, 'host' | 'port'>): FoundController {
  const local = over.host === '127.0.0.1';
  return {
    key: `${local ? 'local' : over.host}:${over.port}`,
    https: true,
    generation: 'rws2',
    authType: 'basic',
    probe: { host: over.host, port: over.port, useHttps: over.https ?? true, authType: 'basic' },
    identified: true,
    realm: 'validusers@robapi.abb',
    sources: [local ? 'this-pc' : 'manual'],
    ...over,
  };
}

/** A run's result around `controllers`. */
function result(controllers: FoundController[], notes: string[] = []): FindControllersResult {
  return {
    controllers,
    aborted: false,
    localScan: { status: 'ok', source: 'netstat -ano', attempts: [{ source: 'netstat -ano', status: 'ok' }], vcFilter: 'on', sweep: false },
    environment: { wsl: false },
    tlsFailures: [],
    unmatchedCredentials: [],
    notes,
  };
}

/** A findControllers stand-in that records its options and answers `answer`. */
function fakeFind(answer: FindControllersResult) {
  const calls: FindControllersOptions[] = [];
  const find = async (o: FindControllersOptions) => { calls.push(o); return answer; };
  return { calls, find };
}

const cfg = (id: string, host: string, port: number, systemId?: string): ControllerConfig =>
  ({ id, name: id, host, port, useHttps: true, username: 'u', password: 'p', ...(systemId ? { systemId } : {}) });
const signal = new AbortController().signal;

describe('discoveryOptions', () => {
  it('scans this PC, the service address and mDNS by default, identifies anonymously, and names nothing else', () => {
    expect(discoveryOptions({})).toEqual({ local: true, serviceAddress: true, mdns: true, identify: 'anonymous' });
  });

  it('takes the service address and mDNS from the request', () => {
    expect(discoveryOptions({ serviceAddress: false, mdns: false })).toMatchObject({ serviceAddress: false, mdns: false });
  });

  it('passes manual entries with their port and scheme, then the hosts, then ranges, ports and the signal', () => {
    const o = discoveryOptions({
      manual: [{ host: '192.0.2.10', port: 5466 }, { host: 'cell-7', https: false }],
      hosts: ['198.51.100.4'],
      ranges: ['10.0.5.0/28'],
      ports: [8443],
    }, signal);
    expect(o.manual).toEqual([{ host: '192.0.2.10', port: 5466 }, { host: 'cell-7', https: false }, { host: '198.51.100.4' }]);
    expect(o.ranges).toEqual(['10.0.5.0/28']);
    expect(o.ports).toEqual([8443]);
    expect(o.signal).toBe(signal);
  });

  it('never asks for logins, credentials, a sweep or wider caps', () => {
    const o = discoveryOptions({ hosts: ['192.0.2.10'], ranges: ['10.0.5.0/24'] }, signal) as Record<string, unknown>;
    expect(o.identify).toBe('anonymous');
    for (const k of ['credentials', 'localFallback', 'maxRangeHosts', 'allowPublicRanges', 'pacing', 'loopbackOnly']) {
      expect(o, k).not.toHaveProperty(k);
    }
  });
});

describe('toDiscoveryEntry', () => {
  it('maps a probed controller', () => {
    expect(toDiscoveryEntry(found({ host: '127.0.0.1', port: 9403, systemName: 'IRB1600_6_120_5', rwVersion: '7.21.4+417' }))).toEqual({
      host: '127.0.0.1', port: 9403, useHttps: true, generation: 'rws2', generationGuessed: false,
      systemName: 'IRB1600_6_120_5', rwVersion: '7.21.4+417', sources: ['this-pc'], alreadyAdded: null, name: null,
    });
  });

  it('keeps an mDNS-only entry`s unknown scheme, and marks its generation as a guess', () => {
    const e = toDiscoveryEntry(found({
      host: '192.0.2.20', port: 443, https: null, probe: null, identified: false, authType: null, realm: undefined,
      sources: ['mdns'], systemName: 'CELL_7', rwVersion: '7.21.0',
    }));
    expect(e).toMatchObject({ useHttps: null, generation: 'rws2', generationGuessed: true, sources: ['mdns'], systemName: 'CELL_7' });
  });

  it('marks a login challenge that is not ABB`s as a guess too', () => {
    const e = toDiscoveryEntry(found({ host: '192.0.2.30', port: 80, https: false, authType: 'digest', generation: 'rws1', identified: false, realm: 'other' }));
    expect(e).toMatchObject({ generation: 'rws1', generationGuessed: true });
  });

  it('carries the name the caller typed next to the address it resolved to, and the range and manual tags', () => {
    expect(toDiscoveryEntry(found({ host: '192.0.2.40', port: 443, name: 'cell-7', sources: ['manual'] })))
      .toMatchObject({ host: '192.0.2.40', name: 'cell-7', sources: ['manual'] });
    expect(toDiscoveryEntry(found({ host: '203.0.113.9', port: 443, sources: ['range', 'mdns'] })).sources).toEqual(['range', 'mdns']);
  });
});

describe('discover', () => {
  it('asks the client once, with the request`s options and the caller`s signal', async () => {
    const f = fakeFind(result([]));
    await discover({ hosts: ['192.0.2.10'], mdns: false }, [], signal, f.find);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ local: true, serviceAddress: true, mdns: false, manual: [{ host: '192.0.2.10' }], identify: 'anonymous' });
    expect(f.calls[0].signal).toBe(signal);
  });

  it('answers the entries sorted by system name (or host), then port, with the run`s notes', async () => {
    const f = fakeFind(result([
      found({ host: '127.0.0.1', port: 9805, systemName: 'IRB1600_6_120_4' }),
      found({ host: '127.0.0.1', port: 80, systemName: 'CRB1910_10_1520' }),
      found({ host: '198.51.100.7', port: 443 }),
      found({ host: '127.0.0.1', port: 5466, systemName: 'IRB1600_6_120_1' }),
    ], ['cell-9: only an IPv6 address; RobotWare does not support IPv6']));
    const answer = await discover({}, [], signal, f.find);
    expect(answer.entries.map(e => `${e.systemName ?? e.host}:${e.port}`))
      .toEqual(['198.51.100.7:443', 'CRB1910_10_1520:80', 'IRB1600_6_120_1:5466', 'IRB1600_6_120_4:9805']);
    expect(answer.notes).toEqual(['cell-9: only an IPv6 address; RobotWare does not support IPv6']);
  });

  it('points at the configured controller by address: any address of this PC is one, and folded addresses count', async () => {
    const f = fakeFind(result([
      found({ host: '127.0.0.1', port: 9403 }),
      found({ host: '192.0.2.50', port: 443, systemId: '{11111111-2222-3333-4444-555555555555}',
        addresses: [{ host: '198.51.100.50', port: 443, https: true, sources: ['mdns'] }] }),
      found({ host: '127.0.0.1', port: 5466 }),
    ]));
    const configured = [cfg('rw7', 'localhost', 9403), cfg('cell', '198.51.100.50', 443)];
    const { entries } = await discover({}, configured, signal, f.find);
    expect(entries.find(e => e.port === 9403)!.alreadyAdded).toBe('rw7');
    expect(entries.find(e => e.host === '192.0.2.50')!.alreadyAdded).toBe('cell');
    expect(entries.find(e => e.port === 5466)!.alreadyAdded).toBeNull();
  });

  it('points at the configured controller by the host name the caller typed, found at the address it resolved to', async () => {
    const f = fakeFind(result([
      found({ host: '198.51.100.7', key: '198.51.100.7:443', name: 'cell-7', port: 443 }),
      found({ host: '198.51.100.8', key: '198.51.100.8:443', name: 'cell-8', port: 5466 }),
    ]));
    const { entries } = await discover({ hosts: ['cell-7', 'cell-8'] }, [cfg('cell', 'Cell-7.', 443), cfg('other', 'cell-8', 443)], signal, f.find);
    expect(entries.find(e => e.name === 'cell-7')!.alreadyAdded).toBe('cell');
    expect(entries.find(e => e.name === 'cell-8')!.alreadyAdded).toBeNull();   // same name, another port
  });

  it('points at the configured controller by system id when the address moved (as the add route refuses it)', async () => {
    const f = fakeFind(result([found({ host: '127.0.0.1', port: 5466, systemId: RW7_SYSID.toLowerCase().replace(/[{}]/g, '') })]));
    const { entries } = await discover({}, [cfg('old-rw7', '127.0.0.1', 9403, RW7_SYSID)], signal, f.find);
    expect(entries[0].alreadyAdded).toBe('old-rw7');
  });

  it('passes the client`s refusal of bad input on as it is', async () => {
    const refusal = Object.assign(new RwsError('findControllers: ranges[0]: covers 65534 hosts, more than 256 (got "10.0.0.0/16"). Nothing was sent.', 'INVALID_ARGUMENT'),
      { field: 'ranges[0]', value: '"10.0.0.0/16"', limit: 256 });
    const find = async () => { throw refusal; };
    await expect(discover({ ranges: ['10.0.0.0/16'] }, [], signal, find)).rejects.toBe(refusal);
  });

  it('the client`s own refusal carries the field, value and cap the route serves (nothing to send even if it passed)', async () => {
    // Every source off, so this sends nothing whatever the outcome; the bad timeout is refused first.
    const err = await findControllers({ local: false, serviceAddress: false, mdns: false, timeoutMs: 5 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RwsError);
    expect(err).toMatchObject({ code: 'INVALID_ARGUMENT', field: 'timeoutMs', value: '5', limit: '100-30000' });
  });
});

describe('mergeDiscovery (deprecated, kept for one release)', () => {
  it('is still exported from the package entry', () => {
    expect(daemon.mergeDiscovery).toBe(mergeDiscovery);
  });

  it('merges probe hits and mDNS answers into one entry per controller, with this PC as one host', () => {
    const entries = mergeDiscovery(
      [
        { host: '127.0.0.1', port: 9403, useHttps: true, authType: 'basic' },
        { host: '192.168.125.1', port: 80, useHttps: false, authType: 'digest' },
        { host: '192.0.2.7', port: 443, useHttps: true, authType: 'basic' },
      ],
      [
        { host: '198.51.100.20', port: 9403, systemName: 'IRB1600_6_120_5', rwVersion: '7.21.4+417', probableProtocol: 'rws2' } as never,
        { host: '203.0.113.9', port: 443, systemName: 'CELL_9', probableProtocol: 'unknown' } as never,
      ],
      { local: new Set(['127.0.0.1', '198.51.100.20']), entered: new Set(['192.0.2.7']), configured: [cfg('cell', '192.0.2.7', 443)] },
    );
    expect(entries).toEqual([
      { host: '192.0.2.7', port: 443, useHttps: true, generation: 'rws2', generationGuessed: false, systemName: null, rwVersion: null,
        sources: ['manual'], alreadyAdded: 'cell', name: null },
      { host: '192.168.125.1', port: 80, useHttps: false, generation: 'rws1', generationGuessed: false, systemName: null, rwVersion: null,
        sources: ['service-address'], alreadyAdded: null, name: null },
      { host: '203.0.113.9', port: 443, useHttps: null, generation: null, generationGuessed: true, systemName: 'CELL_9', rwVersion: null,
        sources: ['mdns'], alreadyAdded: null, name: null },
      { host: '127.0.0.1', port: 9403, useHttps: true, generation: 'rws2', generationGuessed: false, systemName: 'IRB1600_6_120_5',
        rwVersion: '7.21.4+417', sources: ['this-pc', 'mdns'], alreadyAdded: null, name: null },
    ]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PANEL_ORIGINS, canonicalOrigin, hostAllowlist, isAllowedHostHeader, isAllowedOrigin, isLocalHostHeader, originAllowlist,
} from '../src/localGuard.js';

describe('isLocalHostHeader', () => {
  it('accepts loopback hosts with and without a port', () => {
    for (const h of ['127.0.0.1', '127.0.0.1:8080', 'localhost', 'localhost:8080', '[::1]:8080', '::1']) {
      expect(isLocalHostHeader(h), h).toBe(true);
    }
  });

  it('rejects remote / rebinding hosts and empty header', () => {
    for (const h of ['attacker.example', 'attacker.example:8080', 'evil.127.0.0.1.nip.io', '10.0.0.5', undefined, '']) {
      expect(isLocalHostHeader(h), String(h)).toBe(false);
    }
  });

  it('takes no name but the three loopback ones: a container`s name for the host is refused', () => {
    for (const h of ['host.docker.internal', 'host.docker.internal:7810', 'localhost.', 'localhost.:7810']) {
      expect(isLocalHostHeader(h), h).toBe(false);
    }
  });
});

describe('hostAllowlist', () => {
  it('is empty unless host names are given', () => {
    expect([...hostAllowlist()]).toEqual([]);
    expect([...hostAllowlist([])]).toEqual([]);
  });

  it('takes DNS host names in full, trimmed and in lower case, each once', () => {
    expect([...hostAllowlist(['host.docker.internal'])]).toEqual(['host.docker.internal']);
    expect([...hostAllowlist(['  Host.Docker.Internal ', 'HOST.docker.internal', 'gateway'])]).toEqual(['host.docker.internal', 'gateway']);
    // Labels of letters, digits and inner hyphens; a label may start with a digit, and only the last decides "a number".
    for (const name of ['a', 'cell-1.plant.example', '3com.example', '1.2.3.example', '10.cell', 'xn--bcher-kva.example', '0x7f.example',
      'a.0x1g', 'a.1e3', `${'a'.repeat(63)}.example`]) {
      expect([...hostAllowlist([name])], name).toEqual([name]);
    }
    const eight = Array.from({ length: 8 }, (_, i) => `host-${i}.example`);
    expect([...hostAllowlist(eight)]).toEqual(eight);
  });

  it('refuses each kind of bad entry with a message of its own', () => {
    const kinds: Array<[RegExp, string[]]> = [
      [/is empty/, ['', '   ']],
      [/carries a port/, ['host.docker.internal:7810', 'host.docker.internal:', '127.0.0.2:7810', '[::1]:7810', '[fe80::1]:7810']],
      [/carries a scheme/, ['http://host.docker.internal', 'https://host.docker.internal:7810', 'ws://host.docker.internal/v0/stream']],
      [/carries a path/, ['host.docker.internal/', 'host.docker.internal/v0/health', 'host.docker.internal\\v0']],
      [/is a wildcard/, ['*', '*.docker.internal', 'host.*.internal', 'host.docker.*']],
      [/ends in a dot/, ['host.docker.internal.', 'gateway.', '.']],
      [/is an IP address/, ['127.0.0.2', '192.0.2.5', '198.51.100.20', '0.0.0.0', '::', '::ffff:127.0.0.1', 'fe80::1', '[fe80::1]', '2001:db8::1']],
      [/ends in a number/, ['2130706433', '0x7f.1', '0x7f000001', '0X7F000001', '0x', 'cell.0x', '127.1', '127.0.0.256', '1.2.3.4.5',
        'host.docker.0', 'a.b.0x1F', '017700000001']],
      [/is a loopback name, which is always accepted/, ['127.0.0.1', 'localhost', 'LocalHost', '::1', '[::1]']],
      [/is not a DNS host name/, ['-host.example', 'host-.example', 'host..example', '.host.example', 'under_score.example',
        'two words.example', 'user@host.example', 'host.example?x=1', 'host.example#top', `${'a'.repeat(64)}.example`,
        // Letters outside ASCII, one of which (the kelvin sign) turns into a plain k in lower case.
        `b${String.fromCharCode(0xfc)}cher.example`, `${String.fromCharCode(0x212a)}ube.example`]],
      [/is longer than 253 characters/, [Array.from({ length: 64 }, () => 'abc').join('.')]],
    ];
    for (const [message, entries] of kinds) {
      for (const entry of entries) {
        expect(() => hostAllowlist([entry]), `"${entry}"`).toThrow(message);
        // One bad entry spoils the list, wherever it stands.
        expect(() => hostAllowlist(['host.docker.internal', entry]), `"${entry}" second`).toThrow(message);
      }
    }
    // Each kind is told apart from every other.
    const messages = kinds.map(([, entries]) => {
      try { hostAllowlist([entries[0]]); } catch (e) { return (e as Error).message.replace(/"[^"]*"/, '""'); }
      return '';
    });
    expect(new Set(messages).size).toBe(kinds.length);
  });

  it('refuses a ninth entry, whatever it is', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `host-${i}.example`);
    expect(() => hostAllowlist(nine)).toThrow(/at most 8 allowed hosts are taken, not 9/);
    expect(() => hostAllowlist(Array.from({ length: 9 }, () => 'host.docker.internal'))).toThrow(/at most 8/);
  });

  it('refuses what is no text at all (a caller without types)', () => {
    for (const entry of [undefined, null, 7810, ['host.docker.internal'], {}]) {
      expect(() => hostAllowlist([entry as never]), String(entry)).toThrow(/is not text/);
    }
  });

  it('quotes only the start of an overlong entry, and no control character of any', () => {
    const messageOf = (entry: string): string => {
      try { hostAllowlist([entry]); } catch (e) { return (e as Error).message; }
      return '';
    };
    const long = messageOf(`${'a'.repeat(300)}:7810`);
    expect(long).toMatch(/carries a port/);
    expect(long.length).toBeLessThan(200);
    const escape = String.fromCharCode(0x1b);
    const odd = messageOf(`host${escape}[2J\rdocker${String.fromCharCode(0)}.internal`);
    expect(odd).toMatch(/allowed host "host\?\[2J\?docker\?\.internal" is not a DNS host name/);
    expect(odd).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('isAllowedHostHeader', () => {
  const extra = hostAllowlist(['host.docker.internal']);
  const none = hostAllowlist();

  it('accepts the named host with and without a port, in any letter case, with a trailing dot in the header', () => {
    for (const h of [
      'host.docker.internal', 'host.docker.internal:7810', 'host.docker.internal:80', 'HOST.DOCKER.INTERNAL:7810', 'Host.Docker.Internal',
      'host.docker.internal.', 'host.docker.internal.:7810', ' host.docker.internal:7810 ',
    ]) {
      expect(isAllowedHostHeader(h, extra), h).toBe(true);
    }
  });

  it('accepts the loopback hosts as before, with extra names or without', () => {
    for (const h of ['127.0.0.1', '127.0.0.1:8080', 'localhost', 'localhost:8080', '[::1]:8080', '::1']) {
      expect(isAllowedHostHeader(h, extra), h).toBe(true);
      expect(isAllowedHostHeader(h, none), h).toBe(true);
    }
  });

  it('refuses every other host: a name is matched in full, never as a part', () => {
    for (const h of [
      'attacker.example', 'attacker.example:7810', 'evil.host.docker.internal', 'host.docker.internal.attacker.example',
      'docker.internal', 'internal', 'xhost.docker.internal', 'host.docker.internalx', 'host-docker-internal',
      'host.docker.internal..', 'host.docker.internal..:7810', '.host.docker.internal', 'gateway.docker.internal',
      'host.docker.internal@attacker.example', 'attacker.example/host.docker.internal', 'host.docker.internal:7810:attacker.example',
      '192.0.2.5', '192.0.2.5:7810', '127.0.0.2', '2130706433', '0x7f000001', 'localhost.', '[fe80::1]:7810', undefined, '',
    ]) {
      expect(isAllowedHostHeader(h, extra), String(h)).toBe(false);
    }
  });

  it('takes an extra name only as name or name:port: not in brackets, not behind a scheme', () => {
    for (const h of [
      '[host.docker.internal]', '[host.docker.internal]:7810', ' [host.docker.internal]:7810', '[HOST.DOCKER.INTERNAL]:7810',
      'http://host.docker.internal', 'http://host.docker.internal:7810', 'ws://host.docker.internal:7810', 'x://[host.docker.internal]',
    ]) {
      expect(isAllowedHostHeader(h, extra), h).toBe(false);
    }
    // The loopback check keeps the forms it always took.
    for (const h of ['[::1]', '[::1]:7810', '[localhost]:7810', 'http://localhost:7810']) {
      expect(isAllowedHostHeader(h, extra), h).toBe(isLocalHostHeader(h));
      expect(isAllowedHostHeader(h, extra), h).toBe(true);
    }
  });

  it('with no extra names it is the loopback check and nothing more', () => {
    for (const h of ['host.docker.internal', 'host.docker.internal:7810', 'host.docker.internal.', 'attacker.example', undefined, '']) {
      expect(isAllowedHostHeader(h, none), String(h)).toBe(false);
      expect(isAllowedHostHeader(h, none)).toBe(isLocalHostHeader(h));
    }
  });

  it('takes several names, each on its own', () => {
    const two = hostAllowlist(['host.docker.internal', 'Gateway.Docker.Internal']);
    expect(isAllowedHostHeader('gateway.docker.internal:7810', two)).toBe(true);
    expect(isAllowedHostHeader('host.docker.internal:7810', two)).toBe(true);
    expect(isAllowedHostHeader('host.gateway.docker.internal:7810', two)).toBe(false);
  });
});

describe('canonicalOrigin', () => {
  it('serialises an origin the way a browser sends it', () => {
    expect(canonicalOrigin('HTTP://LocalHost:5173')).toBe('http://localhost:5173');
    expect(canonicalOrigin('http://127.0.0.1:80')).toBe('http://127.0.0.1');
    expect(canonicalOrigin('http://localhost:5173/')).toBe('http://localhost:5173');
    expect(canonicalOrigin('http://[::1]:1234')).toBe('http://[::1]:1234');
  });

  it('is null for anything that is not an http(s) origin', () => {
    for (const v of ['null', '', 'file://', 'ws://localhost:5173', 'http://localhost:5173/panel', 'http://u:p@localhost:5173', 'localhost:5173']) {
      expect(canonicalOrigin(v), v).toBeNull();
    }
  });
});

describe('originAllowlist', () => {
  it('holds the daemon`s own origin at its port, under both loopback names, and the panel`s', () => {
    expect([...originAllowlist(7810)].sort()).toEqual([
      'http://127.0.0.1:5173', 'http://127.0.0.1:7810', 'http://localhost:5173', 'http://localhost:7810',
    ]);
    expect(DEFAULT_PANEL_ORIGINS).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173']);
  });

  it('configured panel origins replace the defaults', () => {
    expect([...originAllowlist(7810, ['http://127.0.0.1:4173'])].sort())
      .toEqual(['http://127.0.0.1:4173', 'http://127.0.0.1:7810', 'http://localhost:7810']);
  });

  it('refuses a configured panel origin that is not an origin', () => {
    expect(() => originAllowlist(7810, ['localhost:5173'])).toThrow(/not an http\(s\) origin/);
    expect(() => originAllowlist(7810, ['http://localhost:5173/app'])).toThrow(/not an http\(s\) origin/);
  });
});

describe('isAllowedOrigin', () => {
  const allowed = originAllowlist(7810);

  it('accepts an absent Origin (native clients), the daemon`s own origin and the panel`s', () => {
    for (const o of [undefined, 'http://127.0.0.1:7810', 'http://localhost:7810', 'http://127.0.0.1:5173', 'http://localhost:5173']) {
      expect(isAllowedOrigin(o, allowed), String(o)).toBe(true);
    }
  });

  it('rejects a page on any other loopback port, scheme or name', () => {
    for (const o of [
      'http://localhost:31337', 'http://127.0.0.1:8080', 'http://[::1]:1234', 'http://[::1]:5173',
      'https://localhost:5173', 'http://localhost', 'https://localhost',
    ]) {
      expect(isAllowedOrigin(o, allowed), o).toBe(false);
    }
  });

  it('rejects a cross-site Origin and the opaque null origin', () => {
    for (const o of ['http://attacker.example', 'https://evil.example:8080', 'http://localhost.evil.example:5173', 'null']) {
      expect(isAllowedOrigin(o, allowed), o).toBe(false);
    }
  });
});

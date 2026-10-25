import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RwsError } from 'abb-rws-client';
import { createServer } from '../src/server.js';
import { SnapshotStream, registerStreamRoute } from '../src/stream.js';
import { SocketHub } from '../src/wsHub.js';
import { TOKEN_HEADER } from '../src/schema/v0.js';

/** The daemon's access token in these tests, and the headers of a native consumer that holds it. */
const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const LOCAL = { host: '127.0.0.1:7810', [TOKEN_HEADER]: TOKEN };
let app: FastifyInstance;

afterEach(async () => { await app?.close(); });

describe('GET /v0/health', () => {
  it('reports ok, the package version and uptime', async () => {
    let t = Date.parse('2026-09-23T12:00:00Z');
    app = createServer({ accessToken: TOKEN, now: () => t });
    t += 42_500;

    const res = await app.inject({ method: 'GET', url: '/v0/health', headers: LOCAL });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.startedAt).toBe('2026-09-23T12:00:00.000Z');
    expect(body.uptimeS).toBe(42);
  });
});

describe('loopback guard', () => {
  it('refuses a non-loopback Host (DNS rebinding) with 421', async () => {
    app = createServer({ accessToken: TOKEN });
    const res = await app.inject({ method: 'GET', url: '/v0/health', headers: { host: 'attacker.example' } });
    expect(res.statusCode).toBe(421);
    expect(res.json().code).toBe('HOST_NOT_ALLOWED');
  });

  it('refuses a cross-site Origin on a plain request, not only on WebSocket', async () => {
    app = createServer({ accessToken: TOKEN });
    const res = await app.inject({
      method: 'GET', url: '/v0/health', headers: { ...LOCAL, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('allows the panel`s origin, the daemon`s own and no Origin (native consumers)', async () => {
    app = createServer({ accessToken: TOKEN, port: 7810 });
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://127.0.0.1:7810', 'http://localhost:7810', undefined]) {
      const res = await app.inject({ method: 'GET', url: '/v0/health', headers: { ...LOCAL, ...(origin ? { origin } : {}) } });
      expect(res.statusCode, String(origin)).toBe(200);
    }
  });

  it('refuses a page on another loopback port or scheme: loopback alone is not an origin', async () => {
    app = createServer({ accessToken: TOKEN, port: 7810 });
    for (const origin of ['http://localhost:31337', 'http://[::1]:1234', 'https://localhost:5173', 'http://127.0.0.1:7811', 'null']) {
      const res = await app.inject({ method: 'GET', url: '/v0/health', headers: { ...LOCAL, origin } });
      expect(res.statusCode, origin).toBe(403);
      expect(res.json().code).toBe('ORIGIN_NOT_ALLOWED');
    }
  });

  it('configured panel origins replace the defaults; the daemon`s own follows its port', async () => {
    app = createServer({ accessToken: TOKEN, port: 7900, panelOrigins: ['http://127.0.0.1:4173'] });
    const status = async (origin: string) =>
      (await app.inject({ method: 'GET', url: '/v0/health', headers: { host: '127.0.0.1:7900', origin } })).statusCode;
    expect(await status('http://127.0.0.1:4173')).toBe(200);
    expect(await status('http://127.0.0.1:7900')).toBe(200);
    expect(await status('http://localhost:5173')).toBe(403);
    expect(await status('http://127.0.0.1:7810')).toBe(403);
  });

  it('refuses what a browser marks cross-site, even with no Origin (an img, a script, a navigation)', async () => {
    app = createServer({ accessToken: TOKEN });
    for (const url of ['/v0/health', '/v0/controllers/rw7/io/signals?name=x']) {
      const res = await app.inject({ method: 'GET', url, headers: { ...LOCAL, 'sec-fetch-site': 'cross-site' } });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe('CROSS_SITE_NOT_ALLOWED');
    }
  });

  it('refuses what a browser marks same-site without an Origin: a page on another loopback port (an img, a script)', async () => {
    app = createServer({ accessToken: TOKEN, port: 7810 });
    for (const url of ['/v0/health', '/v0/controllers/rw7/io/signals?name=x']) {
      const res = await app.inject({ method: 'GET', url, headers: { ...LOCAL, 'sec-fetch-site': 'same-site' } });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe('CROSS_SITE_NOT_ALLOWED');
    }
    // A value no browser sends yet counts as foreign too, unless the page names itself.
    const unknown = await app.inject({ method: 'GET', url: '/v0/health', headers: { ...LOCAL, 'sec-fetch-site': 'same-party' } });
    expect(unknown.statusCode).toBe(403);
  });

  it('allows a same-site request that names an allowed Origin (the panel calling the daemon directly)', async () => {
    app = createServer({ accessToken: TOKEN, port: 7810 });
    const ok = await app.inject({ method: 'GET', url: '/v0/health',
      headers: { ...LOCAL, origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-site' } });
    expect(ok.statusCode).toBe(200);
    const other = await app.inject({ method: 'GET', url: '/v0/health',
      headers: { ...LOCAL, origin: 'http://127.0.0.1:8888', 'sec-fetch-site': 'same-site' } });
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('allows same-origin requests (the panel`s health probe), an address typed by hand, and native clients', async () => {
    app = createServer({ accessToken: TOKEN });
    for (const site of ['same-origin', 'none', undefined]) {
      const res = await app.inject({ method: 'GET', url: '/v0/health', headers: { ...LOCAL, ...(site ? { 'sec-fetch-site': site } : {}) } });
      expect(res.statusCode, String(site)).toBe(200);
    }
    const panel = await app.inject({ method: 'GET', url: '/v0/health',
      headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin' } });
    expect(panel.statusCode).toBe(200);
  });

  it('a panel origin that is not an origin fails at startup', () => {
    expect(() => createServer({ accessToken: TOKEN, panelOrigins: ['localhost:5173'] })).toThrow(/not an http\(s\) origin/);
  });

  it('guards unknown routes too, before the 404', async () => {
    app = createServer({ accessToken: TOKEN });
    const res = await app.inject({ method: 'GET', url: '/nope', headers: { host: 'attacker.example' } });
    expect(res.statusCode).toBe(421);
  });
});

describe('allowed hosts: names accepted in Host besides loopback', () => {
  /** How a container reaches a daemon on the host's loopback: under the name its runtime gives the host. */
  const NAMED = 'host.docker.internal:7810';
  /** A server with one route behind the token, as every /v0 route but health is. */
  const serve = (allowedHosts?: string[]) => {
    app = createServer({ accessToken: TOKEN, port: 7810, ...(allowedHosts ? { allowedHosts } : {}) });
    app.get('/v0/controllers', async () => ({ controllers: [] }));
    return app;
  };
  const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });

  it('off by default: the named Host is refused 421 on every route, with the token or without', async () => {
    serve();
    for (const [url, headers] of [
      ['/v0/health', { host: NAMED }], ['/v0/controllers', { host: NAMED }], ['/v0/controllers', { host: NAMED, [TOKEN_HEADER]: TOKEN }],
      ['/v0/nope', { host: NAMED, [TOKEN_HEADER]: TOKEN }], ['/v0/health', { host: 'host.docker.internal' }],
    ] as Array<[string, Record<string, string>]>) {
      const res = await get(url, headers);
      expect(res.statusCode, `${url} ${JSON.stringify(Object.keys(headers))}`).toBe(421);
      expect(res.json()).toEqual({ error: 'host not allowed', code: 'HOST_NOT_ALLOWED' });
    }
  });

  it('an empty list is the default', async () => {
    serve([]);
    expect((await get('/v0/health', { host: NAMED })).statusCode).toBe(421);
    expect((await get('/v0/health', LOCAL)).statusCode).toBe(200);
  });

  it('with the name allowed: health answers, and a token route asks for the token as ever', async () => {
    serve(['host.docker.internal']);
    const health = await get('/v0/health', { host: NAMED });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe('ok');

    const bare = await get('/v0/controllers', { host: NAMED });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().code).toBe('TOKEN_MISSING');
    const wrong = await get('/v0/controllers', { host: NAMED, [TOKEN_HEADER]: 'wrong-token-wrong-token-wrong-token-12345' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe('TOKEN_INVALID');
    const held = await get('/v0/controllers', { host: NAMED, [TOKEN_HEADER]: TOKEN });
    expect(held.statusCode).toBe(200);
    expect(held.json()).toEqual({ controllers: [] });
    // An unknown path says nothing without the token here either.
    expect((await get('/v0/nope', { host: NAMED })).statusCode).toBe(401);
  });

  it('the name is matched as the loopback names are: any port, any letter case, a trailing dot', async () => {
    serve(['Host.Docker.Internal']);
    for (const host of ['host.docker.internal', 'host.docker.internal:80', 'HOST.DOCKER.INTERNAL:7810', 'host.docker.internal.:7810']) {
      expect((await get('/v0/health', { host })).statusCode, host).toBe(200);
    }
  });

  it('the name is no origin: a page served under it is refused 403, as is a cross-site request', async () => {
    serve(['host.docker.internal']);
    for (const origin of ['http://host.docker.internal:7810', 'http://host.docker.internal', 'https://host.docker.internal:7810']) {
      for (const url of ['/v0/health', '/v0/controllers']) {
        const res = await get(url, { host: NAMED, [TOKEN_HEADER]: TOKEN, origin });
        expect(res.statusCode, `${origin} ${url}`).toBe(403);
        expect(res.json().code).toBe('ORIGIN_NOT_ALLOWED');
      }
    }
    // The same page asking a loopback name gets no further.
    const viaLoopback = await get('/v0/health', { ...LOCAL, origin: 'http://host.docker.internal:7810' });
    expect(viaLoopback.statusCode).toBe(403);
    const crossSite = await get('/v0/health', { host: NAMED, 'sec-fetch-site': 'cross-site' });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().code).toBe('CROSS_SITE_NOT_ALLOWED');
    const sameSite = await get('/v0/health', { host: NAMED, 'sec-fetch-site': 'same-site' });
    expect(sameSite.json().code).toBe('CROSS_SITE_NOT_ALLOWED');
    // The panel's origin and the daemon's own stay what they were.
    expect((await get('/v0/health', { host: NAMED, origin: 'http://127.0.0.1:5173' })).statusCode).toBe(200);
  });

  it('every other Host is refused as before, and loopback is accepted as before', async () => {
    serve(['host.docker.internal']);
    for (const host of [
      'attacker.example', 'evil.host.docker.internal:7810', 'host.docker.internal.attacker.example', 'gateway.docker.internal:7810',
      'docker.internal', '192.0.2.5:7810', 'host.docker.internal..',
    ]) {
      const res = await get('/v0/controllers', { host, [TOKEN_HEADER]: TOKEN });
      expect(res.statusCode, host).toBe(421);
      expect(res.json().code).toBe('HOST_NOT_ALLOWED');
    }
    for (const host of ['127.0.0.1:7810', 'localhost:7810', '[::1]:7810']) {
      expect((await get('/v0/controllers', { host, [TOKEN_HEADER]: TOKEN })).statusCode, host).toBe(200);
    }
  });

  it('the stream upgrade passes the Host check under the name, and still needs the token', async () => {
    const withStream = async (allowedHosts?: string[]) => {
      const server = createServer({ accessToken: TOKEN, port: 7810, ...(allowedHosts ? { allowedHosts } : {}) });
      const stream = new SnapshotStream({ list: () => [], get: () => null, onChanged: () => {} }, new SocketHub({ heartbeatMs: 0 }));
      await registerStreamRoute(server, stream);
      await server.ready();
      return { server, stream };
    };

    const open = await withStream(['host.docker.internal']);
    try {
      let first!: (frame: string) => void;
      const snapshot = new Promise<string>(resolve => { first = resolve; });
      const ws = await open.server.injectWS('/v0/stream', { headers: { host: NAMED, [TOKEN_HEADER]: TOKEN } },
        { onInit: sock => sock.once('message', d => first(String(d))) });
      expect(JSON.parse(await snapshot)).toMatchObject({ type: 'snapshot', controllers: [] });
      ws.terminate();
      await expect(open.server.injectWS('/v0/stream', { headers: { host: NAMED } })).rejects.toThrow(/401/);
      await expect(open.server.injectWS('/v0/stream', { headers: { host: NAMED, [TOKEN_HEADER]: TOKEN, origin: `http://${NAMED}` } }))
        .rejects.toThrow(/403/);
      await expect(open.server.injectWS('/v0/stream', { headers: { host: 'attacker.example', [TOKEN_HEADER]: TOKEN } }))
        .rejects.toThrow(/421/);
    } finally {
      open.stream.close();
      await open.server.close();
    }

    const closed = await withStream();
    try {
      await expect(closed.server.injectWS('/v0/stream', { headers: { host: NAMED, [TOKEN_HEADER]: TOKEN } })).rejects.toThrow(/421/);
    } finally {
      closed.stream.close();
      await closed.server.close();
    }
  }, 15_000);

  it('a name that is not a host name fails at startup', () => {
    for (const [bad, message] of [
      ['192.0.2.5', /is an IP address/], ['2130706433', /ends in a number/], ['*.docker.internal', /is a wildcard/],
      ['host.docker.internal:7810', /carries a port/], ['localhost', /always accepted/], ['', /is empty/],
    ] as Array<[string, RegExp]>) {
      expect(() => createServer({ accessToken: TOKEN, allowedHosts: [bad] }), bad).toThrow(message);
    }
    const nine = Array.from({ length: 9 }, (_, i) => `host-${i}.example`);
    expect(() => createServer({ accessToken: TOKEN, allowedHosts: nine })).toThrow(/at most 8/);
  });
});

describe('access token', () => {
  const WRONG = 'wrong-token-wrong-token-wrong-token-12345';
  /** A server with one route behind the token, as every /v0 route but health is. */
  const serve = (accessToken: string | null = TOKEN) => {
    app = createServer({ accessToken });
    app.get('/v0/controllers', async () => ({ controllers: [] }));
    return app;
  };

  it('a request without it is refused 401 TOKEN_MISSING, and told where the token is kept', async () => {
    serve();
    const res = await app.inject({ method: 'GET', url: '/v0/controllers', headers: { host: '127.0.0.1:7810' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('TOKEN_MISSING');
    expect(res.json().error).toMatch(/x-abb-rws-token header; the daemon names the file that holds it/);
  });

  it('a request with another token is refused 401 TOKEN_INVALID, which quotes neither token', async () => {
    serve();
    for (const presented of [WRONG, TOKEN.slice(0, -1), `${TOKEN}x`, `${TOKEN}, ${TOKEN}`]) {
      const res = await app.inject({ method: 'GET', url: '/v0/controllers', headers: { host: '127.0.0.1:7810', [TOKEN_HEADER]: presented } });
      expect(res.statusCode, presented).toBe(401);
      expect(res.json().code).toBe('TOKEN_INVALID');
      expect(res.body).not.toContain(TOKEN.slice(0, 12));
      expect(res.body).not.toContain(WRONG.slice(0, 12));
    }
  });

  it('a request with the token passes', async () => {
    serve();
    const res = await app.inject({ method: 'GET', url: '/v0/controllers', headers: LOCAL });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(TOKEN);
  });

  it('health needs none, whatever else the request carries: "no daemon" and "no token" stay apart', async () => {
    serve();
    for (const headers of [{ host: '127.0.0.1:7810' }, { host: '127.0.0.1:7810', [TOKEN_HEADER]: WRONG }, LOCAL]) {
      for (const method of ['GET', 'HEAD'] as const) {
        const res = await app.inject({ method, url: '/v0/health?probe=1', headers });
        expect(res.statusCode, `${method} ${JSON.stringify(headers)}`).toBe(200);
      }
    }
  });

  it('the route that matched decides, never how the path is spelled', async () => {
    serve();
    for (const url of ['/v0/health/', '/v0/health/../controllers', '/v0/healthz', '/V0/HEALTH', '/v0//health', '/v0/health%2F..%2Fcontrollers']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:7810' } });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('an unknown path needs it too: without it nothing says which paths exist', async () => {
    serve();
    const bare = await app.inject({ method: 'GET', url: '/v0/nope', headers: { host: '127.0.0.1:7810' } });
    expect(bare.statusCode).toBe(401);
    const held = await app.inject({ method: 'GET', url: '/v0/nope', headers: LOCAL });
    expect(held.statusCode).toBe(404);
  });

  it('a page is kept out by Host, Origin and Sec-Fetch-Site first: the token is no way past them', async () => {
    serve();
    const origin = await app.inject({ method: 'GET', url: '/v0/controllers', headers: { ...LOCAL, origin: 'http://localhost:31337' } });
    expect(origin.statusCode).toBe(403);
    expect(origin.json().code).toBe('ORIGIN_NOT_ALLOWED');
    const site = await app.inject({ method: 'GET', url: '/v0/controllers', headers: { ...LOCAL, 'sec-fetch-site': 'cross-site' } });
    expect(site.json().code).toBe('CROSS_SITE_NOT_ALLOWED');
    const host = await app.inject({ method: 'GET', url: '/v0/controllers', headers: { ...LOCAL, host: 'attacker.example' } });
    expect(host.statusCode).toBe(421);
  });

  it('a JSON write without the token is refused before its body is read', async () => {
    app = createServer({ accessToken: TOKEN });
    let reached = false;
    app.post('/v0/controllers', async () => { reached = true; return {}; });
    const res = await app.inject({ method: 'POST', url: '/v0/controllers', headers: { host: '127.0.0.1:7810', 'content-type': 'application/json' },
      payload: '{"host":"10.0.0.5","password":"hunter2-not-robotics"' });
    expect(res.statusCode).toBe(401);
    expect(reached).toBe(false);
    expect(res.body).not.toContain('hunter2');
  });

  it('null checks no token (a server behind a gate of its own)', async () => {
    serve(null);
    const res = await app.inject({ method: 'GET', url: '/v0/controllers', headers: { host: '127.0.0.1:7810' } });
    expect(res.statusCode).toBe(200);
  });

  it('a server is never built open by omission, nor with a token that is no token', () => {
    expect(() => createServer({} as never)).toThrow(/needs an accessToken/);
    for (const bad of ['', 'short', 'has spaces in it and is long enough to be one', 'x'.repeat(257)]) {
      expect(() => createServer({ accessToken: bad }), bad).toThrow(/32 to 256 letters, digits/);
    }
  });
});

describe('error handling', () => {
  it('answers an unknown route with a JSON 404', async () => {
    app = createServer({ accessToken: TOKEN });
    const res = await app.inject({ method: 'GET', url: '/v0/nope', headers: LOCAL });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NO_ROUTE');
  });

  it('never echoes a credential from the URL of an unknown route', async () => {
    app = createServer({ accessToken: TOKEN });
    const res = await app.inject({ method: 'GET', url: '/v0/nope?user=a&password=hunter2-not-robotics', headers: LOCAL });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no route: GET /v0/nope?user=a&password=***', code: 'NO_ROUTE' });
  });

  it('maps a controller failure through the error map', async () => {
    app = createServer({ accessToken: TOKEN });
    app.get('/boom-rws', async () => { throw new RwsError('motors are off', 'MOTORS_OFF'); });
    const res = await app.inject({ method: 'GET', url: '/boom-rws', headers: LOCAL });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'motors are off', code: 'MOTORS_OFF' });
  });

  it("keeps the controller's status, code and message on a controller failure", async () => {
    app = createServer({ accessToken: TOKEN });
    app.get('/boom-held', async () => {
      throw new RwsError('Operation not allowed in the current controller state or operation mode: 400', 'WRONG_MODE',
        400, '<raw body>', -1073442809, 'Operation not allowed in current state');
    });
    const res = await app.inject({ method: 'GET', url: '/boom-held', headers: LOCAL });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Operation not allowed in the current controller state or operation mode: 400',
      code: 'WRONG_MODE',
      controller: { httpStatus: 400, code: -1073442809, message: 'Operation not allowed in current state' },
    });
  });

  it('reserves 500 for the daemon\'s own bugs', async () => {
    app = createServer({ accessToken: TOKEN });
    app.get('/boom-bug', async () => { throw new Error('undefined is not a function'); });
    const res = await app.inject({ method: 'GET', url: '/boom-bug', headers: LOCAL });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('DAEMON_ERROR');
  });
});

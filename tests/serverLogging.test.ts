import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

// Its own file: Fastify emits each deprecation once per process, so a server
// built earlier in the same worker would hide the warning from this test.
describe('server logging', () => {
  it('starts without a Fastify deprecation warning', async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => { warnings.push(w); };
    process.on('warning', onWarning);
    try {
      const app = createServer({ accessToken: null });
      await app.ready();
      await new Promise(r => setImmediate(r));
      await app.close();
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings.filter(w => w.name === 'FastifyDeprecation').map(w => w.message)).toEqual([]);
  });

  it('writes no per-request log lines', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, done) { lines.push(String(chunk)); done(); } });
    const app = createServer({ accessToken: null, logger: { level: 'trace', stream } });
    const res = await app.inject({ method: 'GET', url: '/v0/health' });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(lines.filter(l => /incoming request|request completed/.test(l))).toEqual([]);
  });

  it('logs a failed request without a PIN in its URL or message', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, done) { lines.push(String(chunk)); done(); } });
    const app = createServer({ accessToken: null, logger: { level: 'trace', stream } });
    app.get('/test-only/boom', async () => { throw new Error('POST /rw/panel/opmode/unlock body pin=4711&pincode=4712 failed'); });
    const res = await app.inject({ method: 'GET', url: '/test-only/boom?pin=4711&pincode=4712' });
    await app.close();
    expect(res.statusCode).toBe(500);
    const logged = lines.filter(l => l.includes('daemon error'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('/test-only/boom');
    expect(logged[0]).not.toMatch(/4711|4712/);
    expect(res.body).not.toMatch(/4711|4712/);
  });
});

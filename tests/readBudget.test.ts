import { describe, it, expect } from 'vitest';
import { READ_BURST, READ_IN_FLIGHT_RETRY_AFTER_S, READ_RATE_PER_S, ReadBudget, ReadLimitError } from '../src/readBudget.js';
import { READ_CACHE_MS, READS_IN_FLIGHT_MAX } from '../src/schema/v0.js';

/** A read that stays out until the test lets it go (`finish`) or fails it (`fail`). */
function pending<T>() {
  let finish!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { finish = res; fail = rej; });
  return { promise, finish, fail };
}

/** A budget on a clock the test moves by hand. */
function budget() {
  const clock = { t: 1_000_000 };
  return { clock, b: new ReadBudget(() => clock.t) };
}

const flush = () => new Promise(res => setTimeout(res, 0));

describe('ReadBudget - reads in flight', () => {
  it(`takes ${READS_IN_FLIGHT_MAX} different reads at a time; one more is refused without being sent`, async () => {
    const { b } = budget();
    const reads = [pending<string>(), pending<string>()];
    let sent = 0;
    const a = b.run('rw7', 'a', () => { sent++; return reads[0].promise; });
    const c = b.run('rw7', 'c', () => { sent++; return reads[1].promise; });
    let third: unknown;
    await b.run('rw7', 'd', async () => { sent++; return 'd'; }).catch(e => { third = e; });
    expect(third).toBeInstanceOf(ReadLimitError);
    expect(third).toMatchObject({ controller: 'rw7', limit: 'in-flight', retryAfterS: READ_IN_FLIGHT_RETRY_AFTER_S });
    expect((third as Error).message).toContain(`${READS_IN_FLIGHT_MAX} on-demand reads in flight`);
    expect(sent).toBe(2);
    reads[0].finish('A');
    expect(await a).toBe('A');
    // One is back: the next read goes out.
    expect(await b.run('rw7', 'd', async () => 'd')).toBe('d');
    reads[1].finish('C');
    expect(await c).toBe('C');
  });

  it('a failed read frees its place too', async () => {
    const { b } = budget();
    const r = pending<string>();
    const a = b.run('rw7', 'a', () => r.promise);
    const c = b.run('rw7', 'c', () => new Promise<string>(() => {}));
    await expect(b.run('rw7', 'd', async () => 'd')).rejects.toBeInstanceOf(ReadLimitError);
    r.fail(new Error('controller said no'));
    await expect(a).rejects.toThrow('controller said no');
    expect(await b.run('rw7', 'd', async () => 'd')).toBe('d');
    void c;
  });

  it('a read that throws before it returns a promise is a rejection, and frees its place', async () => {
    const { b } = budget();
    await expect(b.run('rw7', 'a', () => { throw new Error('not connected'); })).rejects.toThrow('not connected');
    expect(b.inFlight('rw7')).toEqual([]);
  });

  it('each controller has a budget of its own', async () => {
    const { b } = budget();
    b.run('rw7', 'a', () => new Promise(() => {}));
    b.run('rw7', 'c', () => new Promise(() => {}));
    await expect(b.run('rw7', 'd', async () => 'd')).rejects.toBeInstanceOf(ReadLimitError);
    expect(await b.run('rw8', 'd', async () => 'd8')).toBe('d8');
  });
});

describe('ReadBudget - identical requests share one read', () => {
  it('a request with the key of a read in flight joins it: one read, one answer, no place taken', async () => {
    const { b } = budget();
    const r = pending<{ text: string }>();
    let sent = 0;
    const read = () => { sent++; return r.promise; };
    const first = b.run('rw7', 'same', read);
    const joined = Array.from({ length: 10 }, () => b.run('rw7', 'same', read));
    // The joiners take no place: another read still goes out beside it.
    const other = b.run('rw7', 'other', async () => ({ text: 'o' }));
    expect(sent).toBe(1);
    r.finish({ text: 'x' });
    const answers = await Promise.all([first, ...joined]);
    expect(answers.every(a => a === answers[0] && a.text === 'x')).toBe(true);
    expect(await other).toEqual({ text: 'o' });
  });

  it('joiners share a failure too, and a failure is not kept', async () => {
    const { b } = budget();
    const r = pending<string>();
    const first = b.run('rw7', 'same', () => r.promise, { cacheMs: READ_CACHE_MS });
    const joined = b.run('rw7', 'same', () => Promise.resolve('never sent'), { cacheMs: READ_CACHE_MS });
    r.fail(new Error('busy'));
    await expect(first).rejects.toThrow('busy');
    await expect(joined).rejects.toThrow('busy');
    let sent = 0;
    expect(await b.run('rw7', 'same', async () => { sent++; return 'fresh'; })).toBe('fresh');
    expect(sent).toBe(1);
  });

  it('joining costs nothing from the rate', async () => {
    const { b } = budget();
    const r = pending<string>();
    const first = b.run('rw7', 'same', () => r.promise, { cost: READ_BURST });
    for (let i = 0; i < 20; i++) { void b.run('rw7', 'same', () => r.promise, { cost: READ_BURST }); }
    await expect(b.run('rw7', 'other', async () => 'x')).rejects.toMatchObject({ limit: 'rate' });
    r.finish('ok');
    expect(await first).toBe('ok');
  });
});

describe('ReadBudget - answers kept', () => {
  it('keeps a successful answer for cacheMs under its key, then reads again', async () => {
    const { b, clock } = budget();
    let sent = 0;
    const read = async () => { sent++; return `answer ${sent}`; };
    expect(await b.run('rw7', 'k', read, { cacheMs: READ_CACHE_MS })).toBe('answer 1');
    clock.t += READ_CACHE_MS - 1;
    expect(await b.run('rw7', 'k', read, { cacheMs: READ_CACHE_MS })).toBe('answer 1');
    expect(sent).toBe(1);
    clock.t += 1;
    expect(await b.run('rw7', 'k', read, { cacheMs: READ_CACHE_MS })).toBe('answer 2');
    expect(sent).toBe(2);
  });

  it('keeps nothing without cacheMs, and another key is another answer', async () => {
    const { b } = budget();
    let sent = 0;
    const read = async () => ++sent;
    await b.run('rw7', 'k', read);
    await b.run('rw7', 'k', read);
    await b.run('rw7', 'k2', read, { cacheMs: READ_CACHE_MS });
    expect(sent).toBe(3);
  });

  it('an answer from memory is served even while the budget has no room', async () => {
    const { b } = budget();
    await b.run('rw7', 'k', async () => 'kept', { cacheMs: READ_CACHE_MS });
    b.run('rw7', 'a', () => new Promise(() => {}));
    b.run('rw7', 'c', () => new Promise(() => {}));
    expect(await b.run('rw7', 'k', async () => 'not sent', { cacheMs: READ_CACHE_MS })).toBe('kept');
  });

  it('peek and keep: an answer kept by hand, for as long as asked', () => {
    const { b, clock } = budget();
    expect(b.peek('rw7', 'kinds')).toBeUndefined();
    b.keep('rw7', 'kinds', ['MainModule'], 60_000);
    expect(b.peek('rw7', 'kinds')).toEqual(['MainModule']);
    clock.t += 60_000;
    expect(b.peek('rw7', 'kinds')).toBeUndefined();
  });

  it('forget drops what a controller kept; a read still out settles as usual', async () => {
    const { b } = budget();
    await b.run('rw7', 'k', async () => 'old', { cacheMs: READ_CACHE_MS });
    const r = pending<string>();
    const out = b.run('rw7', 'slow', () => r.promise, { cacheMs: READ_CACHE_MS });
    expect(b.inFlight('rw7')).toHaveLength(1);
    b.forget('rw7');
    expect(b.inFlight('rw7')).toEqual([]);
    expect(await b.run('rw7', 'k', async () => 'new', { cacheMs: READ_CACHE_MS })).toBe('new');
    r.finish('late');
    expect(await out).toBe('late');
    await flush();
    // What the forgotten read brought back is not kept for the controller as it is now.
    let sent = 0;
    expect(await b.run('rw7', 'slow', async () => { sent++; return 'again'; })).toBe('again');
    expect(sent).toBe(1);
  });
});

describe('ReadBudget - the rate', () => {
  it(`a burst of ${READ_BURST} requests, then about ${READ_RATE_PER_S} a second; a refusal says when to ask again`, async () => {
    const { b, clock } = budget();
    for (let i = 0; i < READ_BURST; i++) { await b.run('rw7', `k${i}`, async () => i); }
    let refused: unknown;
    await b.run('rw7', 'next', async () => 'x').catch(e => { refused = e; });
    expect(refused).toMatchObject({ limit: 'rate', retryAfterS: 1 });
    expect((refused as Error).message).toContain(`about ${READ_RATE_PER_S} controller requests a second`);
    clock.t += 1_000 / READ_RATE_PER_S;   // one request's worth back
    expect(await b.run('rw7', 'next', async () => 'x')).toBe('x');
    await expect(b.run('rw7', 'again', async () => 'x')).rejects.toMatchObject({ limit: 'rate' });
  });

  it('a read of several requests is charged each of them, and waits for as many', async () => {
    const { b, clock } = budget();
    await b.run('rw7', 'a', async () => 'a', { cost: 2 });
    await b.run('rw7', 'c', async () => 'c', { cost: 1 });
    // One request left: a two-request read waits for a second one.
    await expect(b.run('rw7', 'd', async () => 'd', { cost: 2 })).rejects.toMatchObject({ limit: 'rate', retryAfterS: 1 });
    expect(await b.run('rw7', 'e', async () => 'e', { cost: 1 })).toBe('e');
    clock.t += 1_000;   // two requests back
    expect(await b.run('rw7', 'd', async () => 'd', { cost: 2 })).toBe('d');
  });

  it('the refill stops at a burst: a quiet hour does not bank an hour of reads', async () => {
    const { b, clock } = budget();
    clock.t += 3_600_000;
    for (let i = 0; i < READ_BURST; i++) { await b.run('rw7', `k${i}`, async () => i); }
    await expect(b.run('rw7', 'next', async () => 'x')).rejects.toMatchObject({ limit: 'rate' });
  });

  it('a refused request costs nothing', async () => {
    const { b, clock } = budget();
    for (let i = 0; i < READ_BURST; i++) { await b.run('rw7', `k${i}`, async () => i); }
    for (let i = 0; i < 50; i++) { await b.run('rw7', `x${i}`, async () => i).catch(() => {}); }
    clock.t += 1_000 / READ_RATE_PER_S;
    expect(await b.run('rw7', 'next', async () => 'x')).toBe('x');
  });
});

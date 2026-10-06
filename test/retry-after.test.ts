import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, RateLimitError, REST_SAFE_METHODS, createRegistrar } from '../src/index';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-06T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

function client(fetch: typeof globalThis.fetch, retries = 0) {
  return new HttpClient({
    baseUrl: 'https://api.example.test',
    safeMethods: REST_SAFE_METHODS,
    options: { timeout: 30_000, retries, backoff: 1000, fetch },
  });
}

describe('HTTP 429 Retry-After', () => {
  it.each([null, '', 'garbage', '-1', '1.5', 'Infinity', 'Tue, 06 Oct 2026 00:00:12'])(
    'does not turn a missing or invalid header (%s) into an immediate retry',
    async header => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          new Response('Too many requests', {
            status: 429,
            headers: header === null ? {} : { 'Retry-After': header },
          })
        )
      );
      const error = await client(fetch)
        .request({ path: '/domains' })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfter).toBeUndefined();
    }
  );

  it.each([
    ['0', 0],
    ['12', 12],
    [' 12 ', 12],
    ['Tue, 06 Oct 2026 00:00:12 GMT', 12],
    ['Tuesday, 06-Oct-26 00:00:12 GMT', 12],
    ['Tue Oct  6 00:00:12 2026', 12],
    ['Mon, 05 Oct 2026 23:59:59 GMT', 0],
  ])('preserves a valid delay (%s)', async (header, expected) => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 429, headers: { 'Retry-After': header } }))
    );
    const error = await client(fetch)
      .request({ path: '/domains' })
      .catch((error: unknown) => error);
    expect((error as RateLimitError).retryAfter).toBe(expected);
  });

  it('uses configured backoff when the provider supplies no usable delay', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const result = client(fetch, 1).request({ path: '/domains' });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ ok: true });
  });

  it("uses Dynadot's conservative 60-second fallback without Retry-After", async () => {
    const startedAt: number[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => {
        startedAt.push(Date.now());
        return Promise.resolve(new Response(null, { status: 429 }));
      })
      .mockImplementationOnce(() => {
        startedAt.push(Date.now());
        return Promise.resolve(Response.json({ code: 200, data: { account_info: {} } }));
      });
    const provider = createRegistrar(
      'dynadot',
      { apiKey: 'test-key', apiSecret: 'test-secret' },
      {
        fetch,
        retries: 1,
      }
    );
    const result = provider.testConnection();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(Math.max(0, startedAt[0] + 59_999 - Date.now()));
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ success: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(60_000);
  });
});

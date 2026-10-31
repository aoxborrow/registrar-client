import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRegistrar, InvalidResponseError, RateLimitError } from '../src/index';
const make = (fetch: typeof globalThis.fetch) =>
  createRegistrar(
    'dynadot',
    { apiKey: 'fixture-key', apiSecret: 'fixture-secret' },
    { fetch, retries: 0 }
  );
const urlOf = (u: string | URL | Request) => new URL(u instanceof Request ? u.url : u);
const search = (domain: string, prices: unknown[]) =>
  Response.json({
    code: 200,
    message: 'Success',
    data: {
      domain_name: domain,
      available: 'No',
      premium: 'yes',
      price_list: prices,
    },
  });
const entry = (renewal: unknown = '90', unit = '(price/1 year)') => ({
  currency: 'USD',
  unit,
  renewal_price: renewal,
});
const unsupported = () =>
  Response.json(
    {
      code: 400,
      error: { description: "This TLD isn't supported via the API." },
    },
    { status: 400 }
  );
const rejected = () => Response.json({ Response: { ResponseCode: '-1', Error: 'invalid key' } });
const classic = () =>
  Response.json({
    RenewResponse: {
      Status: 'price_check_success',
      PriceInfo: 'Renew Fee: 180 in USD, Total: 180 in USD',
    },
  });
const restOnly = (handler: (url: URL) => Response) =>
  vi.fn<typeof globalThis.fetch>((u, init) => {
    expect(init?.method).toBe('GET');
    const url = urlOf(u);
    if (url.pathname === '/api3.json') {
      expect(url.searchParams.get('price_check')).toBe('1');
      return Promise.resolve(rejected());
    }
    expect(url.pathname.endsWith('/search')).toBe(true);
    return Promise.resolve(handler(url));
  });
afterEach(() => vi.useRealTimers());
describe('Dynadot exact REST renewal fallback', () => {
  it('prices taken names through single search and remembers the incompatible classic key', async () => {
    const fetch = restOnly(url => {
      expect(url.searchParams.get('show_price')).toBe('true');
      return search(decodeURIComponent(url.pathname.split('/')[4]), [
        entry('180', '(price/2 year)'),
        entry('90'),
      ]);
    });
    const provider = make(fetch);
    expect(await provider.getPricing('owned.io')).toMatchObject({
      renewal: 90,
      currency: 'USD',
    });
    expect(await provider.getPricing('next.io')).toMatchObject({
      renewal: 90,
      currency: 'USD',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.filter(([u]) => urlOf(u).pathname === '/api3.json')).toHaveLength(1);
  });
  it('annualizes the supported two-year ai term without inventing one-year registration pricing', async () => {
    const fetch = restOnly(() => search('owned.ai', [entry('140', '(price/2 year)')]));
    const result = await make(fetch).getPricing('OWNED.AI');
    expect(result).toMatchObject({ renewal: 70, currency: 'USD' });
    expect(result.registration).toBeUndefined();
    expect(urlOf(fetch.mock.calls[1][0]).pathname).toBe('/restful/v2/domains/owned.ai/search');
  });
  it('rejects a response for another domain', async () => {
    const fetch = restOnly(() => search('other.io', [entry()]));
    await expect(make(fetch).getPricing('owned.io')).rejects.toBeInstanceOf(InvalidResponseError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('propagates a REST cooldown without sending another request', async () => {
    const fetch = restOnly(
      () => new Response(null, { status: 429, headers: { 'Retry-After': '61' } })
    );
    await expect(make(fetch).getPricing('owned.io')).rejects.toMatchObject({
      name: RateLimitError.name,
      retryAfter: 61,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('preserves already-working exact legacy quotes without changing their source path', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(u => {
      expect(urlOf(u).pathname).toBe('/api3.json');
      return Promise.resolve(classic());
    });
    const provider = make(fetch);
    expect((await provider.getPricing('one.app')).renewal).toBe(180);
    expect((await provider.getPricing('two.app')).renewal).toBe(180);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('bounds incompatible-key and unsupported-TLD retries, and expires that capability cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetch = restOnly(() => unsupported());
    const provider = make(fetch);
    await expect(provider.getPricing('one.app')).rejects.toThrow(/unavailable/);
    await expect(provider.getPricing('two.app')).rejects.toThrow(/unavailable/);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 60 * 60_000 + 1);
    await expect(provider.getPricing('three.app')).rejects.toThrow(/unavailable/);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it.each([-1, '', ' ', 'not-price', '9'.repeat(400)])(
    'rejects malformed renewal value %s',
    async value => {
      const fetch = restOnly(() => search('owned.io', [entry(value)]));
      expect((await make(fetch).getPricing('owned.io')).renewal).toBeUndefined();
    }
  );
  it('does not treat an unknown multi-year term as annual', async () => {
    const fetch = restOnly(() => search('owned.io', [entry('270', '(price/3 year)')]));
    expect((await make(fetch).getPricing('owned.io')).renewal).toBeUndefined();
  });
});

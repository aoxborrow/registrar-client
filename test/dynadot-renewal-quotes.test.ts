import { describe, expect, it, vi } from 'vitest';
import { createRegistrar, RateLimitError, RegistrarError } from '../src/index';

const make = (fetcher: typeof fetch) =>
  createRegistrar(
    'dynadot',
    { apiKey: 'fixture-key', apiSecret: 'fixture-secret' },
    { fetch: fetcher, retries: 0 }
  );
const urlOf = (input: string | URL | Request) =>
  new URL(input instanceof Request ? input.url : input);
const quote = (fee: string) =>
  Response.json({
    RenewResponse: {
      Status: 'price_check_success',
      PriceInfo: `Renew Fee: ${fee} in USD, Total: ${fee} in USD`,
    },
  });
const available = () =>
  Response.json({
    code: 200,
    message: 'Success',
    data: {
      domain_name: 'fixture.com',
      available: 'Yes',
      price_list: [{ unit: '(price/1 year)', currency: 'USD', renewal_price: '14.25' }],
    },
  });

describe('Dynadot price-only renewal terms and retryable errors', () => {
  it.each([
    ['fixture.ai', '2', '160.00', 80],
    ['fixture.AI', '2', '160.00', 80],
    ['fixture.com', '1', '10.50', 10.5],
    ['fixture.ai', '2', '0.00', 0],
  ] as const)(
    'quotes %s for its supported term and reports an annual fee',
    async (name, years, fee, annual) => {
      const fetcher = vi.fn<typeof fetch>((input, init) => {
        const url = urlOf(input);
        expect(init?.method ?? 'GET').toBe('GET');
        expect(url.pathname).toBe('/api3.json');
        expect(url.searchParams.get('command')).toBe('renew');
        expect(url.searchParams.get('price_check')).toBe('1');
        expect(url.searchParams.get('duration')).toBe(years);
        return Promise.resolve(quote(fee));
      });
      expect(await make(fetcher).getPricing(name)).toMatchObject({
        currency: 'USD',
        renewal: annual,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );

  it.each([429, 503])('does not issue a fallback search after retryable HTTP %s', async status => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { message: 'Temporary provider response' },
          { status, headers: { 'Retry-After': '61' } }
        )
      );
    const result = make(fetcher).getPricing('fixture.com');
    if (status === 429)
      await expect(result).rejects.toMatchObject({ name: RateLimitError.name, retryAfter: 61 });
    else await expect(result).rejects.toBeInstanceOf(RegistrarError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses an overflowing fee and retains the optional available-name fallback', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(quote('9'.repeat(400)))
      .mockResolvedValueOnce(available());
    expect((await make(fetcher).getPricing('fixture.com')).renewal).toBe(14.25);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(urlOf(fetcher.mock.calls[1][0]).pathname).toBe('/restful/v2/domains/fixture.com/search');
  });

  it('still falls back for a non-owned name when the optional price check returns 404', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ message: 'Not found' }, { status: 404 }))
      .mockResolvedValueOnce(available());
    expect((await make(fetcher).getPricing('fixture.com')).renewal).toBe(14.25);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

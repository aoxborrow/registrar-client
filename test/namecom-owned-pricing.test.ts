import { describe, expect, it, vi } from 'vitest';
import { createRegistrar } from '../src/index';

const name = 'owned-price.in';
const pricing = (fetcher: typeof fetch, environment?: 'sandbox') =>
  createRegistrar(
    'namecom',
    { username: 'fixture-user', apiToken: 'fixture-token' },
    { fetch: fetcher, retries: 0, environment }
  );
describe('Name.com owned renewal pricing', () => {
  it('uses the exact owned one-year renewal quote when Core pricing rejects .in', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push(url);
      expect(init?.method ?? 'GET').toBe('GET');
      if (url.pathname.endsWith(':getPricing'))
        return Promise.resolve(Response.json({ message: 'TLD not supported' }, { status: 422 }));
      expect(url.pathname).toBe('/core/v1/domains');
      expect(url.searchParams.get('domainName')).toBe(name);
      expect(url.searchParams.get('includeRenewalPrice')).toBe('true');
      expect(url.searchParams.get('perPage')).toBe('1');
      return Promise.resolve(
        Response.json({
          domains: [{ domainName: name, renewalPrice: 21.42 }],
        })
      );
    });
    expect(await pricing(fetcher).getPricing(name)).toMatchObject({
      tld: 'in',
      currency: 'USD',
      renewal: 21.42,
    });
    expect(calls).toHaveLength(2);
  });
  it.each([null, -1, '21.42', undefined])(
    'never substitutes an invalid owned quote (%s)',
    async renewalPrice => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ message: 'TLD not supported' }, { status: 422 }))
        .mockResolvedValueOnce(Response.json({ domains: [{ domainName: name, renewalPrice }] }));
      await expect(pricing(fetcher).getPricing(name)).rejects.toMatchObject({
        status: 422,
      });
    }
  );
  it('refuses a quote for a different owned name', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ message: 'TLD not supported' }, { status: 422 }))
      .mockResolvedValueOnce(
        Response.json({
          domains: [{ domainName: 'other.in', renewalPrice: 21.42 }],
        })
      );
    await expect(pricing(fetcher).getPricing(name)).rejects.toMatchObject({
      status: 422,
    });
  });
  it.each([401, 403, 429, 500])(
    'does not bypass HTTP %s with an owned-domain lookup',
    async status => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ message: 'private upstream detail' }, { status }));
      await expect(pricing(fetcher).getPricing(name)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );
  it('keeps unsupported terms for other TLDs explicit', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message: 'unsupported term' }, { status: 422 }));
    await expect(pricing(fetcher).getPricing('owned-price.ai')).rejects.toMatchObject({
      status: 422,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps sandbox fallback requests in the sandbox', async () => {
    const fetcher = vi.fn<typeof fetch>(input => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.hostname).toBe('api.dev.name.com');
      return Promise.resolve(
        url.pathname.endsWith(':getPricing')
          ? Response.json({ message: 'TLD not supported' }, { status: 422 })
          : Response.json({ domains: [{ domainName: name, renewalPrice: 0 }] })
      );
    });
    expect((await pricing(fetcher, 'sandbox').getPricing(name)).renewal).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { createRegistrar, listPortfolio } from '../src/index';
import type { RequestConfig } from '../src/http';

function stubHttp(provider: unknown, handler: (req: RequestConfig) => unknown): void {
  (provider as { http: { request: (req: RequestConfig) => Promise<unknown> } }).http.request = (
    req: RequestConfig
  ) => Promise.resolve(handler(req));
}

describe('listPortfolio', () => {
  it('aggregates domains across registrars, tagging each with its registrar', async () => {
    const gd = createRegistrar('godaddy', { apiKey: 'k', apiSecret: 's' });
    stubHttp(gd, () => [{ domain: 'a.com' }, { domain: 'b.com' }]);

    const sp = createRegistrar('spaceship', { apiKey: 'k', apiSecret: 's' });
    stubHttp(sp, () => ({ items: [{ name: 'c.com' }] }));

    const { domains, errors } = await listPortfolio([gd, sp]);
    expect(errors).toEqual([]);
    expect(domains.map(d => d.domainName)).toEqual(['a.com', 'b.com', 'c.com']);
    expect(domains.map(d => d.registrar)).toEqual(['godaddy', 'godaddy', 'spaceship']);
  });

  it('isolates a failing registrar without dropping the others', async () => {
    const gd = createRegistrar('godaddy', { apiKey: 'k', apiSecret: 's' });
    stubHttp(gd, () => [{ domain: 'a.com' }]);

    const sp = createRegistrar('spaceship', { apiKey: 'k', apiSecret: 's' });
    stubHttp(sp, () => {
      throw new Error('boom');
    });

    const { domains, errors } = await listPortfolio([gd, sp]);
    expect(domains.map(d => d.domainName)).toEqual(['a.com']);
    expect(errors).toHaveLength(1);
    expect(errors[0].registrar).toBe('spaceship');
    expect(errors[0].error).toBeInstanceOf(Error);
  });

  it('forwards list options (search) to each source', async () => {
    const gd = createRegistrar('godaddy', { apiKey: 'k', apiSecret: 's' });
    stubHttp(gd, () => [{ domain: 'foo.com' }, { domain: 'bar.com' }]);
    const { domains } = await listPortfolio([gd], { search: 'foo' });
    expect(domains.map(d => d.domainName)).toEqual(['foo.com']);
  });
});

import { describe, it, expect } from 'vitest';
import { createRegistrar } from '../src/index';
import type { RequestConfig } from '../src/http';

// NameBright uses OAuth2: the first request fetches a bearer token, then the
// REST call runs. Stub both off the same handler.
function stubHttp(provider: unknown, handler: (req: RequestConfig) => unknown): RequestConfig[] {
  const calls: RequestConfig[] = [];
  (provider as { http: { request: (req: RequestConfig) => Promise<unknown> } }).http.request = (
    req: RequestConfig
  ) => {
    calls.push(req);
    return Promise.resolve(handler(req));
  };
  return calls;
}

function namebright() {
  return createRegistrar('namebright', { clientId: 'acct:app', clientSecret: 's' });
}

describe('NameBright provider', () => {
  it('listDomains paginates via domainsPerPage and maps status/privacy', async () => {
    const nb = namebright();
    const calls = stubHttp(nb, req => {
      if (req.path.includes('auth/token')) return { access_token: 't', expires_in: 1800 };
      const page = Number(req.query?.page ?? 1);
      if (page === 1) {
        // a full page of 100 must trigger a second page fetch
        return {
          Domains: Array.from({ length: 100 }, (_, i) => ({
            DomainName: `d${i}.com`,
            Status: 'active',
            ExpirationDate: '2027-01-01',
            WhoIsPrivacy: true,
            AutoRenew: true,
          })),
        };
      }
      return { Domains: [{ DomainName: 'last.com', ExpirationDate: '2027-01-01' }] };
    });

    const domains = await nb.listDomains();
    // 100 (full page) + 1 (partial page) = 101
    expect(domains).toHaveLength(101);
    const listCall = calls.find(c => c.path === 'account/domains');
    expect(listCall?.query).toMatchObject({ page: 1, domainsPerPage: 100 });
    expect(domains[0]).toMatchObject({ status: 'active', privacy: true, autoRenew: true });
  });

  it('listDomains caps at limit and filters by search', async () => {
    const nb = namebright();
    stubHttp(nb, req => {
      if (req.path.includes('auth/token')) return { access_token: 't', expires_in: 1800 };
      return { Domains: [{ DomainName: 'foo.com' }, { DomainName: 'bar.com' }] };
    });
    const matched = await nb.listDomains({ search: 'foo', limit: 5 });
    expect(matched.map(d => d.domainName)).toEqual(['foo.com']);
  });
});

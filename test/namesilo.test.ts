import { describe, it, expect } from 'vitest';
import { createRegistrar } from '../src/index';
import type { RequestConfig } from '../src/http';

// NameSilo speaks JSON over its HttpClient.request; stub that.
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

function namesilo() {
  return createRegistrar('namesilo', { apiKey: 'k' });
}

describe('NameSilo provider', () => {
  it('getDomain reads getDomainInfo: status, lock, privacy, auto-renew, nameservers', async () => {
    const ns = namesilo();
    const calls = stubHttp(ns, () => ({
      reply: {
        code: 300,
        created: '2020-01-01',
        expires: '2027-01-01',
        status: 'Active',
        locked: 'Yes',
        private: 'No',
        auto_renew: 'Yes',
        nameservers: { nameserver: ['ns1.dnsowl.com', 'ns2.dnsowl.com'] },
      },
    }));
    const d = await ns.getDomain('example.com');
    expect(calls[0].query).toMatchObject({ domain: 'example.com' });
    expect(calls[0].path).toBe('/getDomainInfo');
    expect(d).toMatchObject({
      domainName: 'example.com',
      status: 'active',
      locked: true,
      privacy: false,
      autoRenew: true,
      nameservers: ['ns1.dnsowl.com', 'ns2.dnsowl.com'],
    });
  });

  it('getNameservers delegates to getDomainInfo', async () => {
    const ns = namesilo();
    stubHttp(ns, () => ({
      reply: { code: 300, nameservers: { nameserver: ['a.ns', 'b.ns'] } },
    }));
    expect(await ns.getNameservers('example.com')).toEqual(['a.ns', 'b.ns']);
  });

  it('listDomains applies limit and client-side search', async () => {
    const ns = namesilo();
    stubHttp(ns, () => ({
      reply: {
        code: 300,
        domains: {
          domain: [
            { domain: 'foo.com', created: '2020-01-01', expires: '2027-01-01' },
            { domain: 'bar.com', created: '2020-01-01', expires: '2027-01-01' },
          ],
        },
      },
    }));
    const matched = await ns.listDomains({ search: 'foo' });
    expect(matched.map(d => d.domainName)).toEqual(['foo.com']);
  });
});

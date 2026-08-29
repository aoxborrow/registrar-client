import { describe, it, expect } from 'vitest';
import { createRegistrar } from '../src/index';
import type { RequestConfig } from '../src/http';

// Stub the provider's HttpClient so no network calls happen.
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

function gandi() {
  return createRegistrar('gandi', { apiKey: 'k' });
}

describe('Gandi provider', () => {
  it('listDomains maps nameserver.hosts, status-array lock, and boolean autorenew', async () => {
    const g = gandi();
    stubHttp(g, () => [
      {
        fqdn: 'example.com',
        status: ['clientTransferProhibited'],
        autorenew: true,
        dates: { created_at: '2020-01-01T00:00:00Z', registry_ends_at: '2027-01-01T00:00:00Z' },
        nameserver: { current: 'other', hosts: ['ns1.example.net', 'ns2.example.net'] },
      },
    ]);
    const domains = await g.listDomains();
    expect(domains[0]).toMatchObject({
      domainName: 'example.com',
      locked: true,
      autoRenew: true,
      nameservers: ['ns1.example.net', 'ns2.example.net'],
    });
    expect(domains[0].expirationDate?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('listDomains tolerates the object autorenew shape and legacy nameservers array', async () => {
    const g = gandi();
    stubHttp(g, () => [
      {
        fqdn: 'legacy.com',
        status: 'active',
        autorenew: { enabled: false },
        nameservers: ['ns1.legacy.net'],
      },
    ]);
    const domains = await g.listDomains();
    expect(domains[0]).toMatchObject({
      autoRenew: false,
      locked: false,
      nameservers: ['ns1.legacy.net'],
    });
  });

  it('listDomains sends the fqdn wildcard filter and re-filters by search', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => [{ fqdn: 'foo.com' }, { fqdn: 'bar.com' }]);
    const filtered = await g.listDomains({ search: 'foo' });
    expect(calls[0].query).toMatchObject({ fqdn: '*foo*' });
    expect(filtered.map(d => d.domainName)).toEqual(['foo.com']);
  });
});

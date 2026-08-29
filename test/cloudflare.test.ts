import { describe, it, expect } from 'vitest';
import { createRegistrar, NotImplementedError } from '../src/index';
import type { RequestConfig } from '../src/http';

// Stub the provider's HttpClient. `handler` receives each RequestConfig and
// returns the canned JSON body (keyed off method+path for multi-call flows).
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

function cloudflare() {
  return createRegistrar('cloudflare', { apiToken: 't', accountId: 'acct-1' });
}

describe('Cloudflare provider', () => {
  it('getDomain GETs the registrar domain and maps the envelope result', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, () => ({
      success: true,
      result: {
        id: 'dom-1',
        name: 'example.com',
        status: 'active',
        created_at: '2020-01-01T00:00:00Z',
        expires_at: '2027-01-01T00:00:00Z',
        auto_renew: true,
        locked: true,
        name_servers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
      },
    }));
    const d = await cf.getDomain('example.com');
    expect(calls[0].path).toBe('/accounts/acct-1/registrar/domains/example.com');
    expect(d).toMatchObject({
      domainName: 'example.com',
      status: 'active',
      autoRenew: true,
      locked: true,
      privacy: true, // Cloudflare includes WHOIS privacy by default
      nameservers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
    });
    expect(d.expirationDate?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('getDomain throws when the API reports failure', async () => {
    const cf = cloudflare();
    stubHttp(cf, () => ({ success: false, errors: [{ message: 'not found' }] }));
    await expect(cf.getDomain('missing.com')).rejects.toThrow(/not found/);
  });

  it('getNameservers reads name_servers from the matching zone', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, () => ({
      success: true,
      result: [
        {
          id: 'zone-1',
          name: 'example.com',
          name_servers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
        },
      ],
    }));
    const ns = await cf.getNameservers('example.com');
    expect(calls[0]).toMatchObject({ path: '/zones', query: { name: 'example.com' } });
    expect(ns).toEqual(['ns1.cloudflare.com', 'ns2.cloudflare.com']);
  });

  it('getNameservers throws when the domain is not a zone in the account', async () => {
    const cf = cloudflare();
    stubHttp(cf, () => ({ success: true, result: [] }));
    await expect(cf.getNameservers('example.com')).rejects.toThrow(/not a zone/);
  });

  it('getDnsRecords resolves zone_id then lists and maps records', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, req => {
      if (req.path === '/zones') {
        return { success: true, result: [{ id: 'zone-1', name: 'example.com' }] };
      }
      return {
        success: true,
        result: [
          { type: 'A', name: 'example.com', content: '1.2.3.4', ttl: 3600 },
          { type: 'MX', name: 'example.com', content: 'mail.example.com', ttl: 3600, priority: 10 },
          {
            type: 'SRV',
            name: '_sip._tcp.example.com',
            content: '5 5060 sip.example.com',
            ttl: 3600,
            data: { priority: 1, weight: 5, port: 5060 },
          },
        ],
      };
    });
    const records = await cf.getDnsRecords('example.com');
    // first the zone lookup, then the dns_records list keyed on the resolved id
    expect(calls[0]).toMatchObject({ path: '/zones', query: { name: 'example.com' } });
    expect(calls[1].path).toBe('/zones/zone-1/dns_records');
    expect(records).toEqual([
      { type: 'A', name: 'example.com', value: '1.2.3.4', ttl: 3600 },
      { type: 'MX', name: 'example.com', value: 'mail.example.com', ttl: 3600, priority: 10 },
      {
        type: 'SRV',
        name: '_sip._tcp.example.com',
        value: '5 5060 sip.example.com',
        ttl: 3600,
        priority: 1,
        weight: 5,
        port: 5060,
      },
    ]);
  });

  it('getContacts throws NotImplementedError (no WHOIS contact API)', async () => {
    const cf = cloudflare();
    await expect(cf.getContacts('example.com')).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('getPricing throws NotImplementedError (at-cost, no pricing API)', async () => {
    const cf = cloudflare();
    await expect(cf.getPricing('com')).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('checkAvailability throws NotImplementedError (no availability API)', async () => {
    const cf = cloudflare();
    await expect(cf.checkAvailability(['example.com'])).rejects.toBeInstanceOf(NotImplementedError);
  });
});

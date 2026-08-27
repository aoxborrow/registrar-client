import { describe, it, expect } from 'vitest';
import { createRegistrar, NotImplementedError } from '../src/index';
import type { RequestConfig } from '../src/http';

// Stub the provider's HttpClient so no network calls happen. `handler` receives
// each RequestConfig and returns the canned response body.
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

function godaddy() {
  return createRegistrar('godaddy', { apiKey: 'k', apiSecret: 's' });
}

describe('GoDaddy provider', () => {
  it('checkAvailability normalizes micro-unit prices to major units', async () => {
    const gd = godaddy();
    stubHttp(gd, () => ({
      domains: [
        { domain: 'example.com', available: true, price: 11_990_000, currency: 'USD', period: 1 },
        { domain: 'taken.com', available: false },
      ],
    }));

    const result = await gd.checkAvailability(['example.com', 'taken.com']);
    expect(result).toEqual([
      { domainName: 'example.com', available: true, price: 11.99, currency: 'USD', period: 1 },
      {
        domainName: 'taken.com',
        available: false,
        price: undefined,
        currency: undefined,
        period: undefined,
      },
    ]);
  });

  it('getContacts maps GoDaddy contact shape to the normalized Contact', async () => {
    const gd = godaddy();
    stubHttp(gd, () => ({
      domain: 'example.com',
      contactRegistrant: {
        nameFirst: 'Ada',
        nameLast: 'Lovelace',
        organization: 'Analytical Engines',
        email: 'ada@example.com',
        phone: '+1.4805551234',
        addressMailing: {
          address1: '1 Byron Way',
          city: 'London',
          state: '',
          postalCode: 'EC1',
          country: 'GB',
        },
      },
    }));

    const contacts = await gd.getContacts('example.com');
    expect(contacts.registrant).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      organization: 'Analytical Engines',
      email: 'ada@example.com',
      phone: '+1.4805551234',
      fax: undefined,
      address1: '1 Byron Way',
      address2: undefined,
      city: 'London',
      state: '',
      postalCode: 'EC1',
      country: 'GB',
    });
    // absent roles come back undefined
    expect(contacts.admin).toBeUndefined();
  });

  it('getDnsRecords maps data to value; setDnsRecords maps value to data with a default TTL', async () => {
    const gd = godaddy();
    const getCalls = stubHttp(gd, () => [
      { type: 'A', name: '@', data: '203.0.113.10', ttl: 600 },
      { type: 'MX', name: '@', data: 'mail.example.com', ttl: 3600, priority: 10 },
    ]);
    const records = await gd.getDnsRecords('example.com');
    expect(records[0]).toMatchObject({ type: 'A', name: '@', value: '203.0.113.10', ttl: 600 });
    expect(records[1]).toMatchObject({ type: 'MX', value: 'mail.example.com', priority: 10 });
    expect(getCalls[0].path).toContain('/records');

    const putCalls = stubHttp(gd, () => '');
    await gd.setDnsRecords('example.com', [{ type: 'a', name: 'www', value: '203.0.113.20' }]);
    expect(putCalls[0].method).toBe('PUT');
    expect(putCalls[0].body).toEqual([{ type: 'A', name: 'www', data: '203.0.113.20', ttl: 3600 }]);
  });

  it('setAutoRenew PATCHes renewAuto', async () => {
    const gd = godaddy();
    const calls = stubHttp(gd, () => '');
    const res = await gd.setAutoRenew('example.com', true);
    expect(res.success).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { renewAuto: true } });
  });

  it('getPricing throws for a bare TLD', async () => {
    const gd = godaddy();
    await expect(gd.getPricing('com')).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('setPrivacy disables via DELETE but refuses to enable', async () => {
    const gd = godaddy();
    const calls = stubHttp(gd, () => '');
    const off = await gd.setPrivacy('example.com', false);
    expect(off.success).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'DELETE' });
    await expect(gd.setPrivacy('example.com', true)).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('BaseRegistrar defaults', () => {
  it('unimplemented core methods reject with NotImplementedError', async () => {
    // cloudflare does not override these, so they fall through to BaseRegistrar
    const cf = createRegistrar('cloudflare', { apiToken: 'x', accountId: 'y' });
    await expect(cf.getContacts('example.com')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(cf.getDnsRecords('example.com')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(cf.getPricing('com')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(cf.registerDomain('example.com', { contacts: {} })).rejects.toBeInstanceOf(
      NotImplementedError
    );
  });
});

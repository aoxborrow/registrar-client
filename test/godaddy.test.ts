import { describe, it, expect } from 'vitest';
import { createRegistrar, ConsentRequiredError, NotImplementedError } from '../src/index';
import type { RequestConfig } from '../src/http';
import type { Contact } from '../src/index';

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

  it('listDomains folds nameservers into one call via includes and maps them', async () => {
    const gd = godaddy();
    const calls = stubHttp(gd, () => [
      {
        domain: 'a.com',
        expires: '2027-01-01T00:00:00Z',
        renewAuto: true,
        locked: true,
        nameServers: ['ns1.example.net', 'ns2.example.net'],
      },
    ]);
    const domains = await gd.listDomains();
    expect(calls[0].path).toContain('includes=nameServers');
    expect(domains[0]).toMatchObject({
      domainName: 'a.com',
      autoRenew: true,
      locked: true,
      nameservers: ['ns1.example.net', 'ns2.example.net'],
    });
  });

  it('listDomains sends limit in the query, caps results, and filters by search', async () => {
    const gd = godaddy();
    const calls = stubHttp(gd, () => [
      { domain: 'foo.com' },
      { domain: 'bar.com' },
      { domain: 'foobar.com' },
    ]);
    const capped = await gd.listDomains({ limit: 2 });
    expect(calls[0].path).toContain('limit=2');
    expect(capped).toHaveLength(2);

    const matched = await gd.listDomains({ search: 'foo' });
    expect(matched.map(d => d.domainName)).toEqual(['foo.com', 'foobar.com']);
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

  it('registerDomain fetches agreements then purchases with a consent block', async () => {
    const gd = godaddy();
    const registrant: Contact = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+1.4805551234',
      address1: '1 Byron Way',
      city: 'London',
      state: 'LDN',
      postalCode: 'EC1',
      country: 'GB',
    };
    const calls = stubHttp(gd, req => {
      if (req.path === '/domains/agreements')
        return [{ agreementKey: 'DNRA' }, { agreementKey: 'DPA' }];
      return { orderId: 1 };
    });

    const res = await gd.registerDomain('example.com', {
      years: 2,
      contacts: { registrant },
      consent: { agreedBy: '203.0.113.7', agreedAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(res.success).toBe(true);

    // first call fetches agreements for the TLD
    expect(calls[0]).toMatchObject({
      path: '/domains/agreements',
      query: { tlds: 'com', privacy: false },
    });
    // second call is the purchase carrying the consent block + contacts
    const purchase = calls[1];
    expect(purchase).toMatchObject({ method: 'POST', path: '/domains/purchase' });
    const body = purchase.body as {
      consent: { agreementKeys: string[]; agreedBy: string; agreedAt: string };
      contactRegistrant: { nameFirst: string };
      contactAdmin: { nameFirst: string };
      period: number;
    };
    expect(body.consent).toEqual({
      agreementKeys: ['DNRA', 'DPA'],
      agreedBy: '203.0.113.7',
      agreedAt: '2026-01-01T00:00:00.000Z',
    });
    // omitted roles fall back to the registrant
    expect(body.contactAdmin.nameFirst).toBe('Ada');
    expect(body.period).toBe(2);
  });

  it('registerDomain rejects when consent is missing', async () => {
    const gd = godaddy();
    stubHttp(gd, () => []);
    await expect(
      gd.registerDomain('example.com', {
        contacts: {
          registrant: {
            firstName: 'A',
            lastName: 'B',
            email: 'a@b.com',
            phone: '+1.1',
            address1: 'x',
            city: 'y',
            postalCode: 'z',
            country: 'US',
          },
        },
      })
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('transferIn fetches transfer agreements then POSTs authCode + consent', async () => {
    const gd = godaddy();
    const calls = stubHttp(gd, req => {
      if (req.path === '/domains/agreements') return [{ agreementKey: 'DTRA' }];
      return { orderId: 2 };
    });
    const res = await gd.transferIn('example.com', {
      authCode: 'EPP123',
      years: 1,
      consent: { agreedBy: '203.0.113.7', agreedAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(res.success).toBe(true);
    // agreements are fetched with forTransfer=true
    expect(calls[0]).toMatchObject({
      path: '/domains/agreements',
      query: { tlds: 'com', privacy: false, forTransfer: true },
    });
    const transfer = calls[1];
    expect(transfer).toMatchObject({ method: 'POST', path: '/domains/example.com/transfer' });
    const body = transfer.body as {
      authCode: string;
      consent: { agreementKeys: string[]; agreedBy: string };
      period: number;
    };
    expect(body.authCode).toBe('EPP123');
    expect(body.consent).toEqual({
      agreementKeys: ['DTRA'],
      agreedBy: '203.0.113.7',
      agreedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(body.period).toBe(1);
  });

  it('transferIn rejects when consent is missing', async () => {
    const gd = godaddy();
    stubHttp(gd, () => []);
    await expect(gd.transferIn('example.com', { authCode: 'EPP123' })).rejects.toBeInstanceOf(
      ConsentRequiredError
    );
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

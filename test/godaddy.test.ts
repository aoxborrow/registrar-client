import { describe, it, expect } from 'vitest';
import {
  createRegistrar,
  ConsentRequiredError,
  NotFoundError,
  NotImplementedError,
} from '../src/index';
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

  it('paginates at GoDaddy’s max page size and filters by search client-side', async () => {
    const gd = godaddy();
    // a short page (< max) terminates pagination
    const calls = stubHttp(gd, () => [
      { domain: 'foo.com' },
      { domain: 'bar.com' },
      { domain: 'foobar.com' },
    ]);
    const all = await gd.listDomains();
    expect(calls[0].path).toContain('limit=1000'); // GoDaddy's max page size
    expect(all).toHaveLength(3);

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
      if (req.path === '/v1/domains/agreements')
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
      path: '/v1/domains/agreements',
      query: { tlds: 'com', privacy: false },
    });
    // second call is the purchase carrying the consent block + contacts
    const purchase = calls[1];
    expect(purchase).toMatchObject({ method: 'POST', path: '/v1/domains/purchase' });
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
      if (req.path === '/v1/domains/agreements') return [{ agreementKey: 'DTRA' }];
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
      path: '/v1/domains/agreements',
      query: { tlds: 'com', privacy: false, forTransfer: true },
    });
    const transfer = calls[1];
    expect(transfer).toMatchObject({ method: 'POST', path: '/v1/domains/example.com/transfer' });
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
    // cloudflare does not override these writes, so they fall through to BaseRegistrar
    const cf = createRegistrar('cloudflare', { apiToken: 'x', accountId: 'y' });
    await expect(cf.updateContacts('example.com', {})).rejects.toBeInstanceOf(NotImplementedError);
    await expect(cf.setDnsRecords('example.com', [])).rejects.toBeInstanceOf(NotImplementedError);
    await expect(cf.setPrivacy('example.com', true)).rejects.toBeInstanceOf(NotImplementedError);
    await expect(cf.registerDomain('example.com', { contacts: {} })).rejects.toBeInstanceOf(
      NotImplementedError
    );
    // extended methods default to NotImplementedError too, unless a provider declares them
    await expect(cf.getEmailForwarding('example.com')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(cf.setEmailForwarding('example.com', [])).rejects.toBeInstanceOf(
      NotImplementedError
    );
    await expect(cf.getDomainForwarding('example.com')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(cf.setDomainForwarding('example.com', [])).rejects.toBeInstanceOf(
      NotImplementedError
    );
  });

  // --- extended: domain forwarding ---

  it('getDomainForwarding maps fqdn/type to host and forward type', async () => {
    const gd = godaddy();
    const calls = stubHttp(gd, () => [
      { fqdn: 'example.com', type: 'REDIRECT_PERMANENT', url: 'https://a.com' },
      { fqdn: 'blog.example.com', type: 'REDIRECT_TEMPORARY', url: 'https://b.com' },
      { fqdn: 'app.example.com', type: 'MASKED', url: 'https://c.com' },
    ]);
    expect(await gd.getDomainForwarding('example.com')).toEqual([
      { host: '@', url: 'https://a.com', type: 'permanent' },
      { host: 'blog', url: 'https://b.com', type: 'redirect' },
      { host: 'app', url: 'https://c.com', type: 'frame' },
    ]);
    expect(calls[0]).toMatchObject({
      path: '/v1/domains/forwards/example.com',
      query: { includeSubs: true },
    });
  });

  it('getDomainForwarding returns [] on a 404 (no forwarding configured)', async () => {
    const gd = godaddy();
    stubHttp(gd, () => {
      throw new NotFoundError('not found');
    });
    expect(await gd.getDomainForwarding('example.com')).toEqual([]);
  });

  it('setDomainForwarding PUTs desired fqdns and deletes removed ones', async () => {
    const gd = godaddy();
    const calls = stubHttp(gd, req => {
      if (req.method === undefined && String(req.path).includes('/forwards/')) {
        // the read of current forwards
        return [{ fqdn: 'old.example.com', type: 'REDIRECT_PERMANENT', url: 'https://old.com' }];
      }
      return undefined;
    });
    const res = await gd.setDomainForwarding('example.com', [
      { host: '@', url: 'https://root.com', type: 'permanent' },
      { host: 'app', url: 'https://app.com', type: 'frame' },
    ]);
    expect(res.success).toBe(true);
    const writes = calls.filter(c => c.method === 'PUT' || c.method === 'DELETE');
    expect(writes.map(c => `${c.method} ${c.path}`)).toEqual([
      'DELETE /v1/domains/forwards/old.example.com',
      'PUT /v1/domains/forwards/example.com',
      'PUT /v1/domains/forwards/app.example.com',
    ]);
    const put0 = writes.find(c => c.path === '/v1/domains/forwards/example.com');
    expect(put0?.body).toEqual({ type: 'REDIRECT_PERMANENT', url: 'https://root.com' });
    const put1 = writes.find(c => c.path === '/v1/domains/forwards/app.example.com');
    const body1 = put1?.body as { type: string; url: string; mask?: object };
    expect(body1).toMatchObject({ type: 'MASKED', url: 'https://app.com' });
    expect(body1.mask).toBeTypeOf('object');
  });

  it('setDomainForwarding with an empty list deletes existing forwards', async () => {
    const gd = godaddy();
    const calls = stubHttp(gd, req => {
      if (req.method === undefined)
        return [{ fqdn: 'example.com', type: 'REDIRECT_PERMANENT', url: 'x' }];
      return undefined;
    });
    await gd.setDomainForwarding('example.com', []);
    expect(
      calls.some(c => c.method === 'DELETE' && c.path === '/v1/domains/forwards/example.com')
    ).toBe(true);
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });
});

// A PAT (apiToken) + production selects the modern v3 API surface.
function godaddyV3() {
  return createRegistrar('godaddy', { apiToken: 't' });
}

// read the Authorization header the provider configured on its HttpClient
function authHeaderOf(provider: unknown): string | undefined {
  return (provider as { http: { config: { headers?: Record<string, string> } } }).http.config
    .headers?.Authorization;
}

describe('GoDaddy auth + environment routing', () => {
  it('uses a Bearer header when a PAT is supplied', () => {
    expect(authHeaderOf(godaddyV3())).toBe('Bearer t');
  });

  it('uses an sso-key header when apiKey + apiSecret are supplied', () => {
    expect(authHeaderOf(godaddy())).toBe('sso-key k:s');
  });

  it('defaults to an sso-key header (rejected at request time) when no creds are supplied', () => {
    // construction stays lenient like the other providers; auth fails on the wire
    expect(authHeaderOf(createRegistrar('godaddy', {}))).toBe('sso-key :');
  });

  it('falls back to v1 in the sandbox even with a PAT (OTE has no v3)', async () => {
    const gd = createRegistrar('godaddy', { apiToken: 't' }, { environment: 'sandbox' });
    const calls = stubHttp(gd, () => []);
    await gd.listDomains();
    expect(calls[0].path).toContain('/v1/domains');
    // sandbox base host is OTE
    expect((gd as unknown as { http: { config: { baseUrl: string } } }).http.config.baseUrl).toBe(
      'https://api.ote-godaddy.com'
    );
  });
});

describe('GoDaddy v3 provider (production + PAT)', () => {
  it('checkAvailability reads v3 prices (minor units → major) and premium inventory', async () => {
    const gd = godaddyV3();
    const calls = stubHttp(gd, () => ({
      items: [
        {
          domain: 'example.com',
          available: true,
          inventory: 'REGISTRY',
          prices: [{ period: 1, price: { currencyCode: 'USD', value: 1199 } }],
        },
        {
          domain: 'premium.com',
          available: true,
          inventory: 'PREMIUM',
          prices: [{ period: 1, price: { currencyCode: 'USD', value: 500000 } }],
        },
        { domain: 'taken.com', available: false },
      ],
    }));
    const result = await gd.checkAvailability(['example.com', 'premium.com', 'taken.com']);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/v3/domains/check-availability',
      body: { domains: ['example.com', 'premium.com', 'taken.com'] },
    });
    expect(result[0]).toEqual({
      domainName: 'example.com',
      available: true,
      premium: false,
      price: 11.99,
      currency: 'USD',
      period: 1,
    });
    expect(result[1]).toMatchObject({ premium: true, price: 5000 });
    expect(result[2]).toMatchObject({ available: false, price: undefined });
  });

  it('getPricing reports registration and renewal from v3 terms', async () => {
    const gd = godaddyV3();
    stubHttp(gd, () => ({
      items: [
        {
          domain: 'example.com',
          available: true,
          prices: [
            {
              period: 1,
              price: { currencyCode: 'USD', value: 1199 },
              renewalPrice: { currencyCode: 'USD', value: 1999 },
            },
          ],
        },
      ],
    }));
    expect(await gd.getPricing('example.com')).toEqual({
      tld: 'com',
      currency: 'USD',
      registration: 11.99,
      renewal: 19.99,
    });
  });

  it('listDomains follows the rel="next" link and maps transferLock → locked', async () => {
    const gd = godaddyV3();
    let page = 0;
    const calls = stubHttp(gd, () => {
      page += 1;
      if (page === 1) {
        return {
          items: [
            {
              domain: 'a.com',
              transferLock: true,
              autoRenew: true,
              expiresAt: '2027-01-01T00:00:00Z',
              nameServers: ['ns1.x.net'],
            },
          ],
          links: [{ rel: 'next', href: 'https://api.godaddy.com/v3/domains/domain-names?pt=2' }],
        };
      }
      return { items: [{ domain: 'b.com' }], links: [] };
    });
    const domains = await gd.listDomains();
    expect(calls[0].path).toBe('/v3/domains/domain-names');
    expect(calls[1].path).toBe('https://api.godaddy.com/v3/domains/domain-names?pt=2');
    expect(domains.map(d => d.domainName)).toEqual(['a.com', 'b.com']);
    expect(domains[0]).toMatchObject({ locked: true, autoRenew: true, nameservers: ['ns1.x.net'] });
  });

  it('getDomain reads the v3 domain-names resource', async () => {
    const gd = godaddyV3();
    const calls = stubHttp(gd, () => ({
      domain: 'example.com',
      transferLock: false,
      privacy: true,
      renewBy: '2027-02-01T00:00:00Z',
    }));
    const d = await gd.getDomain('example.com');
    expect(calls[0].path).toBe('/v3/domains/domain-names/example.com');
    expect(d).toMatchObject({ domainName: 'example.com', locked: false, privacy: true });
  });

  it('updateNameservers PUTs a bare array to the v3 nameservers subresource', async () => {
    const gd = godaddyV3();
    const calls = stubHttp(gd, () => '');
    await gd.updateNameservers('example.com', ['ns1.x.net', 'ns2.x.net']);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/v3/domains/domain-names/example.com/nameservers',
      body: ['ns1.x.net', 'ns2.x.net'],
    });
  });

  it('getDnsRecords reads v3 zone records (items) and maps data → value', async () => {
    const gd = godaddyV3();
    const calls = stubHttp(gd, () => ({
      items: [{ recordId: 'r1', type: 'A', name: '@', data: '203.0.113.10', ttl: 600 }],
      links: [],
    }));
    const records = await gd.getDnsRecords('example.com');
    expect(calls[0].path).toBe('/v3/domains/zones/example.com/dns-records');
    expect(records[0]).toMatchObject({ type: 'A', name: '@', value: '203.0.113.10', ttl: 600 });
  });

  it('setDnsRecords diffs against current records: delete removed, add new, keep matched', async () => {
    const gd = godaddyV3();
    const calls = stubHttp(gd, req => {
      // the GET of current records (no method set by getV3Records)
      if (req.method === undefined && String(req.path).includes('/dns-records')) {
        return {
          items: [
            { recordId: 'keep', type: 'A', name: '@', data: '203.0.113.10', ttl: 3600 },
            { recordId: 'drop', type: 'TXT', name: '@', data: 'old', ttl: 3600 },
          ],
          links: [],
        };
      }
      return '';
    });
    const res = await gd.setDnsRecords('example.com', [
      { type: 'A', name: '@', value: '203.0.113.10' }, // unchanged → no write
      { type: 'CNAME', name: 'www', value: 'example.com' }, // new → POST
    ]);
    expect(res.success).toBe(true);
    const writes = calls
      .filter(c => c.method === 'DELETE' || c.method === 'POST' || c.method === 'PUT')
      .map(c => `${c.method} ${c.path}`);
    expect(writes).toEqual([
      'DELETE /v3/domains/zones/example.com/dns-records/drop',
      'POST /v3/domains/zones/example.com/dns-records',
    ]);
  });

  it('registerDomain runs the v3 quote → execute → poll flow', async () => {
    const gd = godaddyV3();
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
      if (req.path === '/v3/domains/registration-quotes') {
        return {
          quoteToken: 'QT',
          requiredAgreements: [{ agreementType: 'DNRA' }],
          fees: [{ type: 'ICANN_FEE', fee: { currencyCode: 'USD', value: 18 } }],
        };
      }
      if (req.path === '/v3/domains/registrations')
        return { operationId: 'OP1', status: 'PENDING' };
      if (String(req.path).includes('/operations/')) return { status: 'COMPLETED' };
      return {};
    });
    const res = await gd.registerDomain('example.com', {
      years: 2,
      contacts: { registrant },
      consent: { agreedBy: '203.0.113.7', agreedAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(res.success).toBe(true);
    const register = calls.find(c => c.path === '/v3/domains/registrations');
    const body = register?.body as {
      quoteToken: string;
      period: number;
      consent: { agreementTypes: string[]; acknowledgedFees: unknown[]; agreedBy: string };
      profile: { contacts: { registrant: { firstName: string }; admin: { firstName: string } } };
    };
    expect(body.quoteToken).toBe('QT');
    expect(body.period).toBe(2);
    expect(body.consent.agreementTypes).toEqual(['DNRA']);
    expect(body.consent.acknowledgedFees).toEqual([
      { type: 'ICANN_FEE', fee: { currencyCode: 'USD', value: 18 } },
    ]);
    expect(body.profile.contacts.registrant.firstName).toBe('Ada');
    // omitted admin role falls back to the registrant
    expect(body.profile.contacts.admin.firstName).toBe('Ada');
    // the async operation was polled
    expect(calls.some(c => String(c.path).includes('/operations/OP1'))).toBe(true);
  });

  it('registerDomain (v3) rejects when consent is missing', async () => {
    const gd = godaddyV3();
    stubHttp(gd, () => ({}));
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
});

import { describe, it, expect } from 'vitest';
import { createRegistrar, ConsentRequiredError, NotImplementedError } from '../src/index';
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

function spaceship() {
  return createRegistrar('spaceship', { apiKey: 'k', apiSecret: 's' });
}

describe('Spaceship provider', () => {
  it('toDomain maps lifecycleStatus, eppStatuses lock, privacy level, ns hosts', async () => {
    const sp = spaceship();
    stubHttp(sp, () => ({
      name: 'example.com',
      lifecycleStatus: 'registered',
      registrationDate: '2020-01-01T00:00:00Z',
      expirationDate: '2027-01-01T00:00:00Z',
      autoRenew: true,
      eppStatuses: ['clientTransferProhibited', 'clientUpdateProhibited'],
      privacyProtection: { contactForm: true, level: 'high' },
      nameservers: { provider: 'custom', hosts: ['ns1.example.net', 'ns2.example.net'] },
    }));
    const d = await sp.getDomain('example.com');
    expect(d).toMatchObject({
      domainName: 'example.com',
      status: 'registered',
      autoRenew: true,
      locked: true,
      privacy: true,
      nameservers: ['ns1.example.net', 'ns2.example.net'],
    });
    expect(d.expirationDate?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('listDomains caps take at limit and filters by search client-side', async () => {
    const sp = spaceship();
    const calls = stubHttp(sp, () => ({ items: [{ name: 'foo.com' }, { name: 'bar.com' }] }));

    const capped = await sp.listDomains({ limit: 5 });
    expect(calls[0].query).toMatchObject({ take: 5, skip: 0 });
    expect(capped).toHaveLength(2);

    const matched = await sp.listDomains({ search: 'foo' });
    expect(matched.map(d => d.domainName)).toEqual(['foo.com']);
  });

  it('checkAvailability maps the result enum and premium register price', async () => {
    const sp = spaceship();
    const calls = stubHttp(sp, () => ({
      domains: [
        { domain: 'example.com', result: 'available', premiumPricing: [] },
        {
          domain: 'rich.com',
          result: 'available',
          premiumPricing: [
            { operation: 'register', price: 2500, currency: 'USD' },
            { operation: 'renew', price: 2500, currency: 'USD' },
          ],
        },
        { domain: 'taken.com', result: 'taken' },
      ],
    }));
    const results = await sp.checkAvailability(['example.com', 'rich.com', 'taken.com']);
    expect(results[0]).toMatchObject({
      domainName: 'example.com',
      available: true,
      premium: false,
    });
    expect(results[0].price).toBeUndefined();
    expect(results[1]).toMatchObject({
      available: true,
      premium: true,
      price: 2500,
      currency: 'USD',
    });
    expect(results[2]).toMatchObject({ domainName: 'taken.com', available: false });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/domains/available' });
    expect((calls[0].body as { domains: string[] }).domains).toHaveLength(3);
  });

  it('getPricing throws NotImplementedError (no pricing endpoint)', async () => {
    const sp = spaceship();
    await expect(sp.getPricing('com')).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('setAutoRenew PUTs isEnabled', async () => {
    const sp = spaceship();
    const calls = stubHttp(sp, () => '');
    await sp.setAutoRenew('example.com', true);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/v1/domains/example.com/autorenew',
      body: { isEnabled: true },
    });
  });

  it('lockDomain PUTs isLocked to /transfer/lock', async () => {
    const sp = spaceship();
    const calls = stubHttp(sp, () => '');
    const res = await sp.lockDomain('example.com');
    expect(res.success).toBe(true);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/v1/domains/example.com/transfer/lock',
      body: { isLocked: true },
    });
  });

  it('updateNameservers wraps hosts under provider=custom', async () => {
    const sp = spaceship();
    const calls = stubHttp(sp, () => '');
    await sp.updateNameservers('example.com', ['ns1.x.net', 'ns2.x.net']);
    expect(calls[0].body).toEqual({ provider: 'custom', hosts: ['ns1.x.net', 'ns2.x.net'] });
  });

  it('setPrivacy maps enabled to privacyLevel + userConsent', async () => {
    const sp = spaceship();
    const calls = stubHttp(sp, () => '');
    await sp.setPrivacy('example.com', true);
    await sp.setPrivacy('example.com', false);
    expect(calls[0].body).toEqual({ privacyLevel: 'high', userConsent: true });
    expect(calls[1].body).toEqual({ privacyLevel: 'public', userConsent: false });
  });

  it('renewDomain fetches expiration then POSTs years + currentExpirationDate', async () => {
    const sp = spaceship();
    const calls = stubHttp(sp, req => {
      if (req.method === undefined || req.method === 'GET') {
        return { name: 'example.com', expirationDate: '2027-01-01T00:00:00Z' };
      }
      return '';
    });
    const res = await sp.renewDomain('example.com', 2);
    expect(res.success).toBe(true);
    expect(calls[1]).toMatchObject({
      method: 'POST',
      path: '/v1/domains/example.com/renew',
      body: { years: 2, currentExpirationDate: '2027-01-01T00:00:00Z' },
    });
  });

  it('getContacts resolves referenced contact ids in the domain', async () => {
    const sp = spaceship();
    stubHttp(sp, req => {
      if (req.path === '/v1/domains/example.com') {
        return { name: 'example.com', contacts: { registrant: 'c-1', admin: 'c-1' } };
      }
      return {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        phone: '+1.5551234',
        address1: '1 Byron Way',
        city: 'London',
        stateProvince: 'LDN',
        postalCode: 'EC1',
        country: 'GB',
      };
    });
    const contacts = await sp.getContacts('example.com');
    expect(contacts.registrant).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      state: 'LDN',
      country: 'GB',
    });
    expect(contacts.admin?.firstName).toBe('Ada');
    expect(contacts.tech).toBeUndefined();
  });

  it('updateContacts saves each role then assigns ids, requiring a registrant', async () => {
    const sp = spaceship();
    let n = 0;
    const calls = stubHttp(sp, req => {
      if (req.path === '/v1/contacts') return { contactId: `c-${++n}` };
      return '';
    });
    const res = await sp.updateContacts('example.com', {
      registrant: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        phone: '+1.5551234',
        address1: '1 Byron Way',
        city: 'London',
        postalCode: 'EC1',
        country: 'GB',
      },
    });
    expect(res.success).toBe(true);
    // one saveContact call, then the assign with the registrant id reused for all roles
    const assign = calls.find(c => c.path === '/v1/domains/example.com/contacts');
    expect(assign?.body).toEqual({ registrant: 'c-1', admin: 'c-1', tech: 'c-1', billing: 'c-1' });

    await expect(sp.updateContacts('example.com', {})).rejects.toThrow(/registrant/);
  });

  it('getDnsRecords maps per-type values (address/cname/exchange+preference)', async () => {
    const sp = spaceship();
    stubHttp(sp, () => ({
      total: 3,
      items: [
        { type: 'A', name: '@', address: '1.2.3.4', ttl: 3600 },
        { type: 'CNAME', name: 'www', cname: 'example.com', ttl: 3600 },
        { type: 'MX', name: '@', exchange: 'mail.example.com', preference: 10, ttl: 3600 },
      ],
    }));
    const records = await sp.getDnsRecords('example.com');
    expect(records).toEqual([
      { type: 'A', name: '@', value: '1.2.3.4', ttl: 3600 },
      { type: 'CNAME', name: 'www', value: 'example.com', ttl: 3600 },
      { type: 'MX', name: '@', value: 'mail.example.com', ttl: 3600, priority: 10 },
    ]);
  });

  it('setDnsRecords upserts then deletes stale custom records; rejects unwritable types', async () => {
    const sp = spaceship();
    const calls = stubHttp(sp, req => {
      // the initial fetch returns an existing custom TXT that is not in the new set
      if (
        (req.method === undefined || req.method === 'GET') &&
        String(req.path).includes('/dns/')
      ) {
        return {
          total: 2,
          items: [
            { type: 'A', name: '@', address: '9.9.9.9', ttl: 3600, group: { type: 'custom' } },
            { type: 'TXT', name: 'old', value: 'x', ttl: 3600, group: { type: 'custom' } },
          ],
        };
      }
      return '';
    });

    const res = await sp.setDnsRecords('example.com', [
      { type: 'A', name: '@', value: '1.2.3.4', ttl: 3600 },
    ]);
    expect(res.success).toBe(true);

    const put = calls.find(c => c.method === 'PUT');
    expect(put?.body).toEqual({
      force: true,
      items: [{ type: 'A', name: '@', address: '1.2.3.4', ttl: 3600 }],
    });
    const del = calls.find(c => c.method === 'DELETE');
    // A@ is kept (still present); TXT/old is stale -> deleted
    expect(del?.body).toEqual([{ type: 'TXT', name: 'old' }]);

    await expect(
      sp.setDnsRecords('example.com', [{ type: 'SRV', name: '@', value: 'x' }])
    ).rejects.toThrow(/not supported/);
  });

  it('registerDomain saves contacts then POSTs with ids + privacy level, requires consent', async () => {
    const sp = spaceship();
    let n = 0;
    const calls = stubHttp(sp, req => {
      if (req.path === '/v1/contacts') return { contactId: `c-${++n}` };
      return '';
    });
    const registrant = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+1.5551234',
      address1: '1 Byron Way',
      city: 'London',
      postalCode: 'EC1',
      country: 'GB',
    };
    const res = await sp.registerDomain('example.com', {
      years: 2,
      contacts: { registrant },
      privacy: true,
      autoRenew: true,
      consent: { agreedBy: 'user' },
    });
    expect(res.success).toBe(true);
    const post = calls.find(c => c.method === 'POST' && c.path === '/v1/domains/example.com');
    expect(post?.body).toEqual({
      autoRenew: true,
      years: 2,
      privacyProtection: { level: 'high', userConsent: true },
      contacts: { registrant: 'c-1', admin: 'c-1', tech: 'c-1', billing: 'c-1' },
    });

    await expect(
      sp.registerDomain('example.com', { contacts: { registrant } })
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('transferIn POSTs the auth code to /transfer', async () => {
    const sp = spaceship();
    const calls = stubHttp(sp, () => '');
    const res = await sp.transferIn('example.com', {
      authCode: 'EPP123',
      consent: { agreedBy: 'user' },
    });
    expect(res.success).toBe(true);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/domains/example.com/transfer',
      body: { authCode: 'EPP123', autoRenew: false },
    });
  });
});

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
  // the real registrar domain shape: status is under last_known_status, the
  // creation date under registered_at, and there is no `id` (name is the key)
  const registrarDomain = {
    name: 'example.com',
    last_known_status: 'registrationActive',
    registered_at: '2020-01-01T00:00:00Z',
    expires_at: '2027-01-01T00:00:00Z',
    auto_renew: true,
    locked: true,
    privacy: true,
    name_servers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
  };

  it('getDomain GETs the registrar domain and maps the envelope result', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, () => ({ success: true, result: registrarDomain }));
    const d = await cf.getDomain('example.com');
    expect(calls[0].path).toBe('/accounts/acct-1/registrar/domains/example.com');
    expect(d).toMatchObject({
      domainName: 'example.com',
      status: 'registrationactive',
      autoRenew: true,
      locked: true,
      privacy: true,
      nameservers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
    });
    expect(d.createdDate?.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(d.expirationDate?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('listDomains paginates from page 0 (the registrar endpoint is 0-indexed)', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, req => {
      // page 0 carries the one domain; a page-1 request would (wrongly) start at 1
      return Number(req.query?.page) === 0
        ? { success: true, result: [registrarDomain] }
        : { success: true, result: [] };
    });
    const domains = await cf.listDomains();
    expect(calls[0].query).toMatchObject({ page: 0, per_page: 200 });
    expect(domains.map(d => d.domainName)).toEqual(['example.com']);
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

  it('getContacts maps inline registrar contacts by role', async () => {
    const cf = cloudflare();
    const contact = {
      first_name: 'Ada',
      last_name: 'Lovelace',
      organization: 'Analytical Engines',
      email: 'ada@example.com',
      phone: '+1.5551234567',
      fax: '',
      address: '1 Byron Way',
      address2: '',
      city: 'London',
      state: 'LDN',
      zip: 'EC1',
      country: 'GB',
    };
    const calls = stubHttp(cf, () => ({
      success: true,
      result: {
        name: 'example.com',
        contacts: { registrant: contact, administrator: contact, technical: contact },
      },
    }));
    const contacts = await cf.getContacts('example.com');
    expect(calls[0].path).toBe('/accounts/acct-1/registrar/domains/example.com');
    expect(contacts.registrant).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      organization: 'Analytical Engines',
      address1: '1 Byron Way',
      city: 'London',
      state: 'LDN',
      postalCode: 'EC1',
      country: 'GB',
    });
    // Cloudflare's role keys map to admin/tech; billing is absent here
    expect(contacts.admin?.firstName).toBe('Ada');
    expect(contacts.tech?.firstName).toBe('Ada');
    expect(contacts.billing).toBeUndefined();
    // empty strings ("" fax/address2) are dropped, not surfaced
    expect(contacts.registrant?.fax).toBeUndefined();
    expect(contacts.registrant?.address2).toBeUndefined();
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

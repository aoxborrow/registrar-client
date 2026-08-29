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

  it('getDomain fetches detail and maps the top-level nameservers array + data_obfuscated privacy', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ({
      fqdn: 'example.com',
      status: ['clientTransferProhibited'],
      autorenew: { enabled: true },
      dates: { created_at: '2021-05-05T00:00:00Z', registry_ends_at: '2026-05-05T00:00:00Z' },
      nameservers: ['ns1.gandi.net', 'ns2.gandi.net'],
      contacts: { owner: { data_obfuscated: true } },
    }));
    const domain = await g.getDomain('example.com');
    expect(calls[0].path).toBe('/domain/domains/example.com');
    expect(domain).toMatchObject({
      domainName: 'example.com',
      registrar: 'gandi',
      locked: true,
      autoRenew: true,
      privacy: true,
      nameservers: ['ns1.gandi.net', 'ns2.gandi.net'],
    });
    expect(domain.expirationDate?.toISOString()).toBe('2026-05-05T00:00:00.000Z');
  });

  it('getNameservers returns the bare string array from the dedicated endpoint', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ['ns1.gandi.net', 'ns2.gandi.net']);
    const ns = await g.getNameservers('example.com');
    expect(calls[0].path).toBe('/domain/domains/example.com/nameservers');
    expect(ns).toEqual(['ns1.gandi.net', 'ns2.gandi.net']);
  });

  it('getContacts maps owner->registrant and bill->billing with Gandi field names', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ({
      owner: {
        given: 'Ada',
        family: 'Lovelace',
        orgname: 'Analytical Engines',
        email: 'ada@example.com',
        phone: '+1.4155551234',
        streetaddr: '1 Main St',
        city: 'London',
        state: 'ENG',
        zip: 'EC1',
        country: 'GB',
      },
      bill: { given: 'Bill', family: 'Payer', email: 'bill@example.com', country: 'GB' },
    }));
    const contacts = await g.getContacts('example.com');
    expect(calls[0].path).toBe('/domain/domains/example.com/contacts');
    expect(contacts.registrant).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      organization: 'Analytical Engines',
      email: 'ada@example.com',
      phone: '+1.4155551234',
      address1: '1 Main St',
      city: 'London',
      state: 'ENG',
      postalCode: 'EC1',
      country: 'GB',
    });
    expect(contacts.billing?.firstName).toBe('Bill');
    expect(contacts.admin).toBeUndefined();
    expect(contacts.tech).toBeUndefined();
  });

  it('getDnsRecords flattens rrset values and splits MX/SRV numeric prefixes', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => [
      { rrset_type: 'a', rrset_name: '@', rrset_ttl: 300, rrset_values: ['1.2.3.4', '5.6.7.8'] },
      {
        rrset_type: 'MX',
        rrset_name: '@',
        rrset_ttl: 3600,
        rrset_values: ['10 mail.example.com.'],
      },
      {
        rrset_type: 'SRV',
        rrset_name: '_sip._tcp',
        rrset_values: ['5 10 5060 sip.example.com.'],
      },
    ]);
    const records = await g.getDnsRecords('example.com');
    expect(calls[0].path).toBe('/livedns/domains/example.com/records');
    // two A values become two records, type uppercased
    expect(records.filter(r => r.type === 'A')).toEqual([
      { type: 'A', name: '@', value: '1.2.3.4', ttl: 300 },
      { type: 'A', name: '@', value: '5.6.7.8', ttl: 300 },
    ]);
    expect(records.find(r => r.type === 'MX')).toEqual({
      type: 'MX',
      name: '@',
      value: 'mail.example.com.',
      ttl: 3600,
      priority: 10,
    });
    expect(records.find(r => r.type === 'SRV')).toEqual({
      type: 'SRV',
      name: '_sip._tcp',
      value: 'sip.example.com.',
      priority: 5,
      weight: 10,
      port: 5060,
    });
  });

  it('getPricing requests all three processes and maps each product by its process', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ({
      currency: 'USD',
      products: [
        { process: 'create', prices: [{ price_after_taxes: 15.5, price_before_taxes: 15.5 }] },
        { process: 'renew', prices: [{ price_before_taxes: 16.0 }] },
        { process: 'transfer', prices: [{ price_after_taxes: 15.5 }] },
      ],
    }));
    const pricing = await g.getPricing('example.com');
    expect(calls[0].path).toContain('/billing/price/domain?');
    expect(calls[0].path).toContain('name=example.com');
    expect(calls[0].path).toContain('processes=create');
    expect(calls[0].path).toContain('processes=renew');
    expect(calls[0].path).toContain('processes=transfer');
    expect(pricing).toEqual({
      tld: 'com',
      currency: 'USD',
      registration: 15.5,
      renewal: 16.0,
      transfer: 15.5,
    });
  });

  it('getPricing synthesizes a sample fqdn for a bare TLD', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ({ currency: 'EUR', products: [] }));
    const pricing = await g.getPricing('dev');
    expect(calls[0].path).toContain('name=example.dev');
    expect(pricing).toEqual({
      tld: 'dev',
      currency: 'EUR',
      registration: undefined,
      renewal: undefined,
      transfer: undefined,
    });
  });

  it('checkAvailability maps status, premium, price, currency and period per name', async () => {
    const g = gandi();
    const calls = stubHttp(g, req => {
      const name = String(req.query?.name);
      if (name === 'taken.com') {
        return { currency: 'USD', products: [{ name, process: 'create', status: 'unavailable' }] };
      }
      return {
        currency: 'USD',
        products: [
          {
            name,
            process: 'create',
            status: 'available',
            prices: [
              {
                price_after_taxes: 11.99,
                price_before_taxes: 11.99,
                duration_unit: 'y',
                min_duration: 1,
                type: 'premium',
              },
            ],
          },
        ],
      };
    });
    const results = await g.checkAvailability(['free.com', 'taken.com']);
    expect(calls.map(c => c.path)).toEqual(['/domain/check', '/domain/check']);
    expect(results[0]).toEqual({
      domainName: 'free.com',
      available: true,
      premium: true,
      price: 11.99,
      currency: 'USD',
      period: 1,
    });
    expect(results[1]).toMatchObject({
      domainName: 'taken.com',
      available: false,
      premium: false,
    });
    expect(results[1].price).toBeUndefined();
  });

  it('setAutoRenew PATCHes the /autorenew subresource', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ({}));
    await g.setAutoRenew('example.com', true);
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/domain/domains/example.com/autorenew',
      body: { enabled: true },
    });
  });

  it('setPrivacy PATCHes the owner contact data_obfuscated flag', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ({}));
    await g.setPrivacy('example.com', false);
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/domain/domains/example.com/contacts',
      body: { owner: { data_obfuscated: false } },
    });
  });

  it('setDnsRecords PUTs LiveDNS rrsets, grouping by name+type and re-encoding MX/SRV', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ({}));
    await g.setDnsRecords('example.com', [
      { type: 'A', name: '@', value: '1.1.1.1', ttl: 3600 },
      { type: 'A', name: '@', value: '2.2.2.2', ttl: 3600 }, // same rrset -> grouped
      { type: 'MX', name: '@', value: 'mail.example.com.', priority: 10, ttl: 3600 },
      {
        type: 'SRV',
        name: '_sip._tcp',
        value: 'sip.example.com.',
        priority: 5,
        weight: 20,
        port: 5060,
        ttl: 3600,
      },
    ]);
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/livedns/domains/example.com/records' });
    const items = (
      calls[0].body as {
        items: {
          rrset_name: string;
          rrset_type: string;
          rrset_ttl?: number;
          rrset_values: string[];
        }[];
      }
    ).items;
    const a = items.find(i => i.rrset_type === 'A');
    expect(a).toMatchObject({
      rrset_name: '@',
      rrset_ttl: 3600,
      rrset_values: ['1.1.1.1', '2.2.2.2'],
    });
    expect(items.find(i => i.rrset_type === 'MX')?.rrset_values).toEqual(['10 mail.example.com.']);
    expect(items.find(i => i.rrset_type === 'SRV')?.rrset_values).toEqual([
      '5 20 5060 sip.example.com.',
    ]);
  });

  it('updateContacts PATCHes contacts, mapping registrant->owner and billing->bill', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ({}));
    const contact = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      organization: 'Analytical Engines',
      email: 'ada@example.com',
      phone: '+44.2071234567',
      address1: '1 Byron Way',
      city: 'London',
      postalCode: 'EC1',
      country: 'GB',
    };
    await g.updateContacts('example.com', { registrant: contact, billing: contact });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/domain/domains/example.com/contacts',
    });
    const body = calls[0].body as {
      owner?: Record<string, unknown>;
      bill?: Record<string, unknown>;
    };
    expect(body.owner).toMatchObject({
      given: 'Ada',
      family: 'Lovelace',
      orgname: 'Analytical Engines',
      type: 1,
      country: 'GB',
    });
    expect(body.bill).toBeDefined();
  });

  it('registerDomain POSTs fqdn/duration/owner and carries privacy on the owner', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ({}));
    await g.registerDomain('example.com', {
      contacts: {
        registrant: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.com',
          phone: '+44.2071234567',
          address1: '1 Byron Way',
          city: 'London',
          postalCode: 'EC1',
          country: 'GB',
        },
      },
      years: 2,
      privacy: true,
      nameservers: ['ns1.x.net', 'ns2.x.net'],
    });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/domain/domains' });
    const body = calls[0].body as {
      fqdn: string;
      duration: number;
      owner: Record<string, unknown>;
      nameservers: string[];
    };
    expect(body).toMatchObject({
      fqdn: 'example.com',
      duration: 2,
      nameservers: ['ns1.x.net', 'ns2.x.net'],
    });
    expect(body.owner).toMatchObject({ given: 'Ada', type: 0, data_obfuscated: true });
  });

  it('transferIn POSTs to /transferin with authinfo + owner, requires a registrant', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ({}));
    await g.transferIn('example.com', {
      authCode: 'EPP-XYZ',
      contacts: {
        registrant: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.com',
          phone: '+44.2071234567',
          address1: '1 Byron Way',
          city: 'London',
          postalCode: 'EC1',
          country: 'GB',
        },
      },
    });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/domain/transferin/example.com' });
    expect(calls[0].body).toMatchObject({ fqdn: 'example.com', authinfo: 'EPP-XYZ' });
    await expect(g.transferIn('example.com', { authCode: 'x' })).rejects.toThrow(/registrant/i);
  });

  it('lockDomain PATCHes the /status subresource with clientTransferProhibited:true', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ({ message: 'Domain name status change in progress.' }));
    const res = await g.lockDomain('example.com');
    expect(res.success).toBe(true);
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/domain/domains/example.com/status',
      body: { clientTransferProhibited: true },
    });
  });

  it('unlockDomain PATCHes the /status subresource with clientTransferProhibited:false', async () => {
    const g = gandi();
    const calls = stubHttp(g, () => ({ message: 'Domain name status change in progress.' }));
    const res = await g.unlockDomain('example.com');
    expect(res.success).toBe(true);
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/domain/domains/example.com/status',
      body: { clientTransferProhibited: false },
    });
  });
});

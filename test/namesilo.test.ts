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

  it('getContacts resolves getDomainInfo contact_ids against contactList records', async () => {
    const ns = namesilo();
    const calls = stubHttp(ns, req =>
      req.path === '/getDomainInfo'
        ? {
            reply: {
              code: 300,
              contact_ids: {
                registrant: '111',
                administrative: '222',
                technical: '111',
                billing: '333',
              },
            },
          }
        : {
            reply: {
              code: 300,
              contact: [
                {
                  contact_id: '111',
                  first_name: 'Homer',
                  last_name: 'Simpson',
                  company: 'Springfield Power',
                  address: '742 Evergreen Terrace',
                  address2: '',
                  city: 'Springfield',
                  state: 'IL',
                  zip: '55555',
                  country: 'US',
                  email: 'homer@example.com',
                  phone: '999-555-1212',
                  fax: '',
                },
                {
                  contact_id: '333',
                  first_name: 'Jane',
                  last_name: 'Doe',
                  company: {},
                  address: '1 Main St',
                  city: 'Anywhere',
                  state: 'AZ',
                  zip: '12345',
                  country: 'US',
                  email: 'jane@example.com',
                  phone: '480-555-0000',
                },
              ],
            },
          }
    );
    const contacts = await ns.getContacts('example.com');
    expect(calls.map(c => c.path)).toEqual(['/getDomainInfo', '/contactList']);
    expect(contacts.registrant).toMatchObject({
      firstName: 'Homer',
      lastName: 'Simpson',
      organization: 'Springfield Power',
      address1: '742 Evergreen Terrace',
      postalCode: '55555',
      country: 'US',
      email: 'homer@example.com',
    });
    // empty self-closing elements collapse to undefined, not '' or '{}'
    expect(contacts.registrant?.address2).toBeUndefined();
    expect(contacts.registrant?.fax).toBeUndefined();
    // technical shares the registrant's ID -> same contact
    expect(contacts.tech?.firstName).toBe('Homer');
    // billing resolves to a different profile; company {} -> undefined org
    expect(contacts.billing).toMatchObject({ firstName: 'Jane', lastName: 'Doe' });
    expect(contacts.billing?.organization).toBeUndefined();
    // admin id 222 has no matching profile -> undefined
    expect(contacts.admin).toBeUndefined();
  });

  it('getContacts handles a single (non-array) contact record', async () => {
    const ns = namesilo();
    stubHttp(ns, req =>
      req.path === '/getDomainInfo'
        ? { reply: { code: 300, contact_ids: { registrant: '111' } } }
        : {
            reply: {
              code: 300,
              contact: {
                contact_id: '111',
                first_name: 'Solo',
                last_name: 'Contact',
                address: '1 St',
                city: 'Town',
                state: 'CA',
                zip: '90001',
                country: 'US',
                email: 'solo@example.com',
                phone: '111',
              },
            },
          }
    );
    const contacts = await ns.getContacts('example.com');
    expect(contacts.registrant?.firstName).toBe('Solo');
  });

  it('getDnsRecords maps resource_record entries (distance -> MX priority)', async () => {
    const ns = namesilo();
    const calls = stubHttp(ns, () => ({
      reply: {
        code: 300,
        resource_record: [
          { record_id: '1', type: 'A', host: 'example.com', value: '1.2.3.4', ttl: '3600' },
          {
            record_id: '2',
            type: 'MX',
            host: 'example.com',
            value: 'mail.example.com',
            ttl: '7207',
            distance: '10',
          },
        ],
      },
    }));
    const records = await ns.getDnsRecords('example.com');
    expect(calls[0].path).toBe('/dnsListRecords');
    expect(calls[0].query).toMatchObject({ domain: 'example.com' });
    expect(records).toEqual([
      { type: 'A', name: 'example.com', value: '1.2.3.4', ttl: 3600 },
      { type: 'MX', name: 'example.com', value: 'mail.example.com', ttl: 7207, priority: 10 },
    ]);
  });

  it('getDnsRecords handles a single (non-array) resource_record', async () => {
    const ns = namesilo();
    stubHttp(ns, () => ({
      reply: {
        code: 300,
        resource_record: { record_id: '1', type: 'a', host: '', value: '1.2.3.4', ttl: '3600' },
      },
    }));
    const records = await ns.getDnsRecords('example.com');
    expect(records).toEqual([{ type: 'A', name: '', value: '1.2.3.4', ttl: 3600 }]);
  });

  it('getPricing picks the requested TLD node from getPrices', async () => {
    const ns = namesilo();
    const calls = stubHttp(ns, () => ({
      reply: {
        code: 300,
        detail: 'success',
        com: { registration: 8.99, transfer: 8.39, renew: 8.99 },
        net: { registration: 9.29, transfer: 8.99, renew: 9.29 },
      },
    }));
    const pricing = await ns.getPricing('example.com');
    expect(calls[0].path).toBe('/getPrices');
    expect(pricing).toEqual({
      tld: 'com',
      currency: 'USD',
      registration: 8.99,
      renewal: 8.99,
      transfer: 8.39,
    });
  });

  it('getPricing accepts a bare TLD and throws when the TLD is absent', async () => {
    const ns = namesilo();
    stubHttp(ns, () => ({
      reply: {
        code: 300,
        net: { registration: 9.29, transfer: 8.99, renew: 9.29 },
      },
    }));
    expect(await ns.getPricing('net')).toMatchObject({ tld: 'net', registration: 9.29 });
    await expect(ns.getPricing('xyz')).rejects.toThrow(/no pricing/i);
  });

  it('checkAvailability splits available/unavailable and reads premium/price', async () => {
    const ns = namesilo();
    const calls = stubHttp(ns, () => ({
      reply: {
        code: 300,
        available: {
          domain: [
            { '#text': 'free1.com', 'price': '9.99', 'premium': '0', 'duration': '1' },
            { '#text': 'prem.com', 'price': '199.99', 'premium': '1', 'duration': '1' },
          ],
        },
        unavailable: { domain: 'taken.com' },
        invalid: { domain: 'n#t.com' },
      },
    }));
    const results = await ns.checkAvailability(['free1.com', 'prem.com', 'taken.com', 'n#t.com']);
    expect(calls[0].path).toBe('/checkRegisterAvailability');
    expect(calls[0].query).toMatchObject({ domains: 'free1.com,prem.com,taken.com,n#t.com' });
    expect(results).toEqual([
      {
        domainName: 'free1.com',
        available: true,
        premium: false,
        price: 9.99,
        currency: 'USD',
        period: 1,
      },
      {
        domainName: 'prem.com',
        available: true,
        premium: true,
        price: 199.99,
        currency: 'USD',
        period: 1,
      },
      { domainName: 'taken.com', available: false },
    ]);
  });

  it('checkAvailability handles a single available entry and bare string entries', async () => {
    const ns = namesilo();
    stubHttp(ns, () => ({
      reply: {
        code: 300,
        available: { domain: 'only.com' },
        unavailable: { domain: ['a.com', 'b.com'] },
      },
    }));
    const results = await ns.checkAvailability(['only.com', 'a.com', 'b.com']);
    expect(results).toEqual([
      { domainName: 'only.com', available: true },
      { domainName: 'a.com', available: false },
      { domainName: 'b.com', available: false },
    ]);
  });
});

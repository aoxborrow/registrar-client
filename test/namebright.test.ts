import { describe, it, expect } from 'vitest';
import { createRegistrar } from '../src/index';
import type { RequestConfig } from '../src/http';

// NameBright uses OAuth2: the first request fetches a bearer token, then the
// REST call runs. Stub both off the same handler.
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

function namebright() {
  return createRegistrar('namebright', { clientId: 'acct:app', clientSecret: 's' });
}

describe('NameBright provider', () => {
  it('listDomains paginates via domainsPerPage and maps status/privacy', async () => {
    const nb = namebright();
    const calls = stubHttp(nb, req => {
      if (req.path.includes('auth/token')) return { access_token: 't', expires_in: 1800 };
      const page = Number(req.query?.page ?? 1);
      if (page === 1) {
        // a full page of 100 must trigger a second page fetch
        return {
          Domains: Array.from({ length: 100 }, (_, i) => ({
            DomainName: `d${i}.com`,
            Status: 'active',
            ExpirationDate: '2027-01-01',
            WhoIsPrivacy: true,
            AutoRenew: true,
          })),
        };
      }
      return { Domains: [{ DomainName: 'last.com', ExpirationDate: '2027-01-01' }] };
    });

    const domains = await nb.listDomains();
    // 100 (full page) + 1 (partial page) = 101
    expect(domains).toHaveLength(101);
    const listCall = calls.find(c => c.path === 'account/domains');
    expect(listCall?.query).toMatchObject({ page: 1, domainsPerPage: 100 });
    expect(domains[0]).toMatchObject({ status: 'active', privacy: true, autoRenew: true });
  });

  it('listDomains filters by search client-side', async () => {
    const nb = namebright();
    stubHttp(nb, req => {
      if (req.path.includes('auth/token')) return { access_token: 't', expires_in: 1800 };
      return { Domains: [{ DomainName: 'foo.com' }, { DomainName: 'bar.com' }] };
    });
    const matched = await nb.listDomains({ search: 'foo' });
    expect(matched.map(d => d.domainName)).toEqual(['foo.com']);
  });

  it('getDomain maps the single-domain endpoint', async () => {
    const nb = namebright();
    const calls = stubHttp(nb, req => {
      if (req.path.includes('auth/token')) return { access_token: 't', expires_in: 1800 };
      return {
        DomainName: 'example.com',
        Status: 'Active',
        ExpirationDate: '2027-01-01',
        Locked: true,
        AutoRenew: true,
        WhoIsPrivacy: true,
      };
    });
    const domain = await nb.getDomain('example.com');
    expect(calls.find(c => c.path === 'account/domains/example.com')).toBeTruthy();
    expect(domain).toMatchObject({
      domainName: 'example.com',
      status: 'active',
      locked: true,
      autoRenew: true,
      privacy: true,
      nameservers: [],
    });
    expect(domain.expirationDate?.getUTCFullYear()).toBe(2027);
  });

  it('getNameservers reads the NameServers array', async () => {
    const nb = namebright();
    const calls = stubHttp(nb, req => {
      if (req.path.includes('auth/token')) return { access_token: 't', expires_in: 1800 };
      return { DomainName: 'example.com', NameServers: ['ns1.example.net', 'ns2.example.net'] };
    });
    const ns = await nb.getNameservers('example.com');
    expect(ns).toEqual(['ns1.example.net', 'ns2.example.net']);
    expect(calls.find(c => c.path === 'account/domains/example.com/nameservers')).toBeTruthy();
  });

  it('getNameservers tolerates a bare array response', async () => {
    const nb = namebright();
    stubHttp(nb, req => {
      if (req.path.includes('auth/token')) return { access_token: 't', expires_in: 1800 };
      return ['ns1.example.net'];
    });
    expect(await nb.getNameservers('example.com')).toEqual(['ns1.example.net']);
  });

  it('getContacts maps roles and joins the split phone (no billing role)', async () => {
    const nb = namebright();
    const calls = stubHttp(nb, req => {
      if (req.path.includes('auth/token')) return { access_token: 't', expires_in: 1800 };
      return {
        DomainName: 'example.com',
        RegistrantContact: {
          FirstName: 'Ada',
          LastName: 'Lovelace',
          Organization: 'Analytical',
          Email: 'ada@example.com',
          PhoneCountry: '1',
          Phone: '4805551234',
          Address1: '1 Main St',
          City: 'Phoenix',
          Region: 'AZ',
          PostalCode: '85001',
          Country: 'US',
        },
        AdministrativeContact: { FirstName: 'Admin', LastName: 'Person' },
        TechnicalContact: { FirstName: 'Tech', LastName: 'Person' },
      };
    });
    const contacts = await nb.getContacts('example.com');
    expect(calls.find(c => c.path === 'account/domains/example.com/contacts/all')).toBeTruthy();
    expect(contacts.registrant).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      organization: 'Analytical',
      email: 'ada@example.com',
      phone: '+1.4805551234',
      state: 'AZ',
      country: 'US',
    });
    expect(contacts.admin?.firstName).toBe('Admin');
    expect(contacts.tech?.firstName).toBe('Tech');
    expect(contacts.billing).toBeUndefined();
  });

  it('getDnsRecords flattens per-type record groups', async () => {
    const nb = namebright();
    stubHttp(nb, req => {
      if (req.path.includes('auth/token')) return { access_token: 't', expires_in: 1800 };
      return {
        DomainName: 'example.com',
        ARecords: [{ Subdomain: '@', IPV4Address: '1.2.3.4' }],
        CNAMERecords: [{ Subdomain: 'www', RedirectDomain: 'example.com' }],
        MXRecords: [{ Subdomain: '@', MailServer: 'mail.example.com', Priority: 10 }],
        TXTRecords: [{ Subdomain: '@', TextRecord: 'v=spf1 -all' }],
        SRVRecords: [
          {
            Service: '_sip',
            Protocol: '_tcp',
            Priority: 1,
            Weight: 5,
            Port: 5060,
            Target: 'sip.example.com',
          },
        ],
      };
    });
    const records = await nb.getDnsRecords('example.com');
    expect(records).toEqual([
      { type: 'A', name: '@', value: '1.2.3.4' },
      { type: 'CNAME', name: 'www', value: 'example.com' },
      { type: 'MX', name: '@', value: 'mail.example.com', priority: 10 },
      { type: 'TXT', name: '@', value: 'v=spf1 -all' },
      {
        type: 'SRV',
        name: '_sip._tcp',
        value: 'sip.example.com',
        priority: 1,
        weight: 5,
        port: 5060,
      },
    ]);
  });

  it('checkAvailability checks each domain, preferring the promo price', async () => {
    const nb = namebright();
    const calls = stubHttp(nb, req => {
      if (req.path.includes('auth/token')) return { access_token: 't', expires_in: 1800 };
      if (req.path.endsWith('taken.com')) {
        return { DomainName: 'taken.com', Status: 'NotAvailable', UnitPrice: 9.99 };
      }
      return {
        DomainName: 'free.com',
        Status: 'AvailableForRegistration',
        UnitPrice: 12.99,
        Promotion: { PromotionPrice: 8.88 },
      };
    });
    const res = await nb.checkAvailability(['free.com', 'taken.com']);
    expect(res).toEqual([
      { domainName: 'free.com', available: true, price: 8.88, currency: 'USD' },
      { domainName: 'taken.com', available: false, price: 9.99, currency: 'USD' },
    ]);
    expect(calls.some(c => c.path === 'purchase/availability/free.com')).toBe(true);
    expect(calls.some(c => c.path === 'purchase/availability/taken.com')).toBe(true);
  });

  it('getPricing throws NotImplementedError (no per-TLD price table)', async () => {
    const nb = namebright();
    stubHttp(nb, () => ({ access_token: 't', expires_in: 1800 }));
    await expect(nb.getPricing('com')).rejects.toThrow(/getPricing is not available/);
  });
});

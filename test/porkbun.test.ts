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

function porkbun() {
  return createRegistrar('porkbun', { apiKey: 'pk', secretApiKey: 'sk' });
}

const SUCCESS = 'SUCCESS';

describe('Porkbun provider', () => {
  it('getDomain lists the account and returns the matching normalized domain', async () => {
    const pb = porkbun();
    const calls = stubHttp(pb, () => ({
      status: SUCCESS,
      domains: [
        { domain: 'other.com', status: 'ACTIVE' },
        {
          domain: 'example.com',
          status: 'ACTIVE',
          createDate: '2020-01-01 00:00:00',
          expireDate: '2027-01-01 00:00:00',
          securityLock: '1',
          whoisPrivacy: '1',
          autoRenew: '1',
        },
      ],
    }));
    const d = await pb.getDomain('example.com');
    expect(d).toMatchObject({
      domainName: 'example.com',
      registrar: 'porkbun',
      status: 'active',
      autoRenew: true,
      locked: true,
      privacy: true,
    });
    expect(d.expirationDate?.getUTCFullYear()).toBe(2027);
    // getDomain funnels through listDomains (/domain/listAll)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/domain/listAll' });
    expect(calls[0].body).toMatchObject({ apikey: 'pk', secretapikey: 'sk' });
  });

  it('getDomain throws NotFoundError when the domain is not in the account', async () => {
    const pb = porkbun();
    stubHttp(pb, () => ({ status: SUCCESS, domains: [{ domain: 'other.com' }] }));
    await expect(pb.getDomain('missing.com')).rejects.toThrow(/not found/i);
  });

  it('getNameservers POSTs to /domain/getNs/{domain} and returns ns', async () => {
    const pb = porkbun();
    const calls = stubHttp(pb, () => ({
      status: SUCCESS,
      ns: ['ns1.porkbun.com', 'ns2.porkbun.com'],
    }));
    const ns = await pb.getNameservers('example.com');
    expect(ns).toEqual(['ns1.porkbun.com', 'ns2.porkbun.com']);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/domain/getNs/example.com' });
  });

  it('getNameservers throws on a non-SUCCESS status', async () => {
    const pb = porkbun();
    stubHttp(pb, () => ({ status: 'ERROR', message: 'nope' }));
    await expect(pb.getNameservers('example.com')).rejects.toThrow(/nope/);
  });

  it('getContacts rejects with NotImplementedError (no WHOIS read endpoint)', async () => {
    const pb = porkbun();
    await expect(pb.getContacts('example.com')).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('getDnsRecords maps content/ttl/prio and relativizes names', async () => {
    const pb = porkbun();
    const calls = stubHttp(pb, () => ({
      status: SUCCESS,
      records: [
        { id: '1', name: 'example.com', type: 'A', content: '1.2.3.4', ttl: '600', prio: '0' },
        { id: '2', name: 'www.example.com', type: 'CNAME', content: 'example.com', ttl: '3600' },
        {
          id: '3',
          name: 'example.com',
          type: 'MX',
          content: 'mail.example.com',
          ttl: '3600',
          prio: '10',
        },
        {
          id: '4',
          name: '_sip._tcp.example.com',
          type: 'SRV',
          content: '20 5060 sip.example.com',
          ttl: '3600',
          prio: '5',
        },
      ],
    }));
    const records = await pb.getDnsRecords('example.com');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/dns/retrieve/example.com' });
    expect(records[0]).toEqual({ type: 'A', name: '@', value: '1.2.3.4', ttl: 600 });
    expect(records[1]).toEqual({ type: 'CNAME', name: 'www', value: 'example.com', ttl: 3600 });
    expect(records[2]).toEqual({
      type: 'MX',
      name: '@',
      value: 'mail.example.com',
      ttl: 3600,
      priority: 10,
    });
    expect(records[3]).toEqual({
      type: 'SRV',
      name: '_sip._tcp',
      value: 'sip.example.com',
      ttl: 3600,
      priority: 5,
      weight: 20,
      port: 5060,
    });
  });

  it('getPricing picks the requested TLD from the full table (major USD units)', async () => {
    const pb = porkbun();
    const calls = stubHttp(pb, () => ({
      status: SUCCESS,
      pricing: {
        com: { registration: '9.68', renewal: '9.68', transfer: '9.68' },
        dev: { registration: '12.00', renewal: '12.00', transfer: '12.00' },
      },
    }));
    const pricing = await pb.getPricing('example.com');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/pricing/get' });
    expect(pricing).toEqual({
      tld: 'com',
      currency: 'USD',
      registration: 9.68,
      renewal: 9.68,
      transfer: 9.68,
    });
  });

  it('getPricing accepts a bare TLD and throws when it is missing', async () => {
    const pb = porkbun();
    stubHttp(pb, () => ({ status: SUCCESS, pricing: { com: { registration: '9.68' } } }));
    const pricing = await pb.getPricing('com');
    expect(pricing.tld).toBe('com');
    expect(pricing.registration).toBe(9.68);
    await expect(pb.getPricing('nope')).rejects.toThrow(/pricing/i);
  });

  it('checkAvailability issues one call per domain and maps avail/premium/price', async () => {
    const pb = porkbun();
    const calls = stubHttp(pb, (req: RequestConfig) => {
      if (String(req.path).endsWith('taken.com')) {
        return { status: SUCCESS, response: { avail: 'no' } };
      }
      if (String(req.path).endsWith('rich.com')) {
        return { status: SUCCESS, response: { avail: 'yes', premium: 'yes', price: '2500.00' } };
      }
      return { status: SUCCESS, response: { avail: 'yes', premium: 'no', price: '11.06' } };
    });
    const results = await pb.checkAvailability(['example.com', 'rich.com', 'taken.com']);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/domain/checkDomain/example.com' });
    expect(results[0]).toEqual({
      domainName: 'example.com',
      available: true,
      premium: false,
      price: 11.06,
      currency: 'USD',
      period: 1,
    });
    expect(results[1]).toMatchObject({
      available: true,
      premium: true,
      price: 2500,
      currency: 'USD',
    });
    expect(results[2]).toMatchObject({ domainName: 'taken.com', available: false });
    expect(results[2].price).toBeUndefined();
    expect(results[2].currency).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { createRegistrar, NotImplementedError } from '../src/index';
import type { RequestConfig } from '../src/http';
import type { Contact } from '../src/types';

const CONTACT: Contact = {
  firstName: 'Jane',
  lastName: 'Doe',
  organization: 'Acme',
  email: 'jane@example.com',
  phone: '+1.4805551234',
  address1: '123 Main St',
  city: 'Phoenix',
  state: 'AZ',
  postalCode: '85001',
  country: 'US',
};

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

  it('registerDomain checks price, sends cost + agreeToTerms, and applies NS/auto-renew follow-ups', async () => {
    const pb = porkbun();
    const calls = stubHttp(pb, (req: RequestConfig) => {
      const path = String(req.path);
      if (path.startsWith('/domain/checkDomain/')) {
        return { status: SUCCESS, response: { avail: 'yes', price: '11.08', premium: 'no' } };
      }
      if (path.startsWith('/domain/updateAutoRenew/')) {
        return { status: SUCCESS, results: { 'example.com': { status: SUCCESS } } };
      }
      return { status: SUCCESS };
    });
    const res = await pb.registerDomain('example.com', {
      contacts: { registrant: CONTACT },
      privacy: false,
      nameservers: ['ns1.example.com', 'ns2.example.com'],
      autoRenew: false,
    });
    expect(res.success).toBe(true);

    const create = calls.find(c => String(c.path) === '/domain/create/example.com');
    expect(create?.body).toMatchObject({ cost: 1108, agreeToTerms: 'yes', whoisPrivacy: false });
    // create carries no NS / auto-renew fields — they go out as separate calls
    expect(calls.some(c => String(c.path) === '/domain/updateNs/example.com')).toBe(true);
    const autoRenew = calls.find(c => String(c.path) === '/domain/updateAutoRenew/example.com');
    expect(autoRenew?.body).toMatchObject({ status: 'off' });
  });

  it('registerDomain throws when the domain is unavailable', async () => {
    const pb = porkbun();
    stubHttp(pb, () => ({ status: SUCCESS, response: { avail: 'no' } }));
    await expect(
      pb.registerDomain('taken.com', { contacts: { registrant: CONTACT } })
    ).rejects.toThrow(/not available/i);
  });

  it('renewDomain looks up the renewal price and sends it as cost (pennies)', async () => {
    const pb = porkbun();
    const calls = stubHttp(pb, (req: RequestConfig) => {
      if (String(req.path) === '/pricing/get') {
        return { status: SUCCESS, pricing: { com: { registration: '9.68', renewal: '9.68' } } };
      }
      return { status: SUCCESS };
    });
    const res = await pb.renewDomain('example.com');
    expect(res.success).toBe(true);
    const renew = calls.find(c => String(c.path) === '/domain/renew/example.com');
    expect(renew?.body).toMatchObject({ cost: 968 });
  });

  it('setAutoRenew sends on/off and reads the nested per-domain result', async () => {
    const pb = porkbun();
    const calls = stubHttp(pb, () => ({
      status: SUCCESS,
      results: { 'example.com': { status: SUCCESS, message: 'Auto renew status updated.' } },
    }));
    const res = await pb.setAutoRenew('example.com', true);
    expect(res).toEqual({ success: true, message: 'Auto renew status updated.' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/domain/updateAutoRenew/example.com',
      body: { status: 'on' },
    });
  });

  it('setAutoRenew fails when the nested per-domain result errored despite a SUCCESS envelope', async () => {
    const pb = porkbun();
    stubHttp(pb, () => ({
      status: SUCCESS,
      results: { 'example.com': { status: 'ERROR', message: 'Invalid domain.' } },
    }));
    const res = await pb.setAutoRenew('example.com', false);
    expect(res).toEqual({ success: false, message: 'Invalid domain.' });
  });

  it('transferIn looks up the transfer price and sends authCode + cost', async () => {
    const pb = porkbun();
    const calls = stubHttp(pb, (req: RequestConfig) => {
      if (String(req.path) === '/pricing/get') {
        return { status: SUCCESS, pricing: { com: { registration: '9.68', transfer: '9.68' } } };
      }
      return { status: SUCCESS };
    });
    const res = await pb.transferIn('example.com', { authCode: 'EPP-XYZ' });
    expect(res.success).toBe(true);
    const transfer = calls.find(c => String(c.path) === '/domain/transfer/example.com');
    expect(transfer?.body).toMatchObject({ authCode: 'EPP-XYZ', cost: 968 });
  });

  it('updateContacts nests roles under contacts and splits the phone into number + country code', async () => {
    const pb = porkbun();
    const calls = stubHttp(pb, () => ({ status: SUCCESS }));
    const res = await pb.updateContacts('example.com', { registrant: CONTACT, admin: CONTACT });
    expect(res.success).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/domain/updateContacts/example.com' });
    const body = calls[0].body as { contacts: Record<string, Record<string, unknown>> };
    expect(Object.keys(body.contacts).sort()).toEqual(['admin', 'registrant']);
    expect(body.contacts.registrant).toMatchObject({
      firstName: 'Jane',
      lastName: 'Doe',
      phone: '4805551234',
      phoneCountryCode: '1',
      state: 'AZ',
      country: 'US',
    });
  });

  it('updateContacts throws when no role is supplied', async () => {
    const pb = porkbun();
    stubHttp(pb, () => ({ status: SUCCESS }));
    await expect(pb.updateContacts('example.com', {})).rejects.toThrow(/at least one contact/i);
  });

  it('setDnsRecords deletes editable records, preserves apex NS, and packs SRV content', async () => {
    const pb = porkbun();
    const calls = stubHttp(pb, (req: RequestConfig) => {
      if (String(req.path) === '/dns/retrieve/example.com') {
        return {
          status: SUCCESS,
          records: [
            { id: '10', name: 'www.example.com', type: 'A', content: '1.1.1.1', ttl: '600' },
            {
              id: '11',
              name: 'example.com',
              type: 'NS',
              content: 'maceio.porkbun.com',
              ttl: '86400',
            },
          ],
        };
      }
      return { status: SUCCESS, id: 999 };
    });
    const res = await pb.setDnsRecords('example.com', [
      { type: 'NS', name: '@', value: 'skip-me.porkbun.com' }, // apex NS — must be skipped on create
      { type: 'A', name: 'www', value: '2.2.2.2', ttl: 600 },
      { type: 'MX', name: '@', value: 'mail.example.com', priority: 10, ttl: 3600 },
      {
        type: 'SRV',
        name: '_sip._tcp',
        value: 'sip.example.com',
        priority: 5,
        weight: 20,
        port: 5060,
      },
    ]);
    expect(res.success).toBe(true);

    const deletes = calls.filter(c => String(c.path).startsWith('/dns/delete/'));
    // only the A record is deleted; the apex NS record is left untouched
    expect(deletes.map(c => String(c.path))).toEqual(['/dns/delete/example.com/10']);

    const creates = calls.filter(c => String(c.path) === '/dns/create/example.com');
    // apex NS is not (re)created — 3 records created (A, MX, SRV)
    expect(creates).toHaveLength(3);
    const byType = Object.fromEntries(
      creates.map(c => [(c.body as { type: string }).type, c.body as Record<string, unknown>])
    );
    expect(byType.A).toMatchObject({ name: 'www', content: '2.2.2.2', ttl: '600' });
    expect(byType.MX).toMatchObject({ name: '', content: 'mail.example.com', prio: '10' });
    expect(byType.SRV).toMatchObject({
      name: '_sip._tcp',
      content: '20 5060 sip.example.com',
      prio: '5',
    });
  });
});

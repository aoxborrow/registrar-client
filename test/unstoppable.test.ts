import { describe, it, expect } from 'vitest';
import {
  createRegistrar,
  registrars,
  AuthenticationError,
  NotFoundError,
  NotImplementedError,
} from '../src/index';
import type { RequestConfig } from '../src/http';

// Unstoppable speaks JSON over HttpClient.request. Stub it; the handler is keyed
// off the action (the last path segment) for multi-call flows. Writes check the
// domain's background queue (ud_domain_pending_operations) before and after;
// unless `queue` is set, those checks answer "idle" and aren't recorded.
function stubHttp(
  provider: unknown,
  handler: (action: string, req: RequestConfig) => unknown,
  { queue = false } = {}
): RequestConfig[] {
  const calls: RequestConfig[] = [];
  (provider as { http: { request: (req: RequestConfig) => Promise<unknown> } }).http.request = (
    req: RequestConfig
  ) => {
    if (!queue && actionOf(req) === 'ud_domain_pending_operations') {
      return Promise.resolve({ results: [{ hasPendingOperations: false, operations: [] }] });
    }
    calls.push(req);
    try {
      return Promise.resolve(handler(actionOf(req), req));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return calls;
}

const actionOf = (req: RequestConfig) => (req.path ?? '').split('/').pop() ?? '';
const actions = (calls: RequestConfig[]) => calls.map(actionOf);
const ud = () => createRegistrar('unstoppable', { apiKey: 'ud_mcp_test' });
const OK_WRITE = { results: [{ success: true }], successCount: 1, failureCount: 0 };

function unauthorized(): never {
  throw new AuthenticationError('Request failed with 401 Unauthorized');
}

describe('Unstoppable Domains provider', () => {
  it('exposes discovery metadata and the forwarding extended feature', () => {
    const U = registrars.unstoppable;
    expect(U.displayName).toBe('Unstoppable Domains');
    expect(U.website).toBe('unstoppabledomains.com');
    expect(U.supportsSandbox).toBe(false);
    expect(U.configFields.map(f => f.name)).toEqual(['apiKey']);
    expect(U.features).toContain('setDomainForwarding');
    expect(U.features).toContain('getDnssec');
    expect(U.features).not.toContain('disableDnssec');
    expect(U.features).not.toContain('getAuthCode');
  });

  it('sends the key as a Bearer header and validates via portfolio_list', async () => {
    const u = ud();
    const calls = stubHttp(u, () => ({ domains: [], pagination: { hasMore: false } }));
    const res = await u.testConnection();
    expect(res.success).toBe(true);
    expect(calls[0].path).toBe('/mcp/v1/actions/ud_portfolio_list');
    expect(calls[0].method).toBe('POST');
    expect(JSON.stringify(calls[0].body)).not.toContain('ud_mcp_test'); // key is a header, not body
  });

  it('testConnection keeps the HTTP status of a rejected key', async () => {
    const u = ud();
    stubHttp(u, unauthorized);
    const res = await u.testConnection();
    expect(res).toMatchObject({ success: false, status: 401 });
  });

  // ud_domain_get detail keyed by name, used by the read-path tests below
  const DETAIL: Record<string, unknown> = {
    'example.com': {
      domain: 'example.com',
      found: true,
      flags: { DNS_TRANSFER_OUT: { status: 'DISABLED' }, DNS_WHOIS_PROXY: { status: 'ENABLED' } },
      lifecycle: {
        purchasedAt: '2023-01-01T00:00:00Z',
        expiresAt: '2027-01-01T00:00:00Z',
        transferStatus: 'none',
        autoRenewal: { status: 'active' },
      },
      dns: {
        nameservers: { status: 'custom', nameservers: ['ns1.ud.com', 'ns2.ud.com'] },
        dnssec: { enabled: true, valid: true },
      },
    },
    // transfer lock off (e.g. unlocked for a sale) — still held, still listed
    'unlocked.com': {
      domain: 'unlocked.com',
      found: true,
      flags: { DNS_TRANSFER_OUT: { status: 'ENABLED' }, DNS_WHOIS_PROXY: { status: 'DISABLED' } },
      lifecycle: { expiresAt: '2026-06-01T00:00:00Z', transferStatus: 'none' },
      dns: { nameservers: { status: 'default', nameservers: ['ns1.uddns.com'] } },
    },
    // registered elsewhere, only listed on Unstoppable's marketplace
    'elsewhere.com': {
      domain: 'elsewhere.com',
      found: true,
      lifecycle: { isExternallyOwned: true },
      dns: { nameservers: { nameservers: ['ns1.afternic.com'] } },
    },
  };
  const domainGet = (req: RequestConfig) => ({
    domains: (req.body as { domains: string[] }).domains.map(
      n => DETAIL[n] ?? { domain: n, found: false }
    ),
  });

  it('listDomains reads detail via ud_domain_get, pages by count, and skips marketplace-only names', async () => {
    const u = ud();
    const page1 = {
      domains: [
        { name: 'example.com' },
        { name: 'elsewhere.com', isExternallyOwned: true },
        { name: 'unlocked.com' },
      ],
      pagination: { hasMore: true, nextOffset: 500 },
    };
    // no detail comes back for this one: the summary fills in
    const page2 = {
      domains: [{ name: 'nodetail.com', expiresAt: '2028-01-01T00:00:00Z' }],
      pagination: { hasMore: false, nextOffset: null },
    };
    const calls = stubHttp(u, (action, req) => {
      if (action === 'ud_portfolio_list')
        return (req.body as { offset?: number }).offset ? page2 : page1;
      if (action === 'ud_domain_get') return domainGet(req);
      return {};
    });
    const all = await u.listDomains();

    const lists = calls.filter(c => actionOf(c) === 'ud_portfolio_list');
    expect(lists.map(c => (c.body as { offset: number }).offset)).toEqual([0, 3]);
    const gets = calls.filter(c => actionOf(c) === 'ud_domain_get');
    expect(gets.flatMap(c => (c.body as { domains: string[] }).domains)).not.toContain(
      'elsewhere.com'
    );

    expect(all.map(d => d.domainName)).toEqual(['example.com', 'unlocked.com', 'nodetail.com']);
    const ex = all.find(d => d.domainName === 'example.com')!;
    expect(ex).toMatchObject({
      registrar: 'unstoppable',
      autoRenew: true,
      locked: true,
      privacy: true,
      nameservers: ['ns1.ud.com', 'ns2.ud.com'],
    });
    expect(ex.expirationDate?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(all.find(d => d.domainName === 'unlocked.com')).toMatchObject({
      locked: false,
      privacy: false,
      autoRenew: false,
    });
    const nd = all.find(d => d.domainName === 'nodetail.com')!;
    expect(nd.expirationDate?.toISOString()).toBe('2028-01-01T00:00:00.000Z');
    expect(nd.nameservers).toEqual([]);
  });

  it('listDomains batches ud_domain_get at 50 names', async () => {
    const u = ud();
    const names = Array.from({ length: 120 }, (_, i) => ({ name: `n${i}.com` }));
    const calls = stubHttp(u, (action, req) =>
      action === 'ud_portfolio_list'
        ? { domains: names, pagination: { hasMore: false } }
        : domainGet(req)
    );
    const all = await u.listDomains();
    expect(all).toHaveLength(120);
    const sizes = calls
      .filter(c => actionOf(c) === 'ud_domain_get')
      .map(c => (c.body as { domains: string[] }).domains.length)
      .sort((a, b) => b - a);
    expect(sizes).toEqual([50, 50, 20]);
  });

  it('getDomain uses ud_domain_get; NotFound when absent or registered elsewhere', async () => {
    const u = ud();
    stubHttp(u, (_a, req) => domainGet(req));
    expect(await u.getDomain('Example.com')).toMatchObject({
      domainName: 'example.com',
      locked: true,
      nameservers: ['ns1.ud.com', 'ns2.ud.com'],
    });
    expect(await u.getDomain('unlocked.com')).toMatchObject({ locked: false });
    await expect(u.getDomain('missing.com')).rejects.toBeInstanceOf(NotFoundError);
    await expect(u.getDomain('elsewhere.com')).rejects.toBeInstanceOf(NotFoundError);

    const u2 = ud();
    stubHttp(u2, () => ({ domains: [] }));
    await expect(u2.getDomain('example.com')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getNameservers reads ud_domain_get; NotFound when absent', async () => {
    const u = ud();
    const calls = stubHttp(u, (_a, req) => domainGet(req));
    expect(await u.getNameservers('example.com')).toEqual(['ns1.ud.com', 'ns2.ud.com']);
    expect(calls[0].path).toBe('/mcp/v1/actions/ud_domain_get');
    await expect(u.getNameservers('missing.com')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getDnssec reads the enabled flag from ud_domain_get', async () => {
    const u = ud();
    stubHttp(u, (_a, req) => domainGet(req));
    expect(await u.getDnssec('example.com')).toEqual({ enabled: true, dsRecords: [] });
    expect(await u.getDnssec('unlocked.com')).toEqual({ enabled: false, dsRecords: [] });
    await expect(u.getDnssec('missing.com')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('updateNameservers posts the custom-nameservers payload', async () => {
    const u = ud();
    const calls = stubHttp(u, () => OK_WRITE);
    const res = await u.updateNameservers('example.com', ['a.ns.net', 'b.ns.net']);
    expect(calls[0].path).toBe('/mcp/v1/actions/ud_dns_nameservers_set_custom');
    expect(calls[0].body).toMatchObject({
      domains: [{ name: 'example.com', nameservers: ['a.ns.net', 'b.ns.net'] }],
    });
    expect(res.success).toBe(true);

    // Unstoppable's own pair switches back to its defaults
    await u.updateNameservers('example.com', [
      'NS2.unstoppabledomains.com.',
      'ns1.unstoppabledomains.com',
    ]);
    expect(calls[1].path).toBe('/mcp/v1/actions/ud_dns_nameservers_set_default');
    expect(calls[1].body).toEqual({ domains: [{ name: 'example.com' }] });
  });

  it('writes report a per-domain failure, and keep the status of an HTTP error', async () => {
    const u = ud();
    stubHttp(u, () => ({
      results: [{ domain: 'example.com', success: false, error: 'Domain not eligible' }],
      successCount: 0,
      failureCount: 1,
    }));
    expect(await u.updateNameservers('example.com', ['a.ns.net', 'b.ns.net'])).toEqual({
      success: false,
      message: 'Domain not eligible',
    });

    const u2 = ud();
    stubHttp(u2, unauthorized);
    expect(await u2.setAutoRenew('example.com', true)).toMatchObject({
      success: false,
      status: 401,
    });
    expect(await u2.lockDomain('example.com')).toMatchObject({ success: false, status: 401 });
  });

  it('checkAvailability batches 10 names per search, converts cents, and flags aftermarket', async () => {
    const u = ud();
    const calls = stubHttp(u, (_a, req) => {
      const query = (req.body as { query: string[] }).query;
      return {
        results: query
          .filter(n => n !== 'unsupported.zz')
          .map(n =>
            n === 'listed.com'
              ? {
                  name: n,
                  available: true,
                  marketplace: { status: 'registered-listed-for-sale', source: 'sedo' },
                  pricing: { amount: 500000, currency: 'USD' },
                }
              : n === 'taken.com'
                ? { name: n, available: false, marketplace: { status: 'registered-not-for-sale' } }
                : n === 'offers.com'
                  ? // seen live for a name in the account, listed for offers on Sedo
                    {
                      name: n,
                      available: true,
                      status: 'available',
                      marketplace: { status: 'registered-listed-for-offers', source: 'sedo' },
                    }
                  : {
                      name: n,
                      available: true,
                      marketplace: { status: 'available' },
                      pricing: { amount: 999, currency: 'USD' },
                    }
          ),
      };
    });
    const extra = Array.from({ length: 9 }, (_, i) => `free${i}.com`);
    const res = await u.checkAvailability([
      'Free.com',
      'listed.com',
      'taken.com',
      'offers.com',
      'unsupported.zz',
      ...extra,
    ]);
    expect(calls.map(c => (c.body as { query: string[] }).query.length)).toEqual([10, 4]);
    expect(res).toHaveLength(13); // unsupported.zz isn't returned
    expect(res[3]).toEqual({ domainName: 'offers.com', available: false });
    expect(res[0]).toEqual({
      domainName: 'free.com',
      available: true,
      price: 9.99,
      currency: 'USD',
    });
    expect(res[1]).toMatchObject({
      domainName: 'listed.com',
      available: true,
      premium: true,
      price: 5000,
    });
    expect(res[2]).toEqual({ domainName: 'taken.com', available: false });
  });

  it('getPricing prices a bare TLD via a probe label', async () => {
    const u = ud();
    const calls = stubHttp(u, () => ({
      results: [
        {
          name: 'ud-registrar-client-probe.io',
          marketplace: { status: 'available' },
          pricing: { amount: 3499, currency: 'USD' },
        },
      ],
    }));
    const p = await u.getPricing('.io');
    expect(calls[0].body).toMatchObject({ query: ['ud-registrar-client-probe'], tlds: ['io'] });
    expect(p).toEqual({ tld: 'io', currency: 'USD', registration: 34.99 });
  });

  it('getPricing prices a full name, but not an aftermarket listing', async () => {
    const u = ud();
    stubHttp(u, () => ({
      results: [
        {
          name: 'fresh.co.uk',
          marketplace: { status: 'available' },
          pricing: { amount: 1299, currency: 'GBP' },
        },
      ],
    }));
    expect(await u.getPricing('fresh.co.uk')).toEqual({
      tld: 'co.uk',
      currency: 'GBP',
      registration: 12.99,
    });

    const u2 = ud();
    stubHttp(u2, () => ({
      results: [
        {
          name: 'listed.com',
          marketplace: { status: 'registered-listed-for-sale' },
          pricing: { amount: 500000, currency: 'USD' },
        },
      ],
    }));
    await expect(u2.getPricing('listed.com')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('setAutoRenew maps the boolean to enable/disable', async () => {
    const u = ud();
    const calls = stubHttp(u, () => OK_WRITE);
    await u.setAutoRenew('example.com', true);
    await u.setAutoRenew('example.com', false);
    expect(calls[0].body).toMatchObject({ action: 'enable', domains: [{ name: 'example.com' }] });
    expect(calls[1].body).toMatchObject({ action: 'disable' });
  });

  it('lock, unlock and privacy set the domain flags', async () => {
    const u = ud();
    const calls = stubHttp(u, () => OK_WRITE);
    expect(await u.lockDomain('Example.com')).toEqual({ success: true, message: 'Domain locked' });
    await u.unlockDomain('example.com');
    await u.setPrivacy('example.com', true);
    await u.setPrivacy('example.com', false);
    expect(actions(calls)).toEqual(Array(4).fill('ud_domain_flags_update'));
    expect(calls.map(c => c.body)).toEqual([
      { domains: ['example.com'], flags: { DNS_TRANSFER_OUT: { status: 'DISABLED' } } },
      { domains: ['example.com'], flags: { DNS_TRANSFER_OUT: { status: 'ENABLED' } } },
      { domains: ['example.com'], flags: { DNS_WHOIS_PROXY: { status: 'ENABLED' } } },
      { domains: ['example.com'], flags: { DNS_WHOIS_PROXY: { status: 'DISABLED' } } },
    ]);
  });

  it('getDnsRecords expands multi-value records, splits MX/SRV numbers, and follows the cursor', async () => {
    const u = ud();
    const calls = stubHttp(u, (_a, req) =>
      (req.body as { cursor?: string }).cursor
        ? {
            records: [
              {
                id: '3',
                type: 'SRV',
                subName: '_sip._tcp',
                values: ['10 5 5060 sip.example.com.'],
                ttl: 300,
              },
            ],
            pagination: { hasMore: false },
          }
        : {
            // as stored live: hostnames end in a dot, TXT is quoted, and
            // Unstoppable's own records are read-only
            records: [
              { id: '1', type: 'A', subName: 'www', values: ['1.1.1.1', '2.2.2.2'], ttl: 3600 },
              { id: '2', type: 'MX', subName: '', values: ['10 mail.example.com.'], ttl: 3600 },
              { id: '4', type: 'TXT', subName: '@', values: ['"v=spf1 -all"'], ttl: 3600 },
              { id: '5', type: 'CNAME', subName: 'blog', values: ['host.example.net.'], ttl: 3600 },
              {
                id: 'rr-soa',
                type: 'SOA',
                subName: '@',
                values: ['ns1.ud.com. ns.ud.com. 1 900 300 604800 600'],
                ttl: 600,
                readonly: true,
              },
              {
                id: 'rr-host',
                type: 'A',
                subName: '@',
                values: ['34.68.218.70'],
                ttl: 300,
                readonly: true,
              },
            ],
            pagination: { hasMore: true, nextCursor: 'c2' },
          }
    );
    const recs = await u.getDnsRecords('example.com');
    expect(calls).toHaveLength(2);
    expect(recs).toEqual([
      { type: 'A', name: 'www', value: '1.1.1.1', ttl: 3600 },
      { type: 'A', name: 'www', value: '2.2.2.2', ttl: 3600 },
      { type: 'MX', name: '@', value: 'mail.example.com', ttl: 3600, priority: 10 },
      { type: 'TXT', name: '@', value: 'v=spf1 -all', ttl: 3600 },
      { type: 'CNAME', name: 'blog', value: 'host.example.net', ttl: 3600 },
      {
        type: 'SRV',
        name: '_sip._tcp',
        value: 'sip.example.com',
        ttl: 300,
        priority: 10,
        weight: 5,
        port: 5060,
      },
    ]);
  });

  describe('setDnsRecords', () => {
    const CURRENT = {
      records: [
        { id: 'a1', type: 'A', subName: 'www', values: ['1.1.1.1', '2.2.2.2'], ttl: 3600 },
        { id: 'm1', type: 'MX', subName: null, values: ['10 old.example.com'], ttl: 3600 },
        { id: 't1', type: 'TXT', subName: 'old', values: ['bye'], ttl: 3600 },
        // a system record: stays whatever we send
        { id: null, type: 'TXT', subName: '_ud', values: ['system'], ttl: 300, readonly: true },
      ],
      pagination: { hasMore: false },
    };
    const zone = (action: string) => (action === 'ud_dns_records_list' ? CURRENT : OK_WRITE);

    it('writes only the difference: removes by id, replaces changed, skips unchanged and read-only', async () => {
      const u = ud();
      const calls = stubHttp(u, zone);
      const res = await u.setDnsRecords('example.com', [
        { type: 'A', name: 'www', value: '2.2.2.2', ttl: 3600 },
        { type: 'A', name: 'www', value: '1.1.1.1', ttl: 3600 },
        { type: 'MX', name: '@', value: 'mail.example.com', priority: 10 },
        { type: 'CNAME', name: 'blog', value: 'host.example.net' },
        { type: 'TXT', name: '_ud', value: 'system', ttl: 300 },
      ]);
      expect(res).toEqual({ success: true, message: 'DNS records updated successfully' });
      expect(actions(calls)).toEqual([
        'ud_dns_records_list',
        'ud_dns_record_remove',
        'ud_dns_record_add',
      ]);
      // the list is a read inside a write
      expect(calls[0].call?.intent).toBe('read');
      expect(calls[1].body).toEqual({ records: [{ domain: 'example.com', recordId: 't1' }] });
      expect(calls[2].body).toEqual({
        records: [
          { domain: 'example.com', type: 'MX', subName: '@', values: ['10 mail.example.com'] },
          { domain: 'example.com', type: 'CNAME', subName: 'blog', values: ['host.example.net'] },
        ],
        upsertMode: 'replace',
      });
    });

    it('an empty list removes every editable record', async () => {
      const u = ud();
      const calls = stubHttp(u, zone);
      const res = await u.setDnsRecords('example.com', []);
      expect(actions(calls)).toEqual(['ud_dns_records_list', 'ud_dns_record_remove']);
      expect(
        (calls[1].body as { records: { recordId: string }[] }).records.map(r => r.recordId)
      ).toEqual(['a1', 'm1', 't1']);
      expect(res.success).toBe(true);
    });

    it('sends nothing when the zone already matches', async () => {
      const u = ud();
      const calls = stubHttp(u, zone);
      const res = await u.setDnsRecords('example.com', [
        { type: 'A', name: 'www', value: '1.1.1.1' },
        { type: 'A', name: 'www', value: '2.2.2.2' },
        { type: 'MX', name: '@', value: 'old.example.com', priority: 10 },
        { type: 'TXT', name: 'old', value: 'bye' },
      ]);
      expect(actions(calls)).toEqual(['ud_dns_records_list']);
      expect(res).toEqual({ success: true, message: 'DNS records already up to date' });
    });

    it('compares values bare, the way it reads them back', async () => {
      const u = ud();
      const calls = stubHttp(u, action =>
        action === 'ud_dns_records_list'
          ? {
              records: [
                { id: 't', type: 'TXT', subName: '@', values: ['"v=spf1 -all"'], ttl: 3600 },
                {
                  id: 'c',
                  type: 'CNAME',
                  subName: 'blog',
                  values: ['host.example.net.'],
                  ttl: 3600,
                },
                { id: 'm', type: 'MX', subName: '@', values: ['10 mx.example.net.'], ttl: 3600 },
              ],
            }
          : OK_WRITE
      );
      const res = await u.setDnsRecords('example.com', [
        { type: 'TXT', name: '@', value: 'v=spf1 -all', ttl: 3600 },
        { type: 'CNAME', name: 'blog', value: 'host.example.net', ttl: 3600 },
        { type: 'MX', name: '@', value: 'mx.example.net.', priority: 10, ttl: 3600 },
      ]);
      expect(res).toEqual({ success: true, message: 'DNS records already up to date' });
      expect(actions(calls)).toEqual(['ud_dns_records_list']);
    });

    it('stops at the first failed write', async () => {
      const u = ud();
      const calls = stubHttp(u, action =>
        action === 'ud_dns_records_list'
          ? CURRENT
          : { results: [{ success: false, error: 'RECORD_INVALID' }], failureCount: 1 }
      );
      const res = await u.setDnsRecords('example.com', [
        { type: 'A', name: 'www', value: '9.9.9.9' },
      ]);
      expect(res).toEqual({ success: false, message: 'RECORD_INVALID' });
      expect(actions(calls)).toEqual(['ud_dns_records_list', 'ud_dns_record_remove']);
    });

    it('splits large writes into batches of 50', async () => {
      const u = ud();
      const calls = stubHttp(u, action =>
        action === 'ud_dns_records_list' ? { records: [] } : OK_WRITE
      );
      const records = Array.from({ length: 60 }, (_, i) => ({
        type: 'A',
        name: `h${i}`,
        value: '1.1.1.1',
      }));
      await u.setDnsRecords('example.com', records);
      expect(
        calls
          .filter(c => actionOf(c) === 'ud_dns_record_add')
          .map(c => (c.body as { records: unknown[] }).records.length)
      ).toEqual([50, 10]);
    });

    it('folds SRV numbers back into the value', async () => {
      const u = ud();
      const calls = stubHttp(u, action =>
        action === 'ud_dns_records_list' ? { records: [] } : OK_WRITE
      );
      await u.setDnsRecords('example.com', [
        {
          type: 'SRV',
          name: '_sip._tcp',
          value: 'sip.example.com',
          priority: 10,
          weight: 5,
          port: 5060,
        },
      ]);
      expect(calls[1].body).toMatchObject({
        records: [{ type: 'SRV', subName: '_sip._tcp', values: ['10 5 5060 sip.example.com'] }],
      });
    });
  });

  it('getDomainForwarding returns only 301/302 redirects', async () => {
    const u = ud();
    stubHttp(u, () => ({
      configs: [
        { type: 'REDIRECT_301', subName: null, targetUrl: 'https://dest.com' },
        { type: 'LISTING_PAGE', subName: null, targetUrl: null },
        { type: 'REDIRECT_302', subName: 'www', targetUrl: 'https://dest.com/www' },
      ],
    }));
    const fwd = await u.getDomainForwarding('example.com');
    expect(fwd).toEqual([
      { host: '@', url: 'https://dest.com', type: 'permanent' },
      { host: 'www', url: 'https://dest.com/www', type: 'temporary' },
    ]);
  });

  it('setDomainForwarding removes stale redirects, adds new ones, keeps unchanged, and rejects masked', async () => {
    const u = ud();
    const calls = stubHttp(u, action =>
      action === 'ud_dns_hosting_list'
        ? {
            configs: [
              { type: 'REDIRECT_301', subName: null, targetUrl: 'https://old.com' },
              { type: 'REDIRECT_301', subName: 'shop', targetUrl: 'https://shop.com' },
            ],
          }
        : OK_WRITE
    );
    const res = await u.setDomainForwarding('example.com', [
      { host: '@', url: 'https://new.com', type: 'temporary' },
      { host: 'shop', url: 'https://shop.com', type: 'permanent' },
    ]);
    expect(actions(calls)).toEqual([
      'ud_dns_hosting_list',
      'ud_dns_hosting_remove',
      'ud_dns_hosting_add',
    ]);
    expect(calls[1].body).toEqual({ domains: [{ name: 'example.com' }] });
    expect(calls[2].body).toEqual({
      domains: [{ name: 'example.com', type: 'REDIRECT_302', targetUrl: 'https://new.com' }],
    });
    expect(res.success).toBe(true);

    // clearing two redirects takes two calls (one host per call)
    const u3 = ud();
    const calls3 = stubHttp(u3, action =>
      action === 'ud_dns_hosting_list'
        ? {
            configs: [
              { type: 'REDIRECT_301', subName: 'go', targetUrl: 'https://a.com' },
              { type: 'REDIRECT_302', subName: null, targetUrl: 'https://b.com' },
            ],
          }
        : OK_WRITE
    );
    expect(await u3.setDomainForwarding('example.com', [])).toMatchObject({ success: true });
    expect(calls3.slice(1).map(c => c.body)).toEqual([
      { domains: [{ name: 'example.com', subName: 'go' }] },
      { domains: [{ name: 'example.com' }] },
    ]);

    const u2 = ud();
    stubHttp(u2, () => OK_WRITE);
    await expect(
      u2.setDomainForwarding('example.com', [{ host: '@', url: 'https://x.com', type: 'masked' }])
    ).rejects.toThrow(/masked/i);
  });

  describe('background changes', () => {
    // poll without waiting
    const quick = (u: unknown, extra: Record<string, unknown> = {}) =>
      Object.assign(u as object, { settleDelaysMs: [0], ...extra });
    const accepted = {
      results: [{ domain: 'example.com', success: true, operationId: 'op-1' }],
      successCount: 1,
      failureCount: 0,
    };

    it('waits for the domain to be idle, writes, then waits for its own operation', async () => {
      const u = ud();
      quick(u);
      let polls = 0;
      const calls = stubHttp(
        u,
        action => {
          if (action !== 'ud_domain_pending_operations') return accepted;
          polls++;
          // busy on the first check before the write and the first one after it
          return {
            results: [{ domain: 'example.com', hasPendingOperations: polls === 1 || polls === 3 }],
          };
        },
        { queue: true }
      );
      expect(await u.lockDomain('example.com')).toEqual({
        success: true,
        message: 'Domain locked',
      });
      expect(actions(calls)).toEqual([
        'ud_domain_pending_operations',
        'ud_domain_pending_operations',
        'ud_domain_flags_update',
        'ud_domain_pending_operations',
        'ud_domain_pending_operations',
      ]);
      expect(calls[0].body).toEqual({ domains: [{ name: 'example.com' }] });
      expect(calls[0].call?.intent).toBe('read');
      expect(calls[3].body).toEqual({ domains: [{ name: 'example.com' }], includeCompleted: true });
    });

    it('reports a change that fails in the background', async () => {
      const u = ud();
      quick(u);
      stubHttp(
        u,
        action =>
          action === 'ud_domain_pending_operations'
            ? {
                results: [
                  {
                    domain: 'example.com',
                    hasPendingOperations: false,
                    operations: [
                      {
                        id: '9',
                        originOperationId: 'op-1',
                        status: 'FAILED',
                        errorCode: 'BAD_FLAG',
                      },
                    ],
                  },
                ],
              }
            : accepted,
        { queue: true }
      );
      expect(await u.setPrivacy('example.com', false)).toEqual({
        success: false,
        message: "Unstoppable couldn't apply the change (BAD_FLAG)",
      });
    });

    it('reports a change still running when the wait runs out as accepted', async () => {
      const u = ud();
      quick(u, { settleTimeoutMs: 0 });
      stubHttp(
        u,
        action =>
          action === 'ud_domain_pending_operations'
            ? { results: [{ domain: 'example.com', hasPendingOperations: true }] }
            : accepted,
        { queue: true }
      );
      expect(await u.unlockDomain('example.com')).toEqual({
        success: true,
        message: 'Domain unlocked; Unstoppable is still applying it',
      });
    });

    it('still writes when the queue check fails', async () => {
      const u = ud();
      quick(u);
      const calls = stubHttp(
        u,
        action => {
          if (action === 'ud_domain_pending_operations') throw new Error('queue check failed');
          return accepted;
        },
        { queue: true }
      );
      expect(await u.lockDomain('example.com')).toMatchObject({ success: true });
      expect(actions(calls)).toContain('ud_domain_flags_update');
    });

    it('explains a change refused because another is still being applied', async () => {
      const u = ud();
      stubHttp(u, () => ({
        results: [
          {
            success: false,
            error: JSON.stringify({
              message: 'Domain already has operation in progress.',
              code: 'CONCURRENT_OPERATION',
            }),
          },
        ],
        failureCount: 1,
      }));
      const res = await u.updateNameservers('example.com', ['a.ns.net', 'b.ns.net']);
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/still applying an earlier change/);

      const u2 = ud();
      stubHttp(u2, () => ({
        results: [{ success: false, error: JSON.stringify({ message: 'TTL out of range' }) }],
        failureCount: 1,
      }));
      expect(await u2.lockDomain('example.com')).toEqual({
        success: false,
        message: 'TTL out of range',
      });
    });
  });

  it('out-of-scope / unsupported methods throw NotImplementedError with a reason', async () => {
    const u = ud();
    stubHttp(u, () => OK_WRITE);
    await expect(u.registerDomain('x.com', { contacts: {} })).rejects.toThrow(/cart/i);
    await expect(u.renewDomain('x.com', 1)).rejects.toThrow(/cart/i);
    await expect(u.transferIn('x.com', { authCode: 'c' })).rejects.toThrow(NotImplementedError);
    await expect(u.getContacts('x.com')).rejects.toThrow(/account-level/i);
    await expect(u.updateContacts('x.com', {})).rejects.toThrow(NotImplementedError);
  });
});

import { describe, it, expect } from 'vitest';
import { createRegistrar, NotFoundError, NotImplementedError } from '../src/index';
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

  it('setPrivacy confirms the domain then PUTs the privacy flag', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, req =>
      req.method === 'PUT'
        ? { success: true, result: { name: 'example.com' } }
        : { success: true, result: [{ name: 'example.com' }] }
    );
    const res = await cf.setPrivacy('example.com', false);
    expect(res.success).toBe(true);
    // first a name-scoped confirmation GET, then the PUT carrying { privacy: false }
    expect(calls[0]).toMatchObject({
      path: '/accounts/acct-1/registrar/domains',
      query: { name: 'example.com' },
    });
    expect(calls[1]).toMatchObject({
      method: 'PUT',
      path: '/accounts/acct-1/registrar/domains/example.com',
      body: { privacy: false },
    });
  });

  it('setDnsRecords deletes existing records then creates the given set (Zones API)', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, req => {
      if (req.path === '/zones')
        return { success: true, result: [{ id: 'zone-1', name: 'example.com' }] };
      if (req.path === '/zones/zone-1/dns_records' && (req.method ?? 'GET') === 'GET') {
        return {
          success: true,
          result: [
            { id: 'rec-a', type: 'A', name: 'example.com', content: '9.9.9.9' },
            { id: 'rec-b', type: 'TXT', name: 'example.com', content: 'old' },
          ],
        };
      }
      return { success: true, result: {} }; // DELETE + POST
    });

    const res = await cf.setDnsRecords('example.com', [
      { type: 'A', name: 'www.example.com', value: '203.0.113.7', ttl: 300 },
      { type: 'MX', name: 'example.com', value: 'mail.example.net', priority: 10 },
      { type: 'NS', name: 'example.com', value: 'ns.example.com' }, // apex NS -> skipped
    ]);
    expect(res.success).toBe(true);

    const deletes = calls.filter(c => c.method === 'DELETE').map(c => c.path);
    expect(deletes).toEqual(['/zones/zone-1/dns_records/rec-a', '/zones/zone-1/dns_records/rec-b']);

    const posts = calls.filter(c => c.method === 'POST').map(c => c.body);
    // apex NS is Cloudflare-managed and skipped; A + MX are created with FQDN names
    expect(posts).toEqual([
      { type: 'A', name: 'www.example.com', content: '203.0.113.7', ttl: 300 },
      { type: 'MX', name: 'example.com', content: 'mail.example.net', priority: 10 },
    ]);
  });

  it('setDnsRecords surfaces a delete failure (e.g. Email Routing managed record)', async () => {
    const cf = cloudflare();
    stubHttp(cf, req => {
      if (req.path === '/zones')
        return { success: true, result: [{ id: 'zone-1', name: 'example.com' }] };
      if ((req.method ?? 'GET') === 'GET') {
        return {
          success: true,
          result: [{ id: 'rec-mx', type: 'MX', name: 'example.com', content: 'x' }],
        };
      }
      return {
        success: false,
        errors: [{ code: 1046, message: 'This record is managed by Email Routing.' }],
      };
    });
    const res = await cf.setDnsRecords('example.com', [
      { type: 'A', name: 'example.com', value: '1.1.1.1' },
    ]);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Email Routing/);
  });

  it('checkAvailability POSTs domain-check and maps registrable + pricing', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, () => ({
      success: true,
      result: {
        domains: [
          {
            name: 'available.click',
            registrable: true,
            tier: 'standard',
            pricing: { currency: 'USD', registration_cost: '10.20', renewal_cost: '10.20' },
          },
          { name: 'premium.xyz', registrable: false, tier: 'premium', reason: 'domain_premium' },
        ],
      },
    }));
    const res = await cf.checkAvailability(['available.click', 'premium.xyz']);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/accounts/acct-1/registrar/domain-check',
      body: { domains: ['available.click', 'premium.xyz'] },
    });
    expect(res).toEqual([
      {
        domainName: 'available.click',
        available: true,
        premium: false,
        price: 10.2,
        currency: 'USD',
      },
      { domainName: 'premium.xyz', available: false, premium: true },
    ]);
  });

  it('checkAvailability batches names in groups of 20', async () => {
    const cf = cloudflare();
    const names = Array.from({ length: 25 }, (_, i) => `d${i}.click`);
    const calls = stubHttp(cf, req => ({
      success: true,
      result: {
        domains: (req.body as { domains: string[] }).domains.map(name => ({
          name,
          registrable: true,
        })),
      },
    }));
    const res = await cf.checkAvailability(names);
    expect(calls).toHaveLength(2); // 20 + 5
    expect((calls[0].body as { domains: string[] }).domains).toHaveLength(20);
    expect((calls[1].body as { domains: string[] }).domains).toHaveLength(5);
    expect(res).toHaveLength(25);
  });

  it('getPricing derives a probe domain for a bare TLD and maps pricing', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, () => ({
      success: true,
      result: {
        domains: [
          {
            name: 'registrar-client-pricing-probe.click',
            registrable: true,
            tier: 'standard',
            pricing: { currency: 'USD', registration_cost: '10.20', renewal_cost: '9.10' },
          },
        ],
      },
    }));
    const pricing = await cf.getPricing('.click');
    expect((calls[0].body as { domains: string[] }).domains).toEqual([
      'registrar-client-pricing-probe.click',
    ]);
    expect(pricing).toEqual({ tld: 'click', currency: 'USD', registration: 10.2, renewal: 9.1 });
  });

  it('getPricing throws when the API returns no pricing (e.g. premium)', async () => {
    const cf = cloudflare();
    stubHttp(cf, () => ({
      success: true,
      result: { domains: [{ name: 'premium.xyz', registrable: false, reason: 'domain_premium' }] },
    }));
    await expect(cf.getPricing('premium.xyz')).rejects.toThrow(/domain_premium/);
  });

  it('registerDomain POSTs the registration and reports success when completed', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, () => ({
      success: true,
      result: { domain_name: 'new.click', state: 'succeeded', completed: true },
    }));
    const res = await cf.registerDomain('new.click', {
      contacts: {},
      autoRenew: true,
      privacy: true,
    });
    expect(res).toMatchObject({ success: true });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/accounts/acct-1/registrar/registrations',
      body: { domain_name: 'new.click', auto_renew: true, privacy_mode: 'redaction' },
    });
  });

  it('registerDomain maps a custom registrant into Cloudflare postal_info', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, () => ({
      success: true,
      result: { state: 'succeeded', completed: true },
    }));
    await cf.registerDomain('new.click', {
      contacts: {
        registrant: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          organization: 'Example Inc',
          email: 'ada@example.com',
          phone: '+1.5555555555',
          address1: '123 Main St',
          city: 'Austin',
          state: 'TX',
          postalCode: '78701',
          country: 'US',
        },
      },
    });
    expect((calls[0].body as { contacts: unknown }).contacts).toEqual({
      registrant: {
        email: 'ada@example.com',
        phone: '+1.5555555555',
        postal_info: {
          name: 'Ada Lovelace',
          organization: 'Example Inc',
          address: {
            street: '123 Main St',
            city: 'Austin',
            state: 'TX',
            postal_code: '78701',
            country_code: 'US',
          },
        },
      },
    });
  });

  it('registerDomain surfaces an API failure', async () => {
    const cf = cloudflare();
    stubHttp(cf, () => ({
      success: false,
      errors: [{ message: 'extension_not_supported_via_api' }],
    }));
    const res = await cf.registerDomain('bad.link', { contacts: {} });
    expect(res).toMatchObject({ success: false });
    expect(res.message).toMatch(/extension_not_supported/);
  });

  // Cloudflare has no post-registration update endpoint; these fields are settable
  // only at registration, so the methods reject rather than hit a doomed PUT.
  it('post-registration updates reject with NotImplementedError (no API endpoint)', async () => {
    const cf = cloudflare();
    await expect(cf.setAutoRenew('example.com', false)).rejects.toBeInstanceOf(NotImplementedError);
    await expect(cf.lockDomain('example.com')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(cf.unlockDomain('example.com')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(cf.updateNameservers('example.com', ['a.ns', 'b.ns'])).rejects.toBeInstanceOf(
      NotImplementedError
    );
    await expect(cf.renewDomain('example.com')).rejects.toBeInstanceOf(NotImplementedError);
  });

  // --- domain forwarding (Rulesets + placeholder DNS) ---

  const zoneList = { success: true, result: [{ id: 'z1', name: 'example.com' }] };

  it('getDomainForwarding maps static redirect rules to forwards (skips dynamic)', async () => {
    const cf = cloudflare();
    stubHttp(cf, req => {
      if (req.path === '/zones') return zoneList;
      if (String(req.path).endsWith('/entrypoint')) {
        return {
          success: true,
          result: {
            id: 'rs1',
            rules: [
              {
                expression: 'http.host eq "example.com"',
                action: 'redirect',
                action_parameters: {
                  from_value: { target_url: { value: 'https://dest.com' }, status_code: 301 },
                },
              },
              {
                expression: 'http.host eq "www.example.com"',
                action: 'redirect',
                action_parameters: {
                  from_value: { target_url: { value: 'https://dest.com' }, status_code: 302 },
                },
              },
              // dynamic target (expression, not a literal value) -> skipped
              {
                expression: 'http.host eq "x.example.com"',
                action: 'redirect',
                action_parameters: {
                  from_value: {
                    target_url: { expression: 'concat("https://", "x")' },
                    status_code: 302,
                  },
                },
              },
            ],
          },
        };
      }
      return { success: true, result: {} };
    });
    expect(await cf.getDomainForwarding('example.com')).toEqual([
      { host: '@', url: 'https://dest.com', type: 'permanent' },
      { host: 'www', url: 'https://dest.com', type: 'temporary' },
    ]);
  });

  it('getDomainForwarding returns [] when no redirect ruleset exists (404)', async () => {
    const cf = cloudflare();
    stubHttp(cf, req => {
      if (req.path === '/zones') return zoneList;
      throw new NotFoundError('no entrypoint');
    });
    expect(await cf.getDomainForwarding('example.com')).toEqual([]);
  });

  it('setDomainForwarding creates the ruleset and proxied placeholder records', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, req => {
      if (req.path === '/zones') return zoneList;
      if (String(req.path).endsWith('/entrypoint')) throw new NotFoundError('none'); // no ruleset yet
      if (String(req.path).endsWith('/dns_records') && (req.method ?? 'GET') === 'GET') {
        return { success: true, result: [] }; // no existing record on the host
      }
      return { success: true, result: { id: 'rs1' } };
    });

    const res = await cf.setDomainForwarding('example.com', [
      { host: '@', url: 'https://dest.com', type: 'temporary' },
      { host: 'www', url: 'https://dest.com', type: 'permanent' },
    ]);
    expect(res.success).toBe(true);

    // two proxied AAAA 100:: placeholders created (apex + www)
    const dnsPosts = calls.filter(
      c => c.method === 'POST' && String(c.path).endsWith('/dns_records')
    );
    expect(dnsPosts.map(c => c.body)).toEqual([
      { type: 'AAAA', name: 'example.com', content: '100::', proxied: true, ttl: 1 },
      { type: 'AAAA', name: 'www.example.com', content: '100::', proxied: true, ttl: 1 },
    ]);

    // ruleset created via POST with a redirect rule per host
    const rsPost = calls.find(c => c.method === 'POST' && c.path === '/zones/z1/rulesets');
    const body = rsPost?.body as {
      phase: string;
      rules: { expression: string; action_parameters: { from_value: { status_code: number } } }[];
    };
    expect(body.phase).toBe('http_request_dynamic_redirect');
    expect(body.rules.map(r => [r.expression, r.action_parameters.from_value.status_code])).toEqual(
      [
        ['http.host eq "example.com"', 302],
        ['http.host eq "www.example.com"', 301],
      ]
    );
  });

  it('setDomainForwarding on an empty list deletes the ruleset and placeholder records only', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, req => {
      if (req.path === '/zones') return zoneList;
      if (String(req.path).endsWith('/entrypoint'))
        return { success: true, result: { id: 'rs1', rules: [] } };
      if (String(req.path).endsWith('/dns_records') && (req.method ?? 'GET') === 'GET') {
        return {
          success: true,
          result: [
            { id: 'ph', type: 'AAAA', name: 'example.com', content: '100::' }, // our placeholder
            { id: 'real', type: 'A', name: 'example.com', content: '203.0.113.9' }, // real record
          ],
        };
      }
      return { success: true, result: {} };
    });

    const res = await cf.setDomainForwarding('example.com', []);
    expect(res.success).toBe(true);
    const deletes = calls.filter(c => c.method === 'DELETE').map(c => c.path);
    expect(deletes).toContain('/zones/z1/rulesets/rs1');
    expect(deletes).toContain('/zones/z1/dns_records/ph'); // placeholder removed
    expect(deletes).not.toContain('/zones/z1/dns_records/real'); // real record kept
  });

  it('setDomainForwarding rejects masked forwarding before any write', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, () => ({ success: true, result: {} }));
    // the provider wraps errors into an OperationResult; the masked guard runs first
    const res = await cf.setDomainForwarding('example.com', [
      { host: '@', url: 'https://dest.com', type: 'masked' },
    ]);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/masked/i);
    expect(calls).toHaveLength(0); // failed fast, nothing written
  });

  // --- email forwarding (Email Routing) ---

  it('getEmailForwarding maps forward rules + catch-all (skips drop/worker)', async () => {
    const cf = cloudflare();
    stubHttp(cf, req => {
      if (req.path === '/zones') return zoneList;
      if (String(req.path).endsWith('/email/routing/rules')) {
        return {
          success: true,
          result: [
            {
              id: 'r1',
              matchers: [{ type: 'literal', field: 'to', value: 'hi@example.com' }],
              actions: [{ type: 'forward', value: ['a@b.com'] }],
            },
            {
              id: 'r2',
              matchers: [{ type: 'literal', field: 'to', value: 'trash@example.com' }],
              actions: [{ type: 'drop' }],
            },
          ],
        };
      }
      if (String(req.path).endsWith('/catch_all')) {
        return {
          success: true,
          result: {
            enabled: true,
            matchers: [{ type: 'all' }],
            actions: [{ type: 'forward', value: ['c@d.com'] }],
          },
        };
      }
      return { success: true, result: {} };
    });
    expect(await cf.getEmailForwarding('example.com')).toEqual([
      { alias: 'hi', forwardTo: 'a@b.com' },
      { alias: '*', forwardTo: 'c@d.com' },
    ]);
  });

  it('setEmailForwarding enables routing, replaces rules, and sets the catch-all', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, req => {
      if (req.path === '/zones') return zoneList;
      if (req.path === '/zones/z1/email/routing')
        return { success: true, result: { enabled: false } };
      if (
        String(req.path).endsWith('/email/routing/addresses') &&
        (req.method ?? 'GET') === 'GET'
      ) {
        // both destinations already verified on the account
        return {
          success: true,
          result: [
            { email: 's@x.com', verified: '2024-01-01T00:00:00Z' },
            { email: 'c@x.com', verified: '2024-01-01T00:00:00Z' },
          ],
        };
      }
      if (String(req.path).endsWith('/email/routing/rules') && (req.method ?? 'GET') === 'GET') {
        return {
          success: true,
          result: [
            {
              id: 'old',
              matchers: [{ type: 'literal', value: 'x@example.com' }],
              actions: [{ type: 'forward', value: ['x@y.com'] }],
            },
          ],
        };
      }
      return { success: true, result: {} };
    });

    const res = await cf.setEmailForwarding('example.com', [
      { alias: 'sales', forwardTo: 's@x.com' },
      { alias: '*', forwardTo: 'c@x.com' },
    ]);
    expect(res.success).toBe(true);

    // routing enabled, old rule deleted, new rule created, catch-all forwarded
    expect(
      calls.some(c => c.method === 'POST' && c.path === '/zones/z1/email/routing/enable')
    ).toBe(true);
    expect(
      calls.some(c => c.method === 'DELETE' && c.path === '/zones/z1/email/routing/rules/old')
    ).toBe(true);

    const rulePost = calls.find(
      c => c.method === 'POST' && c.path === '/zones/z1/email/routing/rules'
    );
    expect(rulePost?.body).toMatchObject({
      matchers: [{ type: 'literal', field: 'to', value: 'sales@example.com' }],
      actions: [{ type: 'forward', value: ['s@x.com'] }],
    });

    const catchAll = calls.find(c => c.method === 'PUT' && String(c.path).endsWith('/catch_all'));
    expect(catchAll?.body).toMatchObject({
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'forward', value: ['c@x.com'] }],
    });
  });

  it('setEmailForwarding adds an unknown destination and notes it awaits verification', async () => {
    const cf = cloudflare();
    const calls = stubHttp(cf, req => {
      if (req.path === '/zones') return zoneList;
      if (req.path === '/zones/z1/email/routing')
        return { success: true, result: { enabled: true } };
      if (
        String(req.path).endsWith('/email/routing/addresses') &&
        (req.method ?? 'GET') === 'GET'
      ) {
        return { success: true, result: [] }; // destination not on the account yet
      }
      if (String(req.path).endsWith('/email/routing/rules') && (req.method ?? 'GET') === 'GET') {
        return { success: true, result: [] };
      }
      return { success: true, result: {} };
    });

    const res = await cf.setEmailForwarding('example.com', [
      { alias: 'hi', forwardTo: 'new@dest.com' },
    ]);
    expect(res.success).toBe(true);
    expect(res.message).toMatch(/awaiting verification of new@dest\.com/);
    // the unknown destination was added (triggers Cloudflare's verification email)
    const addrPost = calls.find(
      c => c.method === 'POST' && c.path === '/accounts/acct-1/email/routing/addresses'
    );
    expect(addrPost?.body).toEqual({ email: 'new@dest.com' });
  });
});

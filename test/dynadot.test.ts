import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { createRegistrar, ConsentRequiredError } from '../src/index';
import type { RequestConfig } from '../src/http';

// Stub the provider's HttpClient so no network calls happen. `handler` receives
// each RequestConfig (path is the full /restful/v2 path+query; headers carry the
// computed X-Signature) and returns the canned v2 envelope.
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

const KEY = 'k';
const SECRET = 's';
function dynadot() {
  return createRegistrar('dynadot', { apiKey: KEY, apiSecret: SECRET });
}

// the reference signature: Base64 HMAC-SHA256 over key\npath\n\nbody
function expectedSignature(pathAndQuery: string, body = ''): string {
  return createHmac('sha256', SECRET).update(`${KEY}\n${pathAndQuery}\n\n${body}`).digest('base64');
}

// wrap a data payload in a success envelope
const ok = (data: unknown) => ({ code: 200, message: 'Success', data });

describe('Dynadot provider (RESTful v2)', () => {
  it('signs each request: Bearer key + X-Signature over key\\npath\\n\\nbody', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ok({ account_info: { username: 'u' } }));
    const res = await dy.testConnection();
    expect(res.success).toBe(true);
    expect(calls[0].path).toBe('/restful/v2/accounts/info');
    expect(calls[0].headers?.['X-Signature']).toBe(expectedSignature('/restful/v2/accounts/info'));
  });

  it('treats a non-200 envelope code as an error (surfacing error.description)', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ({ code: 400, error: { description: 'domain not found' } }));
    await expect(dy.getDomain('missing.com')).rejects.toThrow(/domain not found/);
  });

  it('listDomains maps domain_info_list: dates, lock, privacy, auto-renew, nameservers', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () =>
      ok({
        domain_info_list: [
          {
            domain_name: 'example.com',
            registration_date: 1432685548000,
            expiration_date: 1811376748000,
            locked: 'Yes',
            privacy: 'Full Privacy',
            renew_option: 'auto-renew',
            status: 'active',
            glue_info: {
              glue_type: 'NAME_SERVERS',
              nameserver_list: [{ server_name: 'ns1.domain.io' }, { server_name: 'ns2.domain.io' }],
            },
          },
        ],
      })
    );
    const domains = await dy.listDomains();
    expect(calls[0].path).toBe('/restful/v2/domains');
    expect(domains[0]).toMatchObject({
      domainName: 'example.com',
      registrar: 'dynadot',
      status: 'active',
      locked: true,
      privacy: true,
      autoRenew: true,
      nameservers: ['ns1.domain.io', 'ns2.domain.io'],
    });
    expect(domains[0].expirationDate?.toISOString()).toBe('2027-05-27T00:12:28.000Z');
  });

  it('getDomain reads domain_info; "No Privacy" maps to privacy=false', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () =>
      ok({ domain_info: { domain_name: 'example.com', privacy: 'No Privacy', locked: 'No' } })
    );
    const d = await dy.getDomain('example.com');
    expect(calls[0].path).toBe('/restful/v2/domains/example.com');
    expect(d).toMatchObject({ domainName: 'example.com', privacy: false, locked: false });
  });

  it('getContacts resolves distinct contact ids, de-dupes, splits name and joins phone', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, req => {
      if (req.path === '/restful/v2/domains/example.com') {
        return ok({
          domain_info: {
            registrant_contact_id: 111,
            admin_contact_id: 111, // shares the registrant -> one fetch
            technical_contact_id: 222,
            billing_contact_id: 0, // no dedicated contact
          },
        });
      }
      const id = req.path.split('/').pop();
      const contact =
        id === '111'
          ? {
              name: 'Homer Simpson',
              organization: 'Springfield Power',
              email: 'homer@example.com',
              phone_cc: '1',
              phone_number: '999-555-1212',
              address1: '742 Evergreen Terrace',
              city: 'Springfield',
              state: 'IL',
              zip: '55555',
              country: 'US',
            }
          : { name: 'Solo', email: 't@example.com', city: 'Town', country: 'US' };
      return ok({ contact });
    });
    const contacts = await dy.getContacts('example.com');
    // domain_info first, then get_contact for 111 and 222 only (0 skipped, dupes merged)
    expect(calls.map(c => c.path)).toEqual([
      '/restful/v2/domains/example.com',
      '/restful/v2/contacts/111',
      '/restful/v2/contacts/222',
    ]);
    expect(contacts.registrant).toMatchObject({
      firstName: 'Homer',
      lastName: 'Simpson',
      organization: 'Springfield Power',
      phone: '+1.999-555-1212',
      postalCode: '55555',
    });
    // admin shares id 111 -> same contact
    expect(contacts.admin?.firstName).toBe('Homer');
    // tech is a lone token -> empty last name
    expect(contacts.tech).toMatchObject({ firstName: 'Solo', lastName: '' });
    // billing id 0 -> unset
    expect(contacts.billing).toBeUndefined();
  });

  it('getDnsRecords maps apex + subdomain records (MX priority from record_value2)', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () =>
      ok({
        glue_info: {
          glue_type: 'DNS',
          ttl: '300',
          dns_main_list: [
            { record_type: 'a', record_value1: '1.2.3.4' },
            { record_type: 'mx', record_value1: 'mail.example.com', record_value2: '10' },
          ],
          dns_sub_list: [{ sub_host: 'www', record_type: 'a', record_value1: '1.2.3.4' }],
        },
      })
    );
    const records = await dy.getDnsRecords('example.com');
    expect(calls[0].path).toBe('/restful/v2/domains/example.com/records');
    expect(records).toEqual([
      { type: 'A', name: '@', value: '1.2.3.4', ttl: 300 },
      { type: 'MX', name: '@', value: 'mail.example.com', ttl: 300, priority: 10 },
      { type: 'A', name: 'www', value: '1.2.3.4', ttl: 300 },
    ]);
  });

  it('getDnsRecords returns [] when the domain is not Dynadot-DNS-hosted', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ok({ glue_info: { glue_type: 'NAME_SERVERS', nameserver_list: [] } }));
    expect(await dy.getDnsRecords('example.com')).toEqual([]);
  });

  it('checkAvailability maps bulk_search: available/premium/price from the 1-year entry', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () =>
      ok({
        domain_result_list: [
          {
            domain_name: 'free.com',
            available: 'Yes',
            premium: 'no',
            price_list: [
              { currency: 'USD', unit: '(price/1 year)', registration_price: '10.88' },
              { currency: 'USD', unit: '(price/2 year)', registration_price: '21.76' },
            ],
          },
          { domain_name: 'taken.com', available: 'No' },
        ],
      })
    );
    const results = await dy.checkAvailability(['free.com', 'taken.com']);
    expect(calls[0].path).toBe(
      '/restful/v2/domains/bulk_search?domain_name_list=free.com%2Ctaken.com&show_price=true'
    );
    expect(results).toEqual([
      {
        domainName: 'free.com',
        available: true,
        premium: false,
        price: 10.88,
        currency: 'USD',
        period: 1,
      },
      {
        domainName: 'taken.com',
        available: false,
        premium: undefined,
        price: undefined,
        currency: undefined,
        period: undefined,
      },
    ]);
  });

  it('getPricing prices a full domain and maps register/renew/transfer', async () => {
    const dy = dynadot();
    stubHttp(dy, () =>
      ok({
        domain_result_list: [
          {
            domain_name: 'example.com',
            price_list: [
              {
                currency: 'USD',
                unit: '(price/1 year)',
                registration_price: '10.88',
                renewal_price: '12.99',
                transfer_price: '9.50',
              },
            ],
          },
        ],
      })
    );
    expect(await dy.getPricing('example.com')).toEqual({
      tld: 'com',
      currency: 'USD',
      registration: 10.88,
      renewal: 12.99,
      transfer: 9.5,
    });
  });

  it('getPricing probes an available name for a bare TLD (owned names carry no price)', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () =>
      ok({
        domain_result_list: [
          {
            price_list: [
              {
                currency: 'USD',
                unit: '(price/1 year)',
                registration_price: '32.00',
                renewal_price: '32.00',
                transfer_price: '32.00',
              },
            ],
          },
        ],
      })
    );
    expect(await dy.getPricing('io')).toEqual({
      tld: 'io',
      currency: 'USD',
      registration: 32,
      renewal: 32,
      transfer: 32,
    });
    // It queried bulk_search with a synthesized available probe name in the TLD.
    expect(calls[0].path).toMatch(
      /bulk_search\?domain_name_list=price-probe-[a-z0-9]+\.io&show_price=true/
    );
  });

  it('setDnsRecords POSTs the DNS glue body (apex/sub split, MX in record_value2)', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ok({}));
    const res = await dy.setDnsRecords('example.com', [
      { type: 'A', name: '@', value: '1.2.3.4', ttl: 600 },
      { type: 'MX', name: '@', value: 'mail.example.com', priority: 20 },
      { type: 'CNAME', name: 'www', value: 'example.com' },
    ]);
    expect(res.success).toBe(true);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/restful/v2/domains/example.com/records',
    });
    expect(calls[0].body).toEqual({
      glue_type: 'DNS',
      dns_main_list: [
        { record_type: 'a', record_value1: '1.2.3.4' },
        { record_type: 'mx', record_value1: 'mail.example.com', record_value2: '20' },
      ],
      dns_sub_list: [{ record_type: 'cname', record_value1: 'example.com', sub_host: 'www' }],
      ttl: '600',
    });
  });

  it('setDnsRecords rejects unsupported record types', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ok({}));
    await expect(
      dy.setDnsRecords('example.com', [{ type: 'URL', name: '@', value: 'https://x.com' }])
    ).rejects.toThrow(/not supported/);
  });

  it('updateNameservers PUTs nameserver_list and enforces the 2-13 count', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ok({}));
    const res = await dy.updateNameservers('example.com', ['ns1.x.com', 'ns2.x.com']);
    expect(res.success).toBe(true);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/restful/v2/domains/example.com/nameservers',
      body: { nameserver_list: ['ns1.x.com', 'ns2.x.com'] },
    });
    await expect(dy.updateNameservers('example.com', ['only1.x.com'])).rejects.toThrow(/2-13/);
  });

  it('lock/unlock PUT a boolean lock; setPrivacy PUTs a privacy_level', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ok({}));
    await dy.lockDomain('example.com');
    await dy.unlockDomain('example.com');
    await dy.setPrivacy('example.com', true);
    await dy.setPrivacy('example.com', false);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/restful/v2/domains/example.com/domain_lock',
      body: { lock: true },
    });
    expect(calls[1].body).toEqual({ lock: false });
    expect(calls[2]).toMatchObject({
      path: '/restful/v2/domains/example.com/privacy',
      body: { privacy_level: 'full' },
    });
    expect(calls[3].body).toEqual({ privacy_level: 'off' });
  });

  it('setAutoRenew PUTs renew_option; renewDomain reads the exp year then POSTs duration+year', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, req =>
      req.method === 'GET'
        ? ok({ domain_info: { domain_name: 'example.com', expiration_date: 1811376748000 } })
        : ok({})
    );
    await dy.setAutoRenew('example.com', true);
    await dy.renewDomain('example.com', 2);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/restful/v2/domains/example.com/renew_option',
      body: { renew_option: 'auto' },
    });
    // renew first GETs the domain (for its expiration year), then POSTs the renew
    expect(calls[1]).toMatchObject({ method: 'GET', path: '/restful/v2/domains/example.com' });
    expect(calls[2]).toMatchObject({
      method: 'POST',
      path: '/restful/v2/domains/example.com/renew',
      body: { duration: 2, year: 2027 },
    });
  });

  it('registerDomain/transferIn require consent and POST the nested v2 bodies', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ok({}));

    await expect(dy.registerDomain('example.com', { contacts: {} })).rejects.toBeInstanceOf(
      ConsentRequiredError
    );
    await expect(dy.transferIn('example.com', { authCode: 'EPP1' })).rejects.toBeInstanceOf(
      ConsentRequiredError
    );

    const reg = await dy.registerDomain('example.com', {
      years: 2,
      privacy: true,
      contacts: {},
      consent: { agreedBy: 'user' },
    });
    expect(reg.success).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/restful/v2/domains/example.com/register',
      body: { domain: { duration: 2, privacy: 'full' } },
    });

    await dy.transferIn('example.com', { authCode: 'EPP1', consent: { agreedBy: 'user' } });
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/restful/v2/domains/example.com/transfer_in',
      body: { domain: { auth_code: 'EPP1', duration: 1, privacy: 'off' } },
    });
  });

  it('treats a 202 Accepted envelope (transfer_in) as success', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ({ code: 202, message: 'Accepted' }));
    const res = await dy.transferIn('example.com', {
      authCode: 'EPP1',
      consent: { agreedBy: 'user' },
    });
    expect(res.success).toBe(true);
  });

  // --- extended capabilities ---

  it('getAuthCode reads data.auth_code from the transfer_auth_code endpoint', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ok({ auth_code: 'EPP-SECRET' }));
    expect(await dy.getAuthCode('example.com')).toBe('EPP-SECRET');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].path).toBe('/restful/v2/domains/example.com/transfer_auth_code');
  });

  it('getDnssec maps dnssec_info_list and parses "(code)" labels', async () => {
    const dy = dynadot();
    stubHttp(dy, () =>
      ok({
        dnssec_info_list: [
          {
            key_tag: 12345,
            algorithm: 'RSA/SHA-256 (8)',
            digest_type: 'SHA-256 (2)',
            digest: 'ABCD',
          },
        ],
      })
    );
    expect(await dy.getDnssec('example.com')).toEqual({
      enabled: true,
      dsRecords: [{ keyTag: 12345, algorithm: 8, digestType: 2, digest: 'ABCD' }],
    });
  });

  it('getDnssec reports disabled for an empty list', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ok({ dnssec_info_list: [] }));
    expect(await dy.getDnssec('example.com')).toEqual({ enabled: false, dsRecords: [] });
  });

  it('disableDnssec DELETEs the dnssec resource with a JSON content-type', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ok({}));
    const res = await dy.disableDnssec('example.com');
    expect(res.success).toBe(true);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].path).toBe('/restful/v2/domains/example.com/dnssec');
    expect(calls[0].headers?.['Content-Type']).toBe('application/json');
  });

  it('getEmailForwarding reads MTYPE_FORWARD aliases from domain_info glue_info', async () => {
    const dy = dynadot();
    stubHttp(dy, () =>
      ok({
        domain_info: {
          glue_info: {
            email_forward_type: 'MTYPE_FORWARD',
            email_alias_list: [
              { username: 'hello', email: 'a@example.com' },
              { username: 'sales', email: 'b@example.com' },
            ],
          },
        },
      })
    );
    expect(await dy.getEmailForwarding('example.com')).toEqual([
      { alias: 'hello', forwardTo: 'a@example.com' },
      { alias: 'sales', forwardTo: 'b@example.com' },
    ]);
  });

  it('getEmailForwarding returns [] when forwarding is off', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ok({ domain_info: { glue_info: { email_forward_type: 'MTYPE_NONE' } } }));
    expect(await dy.getEmailForwarding('example.com')).toEqual([]);
  });

  it('setEmailForwarding sends mtype_forward with the alias list', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ok({}));
    await dy.setEmailForwarding('example.com', [{ alias: 'hello', forwardTo: 'a@example.com' }]);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].path).toBe('/restful/v2/domains/example.com/email_forwarding');
    expect(calls[0].body).toEqual({
      email_forward_type: 'mtype_forward',
      email_alias_list: [{ username: 'hello', email: 'a@example.com' }],
      email_exchange_list: [],
    });
  });

  it('setEmailForwarding clears with mtype_none on an empty list', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ok({}));
    await dy.setEmailForwarding('example.com', []);
    expect(calls[0].body).toMatchObject({ email_forward_type: 'mtype_none', email_alias_list: [] });
  });

  it('getDomainForwarding maps standard (permanent) and stealth (-> redirect) glue', async () => {
    const perm = dynadot();
    stubHttp(perm, () =>
      ok({
        domain_info: {
          glue_info: {
            glue_type: 'REGISTRAR_FORWARDING',
            forward_url: 'https://example.com/a',
            forward_type: 'permanently',
          },
        },
      })
    );
    expect(await perm.getDomainForwarding('example.com')).toEqual([
      { host: '@', url: 'https://example.com/a', type: 'permanent' },
    ]);

    const stealth = dynadot();
    stubHttp(stealth, () =>
      ok({
        domain_info: {
          glue_info: {
            glue_type: 'REGISTRAR_STEALTH_FORWARDING',
            forward_url: 'https://example.com/b',
            stealth_title: 'T',
          },
        },
      })
    );
    // stealth forwarding is reported as read-only `masked`
    expect(await stealth.getDomainForwarding('example.com')).toEqual([
      { host: '@', url: 'https://example.com/b', type: 'masked' },
    ]);
  });

  it('getDomainForwarding returns [] when the domain is not forwarding', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ok({ domain_info: { glue_info: { glue_type: 'NAME_SERVERS' } } }));
    expect(await dy.getDomainForwarding('example.com')).toEqual([]);
  });

  it('setDomainForwarding maps permanent/temporary to domain_forwarding', async () => {
    for (const [type, is_temporary] of [
      ['permanent', false],
      ['temporary', true],
    ] as const) {
      const dy = dynadot();
      const calls = stubHttp(dy, () => ok({}));
      await dy.setDomainForwarding('example.com', [{ host: '@', url: 'https://x.com', type }]);
      expect(calls[0].path).toBe('/restful/v2/domains/example.com/domain_forwarding');
      expect(calls[0].body).toEqual({ forward_url: 'https://x.com', is_temporary });
    }
    // masked forwarding is read-only: setting it is rejected
    await expect(
      dynadot().setDomainForwarding('example.com', [
        { host: '@', url: 'https://x.com', type: 'masked' },
      ])
    ).rejects.toThrow(/masked/i);
  });

  it('setDomainForwarding clears by restoring default nameservers on an empty list', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ok({}));
    await dy.setDomainForwarding('example.com', []);
    expect(calls[0].path).toBe('/restful/v2/domains/example.com/nameservers');
    expect(calls[0].body).toEqual({ nameserver_list: ['ns1.dynadot.com', 'ns2.dynadot.com'] });
  });

  it('setDomainForwarding rejects multiple rules and non-apex hosts (whole-domain only)', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ok({}));
    await expect(
      dy.setDomainForwarding('example.com', [
        { host: '@', url: 'https://a.com', type: 'permanent' },
        { host: '@', url: 'https://b.com', type: 'permanent' },
      ])
    ).rejects.toThrow(/whole domain/i);
    await expect(
      dy.setDomainForwarding('example.com', [
        { host: 'www', url: 'https://a.com', type: 'permanent' },
      ])
    ).rejects.toThrow(/per-host/i);
  });

  it('updateContacts creates a contact and PUTs role ids, preserving unspecified roles', async () => {
    const dy = dynadot();
    let created = 0;
    const calls = stubHttp(dy, (req: RequestConfig) => {
      const path = String(req.path);
      if (req.method === 'POST' && path === '/restful/v2/contacts') {
        return ok({ contact_id: 5001 + created++ });
      }
      if (
        path === '/restful/v2/domains/example.com' &&
        (req.method === undefined || req.method === 'GET')
      ) {
        return ok({
          domain_info: {
            registrant_contact_id: 1,
            admin_contact_id: 2,
            technical_contact_id: 3,
            billing_contact_id: 4,
          },
        });
      }
      return ok({});
    });

    const res = await dy.updateContacts('example.com', {
      registrant: {
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
      },
    });
    expect(res.success).toBe(true);

    // the created contact carries a joined name + split phone
    const post = calls.find(c => c.method === 'POST' && String(c.path) === '/restful/v2/contacts');
    expect((post?.body as { contact: Record<string, unknown> }).contact).toMatchObject({
      name: 'Jane Doe',
      phone_cc: '1',
      phone_number: '4805551234',
      organization: 'Acme',
      state: 'AZ',
    });

    // the PUT sets the new registrant id and preserves admin/tech/billing
    const put = calls.find(
      c => c.method === 'PUT' && String(c.path) === '/restful/v2/domains/example.com/contacts'
    );
    expect(put?.body).toEqual({
      registrant_contact_id: 5001,
      admin_contact_id: 2,
      technical_contact_id: 3,
      billing_contact_id: 4,
    });

    await expect(dy.updateContacts('example.com', {})).rejects.toThrow(/at least one/i);
  });
});

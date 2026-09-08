import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  Feature,
  InvalidResponseError,
  NamecomRegistrar,
  NotFoundError,
  RateLimitError,
  RegistrarClient,
  createRegistrar,
} from '../src/index';
import type { Contact, RegistrarOptions } from '../src/index';

const contact: Contact = {
  firstName: 'Test',
  lastName: 'Registrant',
  email: 'test@example.com',
  phone: '+1.2025550123',
  address1: '123 Test St',
  city: 'Denver',
  state: 'CO',
  postalCode: '80202',
  country: 'US',
};
const rawDomain = {
  domainName: 'Example.COM',
  createDate: '2020-01-02T03:04:05Z',
  expireDate: '2030-01-02T03:04:05Z',
  autorenewEnabled: true,
  locked: true,
  locks: ['clientTransferProhibited'],
  privacyEnabled: true,
  nameservers: ['NS1.NAME.COM', 'ns2.name.com'],
};
const quote = { premium: false, purchasePrice: 12, renewalPrice: 15, transferPrice: 10 };
const order = { order: 123, domain: { domainName: 'example.com' } };
function provider(options?: RegistrarOptions) {
  return createRegistrar(
    'namecom',
    { username: 'user-test', apiToken: 'secret-token' },
    { retries: 0, ...options }
  );
}
function responses(...values: unknown[]) {
  const mock = vi.fn<typeof fetch>();
  for (const value of values) {
    if (value instanceof Error) mock.mockRejectedValueOnce(value);
    else mock.mockResolvedValueOnce(value instanceof Response ? value : Response.json(value));
  }
  vi.stubGlobal('fetch', mock);
  return mock;
}
function requestUrl(url: string | URL | Request): string {
  return typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
}
function body(mock: ReturnType<typeof responses>, index = 0): unknown {
  return JSON.parse(mock.mock.calls[index][1]?.body as string) as unknown;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Name.com metadata and authentication', () => {
  it('constructs from the public registry and advertises only implemented extended features', () => {
    expect(provider()).toBeInstanceOf(NamecomRegistrar);
    expect(NamecomRegistrar.extendedFeatures).toEqual([Feature.GetAuthCode]);
    expect(provider().supports(Feature.GetEmailForwarding)).toBe(false);
    expect(provider().requiresNameserversFetch).toBe(false);
    expect(NamecomRegistrar.configFields.map(f => f.name)).toEqual(['username', 'apiToken']);
  });
  it.each(['production', 'sandbox'] as const)(
    'uses Basic auth with the %s Core host',
    async environment => {
      const mock = responses({ domains: [] });
      expect((await provider({ environment }).testConnection()).success).toBe(true);
      const [url, req] = mock.mock.calls[0];
      expect(requestUrl(url)).toBe(
        `https://api.${environment === 'sandbox' ? 'dev.' : ''}name.com/core/v1/domains?perPage=1&page=1`
      );
      expect(req?.headers).toMatchObject({
        Authorization: `Basic ${btoa('user-test:secret-token')}`,
      });
      expect(requestUrl(url)).not.toContain('secret-token');
    }
  );
  it('rejects ambiguous Basic usernames without echoing the credentials', () => {
    expect(() => createRegistrar('namecom', { username: 'bad:name', apiToken: 'secret' })).toThrow(
      ConfigurationError
    );
  });
  it('encodes UTF-8 credentials without Node Buffer', async () => {
    const mock = responses({ domains: [] });
    await createRegistrar('namecom', { username: 'café', apiToken: 'token' }).testConnection();
    expect(mock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Basic Y2Fmw6k6dG9rZW4=',
    });
  });
});

describe('Name.com portfolio and pricing', () => {
  it('follows nextPage across short pages and normalizes domain flags and dates', async () => {
    const mock = responses(
      { domains: [rawDomain], nextPage: 2 },
      { domains: [{ domainName: 'second.net' }], nextPage: 3 },
      { domains: [{ domainName: 'third.org' }] }
    );
    const result = await provider().listDomains();
    expect(result.map(d => d.domainName)).toEqual(['example.com', 'second.net', 'third.org']);
    expect(
      mock.mock.calls.map(([url]) => new URL(requestUrl(url)).searchParams.get('page'))
    ).toEqual(['1', '2', '3']);
    expect(result[0]).toMatchObject({
      registrar: 'namecom',
      createdDate: new Date(rawDomain.createDate),
      expirationDate: new Date(rawDomain.expireDate),
      renewalDate: null,
      status: 'clienttransferprohibited',
      autoRenew: true,
      locked: true,
      privacy: true,
      nameservers: ['ns1.name.com', 'ns2.name.com'],
    });
    expect(result[1]).toMatchObject({
      autoRenew: false,
      locked: false,
      privacy: false,
      nameservers: [],
      status: '',
    });
  });
  it('filters after all pages and supports omitted empty arrays', async () => {
    const mock = responses(
      { domains: [rawDomain], nextPage: 2 },
      { domains: [{ domainName: 'Match.net' }] }
    );
    expect((await provider().listDomains({ search: ' MATCH ' })).map(d => d.domainName)).toEqual([
      'match.net',
    ]);
    expect(mock).toHaveBeenCalledTimes(2);
    responses({});
    expect(await provider().listDomains()).toEqual([]);
  });
  it.each([1, -1, '2', 1.5])('rejects invalid/nonadvancing pagination %s', async nextPage => {
    responses({ domains: [], nextPage });
    await expect(provider().listDomains()).rejects.toBeInstanceOf(InvalidResponseError);
  });
  it('rejects malformed lists and detail responses', async () => {
    responses({ domains: {} });
    await expect(provider().listDomains()).rejects.toBeInstanceOf(InvalidResponseError);
    responses({});
    await expect(provider().getDomain('example.com')).rejects.toBeInstanceOf(InvalidResponseError);
  });
  it('enriches through the facade without redundant nameserver requests', async () => {
    const mock = responses({ domains: [{ domainName: 'example.com' }] }, rawDomain);
    const result = await new RegistrarClient(provider()).listDomains({ detailed: true });
    expect(result[0].nameservers).toEqual(['ns1.name.com', 'ns2.name.com']);
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('reads nameservers and auth code using Core action paths', async () => {
    const mock = responses(rawDomain, { authCode: 'transfer-secret' });
    expect(await provider().getNameservers('Example.com.')).toEqual([
      'ns1.name.com',
      'ns2.name.com',
    ]);
    expect(await provider().getAuthCode('example.com')).toBe('transfer-secret');
    expect(requestUrl(mock.mock.calls[1][0]).endsWith('/domains/example.com:getAuthCode')).toBe(
      true
    );
  });
  it('uses exact domain renewal prices, preserving zero and omitting null products', async () => {
    const mock = responses({
      premium: true,
      purchasePrice: null,
      renewalPrice: 0,
      transferPrice: 900,
    });
    expect(await provider().getPricing('Example.CO.UK')).toEqual({
      tld: 'co.uk',
      currency: 'USD',
      registration: undefined,
      renewal: 0,
      transfer: 900,
    });
    expect(
      requestUrl(mock.mock.calls[0][0]).endsWith('/domains/example.co.uk:getPricing?years=1')
    ).toBe(true);
  });
  it('uses account-level TLD prices and requests a one-year duration explicitly', async () => {
    const mock = responses({
      pricing: [
        {
          tld: 'co.uk',
          duration: 1,
          registrationPrice: 5,
          renewalPrice: 8,
          transferInPrice: 0,
          renewalRetailPrice: 99,
        },
      ],
    });
    expect(await provider().getPricing('.co.uk')).toEqual({
      tld: 'co.uk',
      currency: 'USD',
      registration: 5,
      renewal: 8,
      transfer: 0,
    });
    const url = new URL(requestUrl(mock.mock.calls[0][0]));
    expect(url.pathname).toBe('/core/v1/tldpricing');
    expect(url.searchParams.get('tlds')).toBe('co.uk');
    expect(url.searchParams.get('duration')).toBe('1');
  });
  it('does not substitute unsupported or wrong-term TLD pricing', async () => {
    responses({ pricing: [{ tld: 'ai', duration: 2, renewalPrice: 160 }] });
    await expect(provider().getPricing('ai')).rejects.toBeInstanceOf(NotFoundError);
  });
  it('chunks availability at 50 and excludes aftermarket acquisition offers', async () => {
    const mock = responses(
      {
        results: [
          {
            domainName: 'a.com',
            purchasable: true,
            purchasePrice: 10,
            purchaseType: 'registration',
          },
        ],
      },
      {
        results: [
          { domainName: 'b.com', purchasable: true, purchaseType: 'aftermarket_s' },
          { domainName: 'taken.com' },
        ],
      }
    );
    const results = await provider().checkAvailability(
      Array.from({ length: 51 }, (_, i) => `domain${i}.com`)
    );
    expect(body(mock, 0)).toMatchObject({
      purchaseType: 'registration',
      domainNames: expect.any(Array) as unknown,
    });
    expect((body(mock, 0) as { domainNames: string[] }).domainNames).toHaveLength(50);
    expect((body(mock, 1) as { domainNames: string[] }).domainNames).toHaveLength(1);
    expect(results.map(r => r.available)).toEqual([true, false, false]);
    expect(results[0].period).toBeUndefined();
  });
  it('does not send empty availability requests', async () => {
    const mock = responses();
    expect(await provider().checkAvailability([])).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('Name.com paid operations', () => {
  it('uses a matching multi-year registration quote for registry premiums', async () => {
    const mock = responses(
      {
        results: [
          { domainName: 'example.com', purchasable: true, premium: true, purchasePrice: 999 },
        ],
      },
      { ...quote, premium: true, purchasePrice: 1500 },
      order
    );
    expect(
      (
        await provider().registerDomain('example.com', {
          years: 3,
          contacts: { registrant: contact },
          privacy: true,
          autoRenew: false,
          nameservers: ['ns1.name.com'],
        })
      ).success
    ).toBe(true);
    expect(requestUrl(mock.mock.calls[1][0]).endsWith(':getPricing?years=3')).toBe(true);
    expect(body(mock, 2)).toMatchObject({
      years: 3,
      purchasePrice: 1500,
      purchaseType: 'registration',
      domain: {
        privacyEnabled: true,
        autorenewEnabled: false,
        contacts: { registrant: { zip: '80202', phone: '+12025550123' } },
      },
    });
  });
  it('omits purchasePrice on standard registrations', async () => {
    const mock = responses(
      { results: [{ domainName: 'example.com', purchasable: true }] },
      quote,
      order
    );
    await provider().registerDomain('example.com', { contacts: { registrant: contact } });
    expect(body(mock, 2)).not.toHaveProperty('purchasePrice');
  });
  it('does not purchase on an availability result for another domain', async () => {
    const mock = responses({ results: [{ domainName: 'wrong.com', purchasable: true }] });
    expect(
      (await provider().registerDomain('example.com', { contacts: { registrant: contact } }))
        .success
    ).toBe(false);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('does not submit a registration if unavailable', async () => {
    const mock = responses({ results: [{ domainName: 'example.com', purchasable: false }] });
    expect(
      (await provider().registerDomain('example.com', { contacts: { registrant: contact } }))
        .success
    ).toBe(false);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('uses renewalPrice for the requested term, never registration or discovery prices', async () => {
    const mock = responses({ ...quote, premium: true, renewalPrice: 45 }, order);
    expect((await provider().renewDomain('example.com', 3)).success).toBe(true);
    expect(requestUrl(mock.mock.calls[0][0]).endsWith(':getPricing?years=3')).toBe(true);
    expect(requestUrl(mock.mock.calls[1][0]).endsWith(':renew')).toBe(true);
    expect(body(mock, 1)).toEqual({ years: 3, purchasePrice: 45 });
  });
  it('omits standard renewal prices and rejects unavailable prices before purchasing', async () => {
    const mock = responses(quote, order);
    await provider().renewDomain('example.com');
    expect(body(mock, 1)).toEqual({ years: 1 });
    const noPrice = responses({ ...quote, renewalPrice: null });
    await expect(provider().renewDomain('example.com')).rejects.toThrow('no purchase submitted');
    expect(noPrice).toHaveBeenCalledTimes(1);
  });
  it('transfers with transferPrice and privacy, reporting accepted rather than completed', async () => {
    const mock = responses(
      { ...quote, premium: true },
      { order: 123, transfer: { domainName: 'example.com', status: 'pending' } }
    );
    const result = await provider().transferIn('example.com', {
      authCode: 'epp-secret',
      privacy: false,
    });
    expect(result).toMatchObject({
      success: true,
      message: expect.stringContaining('request accepted') as unknown,
    });
    expect(body(mock, 1)).toEqual({
      domainName: 'example.com',
      authCode: 'epp-secret',
      privacyEnabled: false,
      purchasePrice: 10,
    });
    expect(requestUrl(mock.mock.calls[0][0]).endsWith(':getPricing')).toBe(true);
    expect(requestUrl(mock.mock.calls[1][0]).endsWith('/transfers')).toBe(true);
  });
  it.each([{ years: 1 }, { contacts: { registrant: contact } }, { autoRenew: false }])(
    'rejects unsupported transfer options before purchase: %j',
    async extra => {
      const mock = responses();
      await expect(
        provider().transferIn('example.com', { authCode: 'secret', ...extra })
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(mock).not.toHaveBeenCalled();
    }
  );
  it.each([0, -1, 1.5, 11])('rejects invalid years %s before requests', async years => {
    const mock = responses();
    await expect(provider().renewDomain('example.com', years)).rejects.toBeInstanceOf(
      ConfigurationError
    );
    expect(mock).not.toHaveBeenCalled();
  });
  it.each([
    new Error('network lost'),
    new Response('bad gateway', { status: 502 }),
    new Response('not JSON', { status: 200 }),
    {},
  ])('does not retry uncertain paid responses even with retry overrides', async failure => {
    const mock = responses(quote, failure);
    const result = await provider({ retries: 5 }).renewDomain('example.com', 1, {
      retries: 10,
      backoff: 0,
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Outcome unknown');
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it.each([400, 402, 409, 422, 429])('never retries rejected paid requests (%s)', async status => {
    const mock = responses(quote, new Response('rejected', { status }));
    const result = await provider({ retries: 3 }).renewDomain('example.com', 1, {
      retries: 5,
      backoff: 0,
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain(String(status));
    expect(result.message).not.toContain('Outcome unknown');
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe('Name.com management and contacts', () => {
  it('uses PATCH and preserves false flags', async () => {
    const mock = responses({}, {}, {}, {}, {});
    const p = provider();
    await p.setAutoRenew('example.com', false);
    await p.lockDomain('example.com');
    await p.unlockDomain('example.com');
    await p.setPrivacy('example.com', false);
    await p.setPrivacy('example.com', true);
    expect(mock.mock.calls.every(([, req]) => req?.method === 'PATCH')).toBe(true);
    expect(mock.mock.calls.map((_, i) => body(mock, i))).toEqual([
      { autorenewEnabled: false },
      { locked: true },
      { locked: false },
      { privacyEnabled: false },
      { privacyEnabled: true },
    ]);
  });
  it('uses the Core nameserver action', async () => {
    const mock = responses({});
    await provider().updateNameservers('example.com', ['ns1.name.com', 'ns2.name.com']);
    expect(requestUrl(mock.mock.calls[0][0]).endsWith(':setNameservers')).toBe(true);
    expect(body(mock)).toEqual({ nameservers: ['ns1.name.com', 'ns2.name.com'] });
  });
  it('maps legacy null contacts and writes only supplied complete roles', async () => {
    const mock = responses(
      {
        ...rawDomain,
        contacts: { registrant: { firstName: null, zip: '80202', companyName: 'Test Inc' } },
      },
      {}
    );
    const contacts = await provider().getContacts('example.com');
    expect(contacts.registrant).toMatchObject({
      firstName: '',
      postalCode: '80202',
      organization: 'Test Inc',
    });
    await provider().updateContacts('example.com', { tech: contact });
    expect(requestUrl(mock.mock.calls[1][0]).endsWith(':setContacts')).toBe(true);
    expect(body(mock, 1)).toHaveProperty('contacts.tech.phone', '+12025550123');
    expect(body(mock, 1)).not.toHaveProperty('contacts.registrant');
  });
  it('rejects incomplete contacts without making writes', () => {
    const mock = responses();
    expect(() =>
      provider().updateContacts('example.com', { registrant: { ...contact, state: undefined } })
    ).toThrow(ConfigurationError);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('Name.com DNS reconciliation', () => {
  const a = { id: 1, type: 'A', host: '', answer: '192.0.2.1', ttl: 300 };
  it('paginates DNS and decodes SRV, MX and apex hosts', async () => {
    responses(
      { records: [a], nextPage: 2 },
      {
        records: [
          {
            id: 2,
            type: 'SRV',
            host: '_sip._tcp',
            answer: '5 5060 sip.example.com',
            priority: 10,
            ttl: 600,
          },
          { id: 3, type: 'MX', host: '@', answer: 'mail.example.com', priority: 0, ttl: 300 },
        ],
      }
    );
    expect(await provider().getDnsRecords('example.com')).toEqual([
      { type: 'A', name: '@', value: '192.0.2.1', ttl: 300 },
      {
        type: 'SRV',
        name: '_sip._tcp',
        value: 'sip.example.com',
        weight: 5,
        port: 5060,
        priority: 10,
        ttl: 600,
      },
      { type: 'MX', name: '@', value: 'mail.example.com', priority: 0, ttl: 300 },
    ]);
  });
  it('preserves exact matches before updating same-host records, creates before stale deletes', async () => {
    const mock = responses(
      {
        records: [
          a,
          { ...a, id: 2, answer: '192.0.2.2' },
          { id: 3, type: 'TXT', host: 'stale', answer: 'old', ttl: 300 },
        ],
      },
      {},
      {},
      new Response(null, { status: 204 })
    );
    const result = await provider().setDnsRecords('example.com', [
      { type: 'A', name: '@', value: '192.0.2.3' },
      { type: 'A', name: '@', value: '192.0.2.1' },
      {
        type: 'SRV',
        name: '_sip._tcp',
        value: 'sip.example.com',
        priority: 0,
        weight: 5,
        port: 5060,
      },
    ]);
    expect(result.success).toBe(true);
    expect(
      mock.mock.calls.slice(1).map(([url, req]) => [new URL(requestUrl(url)).pathname, req?.method])
    ).toEqual([
      ['/core/v1/domains/example.com/records/2', 'PUT'],
      ['/core/v1/domains/example.com/records', 'POST'],
      ['/core/v1/domains/example.com/records/3', 'DELETE'],
    ]);
    expect(body(mock, 2)).toMatchObject({
      answer: '5 5060 sip.example.com',
      priority: 0,
      ttl: 300,
    });
  });
  it('clears all records using their ids', async () => {
    const mock = responses({ records: [a] }, new Response(null, { status: 204 }));
    expect((await provider().setDnsRecords('example.com', [])).success).toBe(true);
    expect(mock.mock.calls[1][1]?.method).toBe('DELETE');
  });
  it('deduplicates identical DNS input before reconciling existing records', async () => {
    const mock = responses({ records: [a] });
    const record = { type: 'A', name: '@', value: a.answer };
    expect((await provider().setDnsRecords('example.com', [record, record])).success).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('makes no writes for unchanged records', async () => {
    const mock = responses({ records: [a] });
    expect(
      (await provider().setDnsRecords('example.com', [{ type: 'A', name: '@', value: a.answer }]))
        .success
    ).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it.each([
    { type: 'CAA', name: '@', value: '0 issue ca.example' },
    { type: 'A', name: '@', value: '192.0.2.2', ttl: 60 },
  ])('validates all DNS input before mutation: %j', async record => {
    const mock = responses();
    await expect(provider().setDnsRecords('example.com', [record])).rejects.toBeInstanceOf(
      ConfigurationError
    );
    expect(mock).not.toHaveBeenCalled();
  });
  it('stops on failure and warns about partial state without retrying', async () => {
    const mock = responses({ records: [a] }, new Response('error', { status: 500 }));
    const result = await provider({ retries: 3 }).setDnsRecords(
      'example.com',
      [{ type: 'TXT', name: '@', value: 'new' }],
      { retries: 5 }
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('not atomic');
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('refuses to mutate when record ids are missing', async () => {
    const mock = responses({ records: [{ ...a, id: undefined }] });
    expect((await provider().setDnsRecords('example.com', [])).success).toBe(false);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('Name.com errors and safe read retries', () => {
  it.each([
    [401, AuthenticationError],
    [403, AuthorizationError],
    [404, NotFoundError],
    [429, RateLimitError],
  ] as const)('maps HTTP %s without reflecting secrets', async (status, ErrorType) => {
    responses(new Response('secret-token user-test epp-secret', { status }));
    const error: unknown = await provider()
      .getDomain('example.com')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorType);
    expect((error as Error).message).not.toMatch(/secret-token|user-test|epp-secret/);
  });
  it('retries read-only requests on transient failures', async () => {
    const mock = responses(new Response('down', { status: 503 }), rawDomain);
    expect((await provider({ retries: 1, backoff: 0 }).getDomain('example.com')).domainName).toBe(
      'example.com'
    );
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('honors X-RateLimit-Reset instead of immediately retrying without Retry-After', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    const mock = responses(
      new Response('', {
        status: 429,
        headers: { 'X-RateLimit-Reset': String(Date.now() / 1000 + 2) },
      }),
      rawDomain
    );
    const result = provider({ retries: 1, backoff: 0 }).getDomain('example.com');
    await vi.advanceTimersByTimeAsync(1999);
    expect(mock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('does not reflect malformed responses or network error excerpts', async () => {
    responses(new Response('secret-token epp-secret', { status: 200 }));
    await expect(provider().getDomain('example.com')).rejects.toThrow(
      'namecom: invalid JSON response'
    );
    responses(new Error('secret-token epp-secret'));
    await expect(provider().getDomain('example.com')).rejects.toThrow(
      'namecom: network request failed'
    );
  });
  it('honors caller cancellation without making a network request', async () => {
    const mock = responses();
    const controller = new AbortController();
    controller.abort();
    await expect(provider().listDomains({ signal: controller.signal })).rejects.toThrow('aborted');
    expect(mock).not.toHaveBeenCalled();
  });
  it('keeps unsupported extended capabilities unavailable', async () => {
    await expect(provider().getDnssec('example.com')).rejects.toThrow('not implemented');
  });
});

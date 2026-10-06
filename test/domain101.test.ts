import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  Domain101Registrar,
  Feature,
  InvalidResponseError,
  NotFoundError,
  NotImplementedError,
  RateLimitError,
  RegistrarError,
  createRegistrar,
  type RegistrarOptions,
} from '../src/index';

const raw = {
  domain_name: 'EXAMPLE.COM',
  status: 'ACTIVE',
  registered_at: '2020-01-02T03:04:05Z',
  created_at: '2019-01-01T00:00:00Z',
  expires_at: '2030-01-02T03:04:05Z',
  registry_statuses: ['clientTransferProhibited'],
  auto_renew: true,
  nameservers: ['NS1.101DOMAIN.COM', 'NS2.101DOMAIN.COM'],
  // the live API's shape for a domain without forwarding
  web_forwarding: { destination: null, type: null },
};
const success = (data: unknown, meta?: unknown) => ({
  status: 'success',
  code: 'OK',
  message: '',
  data,
  ...(meta ? { meta } : {}),
});
const page = (data: unknown[], current_page = 1, total_pages = 1, total = data.length) =>
  success(data, { pagination: { current_page, total_pages, per_page: 50, total } });
const apiError = (status: number, code: string, message: string) =>
  Response.json({ status: 'error', code, message, errors: null }, { status });
const quote = {
  register: '12.50',
  renew: '15.00',
  transfer: '10.00',
  currency: 'USD',
  premium: false,
  term_years: 1,
};
function provider(options?: RegistrarOptions) {
  return createRegistrar('101domain', { apiKey: 'secret-token' }, { retries: 0, ...options });
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
function url(mock: ReturnType<typeof responses>, index = 0) {
  const input = mock.mock.calls[index][0];
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}
function body(mock: ReturnType<typeof responses>, index = 0): unknown {
  return JSON.parse(mock.mock.calls[index][1]?.body as string);
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('101domain authentication and metadata', () => {
  it('uses Bearer auth and validates portfolio access rather than public search access', async () => {
    const mock = responses(success([]));
    expect(provider()).toBeInstanceOf(Domain101Registrar);
    expect(await provider().testConnection()).toMatchObject({ success: true });
    expect(url(mock).href).toBe('https://api.101domain.com/v1/domains?page=1&per_page=1');
    expect(mock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
    expect(url(mock).href).not.toContain('secret-token');
    expect(Domain101Registrar.configFields).toEqual([
      { name: 'apiKey', label: 'API key', type: 'password', required: true },
    ]);
    expect(Domain101Registrar.supportsSandbox).toBe(false);
    expect(Domain101Registrar.extendedFeatures).toEqual([
      Feature.GetDomainForwarding,
      Feature.SetDomainForwarding,
    ]);
    expect(provider().supports(Feature.GetAuthCode)).toBe(false);
  });
  it('rejects sandbox and header injection without making requests', () => {
    expect(() => provider({ environment: 'sandbox' })).toThrow(ConfigurationError);
    expect(() => createRegistrar('101domain', { apiKey: 'abc\r\nx-test: secret' })).toThrow(
      ConfigurationError
    );
  });
  it.each([
    [401, AuthenticationError],
    [403, AuthorizationError],
    [429, RateLimitError],
  ] as const)(
    'keeps typed HTTP %s errors and redacts upstream bodies',
    async (status, ErrorClass) => {
      responses(
        new Response('secret-token private-contact', { status, headers: { 'Retry-After': '17' } })
      );
      const error = await provider()
        .getDomain('example.com')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ErrorClass);
      expect((error as Error).message).not.toMatch(/secret-token|private-contact/);
      if (error instanceof RateLimitError) expect(error.retryAfter).toBe(17);
    }
  );
  it("keeps the API's error code and message, but not other body fields", async () => {
    responses(
      Response.json(
        {
          status: 'error',
          code: 'NAMESERVERS_NOT_LOCAL',
          message:
            'DNS records cannot be managed here because the domain is using third-party nameservers.',
          errors: { secret: 'private-contact' },
        },
        { status: 400 }
      )
    );
    const error = (await provider()
      .getDnsRecords('example.com')
      .catch((e: unknown) => e)) as RegistrarError;
    expect(error).toMatchObject({
      status: 400,
      providerCode: 'NAMESERVERS_NOT_LOCAL',
      message:
        '101domain: DNS records cannot be managed here because the domain is using third-party nameservers.',
    });
    expect(error.message).not.toContain('private-contact');
  });
  it('says a 403 without an API error never reached the API', async () => {
    responses(new Response('<html>Just a moment...</html>', { status: 403 }));
    const error = await provider()
      .getDomain('example.com')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorizationError);
    expect((error as Error).message).toMatch(/refused before reaching the API/);
  });
  it('rejects a successful HTTP response with an error or malformed envelope', async () => {
    responses({ status: 'error', data: [], message: 'secret-token' });
    await expect(provider().listDomains()).rejects.toThrow(InvalidResponseError);
    responses('secret-token');
    expect((await provider().testConnection()).message).not.toContain('secret-token');
  });
});

describe('101domain portfolio completeness', () => {
  it('follows total_pages across short pages, then filters and normalizes detail', async () => {
    const mock = responses(
      page([raw], 1, 2, 2),
      page([{ ...raw, domain_name: 'SECOND.NET', status: 'EXPIRED', expires_at: null }], 2, 2, 2)
    );
    const result = await provider().listDomains();
    expect(result.map(d => d.domainName)).toEqual(['example.com', 'second.net']);
    expect(mock.mock.calls.map((_, i) => url(mock, i).searchParams.get('page'))).toEqual([
      '1',
      '2',
    ]);
    expect(result[0]).toMatchObject({
      registrar: '101domain',
      status: 'active',
      createdDate: new Date(raw.registered_at),
      expirationDate: new Date(raw.expires_at),
      autoRenew: true,
      locked: true,
      nameservers: ['ns1.101domain.com', 'ns2.101domain.com'],
    });
    expect(result[1]).toMatchObject({ status: 'expired', expirationDate: null });
    responses(page([raw], 1, 2, 2), page([{ ...raw, domain_name: 'SECOND.NET' }], 2, 2, 2));
    expect((await provider().listDomains({ search: ' SECOND ' })).map(d => d.domainName)).toEqual([
      'second.net',
    ]);
  });
  it('accepts an empty account and does not guess dates or privacy', async () => {
    responses(page([], 1, 0, 0));
    expect(await provider().listDomains()).toEqual([]);
    responses(
      success({
        domain_name: 'EXAMPLE.COM',
        registered_at: null,
        expires_at: null,
        status: 'DELETED',
      })
    );
    expect(await provider().getDomain('example.com')).toMatchObject({
      createdDate: null,
      expirationDate: null,
      deleted: true,
      privacy: false,
    });
  });
  it.each([
    [success([raw])],
    [page([raw], 2, 2, 2)],
    [page([raw], 1, 2, 2), page([], 2, 2, 2)],
    [page([raw], 1, 2, 2), page([raw], 2, 2, 2)],
    [page([raw], 1, 3, 3), page([], 2, 3, 3)],
  ])('rejects incomplete or non-advancing portfolios', async (...values) => {
    responses(...values);
    await expect(provider().listDomains()).rejects.toThrow(InvalidResponseError);
  });
  it('drops names the account no longer or never held', async () => {
    const gone = [
      {
        ...raw,
        domain_name: 'DENIED.BIO',
        status: 'DENIED',
        registered_at: null,
        expires_at: null,
      },
      { ...raw, domain_name: 'DELETED.EE', status: 'DELETED', registered_at: null },
      { ...raw, domain_name: 'CANCELLED.NET', status: 'CANCELLED' },
      { ...raw, domain_name: 'AWAY.IO', status: 'XFER_AWAY' },
      { ...raw, domain_name: 'INCOMING.ORG', status: 'XFER_IN_PEND', registered_at: null },
      { ...raw, domain_name: 'APPLIED.APP', status: 'PROCESSING', registered_at: null },
    ];
    const held = [
      raw,
      { ...raw, domain_name: 'LAPSED.COM', status: 'EXPIRED' },
      { ...raw, domain_name: 'LEAVING.COM', status: 'XFER_PEND' },
    ];
    responses(page([...gone, ...held]));
    expect((await provider().listDomains()).map(d => d.domainName)).toEqual([
      'example.com',
      'lapsed.com',
      'leaving.com',
    ]);
    responses(success({ ...raw, status: 'XFER_AWAY' }));
    expect(await provider().getDomain('example.com')).toMatchObject({ deleted: true });
    responses(success(raw));
    expect(await provider().getDomain('example.com')).toMatchObject({ deleted: false });
  });
  it('rejects detail for a different domain', async () => {
    responses(success({ ...raw, domain_name: 'other.com' }));
    await expect(provider().getDomain('example.com')).rejects.toThrow(/identity/);
  });
});

describe('101domain pricing and availability', () => {
  it('checks up to 50 names per batch and preserves currencies and premiums', async () => {
    const names = Array.from({ length: 51 }, (_, i) => `name${i}.com`);
    const mock = responses(
      success(
        names.slice(0, 50).map(domain_name => ({ domain_name, available: true, pricing: [quote] }))
      ),
      success([{ domain_name: names[50], available: true, pricing: [{ ...quote, premium: true }] }])
    );
    const result = await provider().checkAvailability(names);
    expect(result).toHaveLength(51);
    expect(body(mock, 0)).toEqual({ domains: names.slice(0, 50), pricing_term: 1 });
    expect(result[50]).toMatchObject({
      available: true,
      premium: true,
      price: 12.5,
      renewalPrice: 15,
      currency: 'USD',
      period: 1,
    });
    expect(await provider().checkAvailability([])).toEqual([]);
  });
  it('rejects omitted, invalid or unrelated availability results', async () => {
    responses(success([]));
    await expect(provider().checkAvailability(['example.com'])).rejects.toThrow(/incomplete/);
    responses({ ...success([]), invalid: ['example.com'] });
    await expect(provider().checkAvailability(['example.com'])).rejects.toThrow(/availability/);
    responses(success([{ domain_name: 'other.com', available: false }]));
    await expect(provider().checkAvailability(['example.com'])).rejects.toThrow(/identity/);
  });
  it('uses explicit compound TLDs and only one-year prices', async () => {
    const mock = responses(
      success({
        pricing: [
          { ...quote, term_years: 2 },
          { ...quote, currency: 'EUR', term_years: 1 },
        ],
      })
    );
    expect(await provider().getPricing('.co.uk')).toEqual({
      tld: 'co.uk',
      currency: 'EUR',
      registration: 12.5,
      renewal: 15,
      transfer: 10,
    });
    expect(url(mock).pathname).toBe('/v1/tlds/.co.uk');
    expect(url(mock).searchParams.get('pricing_terms')).toBe('1');
    responses(success({ pricing: [{ ...quote, term_years: 2 }] }));
    await expect(provider().getPricing('com')).rejects.toThrow(/one-year/);
  });
  it('uses the documented single-domain search parameters without guessing missing renewal prices', async () => {
    const mock = responses(
      success({
        domain_name: 'EXAMPLE.COM',
        available: true,
        pricing: [
          { ...quote, term_years: 2, renew: '99.00' },
          { ...quote, renew: undefined },
        ],
      })
    );
    expect(await provider().getPricing('example.com')).toMatchObject({
      registration: 12.5,
      renewal: undefined,
    });
    expect(url(mock).searchParams.get('domain_name')).toBe('example.com');
    expect(url(mock).searchParams.get('pricing_terms')).toBe('1');
    responses(
      success({ domain_name: 'example.com', available: true, pricing: [{ ...quote, renew: '' }] })
    );
    await expect(provider().getPricing('example.com')).rejects.toThrow(/price/);
  });
  it('has no price for a taken name, the account’s own included', async () => {
    responses(success([{ domain_name: 'TAKEN.COM', available: false, pricing: null }]));
    expect(await provider().checkAvailability(['taken.com'])).toEqual([
      { domainName: 'taken.com', available: false, period: 1 },
    ]);
    responses(success({ domain_name: 'TAKEN.COM', available: false, pricing: null }));
    await expect(provider().getPricing('taken.com')).rejects.toThrow(NotFoundError);
  });
});

describe('101domain nameservers and write outcomes', () => {
  it('redacts uncertain network errors and does not retry malformed write confirmations', async () => {
    const dropped = responses(new Error('secret-token private-contact'));
    const result = await provider({ retries: 3 }).updateNameservers('example.com', [
      'ns1.new.net',
      'ns2.new.net',
    ]);
    expect(result).toMatchObject({ success: false, outcome: 'unknown' });
    expect(result.message).not.toMatch(/secret-token|private-contact/);
    expect(dropped).toHaveBeenCalledTimes(1);
    const malformed = responses({ message: 'secret-token' });
    expect(
      await provider({ retries: 3 }).updateNameservers('example.com', [
        'ns1.new.net',
        'ns2.new.net',
      ])
    ).toMatchObject({ success: false, outcome: 'unknown' });
    expect(malformed).toHaveBeenCalledTimes(1);
  });
  it('reports registry-pending changes without claiming active nameservers', async () => {
    const mock = responses(
      success({ change_status: 'pending', current_nameservers: ['ns1.old.net', 'ns2.old.net'] })
    );
    const result = await provider().updateNameservers('example.com', [
      'NS1.NEW.NET',
      'NS2.NEW.NET',
    ]);
    expect(result).toMatchObject({ success: true, pending: true });
    expect(result.message).toContain('pending');
    expect(body(mock)).toEqual({ nameservers: ['ns1.new.net', 'ns2.new.net'] });
    responses(success(['NS1.OLD.NET', 'NS2.OLD.NET']));
    expect(await provider().getNameservers('example.com')).toEqual(['ns1.old.net', 'ns2.old.net']);
  });
  it('validates nameservers before any write', async () => {
    const mock = responses();
    await expect(provider().updateNameservers('example.com', ['ns1.example.net'])).rejects.toThrow(
      ConfigurationError
    );
    await expect(
      provider().updateNameservers('example.com', ['NS1.EXAMPLE.NET', 'ns1.example.net'])
    ).rejects.toThrow(ConfigurationError);
    expect(mock).not.toHaveBeenCalled();
  });
  it('never repeats a write after a 5xx with an uncertain outcome', async () => {
    const mock = responses(new Response('secret-token', { status: 500 }));
    const result = await provider({ retries: 3, backoff: 1 }).updateNameservers('example.com', [
      'ns1.new.net',
      'ns2.new.net',
    ]);
    expect(result).toMatchObject({ success: false, outcome: 'unknown' });
    expect(result.message).not.toContain('secret-token');
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('leaves unavailable paid and settings operations unimplemented', async () => {
    const mock = responses();
    await expect(provider().renewDomain('example.com')).rejects.toThrow(NotImplementedError);
    await expect(provider().setAutoRenew('example.com', true)).rejects.toThrow(NotImplementedError);
    await expect(provider().lockDomain('example.com')).rejects.toThrow(NotImplementedError);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('101domain DNS reconciliation', () => {
  it('preserves SWA proxying when replacing content and rejects automatic TTL on new records', async () => {
    const mock = responses(
      success([{ id: 'old', name: 'www', type: 'A', value: '192.0.2.1', ttl: 1, proxied: true }]),
      success([{ old_id: 'old', id: 'new' }])
    );
    expect(
      await provider().setDnsRecords('example.com', [
        { name: 'www', type: 'A', value: '192.0.2.2', ttl: 1 },
      ])
    ).toMatchObject({ success: true });
    expect(body(mock, 1)).toEqual({
      records: [{ id: 'old', value: '192.0.2.2', ttl: 1, proxied: true }],
    });
    const fresh = responses(success([]));
    expect(
      await provider().setDnsRecords('example.com', [
        { name: 'www', type: 'A', value: '192.0.2.2', ttl: 1 },
      ])
    ).toMatchObject({ success: false });
    expect(fresh).toHaveBeenCalledTimes(1);
  });
  const record = { id: 'stable', type: 'TXT', name: '', value: 'keep', ttl: 3600 };
  it('edits a CNAME by ID and never deletes its replacement ID', async () => {
    const old = {
      id: 'cname-old',
      type: 'CNAME',
      name: 'www',
      value: 'old.example.net.',
      ttl: 3600,
    };
    const mock = responses(
      success([old, record]),
      success([{ old_id: 'cname-old', id: 'cname-new' }]),
      success(null)
    );
    expect(
      await provider().setDnsRecords('example.com', [
        { type: 'CNAME', name: 'www', value: 'new.example.net.', ttl: 3600 },
      ])
    ).toMatchObject({ success: true });
    expect(mock.mock.calls.map(([, req]) => req?.method)).toEqual(['GET', 'PATCH', 'DELETE']);
    expect(body(mock, 1)).toEqual({
      records: [{ id: 'cname-old', value: 'new.example.net.', ttl: 3600 }],
    });
    expect(body(mock, 2)).toEqual({ ids: ['stable'] });
  });
  it('stops after an unconfirmed edit without deleting any stale DNS', async () => {
    const mock = responses(success([record]), success([]));
    expect(
      await provider().setDnsRecords('example.com', [
        { type: 'TXT', name: '@', value: 'changed', ttl: 3600 },
      ])
    ).toMatchObject({ success: false, outcome: 'unknown' });
    expect(mock.mock.calls.map(([, req]) => req?.method)).toEqual(['GET', 'PATCH']);
  });
  it('preserves unchanged IDs, creates additions before stale deletes, and batches at 25', async () => {
    const old = { ...record, id: 'stale', name: 'old', value: 'delete' };
    const mock = responses(success([record, old]), success([]), success([]), success(null));
    const desired = [
      { type: 'TXT', name: '@', value: 'keep', ttl: 3600 },
      ...Array.from({ length: 26 }, (_, i) => ({
        type: 'TXT',
        name: `_test${i}`,
        value: String(i),
        ttl: 300,
      })),
    ];
    expect(await provider().setDnsRecords('example.com', desired)).toMatchObject({ success: true });
    expect(mock.mock.calls.map(([, req]) => req?.method)).toEqual([
      'GET',
      'POST',
      'POST',
      'DELETE',
    ]);
    expect((body(mock, 1) as { records: unknown[] }).records).toHaveLength(25);
    expect(body(mock, 3)).toEqual({ ids: ['stale'] });
  });
  it('handles MX, SRV and CAA round trips without rewriting unchanged records', async () => {
    const records = [
      { ...record, id: 'mx', type: 'MX', value: '10 mail.example.com.' },
      {
        ...record,
        id: 'srv',
        type: 'SRV',
        name: '_service._tcp',
        value: '5 20 443 server.example.com.',
      },
      { ...record, id: 'caa', type: 'CAA', value: '0 issue "ca.example"' },
    ];
    const mock = responses(success(records), success(records));
    const result = await provider().getDnsRecords('example.com');
    expect(result[0]).toMatchObject({ priority: 10, value: 'mail.example.com.' });
    expect(result[1]).toMatchObject({ priority: 5, weight: 20, port: 443 });
    expect(await provider().setDnsRecords('example.com', result)).toMatchObject({ success: true });
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('stops before deleting existing DNS when creation fails', async () => {
    const mock = responses(success([record]), new Response(null, { status: 403 }));
    expect(
      await provider().setDnsRecords('example.com', [
        { type: 'TXT', name: '_test', value: 'new', ttl: 300 },
      ])
    ).toMatchObject({ success: false });
    expect(mock.mock.calls.map(([, req]) => req?.method)).toEqual(['GET', 'POST']);
  });
  it('validates all desired records and IDs before writes', async () => {
    const mock = responses();
    await expect(
      provider().setDnsRecords('example.com', [{ type: 'NS', name: '@', value: 'ns1.new.net' }])
    ).rejects.toThrow(ConfigurationError);
    expect(mock).not.toHaveBeenCalled();
    responses(success([{ ...record, id: undefined }]));
    expect(await provider().setDnsRecords('example.com', [])).toMatchObject({ success: false });
  });
});

describe('101domain URL forwarding', () => {
  it('creates, edits and clears permanent apex forwarding without treating missing domains as empty rules', async () => {
    const mock = responses(
      success(raw),
      success({ destination: 'https://target.example/', type: '301' })
    );
    expect(
      await provider().setDomainForwarding('example.com', [
        { host: '@', type: 'permanent', url: 'https://target.example/' },
      ])
    ).toMatchObject({ success: true });
    expect(mock.mock.calls[1][1]?.method).toBe('POST');
    expect(body(mock, 1)).toEqual({ destination: 'https://target.example/', type: '301' });
    const edit = responses(
      success({ ...raw, web_forwarding: { destination: 'https://old.example/', type: 'cloak' } }),
      success({})
    );
    expect(
      await provider().setDomainForwarding('example.com', [
        { host: '@', type: 'permanent', url: 'https://target.example/' },
      ])
    ).toMatchObject({ success: true });
    expect(edit.mock.calls[1][1]?.method).toBe('PATCH');
    const clear = responses(
      success({ ...raw, web_forwarding: { destination: 'https://old.example/', type: '301' } }),
      success(null)
    );
    expect(await provider().setDomainForwarding('example.com', [])).toMatchObject({
      success: true,
    });
    expect(clear.mock.calls[1][1]?.method).toBe('DELETE');
    const missing = responses(new Response(null, { status: 404 }));
    expect(await provider().setDomainForwarding('example.com', [])).toMatchObject({
      success: false,
    });
    expect(missing).toHaveBeenCalledTimes(1);
  });
  it('reads all-null forwarding fields as no rule', async () => {
    responses(success(raw));
    expect(await provider().getDomainForwarding('example.com')).toEqual([]);
    responses(success({ ...raw, web_forwarding: null }));
    expect(await provider().getDomainForwarding('example.com')).toEqual([]);
    responses(
      success({ ...raw, web_forwarding: { destination: 'https://a.example/', type: null } })
    );
    await expect(provider().getDomainForwarding('example.com')).rejects.toThrow(/forwarding/);
  });
  it('reports cloaked forwarding but rejects creating masking, temporary or subdomain rules', async () => {
    responses(
      success({ ...raw, web_forwarding: { destination: 'https://target.example/', type: 'cloak' } })
    );
    expect(await provider().getDomainForwarding('example.com')).toEqual([
      { host: '@', type: 'masked', url: 'https://target.example/' },
    ]);
    const mock = responses();
    for (const type of ['masked', 'temporary'] as const)
      await expect(
        provider().setDomainForwarding('example.com', [
          { host: '@', type, url: 'https://target.example/' },
        ])
      ).rejects.toThrow(ConfigurationError);
    await expect(
      provider().setDomainForwarding('example.com', [
        { host: 'www', type: 'permanent', url: 'https://target.example/' },
      ])
    ).rejects.toThrow(ConfigurationError);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('101domain read-only API keys', () => {
  const denied = () =>
    apiError(
      403,
      'INSUFFICIENT_PERMISSIONS',
      'The provided token does not have the required scope(s).'
    );

  it('connects and syncs with only the read scopes', async () => {
    responses(page([raw]), page([raw]));
    expect(await provider().testConnection()).toMatchObject({ success: true });
    expect(await provider().listDomains()).toHaveLength(1);
  });
  it('fails a connection test with a clear message when domains_read is missing', async () => {
    responses(denied());
    const result = await provider().testConnection();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/does not have the domains_read scope/);
  });
  it('names dns_write when a nameserver change is refused, with a definite outcome', async () => {
    const mock = responses(denied());
    const result = await provider({ retries: 3 }).updateNameservers('example.com', [
      'ns1.new.net',
      'ns2.new.net',
    ]);
    expect(result).toEqual({
      success: false,
      message:
        '101domain: this API key does not have the dns_write scope. Create a key with dns_write to change DNS records and nameservers.',
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('reports a refused first DNS write as nothing changed', async () => {
    const record = { id: 'r1', name: 'www', type: 'A', value: '192.0.2.1', ttl: 3600 };
    const mock = responses(success([record]), denied());
    const result = await provider().setDnsRecords('example.com', [
      { type: 'A', name: 'www', value: '192.0.2.2', ttl: 3600 },
    ]);
    expect(result.success).toBe(false);
    expect(result.outcome).toBeUndefined();
    expect(result.message).toMatch(/dns_write scope/);
    expect(result.message).not.toMatch(/not atomic/);
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('warns of a partial zone when a later DNS batch is refused', async () => {
    const record = { id: 'r1', name: 'www', type: 'A', value: '192.0.2.1', ttl: 3600 };
    responses(success([record]), success([{ id: 'n1' }]), denied());
    const result = await provider().setDnsRecords('example.com', [
      { type: 'TXT', name: '_new', value: 'added', ttl: 3600 },
    ]);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not atomic/);
  });
  it('names domains_write when a forwarding change is refused', async () => {
    responses(success(raw), denied());
    const result = await provider().setDomainForwarding('example.com', [
      { host: '@', type: 'permanent', url: 'https://target.example/' },
    ]);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/does not have the domains_write scope/);
  });
  it('names dns_read when DNS records cannot be read', async () => {
    responses(denied());
    await expect(provider().getDnsRecords('example.com')).rejects.toThrow(
      /does not have the dns_read scope/
    );
  });
});

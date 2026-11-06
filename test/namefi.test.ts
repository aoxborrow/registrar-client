import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigurationError,
  InvalidResponseError,
  NotImplementedError,
  createRegistrar,
  registrars,
  type RegistrarOptions,
} from '../src/index';

const raw = {
  normalizedDomainName: 'example.com',
  ledgerType: 'email',
  holderIdentifier: 'private@example.test',
  expirationDate: '2028-04-05T00:00:00.000Z',
  autoRenewEnabled: true,
  dnsStatus: { nameservers: ['NS1.NAMEFI.IO.', 'ns2.namefi.io.'] },
};
const money = (amount: number) => ({ amount, currency: 'USD' });
const quote = {
  domain: 'example.com',
  availability: false,
  supported: true,
  isPremium: true,
  pricingDetails: {
    registrationPrice: { type: 'PER_YEAR', price: money(14.95) },
    renewalPrice: {
      type: 'MULTI_YEAR',
      price: { '1': money(18.5), '2': money(35) },
    },
    importPrice: { type: 'PER_YEAR', price: money(10) },
  },
};
const record = (id = 'record-1', name = '@', type = 'TXT', rdata = 'verification', ttl = 300) => ({
  id,
  zoneName: 'example.com',
  name,
  type,
  rdata,
  ttl,
  metadata: null,
});
function provider(options?: RegistrarOptions) {
  return createRegistrar('namefi', { apiKey: 'nfk_private-test-key' }, { retries: 0, ...options });
}
function responses(...values: unknown[]) {
  const mock = vi.fn<typeof fetch>();
  for (const value of values)
    if (value instanceof Error) mock.mockRejectedValueOnce(value);
    else mock.mockResolvedValueOnce(value instanceof Response ? value : Response.json(value));
  vi.stubGlobal('fetch', mock);
  return mock;
}
function body(mock: ReturnType<typeof responses>, n: number): unknown {
  return JSON.parse(mock.mock.calls[n][1]?.body as string);
}
function requestUrl(mock: ReturnType<typeof responses>, n = 0): string {
  const input = mock.mock.calls[n][0];
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('packaged Namefi adapter', () => {
  it('exposes static credential and connection metadata', () => {
    expect(registrars.namefi.displayName).toBe('Namefi');
    expect(registrars.namefi.configFields).toEqual([
      { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    ]);
    expect(registrars.namefi.supportsSandbox).toBe(false);
  });
  it('permits catalog inspection, rejects header injection and never silently chooses sandbox', () => {
    expect(createRegistrar('namefi', {}).listOnlyFields).toEqual([]);
    expect(() => createRegistrar('namefi', { apiKey: 'bad\nkey' })).toThrow(ConfigurationError);
    expect(() => provider({ environment: 'sandbox' })).toThrow(/sandbox/);
  });
  it('tests authentication against /user without depending on having domains', async () => {
    const fetch = responses({
      id: 'private-user-id',
      primaryEmail: 'private@example.test',
    });
    expect(await provider().testConnection()).toEqual({
      success: true,
      message: 'Connection successful',
    });
    expect(fetch.mock.calls[0][1]?.redirect).toBe('manual');
    expect(requestUrl(fetch)).toBe('https://api.namefi.io/v-next/user');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('x-api-key')).toBe(
      'nfk_private-test-key'
    );
  });
  it('maps email and NFT holdings, dates and nameservers without exposing private identifiers', async () => {
    responses([
      raw,
      {
        ...raw,
        normalizedDomainName: 'second.net',
        ledgerType: 'nft',
        ownerAddress: 'private-wallet',
        expirationDate: null,
      },
    ]);
    const rows = await provider().listDomains();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      domainName: 'example.com',
      registrar: 'namefi',
      status: 'unknown',
      autoRenew: true,
      createdDate: null,
      nameservers: ['ns1.namefi.io', 'ns2.namefi.io'],
    });
    expect(rows[0].expirationDate?.toISOString()).toBe(raw.expirationDate);
    expect(rows[1].expirationDate).toBeNull();
    expect(JSON.stringify(rows)).not.toMatch(/private|holder|ownerAddress/);
  });
  it('filters inventory locally and reads owned details without redundant nameserver enrichment', async () => {
    responses([raw], [raw], [raw]);
    expect(await provider().listDomains({ search: 'not-held' })).toEqual([]);
    expect((await provider().getDomain('EXAMPLE.COM.')).domainName).toBe('example.com');
    expect(await provider().getNameservers('example.com')).toEqual([
      'ns1.namefi.io',
      'ns2.namefi.io',
    ]);
    expect(provider().requiresNameserversFetch).toBe(false);
  });
  it.each([
    {},
    null,
    [raw, raw],
    [{ ...raw, expirationDate: 'invalid' }],
    [{ ...raw, autoRenewEnabled: undefined }],
    [{ ...raw, dnsStatus: {} }],
  ])(
    'rejects malformed inventory rather than accepting an empty or partial sync: %j',
    async value => {
      responses(value);
      await expect(provider().listDomains()).rejects.toThrow();
    }
  );
  it('distinguishes an empty account from a missing domain', async () => {
    responses([], []);
    expect(await provider().listDomains()).toEqual([]);
    await expect(provider().getDomain('example.com')).rejects.toThrow(/not in this account/);
  });
  it('preserves annual domain-specific prices, including a one-year MULTI_YEAR quote', async () => {
    responses(quote, { ...quote, availability: true });
    expect(await provider().getPricing('example.com')).toEqual({
      tld: 'com',
      currency: 'USD',
      registration: 14.95,
      renewal: 18.5,
      transfer: 10,
    });
    expect(await provider().checkAvailability(['example.com'])).toEqual([
      {
        domainName: 'example.com',
        available: true,
        premium: true,
        price: 14.95,
        renewalPrice: 18.5,
        currency: 'USD',
        period: 1,
      },
    ]);
  });
  it('never annualizes a multi-year total or fabricates a TLD quote', async () => {
    responses({
      ...quote,
      pricingDetails: {
        ...quote.pricingDetails,
        renewalPrice: { type: 'MULTI_YEAR', price: { '2': money(35) } },
      },
    });
    expect((await provider().getPricing('example.com')).renewal).toBeUndefined();
    await expect(provider().getPricing('.com')).rejects.toThrow(NotImplementedError);
  });
  it('rejects mismatched availability identity and unsafe domain input', async () => {
    const fetch = responses({ ...quote, domain: 'other.com' });
    await expect(provider().checkAvailability(['example.com'])).rejects.toThrow(
      InvalidResponseError
    );
    await expect(provider().getDomain('../user')).rejects.toThrow(ConfigurationError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('writes auto-renew only after ownership is confirmed and reads exactly the requested body', async () => {
    const fetch = responses([raw], { success: true });
    expect(await provider().setAutoRenew('example.com', false)).toMatchObject({
      success: true,
    });
    expect(body(fetch, 1)).toEqual({
      normalizedDomainName: 'example.com',
      enableAutoRenew: false,
    });
    expect(fetch.mock.calls[1][1]?.method).toBe('PUT');
  });
  it('does not mutate an unowned domain', async () => {
    const fetch = responses([]);
    expect(await provider().setAutoRenew('example.com', false)).toMatchObject({
      success: false,
      status: 404,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry a write after a 5xx or claim malformed acknowledgement succeeded', async () => {
    const fetch = responses(
      [raw],
      new Response('private upstream contents', { status: 500 }),
      [raw],
      {}
    );
    expect(await provider({ retries: 3 }).setAutoRenew('example.com', false)).toMatchObject({
      success: false,
      outcome: 'unknown',
    });
    expect(await provider().setAutoRenew('example.com', false)).toMatchObject({
      success: false,
      outcome: 'unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('hides credentials, upstream error bodies and contact details while retaining status', async () => {
    responses(
      Response.json({ message: 'nfk_private-test-key private@example.test' }, { status: 401 })
    );
    const result = await provider().testConnection();
    expect(result).toMatchObject({ success: false, status: 401 });
    expect(result.message).not.toMatch(/nfk_|private@example/);
  });
  it('round-trips MX and SRV numbers without losing their targets', async () => {
    responses([
      record('mx', '@', 'MX', '10 mail.example.com.'),
      record('srv', '_sip._tcp', 'SRV', '5 10 5060 sip.example.com.'),
    ]);
    expect(await provider().getDnsRecords('example.com')).toEqual([
      {
        type: 'MX',
        name: '@',
        value: 'mail.example.com.',
        ttl: 300,
        priority: 10,
      },
      {
        type: 'SRV',
        name: '_sip._tcp',
        value: 'sip.example.com.',
        ttl: 300,
        priority: 5,
        weight: 10,
        port: 5060,
      },
    ]);
  });
  it('rejects cross-zone DNS records before accepting a read or any writes', async () => {
    responses([{ ...record(), zoneName: 'other.com' }]);
    await expect(provider().getDnsRecords('example.com')).rejects.toThrow(/identity/);
  });
  it('preserves unchanged DNS records and creates additions before deleting stale IDs', async () => {
    const existing = record();
    const stale = record('stale', 'old');
    const addition = record('new', 'new', 'TXT', 'new value');
    const fetch = responses([raw], [existing, stale], [addition], {
      success: true,
    });
    expect(
      await provider().setDnsRecords('example.com', [
        { type: 'TXT', name: '@', value: 'verification', ttl: 300 },
        { type: 'TXT', name: 'new', value: 'new value', ttl: 300 },
      ])
    ).toMatchObject({ success: true });
    expect(body(fetch, 2)).toEqual({
      zoneName: 'example.com',
      records: [{ type: 'TXT', name: 'new', rdata: 'new value', ttl: 300 }],
    });
    expect(body(fetch, 3)).toEqual({ zoneName: 'example.com', recordsIds: ['stale'] });
  });
  it('performs no DNS writes for unchanged content', async () => {
    const fetch = responses([raw], [record()]);
    expect(
      await provider().setDnsRecords('example.com', [
        { type: 'TXT', name: '@', value: 'verification', ttl: 300 },
      ])
    ).toMatchObject({ success: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('holds changes to managed records before the first write', async () => {
    const fetch = responses([raw], [{ ...record(), metadata: { source: 'auto-ens' } }]);
    expect(await provider().setDnsRecords('example.com', [])).toMatchObject({
      success: false,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('never deletes stale records after a failed or unconfirmed creation', async () => {
    const fetch = responses([raw], [record('stale')], {});
    expect(
      await provider().setDnsRecords('example.com', [
        { type: 'TXT', name: 'new', value: 'new', ttl: 300 },
      ])
    ).toMatchObject({ success: false, outcome: 'unknown' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('exposes unsupported operations as unsupported without any provider request', async () => {
    const fetch = responses();
    await expect(provider().renewDomain('example.com')).rejects.toThrow(NotImplementedError);
    await expect(provider().updateNameservers('example.com', ['ns1.example.com'])).rejects.toThrow(
      NotImplementedError
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('updates changed CNAME data by ID before creating or deleting anything', async () => {
    const fetch = responses(
      [raw],
      [record('cname', 'www', 'CNAME', 'old.example.net.')],
      [record('cname', 'www', 'CNAME', 'new.example.net.')]
    );
    expect(
      await provider().setDnsRecords('example.com', [
        { type: 'CNAME', name: 'www', value: 'new.example.net.', ttl: 300 },
      ])
    ).toMatchObject({ success: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][1]?.method).toBe('PUT');
    expect(body(fetch, 2)).toEqual({
      zoneName: 'example.com',
      records: [{ id: 'cname', type: 'CNAME', name: 'www', rdata: 'new.example.net.', ttl: 300 }],
    });
  });
  it('accepts unordered DNS creation confirmations while retaining identity checks', async () => {
    const a = record('a', 'a', 'TXT', 'first'),
      b = record('b', 'b', 'TXT', 'second');
    responses([raw], [], [b, a]);
    expect(
      await provider().setDnsRecords('example.com', [
        { type: 'TXT', name: 'a', value: 'first', ttl: 300 },
        { type: 'TXT', name: 'b', value: 'second', ttl: 300 },
      ])
    ).toMatchObject({ success: true });
  });
  it('stops after an unconfirmed edit without creating or deleting more records', async () => {
    const fetch = responses(
      [raw],
      [record('edit', 'www', 'CNAME', 'old.example.net.'), record('remove', 'old')],
      []
    );
    expect(
      await provider().setDnsRecords('example.com', [
        { type: 'CNAME', name: 'www', value: 'new.example.net.', ttl: 300 },
        { type: 'TXT', name: 'added', value: 'new', ttl: 300 },
      ])
    ).toMatchObject({ success: false, outcome: 'unknown' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('submits only the requested registration and reports an accepted order as pending', async () => {
    const fetch = responses({
      id: 'order-123',
      items: [
        {
          normalizedDomainName: 'example.com',
          durationInYears: 2,
          type: 'REGISTER',
          status: 'PROCESSING',
        },
      ],
    });
    expect(
      await provider().registerDomain('example.com', {
        contacts: {},
        years: 2,
        autoRenew: false,
        nameservers: ['NS1.EXAMPLE.NET.'],
      })
    ).toMatchObject({ success: true, pending: true });
    expect(body(fetch, 0)).toEqual({
      normalizedDomainName: 'example.com',
      durationInYears: 2,
      domainSetupOptions: { autoRenew: false, nameservers: ['ns1.example.net.'] },
    });
    expect(requestUrl(fetch)).toBe('https://api.namefi.io/v-next/orders/register-domain');
    expect(fetch.mock.calls[0][1]?.method).toBe('POST');
  });
  it('distinguishes a completed registration from an accepted one', async () => {
    responses({
      id: 'order-123',
      items: [
        {
          normalizedDomainName: 'example.com',
          durationInYears: 1,
          type: 'REGISTER',
          status: 'SUCCEEDED',
        },
      ],
    });
    expect(await provider().registerDomain('example.com', { contacts: {} })).toEqual({
      success: true,
      message: 'Domain registration completed',
    });
  });
  it.each(['FAILED', 'CANCELLED'])('does not call a %s registration successful', async status => {
    responses({
      id: 'order-123',
      items: [
        { normalizedDomainName: 'example.com', durationInYears: 1, type: 'REGISTER', status },
      ],
    });
    expect(await provider().registerDomain('example.com', { contacts: {} })).toMatchObject({
      success: false,
    });
  });
  it('does not retry an unknown registration write or malformed accepted-order identity', async () => {
    const fetch = responses(new Response('upstream error', { status: 503 }), {
      id: 'order-123',
      items: [
        {
          normalizedDomainName: 'other.com',
          durationInYears: 1,
          type: 'REGISTER',
          status: 'PROCESSING',
        },
      ],
    });
    expect(
      await provider({ retries: 3 }).registerDomain('example.com', { contacts: {} })
    ).toMatchObject({ success: false, outcome: 'unknown' });
    expect(await provider().registerDomain('example.com', { contacts: {} })).toMatchObject({
      success: false,
      outcome: 'unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects unsupported registration overrides and invalid periods before spending', async () => {
    const fetch = responses();
    for (const input of [
      { contacts: {}, years: 0 },
      { contacts: {}, years: 1.5 },
      { contacts: {}, years: 11 },
      { contacts: {}, privacy: true },
      { contacts: { registrant: {} as never } },
      { contacts: {}, nameservers: [] },
    ])
      await expect(provider().registerDomain('example.com', input)).rejects.toThrow(
        ConfigurationError
      );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('round-trips managed and delegation records without writing them', async () => {
    const rows = [
      { ...record('managed'), metadata: { source: 'auto-ens' } },
      record('ns', '@', 'NS', 'ns3.namefi.io.'),
      record('soa', '@', 'SOA', 'ns3.namefi.io. hostmaster.namefi.io. 1 2 3 4 5'),
    ];
    const fetch = responses(rows, [raw], rows);
    const client = provider(),
      records = await client.getDnsRecords('example.com');
    expect(await client.setDnsRecords('example.com', records)).toMatchObject({ success: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('holds a malformed JSON write response as unknown without replaying the write', async () => {
    const fetch = responses([raw], new Response('not json', { status: 200 }));
    expect(await provider({ retries: 3 }).setAutoRenew('example.com', false)).toMatchObject({
      success: false,
      outcome: 'unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('names the unavailable core APIs and the unwired forwarding semantics without sending requests', async () => {
    const fetch = responses(),
      client = provider();
    for (const operation of [
      () => client.renewDomain('example.com'),
      () => client.transferIn('example.com', { authCode: 'test-code' }),
      () => client.updateNameservers('example.com', ['ns1.example.net']),
      () => client.lockDomain('example.com'),
      () => client.unlockDomain('example.com'),
      () => client.setPrivacy('example.com', true),
      () => client.getContacts('example.com'),
      () => client.updateContacts('example.com', {}),
      () => client.getDomainForwarding('example.com'),
      () => client.setDomainForwarding('example.com', []),
    ])
      await expect(operation()).rejects.toThrow(NotImplementedError);
    await expect(client.getDomainForwarding('example.com')).rejects.toThrow(
      /not wired up.*redirect mode/
    );
    expect(client.supports('getDomainForwarding')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

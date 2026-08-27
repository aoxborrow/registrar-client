import { describe, it, expect } from 'vitest';
import { createRegistrar, NotImplementedError } from '../src/index';
import type { RequestConfig } from '../src/http';

// Stub the provider's HttpClient so no network calls happen. `handler` receives
// each RequestConfig and returns the canned response body.
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

function dynadot() {
  return createRegistrar('dynadot', { apiKey: 'k' });
}

describe('Dynadot provider', () => {
  it('unwraps the nested Header/Content envelope for list_domain', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ({
      ListDomainInfoResponse: {
        ListDomainInfoHeader: { ResponseCode: '0', Status: 'success' },
        ListDomainInfoContent: {
          DomainInfoList: {
            DomainInfo: [
              {
                Name: 'example.com',
                Expiration: '1361430589062',
                Locked: 'yes',
                Privacy: 'full',
                RenewOption: 'auto',
              },
            ],
          },
        },
      },
    }));

    const domains = await dy.listDomains();
    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({
      domainName: 'example.com',
      registrar: 'dynadot',
      locked: true,
      privacy: true,
      autoRenew: true,
    });
  });

  it('tolerates the SuccessCode header variant and collapses single-item lists', async () => {
    const dy = dynadot();
    // some commands report success as `SuccessCode`, and api3 collapses a
    // one-element list to a bare object rather than an array
    stubHttp(dy, () => ({
      ListDomainInfoResponse: {
        ListDomainInfoResponseHeader: { SuccessCode: '0' },
        ListDomainInfoContent: {
          DomainInfoList: { DomainInfo: { Name: 'solo.com' } },
        },
      },
    }));

    const domains = await dy.listDomains();
    expect(domains).toHaveLength(1);
    expect(domains[0].domainName).toBe('solo.com');
  });

  it('throws on a non-zero response code', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ({
      Response: { ResponseCode: '-1', Error: 'Invalid API key' },
    }));
    await expect(dy.listDomains()).rejects.toThrow('Invalid API key');
  });

  it('getDomain reads domain_info and maps the single DomainInfo object', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ({
      DomainInfoResponse: {
        DomainInfoHeader: { ResponseCode: '0' },
        DomainInfoContent: { DomainInfo: { Name: 'example.com', Locked: 'no' } },
      },
    }));
    const domain = await dy.getDomain('example.com');
    expect(domain.domainName).toBe('example.com');
    expect(domain.locked).toBe(false);
    expect(calls[0].query).toMatchObject({ command: 'domain_info', domain: 'example.com' });
  });

  it('checkAvailability parses the "77.00 in USD" price string', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ({
      SearchResponse: {
        SearchHeader: { ResponseCode: '0' },
        SearchContent: {
          SearchResults: [
            { DomainName: 'example.com', Available: 'yes', Price: '77.00 in USD' },
            { DomainName: 'taken.com', Available: 'no' },
          ],
        },
      },
    }));

    const results = await dy.checkAvailability(['example.com', 'taken.com']);
    expect(results[0]).toMatchObject({
      domainName: 'example.com',
      available: true,
      price: 77,
      currency: 'USD',
      period: 1,
    });
    expect(results[1]).toMatchObject({ domainName: 'taken.com', available: false });
    expect(results[1].price).toBeUndefined();
  });

  it('getDnsRecords maps main + subdomain records, with MX distance from Value2', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ({
      GetDnsResponse: {
        GetDnsHeader: { ResponseCode: '0' },
        GetDnsContent: {
          NameServerSettings: {
            TTL: '3600',
            MainDomains: {
              MainDomainRecord: [
                { RecordType: 'a', Value: '203.0.113.10' },
                { RecordType: 'mx', Value: 'mail.example.com', Value2: '10' },
              ],
            },
            SubDomains: {
              SubDomainRecord: { Subhost: 'www', RecordType: 'cname', Value: 'example.com' },
            },
          },
        },
      },
    }));

    const records = await dy.getDnsRecords('example.com');
    expect(records).toEqual([
      { type: 'A', name: '@', value: '203.0.113.10', ttl: 3600 },
      { type: 'MX', name: '@', value: 'mail.example.com', ttl: 3600, priority: 10 },
      { type: 'CNAME', name: 'www', value: 'example.com', ttl: 3600 },
    ]);
  });

  it('setDnsRecords splits apex vs subdomain params and rejects unsupported types', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ({
      SetDnsResponse: { SetDnsHeader: { ResponseCode: '0' } },
    }));

    const res = await dy.setDnsRecords('example.com', [
      { type: 'A', name: '@', value: '203.0.113.10', ttl: 600 },
      { type: 'MX', name: '@', value: 'mail.example.com', priority: 10 },
      { type: 'CNAME', name: 'www', value: 'example.com' },
    ]);
    expect(res.success).toBe(true);
    expect(calls[0].query).toMatchObject({
      command: 'set_dns2',
      domain: 'example.com',
      main_record_type0: 'a',
      main_record0: '203.0.113.10',
      main_record_type1: 'mx',
      main_record1: 'mail.example.com',
      main_recordx1: 10,
      subdomain0: 'www',
      sub_record_type0: 'cname',
      sub_record0: 'example.com',
      ttl: 600,
    });

    await expect(
      dy.setDnsRecords('example.com', [{ type: 'SRV', name: '@', value: 'x' }])
    ).rejects.toThrow(/not supported/);
  });

  it('setAutoRenew maps enabled/disabled to renew_option values', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ({
      SetRenewOptionResponse: { SetRenewOptionHeader: { ResponseCode: '0' } },
    }));
    await dy.setAutoRenew('example.com', true);
    await dy.setAutoRenew('example.com', false);
    expect(calls[0].query).toMatchObject({ command: 'set_renew_option', renew_option: 'auto' });
    expect(calls[1].query).toMatchObject({ command: 'set_renew_option', renew_option: 'donot' });
  });

  it('setPrivacy maps enabled/disabled to option values', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ({
      SetPrivacyResponse: { SetPrivacyHeader: { ResponseCode: '0' } },
    }));
    await dy.setPrivacy('example.com', true);
    await dy.setPrivacy('example.com', false);
    expect(calls[0].query).toMatchObject({ command: 'set_privacy', option: 'full' });
    expect(calls[1].query).toMatchObject({ command: 'set_privacy', option: 'off' });
  });

  it('updateNameservers rejects out-of-range counts and indexes ns params', async () => {
    const dy = dynadot();
    const calls = stubHttp(dy, () => ({
      SetNsResponse: { SetNsHeader: { ResponseCode: '0' } },
    }));
    await expect(dy.updateNameservers('example.com', ['ns1.example.net'])).rejects.toThrow('2-13');

    await dy.updateNameservers('example.com', ['ns1.example.net', 'ns2.example.net']);
    expect(calls[0].query).toMatchObject({
      command: 'set_ns',
      ns0: 'ns1.example.net',
      ns1: 'ns2.example.net',
    });
  });

  it('a failed mutation surfaces the error message without throwing', async () => {
    const dy = dynadot();
    stubHttp(dy, () => ({
      SetLockResponse: { SetLockHeader: { ResponseCode: '-1', Error: 'Domain is not eligible' } },
    }));
    const res = await dy.lockDomain('example.com');
    expect(res).toEqual({ success: false, message: 'Domain is not eligible' });
  });

  it('getPricing throws for a bare TLD', async () => {
    const dy = dynadot();
    await expect(dy.getPricing('com')).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('leaves register/transfer/contacts throwing NotImplementedError', async () => {
    const dy = dynadot();
    await expect(dy.registerDomain('example.com', { contacts: {} })).rejects.toBeInstanceOf(
      NotImplementedError
    );
    await expect(dy.transferIn('example.com', 'auth')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(dy.getContacts('example.com')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(dy.updateContacts('example.com', {})).rejects.toBeInstanceOf(NotImplementedError);
  });
});

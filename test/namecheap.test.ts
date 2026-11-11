import { describe, it, expect } from 'vitest';
import { createRegistrar, ConsentRequiredError, Feature, RateLimitError } from '../src/index';
import type { RequestConfig } from '../src/http';

// Namecheap speaks XML, so its HttpClient uses requestText (not request). Stub
// that to return canned XML; `handler` receives each RequestConfig.
function stubXml(provider: unknown, handler: (req: RequestConfig) => string): RequestConfig[] {
  const calls: RequestConfig[] = [];
  (
    provider as { http: { requestText: (req: RequestConfig) => Promise<string> } }
  ).http.requestText = (req: RequestConfig) => {
    calls.push(req);
    return Promise.resolve(handler(req));
  };
  return calls;
}

function namecheap() {
  return createRegistrar('namecheap', { username: 'u', apiKey: 'k', clientIp: '1.2.3.4' });
}

// wrap a CommandResponse body in the standard OK envelope
function ok(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
    <ApiResponse Status="OK"><CommandResponse>${body}</CommandResponse></ApiResponse>`;
}

describe('Namecheap provider', () => {
  it('checkAvailability maps availability and premium prices', async () => {
    const nc = namecheap();
    stubXml(nc, () =>
      ok(
        `<DomainCheckResult Domain="example.com" Available="true" IsPremiumName="false" PremiumRegistrationPrice="0.0000" PremiumRenewalPrice="0.0000"/>
         <DomainCheckResult Domain="rich.com" Available="true" IsPremiumName="true" PremiumRegistrationPrice="1500.0000" PremiumRenewalPrice="1200.0000"/>
         <DomainCheckResult Domain="taken.com" Available="false" IsPremiumName="false"/>`
      )
    );
    const results = await nc.checkAvailability(['example.com', 'rich.com', 'taken.com']);
    expect(results[0]).toMatchObject({
      domainName: 'example.com',
      available: true,
      premium: false,
    });
    expect(results[0].price).toBeUndefined();
    expect(results[0].renewalPrice).toBeUndefined();
    expect(results[1]).toMatchObject({
      available: true,
      premium: true,
      price: 1500,
      renewalPrice: 1200,
    });
    expect(results[2]).toMatchObject({ domainName: 'taken.com', available: false });
  });

  it('checkAvailability batches at 50 domains per request', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, req => {
      const list = String(req.query?.DomainList ?? '');
      const els = list
        .split(',')
        .map(d => `<DomainCheckResult Domain="${d}" Available="true" IsPremiumName="false"/>`)
        .join('');
      return ok(els);
    });
    const domains = Array.from({ length: 120 }, (_, i) => `d${i}.com`);
    const results = await nc.checkAvailability(domains);
    expect(calls).toHaveLength(3); // 50 + 50 + 20
    expect(results).toHaveLength(120);
  });

  it('getDomain reads getInfo for status/dates/privacy and the lock from getRegistrarLock', async () => {
    const nc = namecheap();
    // Status is "Ok" while the domain IS transfer-locked — proving `locked` comes
    // from the dedicated getRegistrarLock command, not the coarse getInfo Status.
    const calls = stubXml(nc, req => {
      const command = String(req.query?.Command ?? '');
      if (command === 'namecheap.domains.getRegistrarLock') {
        return ok(
          `<DomainGetRegistrarLockResult Domain="example.com" RegistrarLockStatus="true"/>`
        );
      }
      return ok(
        `<DomainGetInfoResult Status="Ok" DomainName="example.com">
           <DomainDetails><CreatedDate>09/05/2016</CreatedDate><ExpiredDate>09/05/2027</ExpiredDate></DomainDetails>
           <Whoisguard Enabled="True"><ID>123</ID></Whoisguard>
         </DomainGetInfoResult>`
      );
    });
    const domain = await nc.getDomain('example.com');
    expect(domain).toMatchObject({
      domainName: 'example.com',
      status: 'ok',
      locked: true,
      privacy: true,
    });
    expect(domain.expirationDate?.getFullYear()).toBe(2027);
    // it consulted the dedicated lock command for this domain
    const lockCall = calls.find(c => c.query?.Command === 'namecheap.domains.getRegistrarLock');
    expect(lockCall?.query).toMatchObject({ DomainName: 'example.com' });
  });

  it('getDomain reads nameservers from getInfo DnsDetails in two calls', async () => {
    const nc = namecheap();
    // A full getInfo reply, shaped like the fixture in Namecheap's own Go SDK
    // (namecheaptest/fixtures/domains_getInfo.xml), recorded from the live API.
    // PremiumDnsSubscription/UseAutoRenew is the PremiumDNS add-on's flag, not
    // the domain's, so it must not leak into `autoRenew`.
    const getInfo = `<?xml version="1.0" encoding="utf-8"?>
      <ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
        <Errors />
        <Warnings />
        <RequestedCommand>namecheap.domains.getinfo</RequestedCommand>
        <CommandResponse Type="namecheap.domains.getInfo">
          <DomainGetInfoResult Status="Ok" ID="1706717" DomainName="example.com" OwnerName="u" IsOwner="true" IsPremium="false">
            <DomainDetails>
              <CreatedDate>11/26/2021</CreatedDate>
              <ExpiredDate>11/26/2027</ExpiredDate>
              <NumYears>0</NumYears>
            </DomainDetails>
            <LockDetails />
            <Whoisguard Enabled="NotAlloted">
              <ID>0</ID>
            </Whoisguard>
            <PremiumDnsSubscription>
              <UseAutoRenew>true</UseAutoRenew>
              <SubscriptionId>-1</SubscriptionId>
              <CreatedDate>0001-01-01T00:00:00</CreatedDate>
              <ExpirationDate>0001-01-01T00:00:00</ExpirationDate>
              <IsActive>false</IsActive>
            </PremiumDnsSubscription>
            <DnsDetails ProviderType="FreeDNS" IsUsingOurDNS="true" HostCount="0" EmailType="No Email Service" DynamicDNSStatus="false" IsFailover="false">
              <Nameserver>freedns1.registrar-servers.com</Nameserver>
              <Nameserver>FreeDNS2.Registrar-Servers.com.</Nameserver>
            </DnsDetails>
            <Modificationrights />
          </DomainGetInfoResult>
        </CommandResponse>
        <Server>PHX01APIEXT12</Server>
        <GMTTimeDifference>--5:00</GMTTimeDifference>
        <ExecutionTime>0.013</ExecutionTime>
      </ApiResponse>`;
    const calls = stubXml(nc, req =>
      req.query?.Command === 'namecheap.domains.getRegistrarLock'
        ? ok(`<DomainGetRegistrarLockResult Domain="example.com" RegistrarLockStatus="false"/>`)
        : getInfo
    );
    const domain = await nc.getDomain('example.com');
    expect(domain).toMatchObject({
      domainName: 'example.com',
      status: 'ok',
      locked: false,
      privacy: false,
      autoRenew: false,
      // normalized like every Domain.nameservers
      nameservers: ['freedns1.registrar-servers.com', 'freedns2.registrar-servers.com'],
    });
    expect(calls.map(c => c.query?.Command)).toEqual([
      'namecheap.domains.getInfo',
      'namecheap.domains.getRegistrarLock',
    ]);
  });

  it('getDomain reads custom nameservers, and none from a bare DnsDetails', async () => {
    const nc = namecheap();
    let dns = `<DnsDetails ProviderType="CUSTOM" IsUsingOurDNS="false">
                 <Nameserver>ns1.example.net</Nameserver><Nameserver>ns2.example.net</Nameserver>
               </DnsDetails>`;
    stubXml(nc, req =>
      req.query?.Command === 'namecheap.domains.getRegistrarLock'
        ? ok(`<DomainGetRegistrarLockResult RegistrarLockStatus="true"/>`)
        : ok(
            `<DomainGetInfoResult Status="Ok" DomainName="example.com">${dns}</DomainGetInfoResult>`
          )
    );
    expect((await nc.getDomain('example.com')).nameservers).toEqual([
      'ns1.example.net',
      'ns2.example.net',
    ]);
    // the docs' sample reply: attributes only, no Nameserver children
    dns = `<DnsDetails ProviderType="ENOM" />`;
    expect((await nc.getDomain('example.com')).nameservers).toEqual([]);
    dns = `<DnsDetails />`;
    expect((await nc.getDomain('example.com')).nameservers).toEqual([]);
  });

  it('declares auto-renew list-only', () => {
    expect(namecheap().listOnlyFields).toEqual(['autoRenew']);
  });

  it('getPricing reads 1-year register/renew/transfer from users.getPricing', async () => {
    const nc = namecheap();
    stubXml(nc, () =>
      ok(
        `<UserGetPricingResult><ProductType Name="DOMAIN">
           <ProductCategory Name="REGISTER"><Product Name="com">
             <Price Duration="1" DurationType="YEAR" Price="9.06" Currency="USD"/>
             <Price Duration="2" DurationType="YEAR" Price="18.00" Currency="USD"/>
           </Product></ProductCategory>
           <ProductCategory Name="RENEW"><Product Name="com">
             <Price Duration="1" DurationType="YEAR" Price="12.98" Currency="USD"/>
           </Product></ProductCategory>
           <ProductCategory Name="TRANSFER"><Product Name="com">
             <Price Duration="1" DurationType="YEAR" Price="9.06" Currency="USD"/>
           </Product></ProductCategory>
         </ProductType></UserGetPricingResult>`
      )
    );
    const pricing = await nc.getPricing('example.com');
    expect(pricing).toEqual({
      tld: 'com',
      currency: 'USD',
      registration: 9.06,
      renewal: 12.98,
      transfer: 9.06,
    });
  });

  it('listDomains passes SearchTerm server-side and paginates at PageSize max', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, () =>
      ok(
        `<DomainGetListResult>
           <Domain ID="1" Name="example.com" Created="01/01/2020" Expires="01/01/2027"
             AutoRenew="true" IsLocked="false" WhoisGuard="ENABLED"/>
         </DomainGetListResult>`
      )
    );
    const domains = await nc.listDomains({ search: 'exam' });
    expect(calls[0].query).toMatchObject({ SearchTerm: 'exam', PageSize: '100', Page: '1' });
    expect(domains[0]).toMatchObject({
      domainName: 'example.com',
      autoRenew: true,
      privacy: true,
    });
  });

  it('getNameservers reads dns.getList', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, () =>
      ok(
        `<DomainDNSGetListResult Domain="example.com" IsUsingOurDNS="false">
           <Nameserver>ns1.example.net</Nameserver><Nameserver>ns2.example.net</Nameserver>
         </DomainDNSGetListResult>`
      )
    );
    const ns = await nc.getNameservers('example.com');
    expect(ns).toEqual(['ns1.example.net', 'ns2.example.net']);
    expect(calls[0].query).toMatchObject({ SLD: 'example', TLD: 'com' });
  });

  it('updateNameservers sends dns.setCustom with SLD/TLD and a comma list', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, () =>
      ok(`<DomainDNSSetCustomResult Domain="example.co.uk" Updated="true"/>`)
    );
    const res = await nc.updateNameservers('example.co.uk', ['ns1.x.net', 'ns2.x.net']);
    expect(res.success).toBe(true);
    expect(calls[0].query).toMatchObject({
      Command: 'namecheap.domains.dns.setCustom',
      SLD: 'example',
      TLD: 'co.uk',
      Nameservers: 'ns1.x.net,ns2.x.net',
    });
  });

  it('resetNameservers sends dns.setDefault and reads its Updated flag', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, () =>
      ok(`<DomainDNSSetDefaultResult Domain="example.com" Updated="true"/>`)
    );
    const res = await nc.resetNameservers('example.com');
    expect(res.success).toBe(true);
    expect(calls[0].query).toMatchObject({
      Command: 'namecheap.domains.dns.setDefault',
      SLD: 'example',
      TLD: 'com',
    });
    expect(calls[0].query).not.toHaveProperty('Nameservers');
    expect(nc.supports(Feature.ResetNameservers)).toBe(true);

    stubXml(nc, () => ok(`<DomainDNSSetDefaultResult Domain="example.com" Updated="false"/>`));
    expect((await nc.resetNameservers('example.com')).success).toBe(false);
  });

  it('updateNameservers routes the BasicDNS hosts to dns.setDefault', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, () =>
      ok(`<DomainDNSSetDefaultResult Domain="example.com" Updated="true"/>`)
    );
    // setCustom rejects these: "Namecheap BasicDNS can not be used as Custom DNS"
    const res = await nc.updateNameservers('example.com', [
      'dns1.registrar-servers.com',
      'DNS2.registrar-servers.com.',
    ]);
    expect(res.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].query?.Command).toBe('namecheap.domains.dns.setDefault');
  });

  it('getContacts maps the Registrant group (AuxBilling -> billing)', async () => {
    const nc = namecheap();
    stubXml(nc, () =>
      ok(
        `<DomainContactsResult Domain="example.com">
           <Registrant>
             <FirstName>Ada</FirstName><LastName>Lovelace</LastName>
             <Address1>1 Byron Way</Address1><City>London</City>
             <StateProvince>LDN</StateProvince><PostalCode>EC1</PostalCode><Country>GB</Country>
             <Phone>+44.2071234567</Phone><EmailAddress>ada@example.com</EmailAddress>
           </Registrant>
           <AuxBilling><FirstName>Bill</FirstName><LastName>Ing</LastName></AuxBilling>
         </DomainContactsResult>`
      )
    );
    const contacts = await nc.getContacts('example.com');
    expect(contacts.registrant).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      country: 'GB',
    });
    expect(contacts.billing).toMatchObject({ firstName: 'Bill', lastName: 'Ing' });
    expect(contacts.admin).toBeUndefined();
  });

  it('updateContacts sends all four roles, falling back to registrant', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, () =>
      ok(`<DomainSetContactResult Domain="example.com" IsSuccess="true"/>`)
    );
    const res = await nc.updateContacts('example.com', {
      registrant: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        phone: '+44.2071234567',
        address1: '1 Byron Way',
        city: 'London',
        state: 'LDN',
        postalCode: 'EC1',
        country: 'GB',
      },
    });
    expect(res.success).toBe(true);
    const q = calls[0].query as Record<string, string>;
    // registrant fields present, and Admin/Tech/AuxBilling filled from registrant
    expect(q.RegistrantFirstName).toBe('Ada');
    expect(q.AdminFirstName).toBe('Ada');
    expect(q.TechEmailAddress).toBe('ada@example.com');
    expect(q.AuxBillingLastName).toBe('Lovelace');
  });

  it('updateContacts requires a registrant', async () => {
    const nc = namecheap();
    stubXml(nc, () => ok(''));
    await expect(nc.updateContacts('example.com', {})).rejects.toThrow(/registrant/);
  });

  it('getDnsRecords maps host records incl. lowercase <host> and MX priority', async () => {
    const nc = namecheap();
    stubXml(nc, () =>
      ok(
        `<DomainDNSGetHostsResult Domain="example.com" IsUsingOurDNS="true">
           <host Name="@" Type="A" Address="1.2.3.4" TTL="1800"/>
           <host Name="@" Type="MX" Address="mail.example.com" MXPref="10" TTL="1800"/>
         </DomainDNSGetHostsResult>`
      )
    );
    const records = await nc.getDnsRecords('example.com');
    expect(records).toEqual([
      { type: 'A', name: '@', value: '1.2.3.4', ttl: 1800 },
      { type: 'MX', name: '@', value: 'mail.example.com', ttl: 1800, priority: 10 },
    ]);
  });

  it('setDnsRecords 1-indexes host params and sets EmailType when MX present', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, () =>
      ok(`<DomainDNSSetHostsResult Domain="example.com" IsSuccess="true"/>`)
    );
    const res = await nc.setDnsRecords('example.com', [
      { type: 'A', name: '@', value: '1.2.3.4', ttl: 600 },
      { type: 'MX', name: '@', value: 'mail.example.com', priority: 20 },
    ]);
    expect(res.success).toBe(true);
    expect(calls[0].query).toMatchObject({
      SLD: 'example',
      TLD: 'com',
      HostName1: '@',
      RecordType1: 'A',
      Address1: '1.2.3.4',
      TTL1: '600',
      HostName2: '@',
      RecordType2: 'MX',
      Address2: 'mail.example.com',
      MXPref2: '20',
      EmailType: 'MX',
    });
  });

  it('surfaces an error envelope as a thrown error / failed result', async () => {
    const nc = namecheap();
    const errXml = `<ApiResponse Status="ERROR"><Errors><Error Number="1011150">Parameter missing</Error></Errors></ApiResponse>`;
    stubXml(nc, () => errXml);
    await expect(nc.getDnsRecords('example.com')).rejects.toThrow('Parameter missing');

    stubXml(nc, () => errXml);
    const res = await nc.lockDomain('example.com');
    expect(res).toEqual({ success: false, message: 'Parameter missing' });
  });

  describe('rate limit (error 500000)', () => {
    // What Namecheap sends once a key is over 50/min, 700/hour or 8,000/day:
    // a 200 reply with Status="ERROR" and error 500000.
    const limitedXml = `<?xml version="1.0" encoding="utf-8"?>
      <ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response">
        <Errors><Error Number="500000">Too many requests</Error></Errors>
        <Warnings /><RequestedCommand>namecheap.domains.getinfo</RequestedCommand>
      </ApiResponse>`;

    it('a read throws RateLimitError once, without re-sending', async () => {
      const nc = namecheap();
      const calls = stubXml(nc, () => limitedXml);
      const error = await nc.getDomain('example.com').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect(error).toMatchObject({
        message: 'Too many requests',
        status: 429,
        providerCode: '500000',
        retryAfter: undefined,
      });
      // getInfo failed, so getRegistrarLock was never spent
      expect(calls).toHaveLength(1);
    });

    it('finds 500000 among several errors', async () => {
      const nc = namecheap();
      stubXml(
        nc,
        () =>
          `<ApiResponse Status="ERROR"><Errors>
             <Error Number="2019166">Domain not found</Error>
             <Error Number="500000">Too many requests</Error>
           </Errors></ApiResponse>`
      );
      await expect(nc.getDnsRecords('example.com')).rejects.toBeInstanceOf(RateLimitError);
    });

    it('other errors stay plain errors', async () => {
      const nc = namecheap();
      stubXml(
        nc,
        () =>
          `<ApiResponse Status="ERROR"><Errors><Error Number="2019166">Domain not found</Error></Errors></ApiResponse>`
      );
      const error = await nc.getDomain('example.com').catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(RateLimitError);
      expect(error).toMatchObject({ message: 'Domain not found' });
    });

    it('a write returns a failed result with status 429', async () => {
      const nc = namecheap();
      stubXml(nc, () => limitedXml);
      expect(await nc.lockDomain('example.com')).toEqual({
        success: false,
        message: 'Too many requests',
        status: 429,
      });
      // a command-based write (setAutoRenew reads the reply's IsSuccess) throws
      await expect(nc.setAutoRenew('example.com', true)).rejects.toBeInstanceOf(RateLimitError);
    });

    it('testConnection reports status 429', async () => {
      const nc = namecheap();
      stubXml(nc, () => limitedXml);
      expect(await nc.testConnection()).toEqual({
        success: false,
        message: 'Too many requests',
        status: 429,
      });
    });
  });

  describe('rate limit (HTTP 405)', () => {
    // Namecheap's own SDK retries HTTP 405 as the API's pre-execution rate-limit
    // signal. Exercise the real HttpClient through a stubbed fetch.
    function withFetch(statuses: number[], options: { retries: number }) {
      const urls: string[] = [];
      const fetch: typeof globalThis.fetch = url => {
        urls.push(url instanceof Request ? url.url : url.toString());
        const status = statuses[urls.length - 1] ?? 200;
        return Promise.resolve(
          status === 200
            ? new Response(ok(`<DomainGetRegistrarLockResult RegistrarLockStatus="true"/>`))
            : new Response('<html>Method Not Allowed</html>', { status })
        );
      };
      const nc = createRegistrar(
        'namecheap',
        { username: 'u', apiKey: 'secret-api-key', clientIp: '1.2.3.4' },
        { fetch, backoff: 0, ...options }
      );
      return { nc, urls };
    }

    it('is retried like a 429, writes included', async () => {
      const { nc, urls } = withFetch([405], { retries: 1 });
      expect(await nc.lockDomain('example.com')).toEqual({ success: true, message: 'OK' });
      expect(urls).toHaveLength(2);
    });

    it('raises RateLimitError without the URL (it carries the key)', async () => {
      const { nc } = withFetch([405], { retries: 0 });
      const error = await nc.getDnsRecords('example.com').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect(error).toMatchObject({ status: 429 });
      expect(String((error as Error).message)).not.toContain('secret-api-key');
    });

    it('leaves other HTTP errors alone', async () => {
      const { nc } = withFetch([403], { retries: 0 });
      const error = await nc.getDnsRecords('example.com').catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(RateLimitError);
      expect(error).toMatchObject({ status: 403 });
    });
  });

  it('registerDomain sends create with all four contacts + WhoisGuard, requires consent', async () => {
    const nc = namecheap();
    const registrant = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+44.2071234567',
      address1: '1 Byron Way',
      city: 'London',
      state: 'LDN',
      postalCode: 'EC1',
      country: 'GB',
    };
    const calls = stubXml(nc, () =>
      ok(`<DomainCreateResult Domain="example.com" Registered="true"/>`)
    );
    const res = await nc.registerDomain('example.com', {
      years: 2,
      contacts: { registrant },
      privacy: true,
      consent: { agreedBy: 'user' },
    });
    expect(res.success).toBe(true);
    const q = calls[0].query as Record<string, string>;
    expect(q).toMatchObject({
      Command: 'namecheap.domains.create',
      DomainName: 'example.com',
      Years: '2',
      AddFreeWhoisguard: 'yes',
      WGEnabled: 'yes',
    });
    // all four roles are sent, omitted ones falling back to the registrant
    expect(q.RegistrantFirstName).toBe('Ada');
    expect(q.AdminFirstName).toBe('Ada');
    expect(q.AuxBillingEmailAddress).toBe('ada@example.com');

    await expect(
      nc.registerDomain('example.com', { contacts: { registrant } })
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('transferIn sends transfer.create with EPPCode (WGenable lowercase)', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, () =>
      ok(`<DomainTransferCreateResult Domainname="example.com" Transfer="true"/>`)
    );
    const res = await nc.transferIn('example.com', {
      authCode: 'EPP123',
      privacy: true,
      consent: { agreedBy: 'user' },
    });
    expect(res.success).toBe(true);
    expect(calls[0].query).toMatchObject({
      Command: 'namecheap.domains.transfer.create',
      DomainName: 'example.com',
      EPPCode: 'EPP123',
      WGenable: 'yes',
    });
  });

  it('setAutoRenew sends DomainName + IsAutoRenew and reads the inner IsSuccess flag', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, () =>
      ok(`<SetAutoRenewResult Domain="example.com" IsSuccess="true"/>`)
    );
    const res = await nc.setAutoRenew('example.com', true);
    expect(res.success).toBe(true);
    expect(calls[0].query).toMatchObject({
      Command: 'namecheap.domains.setAutoRenew',
      DomainName: 'example.com',
      IsAutoRenew: 'true',
    });

    // enabled=false sends IsAutoRenew=false
    const offCalls = stubXml(nc, () =>
      ok(`<SetAutoRenewResult Domain="example.com" IsSuccess="true"/>`)
    );
    await nc.setAutoRenew('example.com', false);
    expect(offCalls[0].query).toMatchObject({ IsAutoRenew: 'false' });
  });

  it('setAutoRenew fails on an OK envelope carrying IsSuccess="false"', async () => {
    const nc = namecheap();
    // a malformed request comes back Status="OK" but IsSuccess="false" (empty Domain)
    stubXml(nc, () => ok(`<SetAutoRenewResult Domain="" IsSuccess="false"/>`));
    const res = await nc.setAutoRenew('example.com', true);
    expect(res.success).toBe(false);
  });

  it('getEmailForwarding maps <Forward mailbox> elements and drops blanks', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, () =>
      ok(
        `<DomainDNSGetEmailForwardingResult Domain="example.com">
           <Forward mailbox="hello">hello@gmail.com</Forward>
           <Forward mailbox="sales">sales@gmail.com</Forward>
           <Forward mailbox=""></Forward>
         </DomainDNSGetEmailForwardingResult>`
      )
    );
    const forwards = await nc.getEmailForwarding('example.com');
    expect(calls[0].query).toMatchObject({
      Command: 'namecheap.domains.dns.getEmailForwarding',
      DomainName: 'example.com',
    });
    expect(forwards).toEqual([
      { alias: 'hello', forwardTo: 'hello@gmail.com' },
      { alias: 'sales', forwardTo: 'sales@gmail.com' },
    ]);
  });

  it('setEmailForwarding 1-indexes MailBox/ForwardTo params (empty clears)', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, () =>
      ok(`<DomainDNSSetEmailForwardingResult Domain="example.com" IsSuccess="true"/>`)
    );
    const res = await nc.setEmailForwarding('example.com', [
      { alias: 'hello', forwardTo: 'a@gmail.com' },
      { alias: 'sales', forwardTo: 'b@gmail.com' },
    ]);
    expect(res.success).toBe(true);
    expect(calls[0].query).toMatchObject({
      Command: 'namecheap.domains.dns.setEmailForwarding',
      DomainName: 'example.com',
      MailBox1: 'hello',
      ForwardTo1: 'a@gmail.com',
      MailBox2: 'sales',
      ForwardTo2: 'b@gmail.com',
    });

    // empty array clears: only DomainName goes out, no MailBox params
    const clearCalls = stubXml(nc, () =>
      ok(`<DomainDNSSetEmailForwardingResult Domain="example.com" IsSuccess="true"/>`)
    );
    await nc.setEmailForwarding('example.com', []);
    expect(clearCalls[0].query).not.toHaveProperty('MailBox1');
  });

  it('getDomainForwarding returns only URL-family host records, mapped by type', async () => {
    const nc = namecheap();
    stubXml(nc, () =>
      ok(
        `<DomainDNSGetHostsResult Domain="example.com" IsUsingOurDNS="true">
           <host Name="@" Type="A" Address="1.2.3.4" TTL="1800"/>
           <host Name="@" Type="URL301" Address="https://example.org" TTL="1800"/>
           <host Name="shop" Type="FRAME" Address="https://store.example.org" TTL="1800"/>
           <host Name="old" Type="URL" Address="https://new.example.org" TTL="1800"/>
         </DomainDNSGetHostsResult>`
      )
    );
    const forwards = await nc.getDomainForwarding('example.com');
    expect(forwards).toEqual([
      { host: '@', url: 'https://example.org', type: 'permanent' },
      // FRAME (masked) forwarding is reported as read-only `masked`
      { host: 'shop', url: 'https://store.example.org', type: 'masked' },
      { host: 'old', url: 'https://new.example.org', type: 'temporary' },
    ]);
  });

  it('setDomainForwarding preserves non-URL records and rewrites the URL set', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, req => {
      if (req.query?.Command === 'namecheap.domains.dns.getHosts') {
        return ok(
          `<DomainDNSGetHostsResult Domain="example.com" IsUsingOurDNS="true">
             <host Name="@" Type="A" Address="1.2.3.4" TTL="1800"/>
             <host Name="old" Type="URL" Address="https://legacy.example.org" TTL="1800"/>
           </DomainDNSGetHostsResult>`
        );
      }
      return ok(`<DomainDNSSetHostsResult Domain="example.com" IsSuccess="true"/>`);
    });
    const res = await nc.setDomainForwarding('example.com', [
      { host: '@', url: 'https://example.org', type: 'permanent' },
    ]);
    expect(res.success).toBe(true);
    // read-then-write: getHosts first, then setHosts with the merged set
    expect(calls.map(c => c.query?.Command)).toEqual([
      'namecheap.domains.dns.getHosts',
      'namecheap.domains.dns.setHosts',
    ]);
    const setQ = calls[1].query as Record<string, string>;
    // the pre-existing A record is preserved
    expect(setQ).toMatchObject({ HostName1: '@', RecordType1: 'A', Address1: '1.2.3.4' });
    // the old URL record is dropped and the new permanent (URL301) forward added
    expect(setQ).toMatchObject({
      HostName2: '@',
      RecordType2: 'URL301',
      Address2: 'https://example.org',
    });
    expect(setQ).not.toHaveProperty('Address3');
  });

  it('setPrivacy disables WhoisGuard using the id from getInfo', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, req => {
      if (req.query?.Command === 'namecheap.domains.getInfo') {
        return ok(
          `<DomainGetInfoResult Status="Ok" DomainName="example.com">
             <Whoisguard Enabled="True"><ID>555</ID></Whoisguard>
           </DomainGetInfoResult>`
        );
      }
      return ok(`<DomainPrivacyDisableResult Domain="example.com" IsSuccess="true"/>`);
    });
    const res = await nc.setPrivacy('example.com', false);
    expect(res.success).toBe(true);
    const disable = calls.find(c => c.query?.Command === 'namecheap.whoisguard.disable');
    expect(disable?.query).toMatchObject({ WhoisguardID: '555' });
  });

  it('setPrivacy enables WhoisGuard with the registrant email as ForwardedToEmail', async () => {
    const nc = namecheap();
    const calls = stubXml(nc, req => {
      if (req.query?.Command === 'namecheap.domains.getInfo') {
        return ok(
          `<DomainGetInfoResult Status="Ok" DomainName="example.com">
             <Whoisguard Enabled="False"><ID>777</ID></Whoisguard>
           </DomainGetInfoResult>`
        );
      }
      if (req.query?.Command === 'namecheap.domains.getContacts') {
        return ok(
          `<DomainContactsResult Domain="example.com">
             <Registrant><FirstName>Ada</FirstName><EmailAddress>ada@example.com</EmailAddress></Registrant>
           </DomainContactsResult>`
        );
      }
      return ok(`<DomainPrivacyEnableResult Domain="example.com" IsSuccess="true"/>`);
    });
    const res = await nc.setPrivacy('example.com', true);
    expect(res.success).toBe(true);
    const enable = calls.find(c => c.query?.Command === 'namecheap.whoisguard.enable');
    expect(enable?.query).toMatchObject({
      WhoisguardID: '777',
      ForwardedToEmail: 'ada@example.com',
    });
  });

  it('setPrivacy throws when the domain has no WhoisGuard allotted', async () => {
    const nc = namecheap();
    stubXml(nc, () =>
      ok(
        `<DomainGetInfoResult Status="Ok" DomainName="example.com">
           <Whoisguard Enabled="NotAlloted"><ID>0</ID></Whoisguard>
         </DomainGetInfoResult>`
      )
    );
    await expect(nc.setPrivacy('example.com', true)).rejects.toThrow(/WhoisGuard/i);
  });
});

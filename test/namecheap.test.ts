import { describe, it, expect } from 'vitest';
import { createRegistrar, ConsentRequiredError } from '../src/index';
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
  it('checkAvailability maps availability and premium price', async () => {
    const nc = namecheap();
    stubXml(nc, () =>
      ok(
        `<DomainCheckResult Domain="example.com" Available="true" IsPremiumName="false" PremiumRegistrationPrice="0.0000"/>
         <DomainCheckResult Domain="rich.com" Available="true" IsPremiumName="true" PremiumRegistrationPrice="1500.0000"/>
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
    expect(results[1]).toMatchObject({ available: true, premium: true, price: 1500 });
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

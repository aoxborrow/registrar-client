import { beforeAll, describe, expect, it } from 'vitest';
import { createRegistrar, NotFoundError, type Registrar, type Contact } from '../../src/index';

const username = process.env.NAMECOM_USERNAME;
const apiToken = process.env.NAMECOM_API_TOKEN;
const testDomain = process.env.NAMECOM_TEST_DOMAIN;
const contact: Contact = {
  firstName: 'API',
  lastName: 'Sandbox',
  email: 'test@example.com',
  phone: '+1.2025550123',
  address1: '123 Test Street',
  city: 'Denver',
  state: 'CO',
  postalCode: '80202',
  country: 'US',
};

describe.skipIf(!username || !apiToken)('Name.com Core sandbox', () => {
  let provider: Registrar;
  beforeAll(() => {
    // Never consult NAMECOM_ENVIRONMENT: this suite cannot route to production.
    provider = createRegistrar(
      'namecom',
      { username: username!, apiToken: apiToken! },
      {
        environment: 'sandbox',
        retries: 1,
        backoff: 1000,
      }
    );
  });

  it('authenticates, lists domains and reads account pricing', async () => {
    const connection = await provider.testConnection();
    expect(connection.success, connection.message).toBe(true);
    const domains = await provider.listDomains();
    expect(domains.every(d => d.registrar === 'namecom')).toBe(true);
    const pricing = await provider.getPricing('com');
    expect(pricing.currency).toBe('USD');
    expect(pricing.renewal).toBeGreaterThan(0);
    if (domains[0]) {
      const detail = await provider.getDomain(domains[0].domainName);
      expect(detail.domainName).toBe(domains[0].domainName);
      expect(detail.expirationDate).toBeInstanceOf(Date);
    }
  });

  it.skipIf(!testDomain)(
    'exercises a disposable sandbox domain lifecycle',
    async () => {
      if (!testDomain || !/^registrar-client-[a-z0-9-]+\.com$/.test(testDomain)) {
        throw new Error(
          'NAMECOM_TEST_DOMAIN must be a disposable registrar-client-<unique-suffix>.com sandbox name'
        );
      }
      let exists = true;
      try {
        await provider.getDomain(testDomain);
      } catch (error) {
        if (error instanceof NotFoundError) exists = false;
        else throw error;
      }
      if (!exists) {
        const registration = await provider.registerDomain(testDomain, {
          contacts: { registrant: contact, admin: contact, tech: contact, billing: contact },
          privacy: true,
          autoRenew: false,
          years: 1,
        });
        expect(registration.success, registration.message).toBe(true);
      }
      const before = await provider.getDomain(testDomain);
      const renewal = await provider.renewDomain(testDomain, 1);
      expect(renewal.success, renewal.message).toBe(true);
      expect((await provider.getDomain(testDomain)).expirationDate!.getTime()).toBeGreaterThan(
        before.expirationDate!.getTime()
      );
      for (const enabled of [true, false]) {
        const autoRenew = await provider.setAutoRenew(testDomain, enabled);
        expect(autoRenew.success, autoRenew.message).toBe(true);
        expect((await provider.getDomain(testDomain)).autoRenew).toBe(enabled);
        const privacy = await provider.setPrivacy(testDomain, enabled);
        expect(privacy.success, privacy.message).toBe(true);
        expect((await provider.getDomain(testDomain)).privacy).toBe(enabled);
      }
      const lock = await provider.lockDomain(testDomain);
      expect(lock.success, lock.message).toBe(true);
      expect((await provider.getDomain(testDomain)).locked).toBe(true);
      // New registrations may carry a mandatory 60-day lock. An unlock rejection
      // is expected in that case; never claim that it was verified successfully.
      const unlock = await provider.unlockDomain(testDomain);
      if (unlock.success) expect((await provider.getDomain(testDomain)).locked).toBe(false);
      else
        console.info(
          'Sandbox unlock rejected (possible registration policy lock):',
          unlock.message
        );
      expect(await provider.getAuthCode(testDomain)).not.toBe('');
      const ns = before.nameservers;
      expect(ns.length).toBeGreaterThan(0);
      const nameservers = await provider.updateNameservers(testDomain, ns);
      expect(nameservers.success, nameservers.message).toBe(true);
      expect(await provider.getNameservers(testDomain)).toEqual(ns);
      const contacts = await provider.updateContacts(testDomain, { tech: contact });
      expect(contacts.success, contacts.message).toBe(true);
      expect((await provider.getContacts(testDomain)).tech?.email).toBe(contact.email);
      const records = [
        { type: 'TXT', name: '_registrar_client_test', value: 'namecom-core-sandbox', ttl: 300 },
      ];
      const dns = await provider.setDnsRecords(testDomain, records);
      expect(dns.success, dns.message).toBe(true);
      expect(await provider.getDnsRecords(testDomain)).toEqual(records);
      const clear = await provider.setDnsRecords(testDomain, []);
      expect(clear.success, clear.message).toBe(true);
      expect(await provider.getDnsRecords(testDomain)).toEqual([]);
    },
    180_000
  );
});

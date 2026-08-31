import { describe, it, expect } from 'vitest';
import {
  createDomain,
  normalizeDomain,
  normalizeNameservers,
  parseDate,
  registrars,
  createRegistrar,
  selectBaseUrl,
  ConfigurationError,
  RegistrarClient,
  Feature,
  CORE_FEATURES,
  EXTENDED_FEATURES,
  ALL_FEATURES,
  isCoreFeature,
} from '../src/index';
import type { Domain, Registrar } from '../src/index';

// Minimal fake provider exercising just listDomains + getDomain. The rest of
// the Registrar contract is unused by these tests, so we cast a partial.
function fakeProvider(config: {
  summaries: Domain[];
  detail: (name: string) => Domain;
  onGetDomain?: (name: string) => void;
  failFor?: string;
  nameservers?: (name: string) => string[];
}): Registrar {
  return {
    name: 'fake',
    listDomains: () => Promise.resolve(config.summaries),
    getDomain: (name: string) => {
      config.onGetDomain?.(name);
      if (config.failFor === name) {
        return Promise.reject(new Error('detail failed'));
      }
      return Promise.resolve(config.detail(name));
    },
    getNameservers: (name: string) =>
      Promise.resolve(config.nameservers ? config.nameservers(name) : []),
  } as unknown as Registrar;
}

describe('normalizeDomain', () => {
  it('trims, lowercases, and strips a trailing dot', () => {
    expect(normalizeDomain('  Example.COM.  ')).toBe('example.com');
  });
});

describe('normalizeNameservers', () => {
  it('passes through a string array', () => {
    expect(normalizeNameservers(['a.ns.com', 'b.ns.com'])).toEqual(['a.ns.com', 'b.ns.com']);
  });
  it('unwraps a { hosts } object (Spaceship shape)', () => {
    expect(normalizeNameservers({ hosts: ['a.ns.com'] })).toEqual(['a.ns.com']);
  });
  it('extracts ServerName from objects (Dynadot shape)', () => {
    expect(normalizeNameservers([{ ServerName: 'a.ns.com' }])).toEqual(['a.ns.com']);
  });
  it('lowercases and trims hostnames, dropping blanks', () => {
    expect(normalizeNameservers(['  NS1.Example.COM ', 'ns2.EXAMPLE.com', '', '   '])).toEqual([
      'ns1.example.com',
      'ns2.example.com',
    ]);
  });
});

describe('createDomain', () => {
  it('lowercases status and coerces dates', () => {
    const d = createDomain({
      domainName: 'example.com',
      status: 'OK',
      expirationDate: '2030-01-01',
    });
    expect(d.status).toBe('ok');
    expect(d.expirationDate).toBeInstanceOf(Date);
    expect(d.nameservers).toEqual([]);
  });
});

describe('parseDate', () => {
  it('parses epoch-millis numbers', () => {
    expect(parseDate(1_700_000_000_000)?.getUTCFullYear()).toBe(2023);
  });
  it('returns null for empty input', () => {
    expect(parseDate(null)).toBeNull();
  });
});

describe('registrars catalog', () => {
  it('exposes all built-in registrars with metadata', () => {
    for (const [id, Registrar] of Object.entries(registrars)) {
      expect(typeof Registrar.displayName).toBe('string');
      expect(Array.isArray(Registrar.configFields)).toBe(true);
      expect(typeof Registrar.helpText).toBe('string');
      // the instance's name matches its catalog id
      const instance = createRegistrar(id as keyof typeof registrars, {});
      expect(instance.name).toBe(id);
    }
  });

  it('wraps a provider in a RegistrarClient facade', () => {
    const client = new RegistrarClient(
      createRegistrar('cloudflare', { apiToken: 'x', accountId: 'y' })
    );
    expect(client.provider.name).toBe('cloudflare');
  });
});

describe('RegistrarClient listDomains detailed enrichment', () => {
  const summaries = [
    createDomain({ domainName: 'a.com', privacy: false, nameservers: [] }),
    createDomain({ domainName: 'b.com', privacy: false, nameservers: [] }),
  ];
  const detail = (name: string) =>
    createDomain({
      domainName: name,
      privacy: true,
      nameservers: ['ns1.example.net', 'ns2.example.net'],
    });

  it('returns the summary and skips detail calls without `detailed`', async () => {
    const calls: string[] = [];
    const client = new RegistrarClient(
      fakeProvider({ summaries, detail, onGetDomain: n => calls.push(n) })
    );
    const out = await client.listDomains();
    expect(out.map(d => d.privacy)).toEqual([false, false]);
    expect(out.map(d => d.nameservers)).toEqual([[], []]);
    expect(calls).toEqual([]);
  });

  it('merges per-domain detail when `detailed` is set', async () => {
    const calls: string[] = [];
    const client = new RegistrarClient(
      fakeProvider({ summaries, detail, onGetDomain: n => calls.push(n) })
    );
    const out = await client.listDomains({ detailed: true });
    expect(out.map(d => d.privacy)).toEqual([true, true]);
    expect(out[0].nameservers).toEqual(['ns1.example.net', 'ns2.example.net']);
    expect(calls.sort()).toEqual(['a.com', 'b.com']);
  });

  it('falls back to getNameservers when detail leaves nameservers empty', async () => {
    // getDomain fixes privacy but returns no nameservers (Namecheap-style).
    const detailNoNs = (name: string) =>
      createDomain({ domainName: name, privacy: true, nameservers: [] });
    const client = new RegistrarClient(
      fakeProvider({
        summaries,
        detail: detailNoNs,
        nameservers: () => ['dns1.registrar.net', 'dns2.registrar.net'],
      })
    );
    const out = await client.listDomains({ detailed: true });
    expect(out[0].privacy).toBe(true);
    expect(out[0].nameservers).toEqual(['dns1.registrar.net', 'dns2.registrar.net']);
  });

  it('keeps the summary for a domain whose detail fetch fails', async () => {
    const client = new RegistrarClient(fakeProvider({ summaries, detail, failFor: 'a.com' }));
    const out = await client.listDomains({ detailed: true });
    const a = out.find(d => d.domainName === 'a.com');
    const b = out.find(d => d.domainName === 'b.com');
    expect(a?.privacy).toBe(false); // detail failed → summary kept
    expect(b?.privacy).toBe(true); // enriched
  });
});

describe('RegistrarClient forwarding passthrough', () => {
  // Records the domain each forwarding method receives, so we can assert the
  // facade normalizes it and delegates the payload unchanged.
  function forwardingProvider() {
    const seen: { method: string; domain: string; forwards?: unknown }[] = [];
    const provider = {
      name: 'fake',
      getEmailForwarding: (domain: string) => {
        seen.push({ method: 'getEmailForwarding', domain });
        return Promise.resolve([{ alias: 'hello', forwardTo: 'a@b.com' }]);
      },
      setEmailForwarding: (domain: string, forwards: unknown) => {
        seen.push({ method: 'setEmailForwarding', domain, forwards });
        return Promise.resolve({ success: true });
      },
      getDomainForwarding: (domain: string) => {
        seen.push({ method: 'getDomainForwarding', domain });
        return Promise.resolve([{ host: '@', url: 'https://b.com', type: 'permanent' }]);
      },
      setDomainForwarding: (domain: string, forwards: unknown) => {
        seen.push({ method: 'setDomainForwarding', domain, forwards });
        return Promise.resolve({ success: true });
      },
    } as unknown as Registrar;
    return { client: new RegistrarClient(provider), seen };
  }

  it('normalizes the domain and delegates for reads', async () => {
    const { client, seen } = forwardingProvider();
    await client.getEmailForwarding('  Example.COM.  ');
    await client.getDomainForwarding('  Example.COM.  ');
    expect(seen).toEqual([
      { method: 'getEmailForwarding', domain: 'example.com' },
      { method: 'getDomainForwarding', domain: 'example.com' },
    ]);
  });

  it('normalizes the domain and passes forwards through for writes', async () => {
    const { client, seen } = forwardingProvider();
    const emails = [{ alias: 'hi', forwardTo: 'x@y.com' }];
    const urls = [{ host: 'www', url: 'https://y.com', type: 'temporary' as const }];
    await client.setEmailForwarding('EXAMPLE.com', emails);
    await client.setDomainForwarding('EXAMPLE.com', urls);
    expect(seen).toEqual([
      { method: 'setEmailForwarding', domain: 'example.com', forwards: emails },
      { method: 'setDomainForwarding', domain: 'example.com', forwards: urls },
    ]);
  });
});

describe('capabilities / features', () => {
  it('core and extended partition the full feature catalog with no overlap', () => {
    const core = new Set<string>(CORE_FEATURES);
    const extended = new Set<string>(EXTENDED_FEATURES);
    // every Feature constant is in exactly one of core / extended
    for (const feature of Object.values(Feature)) {
      expect(core.has(feature) !== extended.has(feature), `${feature} is in exactly one set`).toBe(
        true
      );
    }
    expect(ALL_FEATURES.length).toBe(core.size + extended.size);
    expect(new Set(ALL_FEATURES).size).toBe(ALL_FEATURES.length); // no duplicates
  });

  it('isCoreFeature reflects membership in CORE_FEATURES', () => {
    expect(isCoreFeature(Feature.GetPricing)).toBe(true);
    expect(isCoreFeature(Feature.SetAutoRenew)).toBe(true);
    expect(isCoreFeature(Feature.GetDnssec)).toBe(false);
  });

  it('every provider inherits core and its extended features are valid extras', () => {
    const extended = new Set<string>(EXTENDED_FEATURES);
    for (const [id, Registrar] of Object.entries(registrars)) {
      // core is guaranteed by the contract, not re-declared per provider
      for (const feature of CORE_FEATURES) {
        expect(Registrar.features.includes(feature), `${id} is missing core ${feature}`).toBe(true);
      }
      // declared extras are real extended features, unique and never core
      expect(new Set(Registrar.extendedFeatures).size, `${id} extras are unique`).toBe(
        Registrar.extendedFeatures.length
      );
      for (const feature of Registrar.extendedFeatures) {
        expect(extended.has(feature), `${id} declares ${feature} as extended`).toBe(true);
      }
    }
  });

  it('provider.features is core plus its extended features', () => {
    expect(registrars.godaddy.features).toEqual([
      ...CORE_FEATURES,
      ...registrars.godaddy.extendedFeatures,
    ]);
  });

  it('instances expose features and a working supports() check', () => {
    const gd = createRegistrar('godaddy', {});
    expect(gd.features).toEqual(registrars.godaddy.features);
    expect(gd.supports(Feature.RegisterDomain)).toBe(true); // core
    expect(gd.supports(Feature.GetAuthCode)).toBe(true); // its extended
    expect(gd.supports(Feature.SetDomainForwarding)).toBe(true); // v2 customer-scoped forwarding
    expect(gd.supports(Feature.GetDnssec)).toBe(false); // not declared
    // a provider that declares an extended feature reports it as supported
    const ns = createRegistrar('namesilo', { apiKey: 'k' });
    expect(ns.supports(Feature.SetDomainForwarding)).toBe(true);
  });
});

describe('sandbox / environment', () => {
  it('selectBaseUrl picks production by default and sandbox when asked', () => {
    const urls = { production: 'https://prod', sandbox: 'https://sbx' };
    expect(selectBaseUrl('X', undefined, urls)).toBe('https://prod');
    expect(selectBaseUrl('X', 'production', urls)).toBe('https://prod');
    expect(selectBaseUrl('X', 'sandbox', urls)).toBe('https://sbx');
  });

  it('selectBaseUrl throws when sandbox is requested but unavailable', () => {
    expect(() => selectBaseUrl('X', 'sandbox', { production: 'https://prod' })).toThrow(
      ConfigurationError
    );
  });

  it('constructing a no-sandbox provider with environment:sandbox throws', () => {
    expect(() =>
      createRegistrar('cloudflare', { apiToken: 'x', accountId: 'y' }, { environment: 'sandbox' })
    ).toThrow(ConfigurationError);
  });

  it('sandbox-capable providers accept environment:sandbox', () => {
    const gandi = createRegistrar('gandi', { apiKey: 'x' }, { environment: 'sandbox' });
    expect(gandi.environment).toBe('sandbox');
  });

  it('supportsSandbox flags match the known set', () => {
    const supported = Object.entries(registrars)
      .filter(([, R]) => R.supportsSandbox)
      .map(([id]) => id)
      .sort();
    expect(supported).toEqual(['dynadot', 'gandi', 'godaddy', 'namecheap', 'namesilo', 'porkbun']);
  });
});

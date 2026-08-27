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
    expect(isCoreFeature(Feature.ConfigureDnssec)).toBe(false);
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
    expect(gd.supports(Feature.SetDomainForwarding)).toBe(true); // its extended
    expect(gd.supports(Feature.SubscribeWebhooks)).toBe(false); // not declared
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
    expect(supported).toEqual(['gandi', 'godaddy', 'namecheap']);
  });
});

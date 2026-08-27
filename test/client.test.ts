import { describe, it, expect } from 'vitest';
import {
  createDomain,
  normalizeDomain,
  normalizeNameservers,
  parseDate,
  registrars,
  createRegistrar,
  RegistrarClient,
} from '../src/index.js';

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

describe('registry', () => {
  it('exposes all built-in registrars with metadata', () => {
    for (const [id, Registrar] of Object.entries(registrars)) {
      expect(typeof Registrar.displayName).toBe('string');
      expect(Array.isArray(Registrar.configFields)).toBe(true);
      expect(typeof Registrar.helpText).toBe('string');
      // the instance's name matches its registry id
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

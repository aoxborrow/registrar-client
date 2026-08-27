import { describe, it, expect } from 'vitest';
import { RegistrarClient, StubRegistrar, NotImplementedError } from '../src/index.js';
import { normalizeDomain } from '../src/utils.js';

describe('normalizeDomain', () => {
  it('trims, lowercases, and strips a trailing dot', () => {
    expect(normalizeDomain('  Example.COM.  ')).toBe('example.com');
  });
});

describe('RegistrarClient with StubRegistrar', () => {
  const client = new RegistrarClient(new StubRegistrar({ apiKey: 'test-key' }));

  it('exposes the provider', () => {
    expect(client.provider.name).toBe('stub');
  });

  it('throws NotImplementedError for unimplemented operations', async () => {
    await expect(client.checkAvailability(['example.com'])).rejects.toBeInstanceOf(
      NotImplementedError
    );
  });
});

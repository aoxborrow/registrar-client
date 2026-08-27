import { beforeAll, describe, expect, it } from 'vitest';
import { createRegistrar, type Registrar } from '../../src/index';
import { loadSandboxCredentials, SANDBOX_TARGETS } from './helpers';

// One suite per sandbox-capable registrar. Each suite is skipped unless its
// credentials are present in the environment (see test/integration/helpers.ts
// and .env.example), so this file is safe to run with no configuration.
//
// Only read-only operations are exercised (testConnection, listDomains) so no
// sandbox domains are modified. Add mutating checks per-registrar as needed,
// guarded by a disposable sandbox domain you control.
for (const target of SANDBOX_TARGETS) {
  const credentials = loadSandboxCredentials(target);

  describe.skipIf(!credentials)(`${target.name} (sandbox)`, () => {
    // constructed lazily in beforeAll so nothing runs when the suite is skipped
    let provider: Registrar;

    beforeAll(() => {
      provider = createRegistrar(target.name, credentials!, { environment: 'sandbox' });
    });

    it('connects with sandbox credentials', async () => {
      const result = await provider.testConnection();
      expect(result.success, result.message).toBe(true);
    });

    it('lists domains', async () => {
      const domains = await provider.listDomains();
      expect(Array.isArray(domains)).toBe(true);
      for (const domain of domains) {
        expect(typeof domain.domainName).toBe('string');
        expect(domain.registrar).toBe(target.name);
      }
    });
  });
}

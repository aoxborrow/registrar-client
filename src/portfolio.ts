// Aggregate domains across multiple registrars into one combined portfolio.
//
// Each source is queried concurrently and failures are isolated per-registrar
// (one provider being down never sinks the whole view). Every returned Domain
// already carries its `registrar`, so the flattened list stays attributable.

import type { RegistrarClient } from './client';
import type { Domain, ListDomainsOptions, Registrar } from './types';
import { toRegistrarError } from './errors';

// anything that can list domains: a raw Registrar or the RegistrarClient facade
export type DomainSource = Registrar | RegistrarClient;

// a per-registrar failure from a portfolio fetch
export interface PortfolioError {
  // the registrar id that failed, e.g. "godaddy"
  registrar: string;
  error: Error;
}

// the outcome of a portfolio fetch: all domains that loaded, plus any errors
export interface PortfolioResult {
  domains: Domain[];
  errors: PortfolioError[];
}

// resolve a source's registrar id, whether it's a client facade or a provider
function sourceName(source: DomainSource): string {
  return 'provider' in source ? source.provider.name : source.name;
}

/**
 * List domains across many registrars at once. Queries every source in parallel
 * and collects results with per-registrar error isolation.
 *
 * `opts` (including `limit` and `search`) is applied to EACH source
 * independently — e.g. `limit: 1000` caps each registrar at 1000, not the whole
 * portfolio. Order of the returned `domains` follows the order of `sources`.
 *
 *   const { domains, errors } = await listPortfolio(
 *     [godaddyClient, namecheapClient, gandiClient],
 *     { limit: 500 }
 *   );
 */
export async function listPortfolio(
  sources: DomainSource[],
  opts?: ListDomainsOptions
): Promise<PortfolioResult> {
  const settled = await Promise.allSettled(sources.map(source => source.listDomains(opts)));

  const domains: Domain[] = [];
  const errors: PortfolioError[] = [];

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      domains.push(...result.value);
    } else {
      errors.push({
        registrar: sourceName(sources[i]),
        error: toRegistrarError(result.reason),
      });
    }
  });

  return { domains, errors };
}

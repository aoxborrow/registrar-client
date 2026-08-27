import { normalizeDomain } from './utils.js';
import type {
  Domain,
  DomainAvailability,
  DomainPricing,
  RegisterDomainParams,
  RenewDomainParams,
  RequestOptions,
  TransferDomainParams,
} from './types.js';
import type { RegistrarProvider } from './registrars/types.js';

// The public entry point. A thin, provider-agnostic facade that normalizes
// input and delegates to the configured `RegistrarProvider`. Construct it with
// any provider:
//
//   const client = new RegistrarClient(new StubRegistrar({ apiKey }));
//   await client.checkAvailability(['example.com']);
export class RegistrarClient {
  constructor(public readonly provider: RegistrarProvider) {}

  checkAvailability(domains: string[], opts?: RequestOptions): Promise<DomainAvailability[]> {
    return this.provider.checkAvailability(domains.map(normalizeDomain), opts);
  }

  getPricing(domain: string, opts?: RequestOptions): Promise<DomainPricing> {
    return this.provider.getPricing(normalizeDomain(domain), opts);
  }

  listDomains(opts?: RequestOptions): Promise<Domain[]> {
    return this.provider.listDomains(opts);
  }

  getDomain(domain: string, opts?: RequestOptions): Promise<Domain> {
    return this.provider.getDomain(normalizeDomain(domain), opts);
  }

  registerDomain(params: RegisterDomainParams, opts?: RequestOptions): Promise<Domain> {
    return this.provider.registerDomain(
      { ...params, domain: normalizeDomain(params.domain) },
      opts
    );
  }

  renewDomain(params: RenewDomainParams, opts?: RequestOptions): Promise<Domain> {
    return this.provider.renewDomain({ ...params, domain: normalizeDomain(params.domain) }, opts);
  }

  transferDomain(params: TransferDomainParams, opts?: RequestOptions): Promise<Domain> {
    return this.provider.transferDomain(
      { ...params, domain: normalizeDomain(params.domain) },
      opts
    );
  }

  setNameservers(domain: string, nameservers: string[], opts?: RequestOptions): Promise<Domain> {
    return this.provider.setNameservers(normalizeDomain(domain), nameservers, opts);
  }

  setAutoRenew(domain: string, enabled: boolean, opts?: RequestOptions): Promise<Domain> {
    return this.provider.setAutoRenew(normalizeDomain(domain), enabled, opts);
  }

  setLock(domain: string, locked: boolean, opts?: RequestOptions): Promise<Domain> {
    return this.provider.setLock(normalizeDomain(domain), locked, opts);
  }
}

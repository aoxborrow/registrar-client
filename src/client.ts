import { normalizeDomain } from './utils';
import type { ConnectionResult, Domain, OperationResult, Registrar, RequestOptions } from './types';

// A thin, provider-agnostic facade over a single `Registrar`. Normalizes
// domain names and delegates to the underlying provider.
//
//   const client = new RegistrarClient(createRegistrar('cloudflare', creds));
//   await client.listDomains();
export class RegistrarClient {
  constructor(public readonly provider: Registrar) {}

  testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    return this.provider.testConnection(opts);
  }

  listDomains(opts?: RequestOptions): Promise<Domain[]> {
    return this.provider.listDomains(opts);
  }

  renewDomain(domainName: string, years?: number, opts?: RequestOptions): Promise<OperationResult> {
    return this.provider.renewDomain(normalizeDomain(domainName), years, opts);
  }

  updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.provider.updateNameservers(normalizeDomain(domainName), nameservers, opts);
  }

  lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.provider.lockDomain(normalizeDomain(domainName), opts);
  }

  unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.provider.unlockDomain(normalizeDomain(domainName), opts);
  }
}

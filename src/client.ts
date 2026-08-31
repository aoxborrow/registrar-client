import { normalizeDomain, normalizeNameservers } from './utils';
import type {
  ConnectionResult,
  ContactSet,
  DnsRecord,
  Domain,
  DomainAvailability,
  DomainForward,
  EmailForward,
  ListDomainsOptions,
  OperationResult,
  Registrar,
  RegisterDomainInput,
  RequestOptions,
  TldPricing,
  TransferDomainInput,
} from './types';

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

  async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const domains = await this.provider.listDomains(opts);
    if (!opts?.detailed) return domains;
    return this.enrichWithDetail(domains, opts);
  }

  // Fills fields that a provider's list endpoint omits (nameservers, privacy,
  // lock) by fetching each domain's detail and merging it over the summary.
  // Runs with bounded concurrency; a per-domain detail failure leaves that
  // domain's summary values untouched rather than failing the whole listing.
  private async enrichWithDetail(domains: Domain[], opts: RequestOptions): Promise<Domain[]> {
    const CONCURRENCY = 5;
    const result = [...domains];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < domains.length) {
        const index = next++;
        const name = domains[index].domainName;
        try {
          const detail = await this.provider.getDomain(name, opts);
          let merged = { ...domains[index], ...detail };
          // Some providers expose nameservers only via a dedicated endpoint, not
          // on the domain detail — fetch them separately when still empty.
          if (merged.nameservers.length === 0) {
            try {
              const nameservers = normalizeNameservers(
                await this.provider.getNameservers(name, opts)
              );
              if (nameservers.length > 0) merged = { ...merged, nameservers };
            } catch {
              // leave nameservers empty if this provider can't supply them
            }
          }
          result[index] = merged;
        } catch {
          // keep the summary values for this domain on detail failure
        }
      }
    };
    const workers = Array.from({ length: Math.min(CONCURRENCY, domains.length) }, worker);
    await Promise.all(workers);
    return result;
  }

  getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    return this.provider.getDomain(normalizeDomain(domainName), opts);
  }

  checkAvailability(domainNames: string[], opts?: RequestOptions): Promise<DomainAvailability[]> {
    return this.provider.checkAvailability(domainNames.map(normalizeDomain), opts);
  }

  getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    return this.provider.getPricing(normalizeDomain(tldOrDomain), opts);
  }

  registerDomain(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.provider.registerDomain(normalizeDomain(domainName), input, opts);
  }

  renewDomain(domainName: string, years?: number, opts?: RequestOptions): Promise<OperationResult> {
    return this.provider.renewDomain(normalizeDomain(domainName), years, opts);
  }

  setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.provider.setAutoRenew(normalizeDomain(domainName), enabled, opts);
  }

  transferIn(
    domainName: string,
    input: TransferDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.provider.transferIn(normalizeDomain(domainName), input, opts);
  }

  updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.provider.updateNameservers(normalizeDomain(domainName), nameservers, opts);
  }

  async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    return normalizeNameservers(
      await this.provider.getNameservers(normalizeDomain(domainName), opts)
    );
  }

  lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.provider.lockDomain(normalizeDomain(domainName), opts);
  }

  unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.provider.unlockDomain(normalizeDomain(domainName), opts);
  }

  setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.provider.setPrivacy(normalizeDomain(domainName), enabled, opts);
  }

  getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    return this.provider.getContacts(normalizeDomain(domainName), opts);
  }

  updateContacts(
    domainName: string,
    contacts: ContactSet,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.provider.updateContacts(normalizeDomain(domainName), contacts, opts);
  }

  getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    return this.provider.getDnsRecords(normalizeDomain(domainName), opts);
  }

  setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.provider.setDnsRecords(normalizeDomain(domainName), records, opts);
  }

  // --- extended: forwarding ---
  //
  // Opt-in per provider (gate on `provider.supports(Feature.…)`); providers that
  // don't declare the feature reject with NotImplementedError. Email forwarding
  // (alias → address) and URL/domain forwarding (host → URL redirect) are
  // unrelated capabilities with separate feature flags. Each `set…` is a full
  // replace: any rule omitted is removed, an empty array clears forwarding.

  getEmailForwarding(domainName: string, opts?: RequestOptions): Promise<EmailForward[]> {
    return this.provider.getEmailForwarding(normalizeDomain(domainName), opts);
  }

  setEmailForwarding(
    domainName: string,
    forwards: EmailForward[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.provider.setEmailForwarding(normalizeDomain(domainName), forwards, opts);
  }

  getDomainForwarding(domainName: string, opts?: RequestOptions): Promise<DomainForward[]> {
    return this.provider.getDomainForwarding(normalizeDomain(domainName), opts);
  }

  setDomainForwarding(
    domainName: string,
    forwards: DomainForward[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.provider.setDomainForwarding(normalizeDomain(domainName), forwards, opts);
  }
}

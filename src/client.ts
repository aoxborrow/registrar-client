import { normalizeDomain } from './utils';
import type {
  ConnectionResult,
  ContactSet,
  DnsRecord,
  Domain,
  DomainAvailability,
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

  listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    return this.provider.listDomains(opts);
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

  getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    return this.provider.getNameservers(normalizeDomain(domainName), opts);
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
}

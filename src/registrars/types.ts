import type {
  Domain,
  DomainAvailability,
  DomainPricing,
  RegisterDomainParams,
  RenewDomainParams,
  RequestOptions,
  TransferDomainParams,
} from '../types.js';

// The contract every registrar backend implements. `RegistrarClient` delegates
// to whichever provider it was constructed with. Providers implement only the
// capabilities their API supports; unsupported operations throw
// `NotImplementedError` (the default in `BaseRegistrar`).
export interface RegistrarProvider {
  // a short identifier for the provider, e.g. "namecheap"
  readonly name: string;

  // check whether one or more domains are available to register
  checkAvailability(domains: string[], opts?: RequestOptions): Promise<DomainAvailability[]>;

  // get pricing for a domain (register/renew/transfer)
  getPricing(domain: string, opts?: RequestOptions): Promise<DomainPricing>;

  // list domains in the account
  listDomains(opts?: RequestOptions): Promise<Domain[]>;

  // get details for a single domain
  getDomain(domain: string, opts?: RequestOptions): Promise<Domain>;

  // register a new domain
  registerDomain(params: RegisterDomainParams, opts?: RequestOptions): Promise<Domain>;

  // renew an existing domain
  renewDomain(params: RenewDomainParams, opts?: RequestOptions): Promise<Domain>;

  // transfer a domain into the account
  transferDomain(params: TransferDomainParams, opts?: RequestOptions): Promise<Domain>;

  // replace the nameservers for a domain
  setNameservers(domain: string, nameservers: string[], opts?: RequestOptions): Promise<Domain>;

  // enable or disable auto-renew for a domain
  setAutoRenew(domain: string, enabled: boolean, opts?: RequestOptions): Promise<Domain>;

  // lock or unlock a domain against transfers
  setLock(domain: string, locked: boolean, opts?: RequestOptions): Promise<Domain>;
}

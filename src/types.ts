// Shared, provider-agnostic types for the registrar client.

import type { RegistrarFeature } from './features';

// client-level request options
export interface RegistrarClientOptions {
  // request timeout in milliseconds
  timeout: number;
  // number of retry attempts for retryable errors
  retries: number;
  // base delay for exponential backoff, in milliseconds
  backoff: number;
  // optional AbortSignal to cancel in-flight requests
  signal?: AbortSignal;
}

// per-request options that can override client-level options
export type RequestOptions = Partial<RegistrarClientOptions>;

// options for `listDomains`. Extends `RequestOptions` so timeout/retries/signal
// still flow through a single argument. `listDomains` always returns the full
// account, paginating internally at each provider's maximum page size.
export interface ListDomainsOptions extends RequestOptions {
  // case-insensitive substring to match against the domain name. Applied
  // server-side where the API supports it (Namecheap `SearchTerm`, Gandi
  // `fqdn`) and client-side otherwise.
  search?: string;
}

// which API environment a provider targets. "sandbox" covers registrar test
// environments (GoDaddy calls theirs "OTE") so integration tests never touch
// real domains. Requesting "sandbox" on a provider without one throws.
export type RegistrarEnvironment = 'production' | 'sandbox';

// options passed when constructing a registrar provider
export interface RegistrarOptions extends Partial<RegistrarClientOptions> {
  environment?: RegistrarEnvironment;
}

// result of a connection/credential test
export interface ConnectionResult {
  success: boolean;
  message: string;
}

// result of a mutating operation (renew, nameserver update, lock/unlock)
export interface OperationResult {
  success: boolean;
  message: string;
}

// a configuration field a registrar needs (used to build credential UIs generically)
export interface ConfigField {
  // property name on the credentials object
  name: string;
  // human-readable label
  label: string;
  // input type
  type: 'text' | 'password' | 'select';
  // whether the field is required
  required: boolean;
  // allowed values for `select` fields
  options?: string[];
  // default value
  default?: string;
}

// normalized, cross-registrar view of a domain
export interface Domain {
  domainName: string;
  // id of the registrar that owns this record, e.g. "cloudflare"
  registrar: string;
  // registry/registrar status, always lowercased
  status: string;
  createdDate: Date | null;
  expirationDate: Date | null;
  renewalDate: Date | null;
  autoRenew: boolean;
  locked: boolean;
  privacy: boolean;
  nameservers: string[];
  // when this record was fetched
  syncedAt: Date;
  // whether the domain has been removed at the registrar
  deleted: boolean;
}

// loose input accepted by `createDomain`; providers pass raw-ish API values
export interface DomainInput {
  domainName?: string;
  registrar?: string;
  status?: string;
  createdDate?: Date | string | number | null;
  expirationDate?: Date | string | number | null;
  renewalDate?: Date | string | number | null;
  autoRenew?: boolean;
  locked?: boolean;
  privacy?: boolean;
  // accepts string[], objects with a `hosts` array, or objects with ServerName
  nameservers?: unknown;
  syncedAt?: Date;
  deleted?: boolean;
}

// A normalized registrant/admin/tech/billing contact, mapped to and from each
// registrar's own contact shape.
export interface Contact {
  firstName: string;
  lastName: string;
  organization?: string;
  email: string;
  // international phone format, e.g. "+1.4805551234"
  phone: string;
  fax?: string;
  address1: string;
  address2?: string;
  city: string;
  // state / province / region; may be empty where the country has none
  state?: string;
  postalCode: string;
  // ISO 3166-1 alpha-2 country code, e.g. "US"
  country: string;
}

// The set of contacts on a domain. `registrant` is the legal owner; most
// registrars also track admin, tech, and billing roles (often the same person).
export interface ContactSet {
  registrant?: Contact;
  admin?: Contact;
  tech?: Contact;
  billing?: Contact;
}

// A single DNS record in provider-agnostic form.
export interface DnsRecord {
  // record type, uppercased: "A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", …
  type: string;
  // host/subdomain relative to the zone apex; "@" denotes the apex
  name: string;
  // record data / value (target host, IP address, text, etc.)
  value: string;
  // time-to-live in seconds
  ttl?: number;
  // priority, for MX and SRV records
  priority?: number;
  // SRV-only fields
  weight?: number;
  port?: number;
}

// Result of an availability check for a single domain.
export interface DomainAvailability {
  domainName: string;
  available: boolean;
  // whether the name is a premium/aftermarket registration
  premium?: boolean;
  // registration price in major currency units (e.g. 11.99), when the API reports it
  price?: number;
  // ISO 4217 currency code, e.g. "USD"
  currency?: string;
  // the registration period the price covers, in years
  period?: number;
}

// Pricing for a TLD (or a specific domain), in major currency units. Fields are
// optional because not every registrar exposes all three price points.
export interface TldPricing {
  // the TLD the prices apply to, without a leading dot, e.g. "com"
  tld: string;
  // ISO 4217 currency code, e.g. "USD"
  currency: string;
  registration?: number;
  renewal?: number;
  transfer?: number;
}

// Consent to a registrar's registration agreements, supplied per registration.
// Registering a domain forms a legal contract with the registry, so providers
// that require it reject `registerDomain` without this. The provider fetches the
// specific per-TLD agreement documents itself; the caller only affirms who is
// consenting (and optionally when).
export interface RegistrationConsent {
  // identifier of the consenting party. Registrars that record an "agreed by"
  // value expect the consenting user's IP address here (e.g. GoDaddy).
  agreedBy: string;
  // ISO 8601 timestamp of when consent was given; defaults to the current time.
  agreedAt?: string;
}

// Input for transferring a domain in. `authCode` (the EPP/auth code from the
// losing registrar) is always required; the rest mirror registration and are
// used by the registrars that need them (GoDaddy/Spaceship want contacts +
// consent, Namecheap/Dynadot rely on account defaults and just need the code).
export interface TransferDomainInput {
  // the EPP / authorization code obtained from the current registrar
  authCode: string;
  // registration length to add as part of the transfer, in years
  years?: number;
  // contacts for the transferred domain, where the registrar requires them
  contacts?: ContactSet;
  // consent to the registrar's transfer agreements, where required (e.g. GoDaddy)
  consent?: RegistrationConsent;
  // enable WHOIS privacy on transfer, where supported
  privacy?: boolean;
  // enable auto-renew on transfer
  autoRenew?: boolean;
}

// Input for registering a new domain.
export interface RegisterDomainInput {
  // registration length in years (defaults to 1)
  years?: number;
  // contacts for the registration; every registrar requires at least a registrant
  contacts: ContactSet;
  // initial nameservers; omitting them uses the registrar's defaults
  nameservers?: string[];
  // enable WHOIS privacy at registration, where supported
  privacy?: boolean;
  // enable auto-renew at registration
  autoRenew?: boolean;
  // consent to the registrar's registration agreements; required by providers
  // that gate registration behind an explicit legal agreement (e.g. GoDaddy).
  // Omitting it where required throws `ConsentRequiredError`.
  consent?: RegistrationConsent;
}

// credentials for a registrar, as a flat string map keyed by `ConfigField.name`
export type RegistrarCredentials = Record<string, string>;

// --- extended-feature payloads ---

// An alias-style email forward: mail sent to `alias`@domain is redirected to
// `forwardTo`. This is redirect-only forwarding — no real mailbox is provisioned
// (see the ProvisionMailbox feature for that).
export interface EmailForward {
  // the local part of the source address at the domain, e.g. "hello" for
  // hello@example.com. Where the registrar supports it, "@" or "*" denotes a
  // catch-all.
  alias: string;
  // the destination address mail is forwarded to
  forwardTo: string;
}

// The redirect style for a DomainForward:
//   - "redirect"  temporary (302) redirect; the destination URL shows in the bar
//   - "permanent" permanent (301) redirect; the destination URL shows in the bar
//   - "frame"     masked/framed redirect; the source URL stays in the bar
export type DomainForwardType = 'redirect' | 'permanent' | 'frame';

// A URL/domain forwarding rule: requests to `host` at the domain are redirected
// to `url`.
export interface DomainForward {
  // the source host at the domain, relative to the apex; "@" denotes the apex,
  // "www" the www subdomain, etc.
  host: string;
  // the destination URL requests are forwarded to
  url: string;
  // the redirect style
  type: DomainForwardType;
}

// The core interface every registrar implementation fulfils. `BaseRegistrar`
// (src/registrar.ts) provides the shared plumbing and `NotImplementedError`
// defaults; concrete providers under src/registrars/ extend it.
export interface Registrar {
  // a short identifier for the provider, e.g. "cloudflare"
  readonly name: string;

  // the API environment this instance targets
  readonly environment: RegistrarEnvironment;

  // the capabilities this provider supports (core contract + its extended features)
  readonly features: readonly RegistrarFeature[];

  // whether this provider supports a given capability
  supports(feature: RegistrarFeature): boolean;

  // verify the configured credentials work
  testConnection(opts?: RequestOptions): Promise<ConnectionResult>;

  // list domains in the account (capped and optionally filtered via `opts`)
  listDomains(opts?: ListDomainsOptions): Promise<Domain[]>;

  // fetch a single domain's details
  getDomain(domainName: string, opts?: RequestOptions): Promise<Domain>;

  // check whether one or more domains are available to register
  checkAvailability(domainNames: string[], opts?: RequestOptions): Promise<DomainAvailability[]>;

  // look up pricing for a TLD (or a specific domain)
  getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing>;

  // register a new domain
  registerDomain(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult>;

  // renew a domain for `years` years
  renewDomain(domainName: string, years?: number, opts?: RequestOptions): Promise<OperationResult>;

  // toggle auto-renew for a domain
  setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult>;

  // transfer a domain into the account using its auth/EPP code (+ any contacts /
  // consent the registrar requires, via `TransferDomainInput`)
  transferIn(
    domainName: string,
    input: TransferDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult>;

  // replace the nameservers for a domain
  updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult>;

  // read the nameservers currently set on a domain
  getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]>;

  // lock a domain against transfers
  lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult>;

  // unlock a domain
  unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult>;

  // toggle WHOIS privacy for a domain
  setPrivacy(domainName: string, enabled: boolean, opts?: RequestOptions): Promise<OperationResult>;

  // read the registrant/admin/tech/billing contacts for a domain
  getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet>;

  // update the contacts for a domain
  updateContacts(
    domainName: string,
    contacts: ContactSet,
    opts?: RequestOptions
  ): Promise<OperationResult>;

  // read the DNS records for a domain
  getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]>;

  // replace the DNS records for a domain
  setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult>;

  // --- extended capabilities ---
  //
  // Opt-in operations beyond the core contract. A provider genuinely supports one
  // only if it declares the matching Feature (see `features`/`supports`); every
  // other provider inherits BaseRegistrar's default, which rejects with
  // NotImplementedError. Callers should gate on `supports(...)` before use.

  // read the alias-style email forwarding rules for a domain
  getEmailForwarding(domainName: string, opts?: RequestOptions): Promise<EmailForward[]>;

  // replace the alias-style email forwarding rules for a domain (full replace: any
  // rule not included is removed; an empty array clears all forwarding)
  setEmailForwarding(
    domainName: string,
    forwards: EmailForward[],
    opts?: RequestOptions
  ): Promise<OperationResult>;

  // read the URL/domain forwarding rules for a domain
  getDomainForwarding(domainName: string, opts?: RequestOptions): Promise<DomainForward[]>;

  // replace the URL/domain forwarding rules for a domain (full replace: any rule
  // not included is removed; an empty array clears all forwarding)
  setDomainForwarding(
    domainName: string,
    forwards: DomainForward[],
    opts?: RequestOptions
  ): Promise<OperationResult>;
}

// static side of a registrar class: the constructor plus discovery metadata
// (display name, the credential fields it needs, where to get them, and whether
// it offers a sandbox/test environment).
export interface RegistrarConstructor {
  new (credentials: RegistrarCredentials, options?: RegistrarOptions): Registrar;
  readonly displayName: string;
  readonly configFields: ConfigField[];
  readonly helpText: string;
  readonly supportsSandbox: boolean;
  // extended capabilities this provider opts into, beyond the core contract
  readonly extendedFeatures: readonly RegistrarFeature[];
  // the full capability set: the core contract plus `extendedFeatures`
  readonly features: readonly RegistrarFeature[];
}

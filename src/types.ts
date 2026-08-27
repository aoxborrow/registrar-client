// Shared, provider-agnostic types for the registrar client.
//
// These describe the *common* shape the client exposes to callers. Individual
// registrar providers map their own API payloads onto these types. They are
// intentionally minimal for now and will grow as concrete providers land.

// client-level options
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

// a domain availability check result
export interface DomainAvailability {
  domain: string;
  available: boolean;
  // whether the domain is a premium registration, if known
  premium?: boolean;
  // raw provider payload for escape-hatch access
  raw?: unknown;
}

// pricing for a registrar operation (register/renew/transfer), per period
export interface DomainPricing {
  domain: string;
  // ISO 4217 currency code, e.g. "USD"
  currency: string;
  // registration price for `years`, if quoted
  registration?: number;
  renewal?: number;
  transfer?: number;
  // number of years the quote covers
  years?: number;
  raw?: unknown;
}

// a registrant/admin/tech/billing contact
export interface Contact {
  firstName?: string;
  lastName?: string;
  organization?: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

// the set of contacts attached to a domain
export interface DomainContacts {
  registrant?: Contact;
  admin?: Contact;
  tech?: Contact;
  billing?: Contact;
}

// registered domain details
export interface Domain {
  domain: string;
  status?: string[];
  nameservers?: string[];
  contacts?: DomainContacts;
  autoRenew?: boolean;
  locked?: boolean;
  createdAt?: string;
  expiresAt?: string;
  raw?: unknown;
}

// parameters for registering a new domain
export interface RegisterDomainParams {
  domain: string;
  years?: number;
  nameservers?: string[];
  contacts?: DomainContacts;
  autoRenew?: boolean;
  // additional provider-specific fields
  extra?: Record<string, unknown>;
}

// parameters for renewing a domain
export interface RenewDomainParams {
  domain: string;
  years?: number;
  extra?: Record<string, unknown>;
}

// parameters for transferring a domain in
export interface TransferDomainParams {
  domain: string;
  authCode: string;
  years?: number;
  nameservers?: string[];
  contacts?: DomainContacts;
  extra?: Record<string, unknown>;
}

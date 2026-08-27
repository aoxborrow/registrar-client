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

// credentials for a registrar, as a flat string map keyed by `ConfigField.name`
export type RegistrarCredentials = Record<string, string>;

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

  // list all domains in the account
  listDomains(opts?: RequestOptions): Promise<Domain[]>;

  // renew a domain for `years` years
  renewDomain(domainName: string, years?: number, opts?: RequestOptions): Promise<OperationResult>;

  // replace the nameservers for a domain
  updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult>;

  // lock a domain against transfers
  lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult>;

  // unlock a domain
  unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult>;
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

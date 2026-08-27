// Shared, provider-agnostic types for the registrar client.

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

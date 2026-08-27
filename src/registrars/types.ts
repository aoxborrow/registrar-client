import type {
  ConfigField,
  ConnectionResult,
  Domain,
  OperationResult,
  RegistrarClientOptions,
  RequestOptions,
} from '../types.js';

// credentials for a registrar, as a flat string map keyed by `ConfigField.name`
export type RegistrarCredentials = Record<string, string>;

// The contract every registrar backend implements. Ported from the prior-project
// project's BaseRegistrar surface, minus the platform-specific
// credential storage (credentials are passed to the constructor here).
export interface RegistrarProvider {
  // a short identifier for the provider, e.g. "cloudflare"
  readonly name: string;

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
// (display name, the credential fields it needs, and where to get them).
export interface RegistrarConstructor {
  new (
    credentials: RegistrarCredentials,
    options?: Partial<RegistrarClientOptions>
  ): RegistrarProvider;
  readonly displayName: string;
  readonly configFields: ConfigField[];
  readonly helpText: string;
}

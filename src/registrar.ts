import { DEFAULT_OPTIONS } from './constants';
import { ConfigurationError, NotImplementedError } from './errors';
import { HttpClient, type HttpClientConfig } from './http';
import { CORE_FEATURES, type RegistrarFeature } from './features';
import type {
  ConnectionResult,
  ContactSet,
  DnsRecord,
  Domain,
  DomainAvailability,
  OperationResult,
  Registrar,
  RegisterDomainInput,
  RegistrarClientOptions,
  RegistrarCredentials,
  RegistrarEnvironment,
  RegistrarOptions,
  RequestOptions,
  TldPricing,
} from './types';

// pick the base URL for the requested environment. Throws if `sandbox` is
// requested but the provider defines no sandbox URL — so integration tests
// fail loudly rather than silently hitting production.
export function selectBaseUrl(
  registrar: string,
  environment: RegistrarEnvironment | undefined,
  urls: { production: string; sandbox?: string }
): string {
  if (environment === 'sandbox') {
    if (!urls.sandbox) {
      throw new ConfigurationError(`${registrar} does not provide a sandbox environment`);
    }
    return urls.sandbox;
  }
  return urls.production;
}

// Abstract base for registrar providers. Owns the shared HTTP/auth/retry
// plumbing (via `HttpClient`) and provides `NotImplementedError`-rejecting
// defaults for every operation. Concrete providers extend this, build their
// base URL + auth from the credentials passed to `super()`, and override the
// operations their API supports.
export abstract class BaseRegistrar implements Registrar {
  abstract readonly name: string;

  protected http: HttpClient;
  protected credentials: RegistrarCredentials;
  protected options: RegistrarClientOptions;
  readonly environment: RegistrarEnvironment;

  // Extended capabilities this provider opts into, beyond the core contract.
  // Subclasses override this; core features are inherited and not re-declared.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [];

  // The provider's full capability set: the core contract plus its extended
  // features. Available statically (no instance/credentials needed) for catalog
  // UIs and MCP tooling.
  static get features(): readonly RegistrarFeature[] {
    return [...CORE_FEATURES, ...this.extendedFeatures];
  }

  // instance mirror of the static `features`
  get features(): readonly RegistrarFeature[] {
    return (this.constructor as typeof BaseRegistrar).features;
  }

  // whether this provider supports a given capability
  supports(feature: RegistrarFeature): boolean {
    return this.features.includes(feature);
  }

  constructor(
    credentials: RegistrarCredentials,
    httpConfig: Omit<HttpClientConfig, 'options'>,
    options?: RegistrarOptions
  ) {
    const { environment = 'production', ...clientOptions } = options ?? {};
    this.credentials = credentials;
    this.environment = environment;
    this.options = { ...DEFAULT_OPTIONS, ...clientOptions };
    this.http = new HttpClient({ ...httpConfig, options: this.options });
  }

  testConnection(_opts?: RequestOptions): Promise<ConnectionResult> {
    return Promise.reject(
      new NotImplementedError(`${this.name}: testConnection is not implemented`)
    );
  }

  listDomains(_opts?: RequestOptions): Promise<Domain[]> {
    return Promise.reject(new NotImplementedError(`${this.name}: listDomains is not implemented`));
  }

  renewDomain(
    _domainName: string,
    _years?: number,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(new NotImplementedError(`${this.name}: renewDomain is not implemented`));
  }

  updateNameservers(
    _domainName: string,
    _nameservers: string[],
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(`${this.name}: updateNameservers is not implemented`)
    );
  }

  lockDomain(_domainName: string, _opts?: RequestOptions): Promise<OperationResult> {
    return Promise.reject(new NotImplementedError(`${this.name}: lockDomain is not implemented`));
  }

  unlockDomain(_domainName: string, _opts?: RequestOptions): Promise<OperationResult> {
    return Promise.reject(new NotImplementedError(`${this.name}: unlockDomain is not implemented`));
  }

  getDomain(_domainName: string, _opts?: RequestOptions): Promise<Domain> {
    return this.notImplemented('getDomain');
  }

  checkAvailability(_domainNames: string[], _opts?: RequestOptions): Promise<DomainAvailability[]> {
    return this.notImplemented('checkAvailability');
  }

  getPricing(_tldOrDomain: string, _opts?: RequestOptions): Promise<TldPricing> {
    return this.notImplemented('getPricing');
  }

  registerDomain(
    _domainName: string,
    _input: RegisterDomainInput,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.notImplemented('registerDomain');
  }

  setAutoRenew(
    _domainName: string,
    _enabled: boolean,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.notImplemented('setAutoRenew');
  }

  transferIn(
    _domainName: string,
    _authCode: string,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.notImplemented('transferIn');
  }

  getNameservers(_domainName: string, _opts?: RequestOptions): Promise<string[]> {
    return this.notImplemented('getNameservers');
  }

  setPrivacy(
    _domainName: string,
    _enabled: boolean,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.notImplemented('setPrivacy');
  }

  getContacts(_domainName: string, _opts?: RequestOptions): Promise<ContactSet> {
    return this.notImplemented('getContacts');
  }

  updateContacts(
    _domainName: string,
    _contacts: ContactSet,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.notImplemented('updateContacts');
  }

  getDnsRecords(_domainName: string, _opts?: RequestOptions): Promise<DnsRecord[]> {
    return this.notImplemented('getDnsRecords');
  }

  setDnsRecords(
    _domainName: string,
    _records: DnsRecord[],
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.notImplemented('setDnsRecords');
  }

  // shared rejection for a capability a provider hasn't wired up yet
  protected notImplemented(method: string): Promise<never> {
    return Promise.reject(new NotImplementedError(`${this.name}: ${method} is not implemented`));
  }
}

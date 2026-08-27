import { HttpClient, type HttpClientConfig } from '../http.js';
import { NotImplementedError } from '../errors.js';
import type {
  Domain,
  DomainAvailability,
  DomainPricing,
  RegisterDomainParams,
  RenewDomainParams,
  RequestOptions,
  TransferDomainParams,
} from '../types.js';
import type { RegistrarProvider } from './types.js';

// Base class for registrar providers. Owns the shared HTTP/auth/retry plumbing
// via an `HttpClient`, and provides `NotImplementedError`-throwing defaults for
// every operation. Concrete providers extend this and override the operations
// their API supports, mapping payloads to/from the shared types.
export abstract class BaseRegistrar implements RegistrarProvider {
  abstract readonly name: string;

  protected http: HttpClient;

  constructor(config: HttpClientConfig) {
    this.http = new HttpClient(config);
  }

  checkAvailability(_domains: string[], _opts?: RequestOptions): Promise<DomainAvailability[]> {
    return Promise.reject(
      new NotImplementedError(`${this.name}: checkAvailability is not implemented`)
    );
  }

  getPricing(_domain: string, _opts?: RequestOptions): Promise<DomainPricing> {
    return Promise.reject(new NotImplementedError(`${this.name}: getPricing is not implemented`));
  }

  listDomains(_opts?: RequestOptions): Promise<Domain[]> {
    return Promise.reject(new NotImplementedError(`${this.name}: listDomains is not implemented`));
  }

  getDomain(_domain: string, _opts?: RequestOptions): Promise<Domain> {
    return Promise.reject(new NotImplementedError(`${this.name}: getDomain is not implemented`));
  }

  registerDomain(_params: RegisterDomainParams, _opts?: RequestOptions): Promise<Domain> {
    return Promise.reject(
      new NotImplementedError(`${this.name}: registerDomain is not implemented`)
    );
  }

  renewDomain(_params: RenewDomainParams, _opts?: RequestOptions): Promise<Domain> {
    return Promise.reject(new NotImplementedError(`${this.name}: renewDomain is not implemented`));
  }

  transferDomain(_params: TransferDomainParams, _opts?: RequestOptions): Promise<Domain> {
    return Promise.reject(
      new NotImplementedError(`${this.name}: transferDomain is not implemented`)
    );
  }

  setNameservers(_domain: string, _nameservers: string[], _opts?: RequestOptions): Promise<Domain> {
    return Promise.reject(
      new NotImplementedError(`${this.name}: setNameservers is not implemented`)
    );
  }

  setAutoRenew(_domain: string, _enabled: boolean, _opts?: RequestOptions): Promise<Domain> {
    return Promise.reject(new NotImplementedError(`${this.name}: setAutoRenew is not implemented`));
  }

  setLock(_domain: string, _locked: boolean, _opts?: RequestOptions): Promise<Domain> {
    return Promise.reject(new NotImplementedError(`${this.name}: setLock is not implemented`));
  }
}

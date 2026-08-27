import { DEFAULT_OPTIONS } from '../constants.js';
import { NotImplementedError } from '../errors.js';
import { HttpClient, type HttpClientConfig } from '../http.js';
import type {
  ConnectionResult,
  Domain,
  OperationResult,
  RegistrarClientOptions,
  RequestOptions,
} from '../types.js';
import type { RegistrarCredentials, RegistrarProvider } from './types.js';

// Abstract base for registrar providers. Owns the shared HTTP/auth/retry
// plumbing (via `HttpClient`) and provides `NotImplementedError`-rejecting
// defaults for every operation. Concrete providers extend this, build their
// base URL + auth from the credentials passed to `super()`, and override the
// operations their API supports.
export abstract class BaseRegistrar implements RegistrarProvider {
  abstract readonly name: string;

  protected http: HttpClient;
  protected credentials: RegistrarCredentials;
  protected options: RegistrarClientOptions;

  constructor(
    credentials: RegistrarCredentials,
    httpConfig: Omit<HttpClientConfig, 'options'>,
    options?: Partial<RegistrarClientOptions>
  ) {
    this.credentials = credentials;
    this.options = { ...DEFAULT_OPTIONS, ...options };
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
}

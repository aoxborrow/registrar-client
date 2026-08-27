import type {
  ConfigField,
  ConnectionResult,
  Domain,
  OperationResult,
  RegistrarClientOptions,
  RequestOptions,
} from '../types.js';
import { createDomain, sleep } from '../utils.js';
import { toRegistrarError } from '../errors.js';
import { BaseRegistrar } from './base.js';
import type { RegistrarCredentials } from './types.js';

interface SpaceshipDomain {
  name: string;
  status?: string;
  registrationDate?: string;
  expirationDate?: string;
  autoRenew?: boolean;
  transferLock?: boolean;
  privacyProtection?: { enabled?: boolean };
  nameservers?: string[];
}

interface SpaceshipList {
  items?: SpaceshipDomain[];
}

/**
 * Spaceship Registrar
 * API docs: https://docs.spaceship.dev/
 *
 * Credentials: generate an API key + secret in the Spaceship API Manager
 * ("New API key"). Both are sent as X-API-Key and X-API-Secret headers.
 */
export class SpaceshipRegistrar extends BaseRegistrar {
  readonly name = 'spaceship';

  static readonly displayName = 'Spaceship';
  static readonly helpText =
    'Generate your API key and secret in the API Manager at Spaceship using the ' +
    '"New API key" button. The API requires both X-API-Key and X-API-Secret headers.';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', required: true },
  ];

  constructor(credentials: RegistrarCredentials, options?: Partial<RegistrarClientOptions>) {
    super(
      credentials,
      {
        baseUrl: 'https://spaceship.dev/api',
        headers: {
          'X-API-Key': credentials.apiKey,
          'X-API-Secret': credentials.apiSecret,
          'Content-Type': 'application/json',
        },
      },
      options
    );
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      await this.http.request<SpaceshipList>({
        path: '/v1/domains',
        query: { take: 1, skip: 0 },
        ...opts,
      });
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: RequestOptions): Promise<Domain[]> {
    const domains: Domain[] = [];
    const take = 100; // max items per request (1-100)
    let skip = 0;
    let hasMore = true;

    while (hasMore) {
      const res = await this.http.request<SpaceshipList>({
        path: '/v1/domains',
        query: { take, skip },
        ...opts,
      });
      const list = res.items ?? [];
      for (const d of list) {
        domains.push(
          createDomain({
            domainName: d.name,
            registrar: this.name,
            status: d.status ?? '',
            createdDate: d.registrationDate,
            expirationDate: d.expirationDate,
            renewalDate: d.expirationDate,
            autoRenew: d.autoRenew ?? false,
            locked: d.transferLock ?? false,
            privacy: d.privacyProtection?.enabled ?? false,
            nameservers: d.nameservers ?? [],
          })
        );
      }
      hasMore = list.length === take;
      skip += take;
      if (hasMore) await sleep(200); // gentle rate limiting between pages
    }
    return domains;
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'POST',
        path: `/v1/domains/${encodeURIComponent(domainName)}/renewal`,
        body: { years },
      },
      'Domain renewal requested successfully',
      opts
    );
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PUT',
        path: `/v1/domains/${encodeURIComponent(domainName)}/nameservers`,
        body: { nameservers },
      },
      'Nameservers updated successfully',
      opts
    );
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PUT',
        path: `/v1/domains/${encodeURIComponent(domainName)}/transfer-lock`,
        body: { transferLock: true },
      },
      'Domain transfer lock enabled successfully',
      opts
    );
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PUT',
        path: `/v1/domains/${encodeURIComponent(domainName)}/transfer-lock`,
        body: { transferLock: false },
      },
      'Domain transfer lock disabled successfully',
      opts
    );
  }

  // run a mutating request; Spaceship returns success as a 2xx with no meaningful body
  private async mutate(
    req: { method: string; path: string; body?: unknown },
    successMessage: string,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      await this.http.request({ ...req, ...opts });
      return { success: true, message: successMessage };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }
}

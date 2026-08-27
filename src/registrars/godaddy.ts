import type {
  ConfigField,
  ConnectionResult,
  Domain,
  OperationResult,
  RegistrarOptions,
  RequestOptions,
} from '../types.js';
import { createDomain } from '../utils.js';
import { toRegistrarError } from '../errors.js';
import { BaseRegistrar, selectBaseUrl } from './base.js';
import type { RegistrarCredentials } from './types.js';

interface GoDaddyDomain {
  domain: string;
  status?: string;
  createdAt?: string;
  expires?: string;
  renewDeadline?: string;
  renewAuto?: boolean;
  locked?: boolean;
  privacy?: boolean;
  nameServers?: string[];
}

/**
 * GoDaddy Registrar
 * API docs: https://developer.godaddy.com/doc/endpoint/domains
 *
 * Credentials: create API keys under Account Settings > API Keys. Choose the
 * `production` or `ote` (test) environment to match the key you generated;
 * both the key and secret are required and sent as an `sso-key` header.
 */
export class GoDaddyRegistrar extends BaseRegistrar {
  readonly name = 'godaddy';

  static readonly displayName = 'GoDaddy';
  static readonly helpText =
    'Create API keys in your GoDaddy account under Account Settings > API Keys. ' +
    'You can create production keys or OTE (test environment) keys. Save both the ' +
    'API Key and Secret when generated. Pass { environment: "sandbox" } to target ' +
    'the OTE test environment (use OTE keys with it).';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', required: true },
  ];
  // GoDaddy's OTE ("Operational Test Environment") is its sandbox
  static readonly supportsSandbox = true;

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('GoDaddy', options?.environment, {
          production: 'https://api.godaddy.com/v1',
          sandbox: 'https://api.ote-godaddy.com/v1',
        }),
        headers: {
          'Authorization': `sso-key ${credentials.apiKey}:${credentials.apiSecret}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      },
      options
    );
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      await this.http.request<GoDaddyDomain[]>({ path: '/domains', ...opts });
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: RequestOptions): Promise<Domain[]> {
    // status filters exclude expired domains: visible (active), renewable
    // (expiring soon), redemption (grace period). statusGroups repeats in the
    // query string, so it is embedded in the path directly.
    const res = await this.http.request<GoDaddyDomain[]>({
      path: '/domains?limit=1000&statusGroups=VISIBLE&statusGroups=RENEWABLE&statusGroups=REDEMPTION',
      ...opts,
    });
    return (res ?? []).map(d =>
      createDomain({
        domainName: d.domain,
        registrar: this.name,
        status: d.status,
        createdDate: d.createdAt,
        expirationDate: d.expires,
        renewalDate: d.renewDeadline,
        autoRenew: d.renewAuto ?? false,
        locked: d.locked ?? false,
        privacy: d.privacy ?? false,
        nameservers: d.nameServers ?? [],
      })
    );
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      { method: 'POST', path: `/domains/${domainName}/renew`, body: { period: years } },
      'Domain renewed successfully',
      opts
    );
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 1 || nameservers.length > 13) {
      throw new Error('GoDaddy requires 1-13 nameservers');
    }
    return this.mutate(
      { method: 'PATCH', path: `/domains/${domainName}`, body: { nameServers: nameservers } },
      'Nameservers updated successfully',
      opts
    );
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      { method: 'PATCH', path: `/domains/${domainName}`, body: { locked: true } },
      'Domain locked successfully',
      opts
    );
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      { method: 'PATCH', path: `/domains/${domainName}`, body: { locked: false } },
      'Domain unlocked successfully',
      opts
    );
  }

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

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

// Cloudflare's standard response envelope
interface CfEnvelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

// a domain object from the Cloudflare Registrar API
interface CfDomain {
  id: string;
  name: string;
  status?: string;
  created_at?: string;
  expires_at?: string;
  auto_renew?: boolean;
  locked?: boolean;
  name_servers?: string[];
}

/**
 * Cloudflare Registrar
 * API docs: https://developers.cloudflare.com/api/resources/registrar/
 *
 * Credentials: create an API token under My Profile > API Tokens with
 * "Account.Registrar" read/write permission. The Account ID is shown on the
 * Overview page of any zone (and in the dashboard URL).
 *
 * Note: Cloudflare Registrar is at-cost and does not support new registrations
 * or transfers-in via API; this provider manages existing domains only.
 */
export class CloudflareRegistrar extends BaseRegistrar {
  readonly name = 'cloudflare';

  static readonly displayName = 'Cloudflare';
  static readonly helpText =
    'Create an API token in your Cloudflare dashboard under My Profile > API Tokens. ' +
    'The token needs "Account.Registrar" read/write permissions. Find your Account ID ' +
    'in the URL or on the Overview page of any zone.';
  static readonly configFields: ConfigField[] = [
    { name: 'apiToken', label: 'API Token', type: 'password', required: true },
    { name: 'accountId', label: 'Account ID', type: 'text', required: true },
  ];
  static readonly supportsSandbox = false; // Cloudflare Registrar has no test environment

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('Cloudflare', options?.environment, {
          production: 'https://api.cloudflare.com/client/v4',
        }),
        headers: {
          'Authorization': `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
        },
      },
      options
    );
  }

  private get accountPath(): string {
    return `/accounts/${this.credentials.accountId}/registrar/domains`;
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      const res = await this.http.request<CfEnvelope<CfDomain[]>>({
        path: this.accountPath,
        ...opts,
      });
      return res.success
        ? { success: true, message: 'Connection successful' }
        : { success: false, message: res.errors?.[0]?.message ?? 'Request failed' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: RequestOptions): Promise<Domain[]> {
    const domains: Domain[] = [];
    const perPage = 200; // Cloudflare API maximum page size
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const res = await this.http.request<CfEnvelope<CfDomain[]>>({
        path: this.accountPath,
        query: { per_page: perPage, page },
        ...opts,
      });
      if (!res.success) {
        throw new Error(res.errors?.[0]?.message ?? 'API request failed');
      }
      const list = res.result ?? [];
      for (const d of list) {
        domains.push(
          createDomain({
            domainName: d.name,
            registrar: this.name,
            status: d.status,
            createdDate: d.created_at,
            expirationDate: d.expires_at,
            renewalDate: d.expires_at,
            autoRenew: d.auto_renew ?? false,
            locked: d.locked ?? false,
            privacy: true, // Cloudflare includes WHOIS privacy by default
            nameservers: d.name_servers ?? [],
          })
        );
      }
      hasMore = list.length === perPage;
      page++;
    }
    return domains;
  }

  override async renewDomain(
    domainName: string,
    _years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    // Cloudflare has no explicit renew endpoint; enabling auto-renew is the
    // supported way to keep a domain active.
    return this.patchDomain(domainName, { auto_renew: true, privacy: true }, opts);
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 2) {
      throw new Error('Cloudflare requires at least 2 nameservers');
    }
    return this.patchDomain(domainName, { name_servers: nameservers }, opts);
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.patchDomain(domainName, { locked: true }, opts);
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.patchDomain(domainName, { locked: false }, opts);
  }

  // look up a domain by name to obtain its Cloudflare id
  private async getDomain(domainName: string, opts?: RequestOptions): Promise<CfDomain | null> {
    const res = await this.http.request<CfEnvelope<CfDomain[]>>({
      path: this.accountPath,
      query: { name: domainName },
      ...opts,
    });
    return res.result?.find(d => d.name === domainName) ?? null;
  }

  // resolve the domain id then PUT the given fields
  private async patchDomain(
    domainName: string,
    body: Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const domain = await this.getDomain(domainName, opts);
      if (!domain) return { success: false, message: 'Domain not found' };

      const res = await this.http.request<CfEnvelope<CfDomain>>({
        method: 'PUT',
        path: `${this.accountPath}/${domain.id}`,
        body,
        ...opts,
      });
      return {
        success: res.success,
        message: res.success ? 'Domain updated successfully' : 'Failed to update domain',
      };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }
}

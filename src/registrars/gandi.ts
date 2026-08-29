import type {
  ConfigField,
  ConnectionResult,
  Domain,
  ListDomainsOptions,
  OperationResult,
  RegistrarOptions,
  RequestOptions,
} from '../types';
import { createDomain, filterDomains } from '../utils';
import { toRegistrarError } from '../errors';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import { Feature, type RegistrarFeature } from '../features';
import type { RegistrarCredentials } from '../types';

// Shape of a domain in `GET /v5/domain/domains`. `status` is an array of EPP
// statuses; `autorenew` may be a bare boolean or an object; nameservers arrive
// as `nameserver.hosts` (a fallback `nameservers` array is tolerated too).
interface GandiDomain {
  fqdn: string;
  status?: string | string[];
  dates?: {
    created_at?: string;
    registry_created_at?: string;
    registry_ends_at?: string;
    updated_at?: string;
  };
  autorenew?: boolean | { enabled?: boolean };
  contacts?: { owner?: { extra_parameters?: { whois_privacy?: string } } };
  nameserver?: { current?: string; hosts?: string[] };
  nameservers?: string[];
}

/**
 * Gandi.net Registrar
 * API docs: https://api.gandi.net/docs/
 *
 * Credentials: generate an API key under Account Settings > Security >
 * "Produce a new API key". The key must have domain management permissions.
 * It is sent as an `Apikey` Authorization header.
 */
export class GandiRegistrar extends BaseRegistrar {
  readonly name = 'gandi';

  static readonly displayName = 'Gandi.net';
  static readonly helpText =
    'Generate an API key in your Gandi account under Account Settings > Security > ' +
    '"Produce a new API key". The key needs permission to manage domains.';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
  ];
  // Gandi's v5 API offers a sandbox at api.sandbox.gandi.net (separate account)
  static readonly supportsSandbox = true;
  // Rich API on top of core: DNSSEC and glue records (LiveDNS), real hosted
  // mailboxes plus forwarding. Note core `setPrivacy` is automatic/GDPR-driven
  // on Gandi rather than a clean toggle — the method treats an already-correct
  // state as idempotent success.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.GetAuthCode,
    Feature.ConfigureDnssec,
    Feature.GetGlueRecords,
    Feature.SetGlueRecords,
    Feature.ProvisionMailbox,
    Feature.SetEmailForwarding,
  ];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('Gandi', options?.environment, {
          production: 'https://api.gandi.net/v5',
          sandbox: 'https://api.sandbox.gandi.net/v5',
        }),
        headers: {
          'Authorization': `Apikey ${credentials.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
      options
    );
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      await this.http.request<GandiDomain[]>({ path: '/domain/domains', ...opts });
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const { search, ...reqOpts } = opts ?? {};
    const domains: Domain[] = [];
    const perPage = 1000; // Gandi API maximum page size
    // Gandi's `fqdn` filter is server-side and supports wildcards, so a plain
    // substring search is wrapped in `*...*`.
    const term = search?.trim();
    const fqdn = term ? `*${term}*` : undefined;
    let page = 1;

    for (;;) {
      const list = await this.http.request<GandiDomain[]>({
        path: '/domain/domains',
        query: { per_page: perPage, page, ...(fqdn ? { fqdn } : {}) },
        ...reqOpts,
      });
      if (!list || list.length === 0) break;

      for (const d of list) domains.push(this.toDomain(d));

      if (list.length < perPage) break;
      page++;
    }
    return filterDomains(domains, search);
  }

  // map Gandi's list/detail domain shape into a normalized Domain, tolerating
  // the field variations documented on GandiDomain.
  private toDomain(d: GandiDomain): Domain {
    const statuses = Array.isArray(d.status) ? d.status : d.status ? [d.status] : [];
    const autoRenew =
      typeof d.autorenew === 'boolean' ? d.autorenew : (d.autorenew?.enabled ?? false);
    return createDomain({
      domainName: d.fqdn,
      registrar: this.name,
      status: statuses.join(','),
      createdDate: d.dates?.created_at ?? d.dates?.registry_created_at,
      expirationDate: d.dates?.registry_ends_at,
      renewalDate: d.dates?.updated_at,
      autoRenew,
      locked: statuses.some(s => /transferprohibited|locked/i.test(s)),
      privacy: d.contacts?.owner?.extra_parameters?.whois_privacy === 'enabled',
      nameservers: d.nameserver?.hosts ?? d.nameservers ?? [],
    });
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      { method: 'POST', path: `/domain/domains/${domainName}/renew`, body: { duration: years } },
      'Domain renewed successfully',
      opts
    );
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 1) {
      throw new Error('At least 1 nameserver is required');
    }
    return this.mutate(
      { method: 'PUT', path: `/domain/domains/${domainName}/nameservers`, body: { nameservers } },
      'Nameservers updated successfully',
      opts
    );
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      { method: 'PATCH', path: `/domain/domains/${domainName}`, body: { status: 'locked' } },
      'Domain locked successfully',
      opts
    );
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      { method: 'PATCH', path: `/domain/domains/${domainName}`, body: { status: 'active' } },
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

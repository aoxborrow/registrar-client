import type {
  ConfigField,
  ConnectionResult,
  Domain,
  OperationResult,
  RegistrarOptions,
  RequestOptions,
} from '../types';
import { createDomain, sleep } from '../utils';
import { toRegistrarError } from '../errors';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import { Feature, type RegistrarFeature } from '../features';
import type { RegistrarCredentials } from '../types';

interface DynadotDomainInfo {
  Name?: string;
  Status?: string;
  Registration?: string | number;
  Expiration?: string | number;
  RenewOption?: string;
  Locked?: string;
  Privacy?: string;
  NameServerSettings?: unknown;
}

interface DynadotListResponse {
  ResponseCode?: number;
  Status?: string;
  DomainInfoList?: DynadotDomainInfo[];
  MainDomains?: DynadotDomainInfo[];
}

interface DynadotCommandResponse {
  ResponseCode?: number;
  Status?: string;
}

interface DynadotResponse {
  ListDomainResponse?: DynadotListResponse;
  ListDomainInfoResponse?: DynadotListResponse;
  RenewResponse?: DynadotCommandResponse;
  SetNsResponse?: DynadotCommandResponse;
  SetLockResponse?: DynadotCommandResponse;
  Response?: { Error?: string };
}

/**
 * Dynadot Registrar
 * API docs: https://www.dynadot.com/domain/api-document
 *
 * Credentials: enable API access and generate an API key under
 * Account > API Settings.
 *
 * Note: Dynadot's API authenticates via a `key` query-string parameter (not a
 * header), so the key appears in the request URL — this is required by their
 * API design.
 */
export class DynadotRegistrar extends BaseRegistrar {
  readonly name = 'dynadot';

  static readonly displayName = 'Dynadot';
  static readonly helpText =
    'Find your API Key in your Dynadot account under Account > API Settings. ' +
    'You must enable API access and generate an API key there.';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
  ];
  static readonly supportsSandbox = false; // Dynadot has no public sandbox environment
  // Broadest coverage of the set: on top of core, it adds DNSSEC, glue records,
  // email + domain forwarding, webhooks, aftermarket/marketplace, push,
  // appraisal, and bulk (Smart Folder) settings. Email is forwarding-only.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.GetAuthCode,
    Feature.ConfigureDnssec,
    Feature.GetGlueRecords,
    Feature.SetGlueRecords,
    Feature.SetEmailForwarding,
    Feature.SetDomainForwarding,
    Feature.SubscribeWebhooks,
    Feature.ListOnMarketplace,
    Feature.PushToAccount,
    Feature.AppraiseDomain,
    Feature.ApplyBulkSettings,
  ];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    // baseUrl is the full endpoint; all commands are query-string based
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('Dynadot', options?.environment, {
          production: 'https://api.dynadot.com/api3.json',
        }),
      },
      options
    );
  }

  // issue a command against the api3.json endpoint (key + command in the query)
  private command(
    query: Record<string, string | number>,
    opts?: RequestOptions
  ): Promise<DynadotResponse> {
    return this.http.request<DynadotResponse>({
      path: '',
      query: { key: this.credentials.apiKey, ...query },
      ...opts,
    });
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      const res = await this.command({ command: 'list_domain' }, opts);
      const list = res.ListDomainResponse ?? res.ListDomainInfoResponse;
      if (list && list.ResponseCode === 0) {
        return { success: true, message: 'Connection successful' };
      }
      if (res.Response?.Error) {
        return { success: false, message: res.Response.Error };
      }
      return { success: false, message: list?.Status ?? 'Unknown error' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: RequestOptions): Promise<Domain[]> {
    const res = await this.command({ command: 'list_domain' }, opts);
    const list = res.ListDomainResponse ?? res.ListDomainInfoResponse;
    if (!list || list.ResponseCode !== 0) {
      throw new Error(list?.Status ?? 'Failed to list domains');
    }

    const infoList = list.DomainInfoList ?? list.MainDomains ?? [];
    const domains: Domain[] = [];
    for (const d of infoList) {
      domains.push(
        createDomain({
          domainName: d.Name,
          registrar: this.name,
          status: d.Status ?? '',
          createdDate: d.Registration ?? null,
          expirationDate: d.Expiration ?? null,
          renewalDate: d.Expiration ?? null,
          autoRenew: d.RenewOption === 'auto-renew',
          locked: d.Locked === 'yes',
          privacy: d.Privacy === 'full' || d.Privacy === 'partial',
          nameservers: extractNameservers(d.NameServerSettings),
        })
      );
      await sleep(200); // gentle rate limiting
    }
    return domains;
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const res = await this.command({ command: 'renew', domain: domainName, duration: years }, opts);
    return commandResult(res.RenewResponse);
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 2 || nameservers.length > 13) {
      throw new Error('Dynadot requires 2-13 nameservers');
    }
    const query: Record<string, string | number> = { command: 'set_ns', domain: domainName };
    nameservers.forEach((ns, i) => {
      query[`ns${i}`] = ns;
    });
    const res = await this.command(query, opts);
    return commandResult(res.SetNsResponse);
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    const res = await this.command({ command: 'set_lock', domain: domainName, lock: 'yes' }, opts);
    return commandResult(res.SetLockResponse);
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    const res = await this.command({ command: 'set_lock', domain: domainName, lock: 'no' }, opts);
    return commandResult(res.SetLockResponse);
  }
}

// map a Dynadot command response to an OperationResult
function commandResult(res: DynadotCommandResponse | undefined): OperationResult {
  return {
    success: res?.ResponseCode === 0,
    message: res?.Status ?? 'Unknown response',
  };
}

// Dynadot nameserver settings can be an array or an object with a NameServers array
function extractNameservers(settings: unknown): string[] {
  if (!settings) return [];
  if (Array.isArray(settings)) return settings.map(String);
  if (typeof settings === 'object' && 'NameServers' in settings) {
    const ns = (settings as { NameServers?: unknown }).NameServers;
    return Array.isArray(ns) ? ns.map(String) : [];
  }
  return [];
}

import type {
  ConfigField,
  ConnectionResult,
  Domain,
  OperationResult,
  RegistrarOptions,
  RequestOptions,
} from '../types';
import { createDomain } from '../utils';
import { toRegistrarError } from '../errors';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import { Feature, type RegistrarFeature } from '../features';
import type { RegistrarCredentials } from '../types';

// Porkbun returns `{ status: "SUCCESS" | "ERROR", ... }` for every operation.
interface PbResponse {
  status?: string;
  message?: string;
  domains?: PbDomain[];
}

interface PbDomain {
  domain?: string;
  status?: string;
  createDate?: string;
  expireDate?: string;
  securityLock?: string | number;
  whoisPrivacy?: string | number;
  autoRenew?: string | number;
}

/**
 * Porkbun Registrar
 * API docs: https://porkbun.com/api/json/v3/documentation
 *
 * Credentials: create an API key + secret under Account > API Access, then
 * enable API access for each domain you want to manage (Porkbun gates most
 * operations behind a per-domain "API Access" toggle in the domain's settings).
 *
 * Note: Porkbun uses a JSON POST API; credentials travel in the request body as
 * `apikey` / `secretapikey`. Success is signalled by `status: "SUCCESS"`.
 *
 * API gaps (left as NotImplementedError): the transfer lock is read-only via the
 * API (`securityLock` is exposed but has no toggle endpoint), and renewal
 * requires matching the current price via a `cost` field, so it isn't a simple
 * `renewDomain(years)` call.
 */
export class PorkbunRegistrar extends BaseRegistrar {
  readonly name = 'porkbun';

  static readonly displayName = 'Porkbun';
  static readonly helpText =
    'Create an API key and secret in your Porkbun account under Account > API Access, ' +
    'then enable "API Access" on each domain you want to manage (per-domain toggle in ' +
    'the domain details).';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'secretApiKey', label: 'Secret API Key', type: 'password', required: true },
  ];
  // Porkbun offers test keys (pk1_sb_...) rather than a distinct sandbox host,
  // so there is no separate base URL to target.
  static readonly supportsSandbox = false;
  // JSON API. Beyond core: DNSSEC, glue records, URL (domain) forwarding, and
  // signed webhooks. No auth-code retrieval; transfer lock and WHOIS-privacy
  // toggles have no write endpoint (privacy is set only at registration).
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.ConfigureDnssec,
    Feature.GetGlueRecords,
    Feature.SetGlueRecords,
    Feature.SetDomainForwarding,
    Feature.SubscribeWebhooks,
  ];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('Porkbun', options?.environment, {
          production: 'https://api.porkbun.com/api/json/v3',
        }),
      },
      options
    );
  }

  // POST an operation with the credentials merged into the JSON body
  private call(
    path: string,
    extra: Record<string, unknown> = {},
    opts?: RequestOptions
  ): Promise<PbResponse> {
    return this.http.request<PbResponse>({
      method: 'POST',
      path,
      body: {
        apikey: this.credentials.apiKey,
        secretapikey: this.credentials.secretApiKey,
        ...extra,
      },
      ...opts,
    });
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      const res = await this.call('/ping', {}, opts);
      return isOk(res)
        ? { success: true, message: 'Connection successful' }
        : { success: false, message: res.message ?? 'Unknown error' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: RequestOptions): Promise<Domain[]> {
    const domains: Domain[] = [];
    const pageSize = 1000; // Porkbun returns up to 1000 domains per call
    let start = 0;
    let hasMore = true;

    while (hasMore) {
      const res = await this.call('/domain/listAll', { start, includeLabels: 'no' }, opts);
      if (!isOk(res)) {
        throw new Error(res.message ?? 'API request failed');
      }

      const list = res.domains ?? [];
      for (const d of list) {
        domains.push(
          createDomain({
            domainName: d.domain,
            registrar: this.name,
            status: d.status ?? 'ok',
            createdDate: d.createDate,
            expirationDate: d.expireDate,
            renewalDate: d.expireDate,
            autoRenew: isYes(d.autoRenew),
            locked: isYes(d.securityLock),
            privacy: isYes(d.whoisPrivacy),
            nameservers: [], // not returned by listAll (see domain/getNs)
          })
        );
      }

      hasMore = list.length === pageSize;
      start += pageSize;
    }
    return domains;
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 2) {
      throw new Error('Porkbun requires at least 2 nameservers');
    }
    const res = await this.call(
      `/domain/updateNs/${encodeURIComponent(domainName)}`,
      { ns: nameservers },
      opts
    );
    return statusResult(res);
  }
}

// whether the response status is "SUCCESS"
function isOk(res: PbResponse): boolean {
  return res.status === 'SUCCESS';
}

// map a response's status to an OperationResult
function statusResult(res: PbResponse): OperationResult {
  if (isOk(res)) return { success: true, message: 'SUCCESS' };
  return { success: false, message: res.message ?? 'Unknown response' };
}

// Porkbun booleans arrive as "1"/"0" (sometimes numbers) — normalize to boolean
function isYes(value: string | number | undefined): boolean {
  return value === '1' || value === 1 || value === 'yes';
}

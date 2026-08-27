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

// NameSilo returns a `{ request, reply }` envelope for every operation. All
// calls return HTTP 200; success/failure is signalled by `reply.code` (300 = ok).
interface NsReply {
  code?: number | string;
  detail?: string;
  domains?: unknown;
  pager?: { page?: number; page_size?: number; total_count?: number };
}

interface NsResponse {
  reply?: NsReply;
}

// a domain entry from listDomains, which may arrive as a bare name or an object
interface NsDomainEntry {
  domain?: string;
  created?: string;
  expires?: string;
}

/**
 * NameSilo Registrar
 * API docs: https://www.namesilo.com/api-reference
 *
 * Credentials: generate an API key in your NameSilo account under
 * Account Options > API Manager. The key may optionally be restricted to up to
 * five IP addresses there.
 *
 * Note: NameSilo uses a simple HTTP GET API — every call hits
 * `/{operation}` with `version`, `type=json`, and `key` query parameters (the
 * key travels in the URL, per their API design). Responses carry a numeric
 * `reply.code` (300 = success) rather than using HTTP status codes.
 */
export class NameSiloRegistrar extends BaseRegistrar {
  readonly name = 'namesilo';

  static readonly displayName = 'NameSilo';
  static readonly helpText =
    'Generate an API key in your NameSilo account under Account Options > API Manager. ' +
    'You can optionally restrict the key to specific IP addresses there.';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
  ];
  // NameSilo runs an OTE/test environment at ote.namesilo.com; sandbox keys are
  // issued by emailing NameSilo support (not self-service).
  static readonly supportsSandbox = true;
  // JSON API with broad coverage. Beyond core: auth-code retrieval (emailed to
  // the registrant, not returned inline), DNSSEC, glue records, email
  // forwarding, and domain forwarding. No webhooks (polling only).
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.GetAuthCode,
    Feature.ConfigureDnssec,
    Feature.GetGlueRecords,
    Feature.SetGlueRecords,
    Feature.SetEmailForwarding,
    Feature.SetDomainForwarding,
  ];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('NameSilo', options?.environment, {
          production: 'https://www.namesilo.com/api',
          sandbox: 'https://ote.namesilo.com/api',
        }),
      },
      options
    );
  }

  // issue an operation with the standard auth params merged in
  private call(
    operation: string,
    extra: Record<string, string | number> = {},
    opts?: RequestOptions
  ): Promise<NsResponse> {
    return this.http.request<NsResponse>({
      path: `/${operation}`,
      query: { version: 1, type: 'json', key: this.credentials.apiKey, ...extra },
      ...opts,
    });
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      // getAccountBalance is the cheapest read-only call that validates the key
      const res = await this.call('getAccountBalance', {}, opts);
      return replyOk(res)
        ? { success: true, message: 'Connection successful' }
        : { success: false, message: replyDetail(res) };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: RequestOptions): Promise<Domain[]> {
    const domains: Domain[] = [];
    const pageSize = 100;
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const res = await this.call('listDomains', { page, pageSize }, opts);
      if (!replyOk(res)) {
        throw new Error(replyDetail(res));
      }

      const entries = extractDomainEntries(res.reply?.domains);
      for (const entry of entries) {
        domains.push(
          createDomain({
            domainName: entry.domain,
            registrar: this.name,
            status: 'ok', // the list endpoint does not return a per-domain status
            createdDate: entry.created,
            expirationDate: entry.expires,
            renewalDate: entry.expires,
            nameservers: [], // not returned by listDomains (see getDomainInfo)
          })
        );
      }

      hasMore = entries.length === pageSize;
      page++;
    }
    return domains;
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const res = await this.call('renewDomain', { domain: domainName, years }, opts);
    return statusResult(res);
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 2 || nameservers.length > 13) {
      throw new Error('NameSilo requires 2-13 nameservers');
    }
    const query: Record<string, string | number> = { domain: domainName };
    nameservers.forEach((ns, i) => {
      query[`ns${i + 1}`] = ns; // ns1..ns13
    });
    const res = await this.call('changeNameServers', query, opts);
    return statusResult(res);
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    // 252 = "already locked" — treat as an idempotent success
    const res = await this.call('domainLock', { domain: domainName }, opts);
    return statusResult(res, [252]);
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    // 253 = "already unlocked" — treat as an idempotent success
    const res = await this.call('domainUnlock', { domain: domainName }, opts);
    return statusResult(res, [253]);
  }
}

// whether the response's reply.code is in the success family (300)
function replyOk(res: NsResponse): boolean {
  return Number(res.reply?.code) === 300;
}

// human-readable detail from a reply, for error messages
function replyDetail(res: NsResponse): string {
  return res.reply?.detail?.trim() || 'Unknown response';
}

// map a reply to an OperationResult; extra codes are also treated as success
function statusResult(res: NsResponse, okCodes: number[] = []): OperationResult {
  const code = Number(res.reply?.code);
  if (code === 300 || okCodes.includes(code)) {
    return { success: true, message: res.reply?.detail?.trim() || 'success' };
  }
  return { success: false, message: replyDetail(res) };
}

// listDomains may return domains as an array of names, an array of objects, or
// an object wrapping a `domain` array — normalize all shapes to entry objects
function extractDomainEntries(domains: unknown): NsDomainEntry[] {
  if (!domains) return [];
  const raw = Array.isArray(domains)
    ? domains
    : typeof domains === 'object' && 'domain' in domains
      ? ((domains as { domain?: unknown }).domain ?? [])
      : [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(item => (typeof item === 'string' ? { domain: item } : (item as NsDomainEntry)));
}

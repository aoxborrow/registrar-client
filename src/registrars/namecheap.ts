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
import { ensureArray, parseXml } from '../xml.js';
import { BaseRegistrar, selectBaseUrl } from '../registrar.js';
import { Feature, type RegistrarFeature } from '../features.js';
import type { RegistrarCredentials } from '../types.js';

// shape of a Namecheap XML response (attributes prefixed with `@_`)
interface NcError {
  '#text'?: string;
  '@_Number'?: string;
}

interface NcDomainEl {
  '@_Name'?: string;
  '@_Created'?: string;
  '@_Expires'?: string;
  '@_AutoRenew'?: string;
  '@_IsLocked'?: string;
  '@_WhoisGuard'?: string;
}

interface NcResponse {
  ApiResponse?: {
    '@_Status'?: string;
    'Errors'?: { Error?: NcError | NcError[] | string };
    'CommandResponse'?: {
      DomainGetListResult?: { Domain?: NcDomainEl | NcDomainEl[] };
    };
  };
}

/**
 * Namecheap Registrar
 * API docs: https://www.namecheap.com/support/api/intro/
 *
 * Credentials: enable API access under Profile > Tools > API Access, generate
 * an API key, and whitelist the IP(s) requests will originate from (Namecheap
 * enforces IP whitelisting). Supply that whitelisted IP as `clientIp`.
 *
 * Note: Namecheap authenticates via query-string parameters (ApiUser, ApiKey,
 * UserName, ClientIp) and responds with XML, parsed via the shared `parseXml`
 * helper (fast-xml-parser).
 */
export class NamecheapRegistrar extends BaseRegistrar {
  readonly name = 'namecheap';

  static readonly displayName = 'Namecheap';
  static readonly helpText =
    'Enable API access in your Namecheap account under Profile > Tools > API Access, ' +
    'generate an API key, and whitelist your request IP(s) in the API settings. ' +
    'Provide the whitelisted IP as the Client IP field.';
  static readonly configFields: ConfigField[] = [
    { name: 'username', label: 'Username', type: 'text', required: true },
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'clientIp', label: 'Client IP', type: 'text', required: false, default: '0.0.0.0' },
  ];
  // Namecheap runs a sandbox at api.sandbox.namecheap.com (separate account at
  // sandbox.namecheap.com with its own API key)
  static readonly supportsSandbox = true;
  // XML API. Beyond core, email forwarding (alias-only) and domain forwarding
  // (URL/FRAME pseudo-records). No DNSSEC or webhooks; auth-code retrieval and
  // glue records are dashboard-gated / unconfirmed, so they're left undeclared
  // until verified against a live account.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.SetEmailForwarding,
    Feature.SetDomainForwarding,
  ];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('Namecheap', options?.environment, {
          production: 'https://api.namecheap.com/xml.response',
          sandbox: 'https://api.sandbox.namecheap.com/xml.response',
        }),
      },
      options
    );
  }

  // common query parameters (credentials + command) for every Namecheap call
  private baseQuery(command: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      ApiUser: this.credentials.username,
      ApiKey: this.credentials.apiKey,
      UserName: this.credentials.username,
      // Namecheap validates against whitelisted IPs configured in the account
      ClientIp: this.credentials.clientIp || '0.0.0.0',
      Command: command,
      ...extra,
    };
  }

  // issue a command and parse the XML response
  private async call(
    command: string,
    extra: Record<string, string>,
    opts?: RequestOptions
  ): Promise<NcResponse> {
    const xml = await this.http.requestText({
      path: '',
      query: this.baseQuery(command, extra),
      ...opts,
    });
    return parseXml<NcResponse>(xml);
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      const res = await this.call('namecheap.domains.getList', {}, opts);
      return isOk(res)
        ? { success: true, message: 'Connection successful' }
        : { success: false, message: errorText(res) ?? 'Unknown error' };
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
      const res = await this.call(
        'namecheap.domains.getList',
        { PageSize: String(pageSize), Page: String(page) },
        opts
      );
      if (!isOk(res)) {
        throw new Error(errorText(res) ?? 'API request failed');
      }

      const elements = ensureArray(res.ApiResponse?.CommandResponse?.DomainGetListResult?.Domain);
      for (const d of elements) {
        domains.push(
          createDomain({
            domainName: d['@_Name'],
            registrar: this.name,
            status: 'ok', // the list endpoint does not return a per-domain status
            createdDate: d['@_Created'],
            expirationDate: d['@_Expires'],
            renewalDate: d['@_Expires'],
            autoRenew: d['@_AutoRenew'] === 'true',
            locked: d['@_IsLocked'] === 'true',
            privacy: d['@_WhoisGuard'] === 'ENABLED',
            nameservers: [], // the list endpoint does not return nameservers
          })
        );
      }

      hasMore = elements.length === pageSize;
      page++;
    }
    return domains;
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const res = await this.call(
      'namecheap.domains.renew',
      { DomainName: domainName, Years: String(years) },
      opts
    );
    return statusResult(res);
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 2 || nameservers.length > 12) {
      throw new Error('Namecheap requires 2-12 nameservers');
    }
    // split into second-level domain + TLD (TLD may contain a dot, e.g. co.uk)
    const dot = domainName.indexOf('.');
    const sld = dot === -1 ? domainName : domainName.slice(0, dot);
    const tld = dot === -1 ? '' : domainName.slice(dot + 1);
    const res = await this.call(
      'namecheap.domains.dns.setCustom',
      { SLD: sld, TLD: tld, Nameservers: nameservers.join(',') },
      opts
    );
    return statusResult(res);
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    const res = await this.call(
      'namecheap.domains.setRegistrarLock',
      { DomainName: domainName, LockAction: 'LOCK' },
      opts
    );
    return statusResult(res);
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    const res = await this.call(
      'namecheap.domains.setRegistrarLock',
      { DomainName: domainName, LockAction: 'UNLOCK' },
      opts
    );
    return statusResult(res);
  }
}

// whether the response's root Status attribute is "OK"
function isOk(res: NcResponse): boolean {
  return res.ApiResponse?.['@_Status'] === 'OK';
}

// extract the first error message from an error response, if present
function errorText(res: NcResponse): string | null {
  const error = res.ApiResponse?.Errors?.Error;
  if (!error) return null;
  const first = ensureArray(error)[0];
  if (typeof first === 'string') return first.trim() || null;
  return first?.['#text']?.trim() ?? null;
}

// map a Namecheap response's root Status to an OperationResult
function statusResult(res: NcResponse): OperationResult {
  if (isOk(res)) return { success: true, message: 'OK' };
  return { success: false, message: errorText(res) ?? 'Unknown response' };
}

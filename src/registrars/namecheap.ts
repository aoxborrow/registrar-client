import type {
  ConfigField,
  ConnectionResult,
  Domain,
  OperationResult,
  RegistrarClientOptions,
  RequestOptions,
} from '../types.js';
import { createDomain } from '../utils.js';
import { toRegistrarError } from '../errors.js';
import { BaseRegistrar } from './base.js';
import type { RegistrarCredentials } from './types.js';

/**
 * Namecheap Registrar
 * API docs: https://www.namecheap.com/support/api/intro/
 *
 * Credentials: enable API access under Profile > Tools > API Access, generate
 * an API key, and whitelist the IP(s) requests will originate from (Namecheap
 * enforces IP whitelisting). Supply that whitelisted IP as `clientIp`.
 *
 * Note: Namecheap authenticates via query-string parameters (ApiUser, ApiKey,
 * UserName, ClientIp) and responds with XML. Responses are parsed with a small
 * built-in extractor rather than a full XML parser so the client stays
 * dependency-free and runs in browsers, Workers, and Node alike.
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

  constructor(credentials: RegistrarCredentials, options?: Partial<RegistrarClientOptions>) {
    super(credentials, { baseUrl: 'https://api.namecheap.com/xml.response' }, options);
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

  private call(
    command: string,
    extra: Record<string, string>,
    opts?: RequestOptions
  ): Promise<string> {
    return this.http.requestText({ path: '', query: this.baseQuery(command, extra), ...opts });
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      const xml = await this.call('namecheap.domains.getList', {}, opts);
      if (getRootStatus(xml) === 'OK') {
        return { success: true, message: 'Connection successful' };
      }
      return { success: false, message: getErrorText(xml) ?? 'Unknown error' };
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
      const xml = await this.call(
        'namecheap.domains.getList',
        { PageSize: String(pageSize), Page: String(page) },
        opts
      );
      if (getRootStatus(xml) !== 'OK') {
        throw new Error(getErrorText(xml) ?? 'API request failed');
      }

      const elements = parseDomainElements(xml);
      for (const attrs of elements) {
        domains.push(
          createDomain({
            domainName: attrs.Name,
            registrar: this.name,
            status: 'ok', // the list endpoint does not return a per-domain status
            createdDate: attrs.Created,
            expirationDate: attrs.Expires,
            renewalDate: attrs.Expires,
            autoRenew: attrs.AutoRenew === 'true',
            locked: attrs.IsLocked === 'true',
            privacy: attrs.WhoisGuard === 'ENABLED',
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
    const xml = await this.call(
      'namecheap.domains.renew',
      { DomainName: domainName, Years: String(years) },
      opts
    );
    return statusResult(xml);
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
    const xml = await this.call(
      'namecheap.domains.dns.setCustom',
      { SLD: sld, TLD: tld, Nameservers: nameservers.join(',') },
      opts
    );
    return statusResult(xml);
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    const xml = await this.call(
      'namecheap.domains.setRegistrarLock',
      { DomainName: domainName, LockAction: 'LOCK' },
      opts
    );
    return statusResult(xml);
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    const xml = await this.call(
      'namecheap.domains.setRegistrarLock',
      { DomainName: domainName, LockAction: 'UNLOCK' },
      opts
    );
    return statusResult(xml);
  }
}

// --- minimal, dependency-free XML extraction for Namecheap responses ---
// These read only the specific attributes/elements the API returns. They are
// deliberately narrow, not a general XML parser.

// read the Status attribute from the root <ApiResponse Status="...">
function getRootStatus(xml: string): string | null {
  const match = /<ApiResponse\b[^>]*\bStatus="([^"]*)"/i.exec(xml);
  return match ? match[1] : null;
}

// read the first <Error ...>message</Error> text, if present
function getErrorText(xml: string): string | null {
  const match = /<Error\b[^>]*>([^<]*)<\/Error>/i.exec(xml);
  return match ? match[1].trim() : null;
}

// extract each <Domain .../> element as a map of its attributes
function parseDomainElements(xml: string): Record<string, string>[] {
  const results: Record<string, string>[] = [];
  const domainRe = /<Domain\b([^>]*?)\/?>/gi;
  let el: RegExpExecArray | null;
  while ((el = domainRe.exec(xml)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(el[1])) !== null) {
      attrs[a[1]] = a[2];
    }
    results.push(attrs);
  }
  return results;
}

// map a Namecheap response's root Status to an OperationResult
function statusResult(xml: string): OperationResult {
  const status = getRootStatus(xml);
  return {
    success: status === 'OK',
    message: status === 'OK' ? 'OK' : (getErrorText(xml) ?? status ?? 'Unknown response'),
  };
}

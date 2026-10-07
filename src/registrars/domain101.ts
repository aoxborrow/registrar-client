import {
  AuthorizationError,
  ConfigurationError,
  ConnectionError,
  InvalidResponseError,
  NotFoundError,
  OutcomeUnknownError,
  ParsingError,
  RegistrarError,
  toRegistrarError,
} from '../errors';
import { Feature, type RegistrarFeature } from '../features';
import { HttpClient, REST_SAFE_METHODS, type RequestConfig } from '../http';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import type {
  ConfigField,
  ConnectionResult,
  DnsRecord,
  Domain,
  DomainAvailability,
  DomainForward,
  ListDomainsOptions,
  OperationResult,
  RegistrarCredentials,
  RegistrarOptions,
  RequestOptions,
  TldPricing,
} from '../types';
import { createDomain, filterDomains, normalizeDomain } from '../utils';

// 101domain Client API 1.1.0, https://api.101domain.com/api/documentation
interface Envelope<T> {
  status: string;
  data: T;
  invalid?: string[];
  meta?: { pagination?: { current_page: number; total_pages: number; total: number } };
}
interface RawDomain {
  domain_name: string;
  status?: string;
  registered_at?: string | null;
  expires_at?: string | null;
  auto_renew?: boolean;
  registry_statuses?: string[];
  nameservers?: string[];
}
interface RawPrice {
  register?: string;
  renew?: string;
  transfer?: string;
  currency: string;
  premium?: boolean;
  term_years?: number;
}
interface RawAvailability {
  domain_name: string;
  available: boolean;
  // one entry per term; null when the name isn't available to register
  pricing?: RawPrice[] | null;
}
interface RawRecord {
  id: string;
  name: string;
  type: string;
  value: string;
  ttl: number;
  proxied?: boolean;
}
interface RawForward {
  destination: string | null;
  type: '301' | 'cloak' | null;
}
type RecordSpec = Record<string, string | number | boolean>;

// Response bodies and fetch/parser excerpts can echo private data. Keep typed
// statuses and Retry-After, and of an error body only the API's own `code` and
// `message` fields (e.g. NAMESERVERS_NOT_LOCAL), never the raw body.
class Domain101HttpClient extends HttpClient {
  override async request<T = unknown>(req: RequestConfig): Promise<T> {
    try {
      return await super.request<T>(req);
    } catch (error) {
      // A read-only key is valid but scoped: name the missing scope so the
      // caller can say what to grant rather than "403 Forbidden".
      if (error instanceof AuthorizationError) {
        const scope = requiredScope(req);
        if (!scope || error.providerCode !== 'INSUFFICIENT_PERMISSIONS') throw error;
        const scoped = new AuthorizationError(
          `101domain: this API key does not have the ${scope} scope. Create a key with ${scope} to ${SCOPE_PURPOSE[scope]}.`
        );
        scoped.providerCode = error.providerCode;
        throw scoped;
      }
      if (error instanceof OutcomeUnknownError)
        throw new OutcomeUnknownError(
          '101domain: the registrar did not confirm this change. Re-read the domain before trying again.',
          { feature: error.feature }
        );
      if (error instanceof ParsingError) throw new ParsingError('101domain: invalid JSON response');
      if (error instanceof ConnectionError)
        throw new ConnectionError('101domain: network request failed', { notSent: error.notSent });
      throw error;
    }
  }
  protected override async toStatusError(response: Response, url: string): Promise<RegistrarError> {
    const detail = await errorDetail(response);
    const error = await super.toStatusError(
      new Response(null, { status: response.status, headers: response.headers }),
      url
    );
    if (detail) {
      error.message = `101domain: ${detail.message}`;
      error.providerCode = detail.code;
    } else if (response.status === 403) {
      // The API host sits behind Cloudflare, whose bot challenge answers
      // some clients with an HTML 403 before the request reaches the API.
      error.message =
        '101domain: the request was refused before reaching the API (403 without an API error)';
    }
    return error;
  }
}

type Scope = 'domains_read' | 'domains_write' | 'dns_read' | 'dns_write';
const SCOPE_PURPOSE: Record<Scope, string> = {
  domains_read: 'read the domain portfolio',
  domains_write: 'change URL forwarding',
  dns_read: 'read DNS records and nameservers',
  dns_write: 'change DNS records and nameservers',
};

// The scope an endpoint requires; search, bulk-search and TLD pricing need none.
function requiredScope(req: RequestConfig): Scope | undefined {
  const write = !REST_SAFE_METHODS.includes((req.method ?? 'GET').toUpperCase());
  if (req.path.startsWith('/dns/')) return write ? 'dns_write' : 'dns_read';
  if (req.path === '/domains' || /^\/domains\/[^/]+(?:\/forwarding)?$/.test(req.path))
    return write ? 'domains_write' : 'domains_read';
  return undefined;
}

// The error envelope's code and message, which are fixed API strings. Returns
// null for anything else so a stray body is never surfaced.
async function errorDetail(response: Response): Promise<{ code: string; message: string } | null> {
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    if (typeof body?.code !== 'string' || typeof body.message !== 'string' || !body.message)
      return null;
    return { code: body.code, message: body.message.replace(/\s+/g, ' ').slice(0, 200) };
  } catch {
    return null;
  }
}

export class Domain101Registrar extends BaseRegistrar {
  readonly name = '101domain';
  static override readonly safeMethods = REST_SAFE_METHODS;
  static readonly displayName = '101domain';
  static readonly website = '101domain.com';
  static readonly supportsSandbox = false;
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API key', type: 'password', required: true },
  ];
  static readonly helpText =
    'Create a Bearer API key under My Account > Developer Tools - API & MCP. ' +
    'Use domains_read and dns_read for reads; dns_write for DNS/nameservers and domains_write for forwarding. ' +
    'Only a primary account with 2FA or SSO can create keys. Keys expire after at most one year. ' +
    'Registration, renewal, auto-renew, privacy, lock, contacts and transfers are not available through this API.';
  static override readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.GetDomainForwarding,
    Feature.SetDomainForwarding,
  ];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    const apiKey = credentials.apiKey?.trim() ?? '';
    if (/[\r\n]/.test(apiKey)) throw new ConfigurationError('101domain: invalid API key format');
    const config = {
      baseUrl: selectBaseUrl('101domain', options?.environment, {
        production: 'https://api.101domain.com/v1',
      }),
      headers: { Authorization: `Bearer ${apiKey}` },
    };
    super(credentials, config, options);
    this.http = new Domain101HttpClient({
      ...config,
      safeMethods: REST_SAFE_METHODS,
      options: this.options,
    });
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      await this.request<RawDomain[]>({
        path: '/domains',
        query: { page: 1, per_page: 1 },
        ...opts,
      });
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const { search, detailed: _detailed, ...requestOpts } = opts ?? {};
    const result: Domain[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page++) {
      const response = await this.request<RawDomain[]>({
        path: '/domains',
        query: { page, per_page: 50 },
        ...requestOpts,
      });
      if (!Array.isArray(response.data)) throw invalid('domain list');
      const pagination = response.meta?.pagination;
      if (
        !pagination ||
        pagination.current_page !== page ||
        !Number.isInteger(pagination.total_pages) ||
        pagination.total_pages < 0 ||
        pagination.total_pages > 100000 ||
        !Number.isInteger(pagination.total) ||
        pagination.total < 0
      )
        throw invalid('pagination');
      for (const raw of response.data) {
        const domain = toDomain(raw);
        if (seen.has(domain.domainName)) throw invalid('duplicate domain across pages');
        seen.add(domain.domainName);
        result.push(domain);
      }
      if (page >= pagination.total_pages) {
        if (result.length !== pagination.total) throw invalid('incomplete portfolio');
        // The list keeps every order the account ever placed, so drop the
        // names it doesn't hold (as GoDaddy's status filter does).
        return filterDomains(
          result.filter(d => !d.deleted),
          search
        );
      }
      if (!response.data.length) throw invalid('empty intermediate page');
    }
  }

  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    const domain = toDomain(
      (await this.request<RawDomain>({ path: domainPath(domainName), ...opts })).data
    );
    if (domain.domainName !== normalizeDomain(domainName)) throw invalid('domain identity');
    return domain;
  }
  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    const raw = (
      await this.request<string[]>({ path: `${dnsPath(domainName)}/nameservers`, ...opts })
    ).data;
    if (!Array.isArray(raw) || raw.some(n => typeof n !== 'string')) throw invalid('nameservers');
    return raw.map(n => n.toLowerCase());
  }
  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const normalized = nameservers.map(n => n.trim().toLowerCase());
    if (
      normalized.length < 2 ||
      normalized.length > 13 ||
      new Set(normalized).size !== normalized.length ||
      normalized.some(n => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(n))
    )
      throw new ConfigurationError('101domain: provide 2–13 distinct nameserver hostnames');
    try {
      const response = await this.request<{ change_status: string }>({
        ...opts,
        method: 'PUT',
        path: `${dnsPath(domainName)}/nameservers`,
        body: { nameservers: normalized },
      });
      if (response.data?.change_status === 'pending')
        return {
          success: true,
          pending: true,
          message:
            'Nameserver change submitted; pending registry processing. Re-read nameservers to confirm completion.',
        };
      if (response.data?.change_status === 'failed')
        return { success: false, message: '101domain rejected the nameserver change' };
      if (response.data?.change_status !== 'completed')
        throw new OutcomeUnknownError(
          '101domain: invalid nameserver change confirmation. Re-read nameservers before trying again.'
        );
      return { success: true, message: 'Nameservers already configured as requested' };
    } catch (error) {
      return failed(error);
    }
  }

  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const names = [...new Set(domainNames.map(normalizeDomain))];
    const result: DomainAvailability[] = [];
    for (const domains of chunks(names, 50)) {
      const response = await this.request<RawAvailability[]>({
        ...opts,
        method: 'POST',
        path: '/domains/bulk-search',
        body: { domains, pricing_term: 1 },
      });
      if (!Array.isArray(response.data) || (response.invalid?.length ?? 0) > 0)
        throw invalid('availability results');
      const found = new Set<string>();
      for (const raw of response.data) {
        if (typeof raw.domain_name !== 'string' || typeof raw.available !== 'boolean')
          throw invalid('availability result');
        const domainName = normalizeDomain(raw.domain_name);
        if (!domains.includes(domainName) || found.has(domainName))
          throw invalid('availability identity');
        found.add(domainName);
        const price = oneYear(raw.pricing);
        result.push({
          domainName,
          available: raw.available,
          premium: price?.premium,
          price: amount(price?.register),
          renewalPrice: amount(price?.renew),
          currency: price?.currency,
          period: 1,
        });
      }
      if (found.size !== domains.length) throw invalid('incomplete availability results');
    }
    return result;
  }

  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    const name = normalizeDomain(tldOrDomain);
    if (name.startsWith('.') || !name.includes('.')) {
      const tld = name.replace(/^\./, '');
      const response = await this.request<{ pricing: RawPrice[] }>({
        path: `/tlds/${encodeURIComponent('.' + tld)}`,
        query: { pricing_terms: '1' },
        ...opts,
      });
      const price = oneYear(response.data?.pricing);
      if (!price) throw new NotFoundError('101domain: no one-year pricing for this TLD');
      return {
        tld,
        currency: price.currency,
        registration: amount(price.register),
        renewal: amount(price.renew),
        transfer: amount(price.transfer),
      };
    }
    const response = await this.request<RawAvailability>({
      path: '/domains/search',
      query: { domain_name: name, pricing_terms: '1' },
      ...opts,
    });
    const raw = response.data;
    if (!raw || normalizeDomain(raw.domain_name) !== name) throw invalid('pricing identity');
    // Pricing is null for a name that's taken, the account's own included.
    const price = oneYear(raw.pricing);
    if (!price) throw new NotFoundError('101domain: pricing unavailable for this domain');
    return {
      tld: name.slice(name.indexOf('.') + 1),
      currency: price.currency,
      registration: amount(price.register),
      renewal: amount(price.renew),
      transfer: amount(price.transfer),
    };
  }

  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    return (await this.rawRecords(domainName, opts)).map(fromRecord);
  }
  // Reconcile by content-derived IDs. Preserve unchanged records, edit by ID, create additions
  // before removing stale records, and stop on any failed batch. Never retry an
  // uncertain write. This replaces the custom records, not the apex NS delegation.
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const desired = records.map(r => recordSpec(r, domainName));
    const unique = desired.filter(
      (r, i) => desired.findIndex(other => recordSignature(other) === recordSignature(r)) === i
    );
    // Whether an earlier batch already landed, leaving the zone part-updated.
    let changed = false;
    try {
      // Existing records are only compared, never validated as writes: the
      // zone may hold what the writer refuses (an SWA record's automatic TTL,
      // a TTL under 300). Apex NS is the delegation, which this never replaces.
      const stale = (await this.rawRecords(domainName, opts))
        .map(raw => ({ raw, spec: recordSpec(fromRecord(raw), domainName, false) }))
        .filter(({ spec }) => !(spec.type === 'NS' && spec.name === ''));
      const additions: RecordSpec[] = [];
      const edits: RecordSpec[] = [];
      for (const record of unique) {
        const index = stale.findIndex(
          ({ spec }) => recordSignature(spec) === recordSignature(record)
        );
        if (index >= 0) stale.splice(index, 1);
        else {
          // The generic DNS shape has no proxy flag. Preserve the existing
          // host/type's SWA proxying when replacing its content or TTL.
          const priorIndex = stale.findIndex(
            ({ spec }) => spec.type === record.type && spec.name === record.name
          );
          const prior = priorIndex >= 0 ? stale.splice(priorIndex, 1)[0].raw : undefined;
          if (prior?.proxied) record.proxied = true;
          if (record.ttl === 1 && record.proxied !== true)
            throw new ConfigurationError(
              '101domain: automatic TTL requires an existing proxied SWA record'
            );
          if (prior) {
            const edit: RecordSpec = { ...record, id: prior.id };
            delete edit.name;
            delete edit.type;
            edits.push(edit);
          } else additions.push(record);
        }
      }
      for (const batch of chunks(edits, 25)) {
        const response = await this.request<{ old_id: string; id: string }[]>({
          ...opts,
          method: 'PATCH',
          path: `${dnsPath(domainName)}/records`,
          body: { records: batch },
        });
        // IDs change on edit. These records have been removed from the stale
        // set, so neither their old nor new IDs may be deleted below.
        if (
          !Array.isArray(response.data) ||
          response.data.length !== batch.length ||
          new Set(response.data.map(r => r?.old_id)).size !== batch.length ||
          response.data.some(
            r =>
              !r || !batch.some(edit => edit.id === r.old_id) || typeof r.id !== 'string' || !r.id
          )
        )
          throw new OutcomeUnknownError(
            '101domain: invalid DNS edit confirmation. Re-read the zone before trying again.'
          );
        changed = true;
      }
      for (const batch of chunks(additions, 25)) {
        await this.request({
          ...opts,
          method: 'POST',
          path: `${dnsPath(domainName)}/records`,
          body: { records: batch },
        });
        changed = true;
      }
      for (const batch of chunks(stale, 25)) {
        await this.request({
          ...opts,
          method: 'DELETE',
          path: `${dnsPath(domainName)}/records`,
          body: { ids: batch.map(({ raw }) => raw.id) },
        });
        changed = true;
      }
      return { success: true, message: 'DNS records updated successfully' };
    } catch (error) {
      const result = failed(error);
      // Nothing was written when the first write was refused (a read-only
      // key, say), so only warn about a partial zone once one may exist.
      if (!changed && !result.outcome) return result;
      return {
        ...result,
        message: `${result.message}. DNS replacement is not atomic; read the zone before retrying.`,
      };
    }
  }

  override async getDomainForwarding(
    domainName: string,
    opts?: RequestOptions
  ): Promise<DomainForward[]> {
    // The domain response explicitly distinguishes no forwarding from a missing
    // domain. A 404 on the forwarding endpoint must not be mistaken for no rule.
    const raw = (
      await this.request<RawDomain & { web_forwarding?: RawForward | null }>({
        path: domainPath(domainName),
        ...opts,
      })
    ).data;
    if (!raw || normalizeDomain(raw.domain_name) !== normalizeDomain(domainName))
      throw invalid('domain identity');
    const forward = raw.web_forwarding;
    // No rule reads as all-null fields ({destination: null, type: null}).
    if (forward === null || (forward?.destination === null && forward.type === null)) return [];
    if (
      !forward ||
      typeof forward.destination !== 'string' ||
      (forward.type !== '301' && forward.type !== 'cloak')
    )
      throw invalid('forwarding');
    return [
      {
        host: '@',
        url: forward.destination,
        type: forward.type === '301' ? 'permanent' : 'masked',
      },
    ];
  }
  override async setDomainForwarding(
    domainName: string,
    forwards: DomainForward[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (forwards.length > 1 || forwards.some(f => f.host !== '@' || f.type !== 'permanent'))
      throw new ConfigurationError(
        '101domain: only one permanent apex forwarding rule is supported'
      );
    if (forwards.length) {
      let url: URL;
      try {
        url = new URL(forwards[0].url);
      } catch {
        throw new ConfigurationError('101domain: forwarding needs a valid HTTP(S) URL');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new ConfigurationError('101domain: forwarding needs a valid HTTP(S) URL');
    }
    try {
      const existing = await this.getDomainForwarding(domainName, opts);
      const path = `${domainPath(domainName)}/forwarding`;
      if (!forwards.length) {
        if (existing.length) await this.request({ ...opts, method: 'DELETE', path });
      } else if (existing[0]?.url !== forwards[0].url || existing[0]?.type !== 'permanent') {
        await this.request({
          ...opts,
          method: existing.length ? 'PATCH' : 'POST',
          path,
          body: { destination: forwards[0].url, type: '301' },
        });
      }
      return {
        success: true,
        message: forwards.length ? 'URL forwarding updated' : 'URL forwarding cleared',
      };
    } catch (error) {
      return failed(error);
    }
  }

  private async request<T>(req: RequestConfig): Promise<Envelope<T>> {
    const raw = await this.http.request<Envelope<T>>(req);
    if (!raw || typeof raw !== 'object' || raw.status !== 'success' || !('data' in raw)) {
      if (req.call?.intent === 'write' && !REST_SAFE_METHODS.includes(req.method ?? 'GET'))
        throw new OutcomeUnknownError(
          '101domain: invalid write confirmation. Re-read the domain before trying again.'
        );
      throw invalid('response envelope');
    }
    return raw;
  }
  private async rawRecords(domainName: string, opts?: RequestOptions): Promise<RawRecord[]> {
    const raw = (
      await this.request<RawRecord[]>({ path: `${dnsPath(domainName)}/records`, ...opts })
    ).data;
    if (
      !Array.isArray(raw) ||
      raw.some(
        r =>
          !r ||
          typeof r.id !== 'string' ||
          !r.id ||
          typeof r.name !== 'string' ||
          typeof r.value !== 'string' ||
          typeof r.type !== 'string' ||
          !Number.isInteger(r.ttl)
      )
    )
      throw invalid('DNS records');
    if (new Set(raw.map(r => r.id)).size !== raw.length) throw invalid('duplicate DNS ids');
    return raw;
  }
}

function invalid(part: string): InvalidResponseError {
  return new InvalidResponseError(`101domain: invalid ${part}`);
}
function failed(error: unknown): OperationResult {
  return {
    success: false,
    message: toRegistrarError(error).message,
    ...(error instanceof OutcomeUnknownError ? { outcome: 'unknown' as const } : {}),
  };
}
function domainPath(name: string): string {
  return `/domains/${encodeURIComponent(normalizeDomain(name))}`;
}
function dnsPath(name: string): string {
  return `/dns/${encodeURIComponent(normalizeDomain(name))}`;
}
function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}
// The one-year entry of a per-term price list.
function oneYear(pricing: RawPrice[] | null | undefined): RawPrice | undefined {
  if (pricing == null) return undefined;
  if (!Array.isArray(pricing)) throw invalid('pricing');
  return pricing.find(p => p?.term_years === 1);
}
function amount(raw?: string): number | undefined {
  if (raw == null) return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw invalid('price');
  const value = Number(raw);
  if (!Number.isFinite(value)) throw invalid('price');
  return value;
}
function toDomain(raw: RawDomain): Domain {
  if (!raw || typeof raw.domain_name !== 'string' || !raw.domain_name.trim())
    throw invalid('domain');
  return createDomain({
    domainName: normalizeDomain(raw.domain_name),
    registrar: '101domain',
    status: raw.status,
    createdDate: raw.registered_at,
    expirationDate: raw.expires_at,
    autoRenew: raw.auto_renew,
    locked: raw.registry_statuses?.some(s => /^clientTransferProhibited$/i.test(s)),
    nameservers: raw.nameservers,
    deleted: !isHeld(raw),
  });
}
// Statuses for a name the account no longer (or never) held: deleted,
// cancelled, a denied application, or transferred to another registrar.
const GONE = new Set(['DELETED', 'CANCELLED', 'DENIED', 'XFER_AWAY']);
// Whether the account holds this name. Incoming transfers and applications
// that never registered (no registered_at) aren't held yet either.
function isHeld(raw: RawDomain): boolean {
  const status = raw.status?.toUpperCase() ?? '';
  return !GONE.has(status) && !status.startsWith('XFER_IN_') && raw.registered_at != null;
}
function fromRecord(raw: RawRecord): DnsRecord {
  const common = { name: raw.name || '@', type: raw.type, ttl: raw.ttl };
  if (raw.type === 'MX') {
    const match = /^(\d+)\s+(.+)$/.exec(raw.value);
    if (!match) throw invalid('MX record');
    return { ...common, value: canonicalValue('MX', match[2]), priority: Number(match[1]) };
  }
  if (raw.type === 'SRV') {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(raw.value);
    if (!match) throw invalid('SRV record');
    return {
      ...common,
      value: canonicalValue('SRV', match[4]),
      priority: Number(match[1]),
      weight: Number(match[2]),
      port: Number(match[3]),
    };
  }
  return { ...common, value: canonicalValue(raw.type, raw.value) };
}
// 101domain returns hostnames fully qualified ("mx.example.net.") and TXT as
// quoted character-strings ("\"v=spf1 -all\""), but accepts both bare. Read and
// compare them bare, so a record written as read back is left unchanged.
function canonicalValue(type: string, value: string): string {
  const kind = type.toUpperCase();
  if (kind === 'TXT') return unquoteTxt(value);
  if (['CNAME', 'NS', 'MX', 'SRV'].includes(kind)) return value.replace(/\.$/, '');
  return value;
}
// A TXT value made only of quoted strings ("a" "b"), joined and unescaped; any
// other value is returned as is.
function unquoteTxt(value: string): string {
  const chunk = /"((?:[^"\\]|\\.)*)"/g;
  if (!/^\s*"(?:[^"\\]|\\.)*"(?:\s+"(?:[^"\\]|\\.)*")*\s*$/.test(value)) return value;
  return [...value.matchAll(chunk)].map(m => m[1].replace(/\\(.)/g, '$1')).join('');
}
// The API's write shape for a record. `strict` applies the write rules; an
// existing record is read with it off, only to compare against.
function recordSpec(record: DnsRecord, domain: string, strict = true): RecordSpec {
  const type = record.type.toUpperCase();
  const zone = normalizeDomain(domain);
  let name = record.name.trim().toLowerCase().replace(/\.$/, '');
  if (name === zone || name === '@') name = '';
  else if (name.endsWith('.' + zone)) name = name.slice(0, -zone.length - 1);
  const reject = (message: string) => {
    if (strict) throw new ConfigurationError(`101domain: ${message}`);
  };
  if (
    !['A', 'AAAA', 'CNAME', 'NS', 'MX', 'TXT', 'SRV', 'CAA'].includes(type) ||
    (type === 'NS' && !name)
  )
    reject('unsupported DNS type or apex NS record');
  const ttl = record.ttl ?? 3600;
  if (!Number.isInteger(ttl) || (ttl !== 1 && ttl < 300))
    reject('DNS TTL must be at least 300 seconds');
  const result: RecordSpec = { name, type, ttl };
  if (type === 'MX' || type === 'SRV') {
    if (!Number.isInteger(record.priority) || record.priority! < 0 || record.priority! > 65535)
      reject('MX/SRV priority is required');
    result.priority = record.priority!;
    result.target = canonicalValue(type, record.value);
    if (type === 'SRV') {
      if (![record.weight, record.port].every(n => Number.isInteger(n) && n! >= 0 && n! <= 65535))
        reject('SRV weight and port are required');
      result.weight = record.weight!;
      result.port = record.port!;
    }
  } else if (type === 'CAA') {
    const match = /^(\d+)\s+(\w+)\s+"([\s\S]*)"$/.exec(record.value);
    if (!match || Number(match[1]) > 255) {
      reject('CAA needs flags, tag and quoted value');
      result.value = record.value;
    } else {
      result.flag = Number(match[1]);
      result.tag = match[2];
      result.value = match[3];
    }
  } else result.value = canonicalValue(type, record.value);
  return result;
}
function recordSignature(record: RecordSpec): string {
  return JSON.stringify(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

import {
  ConfigurationError,
  ConnectionError,
  InvalidResponseError,
  NotFoundError,
  ParsingError,
  RateLimitError,
  RegistrarError,
  toRegistrarError,
} from '../errors';
import { Feature, type RegistrarFeature } from '../features';
import { HttpClient, type RequestConfig } from '../http';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import type {
  ConfigField,
  ConnectionResult,
  Contact,
  ContactSet,
  DnsRecord,
  Domain,
  DomainAvailability,
  ListDomainsOptions,
  OperationResult,
  RegisterDomainInput,
  RegistrarCredentials,
  RegistrarOptions,
  RequestOptions,
  TldPricing,
  TransferDomainInput,
} from '../types';
import { createDomain, filterDomains, normalizeDomain } from '../utils';

// Core v1 schema: https://docs.name.com/api/v1/namecom.api.yaml
interface NamecomContact {
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  fax?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}
interface NamecomDomain {
  domainName: string;
  createDate?: string;
  expireDate?: string;
  autorenewEnabled?: boolean;
  locked?: boolean;
  locks?: string[];
  privacyEnabled?: boolean;
  nameservers?: string[];
  contacts?: Partial<Record<keyof ContactSet, NamecomContact>>;
}
interface NamecomPricing {
  premium?: boolean;
  purchasePrice?: number | null;
  renewalPrice?: number | null;
  transferPrice?: number | null;
}
interface NamecomTldPricing {
  tld: string;
  duration: number;
  registrationPrice?: number | null;
  renewalPrice?: number | null;
  transferInPrice?: number | null;
}
interface NamecomRecord {
  id?: number;
  type: string;
  host?: string | null;
  answer: string;
  ttl?: number;
  priority?: number;
}
interface NamecomAvailability {
  domainName: string;
  purchasable?: boolean;
  premium?: boolean;
  purchaseType?: string;
  purchasePrice?: number;
}

// Preserve shared typed HTTP errors without exposing response bodies: upstream
// errors can echo contacts, tokens or EPP codes. Core uses X-RateLimit-Reset.
class NamecomHttpClient extends HttpClient {
  override async request<T = unknown>(req: RequestConfig): Promise<T> {
    try {
      return await super.request<T>(req);
    } catch (error) {
      if (error instanceof ParsingError) throw new ParsingError('namecom: invalid JSON response');
      if (error instanceof ConnectionError)
        throw new ConnectionError('namecom: network request failed', { notSent: error.notSent });
      throw error;
    }
  }

  protected override async toStatusError(response: Response, url: string): Promise<RegistrarError> {
    await response.body?.cancel().catch(() => undefined);
    const error = await super.toStatusError(
      new Response(null, {
        status: response.status,
        headers: response.headers,
      }),
      url
    );
    if (error instanceof RateLimitError) {
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter == null ? NaN : Number(retryAfter);
      const date = retryAfter == null ? NaN : Date.parse(retryAfter);
      const reset = response.headers.get('x-ratelimit-reset');
      error.retryAfter = Number.isFinite(seconds)
        ? Math.max(0, seconds)
        : Number.isFinite(date)
          ? Math.max(0, (date - Date.now()) / 1000)
          : reset != null && Number.isFinite(Number(reset))
            ? Math.max(0, Number(reset) - Date.now() / 1000)
            : undefined;
    }
    return error;
  }
}

export class NamecomRegistrar extends BaseRegistrar {
  readonly name = 'namecom';
  static readonly displayName = 'Name.com';
  static readonly website = 'name.com';
  static readonly supportsSandbox = true;
  static readonly configFields: ConfigField[] = [
    { name: 'username', label: 'Username', type: 'text', required: true },
    { name: 'apiToken', label: 'API token', type: 'password', required: true },
  ];
  static readonly helpText =
    'Get an API token at https://www.name.com/account/settings/api. ' +
    'Accounts with 2FA must enable API Access. Sandbox requires your -test username ' +
    'and a separate sandbox token; select the sandbox environment explicitly.';
  static override readonly extendedFeatures: readonly RegistrarFeature[] = [Feature.GetAuthCode];
  override readonly requiresNameserversFetch = false;

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    const username = credentials.username ?? '';
    if (username.includes(':'))
      throw new ConfigurationError('namecom: username cannot contain a colon');
    const auth = btoa(
      Array.from(new TextEncoder().encode(`${username}:${credentials.apiToken ?? ''}`), byte =>
        String.fromCharCode(byte)
      ).join('')
    );
    const config = {
      baseUrl: selectBaseUrl('namecom', options?.environment, {
        production: 'https://api.name.com/core/v1',
        sandbox: 'https://api.dev.name.com/core/v1',
      }),
      headers: { Authorization: `Basic ${auth}` },
    };
    super(credentials, config, options);
    this.http = new NamecomHttpClient({ ...config, options: this.options });
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      // hello is a connectivity check; listing verifies account access.
      await this.http.request({ path: '/domains', query: { perPage: 1, page: 1 }, ...opts });
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const { search, detailed: _detailed, ...requestOpts } = opts ?? {};
    const domains = await this.pages<NamecomDomain>('/domains', 'domains', requestOpts);
    return filterDomains(
      domains.map(d => this.toDomain(d)),
      search
    );
  }

  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    return this.toDomain(await this.rawDomain(domainName, opts));
  }

  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    return (await this.getDomain(domainName, opts)).nameservers;
  }

  override async getAuthCode(domainName: string, opts?: RequestOptions): Promise<string> {
    const result = await this.http.request<{ authCode?: string }>({
      path: `${domainPath(domainName)}:getAuthCode`,
      ...opts,
    });
    if (!result?.authCode) throw new InvalidResponseError('namecom: missing authorization code');
    return result.authCode;
  }

  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const results: DomainAvailability[] = [];
    for (let i = 0; i < domainNames.length; i += 50) {
      const res = await this.http.request<{ results?: NamecomAvailability[] }>({
        method: 'POST',
        path: '/domains:checkAvailability',
        body: {
          domainNames: domainNames.slice(i, i + 50).map(normalizeDomain),
          purchaseType: 'registration',
        },
        ...opts,
      });
      if (!Array.isArray(res?.results))
        throw new InvalidResponseError('namecom: missing availability results');
      results.push(
        ...res.results.map(r => ({
          domainName: r.domainName,
          available:
            (r.purchasable ?? false) && (!r.purchaseType || r.purchaseType === 'registration'),
          premium: r.premium ?? false,
          price: price(r.purchasePrice),
          currency: 'USD',
          // Discovery quotes the TLD's minimum term, which isn't always one year.
        }))
      );
    }
    return results;
  }

  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    const name = normalizeDomain(tldOrDomain);
    if (name.startsWith('.') || !name.includes('.')) {
      const tld = name.replace(/^\./, '');
      const entries = await this.pages<NamecomTldPricing>('/tldpricing', 'pricing', opts, {
        tlds: tld,
        duration: 1,
      });
      const entry = entries.find(p => p.tld.toLowerCase() === tld && p.duration === 1);
      if (!entry) throw new NotFoundError(`namecom: no one-year pricing for .${tld}`);
      return {
        tld,
        currency: 'USD',
        registration: price(entry.registrationPrice),
        renewal: price(entry.renewalPrice),
        transfer: price(entry.transferInPrice),
      };
    }
    const result = await this.domainPricing(name, 1, opts);
    return {
      tld: name.slice(name.indexOf('.') + 1),
      currency: 'USD',
      registration: price(result.purchasePrice),
      renewal: price(result.renewalPrice),
      transfer: price(result.transferPrice),
    };
  }

  override async registerDomain(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const years = validYears(input.years ?? 1);
    if (!input.contacts.registrant)
      throw new ConfigurationError('namecom: a registrant contact is required');
    const contacts = toContacts(input.contacts);
    const availability = (await this.checkAvailability([domainName], opts)).find(
      result => normalizeDomain(result.domainName) === normalizeDomain(domainName)
    );
    if (!availability?.available)
      return { success: false, message: 'namecom: domain is not available for registration' };
    const pricing = await this.domainPricing(domainName, years, opts);
    const purchasePrice = purchaseQuote(pricing, 'purchasePrice', availability.premium);
    return this.purchase(
      '/domains',
      {
        domain: {
          domainName: normalizeDomain(domainName),
          contacts,
          nameservers: input.nameservers,
          privacyEnabled: input.privacy,
          autorenewEnabled: input.autoRenew,
        },
        purchaseType: 'registration',
        years,
        purchasePrice,
      },
      domainName,
      'registration',
      opts
    );
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    validYears(years);
    const pricing = await this.domainPricing(domainName, years, opts);
    return this.purchase(
      `${domainPath(domainName)}:renew`,
      {
        years,
        purchasePrice: purchaseQuote(pricing, 'renewalPrice'),
      },
      domainName,
      'renewal',
      opts
    );
  }

  override async transferIn(
    domainName: string,
    input: TransferDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (!input.authCode) throw new ConfigurationError('namecom: an authorization code is required');
    // Core's transfer request accepts none of these. Never silently discard them
    // or perform a paid transfer followed by a potentially failing settings write.
    if (input.years != null || input.contacts != null || input.autoRenew != null) {
      throw new ConfigurationError(
        'namecom: transferIn does not accept years, contacts or autoRenew; the registry determines the term'
      );
    }
    const pricing = await this.domainPricing(domainName, undefined, opts);
    return this.purchase(
      '/transfers',
      {
        domainName: normalizeDomain(domainName),
        authCode: input.authCode,
        privacyEnabled: input.privacy,
        purchasePrice: purchaseQuote(pricing, 'transferPrice'),
      },
      domainName,
      'transfer',
      opts
    );
  }

  override setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.patchDomain(domainName, { autorenewEnabled: enabled }, opts);
  }
  override lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.patchDomain(domainName, { locked: true }, opts);
  }
  override unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.patchDomain(domainName, { locked: false }, opts);
  }
  override setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.patchDomain(domainName, { privacyEnabled: enabled }, opts);
  }
  override updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      { method: 'POST', path: `${domainPath(domainName)}:setNameservers`, body: { nameservers } },
      opts
    );
  }
  override async getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    const result: ContactSet = {};
    const raw = await this.rawDomain(domainName, opts);
    for (const role of CONTACT_ROLES) {
      const c = raw.contacts?.[role];
      if (c)
        result[role] = {
          firstName: c.firstName ?? '',
          lastName: c.lastName ?? '',
          organization: c.companyName ?? undefined,
          email: c.email ?? '',
          phone: c.phone ?? '',
          fax: c.fax ?? undefined,
          address1: c.address1 ?? '',
          address2: c.address2 ?? undefined,
          city: c.city ?? '',
          state: c.state ?? undefined,
          postalCode: c.zip ?? '',
          country: c.country ?? '',
        };
    }
    return result;
  }
  override updateContacts(
    domainName: string,
    contacts: ContactSet,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'POST',
        path: `${domainPath(domainName)}:setContacts`,
        body: { contacts: toContacts(contacts) },
      },
      opts
    );
  }

  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    return (
      await this.pages<NamecomRecord>(`${domainPath(domainName)}/records`, 'records', opts)
    ).map(fromRecord);
  }

  // No bulk replace endpoint. Reconcile by id: preserve identical records, update
  // existing type/host pairs, create additions, then delete stale records. This
  // avoids duplicate-record errors and does not empty the zone before creation.
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    // Validate all input, then collapse exact duplicates to avoid duplicate-create
    // errors when an identical record already exists in the zone.
    const desired = records
      .map(toRecord)
      .filter((record, index, all) => all.findIndex(other => sameRecord(other, record)) === index);
    try {
      const path = `${domainPath(domainName)}/records`;
      const existing = await this.pages<NamecomRecord>(path, 'records', opts);
      if (existing.some(r => !Number.isInteger(r.id) || r.id! <= 0))
        throw new InvalidResponseError('namecom: DNS response missing record ids');
      const remaining = [...existing];
      const pending: NamecomRecord[] = [];
      for (const record of desired) {
        const index = remaining.findIndex(r => sameRecord(r, record));
        if (index >= 0) remaining.splice(index, 1);
        else if (!pending.some(r => sameRecord(r, record))) pending.push(record);
      }
      for (const record of pending) {
        const index = remaining.findIndex(r => recordKey(r) === recordKey(record));
        const old = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
        await this.http.request({
          ...opts,
          method: old ? 'PUT' : 'POST',
          path: old ? `${path}/${old.id!}` : path,
          body: record,
        });
      }
      for (const old of remaining) {
        await this.http.request({
          ...opts,
          method: 'DELETE',
          path: `${path}/${old.id!}`,
        });
      }
      return { success: true, message: 'DNS records updated successfully' };
    } catch (error) {
      return {
        success: false,
        message: `${toRegistrarError(error).message}. DNS replacement is not atomic; read the zone before retrying.`,
      };
    }
  }

  private patchDomain(
    domainName: string,
    body: Record<string, boolean>,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate({ method: 'PATCH', path: domainPath(domainName), body }, opts);
  }
  private rawDomain(domainName: string, opts?: RequestOptions): Promise<NamecomDomain> {
    return this.http.request({ path: domainPath(domainName), ...opts });
  }
  private domainPricing(
    domainName: string,
    years: number | undefined,
    opts?: RequestOptions
  ): Promise<NamecomPricing> {
    return this.http.request({
      path: `${domainPath(domainName)}:getPricing`,
      query: { years },
      ...opts,
    });
  }
  private toDomain(d: NamecomDomain): Domain {
    if (!d?.domainName)
      throw new InvalidResponseError('namecom: domain response missing domainName');
    return createDomain({
      domainName: normalizeDomain(d.domainName),
      registrar: this.name,
      // Core exposes locks, not a lifecycle status or a scheduled renewal date.
      status: (d.locks ?? []).join(','),
      createdDate: d.createDate,
      expirationDate: d.expireDate,
      autoRenew: d.autorenewEnabled ?? false,
      locked: d.locked ?? false,
      privacy: d.privacyEnabled ?? false,
      nameservers: d.nameservers,
    });
  }
  private async pages<T>(
    path: string,
    key: string,
    opts?: RequestOptions,
    query?: RequestConfig['query']
  ): Promise<T[]> {
    const result: T[] = [];
    let page = 1;
    while (true) {
      const res = await this.http.request<{ nextPage?: number | null; [key: string]: unknown }>({
        path,
        query: { perPage: 1000, page, ...query },
        ...opts,
      });
      const items = res?.[key];
      // Empty protobuf arrays may be omitted, but a malformed collection is an error.
      if (!res || (items != null && !Array.isArray(items)))
        throw new InvalidResponseError('namecom: invalid list response');
      result.push(...((items ?? []) as T[]));
      const next = res.nextPage;
      if (next == null || next === 0) return result;
      if (!Number.isInteger(next) || next <= page)
        throw new InvalidResponseError('namecom: invalid pagination cursor');
      page = next;
    }
  }
  private async mutate(req: RequestConfig, opts?: RequestOptions): Promise<OperationResult> {
    try {
      await this.http.request({ ...req, ...opts });
      return { success: true, message: 'Domain updated successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }
  private async purchase(
    path: string,
    body: unknown,
    domainName: string,
    operation: string,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const res = await this.http.request<{
        order?: number;
        domain?: NamecomDomain;
        transfer?: { domainName: string };
      }>({
        method: 'POST',
        path,
        body,
        ...opts,
        retries: 0,
      });
      const returnedName = res?.domain?.domainName ?? res?.transfer?.domainName;
      if (
        !Number.isInteger(res?.order) ||
        (res.order ?? 0) <= 0 ||
        !returnedName ||
        normalizeDomain(returnedName) !== normalizeDomain(domainName)
      ) {
        throw new InvalidResponseError(
          'namecom: purchase response missing order or matching domain'
        );
      }
      return {
        success: true,
        message: `Domain ${operation} request accepted (order ${res.order!}); verify final domain/transfer status`,
      };
    } catch (error) {
      const e = toRegistrarError(error);
      // 4xx rejects are definitive; transport, parse, abort and 5xx failures may
      // arrive after the order was charged. Never repeat the paid request here.
      const uncertain =
        e.status < 0 ||
        e.status === 408 ||
        e.status >= 500 ||
        e.name === 'AbortError' ||
        e instanceof ParsingError;
      return {
        success: false,
        message:
          e.message +
          (uncertain
            ? '. Outcome unknown; check Name.com orders and domain/transfer status before retrying.'
            : ''),
      };
    }
  }
}

const CONTACT_ROLES = ['registrant', 'admin', 'tech', 'billing'] as const;
function toContacts(contacts: ContactSet): Partial<Record<keyof ContactSet, NamecomContact>> {
  const result: Partial<Record<keyof ContactSet, NamecomContact>> = {};
  for (const role of CONTACT_ROLES) {
    const c = contacts[role];
    if (!c) continue;
    // Core requires complete contact objects, including state. Normalize the
    // library's EPP-style +1.555... phone to Core's E.164 +1555... format.
    const required: (keyof Contact)[] = [
      'firstName',
      'lastName',
      'email',
      'phone',
      'address1',
      'city',
      'state',
      'postalCode',
      'country',
    ];
    if (required.some(k => !c[k]?.trim()))
      throw new ConfigurationError(`namecom: ${role} must be a complete contact, including state`);
    result[role] = {
      firstName: c.firstName,
      lastName: c.lastName,
      companyName: c.organization,
      email: c.email,
      phone: c.phone.replace('.', ''),
      fax: c.fax?.replace('.', ''),
      address1: c.address1,
      address2: c.address2,
      city: c.city,
      state: c.state,
      zip: c.postalCode,
      country: c.country.toUpperCase(),
    };
  }
  if (Object.keys(result).length === 0)
    throw new ConfigurationError('namecom: at least one contact is required');
  return result;
}
function domainPath(domainName: string): string {
  return `/domains/${encodeURIComponent(normalizeDomain(domainName))}`;
}
function validYears(years: number): number {
  if (!Number.isInteger(years) || years < 1 || years > 10)
    throw new ConfigurationError('namecom: years must be an integer from 1 to 10');
  return years;
}
function price(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function purchaseQuote(
  pricing: NamecomPricing,
  field: 'purchasePrice' | 'renewalPrice' | 'transferPrice',
  premium = false
): number | undefined {
  const value = price(pricing?.[field]);
  if (value == null)
    throw new RegistrarError(
      `namecom: ${field} unavailable for the requested term; no purchase submitted`
    );
  return premium || pricing.premium ? value : undefined;
}
const DNS_TYPES = new Set(['A', 'AAAA', 'ANAME', 'CNAME', 'MX', 'NS', 'SRV', 'TXT']);
function toRecord(r: DnsRecord): NamecomRecord {
  const type = r.type.toUpperCase();
  if (!DNS_TYPES.has(type))
    throw new ConfigurationError(`namecom: DNS type ${type} is not supported`);
  const ttl = r.ttl ?? 300;
  if (!Number.isInteger(ttl) || ttl < 300)
    throw new ConfigurationError('namecom: DNS TTL must be an integer of at least 300 seconds');
  for (const value of [r.priority, r.weight, r.port]) {
    if (value != null && (!Number.isInteger(value) || value < 0 || value > 65535))
      throw new ConfigurationError('namecom: invalid DNS priority, weight or port');
  }
  if (!r.value.trim()) throw new ConfigurationError('namecom: DNS answer is required');
  return {
    type,
    host: !r.name || r.name === '@' ? '' : r.name,
    answer: type === 'SRV' ? `${r.weight ?? 0} ${r.port ?? 0} ${r.value}` : r.value,
    ttl,
    ...(['MX', 'SRV'].includes(type) ? { priority: r.priority ?? 0 } : {}),
  };
}
function fromRecord(r: NamecomRecord): DnsRecord {
  const type = r.type.toUpperCase();
  const record: DnsRecord = { type, name: r.host || '@', value: r.answer, ttl: r.ttl };
  if (type === 'MX' || type === 'SRV') record.priority = r.priority ?? 0;
  if (type === 'SRV') {
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(r.answer);
    if (!match) throw new InvalidResponseError('namecom: invalid SRV answer');
    record.weight = Number(match[1]);
    record.port = Number(match[2]);
    record.value = match[3];
  }
  return record;
}
function recordKey(r: NamecomRecord): string {
  return `${r.type.toUpperCase()}\0${(r.host === '@' ? '' : (r.host ?? '')).toLowerCase()}`;
}
function sameRecord(a: NamecomRecord, b: NamecomRecord): boolean {
  return (
    recordKey(a) === recordKey(b) &&
    a.answer === b.answer &&
    (a.ttl ?? 300) === (b.ttl ?? 300) &&
    (a.priority ?? 0) === (b.priority ?? 0)
  );
}

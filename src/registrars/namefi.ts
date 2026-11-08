import {
  ConfigurationError,
  ConnectionError,
  InvalidResponseError,
  NotFoundError,
  NotImplementedError,
  OutcomeUnknownError,
  ParsingError,
  RegistrarError,
  failedResult,
} from '../errors';
import { prepareEntry, toDnsEntry, findCnameConflicts } from '../dns-records';
import { HttpClient, REST_SAFE_METHODS, type RequestConfig } from '../http';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import type {
  ConfigField,
  ContactSet,
  DomainForward,
  RegisterDomainInput,
  TransferDomainInput,
  SetPrivacyOptions,
  ConnectionResult,
  DnsRecord,
  Domain,
  DomainAvailability,
  ListDomainsOptions,
  OperationResult,
  RegistrarCredentials,
  RegistrarOptions,
  RequestOptions,
  TldPricing,
} from '../types';
import { createDomain, filterDomains, normalizeDomain } from '../utils';

// Public v-next contract: https://api.namefi.io/v-next/openapi/doc.json.
// Reads include both NFT-held and email-held domains. Never expose holder IDs,
// payment details, wallet addresses or raw upstream errors in normalized data.
interface RawDomain {
  normalizedDomainName: string;
  expirationDate: string | null;
  autoRenewEnabled: boolean;
  dnsStatus: { nameservers: string[] };
}
interface RawRecord {
  id: string;
  zoneName: string;
  name: string;
  type: string;
  rdata: string;
  ttl: number;
  metadata?: unknown;
}
interface Money {
  amount: number;
  currency: string;
}
interface Price {
  type: 'PER_YEAR' | 'MULTI_YEAR';
  price: Money | Record<string, Money>;
}
interface Availability {
  domain: string;
  availability: boolean;
  supported: boolean;
  isPremium?: boolean;
  pricingDetails?: {
    registrationPrice: Price;
    renewalPrice: Price;
    importPrice: Price;
  };
}
interface RecordSpec {
  type: string;
  name: string;
  rdata: string;
  ttl: number;
}

class NamefiHttpClient extends HttpClient {
  override async request<T = unknown>(req: RequestConfig): Promise<T> {
    try {
      const send = req.fetch ?? this.config.options.fetch ?? globalThis.fetch;
      return await super.request<T>({
        ...req,
        fetch: (input, init) => send(input, { ...init, redirect: 'manual' }),
      });
    } catch (error) {
      if (error instanceof ParsingError) {
        if (this.intentOf(req) === 'write')
          throw new OutcomeUnknownError(
            'namefi: invalid JSON after a write; re-read before retrying',
            { feature: req.call?.feature }
          );
        throw new ParsingError('namefi: invalid JSON response');
      }
      if (error instanceof ConnectionError)
        throw new ConnectionError('namefi: network request failed', {
          notSent: error.notSent,
        });
      throw error;
    }
  }
  protected override async toStatusError(response: Response, url: string): Promise<RegistrarError> {
    await response.body?.cancel().catch(() => undefined);
    // A refused redirect is a 3xx in Node and Workers, but an opaque status-0
    // response in browsers, which `new Response` rejects with a RangeError.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
      return new InvalidResponseError(`namefi: request to '${url}' was redirected; refused`);
    return super.toStatusError(
      new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      url
    );
  }
}

export class NamefiRegistrar extends BaseRegistrar {
  readonly name = 'namefi';
  override readonly requiresNameserversFetch = false;
  static override readonly safeMethods = REST_SAFE_METHODS;
  static readonly displayName = 'Namefi';
  static readonly website = 'namefi.io';
  static readonly supportsSandbox = false;
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
  ];
  static readonly helpText =
    'Create a Plain API Key at https://namefi.io/api-keys. Keys can spend NFSC and charge saved cards. ' +
    'Lists email-held and NFT-held domains. Supports inventory, details, nameserver reads, ' +
    'availability, domain pricing, DNS records and auto-renew. Use Namefi for registration, ' +
    'manual renewal, transfers, delegation changes, contacts, privacy and transfer locks.';

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    const apiKey = credentials.apiKey?.trim() ?? '';
    if (/[\r\n]/.test(apiKey)) throw new ConfigurationError('namefi: provide a valid API key');
    const config = {
      baseUrl: selectBaseUrl('namefi', options?.environment, {
        production: 'https://api.namefi.io/v-next',
      }),
      headers: { 'x-api-key': apiKey },
    };
    super(credentials, config, options);
    this.http = new NamefiHttpClient({
      ...config,
      safeMethods: REST_SAFE_METHODS,
      options: this.options,
    });
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      const user = await this.http.request<{ id?: unknown }>({
        ...opts,
        path: '/user',
      });
      if (!user || typeof user.id !== 'string' || !user.id) throw invalid('account');
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return failedResult(error);
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const { search, detailed: _detailed, ...requestOpts } = opts ?? {};
    const rows = await this.http.request<RawDomain[]>({
      ...requestOpts,
      path: '/user/domains',
    });
    if (!Array.isArray(rows)) throw invalid('domain list');
    const domains = rows.map(toDomain);
    // The endpoint promises the complete personal inventory without pagination.
    // Duplicate ownership rows must not become duplicate portfolio entries.
    if (new Set(domains.map(d => d.domainName)).size !== domains.length)
      throw invalid('duplicate domain');
    return filterDomains(domains, search);
  }

  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    const name = domain(domainName);
    const found = (await this.listDomains(opts)).find(d => d.domainName === name);
    if (!found) throw new NotFoundError('namefi: domain is not in this account');
    return found;
  }
  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    return (await this.getDomain(domainName, opts)).nameservers;
  }

  override async checkAvailability(
    names: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const results: DomainAvailability[] = [];
    for (const name of [...new Set(names.map(domain))]) {
      const raw = await this.availability(name, opts);
      const registration = oneYear(raw.pricingDetails?.registrationPrice);
      const renewal = oneYear(raw.pricingDetails?.renewalPrice);
      if (registration && renewal && registration.currency !== renewal.currency)
        throw invalid('price currency');
      results.push({
        domainName: name,
        available: raw.supported && raw.availability,
        premium: raw.isPremium,
        price: registration?.amount,
        renewalPrice: renewal?.amount,
        currency: registration?.currency ?? renewal?.currency,
        period: 1,
      });
    }
    return results;
  }

  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    // A made-up name cannot establish a TLD or owned-domain renewal rate.
    const normalized = normalizeDomain(tldOrDomain);
    if (!normalized.includes('.') || normalized.startsWith('.'))
      throw new NotImplementedError('namefi: pricing is per-domain only; pass a full domain name');
    const name = domain(tldOrDomain);
    const raw = await this.availability(name, opts);
    const registration = oneYear(raw.pricingDetails?.registrationPrice);
    const renewal = oneYear(raw.pricingDetails?.renewalPrice);
    const transfer = oneYear(raw.pricingDetails?.importPrice);
    const prices = [registration, renewal, transfer].filter((p): p is Money => !!p);
    if (!prices.length) throw new NotFoundError('namefi: no annual pricing for this domain');
    if (prices.some(p => p.currency !== prices[0].currency)) throw invalid('price currency');
    return {
      tld: name.slice(name.indexOf('.') + 1),
      currency: prices[0].currency,
      registration: registration?.amount,
      renewal: renewal?.amount,
      transfer: transfer?.amount,
    };
  }
  private async availability(name: string, opts?: RequestOptions): Promise<Availability> {
    const raw = await this.http.request<Availability>({
      ...opts,
      path: '/search/availability',
      query: { domain: name },
    });
    if (
      !raw ||
      raw.domain !== name ||
      typeof raw.availability !== 'boolean' ||
      typeof raw.supported !== 'boolean'
    )
      throw invalid('availability identity');
    return raw;
  }

  override async registerDomain(
    name: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const normalizedDomainName = domain(name);
    const durationInYears = input.years ?? 1;
    if (!Number.isInteger(durationInYears) || durationInYears < 1 || durationInYears > 10)
      throw new ConfigurationError('namefi: registration requires 1–10 whole years');
    if (Object.keys(input.contacts ?? {}).length)
      throw new ConfigurationError(
        'namefi: registration uses saved Namefi profile contacts; pass contacts: {} to use them'
      );
    if (input.privacy !== undefined)
      throw new ConfigurationError('namefi: registration cannot override WHOIS privacy');
    const domainSetupOptions: { autoRenew?: boolean; nameservers?: string[] } = {};
    if (input.autoRenew !== undefined) domainSetupOptions.autoRenew = input.autoRenew;
    if (input.nameservers !== undefined) {
      if (!input.nameservers.length || input.nameservers.length > 13)
        throw new ConfigurationError('namefi: provide 1–13 nameservers');
      domainSetupOptions.nameservers = [...new Set(input.nameservers.map(ns => domain(ns) + '.'))];
    }
    try {
      const order = await this.http.request<{
        id: string;
        items: {
          normalizedDomainName: string;
          durationInYears: number;
          type: string;
          status: string | null;
        }[];
      }>({
        ...opts,
        method: 'POST',
        path: '/orders/register-domain',
        body: {
          normalizedDomainName,
          durationInYears,
          ...(Object.keys(domainSetupOptions).length ? { domainSetupOptions } : {}),
        },
      });
      if (
        !order ||
        typeof order.id !== 'string' ||
        !/^[a-zA-Z0-9-]+$/.test(order.id) ||
        !Array.isArray(order.items) ||
        order.items.length !== 1 ||
        order.items[0]?.normalizedDomainName !== normalizedDomainName ||
        order.items[0].durationInYears !== durationInYears ||
        order.items[0].type !== 'REGISTER'
      )
        throw new OutcomeUnknownError(
          'namefi: registration order identity was not confirmed; check Namefi orders before retrying'
        );
      const status = order.items[0].status;
      if (status === 'FAILED' || status === 'CANCELLED')
        return {
          success: false,
          message: `Namefi registration order ${order.id} ${status.toLowerCase()}; check its payment status in Namefi`,
        };
      if (status !== null && !['CREATED', 'PROCESSING', 'SUCCEEDED'].includes(status))
        throw new OutcomeUnknownError(
          'namefi: registration order has an unrecognized outcome; check Namefi orders before retrying'
        );
      return {
        success: true,
        ...(status === 'SUCCEEDED' ? {} : { pending: true }),
        message:
          status === 'SUCCEEDED'
            ? 'Domain registration completed'
            : `Namefi registration order ${order.id} accepted and pending; check Namefi orders, do not submit it again`,
      };
    } catch (error) {
      return failed(error);
    }
  }

  override async setAutoRenew(
    name: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const normalizedDomainName = domain(name);
      // Confirm current ownership before changing a domain configuration.
      await this.getDomain(normalizedDomainName, opts);
      const result = await this.http.request<{ success: boolean }>({
        ...opts,
        method: 'PUT',
        path: '/domain-config/auto-renew',
        body: { normalizedDomainName, enableAutoRenew: enabled },
      });
      if (result?.success !== true)
        throw new OutcomeUnknownError(
          'namefi: auto-renew change was not confirmed; re-read before retrying'
        );
      return { success: true, message: 'Auto-renew updated' };
    } catch (error) {
      return failed(error);
    }
  }

  override renewDomain(
    _name: string,
    _years?: number,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        'namefi: manual renewal is not available through the public REST API; use Namefi checkout'
      )
    );
  }
  override transferIn(
    _name: string,
    _input: TransferDomainInput,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError('namefi: transfer-in is not available through the public REST API')
    );
  }
  override updateNameservers(
    _name: string,
    _nameservers: string[],
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError('namefi: no public post-registration nameserver-delegation endpoint')
    );
  }
  override lockDomain(_name: string, _opts?: RequestOptions): Promise<OperationResult> {
    return Promise.reject(new NotImplementedError('namefi: no public transfer-lock endpoint'));
  }
  override unlockDomain(_name: string, _opts?: RequestOptions): Promise<OperationResult> {
    return Promise.reject(new NotImplementedError('namefi: no public transfer-lock endpoint'));
  }
  override setPrivacy(
    _name: string,
    _enabled: boolean,
    _opts?: SetPrivacyOptions
  ): Promise<OperationResult> {
    return Promise.reject(new NotImplementedError('namefi: no public WHOIS-privacy endpoint'));
  }
  override getContacts(_name: string, _opts?: RequestOptions): Promise<ContactSet> {
    return Promise.reject(new NotImplementedError('namefi: no public per-domain contact endpoint'));
  }
  override updateContacts(
    _name: string,
    _contacts: ContactSet,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(new NotImplementedError('namefi: no public per-domain contact endpoint'));
  }

  override getDomainForwarding(_name: string, _opts?: RequestOptions): Promise<DomainForward[]> {
    return Promise.reject(
      new NotImplementedError(
        'namefi: managed forwarding is not wired up; its HTTP redirect mode is not mapped'
      )
    );
  }
  override setDomainForwarding(
    _name: string,
    _forwards: DomainForward[],
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        'namefi: managed forwarding is not wired up; its HTTP redirect mode is not mapped'
      )
    );
  }

  override async getDnsRecords(name: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const zoneName = domain(name);
    // DNS reads are public; confirm the zone belongs to this account first.
    await this.getDomain(zoneName, opts);
    return (await this.records(zoneName, opts)).map(fromRecord);
  }
  private async records(zoneName: string, opts?: RequestOptions): Promise<RawRecord[]> {
    const rows = await this.http.request<RawRecord[]>({
      ...opts,
      path: '/dns/records',
      query: { zoneName },
    });
    if (!Array.isArray(rows)) throw invalid('DNS records');
    const ids = new Set<string>();
    for (const row of rows) {
      if (
        !row ||
        typeof row.id !== 'string' ||
        !row.id ||
        ids.has(row.id) ||
        row.zoneName !== zoneName ||
        typeof row.name !== 'string' ||
        typeof row.type !== 'string' ||
        typeof row.rdata !== 'string' ||
        !Number.isInteger(row.ttl) ||
        row.ttl < 0
      )
        throw invalid('DNS record identity');
      ids.add(row.id);
    }
    return rows;
  }

  override async setDnsRecords(
    name: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const zoneName = domain(name);
    const desired = records.map(toSpec);
    if (findCnameConflicts(records.map(r => toDnsEntry(r))).length)
      throw new ConfigurationError('namefi: conflicting CNAME records');
    if (new Set(desired.map(signature)).size !== desired.length)
      throw new ConfigurationError('namefi: duplicate DNS records');
    let changed = false;
    try {
      await this.getDomain(zoneName, opts);
      const stale = [...(await this.records(zoneName, opts))];
      const additions: RecordSpec[] = [];
      for (const spec of desired) {
        const match = stale.findIndex(r => signature(rawSpec(r)) === signature(spec));
        if (match >= 0) stale.splice(match, 1);
        else additions.push(spec);
      }
      const edits: { id: string; spec: RecordSpec }[] = [];
      const creates: RecordSpec[] = [];
      for (const spec of additions) {
        const prior = stale.findIndex(
          r => !protectedRecord(r) && rawSpec(r).name === spec.name && r.type === spec.type
        );
        if (prior < 0) creates.push(spec);
        else edits.push({ id: stale.splice(prior, 1)[0].id, spec });
      }
      // Managed records (parking, ENS, SOA and delegation) are not safely
      // replaceable through the generic editor. Stop before the first write.
      if (stale.some(protectedRecord) || creates.some(r => ['SOA', 'NS'].includes(r.type)))
        throw new ConfigurationError(
          'namefi: preserve managed, SOA and NS records; change them in your Namefi account'
        );
      if (edits.length) {
        const result = await this.http.request<RawRecord[]>({
          ...opts,
          method: 'PUT',
          path: '/dns/records/batch',
          body: { zoneName, records: edits.map(({ id, spec }) => ({ id, ...spec })) },
        });
        changed = true;
        if (!confirmedRecords(result, zoneName, edits))
          throw new OutcomeUnknownError('namefi: DNS edits were not confirmed');
      }
      if (creates.length) {
        const result = await this.http.request<RawRecord[]>({
          ...opts,
          method: 'POST',
          path: '/dns/records/batch',
          body: { zoneName, records: creates },
        });
        changed = true;
        if (
          !confirmedRecords(
            result,
            zoneName,
            creates.map(spec => ({ spec }))
          )
        )
          throw new OutcomeUnknownError('namefi: DNS creation was not confirmed');
      }
      if (stale.length) {
        const result = await this.http.request<{ success: boolean }>({
          ...opts,
          method: 'DELETE',
          path: '/dns/records/batch',
          body: { zoneName, recordsIds: stale.map(r => r.id) },
        });
        changed = true;
        if (result?.success !== true)
          throw new OutcomeUnknownError('namefi: DNS deletion was not confirmed');
      }
      return { success: true, message: 'DNS records updated' };
    } catch (error) {
      const result = failed(error);
      return changed || result.outcome
        ? {
            ...result,
            message:
              result.message + '. DNS replacement is not atomic; re-read the zone before retrying.',
          }
        : result;
    }
  }
}

function invalid(part: string): InvalidResponseError {
  return new InvalidResponseError(`namefi: invalid ${part} response`);
}
function domain(input: string): string {
  const name = normalizeDomain(input);
  if (
    name.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)
  )
    throw new ConfigurationError('namefi: provide a full ASCII domain name');
  return name;
}
function toDomain(raw: RawDomain): Domain {
  if (
    !raw ||
    typeof raw.normalizedDomainName !== 'string' ||
    typeof raw.autoRenewEnabled !== 'boolean' ||
    !raw.dnsStatus ||
    !Array.isArray(raw.dnsStatus.nameservers) ||
    raw.dnsStatus.nameservers.some(n => typeof n !== 'string') ||
    (raw.expirationDate !== null &&
      (typeof raw.expirationDate !== 'string' || !Number.isFinite(Date.parse(raw.expirationDate))))
  )
    throw invalid('domain');
  const name = domain(raw.normalizedDomainName);
  if (name !== raw.normalizedDomainName) throw invalid('domain identity');
  // Namefi reports no EPP status, creation date, privacy or transfer-lock state.
  return createDomain({
    domainName: name,
    registrar: 'namefi',
    expirationDate: raw.expirationDate,
    autoRenew: raw.autoRenewEnabled,
    nameservers: raw.dnsStatus.nameservers,
    status: 'unknown',
  });
}
function oneYear(raw?: Price): Money | undefined {
  if (!raw) return undefined;
  if (raw.type !== 'PER_YEAR' && raw.type !== 'MULTI_YEAR') throw invalid('price type');
  if (!raw.price || typeof raw.price !== 'object') throw invalid('price');
  const value =
    raw.type === 'PER_YEAR' ? (raw.price as Money) : (raw.price as Record<string, Money>)['1'];
  if (!value) return undefined;
  if (!Number.isFinite(value.amount) || value.amount < 0 || !/^[A-Z]{3}$/.test(value.currency))
    throw invalid('price');
  return value;
}
function fromRecord(raw: RawRecord): DnsRecord {
  const record: DnsRecord = {
    type: raw.type,
    name: raw.name || '@',
    value: raw.rdata,
    ttl: raw.ttl,
  };
  if (raw.type === 'MX' || raw.type === 'SRV') {
    const parts = raw.rdata.trim().split(/\s+/);
    const count = raw.type === 'MX' ? 1 : 3;
    if (parts.length !== count + 1 || parts.slice(0, count).some(v => !/^\d+$/.test(v)))
      throw invalid('DNS rdata');
    record.priority = Number(parts.shift());
    if (raw.type === 'SRV') {
      record.weight = Number(parts.shift());
      record.port = Number(parts.shift());
    }
    record.value = parts.join(' ');
  }
  return record;
}
function toSpec(record: DnsRecord): RecordSpec {
  const entry = prepareEntry(toDnsEntry(record));
  if (
    ![
      'A',
      'AAAA',
      'CNAME',
      'MX',
      'TXT',
      'NS',
      'SOA',
      'PTR',
      'SRV',
      'CAA',
      'DS',
      'TLSA',
      'SSHFP',
      'HTTPS',
      'SVCB',
      'NAPTR',
      'SPF',
      'ANAME',
    ].includes(entry.kind)
  )
    throw new ConfigurationError('namefi: unsupported DNS record type');
  const absolute = ['CNAME', 'NS', 'PTR'].includes(entry.kind);
  let rdata = entry.rdata;
  if (absolute && !rdata.endsWith('.')) rdata += '.';
  if (['MX', 'SRV'].includes(entry.kind) && !rdata.endsWith('.')) rdata += '.';
  return { type: entry.kind, name: entry.owner, rdata, ttl: entry.ttl };
}
function rawSpec(raw: RawRecord): RecordSpec {
  return toSpec(fromRecord(raw));
}
function signature(spec: RecordSpec): string {
  return JSON.stringify(spec);
}
function protectedRecord(raw: RawRecord): boolean {
  return (
    ['SOA', 'NS'].includes(raw.type) ||
    (raw.metadata != null && JSON.stringify(raw.metadata) !== '{}')
  );
}

function failed(error: unknown): OperationResult {
  return {
    ...failedResult(error),
    ...(error instanceof OutcomeUnknownError ? { outcome: 'unknown' as const } : {}),
  };
}

function confirmedRecords(
  raw: unknown,
  zoneName: string,
  expected: { id?: string; spec: RecordSpec }[]
): boolean {
  if (!Array.isArray(raw) || raw.length !== expected.length) return false;
  try {
    const rows = raw as RawRecord[];
    if (new Set(rows.map(r => r.id)).size !== rows.length) return false;
    const remaining = [...expected];
    for (const record of rows) {
      if (!record || typeof record.id !== 'string' || !record.id || record.zoneName !== zoneName)
        return false;
      const key = signature(rawSpec(record));
      const index = remaining.findIndex(
        r => (!r.id || r.id === record.id) && signature(r.spec) === key
      );
      if (index < 0) return false;
      remaining.splice(index, 1);
    }
    return remaining.length === 0;
  } catch {
    return false;
  }
}

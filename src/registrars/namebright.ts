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
  RegistrarOptions,
  RequestOptions,
  TldPricing,
} from '../types';
import { createDomain, filterDomains } from '../utils';
import { AuthenticationError, NotImplementedError, toRegistrarError } from '../errors';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import type { RegistrarFeature } from '../features';
import type { RegistrarCredentials } from '../types';
import type { RequestConfig } from '../http';

const TOKEN_URL = 'https://api.namebright.com/auth/token';

// response from the OAuth2 token endpoint
interface NbToken {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

// a domain record from GET account/domains. The list endpoint does not return
// nameservers (those come from account/domains/{domain}/nameservers).
interface NbDomain {
  DomainName?: string;
  domain?: string;
  Status?: string;
  ExpirationDate?: string;
  RegistrationDate?: string;
  AutoRenew?: boolean;
  Locked?: boolean;
  WhoIsPrivacy?: boolean;
}

// the paged wrapper GET account/domains returns
interface NbDomainsPage {
  ResultsTotal?: number;
  CurrentPage?: number;
  Domains?: NbDomain[];
  domains?: NbDomain[];
}

// GET account/domains/{domain}/nameservers → { DomainName, NameServers: [...] }.
// Be lenient about casing and a possible bare array.
interface NbNameservers {
  DomainName?: string;
  NameServers?: string[];
  Nameservers?: string[];
  nameservers?: string[];
}

// a contact object inside GET account/domains/{domain}/contacts/all. NameBright
// splits the phone into a country-code part and the number.
interface NbContact {
  FirstName?: string;
  LastName?: string;
  Organization?: string;
  Department?: string;
  Email?: string;
  Address1?: string;
  Address2?: string;
  City?: string;
  Region?: string;
  Country?: string;
  PostalCode?: string;
  // NameBright returns the country-code parts as numbers (e.g. 1), not strings
  PhoneCountry?: string | number;
  Phone?: string | number;
  FaxCountry?: string | number;
  Fax?: string | number;
}

// GET account/domains/{domain}/contacts/all. NameBright exposes registrant,
// administrative, and technical roles only (no billing).
interface NbContactsResponse {
  DomainName?: string;
  RegistrantContact?: NbContact;
  AdministrativeContact?: NbContact;
  TechnicalContact?: NbContact;
}

// the per-type DNS host records from GET account/domains/{domain}/hostrecords/all.
// Each carries a numeric RecordId used to address it for deletion
// (DELETE account/domains/{domain}/hostrecords/{type}/{RecordId}).
interface NbARecord {
  Subdomain?: string;
  IPV4Address?: string;
  RecordId?: number;
}
interface NbAAAARecord {
  Subdomain?: string;
  IPV6Address?: string;
  RecordId?: number;
}
interface NbCNAMERecord {
  Subdomain?: string;
  RedirectDomain?: string;
  RecordId?: number;
}
interface NbMXRecord {
  Subdomain?: string;
  MailServer?: string;
  Priority?: number;
  RecordId?: number;
}
interface NbTXTRecord {
  Subdomain?: string;
  TextRecord?: string;
  RecordId?: number;
}
interface NbSRVRecord {
  Service?: string;
  Protocol?: string;
  Priority?: number;
  Weight?: number;
  Port?: number;
  Target?: string;
  RecordId?: number;
}

interface NbHostRecords {
  DomainName?: string;
  ARecords?: NbARecord[];
  AAAARecords?: NbAAAARecord[];
  CNAMERecords?: NbCNAMERecord[];
  MXRecords?: NbMXRecord[];
  TXTRecords?: NbTXTRecord[];
  SRVRecords?: NbSRVRecord[];
}

// GET purchase/availability/{domain}. NameBright returns a per-domain result
// with the standard unit price and an optional promotional price.
interface NbAvailability {
  DomainName?: string;
  ProductTypeName?: string;
  Status?: string;
  UnitPrice?: number;
  Promotion?: {
    PromotionPrice?: number;
    Discount?: number;
    Description?: string;
  };
}

/**
 * NameBright Registrar
 * API docs: https://api.namebright.com/rest/Help
 *
 * Credentials: create an API Application at
 * https://my.namebright.com/my-account/api-management. Each application has a
 * name and an IP whitelist; NameBright issues a client secret. The OAuth2
 * `client_id` is formatted "<accountName>:<applicationName>".
 *
 * Auth: OAuth2 client-credentials. We POST to the token endpoint for a bearer
 * token (valid ~30 minutes), cache it, and send it as `Authorization: Bearer`
 * on each REST call.
 *
 * The read operations are implemented here (testConnection, listDomains,
 * getDomain, getNameservers, getContacts, getDnsRecords, checkAvailability).
 * `getPricing` throws NotImplementedError — NameBright has no per-TLD price table.
 *
 * Write operations verified against a live account: lock/unlock, setAutoRenew,
 * and setPrivacy all update the shared `PUT /account/domains/{domain}` endpoint
 * (which takes the full AccountDomain body — we read-merge to avoid clobbering
 * the other flags). setDnsRecords applies a desired-state diff via per-type
 * POST/DELETE on `hostrecords/{type}[/{RecordId}]` (a blind delete-all +
 * re-create trips NameBright's flaky "Duplicate host record" check).
 *
 * updateNameservers (DELETE-all + per-server PUT on `nameservers[/{ns}]`) is
 * built from the documented endpoints but NOT live-verified — replacing the
 * nameservers on a live domain has no safe test path.
 *
 * renewDomain / registerDomain / transferIn remain NotImplementedError — they
 * incur charges and were out of scope for verification.
 */
export class NameBrightRegistrar extends BaseRegistrar {
  readonly name = 'namebright';

  static readonly displayName = 'NameBright';
  static readonly helpText =
    'API access is not enabled by default — you must request it from NameBright ' +
    '(contact support / your account manager) before the API Management page is ' +
    'available. Once enabled, create an API Application under my.namebright.com > ' +
    'My Account > API Management. The Client ID is "<accountName>:<applicationName>"; ' +
    'NameBright issues the Client Secret. Note the application also enforces an IP whitelist.';
  static readonly configFields: ConfigField[] = [
    { name: 'clientId', label: 'Client ID', type: 'text', required: true },
    { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true },
  ];
  static readonly supportsSandbox = false; // NameBright has no sandbox environment
  // REST/JSON API covering the core lifecycle; no DNSSEC, forwarding, webhooks,
  // or standard auth-code retrieval (transfers are intra-account pushes), so no
  // extended capabilities are declared.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [];

  private token?: string;
  private tokenExpiresAt = 0;

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('NameBright', options?.environment, {
          production: 'https://api.namebright.com/rest',
        }),
      },
      options
    );
  }

  // fetch (and cache) an OAuth2 bearer token via the client-credentials grant
  private async getToken(opts?: RequestOptions): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt) return this.token;

    const res = await this.http.request<NbToken>({
      method: 'POST',
      path: TOKEN_URL,
      body: {
        grant_type: 'client_credentials',
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      },
      ...opts,
    });
    if (!res.access_token) {
      throw new AuthenticationError('NameBright: token endpoint returned no access_token');
    }
    this.token = res.access_token;
    // tokens last ~30 minutes; refresh a minute early
    const ttlMs = (res.expires_in ?? 1800) * 1000;
    this.tokenExpiresAt = now + ttlMs - 60_000;
    return this.token;
  }

  // issue an authenticated REST request, attaching a fresh bearer token
  private async authed<T>(
    config: Omit<RequestConfig, 'headers'>,
    opts?: RequestOptions
  ): Promise<T> {
    const token = await this.getToken(opts);
    return this.http.request<T>({
      ...config,
      headers: { Authorization: `Bearer ${token}` },
      ...opts,
    });
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      // GET /account succeeds only with a valid token
      await this.authed({ path: 'account' }, opts);
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    // The list endpoint has no name filter, so `search` is applied client-side.
    // Nameservers are not returned here (see NbDomain).
    const { search, ...reqOpts } = opts ?? {};
    const domains: Domain[] = [];
    const perPage = 100; // domainsPerPage maximum
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const data = await this.authed<NbDomainsPage | NbDomain[]>(
        { path: 'account/domains', query: { page, domainsPerPage: perPage } },
        reqOpts
      );
      // the response may be a bare array or a paged object; be lenient
      const list = Array.isArray(data) ? data : (data?.Domains ?? data?.domains ?? []);

      for (const d of list) domains.push(this.toDomain(d));

      hasMore = list.length === perPage;
      page++;
    }
    return filterDomains(domains, search);
  }

  /**
   * Fetch a single domain via GET account/domains/{domain}. This endpoint carries
   * the same core fields as the list endpoint (plus Category/UpgradedDomain/
   * AuthCode, which we don't map) but not nameservers — use `getNameservers` for
   * those, so `nameservers` comes back empty here.
   */
  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    const d = await this.authed<NbDomain>(
      { path: `account/domains/${encodeURIComponent(domainName)}` },
      opts
    );
    return this.toDomain(d);
  }

  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    const res = await this.authed<NbNameservers | string[]>(
      { path: `account/domains/${encodeURIComponent(domainName)}/nameservers` },
      opts
    );
    if (Array.isArray(res)) return res.map(String);
    return (res.NameServers ?? res.Nameservers ?? res.nameservers ?? []).map(String);
  }

  /**
   * Read the registrant/admin/tech contacts via GET
   * account/domains/{domain}/contacts/all. NameBright has no billing contact, so
   * `billing` is always omitted.
   */
  override async getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    const res = await this.authed<NbContactsResponse>(
      { path: `account/domains/${encodeURIComponent(domainName)}/contacts/all` },
      opts
    );
    return {
      registrant: fromNbContact(res.RegistrantContact),
      admin: fromNbContact(res.AdministrativeContact),
      tech: fromNbContact(res.TechnicalContact),
    };
  }

  /**
   * Read DNS host records via GET account/domains/{domain}/hostrecords/all, which
   * groups records by type. NameBright doesn't return a per-record TTL, so `ttl`
   * is left unset.
   */
  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const res = await this.authed<NbHostRecords>(
      { path: `account/domains/${encodeURIComponent(domainName)}/hostrecords/all` },
      opts
    );
    return flattenHostRecords(res).map(e => e.record);
  }

  /**
   * NameBright exposes no per-TLD price table — only a per-domain availability
   * check that returns a registration price (no renewal/transfer prices), so
   * there's no `TldPricing` to return. Mirrors Spaceship's `getPricing`.
   */
  override getPricing(_tldOrDomain: string, _opts?: RequestOptions): Promise<TldPricing> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: getPricing is not available — NameBright exposes no per-TLD pricing ` +
          'endpoint (only a per-domain registration price via checkAvailability)'
      )
    );
  }

  /**
   * Availability via GET purchase/availability/{domain}. NameBright's endpoint is
   * per-domain, so multiple names are checked sequentially. It reports a `Status`
   * ("AvailableForRegistration") plus a `UnitPrice`, discounted by an optional
   * `Promotion`. NameBright bills in USD (the response carries no currency code).
   */
  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const results: DomainAvailability[] = [];
    for (const domainName of domainNames) {
      const res = await this.authed<NbAvailability>(
        { path: `purchase/availability/${encodeURIComponent(domainName)}` },
        opts
      );
      const price = res.Promotion?.PromotionPrice ?? res.UnitPrice;
      const result: DomainAvailability = {
        domainName: res.DomainName ?? domainName,
        available: res.Status === 'AvailableForRegistration',
      };
      // NameBright returns UnitPrice 0 for unavailable names; only surface a
      // meaningful (positive) registration price.
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
        result.price = price;
        result.currency = 'USD';
      }
      results.push(result);
    }
    return results;
  }

  // --- write operations ---------------------------------------------------

  override lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.setDomainFlag(domainName, { Locked: true }, 'Domain locked successfully', opts);
  }

  override unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.setDomainFlag(domainName, { Locked: false }, 'Domain unlocked successfully', opts);
  }

  override setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.setDomainFlag(
      domainName,
      { AutoRenew: enabled },
      `Auto-renew ${enabled ? 'enabled' : 'disabled'} successfully`,
      opts
    );
  }

  override setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.setDomainFlag(
      domainName,
      { WhoIsPrivacy: enabled },
      `WHOIS privacy ${enabled ? 'enabled' : 'disabled'} successfully`,
      opts
    );
  }

  /**
   * Update one of the boolean domain flags (Locked / AutoRenew / WhoIsPrivacy)
   * via the shared PUT account/domains/{domain}. That endpoint takes the full
   * AccountDomain body, so we first GET the current record and merge the change
   * over it — sending a bare `{ Locked: true }` would otherwise reset the other
   * flags to their defaults. We deliberately drop AuthCode from the round-trip.
   */
  private async setDomainFlag(
    domainName: string,
    change: Partial<Pick<NbDomain, 'Locked' | 'AutoRenew' | 'WhoIsPrivacy'>>,
    successMessage: string,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const path = `account/domains/${encodeURIComponent(domainName)}`;
      const current = await this.authed<NbDomain & { Category?: string; UpgradedDomain?: boolean }>(
        { path },
        opts
      );
      const body = {
        DomainName: current.DomainName,
        Status: current.Status,
        ExpirationDate: current.ExpirationDate,
        Locked: current.Locked ?? false,
        AutoRenew: current.AutoRenew ?? false,
        WhoIsPrivacy: current.WhoIsPrivacy ?? false,
        Category: current.Category,
        UpgradedDomain: current.UpgradedDomain,
        ...change,
      };
      await this.authed({ method: 'PUT', path, body }, opts);
      return { success: true, message: successMessage };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  /**
   * Replace the domain's nameservers. NameBright has no bulk set: remove all
   * existing servers, then PUT each new one (the server is a path segment, with
   * no request body).
   *
   * NOTE: built from the documented endpoints but not live-verified — there is
   * no safe way to test nameserver replacement against a live production domain.
   */
  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const base = `account/domains/${encodeURIComponent(domainName)}/nameservers`;
      await this.authed({ method: 'DELETE', path: base }, opts);
      for (const ns of nameservers) {
        await this.authed({ method: 'PUT', path: `${base}/${encodeURIComponent(ns)}` }, opts);
      }
      return { success: true, message: 'Nameservers updated successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  /**
   * Replace the domain's DNS host records with `records` (desired-state
   * semantics). NameBright manages records individually — per-type POST to
   * create, DELETE by RecordId to remove — with no bulk set, so we diff against
   * the current records: delete the ones no longer wanted and create the ones
   * that are new, leaving unchanged records in place. (A blind delete-all +
   * re-create trips NameBright's flaky "Duplicate host record" check when a
   * record is deleted and immediately re-posted, so the diff both avoids that
   * and skips needless churn.) NameBright supports no per-record TTL, so `ttl`
   * is ignored.
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const base = `account/domains/${encodeURIComponent(domainName)}/hostrecords`;
      const current = flattenHostRecords(
        await this.authed<NbHostRecords>({ path: `${base}/all` }, opts)
      );

      const desiredKeys = new Set(records.map(dnsRecordKey));
      const currentKeys = new Set(current.map(e => dnsRecordKey(e.record)));

      // delete records that are present now but not desired
      for (const e of current) {
        if (e.recordId != null && !desiredKeys.has(dnsRecordKey(e.record))) {
          await this.authed({ method: 'DELETE', path: `${base}/${e.segment}/${e.recordId}` }, opts);
        }
      }
      // create desired records that aren't already present
      for (const r of records) {
        if (!currentKeys.has(dnsRecordKey(r))) {
          const { segment, body } = toNbHostRecord(r);
          await this.authed({ method: 'POST', path: `${base}/${segment}`, body }, opts);
        }
      }
      return { success: true, message: 'DNS records updated successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  // map a NameBright domain object (from list or single-domain endpoints) to the
  // normalized Domain shape. Neither endpoint returns nameservers.
  private toDomain(d: NbDomain): Domain {
    return createDomain({
      domainName: d.DomainName ?? d.domain,
      registrar: this.name,
      status: d.Status ?? 'ok',
      createdDate: d.RegistrationDate,
      expirationDate: d.ExpirationDate,
      renewalDate: d.ExpirationDate,
      autoRenew: d.AutoRenew ?? false,
      locked: d.Locked ?? false,
      privacy: d.WhoIsPrivacy ?? false,
      nameservers: [],
    });
  }
}

// map a NameBright contact object to the normalized Contact (undefined if the
// role isn't present). NameBright splits the phone into country code + number.
function fromNbContact(c: NbContact | undefined): Contact | undefined {
  if (!c) return undefined;
  return {
    firstName: c.FirstName ?? '',
    lastName: c.LastName ?? '',
    organization: c.Organization ? String(c.Organization) : undefined,
    email: c.Email ?? '',
    phone: joinPhone(c.PhoneCountry, c.Phone),
    fax: c.Fax ? joinPhone(c.FaxCountry, c.Fax) : undefined,
    address1: c.Address1 ?? '',
    address2: c.Address2 ? String(c.Address2) : undefined,
    city: c.City ?? '',
    state: c.Region ?? '',
    postalCode: c.PostalCode ?? '',
    country: c.Country ?? '',
  };
}

// flatten NameBright's per-type host-record groups into generic DnsRecords,
// preserving each record's endpoint segment and RecordId so callers can address
// it for deletion. Order is stable (A, AAAA, CNAME, MX, TXT, SRV).
interface FlatHostRecord {
  record: DnsRecord;
  segment: string;
  recordId?: number;
}
function flattenHostRecords(res: NbHostRecords): FlatHostRecord[] {
  const out: FlatHostRecord[] = [];
  for (const r of res.ARecords ?? []) {
    out.push({
      record: { type: 'A', name: r.Subdomain ?? '@', value: r.IPV4Address ?? '' },
      segment: 'a',
      recordId: r.RecordId,
    });
  }
  for (const r of res.AAAARecords ?? []) {
    out.push({
      record: { type: 'AAAA', name: r.Subdomain ?? '@', value: r.IPV6Address ?? '' },
      segment: 'aaaa',
      recordId: r.RecordId,
    });
  }
  for (const r of res.CNAMERecords ?? []) {
    out.push({
      record: { type: 'CNAME', name: r.Subdomain ?? '@', value: r.RedirectDomain ?? '' },
      segment: 'cname',
      recordId: r.RecordId,
    });
  }
  for (const r of res.MXRecords ?? []) {
    const record: DnsRecord = { type: 'MX', name: r.Subdomain ?? '@', value: r.MailServer ?? '' };
    if (r.Priority != null) record.priority = r.Priority;
    out.push({ record, segment: 'mx', recordId: r.RecordId });
  }
  for (const r of res.TXTRecords ?? []) {
    out.push({
      record: { type: 'TXT', name: r.Subdomain ?? '@', value: r.TextRecord ?? '' },
      segment: 'txt',
      recordId: r.RecordId,
    });
  }
  for (const r of res.SRVRecords ?? []) {
    // NameBright splits SRV into service/protocol; recompose the standard
    // "_service._protocol" name that our generic record carries.
    const name = [r.Service, r.Protocol].filter(Boolean).join('.') || '@';
    const record: DnsRecord = { type: 'SRV', name, value: r.Target ?? '' };
    if (r.Priority != null) record.priority = r.Priority;
    if (r.Weight != null) record.weight = r.Weight;
    if (r.Port != null) record.port = r.Port;
    out.push({ record, segment: 'srv', recordId: r.RecordId });
  }
  return out;
}

// canonical identity of a DNS record for diffing (ignores TTL, which NameBright
// doesn't store). Two records with the same key are considered equal.
function dnsRecordKey(r: DnsRecord): string {
  return [
    r.type.toUpperCase(),
    r.name || '@',
    r.value,
    r.priority ?? '',
    r.weight ?? '',
    r.port ?? '',
  ].join('|');
}

// map a generic DnsRecord to NameBright's per-type POST endpoint segment and
// request body. The record's `name` is the subdomain ("@" for the apex); TTL is
// unsupported by NameBright and ignored. Throws on record types NameBright's
// host-record API does not expose.
function toNbHostRecord(r: DnsRecord): { segment: string; body: Record<string, unknown> } {
  const type = r.type.toUpperCase();
  const subdomain = r.name || '@';
  switch (type) {
    case 'A':
      return { segment: 'a', body: { Subdomain: subdomain, IPV4Address: r.value } };
    case 'AAAA':
      return { segment: 'aaaa', body: { Subdomain: subdomain, IPV6Address: r.value } };
    case 'CNAME':
      return { segment: 'cname', body: { Subdomain: subdomain, RedirectDomain: r.value } };
    case 'MX':
      return {
        segment: 'mx',
        body: { Subdomain: subdomain, MailServer: r.value, Priority: r.priority ?? 10 },
      };
    case 'TXT':
      return { segment: 'txt', body: { Subdomain: subdomain, TextRecord: r.value } };
    case 'SRV': {
      // our generic name carries "_service._protocol"; NameBright splits them.
      const [service, protocol] = r.name.split('.');
      return {
        segment: 'srv',
        body: {
          Service: service,
          Protocol: protocol,
          Priority: r.priority ?? 0,
          Weight: r.weight ?? 0,
          Port: r.port ?? 0,
          Target: r.value,
        },
      };
    }
    default:
      throw new Error(`NameBright: unsupported DNS record type "${r.type}"`);
  }
}

// combine a country-code part and a local number into "+<cc>.<number>" form,
// leaving an already-complete number untouched when no country code is given.
// NameBright returns PhoneCountry/FaxCountry as numbers (e.g. 1), so coerce to
// string before trimming.
function joinPhone(
  countryCode: string | number | undefined,
  number: string | number | undefined
): string {
  const num = String(number ?? '').trim();
  const cc = String(countryCode ?? '')
    .trim()
    .replace(/^\+/, '');
  if (!cc) return num;
  if (!num) return cc ? `+${cc}` : '';
  return `+${cc}.${num}`;
}

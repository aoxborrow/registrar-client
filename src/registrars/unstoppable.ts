import type {
  ConfigField,
  ConnectionResult,
  ContactSet,
  DnsRecord,
  Domain,
  DomainAvailability,
  DomainForward,
  ListDomainsOptions,
  OperationResult,
  RegisterDomainInput,
  RegistrarCredentials,
  RegistrarOptions,
  RequestOptions,
  TldPricing,
  TransferDomainInput,
} from '../types';
import { asRead, createDomain, filterDomains, normalizeDomain, settableForwards } from '../utils';
import { NotFoundError, NotImplementedError, failedResult } from '../errors';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import { Feature, type RegistrarFeature } from '../features';

// Unstoppable Domains "User API": a flat set of JSON POST actions at
// /mcp/v1/actions/ud_<action>, each taking and returning JSON. Reads and writes
// are all POST, so intent is carried by the feature, not the method.

// the lifecycle fields ud_portfolio_list and ud_domain_get share
interface UdLifecycle {
  purchasedAt?: string | null;
  expiresAt?: string | null;
  transferStatus?: string; // "none" | "pending"
  // registered elsewhere and only listed on Unstoppable's marketplace (the
  // marketplace calls these "external" listings), so not managed here
  isExternallyOwned?: boolean;
  autoRenewal?: { status?: string; expiresAt?: string | null } | null;
}

// one domain from ud_portfolio_list
interface UdPortfolioDomain extends UdLifecycle {
  name?: string;
}

interface UdPagination {
  hasMore?: boolean;
  nextOffset?: number | null;
  nextCursor?: string | null;
}

interface UdPortfolioResponse {
  domains?: UdPortfolioDomain[];
  pagination?: UdPagination;
  // set when the page was cut short to fit a response size limit
  truncated?: boolean;
}

// one result from ud_domains_search
interface UdSearchResult {
  name?: string;
  available?: boolean;
  // available | registered-listed-for-sale | registered-listed-for-offers |
  // registered-not-for-sale | unavailable | invalid
  marketplace?: { status?: string; source?: string };
  pricing?: { amount?: number; currency?: string }; // amount is in CENTS
}
interface UdSearchResponse {
  results?: UdSearchResult[];
}

// one record from ud_dns_records_list (values is an array; one DNS record can
// carry several values)
interface UdDnsRecord {
  id?: string | null; // absent on system records
  type?: string;
  subName?: string | null; // null/"" at the apex
  values?: string[];
  ttl?: number;
  readonly?: boolean;
}
interface UdDnsRecordsResponse {
  records?: UdDnsRecord[];
  pagination?: UdPagination;
}

// The domain flags ud_domain_get returns and ud_domain_flags_update sets.
// DNS_TRANSFER_OUT is the transfer lock (ENABLED = transfers allowed, DISABLED =
// locked); DNS_WHOIS_PROXY is WHOIS privacy (ENABLED = contact details hidden).
type UdFlag = 'DNS_TRANSFER_OUT' | 'DNS_WHOIS_PROXY';
type UdFlagStatus = 'ENABLED' | 'DISABLED';

// one record from ud_domain_get — the richer per-domain view (batched up to 50).
// Unlike ud_portfolio_list it carries nameservers (even for names that 400 on
// ud_dns_nameservers_list) and the transfer-lock and privacy flags.
interface UdDomainGetRecord {
  domain?: string;
  found?: boolean;
  flags?: Partial<Record<string, { status?: string }>> | null;
  lifecycle?: UdLifecycle;
  dns?: { nameservers?: { status?: string; nameservers?: string[] } | null };
}
interface UdDomainGetResponse {
  domains?: UdDomainGetRecord[];
}

// one hosting/forwarding config from ud_dns_hosting_list
interface UdHostingConfig {
  type?: string; // REDIRECT_301 | REDIRECT_302 | LISTING_PAGE | ...
  subName?: string | null; // null at the apex
  targetUrl?: string | null;
}
interface UdHostingResponse {
  configs?: UdHostingConfig[];
  pagination?: UdPagination;
}

// the common write envelope: a per-domain results array plus counts
interface UdWriteResponse {
  results?: { domain?: string; success?: boolean; error?: string }[];
  successCount?: number;
  failureCount?: number;
}

// a DNS record as Unstoppable stores it: one (type, host) with many values
interface UdRecordGroup {
  type: string;
  subName: string;
  values: string[];
  ttl?: number;
}

const DNS_HOSTING_REDIRECTS = new Set(['REDIRECT_301', 'REDIRECT_302']);
// the most each bulk action takes in one call
const BULK_LIMIT = 50;
// ud_domains_search takes at most 10 query terms per call
const SEARCH_LIMIT = 10;
// marketplace states that are a listing on the aftermarket, not a registration
const AFTERMARKET = new Set(['registered-listed-for-sale', 'registered-listed-for-offers']);
// label used to price a bare TLD (Unstoppable only prices whole names)
const PROBE_LABEL = 'ud-registrar-client-probe';

/**
 * Unstoppable Domains Registrar (User API)
 * API docs: https://docs.unstoppabledomains.com/apis/user-api/overview
 * OpenAPI: https://api.unstoppabledomains.com/mcp/v1/openapi.json
 *
 * Credentials: an API key (format `ud_mcp_…`) from Account Settings → Advanced →
 * MCP API Key. Sent as `Authorization: Bearer <key>`.
 *
 * Every call is a JSON POST to `/mcp/v1/actions/ud_<action>`; success/failure
 * uses HTTP status codes, and write actions return a per-domain `results` array.
 * There is no sandbox. Only ICANN ("dns") domains are listed: the portfolio
 * leaves out web3 names by default, and names registered elsewhere that are only
 * listed on Unstoppable's marketplace are skipped.
 *
 * Scope (read + manage): portfolio list/get, availability + pricing, DNS records,
 * nameservers, auto-renew, transfer lock, WHOIS privacy and domain (URL)
 * forwarding are implemented. Registration and renewal go through a multi-step
 * cart→checkout flow that spends real money and isn't wired here yet
 * (NotImplementedError). Transfer-in, per-domain contacts and auth-code retrieval
 * have no Unstoppable API and also throw NotImplementedError.
 */
export class UnstoppableRegistrar extends BaseRegistrar {
  readonly name = 'unstoppable';

  static readonly displayName = 'Unstoppable Domains';
  static readonly website = 'unstoppabledomains.com';
  static readonly helpText =
    'Generate an API key in your Unstoppable Domains account under Account Settings → ' +
    'Advanced → MCP API Key (it looks like `ud_mcp_…`). It is sent as a Bearer token. ' +
    'There is no sandbox, so every change acts on your live account. Registration, ' +
    'renewal, transfer-in and per-domain contacts aren’t available through this ' +
    'adapter (Unstoppable has no API for them, or they run through a cart/checkout ' +
    'flow not wired here).';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
  ];
  // Production only — Unstoppable documents no sandbox/test environment.
  static readonly supportsSandbox = false;
  // Beyond core: URL (domain) forwarding via the DNS hosting redirect configs.
  // No DNSSEC toggle, email forwarding, or auth-code retrieval.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.GetDomainForwarding,
    Feature.SetDomainForwarding,
  ];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('Unstoppable Domains', options?.environment, {
          production: 'https://api.unstoppabledomains.com',
        }),
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
      },
      options
    );
  }

  // POST an action with a JSON body; `opts` carries timeout/signal and the
  // read/write intent the retry layer needs.
  private call<T>(
    action: string,
    body: Record<string, unknown> = {},
    opts?: RequestOptions
  ): Promise<T> {
    return this.http.request<T>({
      method: 'POST',
      path: `/mcp/v1/actions/${action}`,
      body,
      ...opts,
    });
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      // the lightest authenticated read that validates the key
      await this.call<UdPortfolioResponse>('ud_portfolio_list', { limit: 1 }, opts);
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return failedResult(error);
    }
  }

  /**
   * Lists the portfolio's ICANN domains. ud_portfolio_list enumerates them
   * (offset-paged at its 500 maximum) but has no nameservers or flags, so the
   * names are then read in batches through ud_domain_get, which carries the
   * nameservers, transfer lock and WHOIS privacy. Names that are only listed on
   * Unstoppable's marketplace (`isExternallyOwned`) are skipped. `search` is sent
   * as `searchTerm` and also applied client-side.
   */
  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const { search, ...reqOpts } = opts ?? {};
    const listed = new Map<string, UdPortfolioDomain>();
    const limit = 500; // Unstoppable's max page size
    let offset = 0;
    for (;;) {
      const res = await this.call<UdPortfolioResponse>(
        'ud_portfolio_list',
        { limit, offset, ...(search ? { searchTerm: search } : {}) },
        reqOpts
      );
      const page = res.domains ?? [];
      for (const d of page) {
        if (d.name && !d.isExternallyOwned) listed.set(normalizeDomain(d.name), d);
      }
      if (page.length === 0 || !(res.pagination?.hasMore || res.truncated)) break;
      // advance by what came back: a truncated page holds fewer than `limit`
      offset += page.length;
    }

    const detail = await this.fetchDetails([...listed.keys()], reqOpts);
    const domains: Domain[] = [];
    for (const [name, summary] of listed) {
      const rec = detail.get(name);
      if (rec?.lifecycle?.isExternallyOwned) continue;
      domains.push(this.toDomain(name, rec, summary));
    }
    return filterDomains(domains, search);
  }

  /** Full detail via ud_domain_get. Throws NotFoundError when the domain isn't
   *  registered in this account. */
  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    const rec = await this.lookup(domainName, opts);
    return this.toDomain(normalizeDomain(domainName), rec);
  }

  // getNameservers re-reads ud_domain_get, which listDomains and getDomain
  // already fold in, so the listing-enrichment fallback gains nothing.
  override readonly requiresNameserversFetch = false;

  // ud_domain_get rather than ud_dns_nameservers_list, which 400s ("Domain
  // registration is not valid for management") for some names.
  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    return nameserversOf(await this.lookup(domainName, opts));
  }

  // one domain's ud_domain_get record; NotFoundError when it isn't registered here
  private async lookup(domainName: string, opts?: RequestOptions): Promise<UdDomainGetRecord> {
    const target = normalizeDomain(domainName);
    const res = await this.call<UdDomainGetResponse>('ud_domain_get', { domains: [target] }, opts);
    const rec = (res.domains ?? []).find(r => normalizeDomain(r.domain ?? '') === target);
    if (!rec || rec.found === false || rec.lifecycle?.isExternallyOwned) {
      throw new NotFoundError(`Unstoppable: domain '${domainName}' is not in this account`);
    }
    return rec;
  }

  /**
   * Fetch ud_domain_get detail for many names, batched at the API's 50-per-call
   * limit with light concurrency. Keyed by normalized domain name.
   */
  private async fetchDetails(
    names: string[],
    opts?: RequestOptions
  ): Promise<Map<string, UdDomainGetRecord>> {
    const batches = chunk(names, BULK_LIMIT);
    const byName = new Map<string, UdDomainGetRecord>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < batches.length) {
        const batch = batches[next++];
        const res = await this.call<UdDomainGetResponse>('ud_domain_get', { domains: batch }, opts);
        for (const rec of res.domains ?? []) {
          if (rec.domain && rec.found !== false) byName.set(normalizeDomain(rec.domain), rec);
        }
      }
    };
    // ud_domain_get is slow (~8-10s per call, any batch size) and Unstoppable
    // throttles it server-side, so a handful of concurrent batches is as fast as
    // it gets (and stays well under the 15 req/s limit). A large list is
    // therefore slow, but complete in one pass with no per-domain follow-ups.
    const CONCURRENCY = 5;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    return byName;
  }

  /** Sets custom (external) nameservers via ud_dns_nameservers_set_custom. */
  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const res = await this.call<UdWriteResponse>(
        'ud_dns_nameservers_set_custom',
        { domains: [{ name: normalizeDomain(domainName), nameservers }] },
        opts
      );
      return writeResult(res, 'Nameservers updated successfully');
    } catch (error) {
      return failedResult(error);
    }
  }

  /**
   * Availability + pricing via ud_domains_search, 10 names per call (its limit).
   * Each result carries `available` and a `pricing.amount` in cents. Unstoppable
   * reports names listed on the aftermarket (its own marketplace, Sedo, Afternic)
   * as available; those are flagged `premium` and priced at the listing. Names
   * the search doesn't return (an unsupported TLD) are left out.
   */
  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const names = [...new Set(domainNames.map(normalizeDomain))];
    const byName = new Map<string, UdSearchResult>();
    for (const query of chunk(names, SEARCH_LIMIT)) {
      const res = await this.call<UdSearchResponse>(
        'ud_domains_search',
        { query, limit: 100 },
        opts
      );
      for (const r of res.results ?? []) if (r.name) byName.set(normalizeDomain(r.name), r);
    }
    const out: DomainAvailability[] = [];
    for (const name of names) {
      const r = byName.get(name);
      if (!r) continue;
      const result: DomainAvailability = { domainName: name, available: Boolean(r.available) };
      if (AFTERMARKET.has(r.marketplace?.status ?? '')) result.premium = true;
      const price = centsToMajor(r.pricing?.amount);
      if (price != null) {
        result.price = price;
        result.currency = r.pricing?.currency || 'USD';
      }
      out.push(result);
    }
    return out;
  }

  /**
   * Registration price (Unstoppable has no per-TLD price table). A full domain is
   * priced directly; a bare TLD is priced via an almost-certainly-available probe
   * label so the result is the TLD's standard registration price. Only a fresh
   * registration counts: an aftermarket listing's price isn't one. Search gives
   * no separate renewal or transfer price.
   */
  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    // a leading dot or no dot at all means a bare TLD, as on the other providers
    const raw = normalizeDomain(tldOrDomain);
    const input = raw.replace(/^\./, '');
    const isDomain = !raw.startsWith('.') && input.includes('.');
    const tld = isDomain ? tldOf(input) : input;
    const name = isDomain ? input : `${PROBE_LABEL}.${tld}`;
    const body = isDomain ? { query: [name] } : { query: [PROBE_LABEL], tlds: [tld] };
    const res = await this.call<UdSearchResponse>('ud_domains_search', { ...body, limit: 1 }, opts);
    const result = res.results?.find(r => normalizeDomain(r.name ?? '') === name);
    const status = result?.marketplace?.status;
    const registration =
      status && status !== 'available' ? undefined : centsToMajor(result?.pricing?.amount);
    if (registration == null) {
      throw new NotFoundError(`Unstoppable: no registration price found for '${tldOrDomain}'`);
    }
    return { tld, currency: result?.pricing?.currency || 'USD', registration };
  }

  override async setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const res = await this.call<UdWriteResponse>(
        'ud_domain_auto_renewal_update',
        {
          action: enabled ? 'enable' : 'disable',
          domains: [{ name: normalizeDomain(domainName) }],
        },
        opts
      );
      return writeResult(res, `Auto-renew ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      return failedResult(error);
    }
  }

  /** Transfer lock on: DNS_TRANSFER_OUT DISABLED (transfers blocked). */
  override lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.setFlag(domainName, 'DNS_TRANSFER_OUT', 'DISABLED', 'Domain locked', opts);
  }

  /** Transfer lock off: DNS_TRANSFER_OUT ENABLED (transfers allowed). */
  override unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.setFlag(domainName, 'DNS_TRANSFER_OUT', 'ENABLED', 'Domain unlocked', opts);
  }

  /** WHOIS privacy: the DNS_WHOIS_PROXY flag. */
  override setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.setFlag(
      domainName,
      'DNS_WHOIS_PROXY',
      enabled ? 'ENABLED' : 'DISABLED',
      `WHOIS privacy ${enabled ? 'enabled' : 'disabled'}`,
      opts
    );
  }

  private async setFlag(
    domainName: string,
    flag: UdFlag,
    status: UdFlagStatus,
    okMessage: string,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const res = await this.call<UdWriteResponse>(
        'ud_domain_flags_update',
        { domains: [normalizeDomain(domainName)], flags: { [flag]: { status } } },
        opts
      );
      return writeResult(res, okMessage);
    } catch (error) {
      return failedResult(error);
    }
  }

  /**
   * Reads DNS records via ud_dns_records_list (paginated by cursor). Each
   * Unstoppable record can hold several values; this expands them into one
   * DnsRecord per value. MX and SRV carry their numbers inside the value
   * ("<priority> <host>", "<priority> <weight> <port> <target>"); they're split
   * out into `priority` / `weight` / `port`. Read-only system records are
   * included.
   */
  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const out: DnsRecord[] = [];
    for (const rec of await this.listRecords(normalizeDomain(domainName), opts)) {
      const type = (rec.type ?? '').toUpperCase();
      const name = hostOf(rec.subName);
      for (const raw of rec.values ?? []) out.push(toDnsRecord(type, name, raw, rec.ttl));
    }
    return out;
  }

  private async listRecords(domain: string, opts?: RequestOptions): Promise<UdDnsRecord[]> {
    const out: UdDnsRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await this.call<UdDnsRecordsResponse>(
        'ud_dns_records_list',
        { domain, ...(cursor ? { cursor } : {}) },
        opts
      );
      out.push(...(res.records ?? []));
      cursor = res.pagination?.hasMore ? (res.pagination.nextCursor ?? undefined) : undefined;
      if (!cursor) return out;
    }
  }

  /**
   * Replaces the record set (an empty list clears it). Unstoppable has no atomic
   * "set all" and stores one record per type + host with many values, so this
   * reads the current records, groups the desired ones the same way, and writes
   * only the difference: records whose type + host is no longer wanted are
   * removed by id (ud_dns_record_remove), then new or changed ones are written
   * with ud_dns_record_add in "replace" mode. Unchanged records aren't touched,
   * so a failed write never leaves the zone empty. Read-only system records stay
   * as they are; desired values that match one are skipped. The delegation
   * nameservers aren't part of this (see updateNameservers).
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const domain = normalizeDomain(domainName);
    try {
      const current = await this.listRecords(domain, asRead(opts));

      // values the provider keeps whatever we send
      const fixed = new Set<string>();
      // the user's records by type + host (normally one each)
      const editable = new Map<string, UdDnsRecord[]>();
      for (const rec of current) {
        const key = groupKey(rec.type ?? '', hostOf(rec.subName));
        if (rec.readonly || !rec.id) {
          for (const v of rec.values ?? []) fixed.add(`${key}\u0000${v}`);
        } else {
          editable.set(key, [...(editable.get(key) ?? []), rec]);
        }
      }

      const desired = new Map<string, UdRecordGroup>();
      for (const r of records) {
        const type = r.type.toUpperCase();
        const host = r.name || '@';
        const key = groupKey(type, host);
        const value = toUdValue(type, r);
        if (fixed.has(`${key}\u0000${value}`)) continue;
        const group = desired.get(key);
        if (group) {
          if (!group.values.includes(value)) group.values.push(value);
        } else {
          desired.set(key, { type, subName: host, values: [value], ttl: r.ttl });
        }
      }

      const removals: string[] = [];
      for (const [key, recs] of editable) {
        // more than one record for a type + host can't be replaced in place
        if (!desired.has(key) || recs.length > 1) removals.push(...recs.map(r => r.id as string));
      }
      const writes: UdRecordGroup[] = [];
      for (const [key, want] of desired) {
        const recs = editable.get(key);
        const have = recs?.length === 1 ? recs[0] : undefined;
        const unchanged =
          have &&
          sameValues(have.values ?? [], want.values) &&
          (want.ttl == null || want.ttl === have.ttl);
        if (!unchanged) writes.push(want);
      }

      for (const batch of chunk(removals, BULK_LIMIT)) {
        const res = await this.call<UdWriteResponse>(
          'ud_dns_record_remove',
          { records: batch.map(recordId => ({ domain, recordId })) },
          opts
        );
        const removed = writeResult(res, '');
        if (!removed.success) return removed;
      }
      for (const batch of chunk(writes, BULK_LIMIT)) {
        const res = await this.call<UdWriteResponse>(
          'ud_dns_record_add',
          {
            records: batch.map(g => ({
              domain,
              type: g.type,
              subName: g.subName,
              values: g.values,
              ...(g.ttl != null ? { ttl: g.ttl } : {}),
            })),
            upsertMode: 'replace',
          },
          opts
        );
        const added = writeResult(res, '');
        if (!added.success) return added;
      }
      if (removals.length === 0 && writes.length === 0) {
        return { success: true, message: 'DNS records already up to date' };
      }
      return { success: true, message: 'DNS records updated successfully' };
    } catch (error) {
      return failedResult(error);
    }
  }

  // --- extended: URL/domain forwarding via the DNS hosting redirect configs ----

  /**
   * Reads the 301/302 redirect ("hosting") configs. Non-redirect hosting types
   * (listing page, reverse proxy, UD profile, …) aren't forwarding and are skipped.
   */
  override async getDomainForwarding(
    domainName: string,
    opts?: RequestOptions
  ): Promise<DomainForward[]> {
    const domain = normalizeDomain(domainName);
    const out: DomainForward[] = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await this.call<UdHostingResponse>(
        'ud_dns_hosting_list',
        { domain, ...(cursor ? { cursor } : {}) },
        opts
      );
      for (const c of res.configs ?? []) {
        if (!c.type || !DNS_HOSTING_REDIRECTS.has(c.type) || !c.targetUrl) continue;
        out.push({
          host: hostOf(c.subName),
          url: c.targetUrl,
          type: c.type === 'REDIRECT_301' ? 'permanent' : 'temporary',
        });
      }
      cursor = res.pagination?.hasMore ? (res.pagination.nextCursor ?? undefined) : undefined;
      if (!cursor) return out;
    }
  }

  /**
   * Replaces URL forwarding (full replace; empty clears). Redirects that are no
   * longer wanted (or change) are removed first, then the new ones are added
   * (permanent → REDIRECT_301, temporary → REDIRECT_302); unchanged ones stay.
   * Masked forwarding is rejected up front.
   */
  override async setDomainForwarding(
    domainName: string,
    forwards: DomainForward[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const domain = normalizeDomain(domainName);
    const desired = settableForwards(forwards); // reject masked before any write
    const keyOf = (f: DomainForward) => `${f.host || '@'}\u0000${f.type}\u0000${f.url}`;
    try {
      const current = await this.getDomainForwarding(domain, asRead(opts));
      const wanted = new Set(desired.map(keyOf));
      const existing = new Set(current.map(keyOf));
      for (const stale of current.filter(f => !wanted.has(keyOf(f)))) {
        const rm = await this.call<UdWriteResponse>(
          'ud_dns_hosting_remove',
          { domains: [{ name: domain, ...subNameField(stale.host) }] },
          opts
        );
        const removed = writeResult(rm, '');
        if (!removed.success) return removed;
      }
      for (const f of desired.filter(f => !existing.has(keyOf(f)))) {
        const add = await this.call<UdWriteResponse>(
          'ud_dns_hosting_add',
          {
            domains: [
              {
                name: domain,
                type: f.type === 'permanent' ? 'REDIRECT_301' : 'REDIRECT_302',
                targetUrl: f.url,
                ...subNameField(f.host),
              },
            ],
          },
          opts
        );
        const added = writeResult(add, '');
        if (!added.success) return added;
      }
      return { success: true, message: 'Domain forwarding updated successfully' };
    } catch (error) {
      return failedResult(error);
    }
  }

  // --- operations with no Unstoppable Domains equivalent (or out of scope) -----

  override registerDomain(
    _domainName: string,
    _input: RegisterDomainInput,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: registerDomain is not wired up — Unstoppable registers through a ` +
          'multi-step cart→checkout flow (ud_cart_add_domain_registration → ud_cart_checkout) ' +
          'that spends real money; use the Unstoppable app/cart for now'
      )
    );
  }

  override renewDomain(
    _domainName: string,
    _years?: number,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: renewDomain is not wired up — Unstoppable renews through the cart→checkout ` +
          'flow (ud_cart_add_domain_renewal → ud_cart_checkout); use the Unstoppable app for now'
      )
    );
  }

  override transferIn(
    _domainName: string,
    _input: TransferDomainInput,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: transferIn is not available — Unstoppable has no inbound-transfer API`
      )
    );
  }

  override getContacts(_domainName: string, _opts?: RequestOptions): Promise<ContactSet> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: getContacts is not available — Unstoppable exposes account-level ICANN ` +
          'contacts (ud_contacts_list) but no per-domain contact assignment to read'
      )
    );
  }

  override updateContacts(
    _domainName: string,
    _contacts: ContactSet,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: updateContacts is not available — Unstoppable has no per-domain ` +
          'contact-assignment API'
      )
    );
  }

  // Build a normalized Domain from a ud_domain_get record, falling back to the
  // portfolio summary when the detail call didn't return one.
  private toDomain(name: string, rec?: UdDomainGetRecord, summary?: UdLifecycle): Domain {
    const lc: UdLifecycle = { ...summary, ...rec?.lifecycle };
    return createDomain({
      domainName: rec?.domain ?? name,
      registrar: this.name,
      status: lc.transferStatus === 'pending' ? 'pending transfer' : 'ok',
      createdDate: lc.purchasedAt ?? null,
      expirationDate: lc.expiresAt ?? null,
      renewalDate: lc.expiresAt ?? null,
      autoRenew: lc.autoRenewal?.status === 'active',
      locked: flagOf(rec, 'DNS_TRANSFER_OUT') === 'DISABLED',
      privacy: flagOf(rec, 'DNS_WHOIS_PROXY') === 'ENABLED',
      nameservers: nameserversOf(rec),
    });
  }
}

function flagOf(rec: UdDomainGetRecord | undefined, flag: UdFlag): string | undefined {
  return rec?.flags?.[flag]?.status;
}

// Nameservers from a ud_domain_get record.
function nameserversOf(rec: UdDomainGetRecord | undefined): string[] {
  return rec?.dns?.nameservers?.nameservers ?? [];
}

// Unstoppable leaves the apex host null or empty; the library calls it "@"
function hostOf(subName: string | null | undefined): string {
  return subName && subName.length ? subName : '@';
}

// Hosting actions name the apex by leaving subName out.
function subNameField(host: string | undefined): { subName?: string } {
  return host && host !== '@' ? { subName: host } : {};
}

function groupKey(type: string, host: string): string {
  return `${type.toUpperCase()}\u0000${host.toLowerCase()}`;
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(v => b.includes(v));
}

// one Unstoppable value as a DnsRecord, splitting out MX/SRV numbers
function toDnsRecord(type: string, name: string, raw: string, ttl?: number): DnsRecord {
  const record: DnsRecord = { type, name, value: raw };
  if (typeof ttl === 'number') record.ttl = ttl;
  if (type === 'MX') {
    const m = /^(\d+)\s+(.+)$/.exec(raw);
    if (m) {
      record.priority = Number(m[1]);
      record.value = m[2];
    }
  } else if (type === 'SRV') {
    const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(raw);
    if (m) {
      record.priority = Number(m[1]);
      record.weight = Number(m[2]);
      record.port = Number(m[3]);
      record.value = m[4];
    }
  }
  return record;
}

// a DnsRecord's value as Unstoppable stores it, folding MX/SRV numbers back in
function toUdValue(type: string, r: DnsRecord): string {
  if (type === 'MX' && r.priority != null) return `${r.priority} ${r.value}`;
  if (type === 'SRV' && r.priority != null && r.weight != null && r.port != null) {
    return `${r.priority} ${r.weight} ${r.port} ${r.value}`;
  }
  return r.value;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Unstoppable prices are integer cents; convert to major units (or undefined).
function centsToMajor(cents: unknown): number | undefined {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return undefined;
  return Math.round(cents) / 100;
}

// reduce a full domain to its TLD (everything after the first dot).
function tldOf(domain: string): string {
  return domain.slice(domain.indexOf('.') + 1);
}

// map Unstoppable's per-domain write envelope to an OperationResult.
function writeResult(res: UdWriteResponse | undefined, okMessage: string): OperationResult {
  const failures = (res?.results ?? []).filter(r => r.success === false);
  const failed = res?.failureCount ?? failures.length;
  if (failed > 0) {
    return { success: false, message: failures[0]?.error || 'Unstoppable: operation failed' };
  }
  return { success: true, message: okMessage || 'success' };
}

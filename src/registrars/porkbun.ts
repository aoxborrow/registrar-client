import type {
  ConfigField,
  ConnectionResult,
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
import { createDomain, filterDomains, normalizeDomain } from '../utils';
import { NotFoundError, NotImplementedError, toRegistrarError } from '../errors';
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

// domain/getNs response — `ns` is the current nameserver list
interface PbNsResponse extends PbResponse {
  ns?: string[];
}

// a single DNS record from dns/retrieve. All fields arrive as strings.
interface PbDnsRecord {
  id?: string;
  name?: string; // fully-qualified host, e.g. "www.example.com" ("example.com" at apex)
  type?: string;
  content?: string; // record data (for SRV: "weight port target")
  ttl?: string;
  prio?: string; // priority, for MX / SRV
  notes?: string;
}

interface PbDnsResponse extends PbResponse {
  records?: PbDnsRecord[];
}

// one TLD's price points from pricing/get. Values are strings in major USD units.
interface PbTldPrice {
  registration?: string;
  renewal?: string;
  transfer?: string;
}

interface PbPricingResponse extends PbResponse {
  pricing?: Record<string, PbTldPrice>;
}

// domain/checkDomain response — availability sits under `response`
interface PbCheckResponse extends PbResponse {
  response?: {
    avail?: string; // "yes" | "no"
    type?: string; // "registration" | ...
    price?: string;
    regularPrice?: string;
    premium?: string; // "yes" | "no"
  };
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
    'the domain details). For testing, use a sandbox key (prefixed "pk1_sb_") with ' +
    '{ environment: "sandbox" } — it hits the same base URL but an isolated test ' +
    'environment with $1,000 of fake credit and no real charges (top up or reset via ' +
    'POST /sandbox/topup and POST /sandbox/reset).';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'secretApiKey', label: 'Secret API Key', type: 'password', required: true },
  ];
  // Porkbun's sandbox is the SAME base URL with a swapped key: a sandbox key is
  // prefixed `pk1_sb_` and runs against an isolated test environment (no real
  // registry actions, no DNS changes, no charges). Each sandbox starts with
  // $1,000 of fake credit and every response includes `"sandbox": true`. Top up
  // or reset a sandbox with `POST /sandbox/topup` / `POST /sandbox/reset` using a
  // sandbox key. Because only the key differs, the sandbox base URL equals
  // production — selecting `environment: 'sandbox'` just avoids throwing.
  static readonly supportsSandbox = true;
  // JSON API. Beyond core: DNSSEC, glue records, URL (domain) forwarding, and
  // signed webhooks. No auth-code retrieval; transfer lock and WHOIS-privacy
  // toggles have no write endpoint (privacy is set only at registration).
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.SetDnssec,
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
          // sandbox shares the production URL; the `pk1_sb_` key selects the
          // isolated test environment server-side.
          sandbox: 'https://api.porkbun.com/api/json/v3',
        }),
      },
      options
    );
  }

  // POST an operation with the credentials merged into the JSON body
  private call<T extends PbResponse = PbResponse>(
    path: string,
    extra: Record<string, unknown> = {},
    opts?: RequestOptions
  ): Promise<T> {
    return this.http.request<T>({
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

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    // listAll has no name filter, so `search` is applied client-side. Porkbun
    // returns fixed 1000-domain chunks and pages by `start` offset.
    const { search, ...reqOpts } = opts ?? {};
    const domains: Domain[] = [];
    const chunk = 1000; // Porkbun returns up to 1000 domains per call
    let start = 0;
    let hasMore = true;

    while (hasMore) {
      const res = await this.call('/domain/listAll', { start, includeLabels: 'no' }, reqOpts);
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

      hasMore = list.length === chunk;
      start += chunk;
    }
    return filterDomains(domains, search);
  }

  /**
   * Porkbun has no per-domain "get info" endpoint, so this lists the account and
   * returns the matching record. `listDomains` already normalizes every field, so
   * the result carries the same shape as any other provider's `getDomain`. Throws
   * NotFoundError when the domain isn't in the account.
   */
  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    const target = normalizeDomain(domainName);
    const domains = await this.listDomains(opts);
    const match = domains.find(d => normalizeDomain(d.domainName) === target);
    if (!match) {
      throw new NotFoundError(`${this.name}: domain ${domainName} not found in this account`);
    }
    return match;
  }

  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    const res = await this.call<PbNsResponse>(
      `/domain/getNs/${encodeURIComponent(domainName)}`,
      {},
      opts
    );
    if (!isOk(res)) throw new Error(res.message ?? 'API request failed');
    return res.ns ?? [];
  }

  /**
   * Porkbun exposes no WHOIS/contact retrieval endpoint — contact details are
   * only settable at registration and never read back through the API — so there
   * is no way to fulfil this. (Mirrors Spaceship's `getPricing` gap handling.)
   */
  override getContacts(_domainName: string, _opts?: RequestOptions): Promise<ContactSet> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: getContacts is not available — Porkbun's API has no contact-read ` +
          '(WHOIS) endpoint'
      )
    );
  }

  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const res = await this.call<PbDnsResponse>(
      `/dns/retrieve/${encodeURIComponent(domainName)}`,
      {},
      opts
    );
    if (!isOk(res)) throw new Error(res.message ?? 'API request failed');
    return (res.records ?? []).map(r => toDnsRecord(r, domainName));
  }

  /**
   * pricing/get returns every TLD's price points at once (as strings in major USD
   * units), so this fetches the table and picks the requested TLD. A full domain
   * is reduced to its TLD. Throws NotFoundError when the TLD isn't in the table.
   */
  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    const tld = extractTld(tldOrDomain);
    const res = await this.call<PbPricingResponse>('/pricing/get', {}, opts);
    if (!isOk(res)) throw new Error(res.message ?? 'API request failed');
    const price = res.pricing?.[tld];
    if (!price) {
      throw new NotFoundError(`${this.name}: no pricing found for TLD .${tld}`);
    }
    return {
      tld,
      currency: 'USD', // Porkbun prices are always quoted in USD
      registration: toPrice(price.registration),
      renewal: toPrice(price.renewal),
      transfer: toPrice(price.transfer),
    };
  }

  /**
   * Porkbun's checkDomain takes a single domain per call, so this issues one
   * request per name. The price it reports (major USD units) is the first-year
   * registration price for both regular and premium names.
   */
  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const results: DomainAvailability[] = [];
    for (const domainName of domainNames) {
      const res = await this.call<PbCheckResponse>(
        `/domain/checkDomain/${encodeURIComponent(domainName)}`,
        {},
        opts
      );
      if (!isOk(res)) throw new Error(res.message ?? 'API request failed');
      const info = res.response ?? {};
      const price = toPrice(info.price);
      results.push({
        domainName,
        available: info.avail === 'yes',
        premium: info.premium === 'yes',
        price,
        currency: price != null ? 'USD' : undefined,
        period: price != null ? 1 : undefined,
      });
    }
    return results;
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

// reduce a TLD or full domain to its bare TLD (no leading dot, lowercased). A
// multi-label TLD (e.g. "co.uk") is preserved by taking everything after the
// first label of a full domain.
function extractTld(tldOrDomain: string): string {
  const value = tldOrDomain.trim().toLowerCase().replace(/^\.+/, '');
  return value.includes('.') ? value.slice(value.indexOf('.') + 1) : value;
}

// parse a Porkbun price string (major USD units) into a number, or undefined
function toPrice(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// convert a Porkbun fully-qualified record name to a name relative to the zone
// apex ("@" at the apex), matching the DnsRecord contract.
function relativeName(name: string, domainName: string): string {
  const fqdn = normalizeDomain(name);
  const zone = normalizeDomain(domainName);
  if (fqdn === zone || fqdn === '') return '@';
  if (fqdn.endsWith(`.${zone}`)) return fqdn.slice(0, -(zone.length + 1));
  return fqdn;
}

// map a Porkbun DNS record to the normalized DnsRecord shape. Porkbun stores SRV
// data as prio=priority and content="weight port target"; other types put their
// value in `content`.
function toDnsRecord(r: PbDnsRecord, domainName: string): DnsRecord {
  const type = (r.type ?? '').toUpperCase();
  const record: DnsRecord = {
    type,
    name: relativeName(r.name ?? '', domainName),
    value: r.content ?? '',
  };
  if (r.ttl != null && r.ttl !== '') {
    const ttl = Number(r.ttl);
    if (Number.isFinite(ttl)) record.ttl = ttl;
  }
  const prio = r.prio != null && r.prio !== '' ? Number(r.prio) : NaN;
  if ((type === 'MX' || type === 'SRV') && Number.isFinite(prio)) {
    record.priority = prio;
  }
  if (type === 'SRV') {
    // content is "<weight> <port> <target>"
    const parts = (r.content ?? '').trim().split(/\s+/);
    if (parts.length === 3) {
      const weight = Number(parts[0]);
      const port = Number(parts[1]);
      if (Number.isFinite(weight)) record.weight = weight;
      if (Number.isFinite(port)) record.port = port;
      record.value = parts[2];
    }
  }
  return record;
}

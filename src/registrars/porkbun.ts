import type {
  ConfigField,
  Contact,
  ConnectionResult,
  ContactSet,
  DnsRecord,
  Domain,
  DomainAvailability,
  ListDomainsOptions,
  OperationResult,
  RegisterDomainInput,
  RegistrarOptions,
  RequestOptions,
  TldPricing,
  TransferDomainInput,
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

// bulk/per-domain response (e.g. domain/updateAutoRenew) — the per-domain
// outcome is nested under `results`, keyed by domain name.
interface PbBulkResponse extends PbResponse {
  results?: Record<string, { status?: string; message?: string }>;
}

// Porkbun's contact shape: phone is split into a national number plus a numeric
// country code, distinct from the library's single international `phone`.
interface PbContact {
  firstName: string;
  lastName: string;
  organization?: string;
  email: string;
  phone: string;
  phoneCountryCode: string;
  address1: string;
  address2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
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
 * Write field notes (all verified end-to-end in the sandbox): register and renew
 * take a `cost` in pennies that must exactly match the current price (fetched
 * from `checkDomain`/`pricing/get`), plus `agreeToTerms: "yes"` on register;
 * Porkbun always registers/renews the registry-minimum term, so `years` is not
 * honored. `create` carries no nameservers/auto-renew/contacts fields, so those
 * are applied as follow-up calls (contacts default to the account WHOIS at
 * registration — set them afterwards with `updateContacts`). Auto-renew is
 * toggled with `status: "on"|"off"` and reports its result in a nested
 * `results[domain]` object. Transfer-in needs `authCode` + the transfer `cost`.
 * Porkbun manages the apex NS records itself (creating NS at the apex is
 * rejected and its default nameservers auto-restore), so `setDnsRecords` leaves
 * them untouched.
 *
 * API gaps (left as NotImplementedError): the transfer lock is read-only via the
 * API (`securityLock` is exposed but has no toggle endpoint), WHOIS privacy has
 * no post-registration toggle (settable only at registration), and there is no
 * contact-read (WHOIS) endpoint.
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

  /**
   * Registers a domain. Porkbun's `create` requires a `cost` (pennies) that
   * exactly matches the domain's current price — fetched here via `checkDomain`
   * — plus agreement to its terms (sent automatically; invoking this method is
   * the agreement). It always registers the registry-minimum term, so `years` is
   * ignored. Contacts aren't accepted at registration (Porkbun applies the
   * account-default WHOIS); use `updateContacts` afterwards to set them.
   * Nameservers and auto-renew have no `create` field, so they're applied as
   * follow-up calls when provided.
   */
  override async registerDomain(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const [availability] = await this.checkAvailability([domainName], opts);
    if (!availability?.available) {
      throw new Error(`${this.name}: ${domainName} is not available for registration`);
    }
    if (availability.price == null) {
      throw new Error(`${this.name}: could not determine the registration price for ${domainName}`);
    }
    const body: Record<string, unknown> = {
      cost: toPennies(availability.price),
      agreeToTerms: 'yes',
    };
    // whoisPrivacy is optional; omitting it uses the account default
    if (input.privacy != null) body.whoisPrivacy = input.privacy;

    const res = await this.call(`/domain/create/${encodeURIComponent(domainName)}`, body, opts);
    if (!isOk(res)) return statusResult(res);

    // create has no nameserver / auto-renew fields — apply them separately
    if (input.nameservers && input.nameservers.length > 0) {
      await this.updateNameservers(domainName, input.nameservers, opts);
    }
    if (input.autoRenew != null) {
      await this.setAutoRenew(domainName, input.autoRenew, opts);
    }
    return { success: true, message: `Domain ${domainName} registered successfully` };
  }

  /**
   * Renews a domain. Porkbun renews the registry-minimum term (usually 1 year)
   * and ignores any requested `years`; it requires a `cost` (pennies) matching
   * the domain's current renewal price, fetched here from `pricing/get`. Premium
   * renewals aren't supported via the API.
   */
  override async renewDomain(
    domainName: string,
    _years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const pricing = await this.getPricing(extractTld(domainName), opts);
    if (pricing.renewal == null) {
      throw new Error(`${this.name}: could not determine the renewal price for ${domainName}`);
    }
    const res = await this.call(
      `/domain/renew/${encodeURIComponent(domainName)}`,
      { cost: toPennies(pricing.renewal) },
      opts
    );
    return statusResult(res);
  }

  override async setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const res = await this.call<PbBulkResponse>(
      `/domain/updateAutoRenew/${encodeURIComponent(domainName)}`,
      { status: enabled ? 'on' : 'off' },
      opts
    );
    // updateAutoRenew reports the real outcome in a nested results[domain] entry,
    // even when the top-level status is SUCCESS.
    return bulkResult(
      res,
      domainName,
      `Auto-renew ${enabled ? 'enabled' : 'disabled'} successfully`
    );
  }

  /**
   * Transfers a domain in with its EPP auth code. Porkbun's `transfer` requires a
   * `cost` (pennies) matching the current transfer price, fetched here from
   * `pricing/get`. The transfer body carries no contacts/privacy/auto-renew — the
   * existing registration's details carry over — and premium/`.uk` transfers
   * aren't supported via the API.
   */
  override async transferIn(
    domainName: string,
    input: TransferDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const pricing = await this.getPricing(extractTld(domainName), opts);
    if (pricing.transfer == null) {
      throw new Error(`${this.name}: could not determine the transfer price for ${domainName}`);
    }
    const res = await this.call(
      `/domain/transfer/${encodeURIComponent(domainName)}`,
      { authCode: input.authCode, cost: toPennies(pricing.transfer) },
      opts
    );
    return statusResult(res, `Domain ${domainName} transfer requested successfully`);
  }

  /**
   * Updates contact roles. Only the roles present in `contacts` are changed;
   * unspecified roles are left as-is. Porkbun splits the phone into a national
   * number plus a numeric country code, and runs Google Address Validation on
   * registrant changes for address-validated TLDs.
   */
  override async updateContacts(
    domainName: string,
    contacts: ContactSet,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const roles: Record<string, PbContact> = {};
    if (contacts.registrant) roles.registrant = toPorkbunContact(contacts.registrant);
    if (contacts.admin) roles.admin = toPorkbunContact(contacts.admin);
    if (contacts.tech) roles.tech = toPorkbunContact(contacts.tech);
    if (contacts.billing) roles.billing = toPorkbunContact(contacts.billing);
    if (Object.keys(roles).length === 0) {
      throw new Error(`${this.name}: updateContacts requires at least one contact role`);
    }
    const res = await this.call(
      `/domain/updateContacts/${encodeURIComponent(domainName)}`,
      { contacts: roles },
      opts
    );
    return statusResult(res, 'Contacts updated successfully');
  }

  /**
   * Replaces the entire editable record set (full-replace / PUT semantics):
   * retrieves the current records, deletes them, then creates the supplied set.
   * The apex NS records are Porkbun-managed (it rejects creating NS at the apex
   * and auto-restores its defaults), so they're skipped on both delete and
   * create. Because Porkbun has no atomic "set all" endpoint, this issues one
   * call per record.
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const zone = normalizeDomain(domainName);
    const existing = await this.call<PbDnsResponse>(
      `/dns/retrieve/${encodeURIComponent(domainName)}`,
      {},
      opts
    );
    if (!isOk(existing)) return statusResult(existing);

    for (const r of existing.records ?? []) {
      if (isApexNs(r.type, r.name, zone) || r.id == null) continue;
      const del = await this.call(
        `/dns/delete/${encodeURIComponent(domainName)}/${r.id}`,
        {},
        opts
      );
      if (!isOk(del)) return statusResult(del);
    }

    for (const record of records) {
      const name = relativeName(record.name, domainName);
      const type = record.type.toUpperCase();
      if (type === 'NS' && (name === '@' || name === '')) continue; // apex NS is managed by Porkbun
      const create = await this.call(
        `/dns/create/${encodeURIComponent(domainName)}`,
        toPorkbunDnsRecord(record, name, type),
        opts
      );
      if (!isOk(create)) return statusResult(create);
    }
    return { success: true, message: 'DNS records updated successfully' };
  }
}

// whether the response status is "SUCCESS"
function isOk(res: PbResponse): boolean {
  return res.status === 'SUCCESS';
}

// map a response's status to an OperationResult
function statusResult(res: PbResponse, successMessage = 'SUCCESS'): OperationResult {
  if (isOk(res)) return { success: true, message: res.message ?? successMessage };
  return { success: false, message: res.message ?? 'Unknown response' };
}

// map a bulk/per-domain response (e.g. updateAutoRenew) to an OperationResult.
// The top-level status can be SUCCESS while the per-domain entry failed, so the
// real outcome is read from results[domain].
function bulkResult(
  res: PbBulkResponse,
  domainName: string,
  successMessage: string
): OperationResult {
  const entry = res.results?.[domainName];
  if (isOk(res) && (!entry || entry.status === 'SUCCESS')) {
    return { success: true, message: entry?.message ?? successMessage };
  }
  return { success: false, message: entry?.message ?? res.message ?? 'Unknown response' };
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

// convert major USD units (e.g. 11.08) to integer pennies (1108), as Porkbun's
// `cost` field requires
function toPennies(major: number): number {
  return Math.round(major * 100);
}

// whether a record is an apex NS record (Porkbun-managed: can't be created and
// auto-restores, so setDnsRecords must leave it alone). `name` may be the
// fully-qualified host from a retrieve, or "@"/"" for the apex.
function isApexNs(type: string | undefined, name: string | undefined, zone: string): boolean {
  if ((type ?? '').toUpperCase() !== 'NS') return false;
  const n = normalizeDomain(name ?? '');
  return n === zone || n === '' || name === '@';
}

// map a normalized DnsRecord to a Porkbun dns/create body. `name` is already the
// zone-relative host ("@"/"" at the apex); Porkbun wants the bare subdomain
// (empty string at the apex). SRV data is packed as "<weight> <port> <target>".
function toPorkbunDnsRecord(
  record: DnsRecord,
  name: string,
  type: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: name === '@' ? '' : name,
    type,
    content: record.value,
  };
  if (record.ttl != null) body.ttl = String(record.ttl);
  if (record.priority != null) body.prio = String(record.priority);
  if (type === 'SRV') {
    body.content = `${record.weight ?? 0} ${record.port ?? 0} ${record.value}`;
  }
  return body;
}

// map the library's Contact to Porkbun's shape, splitting the international
// phone ("+1.4805551234") into a national number + numeric country code
function toPorkbunContact(c: Contact): PbContact {
  const { countryCode, national } = splitPhone(c.phone);
  const contact: PbContact = {
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: national,
    phoneCountryCode: countryCode,
    address1: c.address1,
    city: c.city,
    postalCode: c.postalCode,
    country: c.country,
  };
  if (c.organization) contact.organization = c.organization;
  if (c.address2) contact.address2 = c.address2;
  if (c.state) contact.state = c.state;
  return contact;
}

// split an international phone ("+1.4805551234" — "+<cc>.<national>") into its
// numeric country code and national number (digits only). Falls back gracefully
// for values without the leading "+" or the "." separator.
function splitPhone(phone: string): { countryCode: string; national: string } {
  const trimmed = (phone ?? '').trim();
  const dot = trimmed.indexOf('.');
  if (trimmed.startsWith('+') && dot > 1) {
    return {
      countryCode: trimmed.slice(1, dot).replace(/\D/g, ''),
      national: trimmed.slice(dot + 1).replace(/\D/g, ''),
    };
  }
  // no recognizable separator: return all digits as the national number
  return { countryCode: '', national: trimmed.replace(/\D/g, '') };
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

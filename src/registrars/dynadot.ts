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
  RegistrarOptions,
  RequestOptions,
  TldPricing,
  TransferDomainInput,
} from '../types';
import { createDomain, filterDomains, requireConsent } from '../utils';
import { NotFoundError, NotImplementedError, toRegistrarError } from '../errors';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import { Feature, type RegistrarFeature } from '../features';
import type { RegistrarCredentials } from '../types';

// a domain as Dynadot's api3 models it (list_domain / domain_info)
interface DynadotDomainInfo {
  Name?: string;
  Status?: string;
  Registration?: string | number;
  Expiration?: string | number;
  RenewOption?: string;
  Locked?: string;
  Privacy?: string;
  NameServerSettings?: unknown;
  // per-role contact ids (domain_info only); each role is `{ ContactId }`
  Whois?: DynadotWhois;
}

// the Whois block on domain_info: one `{ ContactId }` object per role
interface DynadotWhoisRole {
  ContactId?: string | number;
}

interface DynadotWhois {
  Registrant?: DynadotWhoisRole;
  Admin?: DynadotWhoisRole;
  Technical?: DynadotWhoisRole;
  Billing?: DynadotWhoisRole;
}

// a full contact record as `get_contact` returns it. Name is a single combined
// field (not first/last); phone/fax split into a country code + number.
interface DynadotContact {
  ContactId?: string | number;
  Name?: string;
  Organization?: string;
  Email?: string;
  PhoneCc?: string | number;
  PhoneNum?: string | number;
  FaxCc?: string | number;
  FaxNum?: string | number;
  Address1?: string;
  Address2?: string;
  City?: string;
  State?: string;
  ZipCode?: string;
  Country?: string;
}

// one result from the `search` command
interface DynadotSearchResult {
  DomainName?: string;
  Available?: string;
  // a human string like "77.00 in USD", not a number (api3 quirk)
  Price?: string;
  Premium?: string;
}

// a DNS record as get_dns returns it (Value2 carries a second value, e.g. MX distance)
interface DynadotDnsRecord {
  RecordType?: string;
  Subhost?: string;
  Value?: string;
  Value2?: string;
}

// Dynadot DNS record types set_dns2 understands that map cleanly to our generic
// DnsRecord types. (Dynadot also has `forward`/`stealth`/`email` record types,
// which are forwarding features, not generic DNS, so they're excluded here.)
const SUPPORTED_DNS_TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT']);

/**
 * Dynadot Registrar
 * API docs: https://www.dynadot.com/domain/api-document
 *
 * Targets Dynadot's legacy **API3 JSON** endpoint (`api3.json`), which
 * authenticates with a `key` query-string parameter (not a header), so the key
 * appears in the request URL — this is required by their API design. (The newer
 * RESTful v1 API needs HMAC request signing, which this client doesn't do.)
 *
 * Credentials: enable API access and generate an API key under Tools > API
 * (the account must be unlocked first to reveal the key).
 *
 * ## api3 envelope
 * Responses wrap the payload in a per-command envelope with a nested header and
 * content object, e.g. `{ GetDnsResponse: { GetDnsHeader: { ResponseCode },
 * GetDnsContent: {...} } }`. The naming is internally inconsistent — the success
 * field is `SuccessCode` on some commands and `ResponseCode` on others, and the
 * header key is `<Cmd>Header` or `<Cmd>ResponseHeader` — so `unwrap()` below
 * discovers the header/content generically rather than hard-coding names.
 * `ResponseCode`/`SuccessCode` `0` means success.
 *
 * `registerDomain`/`transferIn` are implemented and require per-call `consent`;
 * they use the account's default WHOIS contact (api3 doesn't take inline contact
 * data) and spend real money, so treat them as documented-but-unverified.
 *
 * `getContacts` reads the per-role `ContactId`s from `domain_info`'s `Whois`
 * block, then resolves each distinct id via `get_contact`. Dynadot's contact
 * shape is lossy against ours — a single `Name` field (split into first/last on
 * the first space) and separate `PhoneCc`/`PhoneNum` (rejoined as `+cc.num`).
 *
 * ## Not implemented (fall through to BaseRegistrar's NotImplementedError)
 * - `updateContacts` — api3 sets a domain's whois from an existing numeric
 *   `ContactId` (via `set_contact`/`set_whois`), not from inline contact data,
 *   so mapping our `Contact` onto it needs a create-or-match step; unverified.
 *
 * Confirmed against real captures / the `7c/dynadot` wrapper: the envelope,
 * `list_domain`, `domain_info`, `get_dns`, `set_dns2`, `set_ns`. Implemented
 * from docs but not yet verified live: `search` (availability/pricing),
 * `set_renew_option`, `set_privacy` — flagged inline.
 */
export class DynadotRegistrar extends BaseRegistrar {
  readonly name = 'dynadot';

  static readonly displayName = 'Dynadot';
  static readonly helpText =
    'Find your API Key in your Dynadot account under Tools > API. ' +
    'You must unlock the account and enable API access to reveal the key.';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
  ];
  static readonly supportsSandbox = false; // Dynadot has no public sandbox environment
  // Broadest coverage of the set: on top of core, it adds DNSSEC, glue records,
  // email + domain forwarding, webhooks, aftermarket/marketplace, push,
  // appraisal, and bulk (Smart Folder) settings. Email is forwarding-only.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.GetAuthCode,
    Feature.SetDnssec,
    Feature.GetGlueRecords,
    Feature.SetGlueRecords,
    Feature.SetEmailForwarding,
    Feature.SetDomainForwarding,
    Feature.SubscribeWebhooks,
    Feature.ListOnMarketplace,
    Feature.PushToAccount,
    Feature.AppraiseDomain,
    Feature.ApplyBulkSettings,
  ];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    // baseUrl is the full endpoint; all commands are query-string based
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('Dynadot', options?.environment, {
          production: 'https://api.dynadot.com/api3.json',
        }),
      },
      options
    );
  }

  // issue a command against the api3.json endpoint (key + command in the query)
  private command(query: Record<string, string | number>, opts?: RequestOptions): Promise<unknown> {
    return this.http.request<unknown>({
      path: '',
      query: { key: this.credentials.apiKey, ...query },
      ...opts,
    });
  }

  // run a command and return its content payload, throwing on a non-success code
  private async read(
    query: Record<string, string | number>,
    opts?: RequestOptions
  ): Promise<Record<string, unknown>> {
    const env = unwrap(await this.command(query, opts));
    if (!env.ok) throw new Error(env.message);
    return env.content;
  }

  // run a mutating command and map its envelope to an OperationResult
  private async mutate(
    query: Record<string, string | number>,
    successMessage: string,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const env = unwrap(await this.command(query, opts));
      return { success: env.ok, message: env.ok ? successMessage : env.message };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      const env = unwrap(await this.command({ command: 'list_domain' }, opts));
      return env.ok
        ? { success: true, message: 'Connection successful' }
        : { success: false, message: env.message };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    // list_domain returns the whole account in one response and already includes
    // nameservers inline (NameServerSettings).
    const { search, ...reqOpts } = opts ?? {};
    const content = await this.read({ command: 'list_domain' }, reqOpts);
    // ListDomainInfoContent > DomainInfoList > DomainInfo (array)
    const list = asRecord(content.DomainInfoList);
    const infos = asArray<DynadotDomainInfo>(list.DomainInfo);
    const domains = infos.map(info => this.toDomain(info));
    return filterDomains(domains, search);
  }

  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    const content = await this.read({ command: 'domain_info', domain: domainName }, opts);
    const info = content.DomainInfo as DynadotDomainInfo | undefined;
    if (!info) throw new NotFoundError(`Dynadot: domain '${domainName}' not found`);
    return this.toDomain(info);
  }

  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    const domain = await this.getDomain(domainName, opts);
    return domain.nameservers;
  }

  /**
   * Reads the registrant/admin/tech/billing contacts. `domain_info` only carries
   * a numeric `ContactId` per role in its `Whois` block, so this resolves each
   * distinct id with a `get_contact` call (roles typically share one contact, so
   * ids are de-duplicated). A `0`/empty id means the role has no dedicated
   * contact (the account default whois), and is left unset.
   */
  override async getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    const content = await this.read({ command: 'domain_info', domain: domainName }, opts);
    const info = content.DomainInfo as DynadotDomainInfo | undefined;
    if (!info) throw new NotFoundError(`Dynadot: domain '${domainName}' not found`);

    const whois = info.Whois ?? {};
    const roleIds: [keyof ContactSet, string][] = [
      ['registrant', contactId(whois.Registrant)],
      ['admin', contactId(whois.Admin)],
      ['tech', contactId(whois.Technical)],
      ['billing', contactId(whois.Billing)],
    ];

    // fetch each distinct, non-default id once
    const byId = new Map<string, Contact>();
    for (const [, id] of roleIds) {
      if (!id || id === '0' || byId.has(id)) continue;
      const res = await this.read({ command: 'get_contact', contact_id: id }, opts);
      byId.set(id, toContact(asRecord(res.Contact ?? res)));
    }

    const contacts: ContactSet = {};
    for (const [role, id] of roleIds) {
      const contact = byId.get(id);
      if (contact) contacts[role] = contact;
    }
    return contacts;
  }

  /**
   * Availability via the `search` command (`show_price=1` returns the price).
   * Note: api3's `search` reports price as a human string like "77.00 in USD",
   * parsed here into `price` + `currency`. Response shape is doc-sourced and not
   * yet verified against a live account.
   */
  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const query: Record<string, string | number> = { command: 'search', show_price: 1 };
    domainNames.forEach((d, i) => {
      query[`domain${i}`] = d;
    });
    const content = await this.read(query, opts);
    const results = asArray<DynadotSearchResult>(content.SearchResults ?? content.Results);
    return results.map(r => {
      const { price, currency } = parsePrice(r.Price);
      return {
        domainName: r.DomainName ?? '',
        available: r.Available === 'yes',
        premium: r.Premium != null ? r.Premium === 'yes' : undefined,
        price,
        currency,
        period: price != null ? 1 : undefined,
      };
    });
  }

  /**
   * Dynadot's per-TLD `tld_price` command returns the entire TLD table with an
   * under-documented inner shape. Mirroring GoDaddy, `getPricing` instead derives
   * a specific domain's registration price from an availability check, so it
   * needs a full domain (e.g. "example.com"); a bare TLD throws.
   */
  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    if (!tldOrDomain.includes('.')) {
      throw new NotImplementedError(
        `${this.name}: getPricing needs a full domain (e.g. "example.com"); ` +
          'per-TLD pricing via tld_price is not wired up'
      );
    }
    const [result] = await this.checkAvailability([tldOrDomain], opts);
    const tld = tldOrDomain.slice(tldOrDomain.indexOf('.') + 1);
    return {
      tld,
      currency: result?.currency ?? 'USD',
      registration: result?.price,
    };
  }

  /**
   * Registers a domain (`duration` is years). api3 register uses the account's
   * default WHOIS contact — it doesn't accept inline contact data (contacts are
   * separate, id-referenced records), so `input.contacts` is not sent. Privacy
   * has no register param, so a requested `privacy` is applied via a follow-up
   * `set_privacy`.
   */
  override async registerDomain(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    requireConsent(this.name, input.consent);
    const res = await this.mutate(
      { command: 'register', domain: domainName, duration: input.years ?? 1 },
      `Domain ${domainName} registered successfully`,
      opts
    );
    if (res.success && input.privacy) {
      const privacyResult = await this.setPrivacy(domainName, true, opts);
      if (!privacyResult.success) {
        return {
          success: true,
          message: `Domain registered, but enabling privacy failed: ${privacyResult.message}`,
        };
      }
    }
    return res;
  }

  /**
   * Transfers a domain in with its auth/EPP code (the api3 param is `auth`).
   * Contacts come from the account default, as with registration.
   */
  override async transferIn(
    domainName: string,
    input: TransferDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    requireConsent(this.name, input.consent);
    return this.mutate(
      { command: 'transfer', domain: domainName, auth: input.authCode },
      `Domain ${domainName} transfer requested successfully`,
      opts
    );
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      { command: 'renew', domain: domainName, duration: years },
      'Domain renewed successfully',
      opts
    );
  }

  /**
   * Auto-renew via `set_renew_option`. The accepted value strings (`auto` /
   * `donot`) are doc-sourced and not yet verified live — Dynadot's newer v1 API
   * uses `auto`/`manual`/`off`, so confirm against a live account.
   */
  override async setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      { command: 'set_renew_option', domain: domainName, renew_option: enabled ? 'auto' : 'donot' },
      `Auto-renew ${enabled ? 'enabled' : 'disabled'} successfully`,
      opts
    );
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 2 || nameservers.length > 13) {
      throw new Error('Dynadot requires 2-13 nameservers');
    }
    const query: Record<string, string | number> = { command: 'set_ns', domain: domainName };
    nameservers.forEach((ns, i) => {
      query[`ns${i}`] = ns;
    });
    return this.mutate(query, 'Nameservers updated successfully', opts);
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      { command: 'set_lock', domain: domainName, lock: 'yes' },
      'Domain locked successfully',
      opts
    );
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      { command: 'set_lock', domain: domainName, lock: 'no' },
      'Domain unlocked successfully',
      opts
    );
  }

  /**
   * WHOIS privacy via `set_privacy` (`option=full` to enable, `off` to disable).
   * The option strings are doc-sourced and not yet verified live.
   */
  override async setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      { command: 'set_privacy', domain: domainName, option: enabled ? 'full' : 'off' },
      `Privacy ${enabled ? 'enabled' : 'disabled'} successfully`,
      opts
    );
  }

  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const content = await this.read({ command: 'get_dns', domain: domainName }, opts);
    // GetDnsContent > NameServerSettings > { MainDomains.MainDomainRecord[],
    // SubDomains.SubDomainRecord[], TTL }
    const settings = asRecord(content.NameServerSettings);
    const ttl = settings.TTL != null ? Number(settings.TTL) : undefined;

    const main = asArray<DynadotDnsRecord>(asRecord(settings.MainDomains).MainDomainRecord);
    const sub = asArray<DynadotDnsRecord>(asRecord(settings.SubDomains).SubDomainRecord);

    return [
      ...main.map(r => toDnsRecord(r, '@', ttl)),
      ...sub.map(r => toDnsRecord(r, r.Subhost ?? '', ttl)),
    ];
  }

  /**
   * Replaces the entire record set via `set_dns2` (default overwrite semantics:
   * records not present are removed). Records are split into apex ("main") and
   * subdomain params. Only generic DNS types are supported — Dynadot's
   * forwarding/email pseudo-records aren't expressible here, so an unsupported
   * type throws rather than being silently dropped.
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const query: Record<string, string | number> = { command: 'set_dns2', domain: domainName };
    let mainIdx = 0;
    let subIdx = 0;
    let ttl: number | undefined;

    for (const r of records) {
      const type = r.type.toUpperCase();
      if (!SUPPORTED_DNS_TYPES.has(type)) {
        throw new Error(`Dynadot: DNS record type '${type}' is not supported via set_dns2`);
      }
      if (ttl == null && r.ttl != null) ttl = r.ttl;

      const isApex = r.name === '@' || r.name === '' || r.name === domainName;
      if (isApex) {
        query[`main_record_type${mainIdx}`] = type.toLowerCase();
        query[`main_record${mainIdx}`] = r.value;
        // MX distance rides in the second-value param (Value2 on read)
        if (type === 'MX' && r.priority != null) query[`main_recordx${mainIdx}`] = r.priority;
        mainIdx++;
      } else {
        query[`subdomain${subIdx}`] = r.name;
        query[`sub_record_type${subIdx}`] = type.toLowerCase();
        query[`sub_record${subIdx}`] = r.value;
        if (type === 'MX' && r.priority != null) query[`sub_recordx${subIdx}`] = r.priority;
        subIdx++;
      }
    }
    if (ttl != null) query.ttl = ttl;

    return this.mutate(query, 'DNS records updated successfully', opts);
  }

  // map a Dynadot domain payload to the normalized Domain shape
  private toDomain(d: DynadotDomainInfo): Domain {
    return createDomain({
      domainName: d.Name,
      registrar: this.name,
      status: d.Status ?? '',
      createdDate: d.Registration ?? null,
      expirationDate: d.Expiration ?? null,
      renewalDate: d.Expiration ?? null,
      autoRenew: d.RenewOption === 'auto' || d.RenewOption === 'auto-renew',
      locked: d.Locked === 'yes',
      privacy: d.Privacy === 'full' || d.Privacy === 'partial',
      nameservers: extractNameservers(d.NameServerSettings),
    });
  }
}

// --- api3 envelope handling ---

interface Envelope {
  ok: boolean;
  message: string;
  content: Record<string, unknown>;
}

/**
 * Unwrap a Dynadot api3 response. The payload is wrapped as
 * `{ <Cmd>Response: { <Cmd>Header: {...}, <Cmd>Content: {...} } }`, but the
 * header/content key names and the success field (`SuccessCode` vs
 * `ResponseCode`) vary by command, so we discover them structurally: any key
 * ending in `Header`/`Content`, falling back to the response object itself for
 * older flat commands. Success is code `0`; errors carry a `Status`/`Error`.
 */
function unwrap(res: unknown): Envelope {
  const root = asRecord(res);
  const keys = Object.keys(root);
  // descend one level into the single `<Cmd>Response` wrapper when present
  const inner: Record<string, unknown> =
    keys.length === 1 && isRecord(root[keys[0]]) ? asRecord(root[keys[0]]) : root;

  const headerKey = Object.keys(inner).find(k => /Header$/.test(k));
  const contentKey = Object.keys(inner).find(k => /Content$/.test(k));
  const header = headerKey && isRecord(inner[headerKey]) ? inner[headerKey] : inner;
  const content = contentKey && isRecord(inner[contentKey]) ? inner[contentKey] : inner;

  const codeRaw =
    header.SuccessCode ?? header.ResponseCode ?? inner.SuccessCode ?? inner.ResponseCode;
  const code = typeof codeRaw === 'string' || typeof codeRaw === 'number' ? String(codeRaw) : '';
  const ok = code === '0';

  const statusRaw = header.Error ?? header.Status ?? inner.Error ?? inner.Status;
  const message =
    typeof statusRaw === 'string' && statusRaw
      ? statusRaw
      : ok
        ? 'success'
        : `Dynadot request failed (code ${code || 'unknown'})`;

  return { ok, message, content };
}

// map a Dynadot DNS record to the normalized DnsRecord shape
function toDnsRecord(r: DynadotDnsRecord, name: string, ttl: number | undefined): DnsRecord {
  const type = (r.RecordType ?? '').toUpperCase();
  const record: DnsRecord = { type, name, value: r.Value ?? '' };
  if (ttl != null) record.ttl = ttl;
  // MX distance comes back in Value2
  if (type === 'MX' && r.Value2 != null && r.Value2 !== '') record.priority = Number(r.Value2);
  return record;
}

// --- contact mapping between Dynadot's shape and the normalized Contact ---

// read a role's numeric ContactId as a string ('' when absent)
function contactId(role: DynadotWhoisRole | undefined): string {
  return str(role?.ContactId);
}

// map a Dynadot get_contact record to the normalized Contact shape
function toContact(c: DynadotContact): Contact {
  const { firstName, lastName } = splitName(str(c.Name));
  const contact: Contact = {
    firstName,
    lastName,
    email: str(c.Email),
    phone: joinPhone(c.PhoneCc, c.PhoneNum),
    address1: str(c.Address1),
    city: str(c.City),
    postalCode: str(c.ZipCode),
    country: str(c.Country),
  };
  const organization = str(c.Organization);
  if (organization) contact.organization = organization;
  const fax = joinPhone(c.FaxCc, c.FaxNum);
  if (fax) contact.fax = fax;
  const address2 = str(c.Address2);
  if (address2) contact.address2 = address2;
  const state = str(c.State);
  if (state) contact.state = state;
  return contact;
}

// Dynadot stores a single combined name; split it into first/last on the first
// space (a lone token becomes the first name, with an empty last name).
function splitName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  const space = trimmed.indexOf(' ');
  if (space === -1) return { firstName: trimmed, lastName: '' };
  return { firstName: trimmed.slice(0, space), lastName: trimmed.slice(space + 1).trim() };
}

// rejoin a split country code + number as "+cc.number" (e.g. "+1.4805551234")
function joinPhone(cc: string | number | undefined, num: string | number | undefined): string {
  const number = str(num);
  if (!number) return '';
  const code = str(cc);
  return code ? `+${code}.${number}` : number;
}

// stringify a loosely-typed api3 scalar, guarding against objects/arrays
function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

// parse an api3 price string like "77.00 in USD" into a number + currency
function parsePrice(raw: string | undefined): { price?: number; currency?: string } {
  if (!raw) return {};
  const match = /([\d.]+)\s*(?:in\s*)?([A-Z]{3})?/.exec(raw);
  if (!match) return {};
  const price = Number(match[1]);
  return {
    price: Number.isFinite(price) ? price : undefined,
    currency: match[2],
  };
}

// Dynadot nameserver settings can be an array or an object with a NameServers array
function extractNameservers(settings: unknown): string[] {
  if (!settings) return [];
  if (Array.isArray(settings)) return settings.map(String);
  if (typeof settings === 'object' && 'NameServers' in settings) {
    const ns = (settings as { NameServers?: unknown }).NameServers;
    return Array.isArray(ns) ? ns.map(String) : [];
  }
  return [];
}

// --- small structural helpers for the loosely-typed api3 JSON ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

// api3 collapses single-element lists to a bare object; normalize to an array
function asArray<T>(value: unknown): T[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

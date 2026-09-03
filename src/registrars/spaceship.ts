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
import { createDomain, filterDomains, requireConsent, sleep } from '../utils';
import { NotImplementedError, toRegistrarError } from '../errors';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import { Feature, type RegistrarFeature } from '../features';
import type { RegistrarCredentials } from '../types';

interface SpaceshipNameservers {
  provider?: string;
  hosts?: string[];
}

interface SpaceshipPrivacy {
  contactForm?: boolean;
  level?: string; // "public" | "high"
}

interface SpaceshipDomainContacts {
  registrant?: string;
  admin?: string;
  tech?: string;
  billing?: string;
}

interface SpaceshipDomain {
  name: string;
  unicodeName?: string;
  isPremium?: boolean;
  autoRenew?: boolean;
  registrationDate?: string;
  expirationDate?: string;
  lifecycleStatus?: string;
  eppStatuses?: string[];
  privacyProtection?: SpaceshipPrivacy;
  nameservers?: SpaceshipNameservers;
  contacts?: SpaceshipDomainContacts;
}

interface SpaceshipPage<T> {
  items?: T[];
  total?: number;
}

// one premium price point from an availability check
interface SpaceshipPremiumPrice {
  operation?: string; // "register" | "transfer" | "renew" | "restore"
  price?: number;
  currency?: string;
}

interface SpaceshipAvailability {
  domain?: string;
  result?: string; // "available" | "taken" | "invalidDomainName" | ...
  premiumPricing?: SpaceshipPremiumPrice[];
}

// a contact record (ContactDetails)
interface SpaceshipContact {
  firstName?: string;
  lastName?: string;
  organization?: string;
  email?: string;
  address1?: string;
  address2?: string;
  city?: string;
  stateProvince?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  phoneExt?: string;
  fax?: string;
}

// a DNS record (ResourceRecord — a discriminated union on `type`)
interface SpaceshipRecord {
  type?: string;
  name?: string;
  ttl?: number;
  group?: { type?: string }; // "custom" | "product" | "personalNs" (read-only)
  address?: string; // A / AAAA
  cname?: string; // CNAME
  nameserver?: string; // NS
  value?: string; // TXT / CAA
  exchange?: string; // MX
  preference?: number; // MX priority
  target?: string; // SRV / ALIAS
  priority?: number; // SRV
  weight?: number; // SRV
  port?: number; // SRV
}

// DNS types this provider can write from our generic DnsRecord shape. Others
// (SRV, CAA, HTTPS, …) need sub-fields our record doesn't carry, so writing them
// throws rather than sending an incomplete record. Reads handle every type.
const WRITABLE_DNS_TYPES = new Set(['A', 'AAAA', 'CNAME', 'NS', 'TXT', 'MX']);

/**
 * Spaceship Registrar
 * API docs: https://docs.spaceship.dev/
 *
 * Credentials: generate an API key + secret in the Spaceship API Manager
 * ("New API key"). Both are sent as X-Api-Key and X-Api-Secret headers.
 *
 * Modern REST/JSON API (`/api/v1`). A few operations are asynchronous — register,
 * transfer, and renew return `202` with a `spaceship-async-operationid` header
 * and complete out of band (poll `GET /async-operations/{id}`); the rest are
 * synchronous 2xx/204.
 *
 * `registerDomain`/`transferIn` are implemented (async, 202) and require
 * per-call `consent`; they spend real money and haven't been exercised against a
 * funded account, so treat them as documented-but-unverified.
 *
 * `getPricing` is overridden to throw a specific error: Spaceship exposes no
 * pricing endpoint at all (only per-domain premium prices via an availability
 * check), so there's no TLD price to return.
 */
export class SpaceshipRegistrar extends BaseRegistrar {
  readonly name = 'spaceship';

  static readonly displayName = 'Spaceship';
  static readonly website = 'spaceship.com';
  static readonly helpText =
    'Generate your API key and secret in the API Manager at Spaceship using the ' +
    '"New API key" button. The API requires both X-API-Key and X-API-Secret headers.';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', required: true },
  ];
  static readonly supportsSandbox = false; // Spaceship has no public sandbox environment
  // Modern REST API. Beyond core: transfer-out auth-code retrieval
  // (GET .../transfer/auth-code). No DNSSEC or forwarding via the API; Spacemail
  // (email) has no public API.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [Feature.GetAuthCode];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('Spaceship', options?.environment, {
          production: 'https://spaceship.dev/api',
        }),
        headers: {
          'X-API-Key': credentials.apiKey,
          'X-API-Secret': credentials.apiSecret,
          'Content-Type': 'application/json',
        },
      },
      options
    );
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      await this.http.request<SpaceshipPage<SpaceshipDomain>>({
        path: '/v1/domains',
        query: { take: 1, skip: 0 },
        ...opts,
      });
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    // No server-side name filter on this endpoint, so `search` is client-side.
    const { search, ...reqOpts } = opts ?? {};
    const domains: Domain[] = [];
    const take = 100; // Spaceship API maximum page size (1-100)
    let skip = 0;
    let hasMore = true;

    while (hasMore) {
      const res = await this.http.request<SpaceshipPage<SpaceshipDomain>>({
        path: '/v1/domains',
        query: { take, skip },
        ...reqOpts,
      });
      const list = res.items ?? [];
      for (const d of list) domains.push(this.toDomain(d));
      hasMore = list.length === take;
      skip += take;
      if (hasMore) await sleep(200); // gentle rate limiting between pages
    }
    return filterDomains(domains, search);
  }

  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    return this.toDomain(await this.getRaw(domainName, opts));
  }

  // getNameservers reads the same getRaw payload as getDomain (no dedicated NS
  // endpoint), so listing enrichment gains nothing from the fallback — skip it.
  override readonly requiresNameserversFetch = false;

  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    const d = await this.getRaw(domainName, opts);
    return d.nameservers?.hosts ?? [];
  }

  /**
   * Transfer authorization (EPP) code via GET /v1/domains/{domain}/transfer/auth-code.
   * Synchronous; the code is returned in `authCode`. Requires the API key to
   * carry the `domains:transfer` scope.
   */
  override async getAuthCode(domainName: string, opts?: RequestOptions): Promise<string> {
    const res = await this.http.request<{ authCode?: string }>({
      path: `/v1/domains/${encodeURIComponent(domainName)}/transfer/auth-code`,
      ...opts,
    });
    return res.authCode ?? '';
  }

  /**
   * Bulk availability via POST /v1/domains/available. Spaceship reports a `result`
   * enum (not a bool) and only carries a price for *premium* names, so `price` is
   * set from the premium "register" price when present.
   */
  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const res = await this.http.request<{ domains?: SpaceshipAvailability[] }>({
      method: 'POST',
      path: '/v1/domains/available',
      body: { domains: domainNames },
      ...opts,
    });
    return (res.domains ?? []).map(a => {
      const premium = (a.premiumPricing?.length ?? 0) > 0;
      const registerPrice = a.premiumPricing?.find(p => p.operation === 'register');
      return {
        domainName: a.domain ?? '',
        available: a.result === 'available',
        premium,
        price: registerPrice?.price,
        currency: registerPrice?.currency,
      };
    });
  }

  override getPricing(_tldOrDomain: string, _opts?: RequestOptions): Promise<TldPricing> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: getPricing is not available — Spaceship exposes no pricing endpoint ` +
          '(only per-domain premium prices via an availability check)'
      )
    );
  }

  /**
   * Registers a domain. Contacts are separate resources, so this saves each
   * supplied contact (getting an id) and references the ids on the domain;
   * omitted roles fall back to the registrant. Registration is async (202).
   */
  override async registerDomain(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    requireConsent(this.name, input.consent);
    if (!input.contacts.registrant) {
      throw new Error(`${this.name}: registration requires at least a registrant contact`);
    }
    try {
      const contacts = await this.saveContactSet(input.contacts, opts);
      const body = {
        autoRenew: input.autoRenew ?? false,
        years: input.years ?? 1,
        privacyProtection: { level: input.privacy ? 'high' : 'public', userConsent: true },
        contacts,
      };
      await this.http.request({
        method: 'POST',
        path: `/v1/domains/${encodeURIComponent(domainName)}`,
        body,
        ...opts,
      });
      return { success: true, message: `Domain ${domainName} registration requested successfully` };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  /**
   * Transfers a domain in with its auth code. Contacts are optional (Spaceship
   * carries over the existing registration's where not supplied); when given,
   * they're saved and referenced by id. Async (202).
   */
  override async transferIn(
    domainName: string,
    input: TransferDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    requireConsent(this.name, input.consent);
    try {
      const body: Record<string, unknown> = {
        authCode: input.authCode,
        autoRenew: input.autoRenew ?? false,
      };
      if (input.privacy != null) {
        body.privacyProtection = { level: input.privacy ? 'high' : 'public', userConsent: true };
      }
      if (input.contacts) body.contacts = await this.saveContactSet(input.contacts, opts);
      await this.http.request({
        method: 'POST',
        path: `/v1/domains/${encodeURIComponent(domainName)}/transfer`,
        body,
        ...opts,
      });
      return { success: true, message: `Domain ${domainName} transfer requested successfully` };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  /**
   * Renewal is async (202 + operation id). Spaceship requires the current
   * expiration date as a guard, so this fetches the domain first to supply it.
   */
  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const d = await this.getRaw(domainName, opts);
    if (!d.expirationDate) {
      throw new Error(`Spaceship: could not determine current expiration date for ${domainName}`);
    }
    return this.mutate(
      {
        method: 'POST',
        path: `/v1/domains/${encodeURIComponent(domainName)}/renew`,
        body: { years, currentExpirationDate: d.expirationDate },
      },
      'Domain renewal requested successfully',
      opts
    );
  }

  override async setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PUT',
        path: `/v1/domains/${encodeURIComponent(domainName)}/autorenew`,
        body: { isEnabled: enabled },
      },
      `Auto-renew ${enabled ? 'enabled' : 'disabled'} successfully`,
      opts
    );
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PUT',
        path: `/v1/domains/${encodeURIComponent(domainName)}/nameservers`,
        // custom nameservers go under a provider wrapper
        body: { provider: 'custom', hosts: nameservers },
      },
      'Nameservers updated successfully',
      opts
    );
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PUT',
        path: `/v1/domains/${encodeURIComponent(domainName)}/transfer/lock`,
        body: { isLocked: true },
      },
      'Domain transfer lock enabled successfully',
      opts
    );
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PUT',
        path: `/v1/domains/${encodeURIComponent(domainName)}/transfer/lock`,
        body: { isLocked: false },
      },
      'Domain transfer lock disabled successfully',
      opts
    );
  }

  /**
   * WHOIS privacy via the privacy preference (`public` = details visible, `high`
   * = protected). Enabling requires consent, which calling this with
   * `enabled = true` supplies.
   */
  override async setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PUT',
        path: `/v1/domains/${encodeURIComponent(domainName)}/privacy/preference`,
        body: { privacyLevel: enabled ? 'high' : 'public', userConsent: enabled },
      },
      `Privacy ${enabled ? 'enabled' : 'disabled'} successfully`,
      opts
    );
  }

  override async getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    const d = await this.getRaw(domainName, opts);
    const refs = d.contacts ?? {};
    // contacts are referenced by id; resolve each present role in parallel
    const [registrant, admin, tech, billing] = await Promise.all([
      this.getContact(refs.registrant, opts),
      this.getContact(refs.admin, opts),
      this.getContact(refs.tech, opts),
      this.getContact(refs.billing, opts),
    ]);
    return { registrant, admin, tech, billing };
  }

  /**
   * Two-step: save each supplied contact (which returns a contact id), then
   * assign the ids to the domain. Spaceship requires a registrant on assignment,
   * so any omitted role falls back to the registrant.
   */
  override async updateContacts(
    domainName: string,
    contacts: ContactSet,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (!contacts.registrant) {
      throw new Error(`${this.name}: updateContacts requires at least a registrant contact`);
    }
    try {
      const contactIds = await this.saveContactSet(contacts, opts);
      await this.http.request({
        method: 'PUT',
        path: `/v1/domains/${encodeURIComponent(domainName)}/contacts`,
        body: contactIds,
        ...opts,
      });
      return { success: true, message: 'Contacts updated successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const records = await this.fetchRecords(domainName, opts);
    return records.map(toDnsRecord);
  }

  /**
   * Spaceship's DNS API is upsert-based (PUT adds/updates; there is no atomic
   * replace). To honor replace semantics, this upserts the new set, then deletes
   * any custom records whose (type, name) is no longer present — done in that
   * order so the zone is never momentarily empty. Only the common record types
   * are writable from the generic shape (see `WRITABLE_DNS_TYPES`).
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const items = records.map(toSpaceshipRecord);
    try {
      const existing = await this.fetchRecords(domainName, opts);

      // The upsert endpoint rejects an empty `items` array (422), so skip it when
      // there's nothing to add/replace — clearing a zone is then handled entirely
      // by the stale-delete pass below.
      if (items.length > 0) {
        await this.http.request({
          method: 'PUT',
          path: `/v1/dns/records/${encodeURIComponent(domainName)}`,
          body: { force: true, items },
          ...opts,
        });
      }

      // delete custom records whose (type, name) no longer appears in the new
      // set. Spaceship's delete endpoint matches on the full record, so it needs
      // each record's value field (address/cname/value/exchange/…) — send the
      // existing records with only the read-only `group` metadata stripped.
      const keep = new Set(items.map(r => recordKey(r.type, r.name)));
      const stale = existing
        .filter(r => (r.group?.type ?? 'custom') === 'custom')
        .filter(r => !keep.has(recordKey(r.type, r.name)))
        .map(({ group: _group, ...rr }) => rr);
      if (stale.length > 0) {
        await this.http.request({
          method: 'DELETE',
          path: `/v1/dns/records/${encodeURIComponent(domainName)}`,
          body: stale,
          ...opts,
        });
      }
      return { success: true, message: 'DNS records updated successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  // --- internal helpers ---

  // GET a single domain's raw payload
  private getRaw(domainName: string, opts?: RequestOptions): Promise<SpaceshipDomain> {
    return this.http.request<SpaceshipDomain>({
      path: `/v1/domains/${encodeURIComponent(domainName)}`,
      ...opts,
    });
  }

  // resolve one contact id to a normalized Contact (undefined if unset)
  private async getContact(
    id: string | undefined,
    opts?: RequestOptions
  ): Promise<Contact | undefined> {
    if (!id) return undefined;
    const c = await this.http.request<SpaceshipContact>({
      path: `/v1/contacts/${encodeURIComponent(id)}`,
      ...opts,
    });
    return fromSpaceshipContact(c);
  }

  // save all four contact roles and return their ids (Spaceship requires a
  // registrant; omitted roles fall back to it)
  private async saveContactSet(
    contacts: ContactSet,
    opts?: RequestOptions
  ): Promise<SpaceshipDomainContacts> {
    if (!contacts.registrant) {
      throw new Error(`${this.name}: a registrant contact is required`);
    }
    const registrant = await this.saveContact(contacts.registrant, opts);
    return {
      registrant,
      admin: contacts.admin ? await this.saveContact(contacts.admin, opts) : registrant,
      tech: contacts.tech ? await this.saveContact(contacts.tech, opts) : registrant,
      billing: contacts.billing ? await this.saveContact(contacts.billing, opts) : registrant,
    };
  }

  // save a contact and return its Spaceship contact id
  private async saveContact(contact: Contact, opts?: RequestOptions): Promise<string> {
    const res = await this.http.request<{ contactId: string }>({
      method: 'PUT',
      path: '/v1/contacts',
      body: toSpaceshipContact(contact),
      ...opts,
    });
    return res.contactId;
  }

  // fetch all DNS records for a domain (paginated; take/skip are required)
  private async fetchRecords(
    domainName: string,
    opts?: RequestOptions
  ): Promise<SpaceshipRecord[]> {
    const records: SpaceshipRecord[] = [];
    const take = 100;
    let skip = 0;
    let hasMore = true;
    while (hasMore) {
      const res = await this.http.request<SpaceshipPage<SpaceshipRecord>>({
        path: `/v1/dns/records/${encodeURIComponent(domainName)}`,
        query: { take, skip },
        ...opts,
      });
      const items = res.items ?? [];
      records.push(...items);
      hasMore = items.length === take;
      skip += take;
      if (hasMore) await sleep(200);
    }
    return records;
  }

  // map a Spaceship domain payload to the normalized Domain shape
  private toDomain(d: SpaceshipDomain): Domain {
    return createDomain({
      domainName: d.name,
      registrar: this.name,
      status: d.lifecycleStatus ?? '',
      createdDate: d.registrationDate,
      expirationDate: d.expirationDate,
      renewalDate: d.expirationDate,
      autoRenew: d.autoRenew ?? false,
      // transfer lock shows up as an EPP status, not a dedicated flag
      locked: (d.eppStatuses ?? []).includes('clientTransferProhibited'),
      privacy: d.privacyProtection?.level === 'high',
      // normalizeNameservers understands the { hosts } shape
      nameservers: d.nameservers,
    });
  }

  // run a mutating request; success is any 2xx (async ops return 202)
  private async mutate(
    req: { method: string; path: string; body?: unknown },
    successMessage: string,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      await this.http.request({ ...req, ...opts });
      return { success: true, message: successMessage };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }
}

// --- record mapping between Spaceship's per-type shape and our DnsRecord ---

// extract the primary value for a Spaceship record based on its type
function spaceshipRecordValue(r: SpaceshipRecord, type: string): string {
  switch (type) {
    case 'A':
    case 'AAAA':
      return r.address ?? '';
    case 'CNAME':
      return r.cname ?? '';
    case 'NS':
      return r.nameserver ?? '';
    case 'MX':
      return r.exchange ?? '';
    case 'SRV':
    case 'ALIAS':
      return r.target ?? '';
    default:
      return r.value ?? '';
  }
}

function toDnsRecord(r: SpaceshipRecord): DnsRecord {
  const type = (r.type ?? '').toUpperCase();
  const record: DnsRecord = { type, name: r.name ?? '', value: spaceshipRecordValue(r, type) };
  if (r.ttl != null) record.ttl = r.ttl;
  if (type === 'MX' && r.preference != null) record.priority = r.preference;
  if (type === 'SRV') {
    if (r.priority != null) record.priority = r.priority;
    if (r.weight != null) record.weight = r.weight;
    if (r.port != null) record.port = r.port;
  }
  return record;
}

function toSpaceshipRecord(r: DnsRecord): SpaceshipRecord {
  const type = r.type.toUpperCase();
  if (!WRITABLE_DNS_TYPES.has(type)) {
    throw new Error(`Spaceship: writing DNS record type '${type}' is not supported`);
  }
  const record: SpaceshipRecord = { type, name: r.name || '@' };
  if (r.ttl != null) record.ttl = r.ttl;
  switch (type) {
    case 'A':
    case 'AAAA':
      record.address = r.value;
      break;
    case 'CNAME':
      record.cname = r.value;
      break;
    case 'NS':
      record.nameserver = r.value;
      break;
    case 'MX':
      record.exchange = r.value;
      record.preference = r.priority ?? 10;
      break;
    default: // TXT
      record.value = r.value;
  }
  return record;
}

// a stable key for a (type, name) pair, for set membership
function recordKey(type: string | undefined, name: string | undefined): string {
  return `${(type ?? '').toUpperCase()}\x00${name ?? '@'}`;
}

// --- contact mapping between Spaceship's shape and the normalized Contact ---

function fromSpaceshipContact(c: SpaceshipContact): Contact {
  return {
    firstName: c.firstName ?? '',
    lastName: c.lastName ?? '',
    organization: c.organization,
    email: c.email ?? '',
    phone: c.phone ?? '',
    fax: c.fax,
    address1: c.address1 ?? '',
    address2: c.address2,
    city: c.city ?? '',
    state: c.stateProvince,
    postalCode: c.postalCode ?? '',
    country: c.country ?? '',
  };
}

function toSpaceshipContact(c: Contact): SpaceshipContact {
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    organization: c.organization,
    email: c.email,
    phone: c.phone,
    fax: c.fax,
    address1: c.address1,
    address2: c.address2,
    city: c.city,
    stateProvince: c.state,
    postalCode: c.postalCode,
    country: c.country,
  };
}

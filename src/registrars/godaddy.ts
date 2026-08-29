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
  RegistrationConsent,
  RegistrarOptions,
  RequestOptions,
  TldPricing,
  TransferDomainInput,
} from '../types';
import { createDomain, filterDomains } from '../utils';
import { DEFAULT_PAGE_SIZE } from '../constants';
import { ConsentRequiredError, NotImplementedError, toRegistrarError } from '../errors';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import { Feature, type RegistrarFeature } from '../features';
import type { RegistrarCredentials } from '../types';

// a mailing address as GoDaddy models it
interface GoDaddyAddress {
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

// a contact as GoDaddy models it (registrant / admin / tech / billing)
interface GoDaddyContact {
  nameFirst?: string;
  nameLast?: string;
  organization?: string;
  email?: string;
  phone?: string;
  fax?: string;
  addressMailing?: GoDaddyAddress;
}

interface GoDaddyDomain {
  domain: string;
  status?: string;
  createdAt?: string;
  expires?: string;
  renewDeadline?: string;
  renewAuto?: boolean;
  locked?: boolean;
  privacy?: boolean;
  nameServers?: string[];
  contactRegistrant?: GoDaddyContact;
  contactAdmin?: GoDaddyContact;
  contactTech?: GoDaddyContact;
  contactBilling?: GoDaddyContact;
}

// one entry from POST /v1/domains/available; `price` is in micro-units of `currency`
interface GoDaddyAvailability {
  domain: string;
  available?: boolean;
  price?: number;
  currency?: string;
  period?: number;
}

interface GoDaddyAvailabilityResponse {
  domains?: GoDaddyAvailability[];
}

// a DNS record as GoDaddy models it
interface GoDaddyRecord {
  type: string;
  name: string;
  data: string;
  ttl?: number;
  priority?: number;
  weight?: number;
  port?: number;
}

// a legal agreement GoDaddy requires consent to before registering a TLD
interface GoDaddyAgreement {
  agreementKey: string;
  title?: string;
  url?: string;
}

// GoDaddy reports availability prices in micro-units (1,000,000 = 1 unit of currency)
const PRICE_MICRO_UNITS = 1_000_000;

/**
 * GoDaddy Registrar
 * API docs: https://developer.godaddy.com/doc/endpoint/domains
 *
 * Credentials: create API keys under Account Settings > API Keys. Choose the
 * `production` or `ote` (test) environment to match the key you generated;
 * both the key and secret are required and sent as an `sso-key` header.
 *
 * This provider targets GoDaddy's stable v1 Domains API.
 *
 * `registerDomain` implements GoDaddy's legal-agreements + consent flow: it
 * fetches the agreement keys for the TLD, then POSTs a purchase with a `consent`
 * block whose `agreedBy` is the consenting party's IP (supplied per call via
 * `RegisterDomainInput.consent`). Callers omitting consent get a
 * `ConsentRequiredError`. It spends real money and has not been exercised
 * against a funded account, so treat it as documented-but-unverified.
 *
 * `transferIn` uses the same consent flow (agreements fetched with
 * `forTransfer=true`) plus the domain's auth code; like registration it spends
 * real money and is documented-but-unverified.
 */
export class GoDaddyRegistrar extends BaseRegistrar {
  readonly name = 'godaddy';

  static readonly displayName = 'GoDaddy';
  static readonly helpText =
    'Create API keys in your GoDaddy account under Account Settings > API Keys. ' +
    'You can create production keys or OTE (test environment) keys. Save both the ' +
    'API Key and Secret when generated. Pass { environment: "sandbox" } to target ' +
    'the OTE test environment (use OTE keys with it).';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', required: true },
  ];
  // GoDaddy's OTE ("Operational Test Environment") is its sandbox
  static readonly supportsSandbox = true;
  // Beyond core, only domain forwarding. DNSSEC has no dedicated endpoint (DS
  // records go through the generic DNS API), there's no glue-record or email
  // API, and auth-code retrieval and push webhooks aren't confirmed via API.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [Feature.SetDomainForwarding];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('GoDaddy', options?.environment, {
          production: 'https://api.godaddy.com/v1',
          sandbox: 'https://api.ote-godaddy.com/v1',
        }),
        headers: {
          'Authorization': `sso-key ${credentials.apiKey}:${credentials.apiSecret}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      },
      options
    );
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      await this.http.request<GoDaddyDomain[]>({ path: '/domains', ...opts });
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const { pageSize = DEFAULT_PAGE_SIZE, search, ...reqOpts } = opts ?? {};
    // status filters exclude expired domains: visible (active), renewable
    // (expiring soon), redemption (grace period). statusGroups repeats in the
    // query string, so it is embedded in the path directly. `includes=nameServers`
    // folds nameservers into this list call (they are otherwise omitted). GoDaddy
    // paginates via `marker` = the last domain name seen (its page-size param is
    // literally named `limit`, capped at 1000).
    const statusGroups = 'statusGroups=VISIBLE&statusGroups=RENEWABLE&statusGroups=REDEMPTION';
    const perPage = Math.min(pageSize, 1000);
    const domains: Domain[] = [];
    let marker: string | undefined;
    for (;;) {
      const markerParam = marker ? `&marker=${encodeURIComponent(marker)}` : '';
      const res = await this.http.request<GoDaddyDomain[]>({
        path: `/domains?limit=${perPage}&includes=nameServers&${statusGroups}${markerParam}`,
        ...reqOpts,
      });
      const list = res ?? [];
      for (const d of list) domains.push(this.toDomain(d));
      if (list.length < perPage) break;
      marker = list[list.length - 1]?.domain;
      if (!marker) break;
    }
    return filterDomains(domains, search);
  }

  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    const d = await this.http.request<GoDaddyDomain>({
      path: `/domains/${encodeURIComponent(domainName)}`,
      ...opts,
    });
    return this.toDomain(d);
  }

  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    const domain = await this.getDomain(domainName, opts);
    return domain.nameservers;
  }

  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    // bulk check: POST an array of domains. checkType=FULL consults the registry
    // (slower but authoritative) rather than GoDaddy's cache.
    const res = await this.http.request<GoDaddyAvailabilityResponse>({
      method: 'POST',
      path: '/domains/available?checkType=FULL',
      body: domainNames,
      ...opts,
    });
    return (res.domains ?? []).map(d => ({
      domainName: d.domain,
      available: d.available ?? false,
      price: d.price != null ? d.price / PRICE_MICRO_UNITS : undefined,
      currency: d.currency,
      period: d.period,
    }));
  }

  /**
   * GoDaddy has no standalone TLD-pricing endpoint — registration price is
   * returned inline with an availability check. So `getPricing` requires a full
   * domain (e.g. "example.com"), checks its availability, and reports the
   * registration price. A bare TLD throws, since GoDaddy can't price a TLD
   * without a specific name. Only `registration` is known here (GoDaddy's
   * availability response carries no separate renewal/transfer price).
   */
  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    if (!tldOrDomain.includes('.')) {
      throw new NotImplementedError(
        `${this.name}: getPricing needs a full domain (e.g. "example.com"); ` +
          'GoDaddy exposes pricing only per-domain via availability, not per-TLD'
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
   * Registers a domain via GoDaddy's purchase flow. Requires per-call `consent`
   * (with `agreedBy` = the consenting party's IP): this fetches the TLD's
   * agreement keys, then POSTs the purchase with a `consent` block referencing
   * them. GoDaddy requires all four contact roles, so any role the caller omits
   * falls back to the registrant.
   */
  override async registerDomain(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const registrant = input.contacts.registrant;
    if (!registrant) {
      throw new Error(`${this.name}: registration requires at least a registrant contact`);
    }
    const tld = domainName.slice(domainName.indexOf('.') + 1);
    const privacy = input.privacy ?? false;
    const consent = await this.buildConsent(input.consent, tld, privacy, false, opts);

    const body = {
      domain: domainName,
      consent,
      contactRegistrant: toGoDaddyContact(registrant),
      contactAdmin: toGoDaddyContact(input.contacts.admin ?? registrant),
      contactTech: toGoDaddyContact(input.contacts.tech ?? registrant),
      contactBilling: toGoDaddyContact(input.contacts.billing ?? registrant),
      period: input.years ?? 1,
      privacy,
      renewAuto: input.autoRenew ?? false,
      ...(input.nameservers ? { nameServers: input.nameservers } : {}),
    };
    return this.mutate(
      { method: 'POST', path: '/domains/purchase', body },
      `Domain ${domainName} registered successfully`,
      opts
    );
  }

  /**
   * Transfers a domain in with its auth code. GoDaddy's transfer body is much
   * smaller than a purchase — just the auth code + a `consent` block (fetched
   * with `forTransfer=true`, since transfer agreements can differ) + optional
   * period/renewAuto/privacy. No contacts: the existing registration's carry
   * over.
   */
  override async transferIn(
    domainName: string,
    input: TransferDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const tld = domainName.slice(domainName.indexOf('.') + 1);
    const privacy = input.privacy ?? false;
    const consent = await this.buildConsent(input.consent, tld, privacy, true, opts);

    const body: Record<string, unknown> = {
      authCode: input.authCode,
      consent,
      privacy,
      renewAuto: input.autoRenew ?? false,
    };
    if (input.years != null) body.period = input.years;
    return this.mutate(
      { method: 'POST', path: `/domains/${encodeURIComponent(domainName)}/transfer`, body },
      `Domain ${domainName} transfer requested successfully`,
      opts
    );
  }

  /**
   * Builds the GoDaddy `consent` block shared by register and transfer: validates
   * consent is present (with `agreedBy`), fetches the agreement keys for the TLD
   * (register vs. transfer agreements differ, hence `forTransfer`), and stamps
   * `agreedAt`.
   */
  private async buildConsent(
    consent: RegistrationConsent | undefined,
    tld: string,
    privacy: boolean,
    forTransfer: boolean,
    opts?: RequestOptions
  ): Promise<{ agreementKeys: string[]; agreedAt: string; agreedBy: string }> {
    if (!consent) {
      throw new ConsentRequiredError(
        `${this.name}: this operation requires consent — supply \`consent\` ` +
          '(accepting the registration agreements)'
      );
    }
    if (!consent.agreedBy) {
      throw new ConsentRequiredError(
        `${this.name}: consent.agreedBy is required and must be the consenting party's IP address`
      );
    }
    const query: Record<string, string | number | boolean> = { tlds: tld, privacy };
    if (forTransfer) query.forTransfer = true;
    const agreements = await this.http.request<GoDaddyAgreement[]>({
      path: '/domains/agreements',
      query,
      ...opts,
    });
    const agreementKeys = (agreements ?? []).map(a => a.agreementKey);
    if (agreementKeys.length === 0) {
      throw new ConsentRequiredError(`${this.name}: no agreements were returned for .${tld}`);
    }
    return {
      agreementKeys,
      agreedAt: consent.agreedAt ?? new Date().toISOString(),
      agreedBy: consent.agreedBy,
    };
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'POST',
        path: `/domains/${encodeURIComponent(domainName)}/renew`,
        body: { period: years },
      },
      'Domain renewed successfully',
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
        method: 'PATCH',
        path: `/domains/${encodeURIComponent(domainName)}`,
        body: { renewAuto: enabled },
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
    if (nameservers.length < 1 || nameservers.length > 13) {
      throw new Error('GoDaddy requires 1-13 nameservers');
    }
    return this.mutate(
      {
        method: 'PATCH',
        path: `/domains/${encodeURIComponent(domainName)}`,
        body: { nameServers: nameservers },
      },
      'Nameservers updated successfully',
      opts
    );
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PATCH',
        path: `/domains/${encodeURIComponent(domainName)}`,
        body: { locked: true },
      },
      'Domain locked successfully',
      opts
    );
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PATCH',
        path: `/domains/${encodeURIComponent(domainName)}`,
        body: { locked: false },
      },
      'Domain unlocked successfully',
      opts
    );
  }

  /**
   * Disabling privacy is a simple DELETE. Enabling it is a paid purchase
   * (`POST /v1/domains/{domain}/privacy/purchase`) requiring a consent block and
   * payment, so it's left unimplemented rather than silently spending money.
   */
  override async setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (enabled) {
      throw new NotImplementedError(
        `${this.name}: enabling privacy is a paid purchase and is not implemented; ` +
          'only disabling privacy is supported via the API'
      );
    }
    return this.mutate(
      { method: 'DELETE', path: `/domains/${encodeURIComponent(domainName)}/privacy` },
      'Privacy disabled successfully',
      opts
    );
  }

  override async getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    const d = await this.http.request<GoDaddyDomain>({
      path: `/domains/${encodeURIComponent(domainName)}`,
      ...opts,
    });
    return {
      registrant: fromGoDaddyContact(d.contactRegistrant),
      admin: fromGoDaddyContact(d.contactAdmin),
      tech: fromGoDaddyContact(d.contactTech),
      billing: fromGoDaddyContact(d.contactBilling),
    };
  }

  override async updateContacts(
    domainName: string,
    contacts: ContactSet,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    // include only the roles the caller supplied
    const body: Record<string, GoDaddyContact> = {};
    if (contacts.registrant) body.contactRegistrant = toGoDaddyContact(contacts.registrant);
    if (contacts.admin) body.contactAdmin = toGoDaddyContact(contacts.admin);
    if (contacts.tech) body.contactTech = toGoDaddyContact(contacts.tech);
    if (contacts.billing) body.contactBilling = toGoDaddyContact(contacts.billing);
    if (Object.keys(body).length === 0) {
      throw new Error('GoDaddy updateContacts requires at least one contact');
    }
    return this.mutate(
      { method: 'PATCH', path: `/domains/${encodeURIComponent(domainName)}/contacts`, body },
      'Contacts updated successfully',
      opts
    );
  }

  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const records = await this.http.request<GoDaddyRecord[]>({
      path: `/domains/${encodeURIComponent(domainName)}/records`,
      ...opts,
    });
    return (records ?? []).map(r => ({
      type: r.type,
      name: r.name,
      value: r.data,
      ttl: r.ttl,
      priority: r.priority,
      weight: r.weight,
      port: r.port,
    }));
  }

  /**
   * Replaces the entire record set (PUT semantics): any record not present in
   * `records` is removed. GoDaddy requires a minimum TTL of 600 seconds, so
   * records without an explicit TTL default to 3600.
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const body: GoDaddyRecord[] = records.map(r => {
      const record: GoDaddyRecord = {
        type: r.type.toUpperCase(),
        name: r.name,
        data: r.value,
        ttl: r.ttl ?? 3600,
      };
      if (r.priority != null) record.priority = r.priority;
      if (r.weight != null) record.weight = r.weight;
      if (r.port != null) record.port = r.port;
      return record;
    });
    return this.mutate(
      { method: 'PUT', path: `/domains/${encodeURIComponent(domainName)}/records`, body },
      'DNS records updated successfully',
      opts
    );
  }

  // map a GoDaddy domain payload to the normalized Domain shape
  private toDomain(d: GoDaddyDomain): Domain {
    return createDomain({
      domainName: d.domain,
      registrar: this.name,
      status: d.status,
      createdDate: d.createdAt,
      expirationDate: d.expires,
      renewalDate: d.renewDeadline,
      autoRenew: d.renewAuto ?? false,
      locked: d.locked ?? false,
      privacy: d.privacy ?? false,
      nameservers: d.nameServers ?? [],
    });
  }

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

// --- contact mapping between GoDaddy's shape and the normalized Contact ---

function fromGoDaddyContact(c: GoDaddyContact | undefined): Contact | undefined {
  if (!c) return undefined;
  const a = c.addressMailing ?? {};
  return {
    firstName: c.nameFirst ?? '',
    lastName: c.nameLast ?? '',
    organization: c.organization,
    email: c.email ?? '',
    phone: c.phone ?? '',
    fax: c.fax,
    address1: a.address1 ?? '',
    address2: a.address2,
    city: a.city ?? '',
    state: a.state,
    postalCode: a.postalCode ?? '',
    country: a.country ?? '',
  };
}

function toGoDaddyContact(c: Contact): GoDaddyContact {
  return {
    nameFirst: c.firstName,
    nameLast: c.lastName,
    organization: c.organization,
    email: c.email,
    phone: c.phone,
    fax: c.fax,
    addressMailing: {
      address1: c.address1,
      address2: c.address2,
      city: c.city,
      state: c.state ?? '',
      postalCode: c.postalCode,
      country: c.country,
    },
  };
}

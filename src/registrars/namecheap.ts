import type {
  ConfigField,
  ConnectionResult,
  Contact,
  ContactSet,
  DnsRecord,
  Domain,
  DomainAvailability,
  DomainForward,
  DomainForwardType,
  EmailForward,
  ListDomainsOptions,
  OperationResult,
  RegisterDomainInput,
  RegistrarOptions,
  RequestOptions,
  TldPricing,
  TransferDomainInput,
} from '../types';
import { createDomain, filterDomains, normalizeDomain, requireConsent } from '../utils';
import { toRegistrarError } from '../errors';
import { ensureArray, parseXml } from '../xml';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import { Feature, type RegistrarFeature } from '../features';
import type { RegistrarCredentials } from '../types';

// shape of a Namecheap XML response (attributes prefixed with `@_`, text `#text`)
interface NcError {
  '#text'?: string;
  '@_Number'?: string;
}

interface NcDomainEl {
  '@_Name'?: string;
  '@_Created'?: string;
  '@_Expires'?: string;
  '@_AutoRenew'?: string;
  '@_IsLocked'?: string;
  '@_WhoisGuard'?: string;
}

// namecheap.domains.getInfo result
interface NcGetInfoResult {
  '@_Status'?: string;
  '@_DomainName'?: string;
  'DomainDetails'?: { CreatedDate?: string; ExpiredDate?: string };
  'Whoisguard'?: { '@_Enabled'?: string; 'ID'?: string | number };
}

// namecheap.domains.check result element (attributes only)
interface NcCheckEl {
  '@_Domain'?: string;
  '@_Available'?: string;
  '@_IsPremiumName'?: string;
  '@_PremiumRegistrationPrice'?: string;
}

// a contact group in namecheap.domains.getContacts (children are text elements)
interface NcContactEl {
  OrganizationName?: string;
  FirstName?: string;
  LastName?: string;
  Address1?: string;
  Address2?: string;
  City?: string;
  StateProvince?: string;
  PostalCode?: string;
  Country?: string;
  Phone?: string;
  Fax?: string;
  EmailAddress?: string;
}

// a <Forward mailbox="alias">destination</Forward> in
// namecheap.domains.dns.getEmailForwarding
interface NcForwardEl {
  '@_mailbox'?: string;
  '#text'?: string;
}

// a host record in namecheap.domains.dns.getHosts (attributes only)
interface NcHostEl {
  '@_Name'?: string;
  '@_Type'?: string;
  '@_Address'?: string;
  '@_MXPref'?: string;
  '@_TTL'?: string;
}

// namecheap.users.getPricing is ProductType > ProductCategory > Product > Price
interface NcPriceEl {
  '@_Duration'?: string;
  '@_DurationType'?: string;
  '@_Price'?: string;
  '@_Currency'?: string;
}
interface NcProductEl {
  '@_Name'?: string;
  'Price'?: NcPriceEl | NcPriceEl[];
}
interface NcProductCategoryEl {
  '@_Name'?: string;
  'Product'?: NcProductEl | NcProductEl[];
}
interface NcProductTypeEl {
  '@_Name'?: string;
  'ProductCategory'?: NcProductCategoryEl | NcProductCategoryEl[];
}

interface NcCommandResponse {
  DomainGetListResult?: { Domain?: NcDomainEl | NcDomainEl[] };
  DomainCheckResult?: NcCheckEl | NcCheckEl[];
  DomainGetInfoResult?: NcGetInfoResult;
  DomainDNSGetListResult?: {
    '@_Domain'?: string;
    '@_IsUsingOurDNS'?: string;
    'Nameserver'?: string | string[];
  };
  // the docs show <Host>, but the live API has historically returned <host>
  DomainDNSGetHostsResult?: { Host?: NcHostEl | NcHostEl[]; host?: NcHostEl | NcHostEl[] };
  DomainDNSGetEmailForwardingResult?: {
    '@_Domain'?: string;
    'Forward'?: NcForwardEl | NcForwardEl[];
  };
  DomainContactsResult?: {
    Registrant?: NcContactEl;
    Admin?: NcContactEl;
    Tech?: NcContactEl;
    AuxBilling?: NcContactEl;
  };
  UserGetPricingResult?: { ProductType?: NcProductTypeEl | NcProductTypeEl[] };
  // namecheap.domains.getRegistrarLock — the authoritative per-domain lock state
  DomainGetRegistrarLockResult?: { '@_RegistrarLockStatus'?: string };
  // namecheap.domains.setAutoRenew result (carries its own IsSuccess flag)
  SetAutoRenewResult?: { '@_IsSuccess'?: string };
}

interface NcResponse {
  ApiResponse?: {
    '@_Status'?: string;
    'Errors'?: { Error?: NcError | NcError[] | string };
    'CommandResponse'?: NcCommandResponse;
  };
}

// Namecheap caps domains.check at 50 domains per request
const CHECK_BATCH_SIZE = 50;
// the four contact roles Namecheap requires on every setContacts call, mapped
// to our ContactSet keys (Namecheap calls the billing role "AuxBilling")
const NC_CONTACT_ROLES = [
  { prefix: 'Registrant', key: 'registrant' },
  { prefix: 'Admin', key: 'admin' },
  { prefix: 'Tech', key: 'tech' },
  { prefix: 'AuxBilling', key: 'billing' },
] as const;

/**
 * Namecheap Registrar
 * API docs: https://www.namecheap.com/support/api/intro/
 *
 * Credentials: enable API access under Profile > Tools > API Access, generate
 * an API key, and whitelist the IP(s) requests will originate from (Namecheap
 * enforces IP whitelisting). Supply that whitelisted IP as `clientIp`.
 *
 * Namecheap authenticates via query-string parameters (ApiUser, ApiKey,
 * UserName, ClientIp) and responds with XML — including for errors, which come
 * back as `<Errors>` nodes inside a 200 OK envelope, so success is read from the
 * root `Status="OK"` attribute (`isOk`), not the HTTP status. XML is parsed via
 * the shared `parseXml` helper (fast-xml-parser).
 *
 * `setAutoRenew` uses `namecheap.domains.setAutoRenew` (DomainName + IsAutoRenew).
 * The command isn't in Namecheap's published method index but is live and keys on
 * DomainName (an SLD/TLD form is rejected); it returns its own `IsSuccess` flag,
 * which this reads rather than the envelope status.
 *
 * `registerDomain`/`transferIn` are implemented and require per-call `consent`;
 * they spend real money and are documented-but-unverified. Registration sends the
 * full four-role contact set but not yet per-TLD extended attributes (.us, .eu,
 * …), so those TLDs aren't supported for registration.
 */
export class NamecheapRegistrar extends BaseRegistrar {
  readonly name = 'namecheap';

  static readonly displayName = 'Namecheap';
  static readonly helpText =
    'Enable API access in your Namecheap account under Profile > Tools > API Access, ' +
    'generate an API key, and whitelist your request IP(s) in the API settings. ' +
    'Provide the whitelisted IP as the Client IP field.';
  static readonly configFields: ConfigField[] = [
    { name: 'username', label: 'Username', type: 'text', required: true },
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'clientIp', label: 'Client IP', type: 'text', required: false, default: '0.0.0.0' },
  ];
  // Namecheap runs a sandbox at api.sandbox.namecheap.com (separate account at
  // sandbox.namecheap.com with its own API key)
  static readonly supportsSandbox = true;
  // XML API. Beyond core, read+write alias-style email forwarding (via the
  // dedicated dns.getEmailForwarding/setEmailForwarding commands) and URL/domain
  // forwarding (URL/URL301/FRAME host records, read+written through the host set).
  // No DNSSEC or webhooks; auth-code retrieval and glue records are dashboard-
  // gated / unconfirmed, so they're left undeclared until verified live.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.GetEmailForwarding,
    Feature.SetEmailForwarding,
    Feature.GetDomainForwarding,
    Feature.SetDomainForwarding,
  ];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('Namecheap', options?.environment, {
          production: 'https://api.namecheap.com/xml.response',
          sandbox: 'https://api.sandbox.namecheap.com/xml.response',
        }),
      },
      options
    );
  }

  // common query parameters (credentials + command) for every Namecheap call
  private baseQuery(command: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      ApiUser: this.credentials.username,
      ApiKey: this.credentials.apiKey,
      UserName: this.credentials.username,
      // Namecheap validates against whitelisted IPs configured in the account
      ClientIp: this.credentials.clientIp || '0.0.0.0',
      Command: command,
      ...extra,
    };
  }

  // issue a command and parse the XML response
  private async call(
    command: string,
    extra: Record<string, string>,
    opts?: RequestOptions
  ): Promise<NcResponse> {
    const xml = await this.http.requestText({
      path: '',
      query: this.baseQuery(command, extra),
      ...opts,
    });
    return parseXml<NcResponse>(xml);
  }

  // issue a command and return its CommandResponse, throwing on an error status
  private async command(
    command: string,
    extra: Record<string, string>,
    opts?: RequestOptions
  ): Promise<NcCommandResponse> {
    const res = await this.call(command, extra, opts);
    if (!isOk(res)) throw new Error(errorText(res) ?? 'Namecheap API request failed');
    return res.ApiResponse?.CommandResponse ?? {};
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      const res = await this.call('namecheap.domains.getList', {}, opts);
      return isOk(res)
        ? { success: true, message: 'Connection successful' }
        : { success: false, message: errorText(res) ?? 'Unknown error' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const { search, ...reqOpts } = opts ?? {};
    const domains: Domain[] = [];
    const perPage = 100; // Namecheap PageSize maximum (10..100)
    // `SearchTerm` filters by name substring server-side.
    const searchTerm = search?.trim();
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const cr = await this.command(
        'namecheap.domains.getList',
        {
          PageSize: String(perPage),
          Page: String(page),
          ...(searchTerm ? { SearchTerm: searchTerm } : {}),
        },
        reqOpts
      );

      const elements = ensureArray(cr.DomainGetListResult?.Domain);
      for (const d of elements) {
        domains.push(
          createDomain({
            domainName: d['@_Name'],
            registrar: this.name,
            status: 'ok', // the list endpoint does not return a per-domain status
            createdDate: d['@_Created'],
            expirationDate: d['@_Expires'],
            renewalDate: d['@_Expires'],
            autoRenew: d['@_AutoRenew'] === 'true',
            locked: d['@_IsLocked'] === 'true',
            privacy: d['@_WhoisGuard'] === 'ENABLED',
            nameservers: [], // the list endpoint does not return nameservers
          })
        );
      }

      hasMore = elements.length === perPage;
      page++;
    }
    return filterDomains(domains, search);
  }

  /**
   * getInfo carries status, dates, and WhoisGuard state but not nameservers, so
   * `nameservers` comes back empty here — use `getNameservers` (dns.getList) for
   * those. The registrar transfer-lock flag isn't in getInfo either (its `Status`
   * reflects the domain lifecycle, e.g. "Ok"/"Expired", not the transfer lock),
   * so `locked` is read from the dedicated `getRegistrarLock` command, which is
   * the authoritative real-time source (getList's per-row `IsLocked` can lag —
   * confirmed stale in the sandbox after a lock the API had already applied).
   */
  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    const cr = await this.command('namecheap.domains.getInfo', { DomainName: domainName }, opts);
    const info = cr.DomainGetInfoResult ?? {};
    const status = info['@_Status'] ?? '';
    return createDomain({
      domainName: info['@_DomainName'] ?? domainName,
      registrar: this.name,
      status,
      createdDate: info.DomainDetails?.CreatedDate,
      expirationDate: info.DomainDetails?.ExpiredDate,
      renewalDate: info.DomainDetails?.ExpiredDate,
      locked: await this.getRegistrarLock(domainName, opts),
      privacy: (info.Whoisguard?.['@_Enabled'] ?? '').toLowerCase() === 'true',
      nameservers: [],
    });
  }

  /**
   * Reads the registrar transfer-lock flag for a single domain via the dedicated
   * `getRegistrarLock` command (`RegistrarLockStatus`). getInfo doesn't expose the
   * lock, and getList's per-row `IsLocked` can lag the real state — verified live:
   * after a lock the API reported as applied, getList still showed `IsLocked=false`
   * while getRegistrarLock correctly returned `RegistrarLockStatus=true`.
   */
  private async getRegistrarLock(domainName: string, opts?: RequestOptions): Promise<boolean> {
    const cr = await this.command(
      'namecheap.domains.getRegistrarLock',
      { DomainName: normalizeDomain(domainName) },
      opts
    );
    return cr.DomainGetRegistrarLockResult?.['@_RegistrarLockStatus'] === 'true';
  }

  /**
   * Availability via domains.check (batched at 50 per request, Namecheap's cap).
   * The check response only carries a price for *premium* names
   * (`PremiumRegistrationPrice`); regular registration pricing comes from
   * `getPricing`, so `price` is set only for premium results.
   */
  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const results: DomainAvailability[] = [];
    for (let i = 0; i < domainNames.length; i += CHECK_BATCH_SIZE) {
      const batch = domainNames.slice(i, i + CHECK_BATCH_SIZE);
      const cr = await this.command(
        'namecheap.domains.check',
        { DomainList: batch.join(',') },
        opts
      );
      for (const el of ensureArray(cr.DomainCheckResult)) {
        const premium = el['@_IsPremiumName'] === 'true';
        const premiumPrice = premium ? Number(el['@_PremiumRegistrationPrice']) : NaN;
        results.push({
          domainName: el['@_Domain'] ?? '',
          available: el['@_Available'] === 'true',
          premium,
          price: Number.isFinite(premiumPrice) && premiumPrice > 0 ? premiumPrice : undefined,
        });
      }
    }
    return results;
  }

  /**
   * Per-TLD pricing via users.getPricing — unlike GoDaddy/Dynadot, Namecheap has
   * a real price table, so a bare TLD works (a full domain is reduced to its
   * TLD). Reads the 1-year register/renew/transfer prices.
   */
  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    const tld = (
      tldOrDomain.includes('.') ? tldOrDomain.slice(tldOrDomain.indexOf('.') + 1) : tldOrDomain
    ).toLowerCase();

    const cr = await this.command(
      'namecheap.users.getPricing',
      { ProductType: 'DOMAIN', ProductName: tld },
      opts
    );
    const categories = ensureArray(
      ensureArray(cr.UserGetPricingResult?.ProductType)[0]?.ProductCategory
    );

    // find the 1-year Price for a given action category (REGISTER/RENEW/TRANSFER)
    const findPrice = (action: string): NcPriceEl | undefined => {
      const category = categories.find(c => c['@_Name']?.toUpperCase() === action);
      const product = ensureArray(category?.Product).find(p => p['@_Name']?.toLowerCase() === tld);
      const prices = ensureArray(product?.Price);
      return prices.find(p => p['@_Duration'] === '1') ?? prices[0];
    };

    const register = findPrice('REGISTER');
    const renew = findPrice('RENEW');
    const transfer = findPrice('TRANSFER');
    return {
      tld,
      currency: register?.['@_Currency'] ?? renew?.['@_Currency'] ?? 'USD',
      registration: toPrice(register),
      renewal: toPrice(renew),
      transfer: toPrice(transfer),
    };
  }

  /**
   * Registers a domain via domains.create, which requires all four contact roles
   * (omitted roles fall back to the registrant) and toggles free WhoisGuard when
   * privacy is requested. Note: TLDs that need per-TLD extended attributes (.us,
   * .eu, .ca, …) are not yet supported — those params aren't sent.
   */
  override async registerDomain(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    requireConsent(this.name, input.consent);
    const registrant = input.contacts.registrant;
    if (!registrant) {
      throw new Error(`${this.name}: registration requires at least a registrant contact`);
    }
    const params: Record<string, string> = {
      DomainName: domainName,
      Years: String(input.years ?? 1),
    };
    for (const { prefix, key } of NC_CONTACT_ROLES) {
      Object.assign(params, toNcContactParams(prefix, input.contacts[key] ?? registrant));
    }
    if (input.nameservers?.length) params.Nameservers = input.nameservers.join(',');
    if (input.privacy) {
      params.AddFreeWhoisguard = 'yes';
      params.WGEnabled = 'yes';
    }
    const res = await this.call('namecheap.domains.create', params, opts);
    return statusResult(res);
  }

  /**
   * Transfers a domain in via domains.transfer.create. Namecheap takes no
   * contacts on transfer (the existing registrant's carry over); it needs the
   * auth code as `EPPCode` and a `Years` of 1. Note: the privacy-enable param is
   * `WGenable` here (lowercase), unlike `WGEnabled` on create.
   */
  override async transferIn(
    domainName: string,
    input: TransferDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    requireConsent(this.name, input.consent);
    const params: Record<string, string> = {
      DomainName: domainName,
      Years: String(input.years ?? 1),
      EPPCode: input.authCode,
    };
    if (input.privacy != null) {
      params.AddFreeWhoisguard = input.privacy ? 'yes' : 'no';
      params.WGenable = input.privacy ? 'yes' : 'no';
    }
    const res = await this.call('namecheap.domains.transfer.create', params, opts);
    return statusResult(res);
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const res = await this.call(
      'namecheap.domains.renew',
      { DomainName: domainName, Years: String(years) },
      opts
    );
    return statusResult(res);
  }

  /**
   * Toggles auto-renew via `namecheap.domains.setAutoRenew`. The command carries
   * its own `IsSuccess` flag inside an otherwise-OK envelope (a malformed request
   * comes back `Status="OK"` with `IsSuccess="false"`), so success is read from
   * that flag, not the envelope status.
   */
  override async setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const cr = await this.command(
      'namecheap.domains.setAutoRenew',
      { DomainName: domainName, IsAutoRenew: enabled ? 'true' : 'false' },
      opts
    );
    if (cr.SetAutoRenewResult?.['@_IsSuccess'] === 'true') {
      return { success: true, message: 'OK' };
    }
    return { success: false, message: `Failed to ${enabled ? 'enable' : 'disable'} auto-renew` };
  }

  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    const { sld, tld } = splitDomain(domainName);
    const cr = await this.command('namecheap.domains.dns.getList', { SLD: sld, TLD: tld }, opts);
    return ensureArray(cr.DomainDNSGetListResult?.Nameserver).map(String);
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 2 || nameservers.length > 12) {
      throw new Error('Namecheap requires 2-12 nameservers');
    }
    const { sld, tld } = splitDomain(domainName);
    const res = await this.call(
      'namecheap.domains.dns.setCustom',
      { SLD: sld, TLD: tld, Nameservers: nameservers.join(',') },
      opts
    );
    return statusResult(res);
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    const res = await this.call(
      'namecheap.domains.setRegistrarLock',
      { DomainName: domainName, LockAction: 'LOCK' },
      opts
    );
    return statusResult(res);
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    const res = await this.call(
      'namecheap.domains.setRegistrarLock',
      { DomainName: domainName, LockAction: 'UNLOCK' },
      opts
    );
    return statusResult(res);
  }

  /**
   * Toggles WhoisGuard (Namecheap's domain privacy), which is a separate entity
   * keyed by a numeric `WhoisguardID` (read from getInfo). Enabling additionally
   * needs a `ForwardedToEmail` — the address WhoisGuard-masked mail is relayed to
   * — which is taken from the domain's registrant contact. Throws if the domain
   * has no WhoisGuard allotted (e.g. TLDs that don't offer it).
   */
  override async setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const cr = await this.command('namecheap.domains.getInfo', { DomainName: domainName }, opts);
    const id = cr.DomainGetInfoResult?.Whoisguard?.ID;
    if (id == null || String(id) === '0') {
      throw new Error(`${this.name}: ${domainName} has no WhoisGuard subscription to toggle`);
    }
    if (!enabled) {
      const res = await this.call(
        'namecheap.whoisguard.disable',
        { WhoisguardID: String(id) },
        opts
      );
      return statusResult(res);
    }
    // enabling requires a forwarding address — use the registrant's email
    const contacts = await this.getContacts(domainName, opts);
    const email = contacts.registrant?.email || contacts.admin?.email;
    if (!email) {
      throw new Error(
        `${this.name}: cannot enable WhoisGuard without a registrant email to forward to`
      );
    }
    const res = await this.call(
      'namecheap.whoisguard.enable',
      { WhoisguardID: String(id), ForwardedToEmail: email },
      opts
    );
    return statusResult(res);
  }

  override async getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    const cr = await this.command(
      'namecheap.domains.getContacts',
      { DomainName: domainName },
      opts
    );
    const result = cr.DomainContactsResult ?? {};
    return {
      registrant: fromNcContact(result.Registrant),
      admin: fromNcContact(result.Admin),
      tech: fromNcContact(result.Tech),
      billing: fromNcContact(result.AuxBilling),
    };
  }

  /**
   * Namecheap's setContacts requires all four roles (Registrant/Admin/Tech/
   * AuxBilling) on every call, so any role the caller omits falls back to the
   * registrant. A registrant is therefore mandatory.
   */
  override async updateContacts(
    domainName: string,
    contacts: ContactSet,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const registrant = contacts.registrant;
    if (!registrant) {
      throw new Error('Namecheap updateContacts requires at least a registrant contact');
    }
    const params: Record<string, string> = { DomainName: domainName };
    for (const { prefix, key } of NC_CONTACT_ROLES) {
      Object.assign(params, toNcContactParams(prefix, contacts[key] ?? registrant));
    }
    const res = await this.call('namecheap.domains.setContacts', params, opts);
    return statusResult(res);
  }

  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const { sld, tld } = splitDomain(domainName);
    const cr = await this.command('namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld }, opts);
    const result = cr.DomainDNSGetHostsResult ?? {};
    // the docs show <Host> but the live API has historically returned <host>
    const hosts = ensureArray(result.Host ?? result.host);
    return hosts.map(h => {
      const type = (h['@_Type'] ?? '').toUpperCase();
      const record: DnsRecord = {
        type,
        name: h['@_Name'] ?? '',
        value: h['@_Address'] ?? '',
      };
      if (h['@_TTL'] != null) record.ttl = Number(h['@_TTL']);
      if (type === 'MX' && h['@_MXPref'] != null) record.priority = Number(h['@_MXPref']);
      return record;
    });
  }

  /**
   * Replaces the entire record set via dns.setHosts (full-replace: any record
   * not sent is removed). Host params are 1-indexed. `EmailType` is set to `MX`
   * when MX records are present so mail routing follows the records; otherwise
   * it's omitted to leave Namecheap's default.
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const { sld, tld } = splitDomain(domainName);
    const params: Record<string, string> = { SLD: sld, TLD: tld };
    let hasMx = false;

    records.forEach((r, idx) => {
      const n = idx + 1; // Namecheap host params are 1-based
      const type = r.type.toUpperCase();
      params[`HostName${n}`] = r.name || '@';
      params[`RecordType${n}`] = type;
      params[`Address${n}`] = r.value;
      if (type === 'MX') {
        hasMx = true;
        params[`MXPref${n}`] = String(r.priority ?? 10);
      }
      if (r.ttl != null) params[`TTL${n}`] = String(r.ttl);
    });
    if (hasMx) params.EmailType = 'MX';

    const res = await this.call('namecheap.domains.dns.setHosts', params, opts);
    return statusResult(res);
  }

  // --- extended: email forwarding ---

  override async getEmailForwarding(
    domainName: string,
    opts?: RequestOptions
  ): Promise<EmailForward[]> {
    const cr = await this.command(
      'namecheap.domains.dns.getEmailForwarding',
      { DomainName: domainName },
      opts
    );
    return ensureArray(cr.DomainDNSGetEmailForwardingResult?.Forward)
      .map(f => ({
        alias: (f['@_mailbox'] ?? '').toString(),
        forwardTo: (f['#text'] ?? '').toString().trim(),
      }))
      .filter(f => f.alias && f.forwardTo);
  }

  /**
   * Full-replace via dns.setEmailForwarding: mailbox/forward params are 1-indexed
   * and any alias not sent is removed, so an empty `forwards` clears all
   * forwarding. Requires the domain to use Namecheap's DNS.
   */
  override async setEmailForwarding(
    domainName: string,
    forwards: EmailForward[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const params: Record<string, string> = { DomainName: domainName };
    forwards.forEach((f, idx) => {
      const n = idx + 1; // Namecheap forwarding params are 1-based
      params[`MailBox${n}`] = f.alias;
      params[`ForwardTo${n}`] = f.forwardTo;
    });
    const res = await this.call('namecheap.domains.dns.setEmailForwarding', params, opts);
    return statusResult(res);
  }

  // --- extended: domain (URL) forwarding ---

  /**
   * Namecheap has no dedicated domain-forwarding endpoint; URL forwarding lives in
   * the host-record set as URL/URL301/FRAME records, so this reads the hosts and
   * returns just the forwarding ones.
   */
  override async getDomainForwarding(
    domainName: string,
    opts?: RequestOptions
  ): Promise<DomainForward[]> {
    const records = await this.getDnsRecords(domainName, opts);
    return records
      .filter(r => isUrlRecordType(r.type))
      .map(r => ({
        host: r.name || '@',
        url: r.value,
        type: NC_URL_TYPE_TO_FORWARD[r.type.toUpperCase()],
      }));
  }

  /**
   * Because URL forwarding is stored in the host set and dns.setHosts is a full
   * replace, this preserves every non-forwarding record and swaps in the new
   * URL-family records — so an empty `forwards` clears URL forwarding while
   * leaving the rest of the zone intact.
   */
  override async setDomainForwarding(
    domainName: string,
    forwards: DomainForward[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const existing = await this.getDnsRecords(domainName, opts);
    const kept = existing.filter(r => !isUrlRecordType(r.type));
    const urlRecords: DnsRecord[] = forwards.map(f => ({
      type: NC_FORWARD_TO_URL_TYPE[f.type] ?? 'URL',
      name: f.host || '@',
      value: f.url,
    }));
    return this.setDnsRecords(domainName, [...kept, ...urlRecords], opts);
  }
}

// Namecheap URL host-record types <-> the normalized DomainForward.type
const NC_URL_TYPE_TO_FORWARD: Record<string, DomainForwardType> = {
  URL: 'redirect',
  URL301: 'permanent',
  FRAME: 'redirect', // masked/framed forwarding is unsupported; read back as a redirect
};
const NC_FORWARD_TO_URL_TYPE: Record<DomainForwardType, string> = {
  redirect: 'URL',
  permanent: 'URL301',
};

// whether a host-record type is one of Namecheap's URL-forwarding pseudo-records
function isUrlRecordType(type: string): boolean {
  return type.toUpperCase() in NC_URL_TYPE_TO_FORWARD;
}

// whether the response's root Status attribute is "OK"
function isOk(res: NcResponse): boolean {
  return res.ApiResponse?.['@_Status'] === 'OK';
}

// extract the first error message from an error response, if present
function errorText(res: NcResponse): string | null {
  const error = res.ApiResponse?.Errors?.Error;
  if (!error) return null;
  const first = ensureArray(error)[0];
  if (typeof first === 'string') return first.trim() || null;
  return first?.['#text']?.trim() ?? null;
}

// map a Namecheap response's root Status to an OperationResult
function statusResult(res: NcResponse): OperationResult {
  if (isOk(res)) return { success: true, message: 'OK' };
  return { success: false, message: errorText(res) ?? 'Unknown response' };
}

// split a domain into second-level label + TLD (the TLD may contain a dot, e.g.
// "co.uk"). Namecheap's DNS/nameserver commands take SLD and TLD separately.
function splitDomain(domain: string): { sld: string; tld: string } {
  const dot = domain.indexOf('.');
  return dot === -1
    ? { sld: domain, tld: '' }
    : { sld: domain.slice(0, dot), tld: domain.slice(dot + 1) };
}

// parse a Namecheap price element's Price attribute into a number, or undefined
function toPrice(price: NcPriceEl | undefined): number | undefined {
  if (!price?.['@_Price']) return undefined;
  const n = Number(price['@_Price']);
  return Number.isFinite(n) ? n : undefined;
}

// --- contact mapping between Namecheap's shape and the normalized Contact ---

function fromNcContact(c: NcContactEl | undefined): Contact | undefined {
  if (!c) return undefined;
  const text = (v: string | undefined): string => (v ?? '').toString();
  return {
    firstName: text(c.FirstName),
    lastName: text(c.LastName),
    organization: c.OrganizationName ? String(c.OrganizationName) : undefined,
    email: text(c.EmailAddress),
    phone: text(c.Phone),
    fax: c.Fax ? String(c.Fax) : undefined,
    address1: text(c.Address1),
    address2: c.Address2 ? String(c.Address2) : undefined,
    city: text(c.City),
    state: text(c.StateProvince),
    postalCode: text(c.PostalCode),
    country: text(c.Country),
  };
}

// build the prefixed request params (e.g. RegistrantFirstName) for one role
function toNcContactParams(prefix: string, c: Contact): Record<string, string> {
  const params: Record<string, string> = {
    [`${prefix}FirstName`]: c.firstName,
    [`${prefix}LastName`]: c.lastName,
    [`${prefix}Address1`]: c.address1,
    [`${prefix}City`]: c.city,
    [`${prefix}StateProvince`]: c.state ?? '',
    [`${prefix}PostalCode`]: c.postalCode,
    [`${prefix}Country`]: c.country,
    [`${prefix}Phone`]: c.phone,
    [`${prefix}EmailAddress`]: c.email,
  };
  if (c.organization) params[`${prefix}OrganizationName`] = c.organization;
  if (c.address2) params[`${prefix}Address2`] = c.address2;
  if (c.fax) params[`${prefix}Fax`] = c.fax;
  return params;
}

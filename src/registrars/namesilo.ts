import type {
  ConfigField,
  ConnectionResult,
  Contact,
  ContactSet,
  DnsRecord,
  DnssecStatus,
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
import { createDomain, filterDomains, settableForwards } from '../utils';
import { NotFoundError, toRegistrarError } from '../errors';
import { ensureArray } from '../xml';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import { Feature, type RegistrarFeature } from '../features';
import type { RegistrarCredentials } from '../types';

// NameSilo returns a `{ request, reply }` envelope for every operation. All
// calls return HTTP 200; success/failure is signalled by `reply.code` (300 = ok).
interface NsReply {
  code?: number | string;
  detail?: string;
  domains?: unknown;
  pager?: { page?: number; page_size?: number; total_count?: number };
  // getDomainInfo fields (present only on that call's reply)
  created?: string;
  expires?: string;
  status?: string;
  locked?: string;
  private?: string;
  auto_renew?: string;
  nameservers?: unknown;
  // getDomainInfo also returns the per-role internal contact IDs
  contact_ids?: NsContactIds;
  // contactList returns full contact records (single object or array)
  contact?: NsContact | NsContact[];
  // contactAdd returns the new contact's id
  contact_id?: string | number;
  // dnsListRecords returns resource_record entries (single object or array)
  resource_record?: NsResourceRecord | NsResourceRecord[];
  // dnsSecListRecords returns ds_record entries (single object or array)
  ds_record?: NsDsRecord | NsDsRecord[];
  // listEmailForwards returns addresses entries (single object or array)
  addresses?: NsEmailAddresses | NsEmailAddresses[];
  // getDomainInfo also carries the apex URL-forwarding config
  forward_url?: string;
  forward_type?: string;
  traffic_type?: string;
  // checkRegisterAvailability groups results; each group wraps `domain` entries
  available?: unknown;
  unavailable?: unknown;
  invalid?: unknown;
  // getPrices returns one node per TLD keyed directly on the reply (e.g.
  // reply.com = { registration, renew, transfer }); read via a Record cast
}

// one DS record from dnsSecListRecords (read fields are snake_case)
interface NsDsRecord {
  digest?: string;
  digest_type?: string | number;
  algorithm?: string | number;
  key_tag?: string | number;
}

// one mailbox from listEmailForwards: `email` is the local part, `forwards_to`
// is one address or an array of them
interface NsEmailAddresses {
  email?: string;
  forwards_to?: string | string[];
}

interface NsResponse {
  reply?: NsReply;
}

// getDomainInfo.contact_ids: internal NameSilo IDs per role (strings)
interface NsContactIds {
  registrant?: string | number;
  administrative?: string | number;
  technical?: string | number;
  billing?: string | number;
}

// a full contact record from contactList (empty XML elements parse to '' or {})
interface NsContact {
  contact_id?: string | number;
  first_name?: unknown;
  last_name?: unknown;
  company?: unknown;
  address?: unknown;
  address2?: unknown;
  city?: unknown;
  state?: unknown;
  zip?: unknown;
  country?: unknown;
  email?: unknown;
  phone?: unknown;
  fax?: unknown;
}

// a DNS record from dnsListRecords (distance carries the MX priority)
interface NsResourceRecord {
  record_id?: string | number;
  type?: unknown;
  host?: unknown;
  value?: unknown;
  ttl?: unknown;
  distance?: unknown;
}

// one TLD's price node from getPrices
interface NsPriceNode {
  registration?: unknown;
  renew?: unknown;
  transfer?: unknown;
}

// a normalized availability entry parsed from a checkRegisterAvailability group
interface NsAvailEntry {
  name: string;
  price?: number;
  premium?: boolean;
  duration?: number;
}

// a domain entry from listDomains, which may arrive as a bare name or an object
interface NsDomainEntry {
  domain?: string;
  created?: string;
  expires?: string;
}

/**
 * NameSilo Registrar
 * API docs: https://www.namesilo.com/api-reference
 *
 * Credentials: generate an API key in your NameSilo account under
 * Account Options > API Manager. The key may optionally be restricted to up to
 * five IP addresses there.
 *
 * Note: NameSilo uses a simple HTTP GET API — every call hits
 * `/{operation}` with `version`, `type=json`, and `key` query parameters (the
 * key travels in the URL, per their API design). Responses carry a numeric
 * `reply.code` (300 = success) rather than using HTTP status codes.
 */
export class NameSiloRegistrar extends BaseRegistrar {
  readonly name = 'namesilo';

  static readonly displayName = 'NameSilo';
  static readonly helpText =
    'Generate an API key in your NameSilo account under Account Options > API Manager. ' +
    'You can optionally restrict the key to specific IP addresses there. For sandbox ' +
    'testing, use { environment: "sandbox" } (OTE host ote.namesilo.com) — OTE ' +
    'credentials are not self-service; you must contact NameSilo support to be issued them.';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
  ];
  // NameSilo runs an OTE/test environment at ote.namesilo.com; sandbox keys are
  // issued by emailing NameSilo support (not self-service).
  static readonly supportsSandbox = true;
  // JSON API with broad coverage. Beyond core: DNSSEC read/disable, email
  // forwarding, and domain (URL) forwarding. GetAuthCode is intentionally NOT
  // declared — NameSilo's retrieveAuthCode emails the EPP code to the
  // registrant and never returns it, so it can't satisfy the getAuthCode
  // contract. No webhooks (polling only).
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.GetDnssec,
    Feature.DisableDnssec,
    Feature.GetEmailForwarding,
    Feature.SetEmailForwarding,
    Feature.GetDomainForwarding,
    Feature.SetDomainForwarding,
  ];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('NameSilo', options?.environment, {
          production: 'https://www.namesilo.com/api',
          sandbox: 'https://ote.namesilo.com/api',
        }),
      },
      options
    );
  }

  // issue an operation with the standard auth params merged in
  private call(
    operation: string,
    extra: Record<string, string | number> = {},
    opts?: RequestOptions
  ): Promise<NsResponse> {
    return this.http.request<NsResponse>({
      path: `/${operation}`,
      query: { version: 1, type: 'json', key: this.credentials.apiKey, ...extra },
      ...opts,
    });
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      // getAccountBalance is the cheapest read-only call that validates the key
      const res = await this.call('getAccountBalance', {}, opts);
      return replyOk(res)
        ? { success: true, message: 'Connection successful' }
        : { success: false, message: replyDetail(res) };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  /**
   * listDomains returns names + created/expires dates only. Nameservers, status,
   * lock, privacy, and auto-renew are NOT in the list response and cannot be
   * batched in — use `getDomain` per domain for those. `search` is applied
   * client-side (NameSilo has no server-side name filter).
   */
  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const { search, ...reqOpts } = opts ?? {};
    const domains: Domain[] = [];
    const perPage = 100; // NameSilo page size
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const res = await this.call('listDomains', { page, pageSize: perPage }, reqOpts);
      if (!replyOk(res)) {
        throw new Error(replyDetail(res));
      }

      const entries = extractDomainEntries(res.reply?.domains);
      for (const entry of entries) {
        domains.push(
          createDomain({
            domainName: entry.domain,
            registrar: this.name,
            status: 'ok', // the list endpoint does not return a per-domain status
            createdDate: entry.created,
            expirationDate: entry.expires,
            renewalDate: entry.expires,
            nameservers: [], // not returned by listDomains (see getDomain)
          })
        );
      }

      hasMore = entries.length === perPage;
      page++;
    }
    return filterDomains(domains, search);
  }

  /**
   * getDomainInfo carries the details listDomains omits: status, lock, privacy,
   * auto-renew, and nameservers. This is the only way to get NS for a NameSilo
   * domain (one call per domain).
   */
  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    const res = await this.call('getDomainInfo', { domain: domainName }, opts);
    if (!replyOk(res)) {
      throw new NotFoundError(`NameSilo: domain '${domainName}' not found (${replyDetail(res)})`);
    }
    const r = res.reply ?? {};
    return createDomain({
      domainName,
      registrar: this.name,
      status: r.status,
      createdDate: r.created,
      expirationDate: r.expires,
      renewalDate: r.expires,
      autoRenew: isYes(r.auto_renew),
      locked: isYes(r.locked),
      privacy: isYes(r.private),
      nameservers: extractNsHosts(r.nameservers),
    });
  }

  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    const domain = await this.getDomain(domainName, opts);
    return domain.nameservers;
  }

  /**
   * NameSilo has no per-domain contact read: getDomainInfo returns only the
   * internal contact IDs per role, so we resolve them against the full account
   * contact profiles from `contactList` (one extra call), matching by ID.
   */
  override async getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    const infoRes = await this.call('getDomainInfo', { domain: domainName }, opts);
    if (!replyOk(infoRes)) {
      throw new NotFoundError(
        `NameSilo: domain '${domainName}' not found (${replyDetail(infoRes)})`
      );
    }
    const ids = infoRes.reply?.contact_ids ?? {};

    const listRes = await this.call('contactList', {}, opts);
    if (!replyOk(listRes)) {
      throw new Error(replyDetail(listRes));
    }
    const byId = new Map<string, NsContact>();
    for (const c of ensureArray(listRes.reply?.contact)) {
      byId.set(text(c.contact_id), c);
    }

    const lookup = (id: string | number | undefined): Contact | undefined => {
      const key = text(id);
      return key ? fromNsContact(byId.get(key)) : undefined;
    };
    return {
      registrant: lookup(ids.registrant),
      admin: lookup(ids.administrative),
      tech: lookup(ids.technical),
      billing: lookup(ids.billing),
    };
  }

  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const res = await this.call('dnsListRecords', { domain: domainName }, opts);
    if (!replyOk(res)) {
      throw new Error(replyDetail(res));
    }
    return ensureArray(res.reply?.resource_record).map(rr => {
      const type = text(rr.type).toUpperCase();
      const record: DnsRecord = {
        type,
        name: text(rr.host),
        value: text(rr.value),
      };
      const ttl = Number(rr.ttl);
      if (Number.isFinite(ttl)) record.ttl = ttl;
      // NameSilo carries the MX priority in `distance`
      const distance = Number(rr.distance);
      if (type === 'MX' && Number.isFinite(distance)) record.priority = distance;
      return record;
    });
  }

  /**
   * Per-TLD pricing via getPrices, which returns every supported TLD keyed
   * directly on the reply (e.g. reply.com = { registration, renew, transfer }).
   * Prices are already in major USD units. A bare TLD works; a full domain is
   * reduced to its TLD.
   */
  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    const tld = (
      tldOrDomain.includes('.') ? tldOrDomain.slice(tldOrDomain.indexOf('.') + 1) : tldOrDomain
    ).toLowerCase();

    const res = await this.call('getPrices', {}, opts);
    if (!replyOk(res)) {
      throw new Error(replyDetail(res));
    }
    const reply = (res.reply ?? {}) as Record<string, unknown>;
    const node = reply[tld];
    if (!node || typeof node !== 'object') {
      throw new NotFoundError(`NameSilo: no pricing found for TLD '${tld}'`);
    }
    const price = node as NsPriceNode;
    return {
      tld,
      currency: 'USD',
      registration: toPrice(price.registration),
      renewal: toPrice(price.renew),
      transfer: toPrice(price.transfer),
    };
  }

  /**
   * Availability via checkRegisterAvailability (up to 200 domains per request).
   * The reply splits names into `available`, `unavailable`, and `invalid`
   * groups; available entries carry `price`/`premium`/`duration` attributes.
   * Malformed names land in `invalid` and are omitted from the result.
   */
  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const res = await this.call(
      'checkRegisterAvailability',
      { domains: domainNames.join(',') },
      opts
    );
    if (!replyOk(res)) {
      throw new Error(replyDetail(res));
    }
    const reply = res.reply ?? {};
    const results: DomainAvailability[] = [];

    for (const entry of extractAvailEntries(reply.available)) {
      const result: DomainAvailability = { domainName: entry.name, available: true };
      if (entry.premium != null) result.premium = entry.premium;
      if (entry.price != null) {
        result.price = entry.price;
        result.currency = 'USD';
      }
      if (entry.duration != null) result.period = entry.duration;
      results.push(result);
    }
    for (const entry of extractAvailEntries(reply.unavailable)) {
      results.push({ domainName: entry.name, available: false });
    }
    return results;
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const res = await this.call('renewDomain', { domain: domainName, years }, opts);
    return statusResult(res);
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 2 || nameservers.length > 13) {
      throw new Error('NameSilo requires 2-13 nameservers');
    }
    const query: Record<string, string | number> = { domain: domainName };
    nameservers.forEach((ns, i) => {
      query[`ns${i + 1}`] = ns; // ns1..ns13
    });
    const res = await this.call('changeNameServers', query, opts);
    return statusResult(res);
  }

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    // 252 = "already locked" — treat as an idempotent success
    const res = await this.call('domainLock', { domain: domainName }, opts);
    return statusResult(res, [252]);
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    // 253 = "already unlocked" — treat as an idempotent success
    const res = await this.call('domainUnlock', { domain: domainName }, opts);
    return statusResult(res, [253]);
  }

  // --- extended capabilities ---------------------------------------------

  /**
   * DNSSEC status via dnsSecListRecords, which returns zero or more `ds_record`
   * entries (snake_case fields on read). A non-empty list means DNSSEC is on.
   */
  override async getDnssec(domainName: string, opts?: RequestOptions): Promise<DnssecStatus> {
    const res = await this.call('dnsSecListRecords', { domain: domainName }, opts);
    if (!replyOk(res)) throw new Error(replyDetail(res));
    const list = ensureArray<NsDsRecord>(res.reply?.ds_record);
    return {
      enabled: list.length > 0,
      dsRecords: list.map(d => ({
        keyTag: Number(d.key_tag) || 0,
        algorithm: Number(d.algorithm) || 0,
        digestType: Number(d.digest_type) || 0,
        digest: text(d.digest),
      })),
    };
  }

  /**
   * Disable DNSSEC by deleting every DS record (dnsSecDeleteRecord, once per
   * record — NameSilo has no bulk off). The delete params are camelCase and echo
   * the record's identifying fields.
   */
  override async disableDnssec(
    domainName: string,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const res = await this.call('dnsSecListRecords', { domain: domainName }, opts);
      if (!replyOk(res)) return statusResult(res);
      for (const d of ensureArray<NsDsRecord>(res.reply?.ds_record)) {
        const del = await this.call(
          'dnsSecDeleteRecord',
          {
            domain: domainName,
            digest: text(d.digest),
            keyTag: text(d.key_tag),
            digestType: text(d.digest_type),
            alg: text(d.algorithm),
          },
          opts
        );
        if (!replyOk(del)) return statusResult(del);
      }
      return { success: true, message: 'DNSSEC disabled successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  /**
   * Read email forwarding via listEmailForwards. Each `addresses` entry has an
   * `email` (local part) and one or more `forwards_to`; expand each destination
   * into its own {alias, forwardTo} row.
   */
  override async getEmailForwarding(
    domainName: string,
    opts?: RequestOptions
  ): Promise<EmailForward[]> {
    const res = await this.call('listEmailForwards', { domain: domainName }, opts);
    if (!replyOk(res)) throw new Error(replyDetail(res));
    const out: EmailForward[] = [];
    for (const a of ensureArray<NsEmailAddresses>(res.reply?.addresses)) {
      const alias = text(a.email);
      for (const dest of ensureArray<string>(a.forwards_to)) {
        if (alias && dest) out.push({ alias, forwardTo: text(dest) });
      }
    }
    return out;
  }

  /**
   * Replace email forwarding (full replace; empty clears). NameSilo has no bulk
   * endpoint, so diff by mailbox: configureEmailForward upserts one alias with up
   * to 5 destinations (forward1..forward5); deleteEmailForward removes an alias.
   */
  override async setEmailForwarding(
    domainName: string,
    forwards: EmailForward[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const desired = new Map<string, string[]>();
      for (const f of forwards) {
        const list = desired.get(f.alias) ?? [];
        list.push(f.forwardTo);
        desired.set(f.alias, list);
      }
      const res = await this.call('listEmailForwards', { domain: domainName }, opts);
      if (!replyOk(res)) return statusResult(res);
      const currentAliases = new Set(
        ensureArray<NsEmailAddresses>(res.reply?.addresses)
          .map(a => text(a.email))
          .filter(Boolean)
      );

      for (const alias of currentAliases) {
        if (!desired.has(alias)) {
          const del = await this.call(
            'deleteEmailForward',
            { domain: domainName, email: alias },
            opts
          );
          if (!replyOk(del)) return statusResult(del);
        }
      }
      for (const [alias, destinations] of desired) {
        const query: Record<string, string | number> = { domain: domainName, email: alias };
        // NameSilo supports up to 5 destinations: forward1..forward5
        destinations.slice(0, 5).forEach((dest, i) => {
          query[`forward${i + 1}`] = dest;
        });
        const set = await this.call('configureEmailForward', query, opts);
        if (!replyOk(set)) return statusResult(set);
      }
      return { success: true, message: 'Email forwarding updated successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  /**
   * Read the apex URL forwarding from getDomainInfo (`forward_url`/`forward_type`).
   * NameSilo has no forwarding-list endpoint, so only the apex forward is
   * readable — per-subdomain forwards can be set but not enumerated.
   */
  override async getDomainForwarding(
    domainName: string,
    opts?: RequestOptions
  ): Promise<DomainForward[]> {
    const res = await this.call('getDomainInfo', { domain: domainName }, opts);
    if (!replyOk(res)) throw new Error(replyDetail(res));
    const url = text(res.reply?.forward_url);
    if (!url) return [];
    return [{ host: '@', url, type: nsForwardType(res.reply?.forward_type) }];
  }

  /**
   * Set apex URL forwarding via domainForward (method 301/302/cloaked). NameSilo
   * can't list per-subdomain forwards, so this interface supports the apex forward
   * only (host "@"); an empty list clears it by restoring NameSilo's default
   * nameservers (there is no dedicated "stop forwarding" command).
   */
  override async setDomainForwarding(
    domainName: string,
    forwards: DomainForward[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (forwards.length === 0) {
      return this.updateNameservers(domainName, NAMESILO_DEFAULT_NS, opts);
    }
    if (forwards.length > 1) {
      throw new Error('NameSilo supports a single apex ("@") forward via this interface');
    }
    const [f] = settableForwards(forwards); // reject masked before any write
    if (f.host && f.host !== '@') {
      throw new Error(
        'NameSilo per-subdomain forwards are not listable, so only the apex ("@") forward is supported'
      );
    }
    const scheme = /^(https?):\/\/(.*)$/i.exec(f.url);
    const protocol = scheme ? scheme[1].toLowerCase() : 'http';
    const address = scheme ? scheme[2] : f.url;
    const res = await this.call(
      'domainForward',
      { domain: domainName, protocol, address, method: NS_FORWARD_METHOD[f.type] },
      opts
    );
    return statusResult(res);
  }

  override async setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    // 300 on change; 280 = "already set to that value" — idempotent success
    const res = await this.call(
      enabled ? 'addAutoRenewal' : 'removeAutoRenewal',
      { domain: domainName },
      opts
    );
    return statusResult(res, [280]);
  }

  override async setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    // 300 on change; 280 = "already in that state" — idempotent success
    const res = await this.call(
      enabled ? 'addPrivacy' : 'removePrivacy',
      { domain: domainName },
      opts
    );
    return statusResult(res, [280]);
  }

  /**
   * Replaces the record set. NameSilo has no atomic "set all" endpoint — records
   * are added/deleted individually by id — so this diffs against the current
   * records: it adds records not already present and deletes those no longer in
   * the desired set, leaving unchanged records (and their ids) untouched. The
   * delegation nameservers aren't part of this list (see `updateNameservers`).
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const listRes = await this.call('dnsListRecords', { domain: domainName }, opts);
    if (!replyOk(listRes)) return { success: false, message: replyDetail(listRes) };
    const existing = ensureArray(listRes.reply?.resource_record);

    const existingByKey = new Map<string, string>(); // record key -> record_id
    for (const rr of existing) {
      const k = dnsKey(text(rr.type), text(rr.host), text(rr.value), Number(rr.distance));
      existingByKey.set(k, text(rr.record_id));
    }

    // add desired records that aren't already present
    const desiredKeys = new Set<string>();
    for (const r of records) {
      const type = r.type.toUpperCase();
      const k = dnsKey(type, r.name || '@', r.value, r.priority);
      desiredKeys.add(k);
      if (existingByKey.has(k)) continue;
      const query: Record<string, string | number> = {
        domain: domainName,
        rrtype: type,
        rrhost: r.name === '@' ? '' : r.name, // NameSilo wants a bare host, empty at the apex
        rrvalue: r.value,
        rrttl: r.ttl ?? 7207, // NameSilo's default TTL
      };
      if (type === 'MX') query.rrdistance = r.priority ?? 10;
      const addRes = await this.call('dnsAddRecord', query, opts);
      if (!replyOk(addRes)) return { success: false, message: replyDetail(addRes) };
    }

    // delete existing records no longer in the desired set
    for (const [k, rrid] of existingByKey) {
      if (desiredKeys.has(k) || !rrid) continue;
      const delRes = await this.call('dnsDeleteRecord', { domain: domainName, rrid }, opts);
      if (!replyOk(delRes)) return { success: false, message: replyDetail(delRes) };
    }
    return { success: true, message: 'DNS records updated successfully' };
  }

  /**
   * Updates contact roles. NameSilo contacts are account-level records referenced
   * by id, so this creates a new contact profile per supplied role (`contactAdd`)
   * and points the domain's roles at the new ids (`contactDomainAssociate`).
   * Identical contacts across roles are created once. Roles not supplied keep
   * their current association.
   */
  override async updateContacts(
    domainName: string,
    contacts: ContactSet,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const roles: [keyof ContactSet, string][] = [
      ['registrant', 'registrant'],
      ['admin', 'administrative'],
      ['tech', 'technical'],
      ['billing', 'billing'],
    ];
    const association: Record<string, string | number> = { domain: domainName };
    const idByContact = new Map<Contact, string>();
    for (const [role, param] of roles) {
      const contact = contacts[role];
      if (!contact) continue;
      let id = idByContact.get(contact);
      if (!id) {
        const addRes = await this.call('contactAdd', toNsContactParams(contact), opts);
        if (!replyOk(addRes)) return { success: false, message: replyDetail(addRes) };
        id = text(addRes.reply?.contact_id);
        if (!id) return { success: false, message: 'NameSilo: contactAdd returned no contact_id' };
        idByContact.set(contact, id);
      }
      association[param] = id;
    }
    if (Object.keys(association).length === 1) {
      throw new Error('NameSilo: updateContacts requires at least one contact role');
    }
    const assocRes = await this.call('contactDomainAssociate', association, opts);
    return statusResult(assocRes);
  }

  /**
   * Registers a domain. NameSilo registers the domain against the account's
   * default contact profile (use `updateContacts` afterwards to set specific
   * contacts). `private`/`auto_renew` are honored, and initial nameservers are
   * passed when supplied. Spends real money; not exercised against a live account.
   */
  override async registerDomain(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const query: Record<string, string | number> = {
      domain: domainName,
      years: input.years ?? 1,
      private: input.privacy ? 1 : 0,
      auto_renew: input.autoRenew ? 1 : 0,
    };
    (input.nameservers ?? []).forEach((ns, i) => {
      query[`ns${i + 1}`] = ns;
    });
    const res = await this.call('registerDomain', query, opts);
    return statusResult(res);
  }

  /**
   * Transfers a domain in with its EPP auth code. `private`/`auto_renew` are
   * honored; contacts come from the account default. Spends real money; not
   * exercised against a live account.
   */
  override async transferIn(
    domainName: string,
    input: TransferDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const query: Record<string, string | number> = {
      domain: domainName,
      auth: input.authCode,
      private: input.privacy ? 1 : 0,
      auto_renew: input.autoRenew ? 1 : 0,
    };
    const res = await this.call('transferDomain', query, opts);
    return statusResult(res);
  }
}

// safely stringify an unknown XML value: strings/numbers/booleans pass through
// (trimmed), everything else (e.g. an empty `{}` from a self-closing element)
// becomes ''. Guards against no-base-to-string on arbitrary objects.
function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

// a stable identity key for a DNS record: type + relative host (apex as "@") +
// value, plus the MX distance (priority) which is part of an MX record's identity
function dnsKey(type: string, host: string, value: string, distance: number | undefined): string {
  const t = type.toUpperCase();
  const dist = t === 'MX' && Number.isFinite(distance) ? String(distance) : '';
  return [t, host || '@', value, dist].join(' ');
}

// map the normalized Contact to NameSilo's contactAdd parameters (fn/ln/ad/…)
function toNsContactParams(c: Contact): Record<string, string | number> {
  const params: Record<string, string | number> = {
    fn: c.firstName,
    ln: c.lastName,
    ad: c.address1,
    cy: c.city,
    st: c.state ?? '',
    zp: c.postalCode,
    ct: c.country,
    em: c.email,
    ph: c.phone,
  };
  if (c.organization) params.cp = c.organization;
  if (c.address2) params.ad2 = c.address2;
  if (c.fax) params.fx = c.fax;
  return params;
}

// parse an unknown price-ish value into a positive number, or undefined
function toPrice(v: unknown): number | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// map a NameSilo contact record to the normalized Contact shape
function fromNsContact(c: NsContact | undefined): Contact | undefined {
  if (!c) return undefined;
  const opt = (v: unknown): string | undefined => {
    const s = text(v);
    return s ? s : undefined;
  };
  return {
    firstName: text(c.first_name),
    lastName: text(c.last_name),
    organization: opt(c.company),
    email: text(c.email),
    phone: text(c.phone),
    fax: opt(c.fax),
    address1: text(c.address),
    address2: opt(c.address2),
    city: text(c.city),
    state: text(c.state),
    postalCode: text(c.zip),
    country: text(c.country),
  };
}

// normalize a checkRegisterAvailability group into availability entries. A group
// is `{ domain: <entry|entry[]> }`; each entry is a bare domain string, or (for
// available names) an object carrying the name plus price/premium/duration.
// NameSilo's JSON attribute naming isn't contractually documented, so read the
// bare, `@`, and `@_` forms defensively (mirroring extractNsHosts' #text guard).
function extractAvailEntries(group: unknown): NsAvailEntry[] {
  if (!group) return [];
  const raw =
    typeof group === 'object' && !Array.isArray(group) && 'domain' in group
      ? ((group as { domain?: unknown }).domain ?? [])
      : group;
  return ensureArray(raw)
    .map((item): NsAvailEntry => {
      if (typeof item === 'string') return { name: item.trim() };
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const name = text(o['#text'] ?? o.value ?? o.domain);
        const priceRaw = o.price ?? o['@price'] ?? o['@_price'];
        const premiumRaw = o.premium ?? o['@premium'] ?? o['@_premium'];
        const durationRaw = o.duration ?? o['@duration'] ?? o['@_duration'];
        const entry: NsAvailEntry = { name };
        const price = toPrice(priceRaw);
        if (price != null && price > 0) entry.price = price;
        if (premiumRaw != null && text(premiumRaw) !== '') entry.premium = isYes(premiumRaw);
        const duration = toPrice(durationRaw);
        if (duration != null && duration > 0) entry.duration = duration;
        return entry;
      }
      return { name: '' };
    })
    .filter(e => e.name);
}

// NameSilo booleans arrive as "Yes"/"No" (or 1/0) strings
function isYes(v: unknown): boolean {
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return false;
  const s = String(v).trim().toLowerCase();
  return s === 'yes' || s === '1' || s === 'true';
}

// NameSilo's default nameservers, used to switch a domain off URL forwarding
// (there is no dedicated "stop forwarding" command).
const NAMESILO_DEFAULT_NS = ['ns1.namesilo.com', 'ns2.namesilo.com'];

// map our generic (settable) forward type to NameSilo's domainForward `method`
const NS_FORWARD_METHOD: Record<'temporary' | 'permanent', string> = {
  permanent: '301',
  temporary: '302',
};

// interpret NameSilo's read-side forward_type into our generic type. A masked/
// cloaked forward is reported as read-only `masked` (setDomainForwarding rejects it).
function nsForwardType(v: string | undefined): DomainForwardType {
  const s = (v ?? '').toLowerCase();
  if (s.includes('cloak') || s.includes('frame') || s.includes('mask')) return 'masked';
  if (s.includes('302') || s.includes('temp')) return 'temporary';
  return 'permanent';
}

// getDomainInfo returns nameservers as an array of `{ nameserver: "HOST",
// position: N }`. Some other endpoints wrap them as `{ nameserver: [...] }` or
// carry the host in `#text`, so all forms are handled defensively.
function extractNsHosts(ns: unknown): string[] {
  if (!ns) return [];
  const raw =
    typeof ns === 'object' && !Array.isArray(ns) && 'nameserver' in ns
      ? ((ns as { nameserver?: unknown }).nameserver ?? [])
      : ns;
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        if (typeof o.nameserver === 'string') return o.nameserver; // { nameserver: "HOST", position }
        if (typeof o['#text'] === 'string') return o['#text'];
      }
      return '';
    })
    .filter(Boolean);
}

// whether the response's reply.code is in the success family (300)
function replyOk(res: NsResponse): boolean {
  return Number(res.reply?.code) === 300;
}

// human-readable detail from a reply, for error messages
function replyDetail(res: NsResponse): string {
  return res.reply?.detail?.trim() || 'Unknown response';
}

// map a reply to an OperationResult; extra codes are also treated as success
function statusResult(res: NsResponse, okCodes: number[] = []): OperationResult {
  const code = Number(res.reply?.code);
  if (code === 300 || okCodes.includes(code)) {
    return { success: true, message: res.reply?.detail?.trim() || 'success' };
  }
  return { success: false, message: replyDetail(res) };
}

// listDomains may return domains as an array of names, an array of objects, or
// an object wrapping a `domain` array — normalize all shapes to entry objects
function extractDomainEntries(domains: unknown): NsDomainEntry[] {
  if (!domains) return [];
  const raw = Array.isArray(domains)
    ? domains
    : typeof domains === 'object' && 'domain' in domains
      ? ((domains as { domain?: unknown }).domain ?? [])
      : [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(item => (typeof item === 'string' ? { domain: item } : (item as NsDomainEntry)));
}

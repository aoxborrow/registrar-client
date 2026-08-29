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
} from '../types';
import { createDomain, filterDomains, normalizeDomain } from '../utils';
import { NotImplementedError, toRegistrarError } from '../errors';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import type { RegistrarFeature } from '../features';
import type { RegistrarCredentials } from '../types';

// Cloudflare's standard response envelope
interface CfEnvelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

// a domain object from the Cloudflare Registrar API
interface CfDomain {
  name: string;
  // registrar domains report lifecycle under last_known_status (e.g.
  // "registrationActive") — there is no plain `status` field
  last_known_status?: string;
  registered_at?: string;
  expires_at?: string;
  auto_renew?: boolean;
  locked?: boolean;
  privacy?: boolean;
  name_servers?: string[];
  // WHOIS contacts, keyed by role, on the registrar domain payload
  contacts?: {
    registrant?: CfContact;
    administrator?: CfContact;
    technical?: CfContact;
    billing?: CfContact;
  };
}

// a WHOIS contact as the Cloudflare Registrar API returns it
interface CfContact {
  first_name?: string;
  last_name?: string;
  organization?: string;
  email?: string;
  phone?: string;
  fax?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

// a zone object from the Cloudflare Zones API. Nameservers and DNS records live
// on the Zones API, not the Registrar API, so several read methods resolve the
// domain to its zone first.
interface CfZone {
  id: string;
  name: string;
  name_servers?: string[];
}

// pricing (major currency units, as strings) on a domain-check / domain-search entry
interface CfPricing {
  currency?: string;
  registration_cost?: string;
  renewal_cost?: string;
}

// one entry from the registrar domain-check / domain-search result. `registrable`
// is the authoritative availability flag; `reason` explains a false (e.g.
// "domain_premium", "extension_not_supported_via_api").
interface CfDomainCheck {
  name: string;
  registrable: boolean;
  tier?: string;
  reason?: string;
  pricing?: CfPricing;
}

// the registration resource returned by POST /registrar/registrations and the
// registration-status endpoint. `state` is the lifecycle; `completed` is a
// convenience flag; registry details hang off context.registration.
interface CfRegistration {
  domain_name?: string;
  state?: 'in_progress' | 'succeeded' | 'failed' | 'action_required' | 'blocked';
  completed?: boolean;
  reason?: string;
}

// a DNS record from the Cloudflare Zones DNS API. For SRV records, weight/port
// are carried on a nested `data` object; `content` holds the primary value for
// every type, and `priority` is populated for MX/SRV.
interface CfDnsRecord {
  // record id, present on records read from the API (needed to delete them)
  id?: string;
  type: string;
  name: string;
  content?: string;
  ttl?: number;
  priority?: number;
  data?: {
    weight?: number;
    port?: number;
    priority?: number;
  };
}

/**
 * Cloudflare Registrar
 * API docs: https://developers.cloudflare.com/api/resources/registrar/
 *
 * Credentials: create an API token under My Profile > API Tokens with
 * "Account.Registrar" read/write permission. The Account ID is shown on the
 * Overview page of any zone (and in the dashboard URL).
 *
 * Registration is supported via the Registrar API's registrations endpoint
 * (beta): at-cost, standard-tier, API-supported TLDs only — premium names and
 * unsupported extensions are rejected by the availability check. Renewals and
 * transfers-in are not yet exposed by the Cloudflare API. Registrar is at-cost,
 * so `registerDomain` spends real money.
 */
export class CloudflareRegistrar extends BaseRegistrar {
  readonly name = 'cloudflare';

  static readonly displayName = 'Cloudflare';
  static readonly helpText =
    'Create an API token in your Cloudflare dashboard under My Profile > API Tokens. ' +
    'The token needs "Account.Registrar" read/write permissions. Find your Account ID ' +
    'in the URL or on the Overview page of any zone.';
  static readonly configFields: ConfigField[] = [
    { name: 'apiToken', label: 'API Token', type: 'password', required: true },
    { name: 'accountId', label: 'Account ID', type: 'text', required: true },
  ];
  static readonly supportsSandbox = false; // Cloudflare Registrar has no test environment
  // No extended capabilities. Cloudflare is held to the core contract like any
  // provider. Reads, registration, availability/pricing, privacy, and DNS are
  // implemented (DNS routes through the Zones API); auto-renew, lock, nameserver,
  // renew, and contact updates are not — Cloudflare's API has no post-registration
  // update endpoint and the legacy edit endpoint (EOL 2026-09-27) rejects those
  // fields. Those methods stay `NotImplementedError`. See docs/registrars/cloudflare.md.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [];

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('Cloudflare', options?.environment, {
          production: 'https://api.cloudflare.com/client/v4',
        }),
        headers: {
          'Authorization': `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
        },
      },
      options
    );
  }

  private get accountPath(): string {
    return `/accounts/${this.credentials.accountId}/registrar/domains`;
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      const res = await this.http.request<CfEnvelope<CfDomain[]>>({
        path: this.accountPath,
        ...opts,
      });
      return res.success
        ? { success: true, message: 'Connection successful' }
        : { success: false, message: res.errors?.[0]?.message ?? 'Request failed' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    // The Registrar list endpoint has no name filter, so `search` is applied
    // client-side. It also does not return nameservers (those live on the Zones
    // API); `nameservers` therefore reflects only what the list response carries.
    const { search, ...reqOpts } = opts ?? {};
    const domains: Domain[] = [];
    const perPage = 200; // Cloudflare API maximum page size
    let page = 0; // the Registrar list endpoint is 0-indexed (result_info.page starts at 0)
    let hasMore = true;

    while (hasMore) {
      const res = await this.http.request<CfEnvelope<CfDomain[]>>({
        path: this.accountPath,
        query: { per_page: perPage, page },
        ...reqOpts,
      });
      if (!res.success) {
        throw new Error(res.errors?.[0]?.message ?? 'API request failed');
      }
      const list = res.result ?? [];
      for (const d of list) domains.push(this.toDomain(d));
      hasMore = list.length === perPage;
      page++;
    }
    return filterDomains(domains, search);
  }

  // map a Cloudflare Registrar domain payload to the normalized Domain shape
  private toDomain(d: CfDomain): Domain {
    return createDomain({
      domainName: d.name,
      registrar: this.name,
      status: d.last_known_status,
      createdDate: d.registered_at,
      expirationDate: d.expires_at,
      renewalDate: d.expires_at,
      autoRenew: d.auto_renew ?? false,
      locked: d.locked ?? false,
      privacy: d.privacy ?? true, // Cloudflare includes WHOIS privacy by default
      nameservers: d.name_servers ?? [],
    });
  }

  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    // Registrar API: GET /accounts/{account_id}/registrar/domains/{domain}
    const res = await this.http.request<CfEnvelope<CfDomain>>({
      path: `${this.accountPath}/${encodeURIComponent(domainName)}`,
      ...opts,
    });
    if (!res.success || !res.result) {
      throw new Error(res.errors?.[0]?.message ?? `Domain ${domainName} not found`);
    }
    return this.toDomain(res.result);
  }

  /**
   * Nameservers come from the Zones API, not the Registrar API: a domain must be
   * an active zone in the account for its Cloudflare-assigned nameservers to be
   * known. GET /zones?name={domain} → the zone's `name_servers`.
   */
  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    const zone = await this.findZone(domainName, opts);
    if (!zone) {
      throw new Error(
        `${this.name}: ${domainName} is not a zone in this account; nameservers are only ` +
          'available via the Zones API for domains added as zones'
      );
    }
    return zone.name_servers ?? [];
  }

  /**
   * DNS records live on the Zones API. Two-step: resolve the domain to its
   * zone_id via GET /zones?name={domain}, then GET /zones/{zone_id}/dns_records.
   */
  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const zone = await this.findZone(domainName, opts);
    if (!zone) {
      throw new Error(
        `${this.name}: ${domainName} is not a zone in this account; DNS records are managed ` +
          'through the Zones API for domains added as zones'
      );
    }
    const res = await this.http.request<CfEnvelope<CfDnsRecord[]>>({
      path: `/zones/${encodeURIComponent(zone.id)}/dns_records`,
      ...opts,
    });
    if (!res.success) {
      throw new Error(res.errors?.[0]?.message ?? 'Failed to list DNS records');
    }
    return (res.result ?? []).map(toDnsRecord);
  }

  /**
   * Replace the zone's DNS records with the provided set (Zones API). The
   * Registrar API has no DNS surface, so the domain must be an active zone in the
   * account. Cloudflare has no bulk "replace" call, so this deletes the zone's
   * existing records and recreates them from `records`. The implicit SOA and the
   * zone's Cloudflare nameservers are not part of the editable record set and are
   * left untouched; an apex NS record in `records` is skipped (Cloudflare manages
   * it).
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const zone = await this.findZone(domainName, opts);
      if (!zone) {
        return {
          success: false,
          message: `${domainName} is not a zone in this account; DNS is managed via the Zones API`,
        };
      }
      const dnsPath = `/zones/${encodeURIComponent(zone.id)}/dns_records`;

      const list = await this.http.request<CfEnvelope<CfDnsRecord[]>>({ path: dnsPath, ...opts });
      if (!list.success) {
        return {
          success: false,
          message: list.errors?.[0]?.message ?? 'Failed to list DNS records',
        };
      }

      for (const rec of list.result ?? []) {
        if (!rec.id) continue;
        const del = await this.http.request<CfEnvelope<unknown>>({
          method: 'DELETE',
          path: `${dnsPath}/${encodeURIComponent(rec.id)}`,
          ...opts,
        });
        if (!del.success) {
          return {
            success: false,
            message: del.errors?.[0]?.message ?? 'Failed to delete DNS record',
          };
        }
      }

      for (const record of records) {
        const type = record.type.toUpperCase();
        const name = toFqdn(record.name, zone.name);
        if (type === 'NS' && name === zone.name) continue; // apex NS is Cloudflare-managed
        const create = await this.http.request<CfEnvelope<unknown>>({
          method: 'POST',
          path: dnsPath,
          body: toCfDnsBody(record, type, name),
          ...opts,
        });
        if (!create.success) {
          return {
            success: false,
            message: create.errors?.[0]?.message ?? `Failed to create ${type} record`,
          };
        }
      }
      return { success: true, message: 'DNS records updated successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  /**
   * WHOIS contacts come inline on the registrar domain payload, keyed by role
   * (registrant / administrator / technical / billing). GET the domain and map
   * each present role to the normalized ContactSet.
   */
  override async getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    const res = await this.http.request<CfEnvelope<CfDomain>>({
      path: `${this.accountPath}/${encodeURIComponent(domainName)}`,
      ...opts,
    });
    if (!res.success || !res.result) {
      throw new Error(res.errors?.[0]?.message ?? `Domain ${domainName} not found`);
    }
    const c = res.result.contacts ?? {};
    const contacts: ContactSet = {};
    if (c.registrant) contacts.registrant = toContact(c.registrant);
    if (c.administrator) contacts.admin = toContact(c.administrator);
    if (c.technical) contacts.tech = toContact(c.technical);
    if (c.billing) contacts.billing = toContact(c.billing);
    return contacts;
  }

  private get registrarPath(): string {
    return `/accounts/${this.credentials.accountId}/registrar`;
  }

  // authoritative availability + pricing for a batch of names (max 20 per call).
  // POST /registrar/domain-check is the source of truth (unlike domain-search).
  private async domainCheck(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<CfDomainCheck[]> {
    const out: CfDomainCheck[] = [];
    for (let i = 0; i < domainNames.length; i += 20) {
      const batch = domainNames.slice(i, i + 20).map(normalizeDomain);
      const res = await this.http.request<CfEnvelope<{ domains?: CfDomainCheck[] }>>({
        method: 'POST',
        path: `${this.registrarPath}/domain-check`,
        body: { domains: batch },
        ...opts,
      });
      if (!res.success) {
        throw new Error(res.errors?.[0]?.message ?? 'Domain check failed');
      }
      out.push(...(res.result?.domains ?? []));
    }
    return out;
  }

  /**
   * Real-time pricing via the registrar domain-check endpoint. Cloudflare has no
   * per-TLD price list — pricing is per name (a premium name prices differently
   * from a standard one) — so a full domain gives an accurate quote; a bare TLD
   * is probed with a neutral standard label and returns representative pricing.
   * Transfers are not available via the Cloudflare API, so `transfer` is omitted.
   */
  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    const input = tldOrDomain.replace(/^\.+/, '').toLowerCase();
    const domain = input.includes('.') ? input : `registrar-client-pricing-probe.${input}`;
    const tld = domain.slice(domain.indexOf('.') + 1);
    const [entry] = await this.domainCheck([domain], opts);
    if (!entry?.pricing) {
      throw new Error(
        `${this.name}: no pricing available for ${tldOrDomain}${
          entry?.reason ? ` (${entry.reason})` : ''
        } — pass a specific standard-tier domain for an accurate quote`
      );
    }
    const pricing: TldPricing = { tld, currency: entry.pricing.currency ?? 'USD' };
    const reg = toPrice(entry.pricing.registration_cost);
    const renew = toPrice(entry.pricing.renewal_cost);
    if (reg != null) pricing.registration = reg;
    if (renew != null) pricing.renewal = renew;
    return pricing;
  }

  /**
   * Availability + pricing via POST /registrar/domain-check (the authoritative
   * check — domain-search is discovery-only). A name is `available` when the API
   * reports it registrable; premium names and unsupported extensions come back
   * registrable:false with a `reason`. Batches of 20 are sent per the API limit.
   */
  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const checks = await this.domainCheck(domainNames, opts);
    const byName = new Map(checks.map(c => [normalizeDomain(c.name), c]));
    return domainNames.map(name => {
      const c = byName.get(normalizeDomain(name));
      const availability: DomainAvailability = {
        domainName: normalizeDomain(name),
        available: c?.registrable ?? false,
      };
      if (c?.tier) availability.premium = c.tier === 'premium';
      const price = toPrice(c?.pricing?.registration_cost);
      if (price != null) availability.price = price;
      if (c?.pricing?.currency) availability.currency = c.pricing.currency;
      return availability;
    });
  }

  // resolve a domain name to its Cloudflare zone via the Zones API (null if the
  // domain is not a zone in this account)
  private async findZone(domainName: string, opts?: RequestOptions): Promise<CfZone | null> {
    const res = await this.http.request<CfEnvelope<CfZone[]>>({
      path: '/zones',
      query: { name: domainName },
      ...opts,
    });
    if (!res.success) {
      throw new Error(res.errors?.[0]?.message ?? 'Failed to look up zone');
    }
    return res.result?.find(z => z.name === domainName) ?? null;
  }

  /**
   * Register a domain via POST /registrar/registrations (Registrar API, beta).
   * Cloudflare registers onto the account's default WHOIS contact unless a
   * registrant is supplied; nameservers cannot be set at registration (the domain
   * joins the account on Cloudflare's nameservers). Registration is at-cost —
   * this spends real money — and only standard-tier, API-supported TLDs qualify
   * (premium names return registrable:false from checkAvailability). When the
   * request does not finish synchronously the registration continues server-side
   * and is polled to a terminal state.
   */
  override async registerDomain(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const name = normalizeDomain(domainName);
      const body: Record<string, unknown> = { domain_name: name };
      if (input.autoRenew != null) body.auto_renew = input.autoRenew;
      if (input.privacy != null) body.privacy_mode = input.privacy ? 'redaction' : 'off';
      const registrant = input.contacts?.registrant;
      if (registrant) body.contacts = { registrant: toCfRegistrant(registrant) };

      const res = await this.http.request<CfEnvelope<CfRegistration>>({
        method: 'POST',
        path: `${this.registrarPath}/registrations`,
        body,
        ...opts,
      });
      if (!res.success) {
        return { success: false, message: res.errors?.[0]?.message ?? 'Registration failed' };
      }

      let reg = res.result;
      for (let i = 0; reg && !reg.completed && reg.state === 'in_progress' && i < 15; i++) {
        await sleep(2000, opts?.signal);
        const poll = await this.http.request<CfEnvelope<CfRegistration>>({
          path: `${this.registrarPath}/registrations/${encodeURIComponent(name)}/registration-status`,
          ...opts,
        });
        if (!poll.success) break;
        reg = poll.result;
      }

      if (reg?.completed || reg?.state === 'succeeded') {
        return { success: true, message: `Domain ${domainName} registered successfully` };
      }
      return {
        success: false,
        message: `Registration did not complete (state: ${reg?.state ?? 'unknown'}${
          reg?.reason ? `, ${reg.reason}` : ''
        })`,
      };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  // Cloudflare exposes no post-registration update endpoint for auto-renew, lock,
  // or nameservers. `auto_renew`, `privacy_mode`, and `locked` can be set only at
  // registration (see `registerDomain`); the legacy PUT edit endpoint refuses
  // these fields (422 "not allowed to perform this action" for auto_renew/locked,
  // 403 for nameservers) while still accepting `privacy` (see `setPrivacy`).
  // Verified live against the account 2026-08-29 on both a gTLD (.dev) and .uk, so
  // this is API-wide, not TLD-specific. Renewals are likewise not in the API yet.
  // These stay NotImplementedError until Cloudflare ships update endpoints; the
  // wiring (patchDomain + a `name_servers`/`auto_renew`/`locked` body) is ready.
  private static readonly UPDATE_UNAVAILABLE =
    "Cloudflare's API has no post-registration update endpoint for it; set it during " +
    'registration or in the Cloudflare dashboard';

  override renewDomain(
    _domainName: string,
    _years = 1,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: renewDomain is not available — renewals are not yet in the Cloudflare ` +
          'Registrar API. Enable auto-renew at registration so the domain renews at expiry'
      )
    );
  }

  override updateNameservers(
    _domainName: string,
    _nameservers: string[],
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: updateNameservers is not available — Cloudflare Registrar nameserver ` +
          'changes require contacting Cloudflare Support (the API rejects them with 403)'
      )
    );
  }

  override lockDomain(_domainName: string, _opts?: RequestOptions): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: lockDomain — ${CloudflareRegistrar.UPDATE_UNAVAILABLE}`
      )
    );
  }

  override unlockDomain(_domainName: string, _opts?: RequestOptions): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: unlockDomain — ${CloudflareRegistrar.UPDATE_UNAVAILABLE}`
      )
    );
  }

  override setAutoRenew(
    _domainName: string,
    _enabled: boolean,
    _opts?: RequestOptions
  ): Promise<OperationResult> {
    return Promise.reject(
      new NotImplementedError(
        `${this.name}: setAutoRenew — ${CloudflareRegistrar.UPDATE_UNAVAILABLE}`
      )
    );
  }

  /**
   * Toggle WHOIS privacy (Cloudflare includes it free). PUT `privacy` on the
   * registrar domain. Whether the registry actually honors the change is
   * TLD-dependent, but Cloudflare accepts the update for supported TLDs.
   */
  override async setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.patchDomain(domainName, { privacy: enabled }, opts);
  }

  // confirm a domain exists in the account (registrar domains are keyed by name)
  private async findDomain(domainName: string, opts?: RequestOptions): Promise<CfDomain | null> {
    const res = await this.http.request<CfEnvelope<CfDomain[]>>({
      path: this.accountPath,
      query: { name: domainName },
      ...opts,
    });
    return res.result?.find(d => d.name === domainName) ?? null;
  }

  // confirm the domain exists then PUT the given fields (registrar API is name-keyed)
  private async patchDomain(
    domainName: string,
    body: Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const domain = await this.findDomain(domainName, opts);
      if (!domain) return { success: false, message: 'Domain not found' };

      const res = await this.http.request<CfEnvelope<CfDomain>>({
        method: 'PUT',
        path: `${this.accountPath}/${encodeURIComponent(domainName)}`,
        body,
        ...opts,
      });
      return {
        success: res.success,
        message: res.success ? 'Domain updated successfully' : 'Failed to update domain',
      };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }
}

// map a Cloudflare DNS record to the generic DnsRecord shape. `content` holds
// the value for every type; MX/SRV carry a `priority`, and SRV's weight/port
// live on the nested `data` object.
function toDnsRecord(r: CfDnsRecord): DnsRecord {
  const type = r.type.toUpperCase();
  const record: DnsRecord = { type, name: r.name, value: r.content ?? '' };
  if (r.ttl != null) record.ttl = r.ttl;
  const priority = r.priority ?? r.data?.priority;
  if ((type === 'MX' || type === 'SRV') && priority != null) record.priority = priority;
  if (type === 'SRV') {
    if (r.data?.weight != null) record.weight = r.data.weight;
    if (r.data?.port != null) record.port = r.data.port;
  }
  return record;
}

// resolve a DnsRecord name (relative, "@" apex, or already a FQDN) to the
// fully-qualified name Cloudflare's DNS API expects.
function toFqdn(name: string, zoneName: string): string {
  const n = (name ?? '').replace(/\.$/, '');
  const zone = zoneName.replace(/\.$/, '');
  if (n === '' || n === '@' || n === zone) return zone;
  if (n.endsWith(`.${zone}`)) return n;
  return `${n}.${zone}`;
}

// map a normalized DnsRecord to a Cloudflare dns_records create body. `content`
// holds the value for every type except SRV, whose priority/weight/port/target
// go on the nested `data` object (Cloudflare derives service/proto from `name`).
function toCfDnsBody(record: DnsRecord, type: string, name: string): Record<string, unknown> {
  if (type === 'SRV') {
    const body: Record<string, unknown> = {
      type,
      name,
      data: {
        priority: record.priority ?? 0,
        weight: record.weight ?? 0,
        port: record.port ?? 0,
        target: record.value,
      },
    };
    if (record.ttl != null) body.ttl = record.ttl;
    return body;
  }
  const body: Record<string, unknown> = { type, name, content: record.value };
  if (record.ttl != null) body.ttl = record.ttl;
  if (type === 'MX') body.priority = record.priority ?? 0;
  return body;
}

// parse a Cloudflare price string (major currency units, e.g. "11.20") to a
// number, or undefined when absent/unparseable.
function toPrice(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// map the library's Contact to Cloudflare's registrant shape (email/phone plus a
// nested postal_info.address). Cloudflare joins first + last into a single name.
function toCfRegistrant(c: Contact): Record<string, unknown> {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
  const street = [c.address1, c.address2].filter(Boolean).join(', ');
  const postal: Record<string, unknown> = {
    name,
    address: {
      street,
      city: c.city,
      state: c.state,
      postal_code: c.postalCode,
      country_code: c.country,
    },
  };
  if (c.organization) postal.organization = c.organization;
  return { email: c.email, phone: c.phone, postal_info: postal };
}

// resolve after `ms` milliseconds, rejecting early if `signal` aborts. Used to
// space out registration status polls. Browser/edge-safe (setTimeout only).
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    if (signal?.aborted) return fail();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        fail();
      },
      { once: true }
    );
  });
}

// map a Cloudflare WHOIS contact to the normalized Contact shape. Optional
// fields are set only when non-empty (Cloudflare returns "" for absent values).
function toContact(c: CfContact): Contact {
  const contact: Contact = {
    firstName: c.first_name ?? '',
    lastName: c.last_name ?? '',
    email: c.email ?? '',
    phone: c.phone ?? '',
    address1: c.address ?? '',
    city: c.city ?? '',
    postalCode: c.zip ?? '',
    country: c.country ?? '',
  };
  if (c.organization) contact.organization = c.organization;
  if (c.fax) contact.fax = c.fax;
  if (c.address2) contact.address2 = c.address2;
  if (c.state) contact.state = c.state;
  return contact;
}

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
  DsRecord,
  EmailForward,
  ListDomainsOptions,
  OperationResult,
  RegisterDomainInput,
  RegistrarOptions,
  RequestOptions,
  TldPricing,
  TransferDomainInput,
} from '../types';
import { createDomain, filterDomains } from '../utils';
import { toRegistrarError } from '../errors';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import { Feature, type RegistrarFeature } from '../features';
import type { RegistrarCredentials } from '../types';

// A contact as returned under `GET /v5/domain/domains/{fqdn}/contacts` (and
// nested in the domain-detail `contacts` object). Gandi names fields `given`/
// `family`/`streetaddr`/`zip`; privacy is `data_obfuscated` on the detail
// endpoint (older responses carried `extra_parameters.whois_privacy`).
interface GandiContact {
  given?: string;
  family?: string;
  orgname?: string;
  email?: string;
  phone?: string;
  fax?: string;
  streetaddr?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  data_obfuscated?: boolean;
  extra_parameters?: { whois_privacy?: string };
}

// the four contact roles Gandi exposes; `bill` maps to our `billing`
interface GandiContacts {
  owner?: GandiContact;
  admin?: GandiContact;
  tech?: GandiContact;
  bill?: GandiContact;
}

// Shape of a domain in `GET /v5/domain/domains` (list) and
// `GET /v5/domain/domains/{fqdn}` (detail). `status` is an array of EPP
// statuses; `autorenew` may be a bare boolean or an object; nameservers arrive
// as `nameserver.hosts` on the list endpoint and as a top-level `nameservers`
// array on the detail endpoint.
interface GandiDomain {
  fqdn: string;
  status?: string | string[];
  dates?: {
    created_at?: string;
    registry_created_at?: string;
    registry_ends_at?: string;
    updated_at?: string;
  };
  autorenew?: boolean | { enabled?: boolean };
  contacts?: GandiContacts;
  nameserver?: { current?: string; hosts?: string[] };
  nameservers?: string[];
}

// one record set from `GET /v5/livedns/domains/{fqdn}/records`; a set can hold
// multiple values (e.g. several A records for one name), flattened on read.
interface GandiRecord {
  rrset_type?: string;
  rrset_name?: string;
  rrset_ttl?: number;
  rrset_values?: string[];
}

// a single price entry within a pricing/check product
interface GandiPrice {
  min_duration?: number;
  max_duration?: number;
  duration_unit?: string;
  price_before_taxes?: number;
  price_after_taxes?: number;
  type?: string;
  discount?: boolean;
}

// a product in `GET /v5/billing/price/domain` and `GET /v5/domain/check`. Each product
// carries the `process` (create/renew/transfer) its `prices` apply to; `check`
// products also carry availability `status`.
interface GandiProduct {
  name?: string;
  status?: string;
  process?: string;
  prices?: GandiPrice[];
}

// envelope shared by the pricing and check endpoints
interface GandiPricingResponse {
  currency?: string;
  grid?: string;
  products?: GandiProduct[];
}

// a DNSSEC key from GET /v5/livedns/domains/{fqdn}/keys. `ds` is the full DS
// RR line ("<owner> <ttl> IN DS <keyTag> <algorithm> <digestType> <digest>").
interface GandiKey {
  id?: string;
  deleted?: boolean;
  flags?: number;
  algorithm?: number;
  ds?: string;
}

// an email forward from GET /v5/email/forwards/{domain}: `source` is the local
// part (mailbox), `destinations` the full addresses it forwards to.
interface GandiForward {
  source?: string;
  destinations?: string[];
}

// a web-forwarding (URL redirect) entry from GET
// /v5/domain/domains/{fqdn}/webredirs. `host` is the full FQDN of the source
// subdomain; `type` is Gandi's redirect kind (http301/http302/cloak).
interface GandiWebredir {
  host?: string;
  type?: string;
  url?: string;
  protocol?: string;
}

// map our DomainForwardType to Gandi's webredir `type`, and back.
const GANDI_FORWARD_TYPE: Record<DomainForwardType, string> = {
  permanent: 'http301',
  redirect: 'http302',
  frame: 'cloak',
};
const GANDI_TYPE_TO_FORWARD: Record<string, DomainForwardType> = {
  http301: 'permanent',
  http302: 'redirect',
  cloak: 'frame',
};

/**
 * Gandi.net Registrar
 * API docs: https://api.gandi.net/docs/
 *
 * Credentials: generate a Personal Access Token (PAT) under Account Settings >
 * Security. The token must have domain management permissions. It is sent as a
 * `Bearer` Authorization header. (Gandi's legacy `Apikey` scheme is deprecated
 * and now returns 403.)
 */
export class GandiRegistrar extends BaseRegistrar {
  readonly name = 'gandi';

  static readonly displayName = 'Gandi.net';
  static readonly helpText =
    'Generate a Personal Access Token (PAT) in your Gandi account under Account ' +
    'Settings > Security. The token needs permission to manage domains. (Gandi has ' +
    'deprecated the legacy API Key; use a PAT.)';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'Personal Access Token', type: 'password', required: true },
  ];
  // Gandi's v5 API offers a sandbox at api.sandbox.gandi.net (separate account)
  static readonly supportsSandbox = true;
  // On top of core: transfer-out auth code (`authinfo`), DNSSEC read/disable
  // (LiveDNS keys), email forwarding, and web/URL forwarding (webredirs;
  // per-subdomain, no apex). Note core `setPrivacy` disabling is a no-op for
  // individual (natural-person) registrants — Gandi keeps WHOIS obfuscation on
  // for GDPR regardless of the request.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.GetAuthCode,
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
        baseUrl: selectBaseUrl('Gandi', options?.environment, {
          production: 'https://api.gandi.net/v5',
          sandbox: 'https://api.sandbox.gandi.net/v5',
        }),
        headers: {
          'Authorization': `Bearer ${credentials.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
      options
    );
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      await this.http.request<GandiDomain[]>({ path: '/domain/domains', ...opts });
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const { search, ...reqOpts } = opts ?? {};
    const domains: Domain[] = [];
    const perPage = 1000; // Gandi API maximum page size
    // Gandi's `fqdn` filter is server-side and supports wildcards, so a plain
    // substring search is wrapped in `*...*`.
    const term = search?.trim();
    const fqdn = term ? `*${term}*` : undefined;
    let page = 1;

    for (;;) {
      const list = await this.http.request<GandiDomain[]>({
        path: '/domain/domains',
        query: { per_page: perPage, page, ...(fqdn ? { fqdn } : {}) },
        ...reqOpts,
      });
      if (!list || list.length === 0) break;

      for (const d of list) domains.push(this.toDomain(d));

      if (list.length < perPage) break;
      page++;
    }
    return filterDomains(domains, search);
  }

  // map Gandi's list/detail domain shape into a normalized Domain, tolerating
  // the field variations documented on GandiDomain.
  private toDomain(d: GandiDomain): Domain {
    const statuses = Array.isArray(d.status) ? d.status : d.status ? [d.status] : [];
    const autoRenew =
      typeof d.autorenew === 'boolean' ? d.autorenew : (d.autorenew?.enabled ?? false);
    return createDomain({
      domainName: d.fqdn,
      registrar: this.name,
      status: statuses.join(','),
      createdDate: d.dates?.created_at ?? d.dates?.registry_created_at,
      expirationDate: d.dates?.registry_ends_at,
      renewalDate: d.dates?.updated_at,
      autoRenew,
      locked: statuses.some(s => /transferprohibited|locked/i.test(s)),
      privacy:
        d.contacts?.owner?.extra_parameters?.whois_privacy === 'enabled' ||
        d.contacts?.owner?.data_obfuscated === true,
      nameservers: d.nameserver?.hosts ?? d.nameservers ?? [],
    });
  }

  // fetch a single domain's details (dates, status, nameservers, privacy) via
  // `GET /v5/domain/domains/{fqdn}` and normalize through the shared toDomain.
  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    const d = await this.http.request<GandiDomain>({
      path: `/domain/domains/${domainName}`,
      ...opts,
    });
    return this.toDomain({ ...d, fqdn: d.fqdn ?? domainName });
  }

  // read the nameservers set on a domain. The dedicated endpoint returns a bare
  // JSON array of hostname strings.
  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    const res = await this.http.request<string[]>({
      path: `/domain/domains/${domainName}/nameservers`,
      ...opts,
    });
    return Array.isArray(res) ? res.map(String) : [];
  }

  // read the registrant/admin/tech/billing contacts. Gandi keys these
  // owner/admin/tech/bill; `owner` is the registrant and `bill` the billing role.
  override async getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    const res = await this.http.request<GandiContacts>({
      path: `/domain/domains/${domainName}/contacts`,
      ...opts,
    });
    return {
      registrant: fromGandiContact(res.owner),
      admin: fromGandiContact(res.admin),
      tech: fromGandiContact(res.tech),
      billing: fromGandiContact(res.bill),
    };
  }

  /**
   * Read DNS records from LiveDNS (`GET /v5/livedns/domains/{fqdn}/records`).
   * A LiveDNS record set carries an array of values, so each value is emitted as
   * its own normalized DnsRecord. MX values are "priority target" and SRV values
   * "priority weight port target"; those numeric prefixes are split into the
   * dedicated DnsRecord fields, leaving `value` as the target.
   */
  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const rrsets = await this.http.request<GandiRecord[]>({
      path: `/livedns/domains/${domainName}/records`,
      ...opts,
    });
    const records: DnsRecord[] = [];
    for (const rr of rrsets ?? []) {
      const type = (rr.rrset_type ?? '').toUpperCase();
      const name = rr.rrset_name ?? '';
      for (const value of rr.rrset_values ?? []) {
        const record: DnsRecord = { type, name, value };
        if (rr.rrset_ttl != null) record.ttl = rr.rrset_ttl;
        if (type === 'MX') {
          const [priority, ...rest] = value.split(/\s+/);
          const p = Number(priority);
          if (Number.isFinite(p) && rest.length > 0) {
            record.priority = p;
            record.value = rest.join(' ');
          }
        } else if (type === 'SRV') {
          const parts = value.split(/\s+/);
          if (parts.length === 4) {
            record.priority = Number(parts[0]);
            record.weight = Number(parts[1]);
            record.port = Number(parts[2]);
            record.value = parts[3];
          }
        }
        records.push(record);
      }
    }
    return records;
  }

  /**
   * Per-TLD pricing via `GET /v5/billing/price/domain`. `processes` is a repeatable
   * query param and each returned product is tagged with the `process` its prices
   * cover, so a single call fetches register/renew/transfer. A bare TLD is turned
   * into a sample fqdn (`example.<tld>`) since the endpoint keys off a domain
   * name. Gandi returns prices in major currency units already.
   */
  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    const tld = (
      tldOrDomain.includes('.') ? tldOrDomain.slice(tldOrDomain.indexOf('.') + 1) : tldOrDomain
    ).toLowerCase();
    const name = tldOrDomain.includes('.') ? tldOrDomain : `example.${tld}`;

    // `processes` must be repeated (create/renew/transfer); the query map can't
    // hold a repeated key, so the params are encoded directly into the path.
    const params = new URLSearchParams({ name });
    for (const process of ['create', 'renew', 'transfer']) {
      params.append('processes', process);
    }

    const resp = await this.http.request<GandiPricingResponse>({
      path: `/billing/price/domain?${params.toString()}`,
      ...opts,
    });
    const products = resp.products ?? [];
    const priceFor = (process: string): number | undefined =>
      pickPrice(products.find(p => p.process === process)?.prices?.[0]);

    return {
      tld,
      currency: resp.currency ?? 'USD',
      registration: priceFor('create'),
      renewal: priceFor('renew'),
      transfer: priceFor('transfer'),
    };
  }

  /**
   * Availability via `GET /v5/domain/check`, which checks a single name per call,
   * so multiple names are looped. The default `create` product carries the
   * availability `status` and registration price; a status of `available*` means
   * registrable, and a `premium` price type (or `*premium` status) flags premium
   * names.
   */
  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const results: DomainAvailability[] = [];
    for (const domainName of domainNames) {
      const resp = await this.http.request<GandiPricingResponse>({
        path: '/domain/check',
        query: { name: domainName },
        ...opts,
      });
      const products = resp.products ?? [];
      const product = products.find(p => p.process === 'create') ?? products[0];
      const status = product?.status ?? '';
      const price = product?.prices?.[0];
      const result: DomainAvailability = {
        domainName: product?.name ?? domainName,
        available: status.startsWith('available'),
        premium: status.includes('premium') || price?.type === 'premium',
      };
      const amount = pickPrice(price);
      if (amount != null) result.price = amount;
      if (resp.currency) result.currency = resp.currency;
      if (price?.duration_unit === 'y' && price.min_duration != null) {
        result.period = price.min_duration;
      }
      results.push(result);
    }
    return results;
  }

  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      { method: 'POST', path: `/domain/domains/${domainName}/renew`, body: { duration: years } },
      'Domain renewed successfully',
      opts
    );
  }

  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 1) {
      throw new Error('At least 1 nameserver is required');
    }
    return this.mutate(
      { method: 'PUT', path: `/domain/domains/${domainName}/nameservers`, body: { nameservers } },
      'Nameservers updated successfully',
      opts
    );
  }

  // The transfer lock lives on the domain's `/status` subresource and is toggled
  // with the `clientTransferProhibited` EPP flag (a boolean) — not by PATCHing a
  // `status` string on the domain object, which 404s. The change is asynchronous
  // (Gandi returns 202 "status change in progress"), so a read-back right after
  // may still show the old state briefly.
  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PATCH',
        path: `/domain/domains/${domainName}/status`,
        body: { clientTransferProhibited: true },
      },
      'Domain locked successfully',
      opts
    );
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PATCH',
        path: `/domain/domains/${domainName}/status`,
        body: { clientTransferProhibited: false },
      },
      'Domain unlocked successfully',
      opts
    );
  }

  // --- extended capabilities ---------------------------------------------

  // The transfer authorization (EPP) code is the `authinfo` field on the
  // domain-details endpoint (present for domains the account manages).
  override async getAuthCode(domainName: string, opts?: RequestOptions): Promise<string> {
    const d = await this.http.request<{ authinfo?: string }>({
      path: `/domain/domains/${domainName}`,
      ...opts,
    });
    return d.authinfo ?? '';
  }

  /**
   * DNSSEC status via Gandi LiveDNS keys (GET /livedns/domains/{fqdn}/keys). A
   * non-deleted key means DNSSEC is enabled; each key's `ds` field is the full DS
   * RR line, which we parse into keyTag/algorithm/digestType/digest.
   */
  override async getDnssec(domainName: string, opts?: RequestOptions): Promise<DnssecStatus> {
    const keys = await this.http.request<GandiKey[]>({
      path: `/livedns/domains/${domainName}/keys`,
      ...opts,
    });
    const active = (keys ?? []).filter(k => !k.deleted);
    const dsRecords = active.map(k => parseDsRecord(k.ds)).filter((d): d is DsRecord => d !== null);
    return { enabled: active.length > 0, dsRecords };
  }

  /**
   * Disable DNSSEC by deleting each LiveDNS key (Gandi has no single toggle —
   * removing the keys removes the DS records at the registry).
   */
  override async disableDnssec(
    domainName: string,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const keys = await this.http.request<GandiKey[]>({
        path: `/livedns/domains/${domainName}/keys`,
        ...opts,
      });
      for (const k of keys ?? []) {
        if (k.deleted || !k.id) continue;
        await this.http.request({
          method: 'DELETE',
          path: `/livedns/domains/${domainName}/keys/${encodeURIComponent(k.id)}`,
          ...opts,
        });
      }
      return { success: true, message: 'DNSSEC disabled successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  /**
   * Read email forwarding via GET /email/forwards/{domain}. A Gandi forward has a
   * `source` (local part) and multiple `destinations`; we expand each destination
   * into its own {alias, forwardTo} row.
   */
  override async getEmailForwarding(
    domainName: string,
    opts?: RequestOptions
  ): Promise<EmailForward[]> {
    const forwards = await this.http.request<GandiForward[]>({
      path: `/email/forwards/${domainName}`,
      ...opts,
    });
    const out: EmailForward[] = [];
    for (const f of forwards ?? []) {
      for (const dest of f.destinations ?? []) {
        if (f.source && dest) out.push({ alias: f.source, forwardTo: dest });
      }
    }
    return out;
  }

  /**
   * Replace email forwarding (full replace; empty clears). Gandi has no bulk
   * endpoint, so diff against the current forwards: group desired rows by source,
   * DELETE sources no longer wanted, PUT changed sources, POST new ones.
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
      const current = await this.http.request<GandiForward[]>({
        path: `/email/forwards/${domainName}`,
        ...opts,
      });
      const currentSources = new Set(
        (current ?? []).map(f => f.source).filter((s): s is string => !!s)
      );

      for (const source of currentSources) {
        if (!desired.has(source)) {
          await this.http.request({
            method: 'DELETE',
            path: `/email/forwards/${domainName}/${encodeURIComponent(source)}`,
            ...opts,
          });
        }
      }
      for (const [source, destinations] of desired) {
        if (currentSources.has(source)) {
          await this.http.request({
            method: 'PUT',
            path: `/email/forwards/${domainName}/${encodeURIComponent(source)}`,
            body: { destinations },
            ...opts,
          });
        } else {
          await this.http.request({
            method: 'POST',
            path: `/email/forwards/${domainName}`,
            body: { source, destinations },
            ...opts,
          });
        }
      }
      return { success: true, message: 'Email forwarding updated successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  /**
   * Read web/URL forwarding via GET /domain/domains/{fqdn}/webredirs. Gandi keys
   * each redirect by the full FQDN of the source subdomain; we normalize that back
   * to a host relative to the apex (e.g. `shop.example.com` -> `shop`).
   */
  override async getDomainForwarding(
    domainName: string,
    opts?: RequestOptions
  ): Promise<DomainForward[]> {
    const redirs = await this.http.request<GandiWebredir[]>({
      path: `/domain/domains/${domainName}/webredirs`,
      ...opts,
    });
    return (redirs ?? []).map(r => ({
      host: gandiFqdnToHost(r.host ?? domainName, domainName),
      url: r.url ?? '',
      type: GANDI_TYPE_TO_FORWARD[(r.type ?? '').toLowerCase()] ?? 'permanent',
    }));
  }

  /**
   * Replace web/URL forwarding (full replace; empty clears). Gandi's webredirs
   * endpoint has no update — only create (POST) and delete (DELETE by FQDN) — so
   * this diffs against the current set: delete entries that are gone or changed,
   * then create the desired ones that aren't already present identically.
   *
   * Gandi only supports forwarding a subdomain, not the apex; an apex host ("@")
   * throws rather than silently failing with a 500 from the API.
   */
  override async setDomainForwarding(
    domainName: string,
    forwards: DomainForward[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      for (const f of forwards) {
        if (!f.host || f.host === '@') {
          throw new Error(
            `${this.name}: web forwarding requires a subdomain host; Gandi cannot forward the apex ("@")`
          );
        }
      }
      const current = await this.getDomainForwarding(domainName, opts);
      const same = (a: DomainForward, b: DomainForward): boolean =>
        a.host === b.host && a.url === b.url && a.type === b.type;

      // delete current entries that are no longer wanted, or whose url/type changed
      for (const existing of current) {
        if (!forwards.some(f => same(f, existing))) {
          await this.http.request({
            method: 'DELETE',
            path: `/domain/domains/${domainName}/webredirs/${gandiHostToFqdn(existing.host, domainName)}`,
            ...opts,
          });
        }
      }
      // create desired entries that aren't already present identically
      for (const f of forwards) {
        if (!current.some(c => same(c, f))) {
          await this.http.request({
            method: 'POST',
            path: `/domain/domains/${domainName}/webredirs`,
            // `protocol` is intentionally omitted so Gandi applies its default
            // (http). Requesting `https` makes Gandi provision a Let's Encrypt
            // certificate for the source host, which our normalized model doesn't
            // express (and which the sandbox can't do — it 500s).
            body: {
              host: gandiHostToFqdn(f.host, domainName),
              type: GANDI_FORWARD_TYPE[f.type],
              url: f.url,
            },
            ...opts,
          });
        }
      }
      return { success: true, message: 'Domain forwarding updated successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      await this.http.request({
        method: 'PATCH',
        path: `/domain/domains/${domainName}/autorenew`,
        body: { enabled },
        ...opts,
      });
      return {
        success: true,
        message: `Auto-renew ${enabled ? 'enabled' : 'disabled'} successfully`,
      };
    } catch (error) {
      // Disabling auto-renew on a domain that never had an autorenew record
      // returns 400 "This product has no autorenew record". That state already
      // means auto-renew is off, so treat it as idempotent success.
      const message = toRegistrarError(error).message;
      if (!enabled && /no autorenew record/i.test(message)) {
        return { success: true, message: 'Auto-renew disabled successfully' };
      }
      return { success: false, message };
    }
  }

  /**
   * WHOIS privacy on Gandi is the per-contact `data_obfuscated` flag, toggled by
   * PATCHing the domain's owner contact. Enabling works; disabling is accepted
   * (HTTP 202) but is a **no-op for individual (natural-person) registrants** —
   * Gandi keeps their contact obfuscated in WHOIS for GDPR regardless. The
   * request is well-formed, so this reports the registrar's acceptance; whether
   * the state actually changes is governed by Gandi's policy for the contact
   * type. (Verified live against the sandbox.)
   */
  override async setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PATCH',
        path: `/domain/domains/${domainName}/contacts`,
        body: { owner: { data_obfuscated: enabled } },
      },
      `WHOIS privacy ${enabled ? 'enabled' : 'disabled'} successfully`,
      opts
    );
  }

  /**
   * Replaces the entire zone via LiveDNS (`PUT /livedns/domains/{d}/records`),
   * which takes `items` as grouped rrsets. Flat records are regrouped by
   * (name, type); MX/SRV values are re-encoded with their numeric prefixes — the
   * exact inverse of `getDnsRecords`, so a get→set round-trip is lossless.
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      {
        method: 'PUT',
        path: `/livedns/domains/${domainName}/records`,
        body: { items: toGandiRrsets(records) },
      },
      'DNS records updated successfully',
      opts
    );
  }

  /**
   * Updates contact roles by PATCHing the domain's contacts. Only supplied roles
   * are sent; `registrant` maps to Gandi's `owner`, `billing` to `bill`. A
   * registrant change can trigger registry verification — not exercised live.
   */
  override async updateContacts(
    domainName: string,
    contacts: ContactSet,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const body: GandiContacts = {};
    if (contacts.registrant) body.owner = toGandiContact(contacts.registrant);
    if (contacts.admin) body.admin = toGandiContact(contacts.admin);
    if (contacts.tech) body.tech = toGandiContact(contacts.tech);
    if (contacts.billing) body.bill = toGandiContact(contacts.billing);
    if (Object.keys(body).length === 0) {
      throw new Error(`${this.name}: updateContacts requires at least one contact role`);
    }
    return this.mutate(
      { method: 'PATCH', path: `/domain/domains/${domainName}/contacts`, body },
      'Contacts updated successfully',
      opts
    );
  }

  /**
   * Registers a domain via `POST /domain/domains`. Requires a registrant (Gandi's
   * `owner`); other roles fall back to it. `data_obfuscated` carries the privacy
   * choice. Spends real money; not exercised against a live account.
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
    const owner = toGandiContact(registrant);
    if (input.privacy != null) owner.data_obfuscated = input.privacy;
    const body: Record<string, unknown> = {
      fqdn: domainName,
      duration: input.years ?? 1,
      owner,
    };
    if (input.contacts.admin) body.admin = toGandiContact(input.contacts.admin);
    if (input.contacts.tech) body.tech = toGandiContact(input.contacts.tech);
    if (input.contacts.billing) body.bill = toGandiContact(input.contacts.billing);
    if (input.nameservers && input.nameservers.length > 0) body.nameservers = input.nameservers;
    return this.mutate(
      { method: 'POST', path: '/domain/domains', body },
      `Domain ${domainName} registered successfully`,
      opts
    );
  }

  /**
   * Transfers a domain in via `POST /domain/transferin/{d}` with the EPP auth code
   * (`authinfo`) and the new owner. Spends real money; not exercised against a
   * live account.
   */
  override async transferIn(
    domainName: string,
    input: TransferDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const registrant = input.contacts?.registrant;
    if (!registrant) {
      throw new Error(`${this.name}: transfer requires a registrant contact (Gandi's owner)`);
    }
    const owner = toGandiContact(registrant);
    if (input.privacy != null) owner.data_obfuscated = input.privacy;
    const body: Record<string, unknown> = {
      fqdn: domainName,
      authinfo: input.authCode,
      owner,
    };
    if (input.years != null) body.duration = input.years;
    return this.mutate(
      { method: 'POST', path: `/domain/transferin/${domainName}`, body },
      `Domain ${domainName} transfer requested successfully`,
      opts
    );
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

// map a Gandi contact into the normalized Contact shape. Gandi has no distinct
// second address line, so `address2` is left undefined.
// map the normalized Contact to Gandi's contact shape (given/family/streetaddr/…).
// `type` is Gandi's contact type: 1 (company) when an organization is set, else
// 0 (individual).
function toGandiContact(c: Contact): GandiContact & { type: number } {
  const contact: GandiContact & { type: number } = {
    given: c.firstName,
    family: c.lastName,
    email: c.email,
    phone: c.phone,
    streetaddr: c.address1,
    city: c.city,
    zip: c.postalCode,
    country: c.country,
    type: c.organization ? 1 : 0,
  };
  if (c.organization) contact.orgname = c.organization;
  if (c.fax) contact.fax = c.fax;
  if (c.state) contact.state = toGandiState(c.state, c.country);
  return contact;
}

// Gandi wants the ISO 3166-2 subdivision code for `state` (e.g. `US-CA`), and
// rejects a bare 2-letter code as "shorter than minimum length 4". The rest of
// the library stores just the subdivision (`CA`, `ENG`), so prefix it with the
// country to form the ISO 3166-2 code. A value that already contains a `-`
// (already `US-CA`) is left as-is.
function toGandiState(state: string, country: string): string {
  return country && !state.includes('-') ? `${country}-${state}` : state;
}

// regroup flat DnsRecords into Gandi LiveDNS rrsets (one per name+type, values
// collected). MX/SRV values are re-encoded with their numeric prefixes — the
// exact inverse of getDnsRecords — so a get→set round-trip reproduces the zone.
function toGandiRrsets(records: DnsRecord[]): GandiRecord[] {
  const groups = new Map<string, GandiRecord>();
  for (const r of records) {
    const type = r.type.toUpperCase();
    const name = r.name || '@';
    let value = r.value;
    if (type === 'MX' && r.priority != null) {
      value = `${r.priority} ${r.value}`;
    } else if (type === 'SRV') {
      value = `${r.priority ?? 0} ${r.weight ?? 0} ${r.port ?? 0} ${r.value}`;
    }
    const key = `${name} ${type}`;
    let rrset = groups.get(key);
    if (!rrset) {
      rrset = { rrset_name: name, rrset_type: type, rrset_values: [] };
      groups.set(key, rrset);
    }
    if (rrset.rrset_ttl == null && r.ttl != null) rrset.rrset_ttl = r.ttl;
    rrset.rrset_values!.push(value);
  }
  return [...groups.values()];
}

// Gandi webredirs are keyed by the full FQDN of the source subdomain, while our
// DomainForward.host is relative to the apex. These convert between the two.
function gandiHostToFqdn(host: string, domain: string): string {
  return !host || host === '@' ? domain : `${host}.${domain}`;
}
function gandiFqdnToHost(fqdn: string, domain: string): string {
  if (fqdn === domain) return '@';
  const suffix = `.${domain}`;
  return fqdn.endsWith(suffix) ? fqdn.slice(0, -suffix.length) : fqdn;
}

function fromGandiContact(c: GandiContact | undefined): Contact | undefined {
  if (!c) return undefined;
  return {
    firstName: c.given ?? '',
    lastName: c.family ?? '',
    organization: c.orgname ? String(c.orgname) : undefined,
    email: c.email ?? '',
    phone: c.phone ?? '',
    fax: c.fax ? String(c.fax) : undefined,
    address1: c.streetaddr ?? '',
    city: c.city ?? '',
    state: c.state ? String(c.state) : undefined,
    postalCode: c.zip ?? '',
    country: c.country ?? '',
  };
}

// pick a numeric price from a Gandi price entry, preferring the tax-inclusive
// amount. Gandi reports prices in major currency units (e.g. 15.5), so no
// cents-to-dollars conversion is needed.
function pickPrice(price: GandiPrice | undefined): number | undefined {
  if (!price) return undefined;
  const value = price.price_after_taxes ?? price.price_before_taxes;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// parse a DS resource-record line into its components. Gandi's `ds` field looks
// like "example.com. 3600 IN DS 50651 13 2 01CC01EE...". Returns null if it
// doesn't contain a DS record (e.g. a key with no published DS).
function parseDsRecord(ds: string | undefined): DsRecord | null {
  if (!ds) return null;
  const tokens = ds.trim().split(/\s+/);
  const i = tokens.findIndex(t => t.toUpperCase() === 'DS');
  const parts = i >= 0 ? tokens.slice(i + 1) : tokens;
  if (parts.length < 4) return null;
  const [keyTag, algorithm, digestType, ...digest] = parts;
  return {
    keyTag: Number(keyTag) || 0,
    algorithm: Number(algorithm) || 0,
    digestType: Number(digestType) || 0,
    digest: digest.join(''),
  };
}

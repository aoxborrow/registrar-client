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
  RegistrarOptions,
  RequestOptions,
  TldPricing,
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
  // Rich API on top of core: DNSSEC and glue records (LiveDNS), real hosted
  // mailboxes plus forwarding. Note core `setPrivacy` is automatic/GDPR-driven
  // on Gandi rather than a clean toggle — the method treats an already-correct
  // state as idempotent success.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [
    Feature.GetAuthCode,
    Feature.GetDnssec,
    Feature.DisableDnssec,
    Feature.GetEmailForwarding,
    Feature.SetEmailForwarding,
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

  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      { method: 'PATCH', path: `/domain/domains/${domainName}`, body: { status: 'locked' } },
      'Domain locked successfully',
      opts
    );
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      { method: 'PATCH', path: `/domain/domains/${domainName}`, body: { status: 'active' } },
      'Domain unlocked successfully',
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

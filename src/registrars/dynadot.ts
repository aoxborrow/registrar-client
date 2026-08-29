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
  EmailForward,
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

// --- RESTful v2 response shapes (snake_case; captured from the live API) ---

// the standard envelope: HTTP 200 with a `code` of 200 on success, otherwise an
// `error.description`. Signature/auth failures come back as real HTTP 4xx.
interface V2Envelope<T> {
  code?: number;
  message?: string;
  data?: T;
  error?: { code?: string; description?: string };
}

interface V2Nameserver {
  server_name?: string;
  ip_list?: string[];
}

// a DNS record under glue_info (record_value2 carries the MX priority)
interface V2DnsRecord {
  sub_host?: string;
  record_type?: string;
  record_value1?: string;
  record_value2?: string;
}

// the glue/DNS block: `glue_type` is NAME_SERVERS (external NS), DNS (Dynadot-
// hosted records), REGISTRAR_FORWARDING (URL redirect), or
// REGISTRAR_STEALTH_FORWARDING (framed/cloaked redirect). It also carries the
// per-domain email-forwarding settings inline.
interface V2GlueInfo {
  glue_type?: string;
  nameserver_list?: V2Nameserver[];
  dns_main_list?: V2DnsRecord[];
  dns_sub_list?: V2DnsRecord[];
  ttl?: string | number;
  // domain (URL) forwarding, present when glue_type is REGISTRAR_FORWARDING /
  // REGISTRAR_STEALTH_FORWARDING. `forward_type` reads back as
  // "permanently"/"temporarily"; stealth carries a `stealth_title` instead.
  forward_url?: string;
  forward_type?: string;
  stealth_title?: string;
  // email forwarding: `email_forward_type` reads back uppercase
  // (MTYPE_NONE/MTYPE_FORWARD/MTYPE_MX); aliases carry username -> destination.
  email_forward_type?: string;
  email_alias_list?: { username?: string; email?: string }[];
}

// one DNS-security record from GET .../dnssec. `algorithm` / `digest_type` read
// back as human labels with the numeric code in parentheses, e.g. "SHA-256 (2)".
interface V2DnssecInfo {
  key_tag?: string | number;
  algorithm?: string | number;
  digest_type?: string | number;
  digest?: string;
}

// Dynadot's default nameservers, used to switch a domain off URL forwarding
// (there is no dedicated "clear forwarding" endpoint).
const DYNADOT_DEFAULT_NS = ['ns1.dynadot.com', 'ns2.dynadot.com'];

interface V2DomainInfo {
  domain_name?: string;
  expiration_date?: number;
  registration_date?: number;
  glue_info?: V2GlueInfo;
  registrant_contact_id?: number;
  admin_contact_id?: number;
  technical_contact_id?: number;
  billing_contact_id?: number;
  locked?: string;
  privacy?: string;
  renew_option?: string;
  status?: string;
}

// a full contact record. Name is one combined field; phone/fax split into a
// country code + number.
interface V2Contact {
  contact_id?: number;
  organization?: string;
  name?: string;
  email?: string;
  phone_number?: string;
  phone_cc?: string | number;
  fax_number?: string;
  fax_cc?: string | number;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

interface V2Price {
  currency?: string;
  unit?: string; // e.g. "(price/1 year)"
  registration_price?: string;
  renewal_price?: string;
  transfer_price?: string;
  restore_price?: string;
}

interface V2SearchResult {
  domain_name?: string;
  available?: string; // "Yes" | "No"
  premium?: string; // "yes" | "no"
  price_list?: V2Price[];
}

// bulk_search is capped conservatively; the endpoint takes a comma-joined list
const SEARCH_BATCH_SIZE = 100;

// Dynadot DNS record types that map cleanly to our generic DnsRecord types.
// (Dynadot also has forward/stealth/email pseudo-records — those are forwarding
// features, not generic DNS, so they're excluded here.)
const SUPPORTED_DNS_TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA']);

/**
 * Dynadot Registrar
 * API docs: https://www.dynadot.com/domain/api-document
 *
 * Targets Dynadot's **RESTful v2 API** (`https://api.dynadot.com/restful/v2/…`).
 *
 * ## Authentication
 * Two credentials: an **API key** (the public identifier, sent as
 * `Authorization: Bearer <key>`) and an **API secret** (used only to sign
 * requests). Every request carries an `X-Signature` header — the Base64 HMAC-
 * SHA256, keyed by the secret, of:
 *
 *   `apiKey + "\n" + pathAndQuery + "\n" + "" + "\n" + body`
 *
 * The third component is the (optional) `X-Request-Id`; this client signs it as
 * an empty string and does not send the header. Signing uses Web Crypto
 * (`crypto.subtle`), so it stays browser/edge-safe.
 *
 * Enable both keys under Tools > API in a Dynadot account (the account must be
 * unlocked with API access enabled).
 *
 * ## Envelope
 * Responses are `{ code, message, data }`, with `code: 200` on success and an
 * `error.description` otherwise. Note Dynadot returns HTTP 200 even for logical
 * errors (a bad command, a missing domain) — only auth/signature failures are
 * real HTTP 4xx — so success is read from the envelope `code`, not the status.
 *
 * ## Verification
 * Every method's path and payload is verified against a live account. Reads
 * (`testConnection`, `listDomains`, `getDomain`, `getNameservers`,
 * `getContacts`, `getDnsRecords`, `checkAvailability`, `getPricing`) were run
 * against the production account; all writes (`registerDomain`, `transferIn`,
 * `renewDomain`, `setAutoRenew`, `updateNameservers`, `lockDomain`/
 * `unlockDomain`, `setPrivacy`, `setDnsRecords`) were exercised end-to-end in the
 * Dynadot sandbox (`api-sandbox.dynadot.com`), which mirrors the API.
 */
export class DynadotRegistrar extends BaseRegistrar {
  readonly name = 'dynadot';

  static readonly displayName = 'Dynadot';
  static readonly helpText =
    'Under Tools > API in your Dynadot account, generate an API Key and API Secret. ' +
    'The account must be unlocked with API access enabled. The key identifies you; ' +
    'the secret signs requests (X-Signature) and is never sent directly.';
  static readonly configFields: ConfigField[] = [
    { name: 'apiKey', label: 'API Key', type: 'password', required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', required: true },
  ];
  static readonly supportsSandbox = true; // api-sandbox.dynadot.com mirrors the API
  // On top of core: transfer-out auth code, DNSSEC read/disable, and email +
  // domain (URL) forwarding. All implemented on the v2 transport and verified in
  // the Dynadot sandbox.
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
        // baseUrl is the host; each request builds the full /restful/v2/… path
        baseUrl: selectBaseUrl('Dynadot', options?.environment, {
          production: 'https://api.dynadot.com',
          sandbox: 'https://api-sandbox.dynadot.com',
        }),
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
      },
      options
    );
  }

  // sign and issue a request. `pathAndQuery` is the exact request target
  // (path + any query), used verbatim both to sign and to send so the two match.
  private async signedRequest<T>(
    method: string,
    pathAndQuery: string,
    body?: unknown,
    opts?: RequestOptions
  ): Promise<V2Envelope<T>> {
    const bodyStr = body !== undefined ? JSON.stringify(body) : '';
    const stringToSign = `${this.credentials.apiKey}\n${pathAndQuery}\n\n${bodyStr}`;
    const signature = await hmacSha256Base64(this.credentials.apiSecret, stringToSign);
    return this.http.request<V2Envelope<T>>({
      method,
      path: pathAndQuery,
      body,
      // Dynadot requires application/json even on bodyless mutations (e.g. the
      // DELETE for disableDnssec), so set it explicitly rather than relying on
      // the client's body-present default.
      headers: { 'X-Signature': signature, 'Content-Type': 'application/json' },
      ...opts,
    });
  }

  // issue a request and return its `data`, throwing on a non-2xx envelope code
  private async read<T>(
    method: string,
    pathAndQuery: string,
    body?: unknown,
    opts?: RequestOptions
  ): Promise<T> {
    const env = await this.signedRequest<T>(method, pathAndQuery, body, opts);
    if (!isOk(env.code)) {
      throw new Error(env.error?.description ?? env.message ?? 'Dynadot request failed');
    }
    return env.data as T;
  }

  // issue a mutating request and map its envelope to an OperationResult. The
  // envelope `code` mirrors the HTTP status, so success spans 2xx (register is
  // 200, transfer_in is 202 Accepted).
  private async mutate(
    method: string,
    pathAndQuery: string,
    body: unknown,
    successMessage: string,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    try {
      const env = await this.signedRequest<unknown>(method, pathAndQuery, body, opts);
      const ok = isOk(env.code);
      return {
        success: ok,
        message: ok ? successMessage : (env.error?.description ?? env.message ?? 'Request failed'),
      };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      await this.read<{ account_info?: unknown }>(
        'GET',
        '/restful/v2/accounts/info',
        undefined,
        opts
      );
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    // GET /domains returns the whole account in one response, nameservers inline.
    const { search, ...reqOpts } = opts ?? {};
    const data = await this.read<{ domain_info_list?: V2DomainInfo[] }>(
      'GET',
      '/restful/v2/domains',
      undefined,
      reqOpts
    );
    const domains = (data.domain_info_list ?? []).map(info => this.toDomain(info));
    return filterDomains(domains, search);
  }

  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    return this.toDomain(await this.domainInfo(domainName, opts));
  }

  // fetch and unwrap GET /domains/{name} -> data.domain_info (shared by getDomain,
  // getContacts, and the forwarding reads, which all read from domain_info)
  private async domainInfo(domainName: string, opts?: RequestOptions): Promise<V2DomainInfo> {
    const data = await this.read<{ domain_info?: V2DomainInfo }>(
      'GET',
      `/restful/v2/domains/${encodeURIComponent(domainName)}`,
      undefined,
      opts
    );
    if (!data.domain_info) throw new NotFoundError(`Dynadot: domain '${domainName}' not found`);
    return data.domain_info;
  }

  override async getNameservers(domainName: string, opts?: RequestOptions): Promise<string[]> {
    // domain_info carries the nameservers inline (empty for Dynadot-DNS-hosted
    // domains, which have no external NS)
    const domain = await this.getDomain(domainName, opts);
    return domain.nameservers;
  }

  /**
   * Reads registrant/admin/tech/billing contacts. domain_info carries a numeric
   * contact id per role; this resolves each distinct id via GET /contacts/{id}
   * (roles usually share one contact, so ids are de-duplicated).
   */
  override async getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    const info = await this.domainInfo(domainName, opts);

    const roleIds: [keyof ContactSet, string][] = [
      ['registrant', str(info.registrant_contact_id)],
      ['admin', str(info.admin_contact_id)],
      ['tech', str(info.technical_contact_id)],
      ['billing', str(info.billing_contact_id)],
    ];

    const byId = new Map<string, Contact>();
    for (const [, id] of roleIds) {
      if (!id || id === '0' || byId.has(id)) continue;
      const cdata = await this.read<{ contact?: V2Contact }>(
        'GET',
        `/restful/v2/contacts/${encodeURIComponent(id)}`,
        undefined,
        opts
      );
      if (cdata.contact) byId.set(id, toContact(cdata.contact));
    }

    const contacts: ContactSet = {};
    for (const [role, id] of roleIds) {
      const contact = byId.get(id);
      if (contact) contacts[role] = contact;
    }
    return contacts;
  }

  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    const data = await this.read<{ glue_info?: V2GlueInfo }>(
      'GET',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/records`,
      undefined,
      opts
    );
    const glue = data.glue_info ?? {};
    // only Dynadot-hosted DNS has records; NAME_SERVERS / forwarding domains have none
    if (glue.glue_type !== 'DNS') return [];
    const ttl = glue.ttl != null ? Number(glue.ttl) : undefined;
    return [
      ...(glue.dns_main_list ?? []).map(r => toDnsRecord(r, '@', ttl)),
      ...(glue.dns_sub_list ?? []).map(r => toDnsRecord(r, r.sub_host ?? '', ttl)),
    ];
  }

  /**
   * Availability via `bulk_search` (comma-joined `domain_name_list`), batched.
   * `show_price=true` returns a `price_list` per name; the first (1-year) entry's
   * registration price is surfaced.
   */
  override async checkAvailability(
    domainNames: string[],
    opts?: RequestOptions
  ): Promise<DomainAvailability[]> {
    const results: DomainAvailability[] = [];
    for (let i = 0; i < domainNames.length; i += SEARCH_BATCH_SIZE) {
      const batch = domainNames.slice(i, i + SEARCH_BATCH_SIZE);
      const list = encodeURIComponent(batch.join(','));
      const data = await this.read<{ domain_result_list?: V2SearchResult[] }>(
        'GET',
        `/restful/v2/domains/bulk_search?domain_name_list=${list}&show_price=true`,
        undefined,
        opts
      );
      for (const r of data.domain_result_list ?? []) {
        const price = oneYearPrice(r.price_list);
        results.push({
          domainName: r.domain_name ?? '',
          available: r.available === 'Yes',
          premium: r.premium != null ? r.premium.toLowerCase() === 'yes' : undefined,
          price: price?.registration,
          currency: price?.currency,
          period: price ? 1 : undefined,
        });
      }
    }
    return results;
  }

  /**
   * Pricing for a specific domain (may be premium), derived from a `bulk_search`
   * with pricing. Needs a full domain (e.g. "example.com"); a bare TLD throws,
   * since v2 has no standalone TLD-price endpoint.
   */
  override async getPricing(tldOrDomain: string, opts?: RequestOptions): Promise<TldPricing> {
    if (!tldOrDomain.includes('.')) {
      throw new NotImplementedError(
        `${this.name}: getPricing needs a full domain (e.g. "example.com"); ` +
          'Dynadot v2 has no standalone per-TLD price endpoint'
      );
    }
    const list = encodeURIComponent(tldOrDomain);
    const data = await this.read<{ domain_result_list?: V2SearchResult[] }>(
      'GET',
      `/restful/v2/domains/bulk_search?domain_name_list=${list}&show_price=true`,
      undefined,
      opts
    );
    const result = (data.domain_result_list ?? [])[0];
    const price = oneYearPrice(result?.price_list);
    const tld = tldOrDomain.slice(tldOrDomain.indexOf('.') + 1);
    return {
      tld,
      currency: price?.currency ?? 'USD',
      registration: price?.registration,
      renewal: price?.renewal,
      transfer: price?.transfer,
    };
  }

  // --- writes (paths + bodies verified against the Dynadot sandbox) ---

  /**
   * Registers a domain via POST /domains/{name}/register. The body nests the
   * order under a `domain` object; v2 uses the account's default WHOIS contacts,
   * so `input.contacts` is not sent. `privacy` maps to Dynadot's privacy level
   * ("full"/"off"). Spends real money in production.
   */
  override async registerDomain(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    requireConsent(this.name, input.consent);
    return this.mutate(
      'POST',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/register`,
      { domain: { duration: input.years ?? 1, privacy: input.privacy ? 'full' : 'off' } },
      `Domain ${domainName} registered successfully`,
      opts
    );
  }

  /**
   * Transfers a domain in with its auth/EPP code (nested under `domain`, like
   * register). Returns 202 Accepted on success. Contacts come from the account
   * default. Spends real money in production.
   */
  override async transferIn(
    domainName: string,
    input: TransferDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    requireConsent(this.name, input.consent);
    return this.mutate(
      'POST',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/transfer_in`,
      {
        domain: {
          auth_code: input.authCode,
          duration: input.years ?? 1,
          privacy: input.privacy ? 'full' : 'off',
        },
      },
      `Domain ${domainName} transfer requested successfully`,
      opts
    );
  }

  /**
   * Renews a domain. Dynadot's renew takes both the number of years (`duration`)
   * and the domain's current expiration `year` as a guard against double-renews,
   * so this reads the current expiration first.
   */
  override async renewDomain(
    domainName: string,
    years = 1,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const domain = await this.getDomain(domainName, opts);
    const year = domain.expirationDate?.getUTCFullYear();
    if (year == null) {
      return { success: false, message: `Dynadot: could not read ${domainName}'s expiration year` };
    }
    return this.mutate(
      'POST',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/renew`,
      { duration: years, year },
      'Domain renewed successfully',
      opts
    );
  }

  // Auto-renew via the renew_option endpoint. The accepted write values are
  // "auto" (auto-renew), "donot" (do not renew), and "reset" (manual renewal) —
  // note these differ from the read values ("auto-renew" etc.).
  override async setAutoRenew(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      'PUT',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/renew_option`,
      { renew_option: enabled ? 'auto' : 'donot' },
      `Auto-renew ${enabled ? 'enabled' : 'disabled'} successfully`,
      opts
    );
  }

  // Replace nameservers via PUT .../nameservers with a `nameserver_list` of
  // hostname strings.
  override async updateNameservers(
    domainName: string,
    nameservers: string[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (nameservers.length < 2 || nameservers.length > 13) {
      throw new Error('Dynadot requires 2-13 nameservers');
    }
    return this.mutate(
      'PUT',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/nameservers`,
      { nameserver_list: nameservers },
      'Nameservers updated successfully',
      opts
    );
  }

  // Transfer lock via PUT .../domain_lock with a boolean `lock`.
  override async lockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.setLock(domainName, true, opts);
  }

  override async unlockDomain(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.setLock(domainName, false, opts);
  }

  private setLock(
    domainName: string,
    locked: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      'PUT',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/domain_lock`,
      { lock: locked },
      `Domain ${locked ? 'locked' : 'unlocked'} successfully`,
      opts
    );
  }

  // WHOIS privacy via PUT .../privacy with a `privacy_level` of "full"/"off".
  override async setPrivacy(
    domainName: string,
    enabled: boolean,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    return this.mutate(
      'PUT',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/privacy`,
      { privacy_level: enabled ? 'full' : 'off' },
      `Privacy ${enabled ? 'enabled' : 'disabled'} successfully`,
      opts
    );
  }

  /**
   * Replaces the DNS record set via POST /domains/{name}/records. Records split
   * into apex ("main") and subdomain lists, mirroring the read shape; MX priority
   * rides in record_value2. Only generic DNS types are supported. Verified live
   * (add/restore round-trip): the body is accepted and non-forwarding records are
   * fully replaced.
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const mainList: V2DnsRecord[] = [];
    const subList: V2DnsRecord[] = [];
    let ttl: number | undefined;

    for (const r of records) {
      const type = r.type.toUpperCase();
      if (!SUPPORTED_DNS_TYPES.has(type)) {
        throw new Error(`Dynadot: DNS record type '${type}' is not supported`);
      }
      if (ttl == null && r.ttl != null) ttl = r.ttl;
      const entry: V2DnsRecord = { record_type: type.toLowerCase(), record_value1: r.value };
      if (type === 'MX' && r.priority != null) entry.record_value2 = String(r.priority);

      const isApex = r.name === '@' || r.name === '' || r.name === domainName;
      if (isApex) {
        mainList.push(entry);
      } else {
        subList.push({ ...entry, sub_host: r.name });
      }
    }

    const glue: V2GlueInfo = { glue_type: 'DNS', dns_main_list: mainList, dns_sub_list: subList };
    if (ttl != null) glue.ttl = String(ttl);

    return this.mutate(
      'POST',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/records`,
      glue,
      'DNS records updated successfully',
      opts
    );
  }

  // --- extended capabilities ---------------------------------------------

  /**
   * The transfer authorization (EPP) code via GET .../transfer_auth_code. Reads
   * the current code (Dynadot can also mint a fresh one with `new_code=true`, not
   * used here to avoid a side effect on a read).
   */
  override async getAuthCode(domainName: string, opts?: RequestOptions): Promise<string> {
    const data = await this.read<{ auth_code?: string }>(
      'GET',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/transfer_auth_code`,
      undefined,
      opts
    );
    return data.auth_code ?? '';
  }

  /**
   * DNSSEC status via GET .../dnssec, which returns a list of DS records
   * (`dnssec_info_list`); a non-empty list means DNSSEC is enabled. `algorithm`
   * and `digest_type` come back as labels with the numeric code in parentheses
   * (e.g. "SHA-256 (2)"), so parse the code out.
   */
  override async getDnssec(domainName: string, opts?: RequestOptions): Promise<DnssecStatus> {
    const data = await this.read<{ dnssec_info_list?: V2DnssecInfo[] }>(
      'GET',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/dnssec`,
      undefined,
      opts
    );
    const list = data.dnssec_info_list ?? [];
    return {
      enabled: list.length > 0,
      dsRecords: list.map(d => ({
        keyTag: parseCode(d.key_tag),
        algorithm: parseCode(d.algorithm),
        digestType: parseCode(d.digest_type),
        digest: d.digest ?? '',
      })),
    };
  }

  // Disable DNSSEC via DELETE .../dnssec (removes the registrar's DS records).
  override disableDnssec(domainName: string, opts?: RequestOptions): Promise<OperationResult> {
    return this.mutate(
      'DELETE',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/dnssec`,
      undefined,
      'DNSSEC disabled successfully',
      opts
    );
  }

  /**
   * Read alias-style email forwarding from domain_info's inline `glue_info`
   * (Dynadot has no standalone endpoint). Only `MTYPE_FORWARD` carries redirect
   * aliases; MX-mode (`MTYPE_MX`) and none return no rules.
   */
  override async getEmailForwarding(
    domainName: string,
    opts?: RequestOptions
  ): Promise<EmailForward[]> {
    const glue = (await this.domainInfo(domainName, opts)).glue_info;
    if ((glue?.email_forward_type ?? '').toUpperCase() !== 'MTYPE_FORWARD') return [];
    return (glue?.email_alias_list ?? [])
      .map(a => ({ alias: a.username ?? '', forwardTo: a.email ?? '' }))
      .filter(f => f.alias && f.forwardTo);
  }

  /**
   * Replace email forwarding via PUT .../email_forwarding (full replace; an empty
   * list clears it with `mtype_none`). Requires the domain to use Dynadot DNS —
   * the API rejects it when the record is a CNAME.
   */
  override async setEmailForwarding(
    domainName: string,
    forwards: EmailForward[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const body =
      forwards.length === 0
        ? { email_forward_type: 'mtype_none', email_alias_list: [], email_exchange_list: [] }
        : {
            email_forward_type: 'mtype_forward',
            email_alias_list: forwards.map(f => ({ username: f.alias, email: f.forwardTo })),
            email_exchange_list: [],
          };
    return this.mutate(
      'PUT',
      `/restful/v2/domains/${encodeURIComponent(domainName)}/email_forwarding`,
      body,
      'Email forwarding updated successfully',
      opts
    );
  }

  /**
   * Read domain (URL) forwarding from domain_info's inline `glue_info`. Dynadot
   * forwards the whole domain, so this returns at most one rule at host "@":
   * REGISTRAR_FORWARDING is a 301/302 redirect (`forward_type`
   * permanently/temporarily), REGISTRAR_STEALTH_FORWARDING is a framed redirect.
   */
  override async getDomainForwarding(
    domainName: string,
    opts?: RequestOptions
  ): Promise<DomainForward[]> {
    const glue = (await this.domainInfo(domainName, opts)).glue_info;
    const type = (glue?.glue_type ?? '').toUpperCase();
    if (!glue?.forward_url) return [];
    if (type === 'REGISTRAR_STEALTH_FORWARDING') {
      return [{ host: '@', url: glue.forward_url, type: 'frame' }];
    }
    if (type === 'REGISTRAR_FORWARDING') {
      const temporary = (glue.forward_type ?? '').toLowerCase().startsWith('temp');
      return [{ host: '@', url: glue.forward_url, type: temporary ? 'redirect' : 'permanent' }];
    }
    return [];
  }

  /**
   * Set domain (URL) forwarding. Dynadot forwards the entire domain, so at most
   * one rule (host "@") is accepted: `frame` uses stealth forwarding, `redirect`/
   * `permanent` use standard forwarding (302 vs 301). An empty list clears
   * forwarding — Dynadot has no "off" for it, so we restore its default
   * nameservers, which is the neutral non-forwarding state.
   */
  override async setDomainForwarding(
    domainName: string,
    forwards: DomainForward[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const enc = encodeURIComponent(domainName);
    if (forwards.length === 0) {
      return this.mutate(
        'PUT',
        `/restful/v2/domains/${enc}/nameservers`,
        { nameserver_list: DYNADOT_DEFAULT_NS },
        'Domain forwarding cleared successfully',
        opts
      );
    }
    if (forwards.length > 1) {
      throw new Error('Dynadot forwards the whole domain; only a single "@" rule is supported');
    }
    const f = forwards[0];
    if (f.host && f.host !== '@') {
      throw new Error(
        'Dynadot forwards the whole domain; per-host forwarding is not supported (use host "@")'
      );
    }
    if (f.type === 'frame') {
      return this.mutate(
        'PUT',
        `/restful/v2/domains/${enc}/stealth_forwarding`,
        { stealth_url: f.url, stealth_title: '' },
        'Domain forwarding updated successfully',
        opts
      );
    }
    return this.mutate(
      'PUT',
      `/restful/v2/domains/${enc}/domain_forwarding`,
      { forward_url: f.url, is_temporary: f.type === 'redirect' },
      'Domain forwarding updated successfully',
      opts
    );
  }

  // map a v2 domain_info payload to the normalized Domain shape
  private toDomain(d: V2DomainInfo): Domain {
    return createDomain({
      domainName: d.domain_name,
      registrar: this.name,
      status: d.status ?? '',
      createdDate: d.registration_date ?? null,
      expirationDate: d.expiration_date ?? null,
      renewalDate: d.expiration_date ?? null,
      autoRenew: d.renew_option === 'auto-renew' || d.renew_option === 'auto',
      locked: d.locked === 'Yes',
      privacy: isPrivacyOn(d.privacy),
      nameservers: extractNameservers(d.glue_info),
    });
  }
}

// --- signing ---

// Base64-encoded HMAC-SHA256 of `message`, keyed by `secret` (UTF-8). Uses Web
// Crypto so it runs unchanged in browsers, edge runtimes, and Node.
async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  let binary = '';
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// --- mapping helpers ---

// whether a v2 envelope `code` (which mirrors the HTTP status) is a success —
// 2xx, so it covers 200 and transfer_in's 202 Accepted
function isOk(code: number | undefined): boolean {
  return code != null && code >= 200 && code < 300;
}

// map a v2 DNS record to the normalized DnsRecord shape
function toDnsRecord(r: V2DnsRecord, name: string, ttl: number | undefined): DnsRecord {
  const type = (r.record_type ?? '').toUpperCase();
  const record: DnsRecord = { type, name, value: r.record_value1 ?? '' };
  if (ttl != null) record.ttl = ttl;
  // MX priority (distance) rides in record_value2
  if (type === 'MX' && r.record_value2 != null && r.record_value2 !== '') {
    record.priority = Number(r.record_value2);
  }
  return record;
}

// map a v2 contact record to the normalized Contact shape
function toContact(c: V2Contact): Contact {
  const { firstName, lastName } = splitName(str(c.name));
  const contact: Contact = {
    firstName,
    lastName,
    email: str(c.email),
    phone: joinPhone(c.phone_cc, c.phone_number),
    address1: str(c.address1),
    city: str(c.city),
    postalCode: str(c.zip),
    country: str(c.country),
  };
  const organization = str(c.organization);
  if (organization) contact.organization = organization;
  const fax = joinPhone(c.fax_cc, c.fax_number);
  if (fax) contact.fax = fax;
  const address2 = str(c.address2);
  if (address2) contact.address2 = address2;
  const state = str(c.state);
  if (state) contact.state = state;
  return contact;
}

// whether a v2 privacy string denotes privacy being on. The API reports several
// values: "Full Privacy"/"Partial Privacy" (on) vs "Privacy Off"/"No Privacy"
// (off), so key off the level word rather than a simple prefix.
function isPrivacyOn(privacy: string | undefined): boolean {
  const p = (privacy ?? '').toLowerCase();
  if (!p || p.includes('off') || p.startsWith('no')) return false;
  return p.includes('full') || p.includes('partial') || p.includes('privacy');
}

// pick the 1-year price entry (falling back to the first), mapping to numbers
function oneYearPrice(
  prices: V2Price[] | undefined
): { currency?: string; registration?: number; renewal?: number; transfer?: number } | undefined {
  if (!prices?.length) return undefined;
  const oneYear = prices.find(p => /\b1\s*year\b/i.test(p.unit ?? '')) ?? prices[0];
  return {
    currency: oneYear.currency,
    registration: toNumber(oneYear.registration_price),
    renewal: toNumber(oneYear.renewal_price),
    transfer: toNumber(oneYear.transfer_price),
  };
}

// pull the external nameserver hostnames from a glue_info block
function extractNameservers(glue: V2GlueInfo | undefined): string[] {
  return (glue?.nameserver_list ?? []).map(ns => str(ns.server_name)).filter(Boolean);
}

// Dynadot stores a single combined name; split on the first space
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

// stringify a loosely-typed scalar, guarding against objects/arrays
function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

// parse a price string like "10.88" into a number, or undefined
function toNumber(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// Dynadot reports DNSSEC algorithm / digest-type as a label with the numeric
// code in parentheses, e.g. "SHA-256 (2)" or "RSA/SHA-256 (8)". Pull out the
// code; tolerate a bare number (key_tag) or numeric string too.
function parseCode(value: string | number | undefined): number {
  if (typeof value === 'number') return value;
  const paren = /\((\d+)\)/.exec(value ?? '');
  if (paren) return Number(paren[1]);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

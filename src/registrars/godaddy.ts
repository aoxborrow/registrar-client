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
  authCode?: string;
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

// --- v3 API shapes ---------------------------------------------------------
// The v3 "Domain Lifecycle Management" API models money, domains, DNS, and
// registration differently from v1. These interfaces cover only the fields we
// read/write.

// v3 "Simple Money": `value` is an integer in the currency's minor units
// (cents for USD/EUR, whole units for zero-decimal currencies like JPY).
interface GdV3Money {
  currencyCode?: string;
  value?: number;
}

interface GdV3TermPrice {
  period?: number;
  price?: GdV3Money;
  renewalPrice?: GdV3Money;
}

interface GdV3Availability {
  domain: string;
  available?: boolean;
  prices?: GdV3TermPrice[];
  inventory?: string; // e.g. "STANDARD" | "PREMIUM"
}

interface GdV3Domain {
  domain: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  renewBy?: string;
  autoRenew?: boolean;
  privacy?: boolean;
  transferLock?: boolean;
  nameServers?: string[];
}

interface GdV3Link {
  href: string;
  rel?: string;
}

interface GdV3DomainCollection {
  items?: GdV3Domain[];
  links?: GdV3Link[];
}

// one DNS record in a v3 zone; `recordId` is server-assigned and required to
// update/delete an individual record (v3 has no bulk replace).
interface GdV3DnsRecord {
  recordId?: string;
  name: string;
  type: string;
  data: string;
  ttl?: number;
  priority?: number;
  weight?: number;
  port?: number;
  service?: string;
  protocol?: string;
  flag?: number;
  tag?: string;
}

interface GdV3DnsRecordPage {
  items?: GdV3DnsRecord[];
  totalPages?: number;
  links?: GdV3Link[];
}

interface GdV3Fee {
  type: string;
  fee?: GdV3Money;
}

interface GdV3Agreement {
  agreementType: string;
  title?: string;
}

interface GdV3Quote {
  quoteToken?: string;
  requiredAgreements?: GdV3Agreement[];
  fees?: GdV3Fee[];
}

interface GdV3Registration {
  registrationId?: string;
  operationId?: string;
  status?: string;
}

interface GdV3Operation {
  operationId?: string;
  status?: string;
  error?: { code?: string; message?: string };
}

/**
 * GoDaddy Registrar
 * API docs: https://developer.godaddy.com/en/docs/api-users/domains
 *
 * GoDaddy runs two concurrent API surfaces and this provider is a hybrid:
 *
 *  - **v3** (Domain Lifecycle Management) — the modern surface, PAT/Bearer only.
 *    Covers discovery (availability/suggestions), registration (quote → execute),
 *    DNS records, nameservers, and list/get. It has **no** endpoints for the
 *    post-registration management operations.
 *  - **v1** — the legacy surface, accepts either a PAT or the deprecated
 *    `sso-key` credential. It's the only place renew, transfer, auto-renew,
 *    lock/unlock, privacy, and contact updates live, and the only surface OTE
 *    (the test environment) exposes — OTE has no v3.
 *
 * Routing (`useV3`): v3 is used only in production **with a PAT**. With an
 * sso-key, or against OTE/sandbox (which has no v3), every call falls back to
 * v1. The management operations above are always v1 regardless. This keeps the
 * full contract working in OTE (all-v1) while preferring v3 in production.
 *
 * Credentials: supply `apiToken` (a Personal Access Token) for production/v3, or
 * `apiKey` + `apiSecret` (an OTE Key/Secret) for sandbox testing. The auth
 * header is chosen automatically — `Bearer` when a token is present, else
 * `sso-key`.
 *
 * `registerDomain` / `transferIn` spend real money. In v3, register uses the
 * quote-then-execute flow (price-locked via `quoteToken`, agreements
 * acknowledged in the consent block); v3 takes the contact profile from the
 * account identity and derives `agreedBy` server-side, so only `consent` (the
 * agreement acknowledgement) is required. In v1 (OTE), register uses the legacy
 * purchase flow and requires `consent.agreedBy` = the consenting party's IP.
 * Callers omitting `consent` entirely get a `ConsentRequiredError`.
 */
export class GoDaddyRegistrar extends BaseRegistrar {
  readonly name = 'godaddy';

  static readonly displayName = 'GoDaddy';
  static readonly helpText =
    'Authenticate one of two ways. For production, create a Personal Access ' +
    'Token (PAT) at https://developer.godaddy.com and pass it as `apiToken` — ' +
    'this enables the modern v3 API. For sandbox testing, create OTE ' +
    '(test environment) keys and pass `apiKey` + `apiSecret` with ' +
    '{ environment: "sandbox" }; OTE only exposes the legacy v1 API. The ' +
    'sso-key (API Key/Secret) scheme is deprecated by GoDaddy in 2026.';
  static readonly configFields: ConfigField[] = [
    { name: 'apiToken', label: 'API Token (PAT)', type: 'password', required: false },
    { name: 'apiKey', label: 'API Key', type: 'password', required: false },
    { name: 'apiSecret', label: 'API Secret', type: 'password', required: false },
  ];
  // GoDaddy's OTE ("Operational Test Environment") is its sandbox
  static readonly supportsSandbox = true;
  // Beyond core: transfer-out auth code (the `authCode` field on the v1
  // domain-detail response). Domain forwarding is NOT reachable and was dropped:
  // the v1 /v1/domains/forwards routes now 404 ("no method to handle request"),
  // and the replacement lives under the reseller-only v2 /v2/customers/{id}/
  // domains/forwards, which returns 403 ACCESS_DENIED for non-"API Users"
  // accounts — verified live 2026-08-29. DNSSEC has no dedicated endpoint (DS
  // records go through the generic DNS API), and there's no glue-record, email,
  // or push-webhook API.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [Feature.GetAuthCode];

  // true → prefer the v3 API (production + PAT). false → all calls use v1
  // (sso-key auth, or OTE/sandbox where v3 does not exist).
  private readonly useV3: boolean;

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    const authHeader = GoDaddyRegistrar.authHeader(credentials);
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('GoDaddy', options?.environment, {
          production: 'https://api.godaddy.com',
          sandbox: 'https://api.ote-godaddy.com',
        }),
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      },
      options
    );
    // v3 requires a PAT and is not deployed to OTE, so only use it in production
    // when a token was supplied.
    this.useV3 = options?.environment !== 'sandbox' && !!credentials.apiToken;
  }

  // Choose the Authorization header: Bearer PAT if a token is supplied,
  // otherwise the legacy sso-key. Missing credentials produce a header that the
  // API rejects at request time (matching the other providers), rather than
  // throwing at construction.
  private static authHeader(credentials: RegistrarCredentials): string {
    if (credentials.apiToken) return `Bearer ${credentials.apiToken}`;
    return `sso-key ${credentials.apiKey ?? ''}:${credentials.apiSecret ?? ''}`;
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      if (this.useV3) {
        await this.http.request<GdV3DomainCollection>({
          path: '/v3/domains/domain-names',
          query: { pageSize: 1 },
          ...opts,
        });
      } else {
        await this.http.request<GoDaddyDomain[]>({ path: '/v1/domains', ...opts });
      }
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    const { search, ...reqOpts } = opts ?? {};
    const domains = this.useV3
      ? await this.listDomainsV3(reqOpts)
      : await this.listDomainsV1(reqOpts);
    return filterDomains(domains, search);
  }

  // v3: cursor-paginated collection; follow the rel="next" HATEOAS link.
  private async listDomainsV3(reqOpts: RequestOptions): Promise<Domain[]> {
    const domains: Domain[] = [];
    let path = '/v3/domains/domain-names';
    let query: Record<string, string | number> | undefined = { pageSize: 200 }; // v3 max
    for (;;) {
      const res = await this.http.request<GdV3DomainCollection>({ path, query, ...reqOpts });
      for (const d of res.items ?? []) domains.push(this.toDomainV3(d));
      const next = (res.links ?? []).find(l => l.rel === 'next')?.href;
      if (!next || !res.items?.length) break;
      path = next; // absolute URL; HttpClient passes it through as-is
      query = undefined; // the next link already carries its cursor
    }
    return domains;
  }

  // v1: `marker`-paginated array (marker = last domain name seen).
  private async listDomainsV1(reqOpts: RequestOptions): Promise<Domain[]> {
    // status filters exclude expired domains: visible (active), renewable
    // (expiring soon), redemption (grace period). statusGroups repeats in the
    // query string, so it is embedded in the path directly. `includes=nameServers`
    // folds nameservers into this list call (they are otherwise omitted). Its
    // page-size param is literally named `limit`, whose max is 1000.
    const statusGroups = 'statusGroups=VISIBLE&statusGroups=RENEWABLE&statusGroups=REDEMPTION';
    const perPage = 1000; // GoDaddy's maximum page size
    const domains: Domain[] = [];
    let marker: string | undefined;
    for (;;) {
      const markerParam = marker ? `&marker=${encodeURIComponent(marker)}` : '';
      const res = await this.http.request<GoDaddyDomain[]>({
        path: `/v1/domains?limit=${perPage}&includes=nameServers&${statusGroups}${markerParam}`,
        ...reqOpts,
      });
      const list = res ?? [];
      for (const d of list) domains.push(this.toDomain(d));
      if (list.length < perPage) break;
      marker = list[list.length - 1]?.domain;
      if (!marker) break;
    }
    return domains;
  }

  override async getDomain(domainName: string, opts?: RequestOptions): Promise<Domain> {
    if (this.useV3) {
      const d = await this.http.request<GdV3Domain>({
        path: `/v3/domains/domain-names/${encodeURIComponent(domainName)}`,
        ...opts,
      });
      return this.toDomainV3(d);
    }
    const d = await this.http.request<GoDaddyDomain>({
      path: `/v1/domains/${encodeURIComponent(domainName)}`,
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
    if (this.useV3) {
      // v3 bulk check: POST { domains: [...] }; the response wraps results in
      // `items` and prices are multi-term.
      const res = await this.http.request<{ items?: GdV3Availability[] }>({
        method: 'POST',
        path: '/v3/domains/check-availability',
        body: { domains: domainNames },
        ...opts,
      });
      return (res.items ?? []).map(d => {
        const term = pickTerm(d.prices);
        return {
          domainName: d.domain,
          available: d.available ?? false,
          premium: isPremiumInventory(d.inventory),
          price: moneyToMajor(term?.price),
          currency: term?.price?.currencyCode,
          period: term?.period,
        };
      });
    }
    // v1 bulk check: POST an array of domains. checkType=FULL consults the
    // registry (slower but authoritative) rather than GoDaddy's cache.
    const res = await this.http.request<GoDaddyAvailabilityResponse>({
      method: 'POST',
      path: '/v1/domains/available?checkType=FULL',
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
    const tld = tldOrDomain.slice(tldOrDomain.indexOf('.') + 1);
    if (this.useV3) {
      // v3 availability carries both registration and renewal price per term.
      const res = await this.http.request<{ items?: GdV3Availability[] }>({
        method: 'POST',
        path: '/v3/domains/check-availability',
        body: { domains: [tldOrDomain] },
        ...opts,
      });
      const term = pickTerm(res.items?.[0]?.prices);
      return {
        tld,
        currency: term?.price?.currencyCode ?? 'USD',
        registration: moneyToMajor(term?.price),
        renewal: moneyToMajor(term?.renewalPrice),
      };
    }
    const [result] = await this.checkAvailability([tldOrDomain], opts);
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
    if (this.useV3) return this.registerDomainV3(domainName, input, opts);
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
      { method: 'POST', path: '/v1/domains/purchase', body },
      `Domain ${domainName} registered successfully`,
      opts
    );
  }

  /**
   * v3 registration: quote-then-execute. First POST a quote for the domain/term
   * (price-locked via `quoteToken`, returns the agreements + fees to
   * acknowledge), then POST the registration with the token, a consent block
   * (acknowledging every required agreement + quoted fee), and the contact
   * profile. Registration is async (202), so poll the returned operation to
   * completion. Spends real money; there is no v3 sandbox, so this is
   * documented-but-unverified against a live purchase.
   */
  private async registerDomainV3(
    domainName: string,
    input: RegisterDomainInput,
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (!input.consent) {
      throw new ConsentRequiredError(
        `${this.name}: registration requires \`consent\` (accepting the registration agreements)`
      );
    }
    const period = input.years ?? 1;
    const quote = await this.http.request<GdV3Quote>({
      method: 'POST',
      path: '/v3/domains/registration-quotes',
      body: { domain: domainName, period },
      ...opts,
    });
    if (!quote.quoteToken) {
      throw new Error(`${this.name}: registration quote did not return a quoteToken`);
    }
    // v3 wants a MINIMAL body for a standard REGISTRY registration:
    // `{ domain, period, quoteToken, consent }`. Two hard-won gotchas:
    //  - No `profile` block. Sending one (even just autoRenew/privacy) is
    //    rejected `INVALID_BODY`. Contacts come from the account identity
    //    (the quote's `resolved.contactSource: "ACCOUNT"`), and autoRenew /
    //    nameservers are applied as post-registration steps below.
    //  - `acknowledgedFees` must be OMITTED unless the quote carried fees
    //    (the array is `minItems: 1`, so `[]` is rejected). `agreedBy` is
    //    resolved server-side from the token + caller IP, so it's not sent.
    const consent = {
      agreementTypes: (quote.requiredAgreements ?? []).map(a => a.agreementType),
      agreedAt: input.consent.agreedAt ?? new Date().toISOString(),
      ...(quote.fees && quote.fees.length ? { acknowledgedFees: quote.fees } : {}),
    };
    const body = { domain: domainName, period, quoteToken: quote.quoteToken, consent };
    try {
      const reg = await this.http.request<GdV3Registration>({
        method: 'POST',
        path: '/v3/domains/registrations',
        body,
        // v3 requires an Idempotency-Key on every execute endpoint; a retry
        // with the same key returns the original result instead of double-buying
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        ...opts,
      });
      if (reg.operationId) await this.pollOperation(reg.operationId, opts);
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
    // Post-registration: the minimal body can't carry these, so apply the
    // caller's intent now. GoDaddy registers with the account's default
    // auto-renew (typically ON), so always assert the requested value.
    const warnings: string[] = [];
    try {
      await this.setAutoRenew(domainName, input.autoRenew ?? false, opts);
    } catch (error) {
      warnings.push(`auto-renew not applied (${toRegistrarError(error).message})`);
    }
    if (input.nameservers) {
      try {
        await this.updateNameservers(domainName, input.nameservers, opts);
      } catch (error) {
        warnings.push(`nameservers not applied (${toRegistrarError(error).message})`);
      }
    }
    const suffix = warnings.length ? ` (registered, but ${warnings.join('; ')})` : '';
    return { success: true, message: `Domain ${domainName} registered successfully${suffix}` };
  }

  /**
   * Poll a v3 async operation until it leaves the pending states. GoDaddy
   * reports COMPLETED / SUCCESS on success and FAILED / ERROR (with an `error`
   * body) on failure; a failed operation throws.
   */
  private async pollOperation(
    operationId: string,
    opts?: RequestOptions,
    attempts = 10,
    delayMs = 1500
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const op = await this.http.request<GdV3Operation>({
        path: `/v3/domains/operations/${encodeURIComponent(operationId)}`,
        ...opts,
      });
      const status = (op.status ?? '').toUpperCase();
      if (status === 'COMPLETED' || status === 'SUCCESS' || status === 'SUCCEEDED') return;
      if (status === 'FAILED' || status === 'ERROR') {
        throw new Error(op.error?.message ?? `operation ${operationId} failed`);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    // still pending after the budget — treat as accepted; the caller can re-check
  }

  /**
   * Transfers a domain in with its auth code. GoDaddy's transfer body is much
   * smaller than a purchase — just the auth code + a `consent` block (fetched
   * with `forTransfer=true`, since transfer agreements can differ) + optional
   * period/renewAuto/privacy. No contacts: the existing registration's carry
   * over. v3 has no transfer endpoint, so this is always the v1 flow (which is
   * also what OTE exposes for testing).
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
      { method: 'POST', path: `/v1/domains/${encodeURIComponent(domainName)}/transfer`, body },
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
      path: '/v1/domains/agreements',
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
        path: `/v1/domains/${encodeURIComponent(domainName)}/renew`,
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
        path: `/v1/domains/${encodeURIComponent(domainName)}`,
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
    if (this.useV3) {
      // v3 replaces nameservers with a dedicated PUT; the body is a bare array.
      // Like /registrations, this execute endpoint requires an Idempotency-Key.
      return this.mutate(
        {
          method: 'PUT',
          path: `/v3/domains/domain-names/${encodeURIComponent(domainName)}/nameservers`,
          body: nameservers,
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        },
        'Nameservers updated successfully',
        opts
      );
    }
    return this.mutate(
      {
        method: 'PATCH',
        path: `/v1/domains/${encodeURIComponent(domainName)}`,
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
        path: `/v1/domains/${encodeURIComponent(domainName)}`,
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
        path: `/v1/domains/${encodeURIComponent(domainName)}`,
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
    const encoded = encodeURIComponent(domainName);
    try {
      await this.http.request({
        method: 'DELETE',
        path: `/v1/domains/${encoded}/privacy`,
        ...opts,
      });
      return { success: true, message: 'Privacy disabled successfully' };
    } catch (error) {
      const err = toRegistrarError(error);
      // GoDaddy's free privacy ("Free DBP") can't be canceled via DELETE — it
      // returns 409 CONFLICTING_STATUS. The only way to turn it off is to expose
      // the WHOIS via a domain PATCH (`exposeWhois: true`), but GoDaddy requires a
      // full legal consent block on that PATCH (`agreedAt` + `agreedBy` = the
      // consenting party's IP + `agreementKeys`) — the same consent as a
      // registration. setPrivacy can't carry that (and this client is edge-safe
      // with no reliable IP source), so surface a clear, actionable error instead
      // of silently failing. Paid DBP still cancels through the DELETE above.
      if (err.status === 409) {
        return {
          success: false,
          message:
            `${this.name}: this domain uses free WHOIS privacy (Free DBP), which the API ` +
            'only disables by exposing the WHOIS via a consent block (agreedAt + agreedBy IP ' +
            '+ agreementKeys) that setPrivacy cannot supply; disable it in the GoDaddy dashboard.',
        };
      }
      return { success: false, message: err.message };
    }
  }

  override async getContacts(domainName: string, opts?: RequestOptions): Promise<ContactSet> {
    // v3's domain record omits contacts, so read them from v1 in both modes.
    const d = await this.http.request<GoDaddyDomain>({
      path: `/v1/domains/${encodeURIComponent(domainName)}`,
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
      { method: 'PATCH', path: `/v1/domains/${encodeURIComponent(domainName)}/contacts`, body },
      'Contacts updated successfully',
      opts
    );
  }

  override async getDnsRecords(domainName: string, opts?: RequestOptions): Promise<DnsRecord[]> {
    if (this.useV3) {
      return (await this.getV3Records(domainName, opts)).map(fromV3Record);
    }
    const records = await this.http.request<GoDaddyRecord[]>({
      path: `/v1/domains/${encodeURIComponent(domainName)}/records`,
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
   * Replaces the entire record set (full-replace semantics): any record not
   * present in `records` is removed. GoDaddy requires a minimum TTL of 600
   * seconds, so records without an explicit TTL default to 3600.
   *
   * v1 does this in one bulk PUT. v3 has no bulk endpoint — only per-record
   * POST/PUT/DELETE — so the v3 path diffs the desired set against the current
   * one (keyed by type+name+value): delete records no longer wanted, add new
   * ones, and PUT matched records whose TTL/priority/etc. changed.
   */
  override async setDnsRecords(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    if (this.useV3) return this.setDnsRecordsV3(domainName, records, opts);
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
      { method: 'PUT', path: `/v1/domains/${encodeURIComponent(domainName)}/records`, body },
      'DNS records updated successfully',
      opts
    );
  }

  // Read every DNS record in a v3 zone, following pagination.
  private async getV3Records(domainName: string, opts?: RequestOptions): Promise<GdV3DnsRecord[]> {
    const zone = encodeURIComponent(domainName);
    const records: GdV3DnsRecord[] = [];
    let path: string | undefined = `/v3/domains/zones/${zone}/dns-records`;
    let query: Record<string, string | number> | undefined = { pageSize: 100 }; // v3 max
    while (path) {
      const page: GdV3DnsRecordPage = await this.http.request<GdV3DnsRecordPage>({
        path,
        query,
        ...opts,
      });
      for (const r of page.items ?? []) records.push(r);
      const next = (page.links ?? []).find(l => l.rel === 'next')?.href;
      path = next && page.items?.length ? next : undefined;
      query = undefined;
    }
    return records;
  }

  private async setDnsRecordsV3(
    domainName: string,
    records: DnsRecord[],
    opts?: RequestOptions
  ): Promise<OperationResult> {
    const zone = encodeURIComponent(domainName);
    const base = `/v3/domains/zones/${zone}/dns-records`;
    try {
      const current = await this.getV3Records(domainName, opts);
      const currentByKey = new Map(current.map(r => [dnsKeyV3(r), r]));
      const desired = records.map(toV3Record);
      const desiredKeys = new Set(desired.map(dnsKeyV3));

      // delete records that are no longer desired
      for (const r of current) {
        if (!desiredKeys.has(dnsKeyV3(r)) && r.recordId) {
          await this.http.request({
            method: 'DELETE',
            path: `${base}/${encodeURIComponent(r.recordId)}`,
            ...opts,
          });
        }
      }
      // add new records; update matched records whose fields changed
      for (const d of desired) {
        const existing = currentByKey.get(dnsKeyV3(d));
        if (!existing) {
          await this.http.request({ method: 'POST', path: base, body: d, ...opts });
        } else if (existing.recordId && dnsFieldsDiffer(existing, d)) {
          await this.http.request({
            method: 'PUT',
            path: `${base}/${encodeURIComponent(existing.recordId)}`,
            body: d,
            ...opts,
          });
        }
      }
      return { success: true, message: 'DNS records updated successfully' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  // --- extended capabilities ---------------------------------------------

  /**
   * Transfer authorization (EPP) code. GoDaddy exposes it as the `authCode`
   * field on the v1 domain-detail response; transfers were never moved to v3,
   * so this always reads from v1 regardless of the `useV3` routing. Returned
   * synchronously in the body — not email-only. The domain generally needs to
   * be unlocked and out of the 60-day post-registration/transfer lock for the
   * code to be usable for an outbound transfer.
   */
  override async getAuthCode(domainName: string, opts?: RequestOptions): Promise<string> {
    const d = await this.http.request<GoDaddyDomain>({
      path: `/v1/domains/${encodeURIComponent(domainName)}`,
      ...opts,
    });
    return d.authCode ?? '';
  }

  // map a v1 GoDaddy domain payload to the normalized Domain shape
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

  // map a v3 GoDaddy domain payload to the normalized Domain shape. v3 renames
  // several fields (transferLock → locked, renewBy → renewalDate, expiresAt →
  // expirationDate).
  private toDomainV3(d: GdV3Domain): Domain {
    return createDomain({
      domainName: d.domain,
      registrar: this.name,
      status: d.status,
      createdDate: d.createdAt,
      expirationDate: d.expiresAt,
      renewalDate: d.renewBy,
      autoRenew: d.autoRenew ?? false,
      locked: d.transferLock ?? false,
      privacy: d.privacy ?? false,
      nameservers: d.nameServers ?? [],
    });
  }

  private async mutate(
    req: { method: string; path: string; body?: unknown; headers?: Record<string, string> },
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

// --- v3 helpers ------------------------------------------------------------

// Pick the pricing term to report — prefer the 1-year term, else the first.
function pickTerm(prices?: GdV3TermPrice[]): GdV3TermPrice | undefined {
  if (!prices || prices.length === 0) return undefined;
  return prices.find(p => p.period === 1) ?? prices[0];
}

// Classify a v3 availability `inventory` value. Standard registry names report
// "REGISTRY" (or "STANDARD"); premium/aftermarket names report a PREMIUM-type
// value. Undefined when the field is absent.
function isPremiumInventory(inventory?: string): boolean | undefined {
  if (inventory == null) return undefined;
  return /PREMIUM/i.test(inventory);
}

// Convert v3 "Simple Money" (integer minor units) to major units. Assumes
// 2-decimal currencies (USD/EUR/…); zero-decimal currencies like JPY would need
// currency-aware scaling, but GoDaddy prices in USD by default.
function moneyToMajor(m?: GdV3Money): number | undefined {
  if (!m || m.value == null) return undefined;
  return m.value / 100;
}

// map a v3 DNS record to the normalized DnsRecord shape
function fromV3Record(r: GdV3DnsRecord): DnsRecord {
  return {
    type: r.type,
    name: r.name,
    value: r.data,
    ttl: r.ttl,
    priority: r.priority,
    weight: r.weight,
    port: r.port,
  };
}

// map a normalized DnsRecord to a v3 record body. GoDaddy requires a minimum
// TTL of 600s, so records without an explicit TTL default to 3600.
function toV3Record(r: DnsRecord): GdV3DnsRecord {
  const out: GdV3DnsRecord = {
    type: r.type.toUpperCase(),
    name: r.name || '@',
    data: r.value,
    ttl: r.ttl ?? 3600,
  };
  if (r.priority != null) out.priority = r.priority;
  if (r.weight != null) out.weight = r.weight;
  if (r.port != null) out.port = r.port;
  return out;
}

// identity of a record for full-replace diffing: type + name + value, joined by
// a unit-separator (U+001F) that can't appear in a hostname or record value —
// avoids collisions without embedding a NUL (which would make the file binary).
function dnsKeyV3(r: GdV3DnsRecord): string {
  return `${r.type.toUpperCase()}\u001f${r.name || '@'}\u001f${r.data}`;
}

// whether two records that share a key differ in a mutable field (TTL/priority/
// weight/port), meaning the existing one should be PUT-updated
function dnsFieldsDiffer(a: GdV3DnsRecord, b: GdV3DnsRecord): boolean {
  return (
    (a.ttl ?? 3600) !== (b.ttl ?? 3600) ||
    (a.priority ?? null) !== (b.priority ?? null) ||
    (a.weight ?? null) !== (b.weight ?? null) ||
    (a.port ?? null) !== (b.port ?? null)
  );
}

// NOTE: v3 registration takes contacts from the account identity (the quote's
// `resolved.contactSource: "ACCOUNT"`) and rejects a `profile.contacts` block,
// so there is no v3 contact mapper — see `registerDomainV3`. v1 uses
// `toGoDaddyContact` above.

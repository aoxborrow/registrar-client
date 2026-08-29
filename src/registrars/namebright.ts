import type {
  ConfigField,
  ConnectionResult,
  Domain,
  ListDomainsOptions,
  RegistrarOptions,
  RequestOptions,
} from '../types';
import { createDomain, filterDomains } from '../utils';
import { AuthenticationError, toRegistrarError } from '../errors';
import { BaseRegistrar, selectBaseUrl } from '../registrar';
import type { RegistrarFeature } from '../features';
import type { RegistrarCredentials } from '../types';
import type { RequestConfig } from '../http';

const TOKEN_URL = 'https://api.namebright.com/auth/token';

// response from the OAuth2 token endpoint
interface NbToken {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

// a domain record from GET account/domains. The list endpoint does not return
// nameservers (those come from account/domains/{domain}/nameservers).
interface NbDomain {
  DomainName?: string;
  domain?: string;
  Status?: string;
  ExpirationDate?: string;
  RegistrationDate?: string;
  AutoRenew?: boolean;
  Locked?: boolean;
  WhoIsPrivacy?: boolean;
}

// the paged wrapper GET account/domains returns
interface NbDomainsPage {
  ResultsTotal?: number;
  CurrentPage?: number;
  Domains?: NbDomain[];
  domains?: NbDomain[];
}

/**
 * NameBright Registrar
 * API docs: https://api.namebright.com/rest/Help
 *
 * Credentials: create an API Application at
 * https://my.namebright.com/my-account/api-management. Each application has a
 * name and an IP whitelist; NameBright issues a client secret. The OAuth2
 * `client_id` is formatted "<accountName>:<applicationName>".
 *
 * Auth: OAuth2 client-credentials. We POST to the token endpoint for a bearer
 * token (valid ~30 minutes), cache it, and send it as `Authorization: Bearer`
 * on each REST call.
 *
 * Only the read operations (testConnection, listDomains) are implemented here.
 * The write endpoints (renew, nameservers, lock/unlock — a shared
 * `PUT /account/domains/{domain}`) have request-body field names that could not
 * be confirmed from the public docs, so they are intentionally left as
 * NotImplementedError until verified against a live account.
 */
export class NameBrightRegistrar extends BaseRegistrar {
  readonly name = 'namebright';

  static readonly displayName = 'NameBright';
  static readonly helpText =
    'API access is not enabled by default — you must request it from NameBright ' +
    '(contact support / your account manager) before the API Management page is ' +
    'available. Once enabled, create an API Application under my.namebright.com > ' +
    'My Account > API Management. The Client ID is "<accountName>:<applicationName>"; ' +
    'NameBright issues the Client Secret. Note the application also enforces an IP whitelist.';
  static readonly configFields: ConfigField[] = [
    { name: 'clientId', label: 'Client ID', type: 'text', required: true },
    { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true },
  ];
  static readonly supportsSandbox = false; // NameBright has no sandbox environment
  // REST/JSON API covering the core lifecycle; no DNSSEC, forwarding, webhooks,
  // or standard auth-code retrieval (transfers are intra-account pushes), so no
  // extended capabilities are declared.
  static readonly extendedFeatures: readonly RegistrarFeature[] = [];

  private token?: string;
  private tokenExpiresAt = 0;

  constructor(credentials: RegistrarCredentials, options?: RegistrarOptions) {
    super(
      credentials,
      {
        baseUrl: selectBaseUrl('NameBright', options?.environment, {
          production: 'https://api.namebright.com/rest',
        }),
      },
      options
    );
  }

  // fetch (and cache) an OAuth2 bearer token via the client-credentials grant
  private async getToken(opts?: RequestOptions): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt) return this.token;

    const res = await this.http.request<NbToken>({
      method: 'POST',
      path: TOKEN_URL,
      body: {
        grant_type: 'client_credentials',
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      },
      ...opts,
    });
    if (!res.access_token) {
      throw new AuthenticationError('NameBright: token endpoint returned no access_token');
    }
    this.token = res.access_token;
    // tokens last ~30 minutes; refresh a minute early
    const ttlMs = (res.expires_in ?? 1800) * 1000;
    this.tokenExpiresAt = now + ttlMs - 60_000;
    return this.token;
  }

  // issue an authenticated REST request, attaching a fresh bearer token
  private async authed<T>(
    config: Omit<RequestConfig, 'headers'>,
    opts?: RequestOptions
  ): Promise<T> {
    const token = await this.getToken(opts);
    return this.http.request<T>({
      ...config,
      headers: { Authorization: `Bearer ${token}` },
      ...opts,
    });
  }

  override async testConnection(opts?: RequestOptions): Promise<ConnectionResult> {
    try {
      // GET /account succeeds only with a valid token
      await this.authed({ path: 'account' }, opts);
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: toRegistrarError(error).message };
    }
  }

  override async listDomains(opts?: ListDomainsOptions): Promise<Domain[]> {
    // The list endpoint has no name filter, so `search` is applied client-side.
    // Nameservers are not returned here (see NbDomain).
    const { search, ...reqOpts } = opts ?? {};
    const domains: Domain[] = [];
    const perPage = 100; // domainsPerPage maximum
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const data = await this.authed<NbDomainsPage | NbDomain[]>(
        { path: 'account/domains', query: { page, domainsPerPage: perPage } },
        reqOpts
      );
      // the response may be a bare array or a paged object; be lenient
      const list = Array.isArray(data) ? data : (data?.Domains ?? data?.domains ?? []);

      for (const d of list) {
        domains.push(
          createDomain({
            domainName: d.DomainName ?? d.domain,
            registrar: this.name,
            status: d.Status ?? 'ok',
            createdDate: d.RegistrationDate,
            expirationDate: d.ExpirationDate,
            renewalDate: d.ExpirationDate,
            autoRenew: d.AutoRenew ?? false,
            locked: d.Locked ?? false,
            privacy: d.WhoIsPrivacy ?? false,
            nameservers: [],
          })
        );
      }

      hasMore = list.length === perPage;
      page++;
    }
    return filterDomains(domains, search);
  }
}

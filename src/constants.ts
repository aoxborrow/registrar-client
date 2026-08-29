import type { RegistrarClientOptions } from './types';

// default client-level options
export const DEFAULT_OPTIONS: RegistrarClientOptions = {
  timeout: 30_000, // 30s — registrar APIs can be slow, especially for registration
  retries: 2,
  backoff: 250,
};

// package identifier used in the default User-Agent header
export const USER_AGENT = '@aoxborrow/registrar-client';

// default per-request page size for `listDomains`. The library paginates
// internally at this size until the account is exhausted. 100 is within every
// provider's per-request cap; providers that don't support a page-size param
// (Porkbun, Dynadot) ignore it and page however their API allows.
export const DEFAULT_PAGE_SIZE = 100;

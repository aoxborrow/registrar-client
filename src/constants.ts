import type { RegistrarClientOptions } from './types';

// default client-level options
export const DEFAULT_OPTIONS: RegistrarClientOptions = {
  timeout: 30_000, // 30s — registrar APIs can be slow, especially for registration
  retries: 2,
  backoff: 250,
};

// package identifier used in the default User-Agent header
export const USER_AGENT = '@aoxborrow/registrar-client';

// default cap on how many domains `listDomains` returns (and, where the API
// allows, fetches) when no explicit `limit` is given. Keeps large accounts
// (10k+ domains) from pulling every page by default.
export const DEFAULT_LIST_LIMIT = 1000;

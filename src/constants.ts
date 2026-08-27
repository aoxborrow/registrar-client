import type { RegistrarClientOptions } from './types.js';

// default client-level options
export const DEFAULT_OPTIONS: RegistrarClientOptions = {
  timeout: 30_000, // 30s — registrar APIs can be slow, especially for registration
  retries: 2,
  backoff: 250,
};

// package identifier used in the default User-Agent header
export const USER_AGENT = '@aoxborrow/registrar-client';

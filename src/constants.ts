import type { RegistrarClientOptions } from './types';

// default client-level options
export const DEFAULT_OPTIONS: RegistrarClientOptions = {
  timeout: 60_000, // 60s — big portfolios and registrations can be slow
  retries: 2,
  backoff: 250,
};

// package identifier used in the default User-Agent header
export const USER_AGENT = '@aoxborrow/registrar-client';

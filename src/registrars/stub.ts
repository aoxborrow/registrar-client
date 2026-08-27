import { DEFAULT_OPTIONS } from '../constants.js';
import type { RegistrarClientOptions } from '../types.js';
import { BaseRegistrar } from './base.js';

// Configuration for the stub provider. Real providers define their own auth
// shape (API key, key+secret, OAuth token, etc.).
export interface StubRegistrarConfig {
  // API credential — sent as a header, never placed in a URL/query string
  apiKey: string;
  // override the API base URL (e.g. for a sandbox environment)
  baseUrl?: string;
  // request/retry behavior overrides
  options?: Partial<RegistrarClientOptions>;
}

// A blank example provider. It wires up auth + HTTP but implements no
// operations yet — every call inherits `NotImplementedError` from
// `BaseRegistrar`. Copy this as the starting point for a real provider.
export class StubRegistrar extends BaseRegistrar {
  readonly name = 'stub';

  constructor(config: StubRegistrarConfig) {
    super({
      baseUrl: config.baseUrl ?? 'https://api.example.com',
      // credentials go in headers only
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      options: { ...DEFAULT_OPTIONS, ...config.options },
    });
  }

  // TODO: override BaseRegistrar operations with real API mappings, e.g.
  //
  //   override async checkAvailability(domains, opts) {
  //     const data = await this.http.request<...>({ path: '/v1/available', query: { ... } });
  //     return data.results.map(r => ({ domain: r.name, available: r.avail }));
  //   }
}

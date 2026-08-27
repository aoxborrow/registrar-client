// Public API surface.

export { RegistrarClient } from './client.js';
export { HttpClient } from './http.js';
export type { HttpClientConfig, RequestConfig } from './http.js';

// core registrar abstraction (the `Registrar` interface itself is exported via
// `export * from './types.js'` below)
export { BaseRegistrar, selectBaseUrl } from './registrar.js';

// built-in providers lookup + factory
export { registrars, createRegistrar } from './registrars/index.js';
export type { RegistrarName } from './registrars/index.js';

// capability model: feature constants, the core contract, and helpers
export {
  Feature,
  CORE_FEATURES,
  EXTENDED_FEATURES,
  ALL_FEATURES,
  isCoreFeature,
} from './features.js';
export type { RegistrarFeature } from './features.js';

// bundled providers
export { CloudflareRegistrar } from './registrars/cloudflare.js';
export { DynadotRegistrar } from './registrars/dynadot.js';
export { GandiRegistrar } from './registrars/gandi.js';
export { GoDaddyRegistrar } from './registrars/godaddy.js';
export { NamecheapRegistrar } from './registrars/namecheap.js';
export { SpaceshipRegistrar } from './registrars/spaceship.js';

// XML parsing helpers for XML-based registrar APIs
export { parseXml, ensureArray } from './xml.js';

// shared types, constants, utils, and errors
export * from './types.js';
export * from './constants.js';
export * from './utils.js';
export * from './errors.js';

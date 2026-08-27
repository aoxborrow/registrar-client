// Public API surface.

export { RegistrarClient } from './client.js';
export { HttpClient } from './http.js';
export type { HttpClientConfig, RequestConfig } from './http.js';

// provider abstraction
export { BaseRegistrar } from './registrars/base.js';
export type {
  RegistrarProvider,
  RegistrarConstructor,
  RegistrarCredentials,
} from './registrars/types.js';

// provider registry
export { registrars, createRegistrar } from './registrars/registry.js';
export type { RegistrarName } from './registrars/registry.js';

// bundled providers
export { CloudflareRegistrar } from './registrars/cloudflare.js';
export { DynadotRegistrar } from './registrars/dynadot.js';
export { GandiRegistrar } from './registrars/gandi.js';
export { GoDaddyRegistrar } from './registrars/godaddy.js';
export { NamecheapRegistrar } from './registrars/namecheap.js';
export { SpaceshipRegistrar } from './registrars/spaceship.js';

// shared types, constants, utils, and errors
export * from './types.js';
export * from './constants.js';
export * from './utils.js';
export * from './errors.js';

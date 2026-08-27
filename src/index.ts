// Public API surface.

export { RegistrarClient } from './client';
export { HttpClient } from './http';
export type { HttpClientConfig, RequestConfig } from './http';

// core registrar abstraction (the `Registrar` interface itself is exported via
// `export * from './types'` below)
export { BaseRegistrar, selectBaseUrl } from './registrar';

// built-in providers lookup + factory
export { registrars, createRegistrar } from './registrars/index';
export type { RegistrarName } from './registrars/index';

// capability model: feature constants, the core contract, and helpers
export { Feature, CORE_FEATURES, EXTENDED_FEATURES, ALL_FEATURES, isCoreFeature } from './features';
export type { RegistrarFeature } from './features';

// bundled providers
export { CloudflareRegistrar } from './registrars/cloudflare';
export { DynadotRegistrar } from './registrars/dynadot';
export { GandiRegistrar } from './registrars/gandi';
export { GoDaddyRegistrar } from './registrars/godaddy';
export { NamecheapRegistrar } from './registrars/namecheap';
export { NameSiloRegistrar } from './registrars/namesilo';
export { SpaceshipRegistrar } from './registrars/spaceship';

// XML parsing helpers for XML-based registrar APIs
export { parseXml, ensureArray } from './xml';

// shared types, constants, utils, and errors
export * from './types';
export * from './constants';
export * from './utils';
export * from './errors';

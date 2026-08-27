// Public API surface.

export { RegistrarClient } from './client.js';
export { HttpClient } from './http.js';
export type { HttpClientConfig, RequestConfig } from './http.js';

// provider abstraction
export { BaseRegistrar } from './registrars/base.js';
export type { RegistrarProvider } from './registrars/types.js';

// bundled providers
export { StubRegistrar } from './registrars/stub.js';
export type { StubRegistrarConfig } from './registrars/stub.js';

// shared types, constants, and errors
export * from './types.js';
export * from './constants.js';
export * from './errors.js';

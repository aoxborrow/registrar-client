import type { RegistrarClientOptions } from '../types.js';
import { CloudflareRegistrar } from './cloudflare.js';
import { DynadotRegistrar } from './dynadot.js';
import { GandiRegistrar } from './gandi.js';
import { GoDaddyRegistrar } from './godaddy.js';
import { NamecheapRegistrar } from './namecheap.js';
import { SpaceshipRegistrar } from './spaceship.js';
import type { RegistrarConstructor, RegistrarCredentials, RegistrarProvider } from './types.js';

// registry of built-in registrar providers, keyed by id
export const registrars = {
  cloudflare: CloudflareRegistrar,
  dynadot: DynadotRegistrar,
  gandi: GandiRegistrar,
  godaddy: GoDaddyRegistrar,
  namecheap: NamecheapRegistrar,
  spaceship: SpaceshipRegistrar,
} satisfies Record<string, RegistrarConstructor>;

// id of a built-in registrar
export type RegistrarName = keyof typeof registrars;

// construct a registrar provider by id
export function createRegistrar(
  name: RegistrarName,
  credentials: RegistrarCredentials,
  options?: Partial<RegistrarClientOptions>
): RegistrarProvider {
  const Registrar = registrars[name];
  return new Registrar(credentials, options);
}

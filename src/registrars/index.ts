import type {
  Registrar,
  RegistrarConstructor,
  RegistrarCredentials,
  RegistrarOptions,
} from '../types.js';
import { CloudflareRegistrar } from './cloudflare.js';
import { DynadotRegistrar } from './dynadot.js';
import { GandiRegistrar } from './gandi.js';
import { GoDaddyRegistrar } from './godaddy.js';
import { NamecheapRegistrar } from './namecheap.js';
import { SpaceshipRegistrar } from './spaceship.js';

// the built-in registrar providers, keyed by id
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
  options?: RegistrarOptions
): Registrar {
  const RegistrarClass = registrars[name];
  return new RegistrarClass(credentials, options);
}

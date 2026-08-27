import type {
  Registrar,
  RegistrarConstructor,
  RegistrarCredentials,
  RegistrarOptions,
} from '../types';
import { CloudflareRegistrar } from './cloudflare';
import { DynadotRegistrar } from './dynadot';
import { GandiRegistrar } from './gandi';
import { GoDaddyRegistrar } from './godaddy';
import { NamecheapRegistrar } from './namecheap';
import { NameSiloRegistrar } from './namesilo';
import { SpaceshipRegistrar } from './spaceship';

// the built-in registrar providers, keyed by id
export const registrars = {
  cloudflare: CloudflareRegistrar,
  dynadot: DynadotRegistrar,
  gandi: GandiRegistrar,
  godaddy: GoDaddyRegistrar,
  namecheap: NamecheapRegistrar,
  namesilo: NameSiloRegistrar,
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

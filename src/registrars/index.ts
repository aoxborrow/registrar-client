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
import { NameBrightRegistrar } from './namebright';
import { NamecheapRegistrar } from './namecheap';
import { NameSiloRegistrar } from './namesilo';
import { PorkbunRegistrar } from './porkbun';
import { SpaceshipRegistrar } from './spaceship';

// the built-in registrar providers, keyed by id
export const registrars = {
  cloudflare: CloudflareRegistrar,
  dynadot: DynadotRegistrar,
  gandi: GandiRegistrar,
  godaddy: GoDaddyRegistrar,
  namebright: NameBrightRegistrar,
  namecheap: NamecheapRegistrar,
  namesilo: NameSiloRegistrar,
  porkbun: PorkbunRegistrar,
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

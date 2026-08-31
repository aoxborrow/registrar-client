import type { DomainForward, Domain, DomainInput, RegistrationConsent } from './types';
import { ConsentRequiredError } from './errors';

// sleep helper for retry backoff
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// a DomainForward that is safe to write: masked/framed forwarding is read-only.
export type SettableDomainForward = DomainForward & { type: 'temporary' | 'permanent' };

export const MASKED_FORWARD_UNSUPPORTED =
  'masked/framed forwarding is not supported by this library; use "temporary" or "permanent"';

// Guard for `setDomainForwarding`: reject any masked/framed forward up front (so
// no partial write happens) and narrow the list to the settable types. Providers
// call this before writing.
export function settableForwards(forwards: DomainForward[]): SettableDomainForward[] {
  for (const f of forwards) {
    if (f.type === 'masked') throw new Error(MASKED_FORWARD_UNSUPPORTED);
  }
  return forwards as SettableDomainForward[];
}

// guard for register/transfer: registration forms a legal contract with the
// registry, so a provider must be given explicit consent. Throws
// ConsentRequiredError (distinct from NotImplementedError) when it's absent.
export function requireConsent(
  provider: string,
  consent: RegistrationConsent | undefined
): RegistrationConsent {
  if (!consent) {
    throw new ConsentRequiredError(
      `${provider}: this operation requires consent — supply \`consent\` ` +
        '(accepting the registrar’s registration agreements)'
    );
  }
  return consent;
}

// filter a domain list by a case-insensitive substring of the domain name.
// Providers that filter server-side still call this — the re-filter is a
// harmless no-op there — so every provider applies `search` consistently.
export function filterDomains(domains: Domain[], search?: string): Domain[] {
  const q = search?.trim().toLowerCase();
  if (!q) return domains;
  return domains.filter(d => d.domainName.toLowerCase().includes(q));
}

// normalize a domain name: trim, lowercase, strip a single trailing dot
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

// exponential backoff delay: backoff * 2^attempt
export function backoffDelay(backoff: number, attempt: number): number {
  return backoff * Math.pow(2, attempt);
}

// parse a variety of date representations into a Date (or null)
// handles ISO strings, epoch millis (as number or numeric string), and Date
export function parseDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  // numeric epoch millis (e.g. Dynadot returns ms timestamps)
  if (typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  // numeric string that looks like an epoch-millis timestamp
  const asNumber = Number(value);
  if (!isNaN(asNumber) && asNumber > 1_000_000_000_000) {
    const d = new Date(asNumber);
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// normalize nameservers into a flat array of hostname strings.
// accepts: string[], { hosts: string[] } (Spaceship), or objects with a
// ServerName property (Dynadot), falling back to String() for anything else.
// Hostnames are trimmed and lowercased (they're case-insensitive, but providers
// return mixed case), and blanks are dropped.
export function normalizeNameservers(nameservers: unknown): string[] {
  if (!nameservers) return [];

  let raw: unknown[];

  // object with a `hosts` array (Spaceship shape)
  if (
    typeof nameservers === 'object' &&
    !Array.isArray(nameservers) &&
    Array.isArray((nameservers as { hosts?: unknown }).hosts)
  ) {
    raw = (nameservers as { hosts: unknown[] }).hosts;
  } else if (Array.isArray(nameservers)) {
    raw = nameservers;
  } else {
    return [];
  }

  return raw
    .map(ns => {
      if (typeof ns === 'string') return ns;
      if (ns && typeof ns === 'object' && 'ServerName' in ns) {
        return String(ns.ServerName);
      }
      return String(ns);
    })
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
}

// build a normalized Domain from loose provider input:
// lowercases status, normalizes nameservers, and coerces dates.
export function createDomain(data: DomainInput = {}): Domain {
  return {
    domainName: data.domainName ?? '',
    registrar: data.registrar ?? '',
    status: (data.status ?? '').toLowerCase(),
    createdDate: parseDate(data.createdDate),
    expirationDate: parseDate(data.expirationDate),
    renewalDate: parseDate(data.renewalDate),
    autoRenew: data.autoRenew ?? false,
    locked: data.locked ?? false,
    privacy: data.privacy ?? false,
    nameservers: normalizeNameservers(data.nameservers),
    syncedAt: data.syncedAt ?? new Date(),
    deleted: data.deleted ?? false,
  };
}

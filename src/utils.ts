import type { Domain, DomainInput } from './types.js';

// sleep helper for retry backoff
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
export function normalizeNameservers(nameservers: unknown): string[] {
  if (!nameservers) return [];

  // object with a `hosts` array (Spaceship shape)
  if (
    typeof nameservers === 'object' &&
    !Array.isArray(nameservers) &&
    Array.isArray((nameservers as { hosts?: unknown }).hosts)
  ) {
    return (nameservers as { hosts: unknown[] }).hosts.map(String);
  }

  if (Array.isArray(nameservers)) {
    return nameservers.map(ns => {
      if (typeof ns === 'string') return ns;
      if (ns && typeof ns === 'object' && 'ServerName' in ns) {
        return String((ns as { ServerName: unknown }).ServerName);
      }
      return String(ns);
    });
  }

  return [];
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

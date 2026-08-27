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

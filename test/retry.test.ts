import { describe, it, expect, vi } from 'vitest';
import {
  ALL_FEATURES,
  ConnectionError,
  FEATURE_CALLS,
  OutcomeUnknownError,
  createRegistrar,
  markNotSent,
} from '../src/index';

// One rule for every registrar: what may be re-sent depends on where the
// failure happened and on whether the feature reads or writes, never on the
// HTTP method. Namecheap sends everything as GET; Porkbun sends everything as
// POST. Both must behave the same.

type Fetch = typeof globalThis.fetch;
const fast = { retries: 2, backoff: 1, timeout: 50 };

const namecheap = (fetch: Fetch) =>
  createRegistrar(
    'namecheap',
    { username: 'u', apiKey: 'k', clientIp: '192.0.2.1' },
    { ...fast, fetch }
  );
const porkbun = (fetch: Fetch) =>
  createRegistrar('porkbun', { apiKey: 'pk', secretApiKey: 'sk' }, { ...fast, fetch });

const status = (code: number, headers?: Record<string, string>) =>
  vi.fn<Fetch>(() => Promise.resolve(new Response('nope', { status: code, headers })));
const rejecting = (error: () => Error) => vi.fn<Fetch>(() => Promise.reject(error()));
const never = () =>
  vi.fn<Fetch>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      })
  );
const undici = (code: string) => () =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

describe('feature classification', () => {
  it('classifies every feature, and only features', () => {
    expect(Object.keys(FEATURE_CALLS).sort()).toEqual([...ALL_FEATURES].sort());
  });

  it('treats reads as reads and everything that can change state as a write', () => {
    const reads = Object.entries(FEATURE_CALLS)
      .filter(([, c]) => c.intent === 'read')
      .map(([name]) => name)
      .sort();
    expect(reads).toEqual(
      [
        'testConnection',
        'listDomains',
        'getDomain',
        'checkAvailability',
        'getPricing',
        'getNameservers',
        'getContacts',
        'getDnsRecords',
        'getDnssec',
        'getEmailForwarding',
        'getDomainForwarding',
      ].sort()
    );
    // regenerating an auth code can invalidate the previous one
    expect(FEATURE_CALLS.getAuthCode.intent).toBe('write');
  });
});

describe('the fetch option', () => {
  it('is used for every request instead of the global fetch', async () => {
    const global = vi.spyOn(globalThis, 'fetch');
    const fetch = status(401);
    await expect(namecheap(fetch).getDomain('example.com')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
    global.mockRestore();
  });
});

describe.each([
  ['a GET-only provider (Namecheap)', namecheap],
  ['a POST-only provider (Porkbun)', porkbun],
])('retry standard for %s', (_label, make) => {
  it('re-sends a read after a 5xx', async () => {
    const fetch = status(503);
    await expect(make(fetch).getDomain('example.com')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('re-sends a read after a timeout', async () => {
    const fetch = never();
    await expect(make(fetch).getDomain('example.com')).rejects.toThrow(/timed out/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('re-sends a write the registrar never saw', async () => {
    const fetch = rejecting(undici('ECONNREFUSED'));
    await make(fetch)
      .updateNameservers('example.com', ['ns1.example.net', 'ns2.example.net'])
      .catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('re-sends a write that a custom transport marks as not sent', async () => {
    const fetch = rejecting(() => markNotSent(new Error('proxy refused CONNECT: 407')));
    await make(fetch)
      .updateNameservers('example.com', ['ns1.example.net', 'ns2.example.net'])
      .catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('re-sends a rate-limited write, honoring Retry-After', async () => {
    const fetch = status(429, { 'retry-after': '0' });
    await make(fetch)
      .updateNameservers('example.com', ['ns1.example.net', 'ns2.example.net'])
      .catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('never re-sends a write that got a definite rejection', async () => {
    const fetch = status(403);
    await make(fetch)
      .renewDomain('example.com', 1)
      .catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 5xx', () => status(502)],
    ['a timeout', never],
    ['a connection dropped with no sign it never left', () => rejecting(undici('ECONNRESET'))],
    ['an unexplained network error', () => rejecting(() => new TypeError('Failed to fetch'))],
  ])('sends a renewal once and reports the outcome as unknown after %s', async (_why, fail) => {
    const fetch = fail();
    // Providers either throw or fold the failure into an OperationResult; the
    // unknown outcome has to survive both.
    const settled = await make(fetch)
      .renewDomain('example.com', 1)
      .then(
        result => ({ result }),
        (error: unknown) => ({ error })
      );
    expect(fetch).toHaveBeenCalledTimes(1);
    if ('error' in settled) {
      expect(settled.error).toBeInstanceOf(OutcomeUnknownError);
      expect((settled.error as OutcomeUnknownError).feature).toBe('renewDomain');
      expect((settled.error as OutcomeUnknownError).shouldRetry()).toBe(false);
    } else {
      expect(settled.result).toMatchObject({ success: false, outcome: 'unknown' });
      expect(settled.result.message).toMatch(/may or may not have been applied/);
    }
  });

  it('does not mark an ordinary failed write as unknown', async () => {
    const settled = await make(status(403))
      .renewDomain('example.com', 1)
      .then(
        result => ({ result }),
        (error: unknown) => ({ error })
      );
    if ('error' in settled) expect(settled.error).not.toBeInstanceOf(OutcomeUnknownError);
    else expect(settled.result.outcome).toBeUndefined();
  });

  it('still honors retries: 0 for a read', async () => {
    const fetch = status(503);
    await expect(make(fetch).getDomain('example.com', { retries: 0 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('not-sent detection', () => {
  it('needs positive evidence, so an opaque failure counts as possibly sent', async () => {
    const error = await namecheap(rejecting(() => new TypeError('Failed to fetch')))
      .getDomain('example.com', { retries: 0 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).notSent).toBe(false);
  });

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED'])(
    'recognizes %s as never sent',
    async code => {
      const error = await namecheap(rejecting(undici(code)))
        .getDomain('example.com', { retries: 0 })
        .catch((e: unknown) => e);
      expect((error as ConnectionError).notSent).toBe(true);
    }
  );
});

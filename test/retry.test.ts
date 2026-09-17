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
// Porkbun prices a renewal before sending it. Answer that lookup so the failure
// under test lands on the renewal itself; `counted` sees only the other requests.
const PRICING = JSON.stringify({ status: 'SUCCESS', pricing: { com: { renewal: '10.00' } } });
function pastPricing(counted: ReturnType<typeof vi.fn<Fetch>>): Fetch {
  return (url, init) =>
    href(url).includes('/pricing/get')
      ? Promise.resolve(new Response(PRICING))
      : counted(url, init);
}
// the library always calls fetch with a URL string
const href = (url: Parameters<Fetch>[0]): string => (typeof url === 'string' ? url : '');
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
    await make(pastPricing(fetch))
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
    const settled = await make(pastPricing(fetch))
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

  it('treats a response cut off mid-body as sent: unknown for a write, retried for a read', async () => {
    const cutOff = () =>
      vi.fn<Fetch>(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError('terminated'));
              },
            }),
            { status: 200 }
          )
        )
      );
    const write = cutOff();
    const settled = await make(pastPricing(write))
      .renewDomain('example.com', 1)
      .then(
        result => ({ result }),
        (error: unknown) => ({ error })
      );
    expect(write).toHaveBeenCalledTimes(1);
    if ('error' in settled) expect(settled.error).toBeInstanceOf(OutcomeUnknownError);
    else expect(settled.result).toMatchObject({ success: false, outcome: 'unknown' });

    const read = cutOff();
    await expect(make(read).getDomain('example.com')).rejects.toThrow(/lost while reading/);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('does not mark an ordinary failed write as unknown', async () => {
    const settled = await make(pastPricing(status(403)))
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

describe('a lookup made in the middle of a write', () => {
  // A write often reads first: current records, a price, a zone id. That lookup
  // changed nothing, so it is retried like any read and its failure is an
  // ordinary error, never "the write may have been applied".
  interface Settled {
    result?: { outcome?: string };
    error?: unknown;
  }
  const settle = (p: Promise<unknown>): Promise<Settled> =>
    p.then(
      result => ({ result: result as Settled['result'] }),
      (error: unknown) => ({ error })
    );
  const expectPlainFailure = (settled: Settled) => {
    expect(settled.error).not.toBeInstanceOf(OutcomeUnknownError);
    expect(settled.result?.outcome).toBeUndefined();
  };

  it('is retried on a REST API because GET never changes state (Cloudflare zone lookup)', async () => {
    const fetch = status(503);
    const cf = createRegistrar('cloudflare', { apiToken: 't', accountId: 'a' }, { ...fast, fetch });
    expectPlainFailure(
      await settle(
        cf.setDnsRecords('example.com', [{ type: 'A', name: '@', value: '192.0.2.1', ttl: 300 }])
      )
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('still sends a REST write once and reports it unknown (Gandi PATCH)', async () => {
    const fetch = status(503);
    const gandi = createRegistrar('gandi', { apiKey: 'k' }, { ...fast, fetch });
    const settled = await settle(gandi.setAutoRenew('example.com', true));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.method).toBe('PATCH');
    if (settled.error !== undefined) expect(settled.error).toBeInstanceOf(OutcomeUnknownError);
    else expect(settled.result?.outcome).toBe('unknown');
  });

  it('is retried where the method means nothing, because the provider marks it (Porkbun price)', async () => {
    const fetch = status(503);
    expectPlainFailure(await settle(porkbun(fetch).renewDomain('example.com', 1)));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([url]) => href(url).includes('/pricing/get'))).toBe(true);
  });

  it('is retried for Namecheap, whose writes are GETs too (WhoisGuard id lookup)', async () => {
    const fetch = status(503);
    expectPlainFailure(await settle(namecheap(fetch).setPrivacy('example.com', true)));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([url]) => href(url).includes('namecheap.domains.getInfo'))).toBe(
      true
    );
  });

  it('is retried for NameSilo (current records before a DNS update)', async () => {
    const fetch = status(503);
    const namesilo = createRegistrar('namesilo', { apiKey: 'k' }, { ...fast, fetch });
    expectPlainFailure(
      await settle(
        namesilo.setDnsRecords('example.com', [
          { type: 'A', name: '@', value: '192.0.2.1', ttl: 3600 },
        ])
      )
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([url]) => href(url).includes('dnsListRecords'))).toBe(true);
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

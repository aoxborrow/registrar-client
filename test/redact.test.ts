import { describe, it, expect, vi } from 'vitest';
import {
  AuthorizationError,
  BaseRegistrar,
  ConfigurationError,
  ConnectionError,
  DEFAULT_OPTIONS,
  Feature,
  HttpClient,
  InvalidResponseError,
  OutcomeUnknownError,
  ParsingError,
  RateLimitError,
  TimeoutError,
  createRegistrar,
  listPortfolio,
  redactSecrets,
} from '../src/index';
import type {
  ConnectionResult,
  Domain,
  OperationResult,
  RegistrarCredentials,
  RegistrarFeature,
  TldPricing,
} from '../src/index';

type Fetch = typeof globalThis.fetch;

const never = () =>
  vi.fn<Fetch>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      })
  );
const rejecting = () => vi.fn<Fetch>(() => Promise.reject(new TypeError('fetch failed')));
const status = (code: number, body = 'nope') =>
  vi.fn<Fetch>(() => Promise.resolve(new Response(body, { status: code })));
const ok = (body: string) => vi.fn<Fetch>(() => Promise.resolve(new Response(body)));

// the rejection of a promise, for checks beyond `toThrow`
async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

// everything an error carries as text: message, stack, and its cause's
function errorText(error: Error): string {
  const cause = error.cause instanceof Error ? error.cause : undefined;
  return [error.message, error.stack, cause?.message, cause?.stack].join('\n');
}

describe('redactSecrets', () => {
  it('drops the userinfo, query and fragment of every URL', () => {
    expect(
      redactSecrets(
        "Request to 'https://user:pass@api.example/path?unknown=old-secret#frag' failed"
      )
    ).toBe("Request to 'https://api.example/path' failed");
    expect(redactSecrets('proxy socks5://alice:hunter22@proxy.example:1080 refused')).toBe(
      'proxy socks5://proxy.example:1080 refused'
    );
  });

  it('leaves a URL with nothing to drop as written, and replaces one that does not parse', () => {
    expect(redactSecrets('see https://example.com or https://example.com/a/b')).toBe(
      'see https://example.com or https://example.com/a/b'
    );
    expect(redactSecrets('bad http://[oops]/x?key=1')).toBe('bad [redacted URL]');
  });

  it('replaces each secret raw, URL-encoded and form-encoded', () => {
    const key = 'secret/+ value';
    const form = new URLSearchParams({ k: key }).toString().slice(2);
    const message = `raw ${key}, encoded ${encodeURIComponent(key)}, form ${form}`;
    const expected = 'raw [redacted], encoded [redacted], form [redacted]';
    expect(redactSecrets(message, { apiKey: key })).toBe(expected);
    expect(redactSecrets(message, [key])).toBe(expected);
  });

  it('replaces a secret that contains another whole, and matches secrets literally', () => {
    expect(redactSecrets('x abcdefgh y abcd', ['abcd', 'abcdefgh'])).toBe(
      'x [redacted] y [redacted]'
    );
    expect(redactSecrets('a.b*c+d and axbxxcd', ['a.b*c+d'])).toBe('[redacted] and axbxxcd');
  });

  it('skips missing values and values too short to be a secret', () => {
    expect(
      redactSecrets('keep spaces and pk', { a: undefined, b: null, c: '', d: 's', e: 'pk' })
    ).toBe('keep spaces and pk');
  });
});

// Namecheap authenticates with ApiUser and ApiKey in the query string, so
// every request URL carries the key.
const NC_CREDENTIALS = {
  username: 'audit-user',
  apiKey: 'AUDIT_FAKE_KEY_123',
  clientIp: '192.0.2.1',
};
const NC_URL = 'https://api.namecheap.com/xml.response';

function expectNoCredentials(text: string): void {
  expect(text).not.toContain(NC_CREDENTIALS.apiKey);
  expect(text).not.toContain(NC_CREDENTIALS.username);
  expect(text).not.toContain('ApiKey=');
}

describe('HttpClient error messages', () => {
  const http = (fetch: Fetch) =>
    new HttpClient({
      baseUrl: NC_URL,
      options: { ...DEFAULT_OPTIONS, retries: 0, timeout: 20, fetch },
    });
  // a read, so a failure surfaces as itself rather than as an unknown write
  const req = {
    path: '',
    query: { ApiUser: NC_CREDENTIALS.username, ApiKey: NC_CREDENTIALS.apiKey, Command: 'x' },
    call: { intent: 'read' as const, feature: 'getDomain' as const },
  };

  it.each([
    ['a timeout', never(), TimeoutError, 'timed out after 20ms'],
    ['a connection failure', rejecting(), ConnectionError, 'fetch failed'],
    ['a 4xx', status(403), AuthorizationError, 'failed with 403'],
    ['a 5xx', status(500), InvalidResponseError, 'failed with 500'],
  ])('show the URL without its query for %s', async (_case, fetch, type, detail) => {
    const error = await caught(http(fetch).requestText(req));
    expect(error).toBeInstanceOf(type);
    expect(error.message).toContain(`'${NC_URL}'`);
    expect(error.message).toContain(detail);
    expectNoCredentials(errorText(error));
  });

  it('show the URL without its query for an unparseable JSON body', async () => {
    const error = await caught(http(ok('<html>')).request(req));
    expect(error).toBeInstanceOf(ParsingError);
    expect(error.message).toContain(`'${NC_URL}'`);
    expectNoCredentials(errorText(error));
  });
});

describe('a query-authenticated registrar (Namecheap)', () => {
  const namecheap = (fetch: Fetch) =>
    createRegistrar('namecheap', NC_CREDENTIALS, { retries: 0, timeout: 20, fetch });

  it('keeps the key out of a timeout', async () => {
    const error = await caught(namecheap(never()).getDomain('example.com'));
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(`Request to '${NC_URL}' timed out after 20ms`);
    expectNoCredentials(errorText(error));

    const result = await namecheap(never()).testConnection();
    expect(result).toMatchObject({ success: false, status: 408 });
    expectNoCredentials(result.message);
  });

  it('keeps the key out of a connection failure', async () => {
    const error = await caught(namecheap(rejecting()).listDomains());
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(`Failed to reach '${NC_URL}': fetch failed`);
    expectNoCredentials(errorText(error));
  });

  it('keeps the key out of a 4xx, even when the body echoes it', async () => {
    const echo = `denied ${NC_URL}?ApiUser=audit-user&ApiKey=AUDIT_FAKE_KEY_123 (AUDIT_FAKE_KEY_123)`;
    const error = await caught(namecheap(status(403, echo)).getDomain('example.com'));
    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({ status: 403 });
    expect(error.message).toBe(
      `Request to '${NC_URL}' failed with 403 : denied ${NC_URL} ([redacted])`
    );
    expectNoCredentials(errorText(error));
  });

  it('keeps the key out of a 5xx, and out of the cause of an unknown write', async () => {
    const read = await caught(namecheap(status(502)).getDomain('example.com'));
    expect(read).toBeInstanceOf(InvalidResponseError);
    expectNoCredentials(errorText(read));

    const write = await caught(namecheap(status(502)).lockDomain('example.com'));
    expect(write).toBeInstanceOf(OutcomeUnknownError);
    expect(write.cause).toBeInstanceOf(InvalidResponseError);
    expect((write.cause as Error).message).toBe(`Request to '${NC_URL}' failed with 502 : nope`);
    expectNoCredentials(errorText(write));
  });

  it('keeps the key out of an error the registrar reports in a 200 reply', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response">
        <Errors><Error Number="1011102">API Key AUDIT_FAKE_KEY_123 is invalid</Error></Errors>
      </ApiResponse>`;
    const result = await namecheap(ok(xml)).testConnection();
    expect(result.success).toBe(false);
    expect(result.message).toContain('API Key [redacted] is invalid');
  });
});

it('keeps a query-string key out of portfolio errors (NameSilo)', async () => {
  const key = 'AUDIT_FAKE_SECRET_123';
  const namesilo = createRegistrar('namesilo', { apiKey: key }, { retries: 0, fetch: status(403) });
  const { errors } = await listPortfolio([namesilo]);
  expect(errors).toHaveLength(1);
  expect(errors[0].error.message).toContain('403');
  expect(errorText(errors[0].error)).not.toContain(key);
});

// A provider that puts its own key into everything it throws or returns, to
// show the redaction sits under every feature, core and extended alike.
class EchoRegistrar extends BaseRegistrar {
  readonly name = 'echo';
  static readonly extendedFeatures: readonly RegistrarFeature[] = [Feature.GetAuthCode];

  constructor(credentials: RegistrarCredentials) {
    super(credentials, { baseUrl: 'https://api.example' });
  }

  private get key(): string {
    return this.credentials.apiKey;
  }

  override testConnection(): Promise<ConnectionResult> {
    return Promise.resolve({ success: false, message: `bad ${encodeURIComponent(this.key)}` });
  }

  override renewDomain(_domainName: string): Promise<OperationResult> {
    return Promise.resolve({ success: true, message: `renewed with ${this.key}` });
  }

  override getAuthCode(_domainName: string): Promise<string> {
    return Promise.reject(new RateLimitError(`slow down ${this.key}`, 7));
  }

  // a provider that validates by throwing synchronously
  override getPricing(_tld: string): Promise<TldPricing> {
    throw new ConfigurationError(`bad config ${this.key}`);
  }

  override lockDomain(_domainName: string): Promise<OperationResult> {
    return Promise.reject(
      new OutcomeUnknownError('unconfirmed', { cause: new Error(`inner ${this.key}`) })
    );
  }

  override getDomain(_domainName: string): Promise<Domain> {
    // a provider rejecting with a bare string
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(`text ${this.key}`);
  }

  override getNameservers(_domainName: string): Promise<string[]> {
    return Promise.resolve([`ns1.${this.key}.example`]);
  }
}

describe('every feature of every provider', () => {
  const key = 'secret/+ value';
  const echo = () => new EchoRegistrar({ apiKey: key });

  it('redacts result messages, failed or not', async () => {
    expect(await echo().testConnection()).toEqual({ success: false, message: 'bad [redacted]' });
    expect(await echo().renewDomain('example.com')).toEqual({
      success: true,
      message: 'renewed with [redacted]',
    });
  });

  it('redacts an extended feature error and keeps its class and fields', async () => {
    const error = await caught(echo().getAuthCode('example.com'));
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ status: 429, retryAfter: 7, message: 'slow down [redacted]' });
    expect(error.stack).not.toContain(key);
  });

  it('redacts a synchronous throw and keeps it synchronous', () => {
    const registrar = echo();
    expect(() => registrar.getPricing('com')).toThrow(ConfigurationError);
    expect(() => registrar.getPricing('com')).toThrow('bad config [redacted]');
  });

  it('redacts the cause chain, and a rejected string', async () => {
    const error = await caught(echo().lockDomain('example.com'));
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error.cause as Error).message).toBe('inner [redacted]');
    expect(errorText(error)).not.toContain(key);
    await expect(echo().getDomain('example.com')).rejects.toBe('text [redacted]');
  });

  it('returns data that is not a result as it is', async () => {
    // lowercased by the nameserver normalization, but not redacted
    expect(await echo().getNameservers('example.com')).toEqual([`ns1.${key}.example`]);
  });
});

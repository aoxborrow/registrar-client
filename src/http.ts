import { USER_AGENT } from './constants';
import {
  AbortError,
  AuthenticationError,
  AuthorizationError,
  ConnectionError,
  InvalidResponseError,
  NotFoundError,
  OutcomeUnknownError,
  ParsingError,
  RateLimitError,
  RegistrarError,
  TimeoutError,
  toRegistrarError,
  wasNotSent,
} from './errors';
import type { FeatureCall, RegistrarClientOptions } from './types';
import { backoffDelay, sleep } from './utils';

// configuration for an HttpClient instance
export interface HttpClientConfig {
  // base URL for all requests, e.g. "https://api.example.com/v2"
  baseUrl: string;
  // default headers applied to every request (e.g. Authorization) — never logged
  headers?: Record<string, string>;
  // request/retry behavior
  options: RegistrarClientOptions;
  // HTTP methods this API reserves for requests that never change state. A
  // REST API sets `REST_SAFE_METHODS`, so a lookup made in the middle of a
  // write (a zone list, a price check) is still retried like any read. Leave
  // unset for APIs where the method means nothing: Namecheap and NameSilo send
  // writes as GET. Those mark their nested reads with `asRead` instead.
  safeMethods?: readonly string[];
}

export const REST_SAFE_METHODS: readonly string[] = ['GET', 'HEAD'];

// options for a single request
export interface RequestConfig {
  method?: string;
  // path appended to baseUrl, or an absolute URL
  path: string;
  // query parameters (never used for secrets)
  query?: Record<string, string | number | boolean | undefined>;
  // JSON body; serialized with JSON.stringify
  body?: unknown;
  headers?: Record<string, string>;
  // per-request overrides
  timeout?: number;
  retries?: number;
  backoff?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  // which feature this request serves and whether it reads or writes; arrives
  // with the caller's `RequestOptions`. A request without one is treated as a
  // write, the safe assumption.
  call?: FeatureCall;
}

// a small, browser/edge-safe fetch wrapper with timeout, abort linking,
// retry-with-backoff, and registrar error mapping. No Node built-ins.
export class HttpClient {
  constructor(protected config: HttpClientConfig) {}

  // perform a request and parse a JSON response body
  async request<T = unknown>(req: RequestConfig): Promise<T> {
    return this.withRetries(req, async () => {
      const text = await this.send(req);
      if (text.length === 0) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new ParsingError(
          `Failed to parse JSON response from '${this.buildUrl(req)}': ${errorMessage(error)}`
        );
      }
    });
  }

  // perform a request and return the raw response body text (e.g. XML APIs)
  async requestText(req: RequestConfig): Promise<string> {
    return this.withRetries(req, () => this.send(req));
  }

  // Shared retry-with-backoff wrapper around a single-attempt operation.
  //
  // What may be re-sent depends on where the failure happened and on whether
  // the call reads or writes:
  //
  //   failure                                        read    write
  //   never sent (DNS, refused, TLS, proxy stage)    retry   retry
  //   429                                            retry   retry
  //   unknown (timeout, dropped mid-response, 5xx)   retry   OutcomeUnknownError
  //   any other response                             fail    fail
  //
  // A write whose outcome is unknown may have been applied, so it is never
  // re-sent: a second renewal charges twice, a second record-create leaves a
  // duplicate. The caller re-reads the domain instead.
  protected async withRetries<T>(req: RequestConfig, attemptFn: () => Promise<T>): Promise<T> {
    const retries = req.retries ?? this.config.options.retries;
    const backoff = req.backoff ?? this.config.options.backoff;

    let lastError: RegistrarError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await attemptFn();
      } catch (error) {
        lastError = toRegistrarError(error);

        if (this.intentOf(req) === 'write' && isOutcomeUnknown(lastError)) {
          const unknown = new OutcomeUnknownError(
            `The registrar did not confirm this change, so it may or may not have been applied. ` +
              `Check the domain before trying again. (${lastError.message})`,
            { feature: req.call?.feature, cause: lastError }
          );
          if (req.call) req.call.outcomeUnknown = unknown;
          throw unknown;
        }

        // out of attempts, or the error is not retryable
        if (attempt >= retries || !lastError.shouldRetry()) {
          throw lastError;
        }

        // honor Retry-After for rate limits when present, else exponential backoff
        const delay =
          lastError instanceof RateLimitError && lastError.retryAfter != null
            ? lastError.retryAfter * 1000
            : backoffDelay(backoff, attempt);
        await sleep(delay);
      }
    }

    // unreachable: the loop always returns or throws
    throw lastError ?? new RegistrarError('Request failed');
  }

  // Whether a request only reads. A method the API reserves for reads wins;
  // otherwise it is whatever the feature being served is, and a request that
  // says nothing is assumed to write.
  protected intentOf(req: RequestConfig): 'read' | 'write' {
    const method = (req.method ?? 'GET').toUpperCase();
    if (this.config.safeMethods?.includes(method)) return 'read';
    return req.call?.intent ?? 'write';
  }

  // build the full URL for a request, applying query parameters
  protected buildUrl(req: RequestConfig): string {
    let base: string;
    if (/^https?:\/\//.test(req.path)) {
      // absolute URL
      base = req.path;
    } else if (req.path === '') {
      // empty path: the baseUrl is itself the full endpoint (e.g. Namecheap/Dynadot)
      base = this.config.baseUrl;
    } else {
      base = `${this.config.baseUrl.replace(/\/$/, '')}/${req.path.replace(/^\//, '')}`;
    }
    const url = new URL(base);
    if (req.query) {
      for (const [key, value] of Object.entries(req.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  // send a single request (no retries), map errors, and return the raw body text
  protected async send(req: RequestConfig): Promise<string> {
    const timeout = req.timeout ?? this.config.options.timeout;
    const externalSignal = req.signal ?? this.config.options.signal;

    // abort controller for this request, linked to any external signal
    const controller = new AbortController();
    if (externalSignal?.aborted) {
      throw new AbortError('Request was aborted');
    }
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onAbort);
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const url = this.buildUrl(req);
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      ...this.config.headers,
      ...req.headers,
    };
    if (req.body !== undefined && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      let response: Response;
      try {
        const doFetch = req.fetch ?? this.config.options.fetch ?? fetch;
        response = await doFetch(url, {
          method: req.method ?? 'GET',
          headers,
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        // distinguish abort/timeout from a genuine network failure
        if (isAbortError(error)) {
          if (externalSignal?.aborted) throw new AbortError('Request was aborted');
          throw new TimeoutError(`Request to '${url}' timed out after ${timeout}ms`);
        }
        throw new ConnectionError(`Failed to reach '${url}': ${errorMessage(error)}`, {
          notSent: wasNotSent(error),
        });
      }

      if (!response.ok) {
        throw await this.toStatusError(response, url);
      }

      // 204 No Content yields an empty string
      if (response.status === 204) {
        return '';
      }
      try {
        return await response.text();
      } catch (error) {
        // The registrar answered, then the body was cut off. The request was
        // certainly sent, so for a write the outcome is unknown; a read can
        // simply be retried.
        if (isAbortError(error)) {
          if (externalSignal?.aborted) throw new AbortError('Request was aborted');
          throw new TimeoutError(`Response from '${url}' timed out after ${timeout}ms`);
        }
        throw new ConnectionError(
          `Connection to '${url}' was lost while reading the response: ${errorMessage(error)}`
        );
      }
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  }

  // map a non-2xx response to a typed RegistrarError
  protected async toStatusError(response: Response, url: string): Promise<RegistrarError> {
    // read the body defensively; it may aid debugging but must not be assumed JSON
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      // ignore body read failures
    }
    const message = `Request to '${url}' failed with ${response.status} ${response.statusText}${
      detail ? `: ${detail}` : ''
    }`;

    switch (response.status) {
      case 401:
        return new AuthenticationError(message);
      case 403:
        return new AuthorizationError(message);
      case 404:
        return new NotFoundError(message);
      case 429: {
        const retryAfter = Number(response.headers.get('retry-after'));
        return new RateLimitError(message, Number.isFinite(retryAfter) ? retryAfter : undefined);
      }
      default: {
        if (response.status >= 500) {
          return new InvalidResponseError(message);
        }
        // preserve the real status for 4xx codes without a dedicated class
        // (400, 402, 409, 422, …) so callers can branch on it
        const err = new RegistrarError(message);
        err.status = response.status;
        return err;
      }
    }
  }
}

// A retryable failure that leaves a write's result unknown: the request may
// have reached the registrar. A rate limit is an explicit rejection, and a
// connection error known to precede sending never reached it.
function isOutcomeUnknown(error: RegistrarError): boolean {
  if (error instanceof TimeoutError || error instanceof InvalidResponseError) return true;
  return error instanceof ConnectionError && !error.notSent;
}

// detect an AbortController/fetch abort across environments
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError'
  );
}

// safely extract a message from an unknown thrown value
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

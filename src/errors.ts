// convert any thrown value to a RegistrarError (preserves existing RegistrarError instances)
export function toRegistrarError(error: unknown): RegistrarError {
  // already a RegistrarError, return as-is
  if (error instanceof RegistrarError) {
    return error;
  }

  // extract message from Error or convert unknown to string
  const message =
    error instanceof Error ? error.message : String(error) || 'An unknown error occurred';

  // wrap in a concrete RegistrarError instance
  const wrapped = new (class extends RegistrarError {})(message);

  // preserve the original error's identity where possible
  if (error instanceof Error) {
    wrapped.name = error.name;
    wrapped.stack = error.stack;
  } else {
    wrapped.name = 'RegistrarError';
  }

  return wrapped;
}

// base error class for registrar client errors
// `status` mirrors an HTTP-style status code where meaningful
export class RegistrarError extends Error {
  public status: number;
  // optional machine-readable code from the underlying registrar API
  public providerCode?: string;

  constructor(message: string) {
    super(message);
    this.name = 'RegistrarError';
    this.status = -1;

    Object.setPrototypeOf(this, new.target.prototype);

    // maintain proper stack trace (V8/Node only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  // determine if this error should trigger a retry
  // overridden by subclasses for custom logic
  shouldRetry(): boolean {
    return false;
  }
}

// base class for transient errors that are safe to retry
export class RetryableRegistrarError extends RegistrarError {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableRegistrarError';
  }

  shouldRetry(): boolean {
    return true;
  }
}

// request timed out
export class TimeoutError extends RetryableRegistrarError {
  public status = 408; // Request Timeout

  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

// network/connection failure reaching the registrar API
export class ConnectionError extends RetryableRegistrarError {
  public status = 503; // Service Unavailable
  // true when the failure is known to have happened before the request left:
  // DNS, connection refused, TLS handshake, or a proxy that never opened its
  // tunnel. The registrar cannot have acted on it, so it is safe to re-send
  // even for a write.
  public notSent: boolean;

  constructor(message: string, details: { notSent?: boolean } = {}) {
    super(message);
    this.name = 'ConnectionError';
    this.notSent = details.notSent ?? false;
  }
}

// A write failed in a way that leaves its result unknown: the request timed
// out, the connection dropped mid-response, or the registrar answered 5xx. It
// may have been applied. Never retried by the library; re-read the domain
// before trying again.
export class OutcomeUnknownError extends RegistrarError {
  public status = 504; // Gateway Timeout
  public feature?: string;
  public override cause?: unknown;

  constructor(message: string, details: { feature?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'OutcomeUnknownError';
    this.feature = details.feature;
    this.cause = details.cause;
  }
}

const NOT_SENT = Symbol.for('registrar-client.notSent');

// For custom `fetch` transports: mark an error as having occurred before the
// request was sent (proxy unreachable, proxy auth refused, tunnel TLS failed).
// Returns the same error for `throw markNotSent(err)`.
export function markNotSent<T>(error: T): T {
  if (typeof error === 'object' && error !== null) {
    Object.defineProperty(error, NOT_SENT, { value: true, enumerable: false });
  }
  return error;
}

// error codes Node's fetch (undici) reports, via `error.cause.code`, for
// failures that happen before any request bytes are written
const PRE_SEND_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// Whether a fetch rejection is known to have happened before the request was
// sent. Only positive evidence counts: an explicit `markNotSent`, or a
// pre-connection error code. Runtimes that expose no code (browsers, Workers)
// yield false, which is the safe answer.
export function wasNotSent(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if ((e as Record<symbol, unknown>)[NOT_SENT] === true) return true;
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && PRE_SEND_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

// registrar API rejected the credentials
export class AuthenticationError extends RegistrarError {
  public status = 401; // Unauthorized

  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

// caller lacks permission for the requested operation
export class AuthorizationError extends RegistrarError {
  public status = 403; // Forbidden

  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

// requested resource (domain, contact, etc.) was not found
export class NotFoundError extends RegistrarError {
  public status = 404; // Not Found

  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// registrar API rate limit exceeded
export class RateLimitError extends RetryableRegistrarError {
  public status = 429; // Too Many Requests
  // seconds to wait before retrying, if provided by the API
  public retryAfter?: number;

  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

// registrar API returned a response we couldn't understand
export class InvalidResponseError extends RetryableRegistrarError {
  public status = 502; // Bad Gateway

  constructor(message: string) {
    super(message);
    this.name = 'InvalidResponseError';
  }
}

// failed to parse a response payload
export class ParsingError extends RegistrarError {
  public status = 422; // Unprocessable Entity

  constructor(message: string) {
    super(message);
    this.name = 'ParsingError';
  }
}

// invalid client configuration or arguments
export class ConfigurationError extends RegistrarError {
  public status = 500; // Internal Server Error

  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

// a registration/transfer was attempted without the consent the registrar
// requires (accepting its registration agreements). Distinct from
// NotImplementedError: the capability exists, but the caller must supply consent.
export class ConsentRequiredError extends RegistrarError {
  public status = 400; // Bad Request

  constructor(message: string) {
    super(message);
    this.name = 'ConsentRequiredError';
  }
}

// the requested capability is not implemented by this provider
export class NotImplementedError extends RegistrarError {
  public status = 501; // Not Implemented

  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

// request was cancelled via an AbortSignal
export class AbortError extends RegistrarError {
  public status = 499; // Client Closed Request

  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }

  shouldRetry(): boolean {
    return false;
  }
}

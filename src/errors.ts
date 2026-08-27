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

  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
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

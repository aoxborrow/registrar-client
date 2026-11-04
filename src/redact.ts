// Credential redaction for anything that leaves the library as text: error
// messages and stacks, and the `message` on operation results.
//
// Some registrar APIs authenticate in the query string (Namecheap's `ApiKey`,
// NameSilo's and Dynadot's `key`), so a request URL is itself a secret, and
// any API can echo a credential back in an error body. `BaseRegistrar` passes
// everything a provider throws or returns through here, with that instance's
// credentials.

// The credential values to remove: a credentials object or a list of values.
// Missing values, and values shorter than `MIN_SECRET_LENGTH`, are skipped.
export type SecretValues =
  Readonly<Record<string, string | null | undefined>> | readonly (string | null | undefined)[];

const REDACTED = '[redacted]';

// No real key, token or account ID is this short, and replacing every `s` or
// `pk` would shred the message.
const MIN_SECRET_LENGTH = 4;

// A `scheme://…` run, up to whitespace, a quote or an angle bracket. Any
// scheme, so a proxy URL such as `socks5://user:pass@host` is covered too.
const URL_PATTERN = /[a-z][a-z\d+.-]*:\/\/[^\s<>"'`]+/gi;

/**
 * Remove credentials from a message before it is shown, logged or stored.
 *
 * Every URL in the message loses its userinfo, query and fragment. The whole
 * query goes, not just the parameters known to carry keys, so a credential
 * under a name nobody listed is dropped as well. Then each secret value is
 * replaced with `[redacted]` wherever it appears raw, URL-encoded
 * (`encodeURIComponent`) or form-encoded (`URLSearchParams`, `+` for a space).
 * Values shorter than four characters are left alone.
 *
 *   redactSecrets(error.message, credentials)
 */
export function redactSecrets(message: string, secrets: SecretValues = []): string {
  const safe = message.replace(URL_PATTERN, raw => stripUrl(raw));
  const pattern = secretPattern(secrets);
  return pattern ? safe.replace(pattern, REDACTED) : safe;
}

// A URL without its userinfo, query and fragment. Returned unchanged when it
// has none of them; one that doesn't parse is replaced whole.
export function stripUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '[redacted URL]';
  }
  if (!url.username && !url.password && !url.search && !url.hash) return raw;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

// Redact a thrown value in place, so its class and fields (`status`,
// `retryAfter`, `providerCode`) still work for callers that branch on them:
// the message, the stack (which repeats the message), and every Error or
// string along the `cause` chain. A thrown string comes back redacted.
export function redactThrown(thrown: unknown, secrets: SecretValues): unknown {
  if (typeof thrown === 'string') return redactSecrets(thrown, secrets);
  const seen = new Set<Error>();
  for (let error: unknown = thrown; error instanceof Error && !seen.has(error);) {
    seen.add(error);
    error.message = redactSecrets(error.message, secrets);
    if (typeof error.stack === 'string') error.stack = redactSecrets(error.stack, secrets);
    if (typeof error.cause === 'string') error.cause = redactSecrets(error.cause, secrets);
    error = error.cause;
  }
  return thrown;
}

// An `OperationResult` or `ConnectionResult` with its message redacted.
// Anything else (a domain, a record list, an auth code) is returned as is.
export function redactResult<T>(value: T, secrets: SecretValues): T {
  if (value === null || typeof value !== 'object') return value;
  const { success, message } = value as { success?: unknown; message?: unknown };
  if (typeof success !== 'boolean' || typeof message !== 'string') return value;
  const safe = redactSecrets(message, secrets);
  return safe === message ? value : { ...value, message: safe };
}

// One pattern matching every form of every secret, longest first: a secret
// that contains another is replaced whole, and a single pass never matches
// inside a `[redacted]` it already wrote.
function secretPattern(secrets: SecretValues): RegExp | undefined {
  const forms = new Set<string>();
  for (const secret of Object.values(secrets)) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    forms.add(secret);
    forms.add(new URLSearchParams({ v: secret }).toString().slice(2));
    try {
      forms.add(encodeURIComponent(secret));
    } catch {
      // a lone surrogate can't be URL-encoded, so it can't appear that way
    }
  }
  if (forms.size === 0) return undefined;
  const alternatives = [...forms].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(alternatives.join('|'), 'g');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

# @aoxborrow/registrar-client

A fully-typed, **browser- and edge-safe** client for domain registrar APIs, with a
pluggable multi-provider interface. Zero runtime dependencies — just `fetch`.

Runs anywhere `fetch` is available: modern Node.js (18+), browsers, Cloudflare
Workers, Deno, Bun, and other edge runtimes.

> **Status:** early scaffold. The provider abstraction, HTTP layer, error model,
> and types are in place; concrete registrar providers are not implemented yet.

## Install

```bash
npm install @aoxborrow/registrar-client
```

## Usage

Construct a `RegistrarClient` with a provider:

```ts
import { RegistrarClient, StubRegistrar } from '@aoxborrow/registrar-client';

const client = new RegistrarClient(new StubRegistrar({ apiKey: process.env.API_KEY! }));

const results = await client.checkAvailability(['example.com', 'example.dev']);
```

## Architecture

The package separates the **caller-facing facade** from **provider
implementations**:

- **`RegistrarClient`** — a thin, provider-agnostic facade. Normalizes input and
  delegates to the configured provider.
- **`RegistrarProvider`** — the interface every backend implements
  (`checkAvailability`, `getPricing`, `registerDomain`, `renewDomain`,
  `transferDomain`, `setNameservers`, …).
- **`BaseRegistrar`** — an abstract base that owns the shared HTTP/auth/retry
  plumbing (via `HttpClient`) and provides `NotImplementedError`-throwing
  defaults. Concrete providers extend it and override only what their API
  supports.
- **`HttpClient`** — a small `fetch` wrapper with timeout, `AbortSignal`
  linking, retry-with-backoff, and typed error mapping. No Node built-ins.

### Adding a provider

Copy `src/registrars/stub.ts`, set the `baseUrl` and auth headers, and override
the `BaseRegistrar` operations your API supports, mapping payloads to the shared
types in `src/types.ts`.

## Errors

All failures throw a typed subclass of `RegistrarError` (`AuthenticationError`,
`NotFoundError`, `RateLimitError`, `TimeoutError`, `NotImplementedError`, …),
each carrying an HTTP-style `status`.

## Security

Credentials are always sent as request **headers**, never in URLs or query
strings, and are not included in error messages.

## License

MIT © Aaron Oxborrow

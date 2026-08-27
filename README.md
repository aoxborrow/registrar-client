# @aoxborrow/registrar-client

A fully-typed, **browser- and edge-safe** client for domain registrar APIs, with a
pluggable multi-provider interface. Speaks both JSON and XML registrar APIs.

Runs anywhere `fetch` is available: modern Node.js (18+), browsers, Cloudflare
Workers, Deno, Bun, and other edge runtimes. Its one runtime dependency —
[`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser)
(pure JS, no Node built-ins) — is used to parse XML registrar responses and is
itself edge-safe.

> **Status:** early. Six registrar providers are implemented (ported from a
> prior Google-Apps-Script domain-sync project); they have not yet been
> exercised against live APIs with real credentials.

## Install

```bash
npm install @aoxborrow/registrar-client
```

## Providers

| id           | Provider   | Auth                       | Sandbox | Notes                                 |
| ------------ | ---------- | -------------------------- | ------- | ------------------------------------- |
| `cloudflare` | Cloudflare | API token + Account ID     | —       | manages existing domains only         |
| `dynadot`    | Dynadot    | API key                    | —       | key sent in query string (API design) |
| `gandi`      | Gandi.net  | API key                    | ✓       | `api.sandbox.gandi.net`               |
| `godaddy`    | GoDaddy    | key + secret               | ✓       | sandbox = OTE test environment        |
| `namecheap`  | Namecheap  | username + key + client IP | ✓       | XML API; IP allowlisting required     |
| `spaceship`  | Spaceship  | key + secret               | —       |                                       |

Each provider class exposes static discovery metadata — `displayName`,
`configFields` (the credential fields it needs), and `helpText` (where to get
them) — so you can build a credential UI generically.

## Usage

Construct a provider (directly or via the registry) and, optionally, wrap it in
the `RegistrarClient` facade:

```ts
import { RegistrarClient, createRegistrar } from '@aoxborrow/registrar-client';

const client = new RegistrarClient(
  createRegistrar('cloudflare', {
    apiToken: process.env.CF_API_TOKEN!,
    accountId: process.env.CF_ACCOUNT_ID!,
  })
);

await client.testConnection();
const domains = await client.listDomains();
await client.updateNameservers('example.com', ['ns1.example.net', 'ns2.example.net']);
```

Every provider implements the same interface: `testConnection`, `listDomains`,
`renewDomain`, `updateNameservers`, `lockDomain`, `unlockDomain`.

## Sandbox environments

Providers that offer a test environment accept `{ environment: 'sandbox' }` at
construction, so you can exercise real API calls without touching live domains:

```ts
const gd = createRegistrar('godaddy', oteCredentials, { environment: 'sandbox' });
```

Requesting `sandbox` on a provider that has none (`cloudflare`, `dynadot`,
`spaceship`) throws a `ConfigurationError` — a test can never silently hit
production. Check `SomeRegistrar.supportsSandbox` to discover which do.

### Integration tests

Real sandbox integration tests live in `test/integration/` and are **credential-
gated**: each registrar's suite skips unless its env vars are set, so the default
suite stays offline.

```bash
cp .env.example .env    # fill in sandbox credentials for the registrars you want
npm run test:integration
```

They exercise read-only operations (`testConnection`, `listDomains`) against each
configured sandbox. Unit tests (`npm test`) never make network calls.

## Architecture

The package separates the **caller-facing facade** from **provider
implementations**:

- **`RegistrarClient`** — a thin, provider-agnostic facade. Normalizes input and
  delegates to the configured provider.
- **`RegistrarProvider`** — the interface every backend implements
  (`testConnection`, `listDomains`, `renewDomain`, `updateNameservers`,
  `lockDomain`, `unlockDomain`).
- **`BaseRegistrar`** — an abstract base that owns the shared HTTP/auth/retry
  plumbing (via `HttpClient`) and provides `NotImplementedError`-rejecting
  defaults. Concrete providers extend it and override only what their API
  supports.
- **`HttpClient`** — a small `fetch` wrapper with timeout, `AbortSignal`
  linking, retry-with-backoff, `request`/`requestText` (JSON and raw/XML), and
  typed error mapping. No Node built-ins.
- **`parseXml` / `ensureArray`** — shared XML helpers (backed by
  `fast-xml-parser`) with one consistent config across XML providers: attributes
  kept, values left as raw strings so providers coerce them explicitly.
- **`registrars` / `createRegistrar`** — a registry of the built-in providers by
  id, and a factory to construct one.

### Adding a provider

Extend `BaseRegistrar`, pass a `baseUrl` + auth headers to `super()`, add the
static `displayName` / `configFields` / `helpText` metadata, override the
operations the API supports (mapping payloads to the shared types in
`src/types.ts`), and register the class in `src/registrars/registry.ts`. The six
existing providers under `src/registrars/` are working references.

## Errors

All failures throw a typed subclass of `RegistrarError` (`AuthenticationError`,
`NotFoundError`, `RateLimitError`, `TimeoutError`, `NotImplementedError`, …),
each carrying an HTTP-style `status`.

## Security

Credentials are sent as request **headers** wherever the registrar's API
supports it. Two providers require query-string authentication by their own API
design — **Dynadot** (`key`) and **Namecheap** (`ApiUser`/`ApiKey`) — so for
those the key necessarily appears in the request URL. This is noted in each
provider's source. Credentials are not interpolated into error messages.

## License

MIT © Aaron Oxborrow

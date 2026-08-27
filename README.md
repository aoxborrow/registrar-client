# @aoxborrow/registrar-client

A fully-typed, **browser- and edge-safe** client for domain registrar APIs, with a
pluggable multi-provider interface. Zero runtime dependencies — just `fetch`.

Runs anywhere `fetch` is available: modern Node.js (18+), browsers, Cloudflare
Workers, Deno, Bun, and other edge runtimes.

> **Status:** early. Six registrar providers are implemented (ported from a
> prior internal project); they have not yet been
> exercised against live APIs with real credentials.

## Install

```bash
npm install @aoxborrow/registrar-client
```

## Providers

| id           | Provider   | Auth                       | Notes                                 |
| ------------ | ---------- | -------------------------- | ------------------------------------- |
| `cloudflare` | Cloudflare | API token + Account ID     | manages existing domains only         |
| `dynadot`    | Dynadot    | API key                    | key sent in query string (API design) |
| `gandi`      | Gandi.net  | API key                    |                                       |
| `godaddy`    | GoDaddy    | key + secret + environment | `production` or `ote`                 |
| `namecheap`  | Namecheap  | username + key + client IP | XML API; IP allowlisting required     |
| `spaceship`  | Spaceship  | key + secret               |                                       |

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

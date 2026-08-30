# @aoxborrow/registrar-client

A fully-typed, **browser- and edge-safe** client for domain registrar APIs, with a
pluggable multi-provider interface. Speaks both JSON and XML registrar APIs.

Runs anywhere `fetch` is available: modern Node.js (20+), browsers, Cloudflare
Workers, Deno, Bun, and other edge runtimes. Its one runtime dependency —
[`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser)
(pure JS, no Node built-ins) — is used to parse XML registrar responses and is
itself edge-safe.

> **Status:** nine registrar providers implement the full 18-method core
> contract, plus their extended capabilities (auth code, DNSSEC, forwarding).
> Where a registrar's API genuinely can't do something, that method throws
> `NotImplementedError` with a specific reason — see
> [Supported functionality](#supported-functionality). Most read and write paths
> have been verified against live accounts or provider sandboxes (2026-08). Still
> treat paid, irreversible operations (register / renew / transfer) as
> use-at-your-own-risk: some remain documented-but-unrun on funded accounts.

## Install

```bash
npm install @aoxborrow/registrar-client
```

## Providers

| id           | Provider   | Auth                       | Sandbox | Notes                                        |
| ------------ | ---------- | -------------------------- | ------- | -------------------------------------------- |
| `cloudflare` | Cloudflare | API token + Account ID     | —       | manages existing domains only                |
| `dynadot`    | Dynadot    | API key                    | ✓       | `api-sandbox.dynadot.com`; key in query      |
| `gandi`      | Gandi.net  | API key                    | ✓       | `api.sandbox.gandi.net`                      |
| `godaddy`    | GoDaddy    | PAT, or key + secret       | ✓       | hybrid v3/v1; sandbox = OTE (v1 only)        |
| `namebright` | NameBright | client ID + secret         | —       | OAuth2 bearer; production-only               |
| `namecheap`  | Namecheap  | username + key + client IP | ✓       | XML API; IP allowlisting required            |
| `namesilo`   | NameSilo   | API key                    | ✓       | JSON/XML API; key sent in query string       |
| `porkbun`    | Porkbun    | key + secret               | ✓       | sandbox via `pk1_sb_` key; per-domain opt-in |
| `spaceship`  | Spaceship  | key + secret               | —       |                                              |

Each provider class exposes static discovery metadata — `displayName`,
`configFields` (the credential fields it needs), and `helpText` (where to get
them) — so you can build a credential UI generically.

Research notes for additional registrars live in
[`docs/registrars/`](docs/registrars). Three are documented but **not**
implemented because they have no usable public API: **Squarespace**
(reseller-program-gated), **Network Solutions** (partner-gated Partner Protocol /
SRSplus), and **eDomains** (WHMCS-based, no documented API). They can be added if
API access becomes available.

## Usage

Construct a provider (directly or via the `createRegistrar` factory) and, optionally, wrap it in
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
const [availability] = await client.checkAvailability(['example.com']);
const records = await client.getDnsRecords('example.com');
await client.updateNameservers('example.com', ['ns1.example.net', 'ns2.example.net']);
```

Every provider implements the same `Registrar` interface — the full core
contract is `testConnection`, `listDomains`, `getDomain`, `checkAvailability`,
`getPricing`, `registerDomain`, `renewDomain`, `setAutoRenew`, `transferIn`,
`updateNameservers`, `getNameservers`, `lockDomain`, `unlockDomain`,
`setPrivacy`, `getContacts`, `updateContacts`, `getDnsRecords`, and
`setDnsRecords`. All nine providers implement it; where a registrar's API can't
express a given method, that method throws `NotImplementedError` with a specific
reason (see [Supported functionality](#supported-functionality)). The gaps are
API limits, not missing work — e.g. **Cloudflare** has no post-registration write
endpoints, **Porkbun** exposes no transfer-lock / privacy / contact-read toggles,
**NameBright** has no transfer-in endpoint, and **Spaceship** / **NameBright**
have no pricing endpoint. **Namecheap** and **Gandi** are the only providers with
a real per-TLD `getPricing` table; **GoDaddy** and **Dynadot** price per-domain
via their availability endpoint.

## Listing domains & portfolios

`listDomains` returns the **full account**, paginating internally at each
provider's maximum page size (so it makes the fewest requests each API allows).
Its only option is `search` — a domain-name substring filter, applied server-side
where the API supports it (**Namecheap** `SearchTerm`, **Gandi** `fqdn`) and
client-side everywhere else. The usual request options (timeout/retries/signal)
still apply.

```ts
const all = await client.listDomains();
const acme = await client.listDomains({ search: 'acme' });
```

Nameservers come back **in the single list call** on **GoDaddy** (via
`includes=nameServers`), **Gandi**, **Spaceship**, and **Dynadot**. The others
(**Namecheap**, **Porkbun**, **NameSilo**, **NameBright**) don't return
nameservers from their list endpoint — use `getNameservers` / `getDomain`
per domain for those. **Cloudflare** manages nameservers via its Zones API, not
the Registrar list.

To build a combined view across registrars, `listPortfolio` fans out over many
providers concurrently with per-registrar error isolation (one provider being
down never sinks the whole view). Every `Domain` already carries its `registrar`:

```ts
import { listPortfolio, createRegistrar } from '@aoxborrow/registrar-client';

const { domains, errors } = await listPortfolio([
  createRegistrar('godaddy', godaddyCreds),
  createRegistrar('namecheap', namecheapCreds),
  createRegistrar('gandi', gandiCreds),
]);
// domains: Domain[] (each tagged with .registrar); errors: { registrar, error }[]
```

## Supported functionality

What each provider implements today, read straight from the code. **Core** methods
are the guaranteed contract; **extended** methods are opt-in per provider.

**Legend:** ✓ implemented · ✗ not available via the provider's API (throws
`NotImplementedError`) · a superscript marks a caveat noted below.

| Core method         | CF  | DY  | GA  | GD  | NB  | NC  | NS  | PB  | SP  |
| ------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `testConnection`    | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   |
| `listDomains`       | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   |
| `getDomain`         | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   |
| `checkAvailability` | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   |
| `getPricing`        | ✓   | ✓ᵃ  | ✓   | ✓ᵃ  | ✗ᵇ  | ✓   | ✓   | ✓   | ✗ᵇ  |
| `registerDomain`    | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   |
| `renewDomain`       | ✗ᶜ  | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   |
| `setAutoRenew`      | ✗ᶜ  | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   |
| `transferIn`        | ✗ᶜ  | ✓   | ✓   | ✓   | ✗ᵈ  | ✓   | ✓   | ✓   | ✓   |
| `updateNameservers` | ✗ᶜ  | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   |
| `getNameservers`    | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   |
| `lockDomain`        | ✗ᶜ  | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✗ᵉ  | ✓   |
| `unlockDomain`      | ✗ᶜ  | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✗ᵉ  | ✓   |
| `setPrivacy`        | ✓   | ✓   | ✓ᶠ  | ✓ᵍ  | ✓   | ✓   | ✓   | ✗ᵉ  | ✓   |
| `getContacts`       | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✗ᵉ  | ✓   |
| `updateContacts`    | ✗ᶜ  | ✓   | ✓   | ✓   | ✗ᵈ  | ✓   | ✓   | ✓   | ✓   |
| `getDnsRecords`     | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   |
| `setDnsRecords`     | ✓   | ✓ʰ  | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓ʰ  |

| Extended method       | CF  | DY  | GA  | GD  | NB  | NC  | NS  | PB  | SP  |
| --------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `getAuthCode`         | ✗   | ✓   | ✓   | ✓   | ✓   | ✗ⁱ  | ✗ⁱ  | ✗   | ✓   |
| `getDnssec`           | ✗   | ✓   | ✓   | ✗   | ✗   | ✗   | ✓   | ✓   | ✗   |
| `disableDnssec`       | ✗   | ✓   | ✓   | ✗   | ✗   | ✗   | ✓   | ✓   | ✗   |
| `getEmailForwarding`  | ✓   | ✓   | ✓   | ✗   | ✗   | ✓   | ✓   | ✗   | ✗   |
| `setEmailForwarding`  | ✓   | ✓   | ✓   | ✗   | ✗   | ✓   | ✓   | ✗   | ✗   |
| `getDomainForwarding` | ✓   | ✓ʲ  | ✓ᵏ  | ✓ˡ  | ✗   | ✓   | ✓ʲ  | ✓   | ✗   |
| `setDomainForwarding` | ✓   | ✓ʲ  | ✓ᵏ  | ✓ˡ  | ✗   | ✓   | ✓ʲ  | ✓   | ✗   |

`CF` Cloudflare · `DY` Dynadot · `GA` Gandi · `GD` GoDaddy · `NB` NameBright ·
`NC` Namecheap · `NS` NameSilo · `PB` Porkbun · `SP` Spaceship.

**Caveats**

- **ᵃ** `getPricing` is per-domain only (pass a full name, not a bare TLD) —
  Dynadot and GoDaddy price via their availability endpoint and have no per-TLD
  price table.
- **ᵇ** No pricing endpoint at all; a per-domain registration price is still
  available through `checkAvailability`.
- **ᶜ** Cloudflare Registrar has no post-registration write API — auto-renew,
  privacy, and lock are settable only at registration; nameserver changes require
  Cloudflare support; there is no renew, transfer-in, or contact-update endpoint.
  These throw with a message pointing to the dashboard.
- **ᵈ** NameBright's REST API has no transfer-in or contact-update endpoint.
- **ᵉ** Porkbun exposes the transfer-lock and privacy state read-only (settable
  only at registration) and has no WHOIS/contact-read endpoint.
- **ᶠ** Gandi `setPrivacy(false)` is a no-op for individual registrants — WHOIS
  stays obfuscated for GDPR.
- **ᵍ** GoDaddy `setPrivacy`: enabling is a paid add-on (not implemented);
  disabling works for paid privacy, but GoDaddy's free privacy ("Free DBP")
  cannot be disabled via the API (returns a clear error pointing to the dashboard).
- **ʰ** `setDnsRecords` writes cover the common record types; SRV/CAA and other
  sub-field-bearing types throw on write (reads handle every type).
- **ⁱ** Namecheap and NameSilo only email the EPP/auth code to the registrant;
  it can't be returned synchronously.
- **ʲ** Dynadot and NameSilo forward the whole domain (a single `@` rule);
  clearing a forward restores the default nameservers.
- **ᵏ** Gandi web redirects are subdomain-only — the apex (`@`) is rejected.
- **ˡ** GoDaddy domain forwarding uses the v2 customer-scoped API, so it requires
  a `customerId` (the customer UUID, or a numeric shopper ID the client resolves to
  the UUID via an sso-key-only lookup); the old v1 forwarding route was removed.

For the deeper cross-provider notes and per-registrar quirks, see
[docs/registrars/FEATURES.md](docs/registrars/FEATURES.md).

## Capabilities

Registrars don't all support the same operations. **Core** is a fixed contract
every provider is expected to fulfil (inherited by extending `BaseRegistrar`);
**extended** capabilities are opt-in and declared per provider. Where a core
method's API path isn't wired up yet, it throws `NotImplementedError` — the
contract is the promise, not a claim that every byte is implemented today.

Reference capabilities through the `Feature` object (autocomplete +
find-all-references), and introspect statically — no instance or credentials
needed, which makes this easy to surface to a UI or an MCP tool:

```ts
import { registrars, createRegistrar, Feature, CORE_FEATURES } from '@aoxborrow/registrar-client';

registrars.dynadot.features; // full set: core + Dynadot's extras
registrars.dynadot.extendedFeatures; // just the extras
CORE_FEATURES.includes(Feature.GetDnsRecords); // true — DNS is core

const gd = createRegistrar('godaddy', creds);
gd.supports(Feature.RegisterDomain); // true (core)
gd.supports(Feature.GetAuthCode); // true (its extended)
gd.supports(Feature.SetDomainForwarding); // false (not declared)
```

See [docs/registrars/FEATURES.md](docs/registrars/FEATURES.md) for the full
feature matrix and the core vs. extended breakdown.

## Forwarding

Two opt-in extended capabilities cover forwarding, both modelled as replace-all
sets:

- **Domain (URL) forwarding** — `getDomainForwarding` / `setDomainForwarding`
  take `DomainForward[]` (`{ host, url, type }`). `host` is apex-relative (`@`,
  `www`, …); `type` is `temporary` (302) or `permanent` (301). HTTPS targets work
  wherever the provider issues a certificate for the domain (all supported
  providers do).
- **Email forwarding** — `getEmailForwarding` / `setEmailForwarding` take
  `EmailForward[]` (`{ alias, forwardTo }`). `alias` is the local part; `*` (or
  `@`) is the catch-all. This is alias→inbox **forwarding**, not mailbox hosting.

**Masked/framed forwarding is read-only.** `DomainForwardType` also has a
`masked` value — a "cloaked" forward where an iframe keeps the source URL in the
address bar. The library **never creates** one (`setDomainForwarding` rejects
`masked`): it breaks HTTPS, SEO, and modern browser protections, and several
providers (e.g. Cloudflare) can't do it at all. But `getDomainForwarding`
**reports** `masked` truthfully when a provider already has one configured, so
reading state stays accurate. (One consequence: reading a masked forward and
writing the same array straight back is rejected — by design.)

Providers that expose a native forwarding feature do this in one call.
**Cloudflare** has no such primitive, so the provider composes it from other
Cloudflare APIs: domain forwarding writes a Rules redirect plus a proxied
placeholder DNS record so the edge can apply it, and email forwarding uses Email
Routing (enabling it adds the required MX/SPF records). Email Routing
destinations must be verified on the Cloudflare account before a rule activates;
where the token can manage addresses, `setEmailForwarding` adds any unknown
destination (sending its verification email) and reports which are still
pending. See [docs/registrars/cloudflare.md](docs/registrars/cloudflare.md).

## Registering & transferring domains

Registering or transferring a domain forms a legal contract with the registry, so
registrars gate `registerDomain`/`transferIn` behind **consent** to their
agreements. Consent is supplied **per operation** (matching how the registrar
APIs model it — there is no "consent once" server state):

```ts
await client.registerDomain('example.com', {
  years: 1,
  contacts: { registrant: { firstName: 'Ada', lastName: 'Lovelace' /* … */ } },
  consent: { agreedBy: userIpAddress }, // the consenting party's IP
});

await client.transferIn('example.com', {
  authCode: 'EPP-CODE-FROM-LOSING-REGISTRAR',
  consent: { agreedBy: userIpAddress },
});
```

You only affirm **who** consents (`agreedBy` — the consenting user's IP address)
and optionally **when** (`agreedAt`, defaulting to now). The provider fetches the
specific per-TLD agreement documents itself and attaches them. Omitting `consent`
throws `ConsentRequiredError` (distinct from `NotImplementedError` — the
capability exists; you just have to consent).

Contacts are supplied on the same call, where the registrar needs them: GoDaddy
and Spaceship take a full contact set on registration (omitted roles fall back to
the registrant); Namecheap requires all four roles; Dynadot and Porkbun use the
account's default WHOIS contact. Transfers carry over the existing contacts, so
most providers need only the auth code (`TransferDomainInput`).

> `registerDomain` is implemented for **all nine providers**, and `transferIn`
> for every one whose API has a transfer endpoint (all except **Cloudflare** and
> **NameBright**). `registerDomain` has been exercised live against several
> sandboxes and one real account (Cloudflare `example.dev`), but since
> these operations spend real money, treat any path you haven't run yourself as
> documented-but-unverified. Known gap: Namecheap registration doesn't yet send
> per-TLD extended attributes, so TLDs that require them (`.us`, `.eu`, …) aren't
> registrable there yet.

## Sandbox environments

Providers that offer a test environment accept `{ environment: 'sandbox' }` at
construction, so you can exercise real API calls without touching live domains:

```ts
const gd = createRegistrar('godaddy', oteCredentials, { environment: 'sandbox' });
```

Requesting `sandbox` on a provider that has none (`cloudflare`, `namebright`,
`spaceship`) throws a `ConfigurationError` — a test can never silently hit
production. Check `SomeRegistrar.supportsSandbox` to discover which do.

Some providers key their sandbox off the **credential**, not a separate host.
**Porkbun**'s sandbox shares the production base URL — a sandbox key is prefixed
`pk1_sb_`, starts with $1,000 of fake credit, and marks every response with
`"sandbox": true` (top up / reset via `POST /sandbox/topup` · `POST
/sandbox/reset`). There, `{ environment: 'sandbox' }` is cosmetic; the `pk1_sb_`
key is what routes to the test environment.

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
- **`Registrar`** — the core interface every backend implements (the 18 core
  operations listed under [Usage](#usage), plus the capability accessors).
  Defined in `src/types.ts`, with shared payload types (`Contact`, `DnsRecord`,
  `DomainAvailability`, `TldPricing`, `RegisterDomainInput`) alongside it.
- **`BaseRegistrar`** (`src/registrar.ts`) — an abstract base that owns the
  shared HTTP/auth/retry plumbing (via `HttpClient`) and provides
  `NotImplementedError`-rejecting defaults. Concrete providers under
  `src/registrars/` extend it and override only what their API supports.
- **`HttpClient`** — a small `fetch` wrapper with timeout, `AbortSignal`
  linking, retry-with-backoff, `request`/`requestText` (JSON and raw/XML), and
  typed error mapping. No Node built-ins.
- **`parseXml` / `ensureArray`** — shared XML helpers (backed by
  `fast-xml-parser`) with one consistent config across XML providers: attributes
  kept, values left as raw strings so providers coerce them explicitly.
- **`registrars` / `createRegistrar`** — a lookup of the built-in providers by
  id, and a factory to construct one.

### Adding a provider

Extend `BaseRegistrar`, pass a `baseUrl` + auth headers to `super()`, add the
static `displayName` / `configFields` / `helpText` metadata, override the
operations the API supports (mapping payloads to the shared types in
`src/types.ts`), and add the class to `src/registrars/index.ts`. The existing
providers under `src/registrars/` are working references.

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

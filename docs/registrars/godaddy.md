# GoDaddy — Domains API Research

> Researched: 2026-08-26 · Docs: https://developer.godaddy.com/doc · https://developer.godaddy.com/en/docs/references/rest/domains

## Overview

GoDaddy exposes domain search, registration, DNS, contact, privacy, forwarding, and transfer management through a REST API spanning three concurrent version namespaces (v1 account-scoped, v2 v1+async operations, v3 quote-execute discovery/registration). Base URL is `https://api.godaddy.com`; docs also reference a separate OTE (test) environment at `https://api.ote-godaddy.com` for the classic/v1-v2 API surface, though GoDaddy's newest (2026) developer-platform docs describe production as the only environment for the new v3 API ("no local dev server — all requests go to production"), so OTE availability may now be limited to the legacy v1/v2 surface — treat this as ambiguous and verify per-version at implementation time.

## Implementation (2026-08-29): hybrid v3-first / v1-fallback

The provider is a **hybrid** and resolves the OTE/v3 ambiguity above with live
probes:

- **v3 is discovery + registration + DNS + nameservers only** (14 operations
  total). It has **no** endpoints for renew, transfer, auto-renew toggle,
  lock/unlock, privacy, or contact updates — those live only in v1/v2. The v3
  `Domain` record exposes `autoRenew`/`privacy`/`transferLock` read-only,
  settable only at registration.
- **OTE serves v1/v2 only — not v3.** `GET https://api.ote-godaddy.com/v3/...`
  → 404; `/v1/...` → 401. So v3 has no sandbox, and the only safe way to test
  paid writes (register/renew/transfer) is the **v1 endpoints on OTE**.
- **v3 requires a PAT** (`Authorization: Bearer`); sso-key is rejected on v3 and
  deprecated by GoDaddy in 2026 on v1/v2. A PAT also works on v1 (verified: v1
  GET 200, PATCH 204).

**Routing** (`useV3` in `src/registrars/godaddy.ts`): v3 is used only in
production **with a PAT**. With an sso-key, or against OTE/sandbox, every call
falls back to v1. Management ops are always v1. The base URL is the host root
(`https://api.godaddy.com` / `https://api.ote-godaddy.com`) and each call is
version-qualified (`/v3/domains/...` or `/v1/domains/...`).

**Credentials**: `apiToken` (PAT) for production/v3, or `apiKey` + `apiSecret`
(OTE Key/Secret) with `{ environment: 'sandbox' }` for OTE. The auth header is
chosen automatically (Bearer if a token is present, else sso-key).

**v3 shape notes** (verified live): bulk availability is `POST
/v3/domains/check-availability` `{domains}` → `{items:[…]}` (not `domains`);
prices are "Simple Money" integer **minor units** (`value/100`); standard names
report `inventory:"REGISTRY"` (premium ⇒ matches `/PREMIUM/`); `pageSize` maxes
at **200** for domain-names and **100** for dns-records; DNS is per-record
POST/PUT/DELETE (no bulk PUT — `setDnsRecords` diffs); registration is async
(202 → poll `/v3/domains/operations/{id}`); nameserver PUT body is a bare array.

**v3 registration** (verified live by registering a real $1.19 `.xyz`): the
execute body must be **minimal** — `{ domain, period, quoteToken, consent:{
agreementTypes, agreedAt } }`. Hard-won gotchas:

- **No `profile` block.** Sending one (contacts / autoRenew / privacy /
  nameServers) is rejected `INVALID_BODY`. Contacts come from the **account
  identity** (the quote's `resolved.contactSource: "ACCOUNT"`), and `agreedBy`
  is derived server-side from the token + caller IP. `registerDomainV3` therefore
  applies `autoRenew` (always, since GoDaddy registers with the account default —
  typically ON) and `nameservers` as **post-registration** steps.
- **`consent.acknowledgedFees` must be omitted** for a standard REGISTRY
  registration — the array is `minItems: 1`, so `[]` is rejected. Include it only
  when the quote returned a non-empty `fees` array (premium), echoed verbatim.
- **`Idempotency-Key` header is required** on the execute endpoints
  `POST /v3/domains/registrations` and `PUT /v3/domains/domain-names/{d}/nameservers`
  (400 `MISSING_VALUE` without it); the client sends a `crypto.randomUUID()`.
  DNS record writes do not require it.
- **Premium / aftermarket domains are not registrable via the v3 API**
  (`available:false` with no price, or `422 UNSUPPORTED_AFTERMARKET_DOMAIN`) even
  when for sale on the website. Short numeric `.xyz` are premium; 10-digit numeric
  `.xyz` fall into standard `REGISTRY` at $1.19.

**Verified live** (prod + PAT, against a real domain): full v3 read surface
(testConnection, listDomains, getDomain, checkAvailability incl. price
conversion, getPricing, getDnsRecords); v3 `registerDomain` (quote→execute→poll,
a real purchase); v3 `setDnsRecords` (reversible TXT add/remove) and
`updateNameservers` (reversible swap — note GoDaddy **serializes** NS changes, so
overlapping PUTs clobber each other; propagation ~8s); and v1-via-PAT
`setAutoRenew` + `lock`/`unlock` + `getContacts`. Reads are **eventually
consistent** across the v1-write / v3-read boundary, so management assertions must
poll rather than read back immediately. OTE v1 (testConnection, listDomains,
checkAvailability) also verified. **Not run**: `renewDomain` / `transferIn`
(v1-only, paid/irreversible, and OTE purchases need a paid API Reseller account
with Good as Gold — a plain developer key returns `500 ERROR_UNKNOWN`);
`updateContacts` (skipped — a registrant change triggers the ICANN verification /
60-day-lock workflow) and `setPrivacy`. See `docs/TODOS.md`.

## Authentication

Two auth schemes coexist: the legacy `sso-key {API_KEY}:{API_SECRET}` header (used with v1/v2, noted as deprecating in 2026) and newer scoped Personal Access Tokens (PAT) sent as `Authorization: Bearer <PAT>` (required for v3, supported everywhere). PATs are generated from the developer dashboard, can carry granular scopes (e.g. `domains.domain:read`, `domains.dns:update`, `domains.transfer:execute`), can be set to expire, and can be revoked individually. Auth is account-scoped (acts on the domains owned by the authenticated GoDaddy account); v2 additionally paths requests under `/v2/customers/{customerId}/domains/...` for reseller/customer scoping. No IP allowlisting is documented. Rate limits apply per-credential (recent docs cite roughly 600 requests per ~23-minute window; legacy docs cited 60 req/min), returning `429` with a `Retry-After` header; `RateLimit-*` response headers report remaining quota.

## Feature Support

| Feature                                     | Support | Notes / endpoint                                                                                                                                                                               |
| ------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test connection / verify credentials        | ~       | No dedicated ping endpoint documented; typically verified via `GET /v1/domains` or a scoped read call.                                                                                         |
| List domains                                | ✓       | `GET /v1/domains` — domains owned by the authenticated account.                                                                                                                                |
| Get single domain details                   | ✓       | `GET /v1/domains/{domain}` (v1); `GET /v3/domains/registrations/{registrationId}` for v3-registered domains.                                                                                   |
| Check domain availability                   | ✓       | `GET /v3/domains/check-availability` (or legacy `GET /v1/domains/available`); returns pricing options.                                                                                         |
| Get domain/TLD pricing                      | ✓       | Returned inline with availability check; v3 quote flow (`POST /v3/domains/registration-quotes`) price-locks via `quoteToken`.                                                                  |
| Register a new domain                       | ✓       | v3 quote-then-execute: `POST /v3/domains/registration-quotes` → `POST /v3/domains/registrations` (async, poll `GET /v3/domains/operations/{operationId}`); legacy `POST /v1/domains/purchase`. |
| Renew a domain                              | ✓       | v1/v2 endpoint (`POST /v1/domains/{domain}/renew`); stated as remaining on v1/v2, out of scope for v3.                                                                                         |
| Auto-renew toggle                           | ✓       | Managed via domain settings update on `PATCH /v1/domains/{domain}`.                                                                                                                            |
| Transfer domain in                          | ✓       | v1/v2 `POST /v1/domains/{domain}/transfer` (inbound transfer initiation).                                                                                                                      |
| Transfer out / get auth/EPP code            | ~       | Outbound transfer supported per doc summary ("inbound and outbound transfers"); explicit EPP/auth-code retrieval endpoint not confirmed in fetched pages.                                      |
| Update nameservers                          | ✓       | `PATCH /v1/domains/{domain}` (nameservers field) and v3 nameserver management endpoints.                                                                                                       |
| Get nameservers                             | ✓       | Included in `GET /v1/domains/{domain}` / v3 domain read.                                                                                                                                       |
| Lock / unlock domain (transfer lock)        | ✓       | Registry lock flag on domain settings (`PATCH /v1/domains/{domain}`), read/toggle per domain-management-concepts doc.                                                                          |
| Get/set WHOIS privacy                       | ✓       | `DELETE /v1/domains/{domain}/privacy` (cancel privacy); privacy purchase/status via domain settings — full CRUD not fully confirmed.                                                           |
| Update contact info (registrant/admin/tech) | ✓       | `PATCH /v1/domains/{domain}/contacts` (v1); registrant changes trigger ICANN approval workflow.                                                                                                |
| DNS record management                       | ✓       | `GET/PUT/PATCH/DELETE /v1/domains/{domain}/records[/{type}/{name}]` — full CRUD, but only for domains on GoDaddy's authoritative nameservers.                                                  |
| DNSSEC management                           | ~       | No dedicated DNSSEC endpoint documented; DS records manageable via the generic DNS records endpoint (`/v1/domains/{domain}/records/DS`).                                                       |
| Glue / host records                         | ✗       | Not documented in fetched pages.                                                                                                                                                               |
| Email forwarding / mailbox provisioning     | ✗       | Not part of the Domains API; email/Microsoft 365 products are separate GoDaddy offerings.                                                                                                      |
| Domain forwarding / URL redirect            | ✓       | Forwarding capability listed under v1 (and v2 async variant); exact endpoint path not confirmed.                                                                                               |
| Webhooks / event notifications              | ~       | v2 adds "async operation tracking — action queues, status polling, notifications" — notification mechanism unclear (polling vs. push webhook) from available docs.                             |

## Notable / Unique Features

- **Quote-then-execute registration (v3)**: price is locked via a `quoteToken` before purchase, then executed with an idempotency key — reduces race conditions between availability check and purchase. Generic method: `quoteRegistration(domain, params)` → `executeRegistration(quoteToken, idempotencyKey)`.
- **Agent/LLM-oriented platform**: GoDaddy's 2026 developer platform relaunch explicitly targets AI agents as first-class API consumers, with a CLI tool and machine-readable OpenAPI specs designed for programmatic/LLM tooling.
- **Scoped, expiring Personal Access Tokens**: fine-grained per-capability scopes (read/write per domain, DNS, transfer) and token expiry/revocation, beyond a single static API key/secret pair. Generic: `createScopedToken(scopes[], expiry)`.
- **Async operation polling model (v2/v3)**: write operations return `202 Accepted` with an operation/status URL to poll rather than synchronous completion — useful pattern for a common `pollOperation(operationId)` abstraction.

## Auth / Access Notes for Implementors

- Credentials: generate via the GoDaddy developer dashboard (https://developer.godaddy.com) — legacy API Key/Secret pair (`sso-key`) or a new Personal Access Token with selected scopes.
- **Account requirements (critical, historically restrictive)**: As of a April 30 – May 1, 2024 policy change, GoDaddy cut off production API access for smaller accounts — the Availability API required 50+ domains in the account, and Management/DNS APIs required 10+ domains and/or an active Discount Domain Club – Premier Membership. GoDaddy's newer (2026) developer-platform announcement states "any GoDaddy account can generate a token and start calling," which suggests this may have loosened for the new v3 surface — but this is not confirmed against the legacy v1/v2 domain-count gating, and the two statements are not reconciled in the docs fetched. **Verify current eligibility directly with GoDaddy (or via a live token call) before assuming either policy applies**, especially for accounts with few domains.
- Reseller/API-reseller accounts have a separate onboarding path (`Set up my API Reseller account`) and are subject to GoDaddy's API Terms of Use, which prohibit reselling/sublicensing API access to third parties without written authorization.
- Sandbox: classic docs describe a free, pre-funded OTE environment (`api.ote-godaddy.com`) using a separate Test API key/secret, isolated from production (no data crossover). It is unclear whether OTE is available for the new v3 endpoints.
- Rate limits: per-credential; recent docs cite ~600 requests per ~23-minute window (older docs cited 60 req/min per endpoint) — treat published numbers as illustrative and read `RateLimit-*` response headers at runtime. Contact GoDaddy developer support for higher limits.

## Sources

- https://developer.godaddy.com/doc
- https://developer.godaddy.com/en/docs/references/rest/domains
- https://developer.godaddy.com/en/docs/references/rest/domains/v1
- https://developer.godaddy.com/en/docs/references/rest/domains/v3
- https://developer.godaddy.com/en/docs/references/rest/domains/v2/domains-api-usage
- https://developer.godaddy.com/en/docs/api-users/how-godaddy-apis-work
- https://developer.godaddy.com/en/docs/api-users/concepts/domain-management-concepts
- https://developer.godaddy.com/getstarted
- https://developer.godaddy.com/docs/api-users/rate-limits
- https://www.godaddy.com/resources/news/introducing-the-godaddy-developer-platform-domain-apis-for-developers-and-their-agents
- https://community.letsencrypt.org/t/godaddy-no-longer-allows-api-access-to-clients-e-g-for-dns-based-cert-renewal-if-you-have-less-than-50-domains/219377
- https://www.godaddy.com/legal/agreements/godaddy-api-terms-of-use

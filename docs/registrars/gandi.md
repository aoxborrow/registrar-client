# Gandi — API Research

> Researched: 2026-08-26 · **Live-verified: 2026-08-29** · Docs: https://api.gandi.net/docs/ · https://api.gandi.net/docs/domains/ · https://api.gandi.net/docs/livedns/ · https://api.gandi.net/docs/mailbox/ · https://api.gandi.net/docs/authentication/

## Live verification (2026-08-29)

Exercised end-to-end against the OTE **sandbox** (`https://api.sandbox.gandi.net/v5`,
PAT via `Authorization: Bearer`) on a freshly registered test domain. Every write
path below ran live and was read back, except `transferIn` (needs an external
domain + auth code, not reproducible in the sandbox).

**Writes — all verified:**

- `registerDomain` — `POST /domain/domains`. **Gotcha:** the `owner.state` must be
  the ISO 3166-2 subdivision code (`US-CA`), not the bare `CA` our normalized
  `Contact` carries — Gandi rejects a 2-letter state as "shorter than minimum
  length 4". Callers targeting Gandi should pass the full subdivision code.
- `renewDomain` — `POST .../renew` (202, async; expiry advanced on read-back).
- `updateNameservers` — `PUT .../nameservers` returns **202 "allow 12-24h for
  propagation"**; request shape confirmed accepted (read-back reflects it only
  after propagation).
- `updateContacts` — `PATCH .../contacts`; tech-role phone changed and read back.
- `setAutoRenew` — `PATCH .../autorenew`. **Gotcha:** disabling on a domain that
  never had an autorenew record 400s ("no autorenew record"); the client now
  treats that as idempotent success (that state already means off).
- `lockDomain` / `unlockDomain` — `PATCH .../status` with `clientTransferProhibited`
  (async 202). Back-to-back status changes collide with a "pending operation"
  400 — expected; from a settled state each flips correctly.
- `setDnsRecords` — LiveDNS `PUT .../records` full-zone replace; lossless
  get→set→get round-trip (incl. MX priority split).
- `setEmailForwarding` — `/email/forwards` diff (POST/PUT/DELETE); set/read/clear.
- `disableDnssec` — LiveDNS key delete; idempotent success when no keys exist.
- `getAuthCode` — `authinfo` on the domain detail; returned a real EPP code.
- `getDomainForwarding` / `setDomainForwarding` — **newly built** on the
  `webredirs` endpoint (see below).
- `setPrivacy` — enabling is the natural default; **disabling is accepted (202)
  but a no-op for individual registrants** — Gandi keeps WHOIS obfuscation on for
  GDPR. The request is well-formed; the outcome is Gandi policy.

**Web / URL forwarding (`webredirs`) — discovered + built live:**
`GET/POST/DELETE /v5/domain/domains/{fqdn}/webredirs[/{fqdn}]`. `host` is the full
FQDN of the source subdomain; `type` is `http301` (permanent) / `http302`
(redirect) / `cloak` (frame). **Per-subdomain only** — the apex (`@` / bare
domain) 500s, so the client rejects it up front. **No PUT** — updating a redirect
is delete-then-recreate. Sending `protocol: https` makes Gandi provision a
Let's Encrypt cert and **500s in the sandbox**, so the client omits `protocol`
(Gandi defaults to `http`).

## Overview

Gandi's "Public API v5" is a REST/JSON API split into product-specific sub-APIs (Domain, LiveDNS, Mailbox, Email, Certificate, Simple Hosting, Organization, Billing). Production base URL is `https://api.gandi.net/v5/<product>/...` (e.g. `https://api.gandi.net/v5/domain/domains`); a fully separate sandbox environment is available at `https://api.sandbox.gandi.net/v5/...` with its own accounts/credentials for safe testing before hitting production.

## Authentication

Two mechanisms exist, both sent via the `Authorization` header:

- **Personal Access Token (PAT)** — current recommended method: `Authorization: Bearer <token>`. Created in the Gandi Admin app (Organization → Sharing tab → "Create a token"), scoped to a single organization and to a fine-grained set of permissions/resources chosen at creation time. PATs expire, so implementors need a rotation/refresh strategy.
- **API Key (legacy/deprecated)** — `Authorization: Apikey <key>`. Grants full access equivalent to the owning account; not scopable, not auditable by org admins, and not tied to a specific organization. Gandi is actively pushing users toward PATs and documents API Keys as a legacy path.

There is no separate "IP allowlisting" documented for the v5 API. Requests are otherwise account/organization-scoped — resources belong to a Gandi "Organization," and a token/key only sees what its owning account/org has access to.

## Feature Support

| Feature                                     | Support | Notes / endpoint                                                                                                                                                                                                                         |
| ------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test connection / verify credentials        | ~       | No dedicated "whoami" endpoint documented for Domain API; typically verified via `GET /v5/organization/user-info` or any low-cost authenticated GET (e.g. list domains).                                                                 |
| List domains                                | ✓       | `GET /v5/domain/domains` (filter/sort supported)                                                                                                                                                                                         |
| Get single domain details                   | ✓       | `GET /v5/domain/domains/{domain}` (contacts, status, nameservers, dates)                                                                                                                                                                 |
| Check domain availability                   | ✓       | `GET /v5/domain/check` — availability + pricing across processes (create/renew/transfer)                                                                                                                                                 |
| Get domain/TLD pricing                      | ✓       | Returned as part of `GET /v5/domain/check`; also `GET /v5/domain/tlds` for TLD-level rules                                                                                                                                               |
| Register a new domain                       | ✓       | `POST /v5/domain/domains` — owner/admin/tech/bill contacts + nameservers in payload                                                                                                                                                      |
| Renew a domain                              | ✓       | Documented under Domain API renewal operations (procedure endpoint per domain)                                                                                                                                                           |
| Auto-renew toggle                           | ✓       | `PATCH /v5/domain/domains/{domain}/autorenew`                                                                                                                                                                                            |
| Transfer domain in                          | ✓       | Domain API transfer-in procedure (submit authinfo/EPP code + contacts)                                                                                                                                                                   |
| Transfer out / get auth/EPP code            | ✓       | `PUT /v5/domain/domains/{domain}/authinfo` — (re)generates auth code, emailed/available to registrant                                                                                                                                    |
| Update nameservers                          | ✓       | `PUT /v5/domain/domains/{domain}/nameservers` (or via LiveDNS `GET /v5/livedns/domains/{fqdn}/nameservers`)                                                                                                                              |
| Get nameservers                             | ✓       | `GET /v5/domain/domains/{domain}/nameservers`                                                                                                                                                                                            |
| Lock / unlock domain (transfer lock)        | ~       | Exposed via domain status flags (`clientTransferProhibited` etc.) rather than a single dedicated toggle endpoint; set through domain update payload.                                                                                     |
| Get/set WHOIS privacy                       | ~       | Gandi masks personal WHOIS data by default per ICANN/GDPR rules rather than an explicit per-domain on/off toggle in all cases; some TLD-specific privacy controls exist in the domain contact payload.                                   |
| Update contact info (registrant/admin/tech) | ✓       | Via `POST/PATCH` on domain contacts / `POST /v5/domain/changeowner/{domain}` for ownership change (with FOA email flow)                                                                                                                  |
| DNS record management                       | ✓       | LiveDNS API: `GET/POST/PUT/DELETE /v5/livedns/domains/{fqdn}/records[/{name}[/{type}]]` — full zone or per-record CRUD                                                                                                                   |
| DNSSEC management                           | ✓       | LiveDNS: `GET/POST/PATCH/DELETE /v5/livedns/domains/{fqdn}/keys[/{id}]`                                                                                                                                                                  |
| Glue / host records                         | ✓       | Domain API glue-records endpoint — dict of nameserver → list of IPs                                                                                                                                                                      |
| Email forwarding / mailbox provisioning     | ✓       | Mailbox API (beta): `.../v5/mailbox/forwards` for forwards (requires ≥1 mailbox on source domain, capped at 1000 forwards/domain); Email API (current) for mailbox provisioning                                                          |
| Domain forwarding / URL redirect            | ✓       | Dedicated web-forwarding endpoint `GET/POST/DELETE /v5/domain/domains/{fqdn}/webredirs[/{fqdn}]`; per-subdomain only (no apex), `type` = `http301`/`http302`/`cloak`. No PUT (update = delete + recreate). Verified live in the sandbox. |
| Webhooks / event notifications              | ✗       | No webhook/event-notification system found in current v5 REST docs; legacy XML-RPC "Notification API" (v3.3.38) exists but is not part of v5                                                                                             |

## Notable / Unique Features

- **LiveDNS** — Gandi's own low-latency anycast DNS hosting product with full zone/record REST management, DNSSEC key management, AXFR/TSIG secondary-DNS support, and automatic zone snapshots. Generic method: `manageDnsZone(domain, records)` / `setDnssec(domain, keys)`.
- **Mailbox/Email products** — Gandi sells and provisions actual mailboxes (not just forwarding) via its Email and Mailbox (beta) APIs. Generic method: `provisionMailbox(domain, mailboxConfig)`.
- **Sandbox environment** — a fully separate `api.sandbox.gandi.net` deployment with its own signup/credentials for safe end-to-end testing of registration, transfers, etc. Generic method/concept: `useSandboxEnvironment(true)`.
- **Fine-grained Personal Access Tokens** — scoped-permission, single-organization, expiring tokens (vs. all-or-nothing legacy API keys). Generic concept: `createScopedApiToken(scopes, orgId, expiry)`.
- **AXFR/TSIG secondary DNS** — API-managed zone transfer to external secondary nameservers. Generic method: `configureZoneTransfer(domain, slaveIps, tsigKey)`.

## Auth / Access Notes for Implementors

- Get credentials from the Gandi Admin app (admin.gandi.net) → Organization → account/sharing settings → "Create a token" to mint a PAT; select the organization and scope permissions at creation.
- Migration note: Gandi is deprecating the account-wide API Key in favor of PATs; new integrations should use PATs exclusively and plan for token expiry/rotation (no fixed lifetime is guaranteed).
- A Gandi Organization is required to hold domains/products; a PAT is scoped to exactly one organization, so multi-org setups need one token per organization.
- Sandbox: register/test against `api.sandbox.gandi.net` using sandbox-specific credentials before touching production `api.gandi.net`; useful for exercising registration/transfer flows without real charges.
- No explicit rate-limit numbers were found in the fetched docs; check `https://api.gandi.net/docs/reference/` and response headers at implementation time for any `X-RateLimit-*` headers.

## Sources

- https://api.gandi.net/docs/
- https://api.gandi.net/docs/domains/
- https://api.sandbox.gandi.net/docs/domains/
- https://api.gandi.net/docs/livedns/
- https://api.gandi.net/docs/authentication/
- https://api.sandbox.gandi.net/docs/authentication/
- https://api.gandi.net/docs/mailbox/
- https://api.sandbox.gandi.net/docs/mailbox/
- https://api.gandi.net/docs/email/
- https://docs.gandi.net/en/managing_an_organization/organizations/personal_access_token.html
- https://api.gandi.net/docs/reference/

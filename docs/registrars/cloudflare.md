# Cloudflare — Registrar API Research

> Researched: 2026-08-26 · **Live-verified: 2026-08-29** · Docs: https://developers.cloudflare.com/registrar/, https://developers.cloudflare.com/registrar/registrar-api/, https://developers.cloudflare.com/api/resources/registrar/

## Live verification (2026-08-29)

Tested against the real Cloudflare account (no sandbox exists). The `~`/`✗` marks in
the research table below predate this and are partly superseded by these findings.

**Implemented + verified working:**

- **Reads** — `testConnection`, `listDomains`, `getDomain`, `getNameservers`,
  `getDnsRecords`, `getContacts` all work (nameservers/DNS resolve the domain to a
  Zones API zone first).
- **`checkAvailability`** — `POST /registrar/domain-check` (batches of 20). This is
  the **authoritative** availability source; `domain-search` (GET) is discovery-only
  and over-reports (it listed a premium numeric `.xyz` as registrable at $0.85 while
  `domain-check` returned `registrable:false, reason:"domain_premium"`).
- **`getPricing`** — derived from `domain-check` pricing. A full domain gives an exact
  quote; a bare TLD is probed with a neutral standard label. Transfers omitted (no API).
- **`registerDomain`** — `POST /registrar/registrations` (beta). **Live-registered
  `example.dev`** (standard `.dev`) — 201, `state:succeeded`, then `getDomain`
  confirmed active with `autoRenew:true, privacy:true`. `auto_renew`/`privacy_mode`/
  custom registrant contact are honored **at registration**. Premium names and
  unsupported extensions (`reason:"extension_not_supported_via_api"`) are rejected by
  the availability check, so registration is gated behind `checkAvailability`.
- **`setPrivacy`** — legacy `PUT .../registrar/domains/{name}` with `privacy` still
  works and persists (toggled `true→false→true`, reversible).
- **`setDnsRecords`** — Zones API replace-all (delete existing, recreate). **Verified on
  the clean `example.dev` zone**: set A/TXT/MX, read-back matched, restored to empty.
- **`get/setDomainForwarding`** (extended) — composed from the Rules API + a proxied
  placeholder DNS record (there is no native Registrar forwarding). `setDomainForwarding`
  writes one static redirect rule per host to the `http_request_dynamic_redirect` phase
  ruleset (301 `permanent` / 302 `redirect`) and ensures a proxied `AAAA → 100::`
  placeholder on each source host so the edge applies the redirect. HTTPS works via
  Universal SSL. **Verified live** on a gTLD test zone: apex + `www` → an external
  HTTPS target both return `302` at the edge. Clearing removes the rules and the
  placeholder records.
- **`get/setEmailForwarding`** (extended) — Cloudflare Email Routing. `setEmailForwarding`
  enables routing if needed (adds MX/SPF), writes a routing rule per `alias@domain`, and
  maps `*`/`@` to the catch-all. It also pre-checks destination addresses: any unknown
  destination is added (which sends Cloudflare's verification email) and the result names
  the ones still awaiting verification (rules to them stay inactive until verified). This
  needs the token's **Email Routing Addresses** scope — without it (`/email/routing/addresses`
  → 403) the pre-check is skipped and verification is done in the dashboard. **Verified
  live**: wildcard catch-all on `example.dev` to an already-verified destination.
- **Masked/framed forwarding is read-only**: `DomainForwardType` is `temporary | permanent
| masked`; `setDomainForwarding` rejects `masked`, `getDomainForwarding` reports it.
  Cloudflare never produces `masked` (it can't cloak).

**Not available via the API (confirmed, both `.uk` and gTLD `.dev`):**

- **`setAutoRenew`, `lockDomain`, `unlockDomain`** → the legacy `PUT` edit endpoint
  returns **422 "You are not allowed to perform this action"** for `auto_renew` and
  `locked`, on **both** a `.uk` and the gTLD `.dev` — so this is **API-wide, not
  TLD-specific**. The new `registrations` resource has **no update endpoint** (docs:
  "these core Registrar functions will be added in future versions"). These fields can
  only be set **at registration**. → now `NotImplementedError` with a clear message.
- **`updateNameservers`** → 403 "Name server update not allowed"; Cloudflare Registrar
  nameserver changes require contacting support. → `NotImplementedError`.
- **`renewDomain`** → renewals are not in the API yet. → `NotImplementedError`.
- **`updateContacts`, `transferIn`** → not yet in the API. → `NotImplementedError`.

**Token note:** the account token authenticates registrar **reads and writes** — both
privacy and DNS writes succeed. The earlier "token is read-only / needs a
Domain-Registration:Edit token" theory was **wrong**: the 422s are Cloudflare gating
those operations at the API, not a token-scope problem. (`GET /user/tokens/verify`
returns "Invalid API Token" for an account-scoped token — expected, not a sign of a bad
token.)

**Gotcha — Email Routing locks DNS:** on a zone with Cloudflare Email Routing enabled,
the managed MX/DKIM/SPF records return **error 1046** ("This record is managed by Email
Routing") on delete, so a `setDnsRecords` replace-all fails until Email Routing is
disabled. `setDnsRecords` surfaces this cleanly and leaves the zone untouched.

## Overview

Cloudflare Registrar is an at-cost domain registrar built into the Cloudflare account/dashboard, historically limited to managing domains transferred in (no new registrations). **This has recently changed**: as of a beta announced April 2026 (blog: "Register domains wherever you build"), Cloudflare now exposes a `registrations` API that lets you search, check, and actually _register_ new domains programmatically for a curated set of TLDs — a notable reversal of the "transfer-in only" model this research brief assumed. Base URL is the standard Cloudflare API v4 root (`https://api.cloudflare.com/client/v4/accounts/{account_id}/registrar/...`); all Registrar endpoints are account-scoped (not zone-scoped). There is no separate sandbox — testing happens against the production API/account with real (low-value/available) domains. The older `registrar/domains` list/get/update endpoints are marked **deprecated**, with an end-of-life date of 2026-09-27, and are being superseded by the newer `domain-search` / `domain-check` / `registrations` resource family.

## Authentication

Standard Cloudflare API auth, applied at the account level:

- **API Token** (recommended): `Authorization: Bearer $CLOUDFLARE_API_TOKEN` header, with a token scoped to "Registrar" write/read permissions on the target account.
- **Legacy API Key**: `X-Auth-Email` + `X-Auth-Key` headers (global key, full account access) — still accepted but discouraged.
- Every request is scoped by `account_id` in the URL path; there is no separate "registrar account" concept beyond the normal Cloudflare account. No documented IP allowlisting specific to Registrar. The same token/key pattern used across all Cloudflare products (DNS, Workers, etc.) applies here, and Registrar endpoints are also exposed through Cloudflare's MCP server for agent access.

## Feature Support

| Feature                                     | Support | Notes / endpoint                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test connection / verify credentials        | ~       | No dedicated "verify" endpoint; convention is a harmless GET such as `GET /registrations` or `GET /domains` (deprecated) to confirm auth/scopes.                                                                                                                                                      |
| List domains                                | ~       | Deprecated: `GET /accounts/{account_id}/registrar/domains` (EOL 2026-09-27). Successor: `GET /accounts/{account_id}/registrar/registrations`.                                                                                                                                                         |
| Get single domain details                   | ~       | Deprecated: `GET /accounts/{account_id}/registrar/domains/{domain_name}`. Successor: `GET /accounts/{account_id}/registrar/registrations/{domain_name}`.                                                                                                                                              |
| Check domain availability                   | ✓       | New beta: `POST /accounts/{account_id}/registrar/domain-check` — checks up to 20 candidate domains at once for availability + pricing in real time.                                                                                                                                                   |
| Get domain/TLD pricing                      | ✓       | Returned inline as part of `domain-check` response (per-domain pricing); `GET /accounts/{account_id}/registrar/extensions` lists supported TLDs/extensions and their registration schemas (pricing tied to extension).                                                                                |
| Register a new domain                       | ✓       | New beta: `POST /accounts/{account_id}/registrar/registrations`. Supports sync (201) or async (202, poll via `GET .../registration-status`) completion. Curated set of TLDs only; premium domains require explicit fee acknowledgment. Uses account default contact/payment unless overridden inline. |
| Renew a domain                              | ✗       | Not available via API (dashboard/auto-renew only). Cloudflare states renewal API support is planned.                                                                                                                                                                                                  |
| Auto-renew toggle                           | ~       | Available on the deprecated `PUT /accounts/{account_id}/registrar/domains/{domain_name}` endpoint (`auto_renew: boolean`). No confirmed equivalent yet on the new `registrations` resource; defaults to `false` at registration.                                                                      |
| Transfer domain in                          | ✗       | Dashboard-only today; no documented API endpoint. Cloudflare has stated transfers are planned for the API.                                                                                                                                                                                            |
| Transfer out / get auth/EPP code            | ✗       | Dashboard-only ("Request an authorization code" flow); no API endpoint documented.                                                                                                                                                                                                                    |
| Update nameservers                          | ✗       | No Registrar API field for this. Practically, nameservers for a domain are set via Cloudflare's zone/`dns_settings` API when using Cloudflare DNS, or by contacting support if pointing elsewhere; not a Registrar-resource operation.                                                                |
| Get nameservers                             | ~       | Not returned by documented Registrar domain schemas; would come from the DNS zone API instead.                                                                                                                                                                                                        |
| Lock / unlock domain (transfer lock)        | ~       | Deprecated `PUT /accounts/{account_id}/registrar/domains/{domain_name}` accepts `locked: boolean`. No confirmed equivalent on the new `registrations` resource yet.                                                                                                                                   |
| Get/set WHOIS privacy                       | ~       | Deprecated `PUT .../domains/{domain_name}` accepts `privacy: boolean`. On the new registration flow, WHOIS privacy is enabled by default at no extra charge (opt-out status via API unconfirmed).                                                                                                     |
| Update contact info (registrant/admin/tech) | ✗       | Explicitly called out as not-yet-supported in the beta ("contact updates" is on the roadmap). Registration accepts an inline registrant contact override at create time only.                                                                                                                         |
| DNS record management                       | ✗       | Out of scope of Registrar API — handled entirely by the separate Cloudflare DNS/Zones API.                                                                                                                                                                                                            |
| DNSSEC management                           | ✗       | Marketed as "one-click activation" in the dashboard; no Registrar API endpoint documented for enabling/disabling DNSSEC.                                                                                                                                                                              |
| Glue / host records                         | ✗       | Not documented in the Registrar API.                                                                                                                                                                                                                                                                  |
| Email forwarding / mailbox provisioning     | ✗       | Not a Registrar capability; Cloudflare offers this as a separate product ("Email Routing").                                                                                                                                                                                                           |
| Domain forwarding / URL redirect            | ✗       | Not documented as a Registrar API capability (Cloudflare's redirect features live in the Rules/Bulk Redirects products, not Registrar).                                                                                                                                                               |
| Webhooks / event notifications              | ✗       | No Registrar-specific webhooks documented; async registration progress is polled via `GET .../registration-status`, not pushed.                                                                                                                                                                       |

## Notable / Unique Features

- **At-cost pricing model**: Cloudflare sells/renews domains at wholesale registry price with no markup — a pricing philosophy, not really an "API feature," but worth noting for a `getPricing()` comparison across registrars.
- **Native MCP/agent exposure**: Registrar endpoints are available through Cloudflare's own MCP server "by default," letting AI agents discover and call `domain-search`/`domain-check`/`registrations` the same way they'd call any other Cloudflare API resource — suggests a generic `discoverViaMcp()` / tool-schema-exposed capability worth flagging as distinctive.
- **Bundled DNS + CDN/security**: Any domain on Cloudflare Registrar is trivially placed behind Cloudflare's DNS, CDN, and security stack — a generic `bundleWithDns(domain)` / `bundleWithCdn(domain)` capability unique to registrars that are also DNS/CDN providers.
- **Default privacy-by-design**: WHOIS privacy redaction is on by default with no separate paid tier — could map to a generic `getDefaultPrivacyPolicy()` capability distinguishing registrars that charge extra for privacy.
- **Extensions/schema introspection**: `GET /extensions` and `GET /extensions/{extension}` return machine-readable registration schemas per TLD (what fields/contacts each TLD requires) — a generic `getRegistrationSchema(tld)` capability that's unusually explicit compared to typical registrar APIs.

## Auth / Access Notes for Implementors

- Credentials: create an API Token in the Cloudflare dashboard (My Profile → API Tokens) scoped with Registrar read/write permission on the relevant account; account ID is required in every URL.
- Account requirements: the account must have Registrar enabled (available on all plans per Cloudflare's marketing), and for registration a default registrant contact and payment method should be on file since the new `registrations` endpoint can fall back to account defaults.
- No distinct sandbox/test environment — the beta operates against production; test carefully with cheap/available TLDs and be aware premium domains require explicit fee acknowledgment to avoid accidental charges.
- No documented Registrar-specific rate limits; assume standard Cloudflare API-wide rate limits apply.
- Two whole generations of API coexist right now: the deprecated `domains` resource (list/get/update — supports `auto_renew`, `locked`, `privacy` toggles) sunsets 2026-09-27, while the new `domain-search`/`domain-check`/`registrations` family is additive-only so far (no update/lock/privacy/renew endpoints confirmed on it yet). Implementors should watch for the new resource to absorb those lifecycle operations before the old one is removed, since a gap currently exists between what's deprecated and what's replaced it.

## Sources

- https://developers.cloudflare.com/registrar/
- https://developers.cloudflare.com/registrar/registrar-api/
- https://developers.cloudflare.com/registrar/get-started/transfer-domain-to-cloudflare/
- https://developers.cloudflare.com/api/resources/registrar/
- https://developers.cloudflare.com/api/resources/registrar/subresources/domains/methods/list/
- https://developers.cloudflare.com/api/resources/registrar/subresources/domains/methods/get/
- https://developers.cloudflare.com/api/resources/registrar/subresources/domains/methods/update/
- https://blog.cloudflare.com/registrar-api-beta/

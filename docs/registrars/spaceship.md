# Spaceship — API Research

> Researched: 2026-08-26 · Docs: https://docs.spaceship.dev/

## Overview

Spaceship (a Namecheap-family registrar) exposes a modern REST API at `https://spaceship.dev/api/v1`, documented via Redoc/OpenAPI 3.0. It covers domain lifecycle management, DNS records, contacts, nameservers/glue records, transfers, and the separate "SellerHub" (domain marketplace) and "Hyperlift" (app hosting) product lines. No sandbox/test environment is documented — the API appears production-only.

## Authentication

Dual-credential header auth: every request must include `X-Api-Key` and `X-Api-Secret` headers, generated via the API Manager in the Spaceship dashboard (spaceship.com/application/api-manager/). Keys are scoped by permission (see below), and access is account-scoped (tied to the Spaceship account that created the key). No mention of IP allowlisting or OAuth in the docs. Rate limits vary per endpoint (roughly 5–300 requests per 30–300 second window); exceeding limits returns HTTP 429.

Long-running operations (register, transfer, renew, restore) are asynchronous: the initial call returns HTTP 202 with a `spaceship-async-operationid` header, and clients poll `GET /async-operations/{operationId}` for status (`pending` / `success` / `failed`).

## Feature Support

| Feature                                             | Support | Notes / endpoint                                                                                                                                                                                              |
| --------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test connection / verify credentials                | ~       | No dedicated "whoami"/ping endpoint documented; `GET /domains` (or any authenticated call) doubles as a credential check                                                                                      |
| List domains                                        | ✓       | `GET /domains` (paginated: `take`/`skip`, `orderBy`)                                                                                                                                                          |
| Get single domain details                           | ✓       | `GET /domains/{domain}`                                                                                                                                                                                       |
| Check domain availability                           | ✓       | `GET /domains/{domain}/available` (single); `POST /domains/available` (bulk check)                                                                                                                            |
| Get domain/TLD pricing                              | ✗       | No dedicated pricing endpoint documented; pricing must be sourced outside the API (e.g. website/manual config)                                                                                                |
| Register a new domain                               | ✓       | `POST /domains/{domain}` — async, 202 + operation id                                                                                                                                                          |
| Renew a domain                                      | ✓       | `POST /domains/{domain}/renew` — async                                                                                                                                                                        |
| Auto-renew toggle                                   | ✓       | `PUT /domains/{domain}/autorenew`                                                                                                                                                                             |
| Transfer domain in                                  | ✓       | `POST /domains/{domain}/transfer` — async; status via `GET /domains/{domain}/transfer`                                                                                                                        |
| Transfer out / get auth/EPP code                    | ✓       | `GET /domains/{domain}/transfer/auth-code`                                                                                                                                                                    |
| Update nameservers                                  | ✓       | `PUT /domains/{domain}/nameservers`                                                                                                                                                                           |
| Get nameservers                                     | ~       | Not separately listed, but returned as part of `GET /domains/{domain}` details                                                                                                                                |
| Lock / unlock domain (transfer lock)                | ✓       | `PUT /domains/{domain}/transfer/lock`                                                                                                                                                                         |
| Get/set WHOIS privacy                               | ✓       | `PUT /domains/{domain}/privacy/preference` (high/public levels, consent-based); email protection via `PUT /domains/{domain}/privacy/email-protection-preference`                                              |
| Update contact info (registrant/admin/tech)         | ✓       | `PUT /domains/{domain}/contacts` (assign to domain); contact records managed separately via `PUT /contacts`, `GET /contacts/{contact}`, plus `PUT/GET /contacts/attributes/{contact}` for extended attributes |
| DNS record management                               | ✓       | `PUT /dns/records/{domain}` (save/upsert), `GET /dns/records/{domain}` (list, paginated), `DELETE /dns/records/{domain}`                                                                                      |
| DNSSEC management                                   | ✗       | Not documented anywhere in the API reference                                                                                                                                                                  |
| Glue / host records                                 | ✓       | "Personal nameservers" endpoints: `GET/PUT/DELETE /domains/{domain}/personal-nameservers/{currentHost}`, list via `GET /domains/{domain}/personal-nameservers` (A/AAAA host records)                          |
| Email forwarding / mailbox provisioning (Spacemail) | ✗       | Spacemail is a distinct product with its own web management UI (Spacemail Manager); no provisioning endpoints found in the public API docs                                                                    |
| Domain forwarding / URL redirect                    | ✗       | Not documented as a distinct API capability                                                                                                                                                                   |
| Webhooks / event notifications                      | ✗       | Not documented; async operations must be polled, not pushed                                                                                                                                                   |

## Notable / Unique Features

- **SellerHub (domain marketplace/aftermarket)** — endpoints to list domains for sale, manage checkout links, and pull sold-domain reports (`POST /sellerhub/checkout-links`, `GET/POST/PATCH/DELETE /sellerhub/domains`, `GET /sellerhub/domains/reports/sold`, plus SafePay escrow transaction endpoints). Generic name suggestion: `listDomainForSale(config)` / `getMarketplaceListings()`.
- **Hyperlift (application hosting platform)** — full app-deployment API (create/build/list/get applications, logs, metrics, restart, scale) bundled under the same API key. This is adjacent to registrar functionality (more like a PaaS) and likely has no counterpart among other registrars; out of scope for a common registrar feature set but worth flagging as a Spaceship-only extension.
- **Personal nameservers / glue records as first-class resources** — modeled as their own sub-resource with full CRUD rather than a field on the domain object. Generic name suggestion: `manageGlueRecord(domain, host, config)`.
- **Granular contact "attributes"** — separate save/read endpoints for extended contact attributes (likely TLD-specific registrant requirements, e.g. .de, .eu, .ca local presence fields), distinct from core contact fields. Generic name suggestion: `setContactExtendedAttributes(contact, attributes)`.
- **Scoped API keys** — permissions are broken into fine-grained scopes (`domains:read`, `domains:write`, `domains:transfer`, `domains:billing`, `contacts:read/write`, `dnsrecords:read/write`, `asyncoperations:read`, `sellerhub:read/write`, `hyperlift:*`), allowing least-privilege key issuance — more granular than most registrar APIs.

## Auth / Access Notes for Implementors

- Generate API key + secret from the Spaceship dashboard: API Manager (spaceship.com/application/api-manager/) → "New API key". Choose scopes at creation time (read/write/transfer/billing per resource).
- No sandbox or test environment is documented — all testing hits production, so implementors should be careful with register/transfer/renew calls (which are real, billable, async operations).
- Async operations (register, transfer, renew, restore) require polling `GET /async-operations/{operationId}` — plan for a poll loop / backoff rather than assuming synchronous completion.
- Rate limits are per-endpoint and fairly tight on some operations (as low as 5 requests per window) — implementors should inspect response headers / 429s and back off per-endpoint rather than using a single global rate limiter.
- No pricing API — TLD/domain pricing must be sourced out-of-band (scraping, manual price list, or a different Spaceship product surface) if the client library needs cost data before registering.

## Sources

- https://docs.spaceship.dev/
- https://registry.terraform.io/providers/namecheap/spaceship/0.0.2/docs
- https://apis.io/apis/spaceship/spaceship-domain-management-api/

# Squarespace — Domains API Research

> Researched: 2026-08-26 · Docs: https://developers.squarespace.com/ (Commerce APIs), https://reseller.squarespace.com/home-3 (Reseller Program), https://support.squarespace.com/hc/en-us/articles/41325887099533-Developer-Tools-APIs-at-Squarespace

## Overview

Squarespace does **not** offer a self-serve, publicly documented API for managing registered domains. A support article names two products — "Domains Search API" and "Domains Management API" — but neither has any published endpoint reference, base URL, or auth flow anywhere on `developers.squarespace.com` or elsewhere; they appear to be internal/partner-only capabilities exposed through the separate, application-gated **Reseller API** (`reseller.squarespace.com`), which itself has no publicly browsable documentation prior to partner approval. The only fully public, documented API surface at `developers.squarespace.com` is the **Commerce APIs** (Orders, Products, Inventory, Contacts, Profiles, Transactions, Websites, Discounts, Webhook Subscriptions, Analytics) plus a separate Acuity Scheduling API — none of which touch domain registration, DNS, or nameservers. There is no sandbox; the Commerce APIs are OAuth/API-key gated production-only endpoints for Squarespace _website/commerce_ accounts, unrelated to domain management.

## Authentication

N/A for domain management — no public API exists to authenticate against. For reference, the unrelated Commerce APIs use either an account-level API key (with scopes like `CONTACT`, `CONTACT_READONLY`) or OAuth (self-service app registration at `https://account.squarespace.com/developer-apps`, website-level scopes such as `website.contacts`). The Reseller API (the only place domain provisioning is mentioned with any specificity) requires a formal, vetted partnership agreement with Squarespace before any credentials or docs are issued — there is no self-service key generation for it.

## Feature Support

| Operation                            | Support | Notes                                                                                                                                                                         |
| ------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test connection / verify credentials | ✗       | No public domain API to connect to.                                                                                                                                           |
| List domains                         | ✗       | Not documented publicly.                                                                                                                                                      |
| Get single domain details            | ✗       | Not documented publicly.                                                                                                                                                      |
| Check domain availability            | ✗       | "Domains Search API" is named but undocumented/invite-only; public-facing search only exists as the consumer UI at domains.squarespace.com.                                   |
| Get domain/TLD pricing               | ✗       | Not documented publicly.                                                                                                                                                      |
| Register a new domain                | ✗       | Only via the Reseller Program (partner-gated, "buy and register domains within your platform" for 360+ TLDs) — no open docs.                                                  |
| Renew a domain                       | ✗       | Reseller Program mentions "manage subscription renewals" but no public endpoint docs.                                                                                         |
| Auto-renew toggle                    | ✗       | Not documented publicly.                                                                                                                                                      |
| Transfer domain in                   | ✗       | Not documented publicly.                                                                                                                                                      |
| Transfer out / get auth-EPP code     | ✗       | Not documented publicly.                                                                                                                                                      |
| Update nameservers                   | ✗       | Not documented publicly.                                                                                                                                                      |
| Get nameservers                      | ✗       | Not documented publicly.                                                                                                                                                      |
| Lock / unlock domain (transfer lock) | ✗       | Not documented publicly.                                                                                                                                                      |
| Get/set WHOIS privacy                | ✗       | Reseller Program mentions WHOIS privacy management "through Squarespace" but no public endpoint docs.                                                                         |
| Update contact info                  | ✗       | Not documented publicly.                                                                                                                                                      |
| DNS record management                | ✗       | Reseller Program mentions DNS records "through Squarespace" but no public endpoint docs; DNS is otherwise only editable via the Squarespace account UI.                       |
| DNSSEC management                    | ✗       | Not documented anywhere.                                                                                                                                                      |
| Glue / host records                  | ✗       | Not documented anywhere.                                                                                                                                                      |
| Email forwarding                     | ✗       | Not documented publicly (UI-only feature).                                                                                                                                    |
| Domain forwarding / URL redirect     | ✗       | Not documented publicly (UI-only feature).                                                                                                                                    |
| Webhooks                             | ~       | Squarespace has a general Webhooks/Webhook Subscriptions API, but it covers order, inventory, content, and customer events — no domain-related webhook topics are documented. |

## Implementation quick-reference

No public API exists for domain operations (list, register, renew, nameservers, lock, DNS, etc.) — none of these can be implemented against `developers.squarespace.com` today.

What `developers.squarespace.com` DOES publicly expose (all unrelated to domain management):

- **Commerce APIs** (base: `https://api.squarespace.com/1.0/commerce/...`) — Orders, Products, Inventory, Contacts, Profiles, Transactions, Discounts, Websites (basic site info), Analytics. Auth via API key (`Authorization: Bearer <api-key>`) or OAuth (website-scoped).
- **Webhook Subscriptions API** — subscribe to commerce/content events (orders, inventory, etc.), not domains.
- **Custom Code Spec** — for injecting code into 7.1 template sites; unrelated to domains.
- **Reseller APIs** — listed on the platform's landing page as **"Coming soon"** for self-service purposes; the older `reseller.squarespace.com` partner portal references domain provisioning/renewal/WHOIS/DNS management "through Squarespace" but ships no public endpoint reference — access requires a formal, vetted partnership agreement, and full docs are gated behind approval.
- **Acuity Scheduling API** (`developers.acuityscheduling.com`) — appointment scheduling, unrelated to domains.

If domain-management access is ever required, the only realistic path found is applying to the Squarespace Domain Reseller Program and requesting API docs post-approval — this cannot be implemented as a standard self-service registrar-client integration.

## Notable / Unique Features

- Squarespace acquired Google Domains in 2023 and migrated ~10M domains onto Squarespace's own registrar infrastructure; those domains are now managed exclusively through the Squarespace account UI (Domains panel), with the same lack of public API access as natively-registered Squarespace domains.
- Former Google Domains customers lost access to Google Domains' API-adjacent tooling entirely — Squarespace has not published a replacement public API to fill that gap.
- A "Domains Search API" and "Domains Management API" are named in Squarespace's own Help Center list of Developer Tools APIs, which implies they exist as internal/partner infrastructure, but Squarespace has chosen not to publish any reference documentation, base URL, or auth mechanism for them — this is a strong signal they are not intended for general third-party use.
- The Reseller Program page explicitly states domain resellers must go through "a formal partnership agreement with Squarespace" and "thorough vetting for security and technical capabilities," positioning this as a business-development track, not an open developer product.

## Auth / Access Notes for Implementors

- No self-service credential path exists for domain management. The Commerce API self-service OAuth app registration flow (`https://account.squarespace.com/developer-apps`) does not grant access to any domain endpoints.
- The only route to domain-related API access is the Domain Reseller Program: apply via "Contact our team to apply" on `reseller.squarespace.com`; expect a vetting process and a formal partnership agreement before any credentials or documentation are shared.
- No sandbox/test environment is documented for any Squarespace API, domain-related or otherwise.
- No rate-limit information is published for domain-related capabilities since no public docs exist; the Commerce APIs (unrelated) do publish standard per-key rate limits, but that has no bearing on domain use cases.
- Bottom line for this library: Squarespace should be marked as **unsupported / no public API** for domain-registrar integration purposes unless/until a Reseller Program partnership is separately negotiated.

## Sources

- https://developers.squarespace.com/
- https://developers.squarespace.com/commerce-apis
- https://developers.squarespace.com/commerce-apis/retrieve-basic-site-info
- https://support.squarespace.com/hc/en-us/articles/41325887099533-Developer-Tools-APIs-at-Squarespace
- https://support.squarespace.com/hc/en-us/articles/236297987-Squarespace-API-keys
- https://support.squarespace.com/hc/en-us/articles/205815758-Developer-Tools
- https://reseller.squarespace.com/home-3
- https://apitracker.io/a/squarespace

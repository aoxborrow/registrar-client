# NameBright — API Research

> Researched: 2026-08-26 · **Live-verified: 2026-08-28** · Docs: https://api.namebright.com/rest/Help · https://api.namebright.com/auth/help · https://github.com/NameBright/DomainApiClientExamples

## Live verification (2026-08-28)

Confirmed against a real production account (API access enabled). This resolves
the "unconfirmed" caveats scattered through the research notes below.

**Reads** — all working: `testConnection` (`GET /account`), `listDomains`
(paged via `page` + `domainsPerPage`, max 100), `getDomain`, `getNameservers`,
`getContacts`, `getDnsRecords`, `checkAvailability`, `getAuthCode`. Notes:

- `GET /account/domains/{domain}` returns the `AccountDomain` shape
  (`DomainName`, `Status`, `ExpirationDate`, `Locked`, `AutoRenew`,
  `WhoIsPrivacy`, `Category`, `UpgradedDomain`, `AuthCode`) — **no**
  registration/creation date on any read endpoint, so `createdDate` is always
  null.
- `getAuthCode` reads the `AuthCode` field off that same domain-detail
  response — the transfer/EPP code is returned synchronously, not emailed
  (live-verified 2026-08-29).
- Contacts: `PhoneCountry` comes back as a **number** and an empty
  `FaxCountry` as **null** (not strings) — the mapper must coerce.
- `checkAvailability` returns `UnitPrice: 0` for unavailable names; treat a
  zero price as "no price", not a real $0.

**Writes** (verified reversibly on a domain whose DNS is served elsewhere):

- **Lock / unlock / auto-renew / WHOIS privacy** all go through the shared
  `PUT /account/domains/{domain}` with an `AccountDomain` JSON body. Fields:
  `Locked`, `AutoRenew`, `WhoIsPrivacy` (booleans). This is a **full-object
  PUT** — sending a bare `{ "Locked": true }` resets the other flags, so
  read-merge the current record first (and drop `AuthCode` from the round-trip).
- **DNS host records**: `POST /account/domains/{domain}/hostrecords/{type}`
  (`a`, `aaaa`, `cname`, `mx`, `txt`, `srv`) to create; `DELETE
.../hostrecords/{type}/{RecordId}` to remove. The read endpoint returns a
  numeric `RecordId` per record (needed for deletes). Confirmed bodies: A
  `{Subdomain, IPV4Address}`, TXT `{Subdomain, TextRecord}` (other types follow
  the read shapes). Quirks:
  - The POST **response body is unreliable** (it echoes an unrelated record) —
    ignore it; re-read the zone to confirm.
  - Deleting a record and immediately re-POSTing an **identical** one returns
    `400 "Duplicate host record"`. So `setDnsRecords` applies a **diff** (delete
    only removed records, post only new ones) instead of a blind delete-all +
    recreate.
  - A TXT value containing **non-ASCII** characters (e.g. an em-dash) makes the
    endpoint return `500 NullReferenceException`. Stick to ASCII.
- **Nameservers**: `DELETE /account/domains/{domain}/nameservers` (clear all) +
  `PUT .../nameservers/{nameServer}` (add one, no body) are implemented but
  **not** live-verified — no safe way to test NS replacement on a live domain.

`renewDomain` / `registerDomain` / `transferIn` are left unimplemented (they
incur charges).

## Overview

NameBright offers a real, public, self-service REST API (JSON) for domain management — no reseller/partner gating, only a NameBright account with API access requested through the account dashboard. Base URL is `https://api.namebright.com/rest/`, with a separate OAuth2 token endpoint at `https://api.namebright.com/auth/token` (grant type `client_credentials` only). There is no evidence of a sandbox/test environment — the API appears to be production-only, and purchases (registration/renewal) draw from a pre-funded account balance.

## Authentication

- OAuth2 `client_credentials` grant against `POST https://api.namebright.com/auth/token`.
- Request body (`application/x-www-form-urlencoded` or JSON): `grant_type=client_credentials`, `client_id` (format `"accountname:applicationname"`), `client_secret`.
- Response includes `access_token` (documented sample shows only this field; `token_type`/`expires_in` are not explicitly confirmed in the help docs).
- Bearer tokens are valid for **30 minutes**; re-request as needed.
- Credentials come from self-service "API Applications" created at `https://my.namebright.com/my-account/api-management`, each with a unique name and a configurable **IP whitelist**; NameBright issues a `client_secret` per application. No OAuth scopes are documented — access appears to be all-or-nothing per application/account.

## Feature Support

| Feature                              | Support | Notes / endpoint                                                                                                                                                                                                                                    |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test connection / verify credentials | ✓       | `GET /rest/account` (returns balance/financial details); implicitly also any authenticated call                                                                                                                                                     |
| List domains                         | ✓       | `GET /rest/account/domains` (paginated)                                                                                                                                                                                                             |
| Get single domain details            | ✓       | `GET /rest/account/domains/{domain}`                                                                                                                                                                                                                |
| Check domain availability            | ✓       | `GET /rest/purchase/availability/{domain}`                                                                                                                                                                                                          |
| Get domain/TLD pricing               | ~       | Not seen as a distinct dedicated pricing/TLD-price endpoint in the documented list; pricing appears bundled into availability/purchase flow — unconfirmed, verify against live Help pages before relying on it                                      |
| Register a new domain                | ✓       | `POST /rest/purchase/register`                                                                                                                                                                                                                      |
| Renew a domain                       | ✓       | `POST /rest/purchase/renew`                                                                                                                                                                                                                         |
| Auto-renew toggle                    | ✓       | `PUT /rest/account/domains/{domain}` (auto-renew is one of the settable fields alongside lock/WHOIS privacy; exact JSON field names could not be confirmed — the live Help subpage for this endpoint returned an error during research)             |
| Transfer domain in                   | ~       | "Inbound Push" endpoints accept/decline pending incoming account-to-account transfers; a true external-registrar transfer-in was not clearly documented                                                                                             |
| Transfer out / get auth-EPP code     | ✓       | `getAuthCode` reads the `AuthCode` field on `GET /rest/account/domains/{domain}` — the transfer/EPP code is returned synchronously (live-verified 2026-08-29). ("Outbound Push" endpoints are a separate intra-NameBright account-to-account flow.) |
| Update nameservers                   | ✓       | `PUT /rest/account/domains/{domain}/nameservers/{nameServer}`; `DELETE` same path to remove one, `DELETE /rest/account/domains/{domain}/nameservers` to clear all                                                                                   |
| Get nameservers                      | ✓       | `GET /rest/account/domains/{domain}/nameservers`                                                                                                                                                                                                    |
| Lock / unlock domain (transfer lock) | ✓       | `PUT /rest/account/domains/{domain}` (locking is one of the settable fields)                                                                                                                                                                        |
| Get/set WHOIS privacy                | ✓       | `PUT /rest/account/domains/{domain}` (WHOIS privacy is one of the settable fields)                                                                                                                                                                  |
| Update contact info                  | ✓       | `GET/PUT /rest/account/domains/{domain}/contacts/all`, plus per-role `.../contacts/technical`, `.../contacts/administrative`, `.../contacts/registrant`                                                                                             |
| DNS record management                | ✓       | Host records under the domain resource; documented support for A, AAAA, CNAME, MX, SRV, TXT via `GET` (by type), `POST` (create), `DELETE` (by record ID)                                                                                           |
| DNSSEC management                    | ✗       | No DNSSEC endpoints found in the documented endpoint list                                                                                                                                                                                           |
| Glue / host records                  | ✓       | Covered by the same nameserver endpoints (`.../nameservers/{nameServer}`) used for glue/host record management                                                                                                                                      |
| Email forwarding                     | ✗       | No email-forwarding endpoint found in the documented endpoint list                                                                                                                                                                                  |
| Domain forwarding / URL redirect     | ✗       | No domain/URL forwarding endpoint found in the documented endpoint list                                                                                                                                                                             |
| Webhooks                             | ✗       | No webhook/event-notification mechanism found in the documented endpoint list                                                                                                                                                                       |

## Implementation quick-reference

- **Base URL**: `https://api.namebright.com/rest/`
- **Auth flow (all calls)**: `POST https://api.namebright.com/auth/token` with `grant_type=client_credentials`, `client_id="<accountname>:<applicationname>"`, `client_secret="<secret>"` → returns `access_token`; send as `Authorization: Bearer <access_token>` on every REST call. Token expires after 30 minutes — refresh proactively for long-running jobs. Requests are also checked against the IP whitelist configured for the API Application.
- **Test connection**: `GET /rest/account` with the bearer token — returns account balance/financial details; a 200 response confirms valid credentials.
- **List domains**: `GET /rest/account/domains` (supports pagination per the Help page; exact query param names, e.g. `page`/`pageSize`, were not confirmed from the fetched summary — check `https://api.namebright.com/rest/Help/Api/GET-account-domains` directly).
- **Renew**: `POST /rest/purchase/renew` (exact request body fields, e.g. domain name and term length, not confirmed from research — verify against `https://api.namebright.com/rest/Help/Api/POST-purchase-renew`).
- **Set nameservers**: `PUT /rest/account/domains/{domain}/nameservers/{nameServer}` — sets/updates one nameserver at a time (exact body shape not confirmed; the live Help subpage errored during research — verify before implementing).
- **Lock**: `PUT /rest/account/domains/{domain}` with a locking field in the request body (field name unconfirmed — likely `Locked`/similar; verify against live Help page).
- **Unlock**: same `PUT /rest/account/domains/{domain}` endpoint, opposite value of the locking field.
- Auto-renew toggle and WHOIS privacy toggle are combined into the same `PUT /rest/account/domains/{domain}` endpoint as locking, per the endpoint list — but exact JSON field names, allowed values, and whether they can be set independently or must be sent together were not confirmed; the specific Help subpages for this endpoint returned generic errors when fetched during this research pass. Implementors should hit `https://api.namebright.com/rest/Help/Api/PUT-account-domains-domain` directly (with a valid session/browser, since the raw fetch above failed) before coding against it.

## Notable / Unique Features

- **Self-service, non-gated access** — any NameBright account holder can request API access and generate credentials at `my.namebright.com/my-account/api-management`; this is not reseller/partner-only, unlike some competitors.
- **Per-application IP whitelisting** — each API Application (client_id) is scoped to specific IPs, which is a stronger default security posture than a bare API key.
- **Platform lineage** — NameBright is known to power the domain-management back end for several other registrar brands (it originated from/relates to the eNom/domain-services lineage); this API's coverage and quirks likely apply to those white-labeled storefronts too, though this was not independently re-verified in this pass and should be confirmed per-brand if relevant.
- **"Push" transfer model** — NameBright's dedicated transfer endpoints are framed around intra-NameBright account-to-account "push" (inbound/outbound), not a standard EPP transfer-in flow. The transfer-out **auth code**, however, is exposed: it's the `AuthCode` field on the domain-detail response (`GET /rest/account/domains/{domain}`), which `getAuthCode` reads and which live-verified as a real synchronous code on 2026-08-29. There is still no external-registrar transfer-_in_ endpoint.
- **No DNSSEC, no webhooks, no domain/email forwarding** documented — this is a comparatively narrow feature surface relative to full-service competitor APIs (e.g., Dynadot, GoDaddy).
- **No sandbox** — testing appears to require a live account and real IP-whitelisted credentials; there's no indication of a staging/sandbox host.

## Auth / Access Notes for Implementors

- Sign up for a NameBright account, then request/enable API access and create an "API Application" at `https://my.namebright.com/my-account/api-management`, supplying a unique application name and an IP whitelist (required — requests from non-whitelisted IPs will presumably be rejected).
- The account receives a `client_secret` for that application; `client_id` is `"<accountname>:<applicationname>"`.
- Rate limit: reported as roughly **30 requests per 30 seconds**, though this figure came from a secondary summary during research and should be re-confirmed against the official Help page before relying on it for production throttling logic.
- Purchases (register/renew) draw from a **pre-funded account balance** — the API does not appear to accept a payment method per call, so the account must be funded ahead of time.
- Bearer tokens expire every 30 minutes; long-running batch jobs must refresh tokens mid-run and handle 401s gracefully.
- No documented sandbox/test mode was found — build against production carefully, using low-risk read calls (`GET /rest/account`, `GET /rest/account/domains`) first to validate credentials before attempting any mutating call.

## Sources

- https://api.namebright.com/rest/Help
- https://api.namebright.com/auth/help
- https://api.namebright.com/auth/Help/Api/POST-token
- https://github.com/NameBright/DomainApiClientExamples/blob/master/README.md
- https://github.com/NameBright/DomainApiClientExamples

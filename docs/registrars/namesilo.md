# NameSilo — API Research

> Researched: 2026-08-26 · Docs: https://www.namesilo.com/api-reference · https://www.namesilo.com/support/v2/articles/account-options/api-manager

## Overview

NameSilo offers a single, free, comprehensive HTTP API: every operation is invoked with a plain GET request to `https://www.namesilo.com/api/{operation}` (operation name is also passed as an `operation` query param in the docs' examples), with the response format chosen per-call via a `type` query param (`xml`, the default, or `json`). Coverage spans domain registration/renewal/transfer, nameservers, WHOIS privacy, contacts, DNS records, DNSSEC, email forwarding, and domain forwarding. A test/OTE ("Operational Test Environment") endpoint exists at `https://ote.namesilo.com/api` (a `sandbox.namesilo.com/api` host has also been referenced) for testing without touching production/billing; sandbox credentials must be requested from NameSilo support rather than self-generated.

## Authentication

- Every request carries three required query-string parameters: `version` (currently `1`), `type` (`xml` or `json`), and `key` (the account's API key).
- Example: `https://www.namesilo.com/api/getAccountBalance?version=1&type=json&key=API_KEY`.
- The API key is generated (and shown only once) from the API Manager page in the account dashboard (`account/api-manager`); if lost, a new key must be generated.
- Optional IP allowlisting: up to 5 IP addresses can be configured in the API Manager; if none are set, the key works from any IP. Only requests from an allowed IP succeed once any are configured.
- Auth is account-scoped only — there is no separate reseller/sub-account partitioning documented; all API actions are logged and tied into NameSilo's Domain History / Domain Defender security monitoring.
- No signing (HMAC) or header-based auth is used — the key is a plain credential in the query string.

## Feature Support

| Feature                              | Support | Notes / operation                                                                                                                                                                                      |
| ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Test connection / verify credentials | ✓       | `getAccountBalance` (cheapest read call, no side effects)                                                                                                                                              |
| List domains                         | ✓       | `listDomains` — supports `portfolio`, `pageSize`, `page`, `withBid`, `skipExpired`, `expiredGrace` filters                                                                                             |
| Get single domain details            | ✓       | `getDomainInfo`                                                                                                                                                                                        |
| Check domain availability            | ✓       | `checkRegisterAvailability` (registration), `checkTransferAvailability` (transfer eligibility)                                                                                                         |
| Get domain/TLD pricing               | ✓       | `getPrices`                                                                                                                                                                                            |
| Register a new domain                | ✓       | `registerDomain`                                                                                                                                                                                       |
| Renew a domain                       | ✓       | `renewDomain` (also performs a restoration if the domain is in redemption grace, unless overridden in API Manager settings)                                                                            |
| Auto-renew toggle                    | ✓       | `addAutoRenewal` / `removeAutoRenewal`                                                                                                                                                                 |
| Transfer domain in                   | ✓       | `transferDomain`, with status polling via `checkTransferStatus`                                                                                                                                        |
| Transfer out / get auth-EPP code     | ✓       | `retrieveAuthCode` (code is emailed to the registrant, not returned directly in the API response, per NameSilo's transfer-security policy)                                                             |
| Update nameservers                   | ✓       | `changeNameServers`                                                                                                                                                                                    |
| Get nameservers                      | ~       | Current nameservers are returned as part of `getDomainInfo`; no dedicated "get nameservers" call for the domain itself (a separate `listRegisteredNameServers` exists for registered/glue nameservers) |
| Lock / unlock domain (transfer lock) | ✓       | `domainLock` / `domainUnlock`                                                                                                                                                                          |
| Get/set WHOIS privacy                | ✓       | `addPrivacy` / `removePrivacy`; privacy status also visible via `getDomainInfo`                                                                                                                        |
| Update contact info                  | ✓       | `contactAdd`, `contactUpdate`, `contactDelete`, `contactList`, `contactDomainAssociate` (contacts are account-level objects associated with domains, not embedded per-domain fields)                   |
| DNS record management                | ✓       | `dnsListRecords`, `dnsAddRecord`, `dnsUpdateRecord`, `dnsDeleteRecord`                                                                                                                                 |
| DNSSEC management                    | ✓       | `dnsSecListRecords`, `dnsSecAddRecord`, `dnsSecDeleteRecord`                                                                                                                                           |
| Glue / host records                  | ✓       | `addRegisteredNameServer`, `modifyRegisteredNameServer`, `deleteRegisteredNameServer`, `listRegisteredNameServers`                                                                                     |
| Email forwarding                     | ✓       | `listEmailForwards`, `configureEmailForward`, `deleteEmailForward`                                                                                                                                     |
| Domain forwarding / URL redirect     | ✓       | `domainForward` (whole domain), `domainForwardSubDomain` (subdomain-level)                                                                                                                             |
| Webhooks                             | ✗       | No webhook/event-notification mechanism found in the official docs; polling (e.g. `checkTransferStatus`, `getDomainInfo`) is the only option                                                           |

## Implementation quick-reference

**Base URLs**

- Production: `https://www.namesilo.com/api/{operation}`
- Sandbox/OTE: `https://ote.namesilo.com/api/{operation}` (an alternate `sandbox.namesilo.com/api` host is also referenced in third-party material; confirm the current host when sandbox credentials are issued). Sandbox access requires emailing NameSilo support for a sandbox account/key — it is not self-service.

**Auth query params (every call, both environments)**
`version=1`, `type=xml|json`, `key=<API_KEY>`

**1. Verify credentials / test connection**

- Operation: `getAccountBalance`
- Method: GET `https://www.namesilo.com/api/getAccountBalance?version=1&type=json&key=API_KEY`
- Params: none beyond the standard three
- Response shape (JSON): `{ request: { operation, ip }, reply: { code, detail, balance } }`. `code: 300` + `detail: "success"` indicates the key is valid; `balance` is the account funds figure — this is the cheapest read-only call for a connectivity/credential check.

**2. List domains**

- Operation: `listDomains`
- Method: GET `https://www.namesilo.com/api/listDomains?version=1&type=json&key=API_KEY`
- Params (all optional): `portfolio` (encoded portfolio name filter), `pageSize`, `page`, `withBid`, `skipExpired`, `expiredGrace`
- Pagination: yes, via `page`/`pageSize`, with result totals returned in `reply.pager`
- Response shape (JSON): `{ request: {...}, reply: { code, detail, domains: [ { domain, created, expires, maxBid? } , ... ], pager: { page, pageSize, total } } }`

**3. Renew a domain**

- Operation: `renewDomain`
- Method: GET `https://www.namesilo.com/api/renewDomain?version=1&type=json&key=API_KEY&domain=example.com&years=1`
- Required params: `domain`, `years` (1–10)
- Optional params: `payment_id` (verified stored credit card ID), `coupon`
- Response shape (JSON): `{ request: {...}, reply: { code, detail, message, domain, order_amount } }`

**4. Update/set nameservers**

- Operation: `changeNameServers`
- Method: GET `https://www.namesilo.com/api/changeNameServers?version=1&type=json&key=API_KEY&domain=example.com&ns1=ns1.host.com&ns2=ns2.host.com`
- Required params: `domain`, `ns1`, `ns2` (minimum 2 nameservers)
- Optional params: `ns3` through `ns13` (maximum 13 nameservers total)
- Note: values must be nameserver hostnames (e.g. `ns1.host.com`), not IP addresses
- Response shape (JSON): `{ request: {...}, reply: { code, detail } }` (e.g. `code: 300, detail: "success"`)

**5. Lock domain (transfer lock)**

- Operation: `domainLock`
- Method: GET `https://www.namesilo.com/api/domainLock?version=1&type=json&key=API_KEY&domain=example.com`
- Required params: `domain`
- Response shape (JSON): `{ request: {...}, reply: { code, detail } }` — e.g. `code: 300, detail: "success"` on change, or `code: 252, detail: "Domain is already Locked - No update made."` if already locked

**6. Unlock domain**

- Operation: `domainUnlock`
- Method: GET `https://www.namesilo.com/api/domainUnlock?version=1&type=json&key=API_KEY&domain=example.com`
- Required params: `domain`
- Response shape (JSON): `{ request: {...}, reply: { code, detail } }` — e.g. `code: 300, detail: "success"` on change, or `code: 253, detail: "Domain is already Unlocked - No update made."` if already unlocked

**General response envelope**: both XML and JSON responses share the same shape — a `request` echo (operation + requester IP) and a `reply` block containing at minimum `code` (numeric status; `300` = success family) and `detail` (human-readable status string), plus operation-specific fields. Non-2xx/error conditions are signaled via non-300 `code` values rather than HTTP status codes (all calls return HTTP 200).

## Notable / Unique Features

- **Registered/glue nameservers as first-class objects** — `addRegisteredNameServer` / `modifyRegisteredNameServer` / `deleteRegisteredNameServer` / `listRegisteredNameServers` manage custom host records (e.g. `ns1.example.com` with its own IP) independently of `changeNameServers`, which just points a domain at existing nameservers. Suggested generic methods: `createGlueRecord(host, ips[])`, `updateGlueRecord(host, ips[])`, `deleteGlueRecord(host)`, `listGlueRecords()`.
- **Portfolios** — domains can be grouped into named portfolios and filtered via `listDomains(portfolio=...)`. Suggested generic method: `listDomains({ group: portfolioName })`.
- **Free WHOIS privacy** — NameSilo bundles WHOIS privacy at no extra cost on eligible TLDs (`addPrivacy`/`removePrivacy`), unlike registrars that upsell it.
- **Auto-restoration on renew** — `renewDomain` transparently performs a redemption-period restoration if needed, with an account-level setting to disable that auto-behavior. Worth surfacing as a configurable flag in a generic `renewDomain` wrapper (e.g. `allowRestore: boolean`).
- **Auth/EPP code delivered out-of-band** — `retrieveAuthCode` triggers an email to the registrant rather than returning the code inline in the API response, a deliberate anti-hijacking measure that differs from registrars that return the code directly.
- **No webhooks** — anything event-driven (transfer completion, expiration, etc.) must be built on top of polling (`checkTransferStatus`, `listDomains`/`getDomainInfo` with expiry fields), which has implications for how a multi-provider client should model "notifications" across registrars.

## Auth / Access Notes for Implementors

- API keys are self-service: generate from the account's API Manager page (`www.namesilo.com/account/api-manager`); the key is shown once at creation and cannot be retrieved again if lost (must regenerate).
- The API is available to all NameSilo accounts at no extra charge — no approval process, tiering, or per-call fees are documented.
- Optional IP allowlisting (up to 5 IPs) can be configured per key in the API Manager; leaving it blank allows calls from any IP.
- No documented rate limits were found in the official docs reviewed; treat as undocumented/soft-limited and implement conservative client-side throttling.
- Sandbox/OTE access is not self-service — it must be requested from NameSilo support via email, who provision separate sandbox credentials; the sandbox host (`ote.namesilo.com` / `sandbox.namesilo.com`) should be confirmed at that time since the two names appear inconsistently across sources.
- All API activity is logged and integrated with NameSilo's Domain History and Domain Defender systems for account security monitoring.

## Sources

- https://www.namesilo.com/api-reference
- https://www.namesilo.com/support/v2/articles/account-options/api-manager
- https://www.namesilo.com/api-reference/pages?uid=nameserver/add-registered-nameserver
- https://www.namesilo.com/api-reference/pages?uid=domains/list-domains
- https://www.namesilo.com/api-reference/pages?uid=domains/renew-domain
- https://www.namesilo.com/api-reference/pages?uid=domains/domain-lock
- https://www.namesilo.com/api-reference/pages?uid=domains/domain-unlock
- https://www.namesilo.com/api-reference/pages?uid=account/get-account-balance
- https://pkg.go.dev/github.com/nrdcg/namesilo (third-party client used to cross-check operation names/params)

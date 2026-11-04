# Unstoppable Domains — API Research

> Researched: 2026-10-29 · Docs: https://docs.unstoppabledomains.com/apis/user-api/overview
> OpenAPI: https://api.unstoppabledomains.com/mcp/v1/openapi.json

## Overview

Unstoppable Domains' **User API** is a flat set of JSON "actions" at
`https://api.unstoppabledomains.com/mcp/v1/actions/ud_<action>`. Every action is
an HTTP **POST** with a JSON body and a JSON response; success/failure uses
normal HTTP status codes (e.g. `401` for a bad key), and write actions return a
per-domain `results` array plus `successCount`/`failureCount`. The same surface
backs Unstoppable's MCP server and CLI.

Unstoppable sells two kinds of name: **ICANN ("dns") domains** — which have real
expiry, renewal, DNS, nameservers and auto-renew — and **web3 NFT domains**
(`.crypto`, `.x`, `.nft`, …) which don't expire and have no registrar-style lock,
privacy, transfer or WHOIS. `ud_portfolio_list` returns **only ICANN domains by
default** (web3 names need `registryType: "web3"`), and this adapter lists only
those.

The portfolio can also hold names **registered elsewhere** that are only listed
on Unstoppable's marketplace (`isExternallyOwned: true`; the marketplace calls
them "external" listings). Unstoppable doesn't manage them — the dedicated
nameserver read 400s with "Domain registration is not valid for management" —
so `listDomains` skips them and `getDomain` reports them as not found.

> **Implementation (read + manage):** portfolio list/get, availability + pricing,
> nameservers and the DNS record read are **live-verified** (2026-11, an
> 852-domain account). The writes — nameservers, DNS records, auto-renew,
> transfer lock, WHOIS privacy, URL forwarding — are built from the OpenAPI spec
> and **unit-tested only** (there is no sandbox). Registration and renewal are
> deliberately **left out**: Unstoppable buys/renews through a multi-step
> cart→checkout flow that spends real money
> (`ud_cart_add_domain_registration`/`_renewal` → `ud_cart_checkout`), not a
> single call. Transfer-in and per-domain contacts have no equivalent.

## Authentication

- **API key** in the format `ud_mcp_…`, generated under Account Settings →
  Advanced → **MCP API Key** (copyable any time). Sent as
  `Authorization: Bearer <key>`.
- OAuth 2.0 is also supported (scopes `domains:search`, `portfolio:read`,
  `portfolio:write`, `cart:*`, `checkout`); this adapter uses the API key.
- **No sandbox / test environment.** All calls act on the live account.

## Feature Support

| Feature                              | Support          | Notes / action                                                                                                                                                       |
| ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test connection / verify credentials | ✓                | No ping; `ud_portfolio_list` with `limit:1` is the lightest authenticated read                                                                                       |
| List domains                         | ✓                | `ud_portfolio_list` (offset-paged, max 500) to enumerate, then `ud_domain_get` (50/call) for nameservers + flags                                                     |
| Get single domain details            | ✓                | `ud_domain_get` (up to 50 names per call): lifecycle, flags, nameservers, hosting, DNSSEC, renewal price                                                             |
| Check domain availability            | ✓                | `ud_domains_search` — `query` takes up to **10** names; results carry `available` + `pricing.amount` (**cents**) + `marketplace.status`                              |
| Get domain/TLD pricing               | ✓ (per-domain)   | From `ud_domains_search`; no per-TLD table. A bare TLD is priced via a probe label. Registration price only.                                                         |
| Register a new domain                | ✗ (out of scope) | `ud_cart_add_domain_registration` → `ud_cart_checkout` (multi-step, spends money); not wired here                                                                    |
| Renew a domain                       | ✗ (out of scope) | `ud_cart_add_domain_renewal` → `ud_cart_checkout`; not wired here                                                                                                    |
| Auto-renew toggle                    | ✓                | `ud_domain_auto_renewal_update` (`action: enable`/`disable`) — ICANN domains                                                                                         |
| Transfer domain in                   | ✗                | No inbound-transfer API                                                                                                                                              |
| Update nameservers                   | ✓                | `ud_dns_nameservers_set_custom` (also `…_set_default` to reset)                                                                                                      |
| Get nameservers                      | ✓                | `ud_domain_get` — `ud_dns_nameservers_list` 400s for some names                                                                                                      |
| Lock / unlock domain                 | ✓                | `ud_domain_flags_update` with `DNS_TRANSFER_OUT`: `ENABLED` = transfers allowed (unlocked), `DISABLED` = blocked (locked). Read from `ud_domain_get` `flags`.        |
| Get/set WHOIS privacy                | ✓                | `ud_domain_flags_update` with `DNS_WHOIS_PROXY`: `ENABLED` = contact details hidden. Read from `ud_domain_get` `flags`.                                              |
| Read / update contacts               | ~ / ✗            | `ud_contacts_list` returns **account-level** ICANN contacts by id; there's no per-domain contact read or reassignment                                                |
| DNS record management                | ✓                | `ud_dns_records_list` (cursor-paged); write via `ud_dns_record_add` (`upsertMode`), `_update`, `_remove` (by id) and `ud_dns_records_remove_all` — 50 records a call |
| DNSSEC                               | ~                | Readable on `ud_domain_get` (`dns.dnssec`); DS records can be passed with custom nameservers; no standalone enable/disable — not wired                               |
| Domain forwarding / URL redirect     | ✓                | DNS "hosting" configs: `ud_dns_hosting_list`/`_add`/`_remove` — `REDIRECT_301`/`REDIRECT_302` map to permanent/temporary                                             |
| Email forwarding                     | ✗                | No email-forwarding API                                                                                                                                              |
| Auth code / transfer out             | ✗                | No auth-code action; `ud_domain_push` moves a name to another Unstoppable account (needs an OTP), which isn't a registrar transfer                                   |
| Marketplace / offers / messaging     | ✓ (out of scope) | `ud_listing_*`, `ud_offers_*`, `ud_leads_*` — Unstoppable-specific, outside the registrar contract                                                                   |

## Implementation notes

- **Reads go through `ud_domain_get` (batched, 50/call).** `ud_portfolio_list`
  enumerates names but has no nameservers or flags, and `ud_dns_nameservers_list`
  400s for some names. `ud_domain_get` returns nameservers for every domain plus
  the `flags` map, so `listDomains` enumerates via the portfolio and then reads
  the names in batches to fill in nameservers, `locked` and `privacy`. That makes
  `requiresNameserversFetch` false, and `detailed: true` adds nothing.
  `ud_domain_get` is slow and server-throttled (~8-10s/call regardless of batch
  size), so a large account's list is slow (~70s for 852 domains) but complete
  in one pass.
- **`DNS_TRANSFER_OUT` is the transfer lock, not a transfer status.** `ENABLED`
  means transfers are allowed, so every unlocked domain carries it. A transfer in
  progress shows as `transferStatus: "pending"`.
- **Open question — transferred-out names.** In live testing, names that had
  already transferred away still came back from `ud_portfolio_list` with
  `transferStatus: "none"`. The adapter skips `isExternallyOwned` names; whether
  a completed transfer-out sets that flag still needs checking against a live
  account.
- **Prices are integer cents.** `pricing.amount` (and `listing.price`) are in
  cents; divide by 100 for major units. `currency` is alongside.
- **Availability counts aftermarket listings.** `available` is true for fresh
  registrations _and_ names listed for sale (on Unstoppable, Sedo or Afternic);
  `marketplace.status` tells them apart. Listings come back `premium` at the
  listing price, and `getPricing` refuses them (it only reports registration
  prices).
- **Records hold multiple values.** A `ud_dns_records_list` record has a
  `values[]` array; `getDnsRecords` expands them into one `DnsRecord` per value,
  and `setDnsRecords` re-groups records sharing type + host into one multi-value
  record. MX and SRV numbers travel inside the value (`"<priority> <host>"`,
  `"<priority> <weight> <port> <target>"`). The apex is `"@"` on writes; reads
  return it as null or empty.
- **`setDnsRecords` writes only the difference.** It reads the zone, removes the
  records whose type + host is no longer wanted (`ud_dns_record_remove` by id),
  then writes new or changed ones with `ud_dns_record_add` in `replace` mode.
  Unchanged records aren't touched, so a failed write never leaves the zone
  empty. Read-only system records (no id) stay; desired values that match one are
  skipped.
- **Writes return a `results` array**, not a status code per operation — map
  `failureCount`/per-row `success` to the library's `OperationResult`.
- **`applyToAllDomainsInPortfolio`** exists on the bulk write actions; this
  adapter always targets a single domain and never sets it.

## Sources

- https://docs.unstoppabledomains.com/apis/user-api/overview
- https://api.unstoppabledomains.com/mcp/v1/openapi.json
- https://support.unstoppabledomains.com/support/solutions/articles/48001280210-connect-your-ai-agent-to-unstoppable-domains

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
privacy, transfer or WHOIS. `ud_portfolio_list` returns both; web3 entries simply
have a null `expiresAt`.

> **Implementation (read + manage):** portfolio list/get, availability + pricing,
> DNS records, nameservers, auto-renew, and URL (domain) forwarding are built from
> the OpenAPI spec and **unit-tested**, but **not yet run against a live account**
> (there is no sandbox). Registration and renewal are deliberately **left out** —
> Unstoppable buys/renews through a multi-step cart→checkout flow that spends real
> money (`ud_cart_add_domain[_renewal]` → `ud_cart_checkout`), not a single call.
> Transfer-in, transfer lock, WHOIS privacy, and per-domain contacts have no
> equivalent in Unstoppable's model.

## Authentication

- **API key** in the format `ud_mcp_…`, generated under Account Settings →
  Advanced → **MCP API Key** (copyable any time). Sent as
  `Authorization: Bearer <key>`.
- OAuth 2.0 is also supported (scopes `domains:search`, `portfolio:read`,
  `portfolio:write`, `cart:*`, `checkout`); this adapter uses the API key.
- **No sandbox / test environment.** All calls act on the live account.

## Feature Support

| Feature                              | Support          | Notes / action                                                                                                                  |
| ------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Test connection / verify credentials | ✓                | No ping; `ud_portfolio_list` with `limit:1` is the lightest authenticated read                                                  |
| List domains                         | ✓                | `ud_portfolio_list` — paginated (`offset`/`limit`, max 500), filterable (`searchTerm`, `status`, `registryType`, `expiring…`)   |
| Get single domain details            | ✓                | No per-domain get; `ud_portfolio_list` with `searchTerm` + exact-name match                                                     |
| Check domain availability            | ✓                | `ud_domains_search` — `query` is a name or array; results carry `available` + `pricing.amount` (**cents**) + marketplace status |
| Get domain/TLD pricing               | ✓ (per-domain)   | From `ud_domains_search`; no per-TLD table. A bare TLD is priced via a probe label. Registration price only.                    |
| Register a new domain                | ✗ (out of scope) | `ud_cart_add_domain` → `ud_cart_checkout` (multi-step, spends money); not wired here                                            |
| Renew a domain                       | ✗ (out of scope) | `ud_cart_add_domain_renewal` → `ud_cart_checkout`; not wired here                                                               |
| Auto-renew toggle                    | ✓                | `ud_domain_auto_renewal_update` (`action: enable`/`disable`) — ICANN domains                                                    |
| Transfer domain in                   | ✗                | No inbound-transfer API                                                                                                         |
| Update nameservers                   | ✓                | `ud_dns_nameservers_set_custom` (also `…_set_default` to reset)                                                                 |
| Get nameservers                      | ✓                | `ud_dns_nameservers_list`                                                                                                       |
| Lock / unlock domain                 | ✗                | No transfer-lock concept                                                                                                        |
| Get/set WHOIS privacy                | ✗                | No privacy toggle                                                                                                               |
| Read / update contacts               | ~ / ✗            | `ud_contacts_list` returns **account-level** ICANN contacts by id; there's no per-domain contact read or reassignment           |
| DNS record management                | ✓                | `ud_dns_records_list` (cursor-paged); write via `ud_dns_record_add`/`_update`/`_remove` and `ud_dns_records_remove_all`         |
| DNSSEC                               | ~                | Readable on `ud_dns_nameservers_list`; no standalone enable/disable — not wired                                                 |
| Domain forwarding / URL redirect     | ✓                | DNS "hosting" configs: `ud_dns_hosting_list`/`_add`/`_remove` — `REDIRECT_301`/`REDIRECT_302` map to permanent/temporary        |
| Email forwarding                     | ✗                | No email-forwarding API                                                                                                         |
| Marketplace / offers / messaging     | ✓ (out of scope) | `ud_listing_*`, `ud_offers_*`, `ud_leads_*` — Unstoppable-specific, outside the registrar contract                              |

## Implementation notes

- **Reads go through `ud_domain_get` (batched, 50/call), not the dedicated
  endpoints.** `ud_portfolio_list` enumerates names but has no nameservers and no
  transfer-out signal; `ud_dns_nameservers_list` 400s for externally-parked names
  ("Domain registration is not valid for management"). `ud_domain_get` returns
  nameservers for every domain plus a `flags` map. So `listDomains` enumerates via
  the portfolio, then `ud_domain_get`s the names to fold in nameservers and **drop
  transferred-out domains** (`flags.DNS_TRANSFER_OUT.status === "ENABLED"` — these
  still appear in the portfolio list with `transferStatus:"none"`). That makes
  `requiresNameserversFetch` false. `ud_domain_get` is slow and server-throttled
  (~8-10s/call regardless of batch size), so a large account's list is slow (~70s
  for 852 domains) but complete in one pass.

- **Prices are integer cents.** `pricing.amount` (and `listing.price`) are in
  cents; divide by 100 for major units. `currency` is alongside.
- **Records hold multiple values.** A `ud_dns_records_list` record has a
  `values[]` array; `getDnsRecords` expands them into one `DnsRecord` per value,
  and `setDnsRecords` re-groups records sharing type + host into one multi-value
  record. MX priority travels inside the value as `"<priority> <host>"`.
- **`setDnsRecords` is a full replace** done as `ud_dns_records_remove_all`
  (which leaves the provider's read-only records) followed by `ud_dns_record_add`.
  An empty list just clears.
- **Writes return a `results` array**, not a status code per operation — map
  `failureCount`/per-row `success` to the library's `OperationResult`.
- **`applyToAllDomainsInPortfolio`** exists on the bulk write actions; this
  adapter always targets a single domain and never sets it.

## Sources

- https://docs.unstoppabledomains.com/apis/user-api/overview
- https://api.unstoppabledomains.com/mcp/v1/openapi.json
- https://support.unstoppabledomains.com/support/solutions/articles/48001280210-connect-your-ai-agent-to-unstoppable-domains

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

> **Implementation (read + manage):** reads were **live-verified** on an
> 852-domain account (2026-11). Every read and write — nameservers, DNS records,
> auto-renew, transfer lock, WHOIS privacy, URL forwarding, DNSSEC status — was
> **live-verified** on a test domain on 2026-11-04 (there is no sandbox; see
> the notes below for what that turned up). Registration and renewal are
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
- **No sandbox / test environment.** All calls act on the live account. The
  CLI docs list a sandbox at `api.ud-sandbox.com`, but that host doesn't resolve
  (checked 2026-11-04).

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
| Auto-renew toggle                    | ✓                | `ud_domain_auto_renewal_update` (`action: enable`/`disable`); enabling needs a saved card                                                                            |
| Transfer domain in                   | ✗                | No inbound-transfer API                                                                                                                                              |
| Update nameservers                   | ✓                | `ud_dns_nameservers_set_custom`; Unstoppable's own pair goes through `…_set_default`                                                                                 |
| Get nameservers                      | ✓                | `ud_domain_get` — `ud_dns_nameservers_list` 400s for some names                                                                                                      |
| Lock / unlock domain                 | ✓                | `ud_domain_flags_update` with `DNS_TRANSFER_OUT`: `ENABLED` = transfers allowed (unlocked), `DISABLED` = blocked (locked). Read from `ud_domain_get` `flags`.        |
| Get/set WHOIS privacy                | ✓                | `ud_domain_flags_update` with `DNS_WHOIS_PROXY`: `ENABLED` = contact details hidden. Read from `ud_domain_get` `flags`.                                              |
| Read / update contacts               | ~ / ✗            | `ud_contacts_list` returns **account-level** ICANN contacts by id; there's no per-domain contact read or reassignment                                                |
| DNS record management                | ✓                | `ud_dns_records_list` (cursor-paged); write via `ud_dns_record_add` (`upsertMode`), `_update`, `_remove` (by id) and `ud_dns_records_remove_all` — 50 records a call |
| DNSSEC                               | ~                | `getDnssec` reads `dns.dnssec.enabled` from `ud_domain_get` (no DS records there); on by default on Unstoppable's nameservers; no enable/disable call                |
| Domain forwarding / URL redirect     | ✓                | DNS "hosting" configs: `ud_dns_hosting_list`/`_add`/`_remove`, one host per call — `REDIRECT_301`/`REDIRECT_302` map to permanent/temporary                          |
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
- **Changes apply in the background.** Writes to DNS records, hosting,
  nameservers and flags return an `operationId` and are applied later (live: about
  70 s for DNS records, 15–60 s for nameservers or a redirect, 2 s for a flag).
  Until then the domain refuses another change with `CONCURRENT_OPERATION`
  ("Domain already has operation in progress"), even though the write that started
  it reported success. Every write therefore waits for the domain to be idle
  (`ud_domain_pending_operations`), sends, and then waits for its own operation,
  up to five minutes; one that fails later is reported as a failure, and one still
  running at the five-minute mark as accepted. A change that removes and adds DNS
  records makes two calls and takes a minute or two.
- **`ud_domain_get` lags behind nameserver changes.** After a nameserver change
  had finished, `ud_domain_get` kept showing the old nameservers (and two calls a
  moment apart disagreed on DNSSEC) for a few more minutes. Lock and privacy show
  their new value at once.
- **Custom nameservers set Unstoppable's DNS aside.** With custom nameservers the
  records list comes back empty and DNSSEC turns off; switching back to
  Unstoppable's nameservers (`updateNameservers` with
  `ns1/ns2.unstoppabledomains.com`, sent as `ud_dns_nameservers_set_default`)
  brings the records back and turns DNSSEC back on.
- **Auto-renew needs a saved card.** Without one, enabling fails with "No valid
  payment method found". An auto-renewal set up without a working card reads
  `autoRenewal.status: "update_required"`, which is reported as auto-renew off
  (it won't renew); disabling clears it to `null`.
- **Open question — transferred-out names.** In live testing, names that had
  already transferred away still came back from `ud_portfolio_list` with
  `transferStatus: "none"`. The adapter skips `isExternallyOwned` names; whether
  a completed transfer-out sets that flag still needs checking against a live
  account.
- **Prices are integer cents.** `pricing.amount` (and `listing.price`) are in
  cents; divide by 100 for major units. `currency` is alongside.
- **Availability counts aftermarket listings.** `available` is true for fresh
  registrations _and_ names listed on Unstoppable, Sedo or Afternic, even names
  already in this account (live: an owned name listed for offers on Sedo came back
  `available: true`). `marketplace.status` tells them apart: a fixed-price
  listing (`registered-listed-for-sale`) comes back `premium` at the listing
  price; one open only to offers isn't available. `getPricing` refuses listings
  (it only reports registration prices).
- **Records hold multiple values.** A `ud_dns_records_list` record has a
  `values[]` array; `getDnsRecords` expands them into one `DnsRecord` per value,
  and `setDnsRecords` re-groups records sharing type + host into one multi-value
  record. MX and SRV numbers travel inside the value (`"<priority> <host>"`,
  `"<priority> <weight> <port> <target>"`). The apex is `"@"` on writes; reads
  return it as `"@"`, null or empty. Unstoppable stores hostnames with a
  trailing dot and TXT values quoted (it adds them to bare values); reads return
  them bare and writes compare bare, so saving what was read changes nothing.
- **Read-only records are left out.** The records list includes Unstoppable's own
  SOA and apex NS, and the A/AAAA records behind a listing page or redirect
  (`readonly: true`). `getDnsRecords` leaves them out; `setDnsRecords` never
  touches them.
- **`setDnsRecords` writes only the difference.** It reads the zone, removes the
  records whose type + host is no longer wanted (`ud_dns_record_remove` by id),
  then writes new or changed ones with `ud_dns_record_add` in `replace` mode.
  Unchanged records aren't touched, so a failed write never leaves the zone
  empty. Desired values that match a read-only record are skipped.
- **Redirects replace the listing page.** A name on Unstoppable's nameservers
  shows its marketplace page (`LISTING_PAGE` hosting) on the apex and `www`.
  Adding a redirect on one of those hosts replaces the page there, and removing
  the redirect doesn't bring it back. A remove or add call that listed two hosts
  of one domain applied only one of them (and still reported success), so
  `setDomainForwarding` sends one host per call.
- **Writes return a `results` array**, not a status code per operation — map
  `failureCount`/per-row `success` to the library's `OperationResult`. A row's
  `error` can be a JSON string (`{"message","code"}`); its message is shown.
- **`applyToAllDomainsInPortfolio`** exists on the bulk write actions; this
  adapter always targets a single domain and never sets it.

## Sources

- https://docs.unstoppabledomains.com/apis/user-api/overview
- https://api.unstoppabledomains.com/mcp/v1/openapi.json
- https://support.unstoppabledomains.com/support/solutions/articles/48001280210-connect-your-ai-agent-to-unstoppable-domains

# Namecheap — API Research

> Researched: 2026-08-26 · **Live-verified: 2026-08-29** · Docs: https://www.namecheap.com/support/api/intro/ , https://www.namecheap.com/support/api/methods/

## Live verification (2026-08-29)

Exercised end-to-end against the **sandbox** (`https://api.sandbox.namecheap.com/xml.response`,
separate account, query-string auth) on a freshly registered test domain. Every
core read and write path ran live and was read back, except `transferIn` (needs
an external domain + auth code, not reproducible in the sandbox).

**Reads — all verified:** `testConnection`, `listDomains`, `checkAvailability`,
`getPricing`, `getDomain`, `getNameservers`, `getContacts`, `getDnsRecords`,
`getEmailForwarding`, `getDomainForwarding`.

**Writes — all verified:** `registerDomain`, `renewDomain` (expiry advanced),
`setAutoRenew`, `lockDomain`/`unlockDomain`, `updateNameservers`, `setDnsRecords`,
`updateContacts`, `setPrivacy` (WhoisGuard toggles on/off — a real change, not a
no-op), `setEmailForwarding`, `setDomainForwarding`.

**Fixes/discoveries from this pass:**

- **`setAutoRenew` is implementable** (was `NotImplementedError`). The command
  `namecheap.domains.setAutoRenew` isn't in the published method index but is live;
  it takes `DomainName` + `IsAutoRenew` (an `SLD`/`TLD` form is rejected) and
  returns its own `IsSuccess` flag inside an otherwise-`OK` envelope — the client
  reads that inner flag, not the envelope status.
- **`getDomain` lock source fixed.** `locked` now comes from the dedicated
  `namecheap.domains.getRegistrarLock` command. getList's per-row `IsLocked` lags:
  after a lock the API reported as applied (`RegistrarLockStatus=true`), getList
  still returned `IsLocked=false`. The dedicated command is authoritative and costs
  the same single call.
- **Sandbox getList staleness.** getList's `IsLocked`/`AutoRenew` columns don't
  reflect recent toggles in the sandbox even when the write succeeded — verify via
  the dedicated per-domain commands, not the list.
- **Restoring Namecheap DNS needs `dns.setDefault`.** Passing the BasicDNS hosts
  (`dns1.registrar-servers.com`) to `updateNameservers` (setCustom) is rejected
  ("BasicDNS can not be used as Custom DNS"); reverting to Namecheap DNS is a
  distinct `namecheap.domains.dns.setDefault` command (out of the core contract's
  scope — `updateNameservers` is for custom NS).
- Registration requires the whitelisted `ClientIp` to also be the request's
  outbound IP; both must match.

## Overview

Namecheap exposes a legacy-style XML API (REST-ish over HTTP GET/POST, XML request/response only — no JSON option) covering domains, DNS, WHOIS privacy (WhoisGuard), SSL, and account/user management. Production base URL is `https://api.namecheap.com/xml.response`; a full sandbox mirror is available at `https://api.sandbox.namecheap.com/xml.response` (separate account required at sandbox.namecheap.com, periodically reset). Every call is a `Command` query parameter (e.g. `namecheap.domains.check`) plus shared auth parameters.

## Authentication

Auth is via query-string parameters on every request — no bearer tokens or signed requests: `ApiUser`, `ApiKey`, `UserName` (account username, usually same as ApiUser unless calling on behalf of a sub-account), and `ClientIp`. The ApiKey is generated in the account's API access settings once API access is enabled. **IP allowlisting is mandatory**: at least one IPv4 address must be whitelisted in the Namecheap account before any call succeeds, and calls from a non-whitelisted `ClientIp` are rejected outright — no dynamic/CIDR support noted, must be static IPv4. There is no OAuth or per-request signing; the ApiKey itself is the long-lived secret.

## Feature Support

| Feature                                     | Support | Notes / endpoint (Namecheap command name)                                                                                                                                                                                                     |
| ------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test connection / verify credentials        | ~       | No dedicated ping; convention is a cheap call like `namecheap.domains.getList` or `namecheap.users.getBalances`                                                                                                                               |
| List domains                                | ✓       | `namecheap.domains.getList`                                                                                                                                                                                                                   |
| Get single domain details                   | ✓       | `namecheap.domains.getInfo`                                                                                                                                                                                                                   |
| Check domain availability                   | ✓       | `namecheap.domains.check` (supports batch, comma-separated domains)                                                                                                                                                                           |
| Get domain/TLD pricing                      | ✓       | `namecheap.users.getPricing` (register/renew/transfer prices incl. promos), `namecheap.domains.getTldList` (TLD metadata: min/max years, API-registerable/renewable flags)                                                                    |
| Register a new domain                       | ✓       | `namecheap.domains.create`                                                                                                                                                                                                                    |
| Renew a domain                              | ✓       | `namecheap.domains.renew`; `namecheap.domains.reactivate` for expired domains                                                                                                                                                                 |
| Auto-renew toggle                           | ✓       | `namecheap.domains.setAutoRenew` (DomainName + IsAutoRenew). Not in the published method index but live-verified; returns its own `IsSuccess` flag                                                                                            |
| Transfer domain in                          | ✓       | `namecheap.domains.transfer.create` (limited TLD list: .com/.net/.org/.co/.info/.biz/.me/.tv/.us/.ca/.cc/.in/.mobi/.pe/.es and a few ccTLD variants)                                                                                          |
| Transfer out / get auth/EPP code            | ~       | No documented API method to fetch EPP code directly; EPP/auth code retrieval is dashboard-only ("Get EPP Code" link after unlocking), domain must be unlocked first via `setRegistrarLock`                                                    |
| Update nameservers                          | ✓       | `namecheap.domains.dns.setCustom` (custom NS) / `namecheap.domains.dns.setDefault` (revert to Namecheap DNS)                                                                                                                                  |
| Get nameservers                             | ✓       | `namecheap.domains.dns.getList`                                                                                                                                                                                                               |
| Lock / unlock domain (transfer lock)        | ✓       | `namecheap.domains.getRegistrarLock` / `namecheap.domains.setRegistrarLock`                                                                                                                                                                   |
| Get/set WHOIS privacy                       | ✓       | WhoisGuard command group: `namecheap.whoisguard.getList`, `.enable`, `.disable`, `.renew`, `.changeEmailAddress`                                                                                                                              |
| Update contact info (registrant/admin/tech) | ✓       | `namecheap.domains.getContacts` / `namecheap.domains.setContacts` (Registrant/Admin/Tech/AuxBilling contact sets)                                                                                                                             |
| DNS record management                       | ✓       | `namecheap.domains.dns.getHosts` / `namecheap.domains.dns.setHosts` (A, AAAA, CNAME, MX, TXT, NS, URL, URL301, FRAME record types; only for domains on Namecheap BasicDNS/FreeDNS/PremiumDNS — not available once custom nameservers are set) |
| DNSSEC management                           | ✗       | No documented DNSSEC command group in the public API method list; DNSSEC is managed only via the web dashboard (Advanced DNS tab)                                                                                                             |
| Glue / host records                         | ~       | Personal/glue nameserver management (`namecheap.domains.ns.create/delete/getInfo/update`) exists as an API command group per third-party references, but not confirmed directly from primary docs in this pass — flag as needing verification |
| Email forwarding / mailbox provisioning     | ~       | `namecheap.domains.dns.getEmailForwarding` / `.setEmailForwarding` covers alias-style email forwarding only; no full mailbox provisioning (Private Email product) exposed via this API                                                        |
| Domain forwarding / URL redirect            | ✓       | Implemented via `domains.dns.setHosts` special record types `URL` (302), `URL301` (permanent), and `FRAME` (masked redirect)                                                                                                                  |
| Webhooks / event notifications              | ✗       | No webhook/event-subscription capability documented; API is pull/poll-only                                                                                                                                                                    |

## Notable / Unique Features

- **WhoisGuard privacy as a distinct manageable entity** (own get/enable/disable/renew/changeEmail lifecycle, separate from the domain itself) — generic name: `getPrivacyStatus(domain)` / `setPrivacy(domain, enabled)`.
- **URL/FRAME redirect as pseudo DNS record types** (`URL`, `URL301`, `FRAME`) rather than a separate forwarding endpoint — generic name: `setDomainForwarding(domain, target, type)`.
- **Sandbox is a full account-level mirror environment** (separate signup at sandbox.namecheap.com, periodic resets) rather than a flag/test-mode on the same account — worth modeling as a distinct base-URL/env concept in the client.
- **Hard account-eligibility gate for API access** (balance/spend/domain-count thresholds — see below) — a capability check other registrars in this comparison set may not require at all.

## Auth / Access Notes for Implementors

- Credentials: enable "API Access" in Namecheap account profile → generates `ApiKey`; `ApiUser`/`UserName` is the account login name.
- **Eligibility gate**: production API access requires the account meet at least one of: ≥20 domains registered, ≥$50 account balance, or ≥$50 spent within the last 2 years. Sandbox has no such requirement — build/test there first.
- **IP allowlisting is mandatory and static IPv4-only**; must be pre-registered in account settings before any call from that IP succeeds — plan for allowlist management as an onboarding step, not just credential entry.
- **Rate limits** (per API key, best available figures — not fully confirmed in primary docs, treat as approximate): ~50 requests/minute, 700/hour, 8000/day (older references cite 20/min instead of 50/min, suggesting this may have changed over time or vary by account).
- Responses are XML only; errors come back as `<Errors>` nodes with numeric codes in a 200-OK envelope (not HTTP status codes) — client must parse the XML body to detect failure, not rely on HTTP status.
- Sandbox base URL: `https://api.sandbox.namecheap.com/xml.response`; production: `https://api.namecheap.com/xml.response`.

## Sources

- [Intro to API for Developers](https://www.namecheap.com/support/api/intro/)
- [API Methods for Developers](https://www.namecheap.com/support/api/methods/)
- [Namecheap API - Domains](https://www.namecheap.com/support/api/methods/domains/)
- [Namecheap API - Domains.Dns](https://www.namecheap.com/support/api/methods/domains-dns/)
- [namecheap.domains.getList](https://www.namecheap.com/support/api/methods/domains/get-list/)
- [namecheap.domains.getTldList](https://www.namecheap.com/support/api/methods/domains/get-tld-list/)
- [namecheap.domains.check](https://www.namecheap.com/support/api/methods/domains/check/)
- [namecheap.domains.getContacts](https://www.namecheap.com/support/api/methods/domains/get-contacts/)
- [namecheap.domains.setContacts](https://www.namecheap.com/support/api/methods/domains/set-contacts/)
- [namecheap.domains.getRegistrarLock](https://www.namecheap.com/support/api/methods/domains/get-registrar-lock/)
- [namecheap.domains.dns.setCustom](https://www.namecheap.com/support/api/methods/domains-dns/set-custom/)
- [namecheap.domains.dns.setHosts](https://www.namecheap.com/support/api/methods/domains-dns/set-hosts/)
- [namecheap.domains.dns.getHosts](https://www.namecheap.com/support/api/methods/domains-dns/get-hosts/)
- [namecheap.domains.transfer.create](https://www.namecheap.com/support/api/methods/domains-transfer/create/)
- [namecheap.whoisguard.enable](https://www.namecheap.com/support/api/methods/domainprivacy/enable/)
- [namecheap.users.getPricing](https://www.namecheap.com/support/api/methods/users/get-pricing/)
- [What is Sandbox?](https://www.namecheap.com/support/knowledgebase/article.aspx/763/63/what-is-sandbox/)
- [API - FAQ](https://www.namecheap.com/support/knowledgebase/article.aspx/9739/63/api-faq/)
- [What is DNSSEC?](https://www.namecheap.com/support/knowledgebase/article.aspx/9717/2232/what-is-dnssec/)
- [Types of Domain Redirects](https://www.namecheap.com/support/knowledgebase/article.aspx/9604/2237/types-of-domain-redirects-301-302-url-redirects-url-frame-and-cname/)

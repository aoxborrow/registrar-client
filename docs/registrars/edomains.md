# eDomains — API Research

> Researched: 2026-08-26 · Docs: none found (no public developer/API documentation exists)

## Overview

"eDomains" most plausibly refers to **Edomains LLC** (edomains.com), a small ICANN-accredited domain registrar based in the United States (IANA registrar ID 3804, contact Cristian Gonzalez, phone +1 307-274-4655, RDAP endpoint `https://rdap.edomains.com/rdap/`). No other registrar or SaaS product trading under the name "eDomains" was found (no NZ, UK, or Ireland-based candidate turned up in search). The site is built on **WHMCS** (confirmed via a `WHMCSYL...` session cookie), and standard end-user features exist (register, transfer, pricing page, knowledgebase, WHOIS lookup). No public, documented developer/reseller API was found anywhere on the site, in ICANN/IANA registrar records, or in general web search. A path at `https://www.edomains.com/api/` does respond, but only with a bare JSON error (`{"error":"Command is required"}`) and no accompanying documentation — this is very likely an internal/undocumented endpoint used by their own WHMCS-based client area, not a published third-party API. Base URL, protocol, auth model, and sandbox availability are therefore **unknown/not publicly documented**.

## Authentication

Unknown / not publicly documented. No developer portal, API key signup flow, or auth documentation was found. The undocumented `/api/` endpoint returning `{"error":"Command is required"}` suggests some command-based request format exists internally, but no parameter names, auth scheme, or credentials-provisioning process are published.

## Feature Support

| Feature                              | Support | Notes                                                        | Endpoint |
| ------------------------------------ | ------- | ------------------------------------------------------------ | -------- |
| Test connection / verify credentials | ✗       | No public API/auth docs found                                | —        |
| List domains                         | ✗       | No public API                                                | —        |
| Get single domain details            | ✗       | No public API                                                | —        |
| Check domain availability            | ✗       | Only via website search form, not a documented API           | —        |
| Get domain/TLD pricing               | ✗       | Human-readable pricing page only (`/domain/pricing`), no API | —        |
| Register a new domain                | ✗       | Website-only checkout flow                                   | —        |
| Renew a domain                       | ✗       | Website/client-area only                                     | —        |
| Auto-renew toggle                    | ✗       | Not documented                                               | —        |
| Transfer domain in                   | ✗       | Website-only transfer form                                   | —        |
| Transfer out / get auth-EPP code     | ✗       | Not documented (likely via WHMCS client-area support ticket) | —        |
| Update nameservers                   | ✗       | Not documented                                               | —        |
| Get nameservers                      | ✗       | Not documented                                               | —        |
| Lock / unlock domain (transfer lock) | ✗       | Not documented                                               | —        |
| Get/set WHOIS privacy                | ✗       | Not documented                                               | —        |
| Update contact info                  | ✗       | Not documented                                               | —        |
| DNS record management                | ✗       | Knowledgebase has manual "add TXT record" article; no API    | —        |
| DNSSEC management                    | ✗       | Not documented                                               | —        |
| Glue / host records                  | ✗       | Not documented                                               | —        |
| Email forwarding                     | ✗       | Not documented                                               | —        |
| Domain forwarding / URL redirect     | ✗       | Not documented                                               | —        |
| Webhooks                             | ✗       | Not documented                                               | —        |

## Implementation quick-reference

No usable public API was found. The only API-shaped artifact discovered is an unauthenticated probe of `https://www.edomains.com/api/`, which returned `HTTP 200` with body `{"error":"Command is required"}` and a `WHMCSYL...` session cookie — indicating the site runs on WHMCS and that this path is almost certainly an internal AJAX/JSON endpoint consumed by their own client-area JavaScript, not a documented, stable, third-party-facing API. No parameter names, response shapes, base URL for a versioned API, or auth headers are published. Building against this endpoint would mean reverse-engineering an undocumented, unsupported internal interface — not recommended for a registrar-client integration.

## Notable / Unique Features

- Identity ambiguity: "eDomains" was checked against several possible readings (edomains.com/Edomains LLC, an Ireland/UK-focused registrar, a New Zealand registrar, and a reseller-platform white-label under Tucows/Enom/OpenSRS/Ascio or Dynadot). Only **Edomains LLC** (edomains.com, IANA ID 3804) was confirmed to exist as an actual ICANN-accredited registrar under this name; no other real "eDomains" registrar candidate was found.
- The site runs on WHMCS (confirmed via session cookie naming), which is a common billing/client-management platform for small/mid-size registrars and hosts — WHMCS itself has domain-provisioning modules, but those are for the WHMCS operator's back-end registrar integrations, not a public API exposed by edomains.com to its own customers.
- An undocumented endpoint at `/api/` exists and responds to requests, hinting at some internal command-based JSON API, but nothing about it is published, versioned, or supported.
- No reseller program, developer portal, or API keys/signup flow could be found anywhere on the site or via web search.

## Auth / Access Notes for Implementors

There is no known way to obtain API credentials for Edomains LLC — no developer portal, no reseller/API signup flow, no sandbox environment, and no published documentation describing how (or whether) API access could be requested. Anyone needing this would have to contact edomains.com support directly and ask if any private/undocumented API or reseller agreement exists; based on available public information, this cannot be assumed or relied upon for integration work.

## Sources

- [https://www.edomains.com](https://www.edomains.com)
- [https://domaindetails.com/registrars/edomains-llc](https://domaindetails.com/registrars/edomains-llc)
- [https://www.edomains.com/api/](https://www.edomains.com/api/) (raw response: `{"error":"Command is required"}`)
- [https://www.icann.org/en/contracted-parties/accredited-registrars/list-of-accredited-registrars](https://www.icann.org/en/contracted-parties/accredited-registrars/list-of-accredited-registrars)
- [https://domaindetails.com/registrars](https://domaindetails.com/registrars)

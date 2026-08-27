# Network Solutions — API Research

> Researched: 2026-08-26 · Docs: https://partners.networksolutions.com/en_US/help/faq-main.html · https://ecomapi.networksolutions.com/ · https://www.srsplus.com/resellertools/api.aspx

## Overview

Network Solutions has **no self-serve public API** for regular retail accounts — there is no "developer portal," API key generator, or published REST/JSON reference a normal customer can sign up for. Domain-management API access exists only through two gated channels: (1) the **Partner Protocol**, an XML-based API tied to the Wholesale Partner Program / Partner Portal, and (2) **SRSplus**, a white-label reseller API (also XML-based) operated as "a Web.com Company." Both require a partner/reseller agreement (and for Wholesale, a volume commitment) before any credentials or technical docs are issued; no base URLs, request/response schemas, or sandbox details are publicly documented. A separate, unrelated "Ecommerce API" sign-up form (ecomapi.networksolutions.com) exists for a different product line (mentions SOAP WSDL + REST docs, token auth) but does not appear to cover domain lifecycle management and its docs are only sent after manual approval.

## Authentication

- **Partner Protocol (Wholesale)**: Not publicly documented; FAQ page gives no auth details (no mention of API keys, OAuth, or IP allowlisting) — access/credentials are provisioned after signing a Wholesale Partner agreement.
- **SRSplus API**: "Secure IP authentication access to our servers" — i.e., IP allowlisting rather than API keys/OAuth. Separate development and production environments are provided after signup.
- **Ecommerce API**: Token-based ("Renew User Token" option seen on the signup portal), but scope/relevance to domain management is unconfirmed.
- Overall: **partner-gated**. No credentials can be obtained without an approved reseller/wholesale/partner account.

## Feature Support

| Feature                              | Support | Notes                                                                                                 |
| ------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------- |
| Test connection / verify credentials | ✗       | No public API; gated behind partner signup                                                            |
| List domains                         | ~       | Claimed available in Partner Protocol/Partner Portal per marketing copy, undocumented publicly        |
| Get single domain details            | ~       | Same as above, undocumented                                                                           |
| Check domain availability            | ~       | Likely present (standard for reseller platforms) but no public spec                                   |
| Get domain/TLD pricing               | ✗       | No public pricing API found                                                                           |
| Register a new domain                | ~       | Marketing copy states "real-time domain registrations" via Wholesale/Partner Protocol; no public spec |
| Renew a domain                       | ~       | Marketing copy mentions "bulk registrations and renewals"; no public spec                             |
| Auto-renew toggle                    | ✗       | Not mentioned anywhere in available materials                                                         |
| Transfer domain in                   | ✗       | Not documented publicly                                                                               |
| Transfer out / get auth-EPP code     | ✗       | Not documented publicly                                                                               |
| Update nameservers                   | ~       | "Rapid DNS modifications" mentioned for Wholesale program; no public spec                             |
| Get nameservers                      | ~       | Presumably possible if updates are, unconfirmed                                                       |
| Lock / unlock domain (transfer lock) | ✗       | Not documented publicly                                                                               |
| Get/set WHOIS privacy                | ✗       | Not documented publicly                                                                               |
| Update contact info                  | ~       | "Global updates to ... contact information" mentioned for Partner Protocol; no public spec            |
| DNS record management                | ~       | "Rapid DNS modifications" mentioned; granularity unknown                                              |
| DNSSEC management                    | ✗       | Not mentioned                                                                                         |
| Glue / host records                  | ✗       | Not mentioned                                                                                         |
| Email forwarding                     | ✗       | Not mentioned in API context (retail control panel feature only)                                      |
| Domain forwarding / URL redirect     | ✗       | Not mentioned in API context                                                                          |
| Webhooks                             | ✗       | No mention of webhooks/callbacks anywhere                                                             |

Legend: ✓ documented and available · ~ claimed/plausible but not publicly specified · ✗ not available / not documented.

## Implementation quick-reference

No implementable spec exists publicly for any of the six operations (test connection, list domains, renew, set nameservers, lock, unlock). Both real API surfaces are **partner-gated and undocumented to the public**:

- **Partner Protocol**: Described only as an "XML API" that is "the foundation for real-time binding to our service delivery platform." No endpoint paths, request/response XML schemas, base URL, or auth headers are published. A prior public PDF reference (`content.networksolutions.com/.../public-api-documentation.pdf`) returned HTTP 403 during this research, confirming it is no longer openly accessible. Historical mentions point to `ftp.networksolutions.com/partners/XML/` as a partner-only doc drop, not a public reference.
- **SRSplus API**: XML-based, IP-allowlisted, with separate dev/production servers — but no endpoint list, WSDL, or schema is published; access is granted only after completing partner signup at partnersignup.srsplus.com.
- **Ecommerce API**: Has a SOAP WSDL link and "API Documentation" link on its signup page, but both are gated behind submitting the intake form and being manually approved/emailed instructions; not fetchable as an anonymous developer, and its relevance to domain lifecycle management (vs. other e-commerce/hosting products) is unconfirmed.

Given none of these expose a publicly readable spec, **this API cannot currently be implemented** against the registrar-client library without first obtaining a partner/wholesale/reseller agreement and being sent private documentation directly by Network Solutions/SRSplus.

## Notable / Unique Features

- No public, self-serve API exists for regular Network Solutions retail customers — this is a hard access gate, not merely sparse documentation.
- Two distinct partner-tier products offer domain-management APIs: the **Wholesale Partner Program / Partner Protocol** (requires a volume commitment) and **SRSplus** (targeted at mid/large resellers wanting a white-label integration).
- SRSplus explicitly identifies itself as **"a Web.com Company,"** confirming it is the shared reseller/API backend historically used across Web.com-family brands. Network Solutions and Web.com are both Newfold Digital brands, and in 2025 Newfold merged Web.com's retail accounts into Network Solutions (sunsetting the Web.com brand) — consistent with these brands sharing underlying reseller infrastructure (SRSplus / Partner Protocol) rather than each maintaining an independent public API.
- A separate "Ecommerce API" (ecomapi.networksolutions.com) exists but is a distinct product line from domain reseller APIs, gated behind a manual-approval intake form, and its coverage of domain operations is unconfirmed.

## Auth / Access Notes for Implementors

- To obtain any API access, a business must apply to become a Network Solutions **Wholesale Partner** (volume commitment required) or an **SRSplus** reseller (white-label, IP-authenticated, dev + production environments) — both via sales/partner-signup forms, not self-service developer signup.
- No rate limits, sandbox/OT&E environment names, or SLA details are published for either program; SRSplus does mention separate "development and production servers" are provided to accepted partners.
- No evidence of a free/no-commitment tier or trial API key.
- Given the total absence of public technical specs, any implementation attempt would require directly contacting Network Solutions Wholesale sales or SRSplus partner support to obtain private documentation and credentials before development could begin.

## Sources

- [Public API](http://www.networksolutions.com/support/public-api/) (404 — page no longer exists)
- [Help | Network Solutions (Partner Protocol FAQ)](https://partners.networksolutions.com/en_US/help/faq-main.html)
- [Network Solutions Ecommerce API - Sign Up](https://ecomapi.networksolutions.com/)
- [The Wholesale Partner Program | Network Solutions](https://www.networksolutions.com/partners/wholesale/index.jsp)
- [Public API documentation PDF (content.networksolutions.com)](https://content.networksolutions.com/netsol/pdf/commerce-space/public-api-documentation.pdf) (403 Forbidden — no longer publicly accessible)
- [SRSplus Reseller API](https://www.srsplus.com/resellertools/api.aspx)
- [SRSplus Reseller Tools](https://www.srsplus.com/reseller-tools.aspx)
- [Network Solutions and Web.com Consolidate — Newfold Digital newsroom](https://www.newfold.com/newsroom/-network-solutions-and-web-com-consolidate-to-deliver-an-even-st)
- [Newfold is killing the Web.com brand, accounts will migrate to Network Solutions — Domain Name Wire](https://domainnamewire.com/2025/04/24/newfold-is-killing-the-web-com-brand-accounts-will-migrate-to-network-solutions/)

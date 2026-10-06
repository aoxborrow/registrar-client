# 101domain

Adapter: `createRegistrar('101domain', { apiKey })`. API base:
`https://api.101domain.com/v1`. Authentication is an HTTPS Bearer token. The
adapter has no sandbox endpoint and rejects `environment: 'sandbox'`.

## Credentials

The primary user, with 2FA or SSO enabled, creates a key under My Account →
Developer Tools – API & MCP. Tokens are shown once and expire after at most
one year. Scopes cannot be added after creation. The control panel and technical
specification use underscores (`domains_read`); some help pages use colons.

- `domains_read`: portfolio/detail and forwarding reads.
- `dns_read`: nameserver and DNS record reads.
- `dns_write`: nameserver and DNS record changes.
- `domains_write`: forwarding changes.

Availability and TLD pricing need a valid token but no additional scopes.
Finance/account/product scopes are not needed by this adapter. Optional IP
restrictions support IPv4/IPv6, up to ten addresses, without CIDR ranges.

## Supported operations and limits

- Portfolio and detail reads normalize domain names, registration/expiration
  dates, lifecycle status, auto-renew and registry transfer-lock status. Privacy
  is not reported; the generic boolean default does not prove privacy is off.
  Contact handles are not contact objects and are not exposed as such.
- Listing follows `meta.pagination`, at 50 names per page, and rejects missing
  pages, duplicate names and inconsistent totals. A partial result never becomes
  a successful portfolio. Reads support standard retry/backoff and cancellation.
- Availability checks use batches of at most 50 names. Bulk searches have a
  documented limit of five requests/minute and thirty/hour. Pricing requests use
  a one-year term, preserve currency and do not fabricate missing prices. Prefix
  compound TLDs with a dot (`.co.uk`). An owned domain may have no search quote;
  public TLD pricing is not proof of that domain's premium renewal price.
- Nameservers: 2–13 distinct hostnames; no glue records. Accepted changes return
  `pending: true` until registry processing completes. Callers must re-read the
  nameservers rather than immediately showing the submitted set as active.
- DNS records: A, AAAA, CNAME, NS (subdomains), MX, TXT, SRV and CAA. Available
  only on 101domain/SWA managed DNS. Content-derived record IDs change after an
  edit. `setDnsRecords` reconciles the complete custom zone: preserve identical
  records, create additions, then delete stale IDs in batches of 25. Replacement
  is not atomic. A rejected creation leaves stale records intact; a partial
  failure requires reading the zone before retrying. Apex NS is never replaced
  through the records API. Incompatible CNAME transitions can be rejected by the
  registrar; the adapter stops rather than removing existing records first.
- URL forwarding: one permanent (301) apex rule. Existing cloaked forwarding is
  readable as `masked`; creating masking, temporary redirects and subdomain
  forwarding is rejected. An empty rule list removes forwarding.

Registration, renewal, auto-renew changes, transfer-in, EPP codes, lock/privacy
changes, contacts and DNSSEC are unimplemented. The inherited core `features`
list represents the library contract; unsupported core methods still throw
`NotImplementedError`. Consumers should gate these known API gaps explicitly.
Only the implemented URL-forwarding methods are declared as extended features.

Unknown write outcomes are never automatically repeated. HTTP error bodies,
network excerpts and parser errors do not expose tokens or upstream private data.
Account rate limits aggregate all keys; numeric RPS/RPH quotas are account-specific.

## Verification

Unit tests: `TZ=UTC npm test -- test/domain101.test.ts`. For live validation,
first compare a read-only list/detail result against the account portal. Test DNS
or forwarding writes only on an explicitly disposable domain. No live account
or write verification is implied by offline tests.

## Sources checked 2026-10-06

- [OpenAPI 1.1.0](https://api.101domain.com/api/documentation)
- [API key creation](https://help.101domain.com/kb/how-to-get-api-keys)
- [Endpoint reference](https://help.101domain.com/kb/api-endpoints-reference)
- [DNS writes](https://help.101domain.com/kb/dns-record-and-name-server-management-api-write-endpoints)
- [Account quotas](https://help.101domain.com/kb/api-key-limits)

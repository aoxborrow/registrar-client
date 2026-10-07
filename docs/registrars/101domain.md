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

A read-only key (`domains_read` + `dns_read`) connects and syncs normally. A
write it isn't scoped for fails with an `AuthorizationError` that names the
missing scope ("this API key does not have the dns_write scope…"); write
methods that return an `OperationResult` report it as `success: false` with no
`outcome`, since nothing was changed.
Finance/account/product scopes are not needed by this adapter. Optional IP
restrictions support IPv4/IPv6, up to ten addresses, without CIDR ranges.

## Supported operations and limits

- Portfolio and detail reads normalize domain names, registration/expiration
  dates, lifecycle status, auto-renew and registry transfer-lock status. Privacy
  is not reported; the generic boolean default does not prove privacy is off.
  Contact handles are not contact objects and are not exposed as such.
- `GET /domains` returns every order the account has placed, so the list drops
  names it doesn't hold: `DELETED`, `CANCELLED`, `DENIED` (a failed application),
  `XFER_AWAY` (transferred out), incoming `XFER_IN_*` transfers, and any name
  with no `registered_at`. `getDomain` on one of these returns `deleted: true`.
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
- DNS records: A, AAAA, CNAME, NS (subdomains), MX, TXT, SRV and CAA. The API
  returns hostnames with a trailing dot and TXT as quoted strings; both are read
  and compared bare, so re-saving a zone as read changes nothing. Available
  only on 101domain/SWA managed DNS. Content-derived record IDs change after an
  edit. `setDnsRecords` reconciles the complete custom zone: preserve identical
  records, PATCH existing host/type pairs, create additions, then delete stale IDs
  in batches of 25. Edited records receive new IDs and are never stale-deleted. Replacement
  is not atomic. A rejected creation leaves stale records intact; a partial
  failure requires reading the zone before retrying. Apex NS is never replaced
  through the records API. Cross-type CNAME transitions can be rejected by the
  registrar; the adapter stops rather than removing existing records first.
- URL forwarding: one permanent (301) apex rule. A domain with no rule reports
  `web_forwarding: {destination: null, type: null}`. Existing cloaked forwarding is
  readable as `masked`; creating masking, temporary redirects and subdomain
  forwarding is rejected. An empty rule list removes forwarding.

Registration, renewal, auto-renew changes, transfer-in, EPP codes, lock/privacy
changes, contacts and DNSSEC are unimplemented. The inherited core `features`
list represents the library contract; unsupported core methods still throw
`NotImplementedError`. Consumers should gate these known API gaps explicitly.
Only the implemented URL-forwarding methods are declared as extended features.

Unknown write outcomes are never automatically repeated. Of an HTTP error body
only the API's own `code` (as `providerCode`, e.g. `NAMESERVERS_NOT_LOCAL`) and
`message` are kept; network excerpts and parser errors are not surfaced. The API
host is behind Cloudflare, and a 403 without an API error body (a bot challenge)
is reported as refused before reaching the API.
Account rate limits aggregate all keys; numeric RPS/RPH quotas are account-specific.

## Verification

Unit tests: `TZ=UTC npm test -- test/domain101.test.ts`. For live validation,
first compare a read-only list/detail result against the account portal. Test DNS
or forwarding writes only on an explicitly disposable domain.

Live-verified 2026-10-06 (reads only, from Node): connection, portfolio
filtering, detail, nameservers, DNS records (and the third-party-nameserver
error), forwarding with and without a rule, availability with prices, and TLD
and domain pricing.

Writes live-verified 2026-10-07 on a test domain: DNS add, edit by ID, no-op
re-save and restore; forwarding change, clear and create. A nameserver change
on an update-locked domain (`clientUpdateProhibited`) returns "This domain is
currently update-locked"; the API can't remove that lock, and an unlocked
nameserver change is not yet verified.

## Sources checked 2026-10-06

- [OpenAPI 1.1.0](https://api.101domain.com/api/documentation)
- [API key creation](https://help.101domain.com/kb/how-to-get-api-keys)
- [Endpoint reference](https://help.101domain.com/kb/api-endpoints-reference)
- [DNS writes](https://help.101domain.com/kb/dns-record-and-name-server-management-api-write-endpoints)
- [Account quotas](https://help.101domain.com/kb/api-key-limits)

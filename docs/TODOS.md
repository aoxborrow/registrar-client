# TODOs

Open items found during live write-testing (PR #24), the core-write build-out
(PR #25), the extended-capabilities build-out (PR #26), plus NameBright and Gandi
live testing. Verified items are omitted; these are what's still unproven or
blocked. See `docs/registrars/FEATURES.md` for the full status matrix.

## Needs live testing (built + unit-tested, not executed)

- [ ] `registerDomain` / `renewDomain` / `transferIn` on **NameSilo** (and
      NameBright register/renew) — paid/irreversible; built to documented
      shapes, never run. (Dynadot, Gandi register+renew, Porkbun, and Namecheap
      register+renew are sandbox-verified; Namecheap and Gandi `transferIn` need an
      external domain + auth code, not reproducible in the sandbox.)
- [ ] **GoDaddy** register/renew/transfer — v3 register (quote→execute) is paid
      with **no v3 sandbox** (OTE is v1-only). The v1 purchase path is correct
      (`POST /v1/domains/purchase/validate` returns 200 for our body) but OTE
      returns `500 ERROR_UNKNOWN` on the actual purchase: OTE purchases require an
      **API Reseller account** (a paid tier) with a Good as Gold balance, created
      via the Reseller Control Center (reseller.godaddy.com → Settings → API Keys
      → Test). A plain developer key can read/validate but not purchase. Blocked
      until/unless a reseller account is set up; the client code is already
      validated for this path.
- [ ] **GoDaddy** `updateNameservers` (v3 PUT bare-array) — built + unit-tested;
      not run live (would repoint a real domain's NS). Verify with a reversible swap.
- [ ] `updateContacts` on **NameSilo, GoDaddy** — can trigger registrant-change
      verification / 60-day locks; reviewed only. (Dynadot, Gandi, and Namecheap
      are sandbox-verified.)
- [ ] **GoDaddy** `setPrivacy` — disabling is a one-way DELETE (enabling is a paid
      purchase, left `NotImplementedError`); not exercised.
- [ ] **Extended features on GoDaddy / NameSilo** (authCode, DNSSEC
      read/disable, email + domain forwarding) — built from docs only; add sandbox
      creds to `.env.testing` and verify. (Dynadot, Gandi, and Porkbun are
      sandbox-verified; GoDaddy forwarding is v1-only — check on a real domain.
      Spaceship `getAuthCode` is now live-verified — see confirmed quirks below.)
- [ ] **NameBright** `updateNameservers` — coded from the documented endpoints; no
      safe way to test NS replacement on the live account, so unverified.
- [ ] **Dynadot** DNSSEC enabled→disabled transition — `disableDnssec`/`getDnssec`
      verified, but the sandbox rejects every DNSSEC _enable_ body, so the full
      round-trip is untested.
- [ ] **NameSilo** domain forwarding — apex-only read + clear-via-default-NS are
      unverified; confirm the `domainForward` protocol/address split against a live reply.

## Registrar quirks confirmed live (documented, not action items)

- **Gandi** `setPrivacy(false)` is a no-op for individual registrants (WHOIS stays
  obfuscated for GDPR); `updateNameservers` returns 202 with a 12-24h propagation
  delay; `registerDomain` requires the ISO 3166-2 `owner.state` (`US-CA`, not
  `CA`); web forwarding is subdomain-only (no apex) and `protocol: https` 500s in
  the sandbox. See `docs/registrars/gandi.md`.
- **GoDaddy** is hybrid v3/v1 (v3 in prod with a PAT, v1 for management + all of
  OTE, which has no v3). Live-confirmed: v3 availability wraps results in `items`
  (not `domains`), prices are integer minor units (`value/100`), standard names
  report `inventory:"REGISTRY"`, `pageSize` caps at 200 (domains) / 100 (dns),
  DNS is per-record (no bulk PUT — `setDnsRecords` diffs), and the v3 zones
  endpoint 404s for domains on external nameservers. A PAT authenticates v1 too
  (GET 200 / PATCH 204); v1 PATCH is eventually-consistent (read-after-write lag).
  See `docs/registrars/godaddy.md`.
- **Namecheap** `setAutoRenew` uses the undocumented-but-live `domains.setAutoRenew`
  (DomainName + IsAutoRenew; reads its inner `IsSuccess`). `getDomain`'s `locked`
  reads the dedicated `getRegistrarLock` command — getList's per-row `IsLocked`
  (and `AutoRenew`) lag in the sandbox even after a successful write. Reverting to
  Namecheap DNS is a separate `dns.setDefault` command (setCustom rejects the
  BasicDNS hosts). `setPrivacy` genuinely toggles WhoisGuard (not a no-op). See
  `docs/registrars/namecheap.md`.
- **Cloudflare** (live-verified 2026-08-29): registration is a real beta API —
  `checkAvailability`/`getPricing` use `POST domain-check` (authoritative;
  `domain-search` over-reports premium names as registrable), and `registerDomain`
  uses `POST registrations` (`namebot.dev` registered live for $12.20). Premium
  names and unsupported extensions are rejected by the availability check.
  `setPrivacy` works via the legacy `PUT privacy`; `setDnsRecords` works via the
  Zones API but a replace-all hits **error 1046** on Email-Routing-managed
  MX/DKIM/SPF records (disable Email Routing first). `GET /user/tokens/verify`
  returns "Invalid API Token" for an account-scoped token — expected, not a bad
  token. See `docs/registrars/cloudflare.md`.
- **Spaceship** (live-verified 2026-08-29 with a `domains:transfer`-scoped key):
  `getAuthCode` returns the 16-char EPP code synchronously; `lockDomain`/
  `unlockDomain` are accepted (200) but the lock state (the `clientTransferProhibited`
  eppStatus) propagates with a delay, so an immediate read-back is stale — poll
  `getDomain` to confirm, same as GoDaddy. See `docs/registrars/spaceship.md`.

## Not buildable (no public API endpoint)

- [ ] **Cloudflare** `setAutoRenew` / `lockDomain` / `unlockDomain` /
      `updateNameservers` / `renewDomain` / `updateContacts` — no Cloudflare API
      path (verified live 2026-08-29). The legacy `PUT registrar/domains/{name}`
      returns 422 for `auto_renew`/`locked` and 403 for nameservers on **both** a
      `.uk` and a gTLD (`.dev`), and the new `registrations` beta has no update
      endpoint. `auto_renew`/`privacy`/`locked` are settable only **at
      registration**. Not a credential problem — the token writes fine (privacy +
      DNS succeed). Revisit when Cloudflare ships registration-update endpoints.

- [ ] **NameBright** `transferIn` — NameBright's REST API has no transfer-in endpoint.
- [ ] **NameSilo** `getAuthCode` — `retrieveAuthCode` only emails the EPP code to
      the registrant; it can't be returned synchronously (declaration dropped).

## Deferred capabilities (pruned; revisit later)

- [ ] **Marketplace listing + account push** — `listOnMarketplace`
      (Dynadot/Spaceship) and `pushToAccount` (Dynadot/NameBright).
- [ ] **Cloudflare extended routing** — email forwarding (Email Routing) and domain
      forwarding (Bulk Redirects) via Cloudflare's non-registrar APIs.

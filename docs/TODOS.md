# TODOs

Open items found during live write-testing (PR #24), the core-write build-out
(PR #25), the extended-capabilities build-out (PR #26), plus NameBright and Gandi
live testing. Verified items are omitted; these are what's still unproven or
blocked. See `docs/registrars/FEATURES.md` for the full status matrix.

## Needs live testing (built + unit-tested, not executed)

- [ ] `registerDomain` / `renewDomain` / `transferIn` on **NameSilo,
      Namecheap** (and NameBright register/renew) — paid/irreversible; built to
      documented shapes, never run. (Dynadot, Gandi register+renew, and Porkbun
      are sandbox-verified; Gandi `transferIn` needs an external domain + auth
      code, not reproducible in the sandbox.)
- [ ] **GoDaddy** register/renew/transfer — v3 register (quote→execute) is paid
      with **no v3 sandbox** (OTE is v1-only), so only the free quote step is
      testable; v1 register/renew/transfer are OTE-testable but the OTE account
      currently holds 0 domains. Run once an OTE domain exists / for a real buy.
- [ ] **GoDaddy** `updateNameservers` (v3 PUT bare-array) — built + unit-tested;
      not run live (would repoint a real domain's NS). Verify with a reversible swap.
- [ ] `updateContacts` on **NameSilo, GoDaddy, Namecheap** — can trigger
      registrant-change verification / 60-day locks; reviewed only. (Dynadot and
      Gandi are sandbox-verified.)
- [ ] **GoDaddy** `setPrivacy` — disabling is a one-way DELETE (enabling is a paid
      purchase, left `NotImplementedError`); not exercised.
- [ ] **Extended features on GoDaddy / NameSilo / Spaceship** (authCode, DNSSEC
      read/disable, email + domain forwarding) — built from docs only; add sandbox
      creds to `.env.testing` and verify. (Dynadot, Gandi, and Porkbun are
      sandbox-verified; GoDaddy forwarding is v1-only — check on a real domain.)
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

## Blocked (need better credentials / a suitable domain)

- [ ] **Cloudflare** writes (auto-renew, nameservers, lock) — token is read-only
      for registrar ops (422); needs a Domain-Registration:Edit token.
- [ ] **Spaceship** `lockDomain`/`unlockDomain` — API key lacks the transfer-lock
      scope (403); needs a lock-scoped key.
- [ ] **Namecheap** `lockDomain`/`unlockDomain` — request is correct but the
      account holds only ccTLDs that don't expose the registrar lock; needs a gTLD
      to confirm the flag flips.

## Not buildable (no public API endpoint)

- [ ] **NameBright** `transferIn` — NameBright's REST API has no transfer-in endpoint.
- [ ] **Namecheap** `setAutoRenew` — no auto-renew command in the public API
      (dashboard-only).
- [ ] **NameSilo** `getAuthCode` — `retrieveAuthCode` only emails the EPP code to
      the registrant; it can't be returned synchronously (declaration dropped).

## Deferred capabilities (pruned; revisit later)

- [ ] **Marketplace listing + account push** — `listOnMarketplace`
      (Dynadot/Spaceship) and `pushToAccount` (Dynadot/NameBright).
- [ ] **Cloudflare extended routing** — email forwarding (Email Routing) and domain
      forwarding (Bulk Redirects) via Cloudflare's non-registrar APIs.

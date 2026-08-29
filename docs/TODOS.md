# TODOs

Open items found during live write-testing (PR #24), the core-write build-out
(PR #25), the extended-capabilities build-out (PR #26), plus NameBright and Gandi
live testing. Verified items are omitted; these are what's still unproven or
blocked. See `docs/registrars/FEATURES.md` for the full status matrix.

## Needs live testing (built + unit-tested, not executed)

- [ ] `registerDomain` / `renewDomain` / `transferIn` on **NameSilo, GoDaddy**
      (and NameBright register/renew) — paid/irreversible; built to documented
      shapes, never run. (Dynadot, Gandi register+renew, Porkbun, and Namecheap
      register+renew are sandbox-verified; Namecheap and Gandi `transferIn` need an
      external domain + auth code, not reproducible in the sandbox.)
- [ ] `updateContacts` on **NameSilo, GoDaddy** — can trigger registrant-change
      verification / 60-day locks; reviewed only. (Dynadot, Gandi, and Namecheap
      are sandbox-verified.)
- [ ] **GoDaddy** `setPrivacy` — disabling is a one-way DELETE (enabling is a paid
      purchase, left `NotImplementedError`); not exercised.
- [ ] **Extended features on GoDaddy / NameSilo / Spaceship** (authCode, DNSSEC
      read/disable, email + domain forwarding) — built from docs only; add sandbox
      creds to `.env.testing` and verify. (Dynadot, Gandi, and Porkbun are
      sandbox-verified; GoDaddy OTE forwarding is reportedly flaky — check on a real domain.)
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
- **Namecheap** `setAutoRenew` uses the undocumented-but-live `domains.setAutoRenew`
  (DomainName + IsAutoRenew; reads its inner `IsSuccess`). `getDomain`'s `locked`
  reads the dedicated `getRegistrarLock` command — getList's per-row `IsLocked`
  (and `AutoRenew`) lag in the sandbox even after a successful write. Reverting to
  Namecheap DNS is a separate `dns.setDefault` command (setCustom rejects the
  BasicDNS hosts). `setPrivacy` genuinely toggles WhoisGuard (not a no-op). See
  `docs/registrars/namecheap.md`.

## Blocked (need better credentials / a suitable domain)

- [ ] **Cloudflare** writes (auto-renew, nameservers, lock) — token is read-only
      for registrar ops (422); needs a Domain-Registration:Edit token.
- [ ] **Spaceship** `lockDomain`/`unlockDomain` — API key lacks the transfer-lock
      scope (403); needs a lock-scoped key.

## Not buildable (no public API endpoint)

- [ ] **NameBright** `transferIn` — NameBright's REST API has no transfer-in endpoint.
- [ ] **NameSilo** `getAuthCode` — `retrieveAuthCode` only emails the EPP code to
      the registrant; it can't be returned synchronously (declaration dropped).

## Deferred capabilities (pruned; revisit later)

- [ ] **Marketplace listing + account push** — `listOnMarketplace`
      (Dynadot/Spaceship) and `pushToAccount` (Dynadot/NameBright).
- [ ] **Cloudflare extended routing** — email forwarding (Email Routing) and domain
      forwarding (Bulk Redirects) via Cloudflare's non-registrar APIs.

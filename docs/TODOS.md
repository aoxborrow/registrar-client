# TODOs

Open items found during live write-testing (PR #24), the core-write build-out
(PR #25), and the extended-capabilities build-out (PR #26) plus NameBright live
testing. Verified items are omitted; these are what's still unproven or blocked.
See `docs/registrars/FEATURES.md` for the full status matrix.

## Needs live testing (built + unit-tested, not executed)

- [ ] `registerDomain` / `renewDomain` / `transferIn` on **NameSilo, Gandi,
      GoDaddy, Namecheap** (and NameBright register/renew) — paid/irreversible;
      built to documented shapes, never run. (Dynadot + Porkbun are sandbox-verified.)
- [ ] `updateContacts` on **NameSilo, Gandi, GoDaddy, Namecheap** — can trigger
      registrant-change verification / 60-day locks; reviewed only. (Dynadot is
      sandbox-verified.)
- [ ] **Gandi** `setPrivacy` — touches the real registrant WHOIS; built, not
      toggled live.
- [ ] **Gandi** `setDnsRecords` — no full-zone PUT run (every account domain has
      live email); only proven lossless offline against the live zone.
- [ ] **GoDaddy** `setPrivacy` — disabling is a one-way DELETE (enabling is a paid
      purchase, left `NotImplementedError`); not exercised.
- [ ] **Extended features on Gandi / GoDaddy / NameSilo / Spaceship** (authCode,
      DNSSEC read/disable, email + domain forwarding) — built from docs only; add
      sandbox creds to `.env.testing` and verify. (Dynadot + Porkbun are
      sandbox-verified; GoDaddy OTE forwarding is reportedly flaky — check on a real domain.)
- [ ] **NameBright** `updateNameservers` — coded from the documented endpoints; no
      safe way to test NS replacement on the live account, so unverified.
- [ ] **Dynadot** DNSSEC enabled→disabled transition — `disableDnssec`/`getDnssec`
      verified, but the sandbox rejects every DNSSEC _enable_ body, so the full
      round-trip is untested.
- [ ] **NameSilo** domain forwarding — apex-only read + clear-via-default-NS are
      unverified; confirm the `domainForward` protocol/address split against a live reply.

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

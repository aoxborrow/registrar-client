# TODOs

Open items found during live write-testing (PR #24) and the write build-out
(PR #25). Verified items are omitted; these are what's still unproven or blocked.

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

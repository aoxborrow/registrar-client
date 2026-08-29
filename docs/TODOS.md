# TODOs

Open items found during live write-testing and the write build-out. Verified
items are omitted; these are what's still unproven or blocked.

## Needs live testing (built + unit-tested, not executed)

- [ ] **NameSilo** `registerDomain`, `transferIn` — paid/irreversible; built to
      the documented params, never run against the account.
- [ ] **Gandi** `registerDomain`, `transferIn` — paid/irreversible; built, not run.
- [ ] **Gandi** `setPrivacy`, `updateContacts` — touch the real registrant WHOIS
      (60-day-lock risk), so not toggled on the live personal domains.
- [ ] **Gandi** `setDnsRecords` — no full-zone PUT run (every account domain has
      live email); only proven lossless offline against the live zone.
- [ ] **NameBright** `registerDomain`, `renewDomain` — paid order endpoints; built,
      not run.
- [ ] **Namecheap** `registerDomain`, `transferIn` — paid; documented-but-unverified.
- [ ] **GoDaddy** `registerDomain`, `transferIn`, `updateContacts` — paid/
      side-effecting; reviewed against docs, not run.

## Blocked (need better credentials to verify)

- [ ] **Cloudflare** writes (auto-renew, nameservers, lock) — token is read-only
      for registrar ops (422); needs a Domain-Registration:Edit token.
- [ ] **Spaceship** `lockDomain`/`unlockDomain` — API key lacks the transfer-lock
      scope (403); needs a lock-scoped key.

## Not buildable (no public API endpoint)

- [ ] **NameBright** `transferIn` — NameBright's REST API has no transfer-in endpoint.
- [ ] **Namecheap** `setAutoRenew` — no auto-renew command in the public API
      (dashboard-only).

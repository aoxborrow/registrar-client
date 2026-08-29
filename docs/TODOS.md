# TODOs

Open follow-ups found while implementing NameBright writes and the extended
capabilities. See `docs/registrars/FEATURES.md` for the full status matrix.

## Live-test (implemented, not yet verified against a real/sandbox account)

- **Gandi / GoDaddy / NameSilo / Spaceship extended features** — built from docs
  only; add sandbox creds to `.env.testing` and verify (GoDaddy OTE forwarding is reportedly flaky — check on a real domain).
- **NameBright `updateNameservers`** — coded from the documented endpoints; no
  safe way to test NS replacement on the live account, so unverified.
- **Dynadot DNSSEC enabled→disabled transition** — `disableDnssec`/`getDnssec`
  verified, but the sandbox rejects every DNSSEC _enable_ body, so the full round-trip is untested.
- **NameSilo domain forwarding** — apex-only read + clear-via-default-NS are
  unverified (no sandbox creds); confirm `domainForward` protocol/address split against a live reply.

## Build (deferred capabilities)

- **Marketplace listing + account push** — pruned for now; revisit
  `listOnMarketplace` (Dynadot/Spaceship) and `pushToAccount` (Dynadot/NameBright) later.
- **Cloudflare extended routing** — email forwarding (Email Routing) and domain
  forwarding (Bulk Redirects) via Cloudflare's non-registrar APIs, if wanted.

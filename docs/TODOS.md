# TODOs

Open items found during live write-testing (PR #24), the core-write build-out
(PR #25), the extended-capabilities build-out (PR #26), plus NameBright and Gandi
live testing. Verified items are omitted; these are what's still unproven or
blocked. See `docs/registrars/FEATURES.md` for the full status matrix.

## Needs live testing (built + unit-tested, not executed)

- [ ] `renewDomain` / `transferIn` on **NameSilo**, and `registerDomain` /
      `renewDomain` on **NameBright** — paid/irreversible; built to documented
      shapes. **NameSilo `registerDomain` is now sandbox-verified** on the OTE
      (`ote.namesilo.com`, 2026-08-30 — see below). NameSilo `renewDomain`
      couldn't be exercised there: OTE's gateway 504s that transactional endpoint
      (along with `dnsSecListRecords`, `domainForward`, and `contactAdd`), so it
      and `transferIn` (needs an external domain + auth code) remain unrun.
      (Dynadot, Gandi register+renew, Porkbun, and Namecheap register+renew are
      sandbox-verified; Namecheap and Gandi `transferIn` need an external domain +
      auth code, not reproducible in the sandbox.)
- [ ] **GoDaddy** `renewDomain` / `transferIn` — both are **v1** endpoints
      (`POST /v1/domains/{d}/renew`, `POST /v1/domains/{d}/transfer`), so OTE
      _should_ apply — but OTE can't fund a purchase. The blocker is the
      **unfunded sandbox**, not the API version: the v1 purchase path validates
      (`POST /v1/domains/purchase/validate` returns 200) but the actual spend
      (`POST /v1/domains/purchase`, and by extension renew/transfer) returns
      `500 ERROR_UNKNOWN` on OTE. OTE spends draw on "Good as Gold" funds, which
      only exist on a paid **API Reseller account** (reseller.godaddy.com →
      Settings → API Keys → Test). So renew/transfer can only be exercised via a
      **real paid action in prod** (as `registerDomain` was) or a funded Reseller
      OTE account. Renew is paid but non-destructive (you keep the domain);
      transfer needs an external domain + auth code and imposes a 60-day lock.
      (v3 `registerDomain` is now **live-verified** — see confirmed quirks below.)
- [ ] **NameBright** `updateNameservers` — coded from the documented endpoints; no
      safe way to test NS replacement on the live account, so unverified.
- [ ] **Dynadot / NameSilo** DNSSEC enabled→disabled transition — `getDnssec` (read)
      verified live on both; `disableDnssec` remains untested because no provider
      implements DNSSEC _enable_ (it needs DS-record generation), so there's no way
      to get a domain into the enabled state through the client to then disable.

## Registrar quirks confirmed live (documented, not action items)

- **Gandi** `setPrivacy(false)` is a no-op for individual registrants (WHOIS stays
  obfuscated for GDPR); `updateNameservers` returns 202 with a 12-24h propagation
  delay; `registerDomain` requires the ISO 3166-2 `owner.state` (`US-CA`, not
  `CA`); web forwarding is subdomain-only (no apex) and `protocol: https` 500s in
  the sandbox. See `docs/registrars/gandi.md`.
- **GoDaddy** is hybrid v3/v1 (v3 in prod with a PAT, v1 for management + all of
  OTE, which has no v3). Live-confirmed on a real prod domain (a $1.19 `.xyz`):
  - **Availability/pricing**: v3 wraps results in `items` (not `domains`), prices
    are integer minor units (`value/100`), standard names report
    `inventory:"REGISTRY"`, `pageSize` caps at 200 (domains) / 100 (dns).
  - **`registerDomain` (v3 quote→execute→poll) works** with a **minimal** body —
    `{domain, period, quoteToken, consent:{agreementTypes, agreedAt}}`. Sending a
    `profile` block (contacts/autoRenew/privacy) is rejected `INVALID_BODY`:
    contacts come from the **account identity** (quote's
    `resolved.contactSource:"ACCOUNT"`) and `agreedBy` is derived server-side.
    `consent.acknowledgedFees` must be **omitted** unless the quote carried fees
    (the array is `minItems:1`; `[]` is rejected). autoRenew/nameservers can't be
    set at registration, so the client applies them as post-registration steps.
  - **Idempotency-Key header is required** on the execute endpoints
    `POST /v3/.../registrations` and `PUT /v3/.../nameservers` (400
    `MISSING_VALUE` without it); the client sends a `crypto.randomUUID()`. DNS
    record writes do **not** require it.
  - **Premium/aftermarket domains are not registrable via the v3 API**
    (`available:false` with no price / `422 UNSUPPORTED_AFTERMARKET_DOMAIN`) even
    when for sale on the website — short numeric `.xyz` are premium; 10-digit
    numeric `.xyz` are standard `REGISTRY` ($1.19).
  - **DNS** is per-record (no bulk PUT — `setDnsRecords` diffs; add/remove
    verified reversibly); the v3 zones endpoint 404s for domains on external NS.
  - **`updateNameservers` (v3 PUT bare-array) verified** with a reversible swap.
    GoDaddy **serializes** NS changes — overlapping PUTs clobber each other, so
    space them out; propagation is ~8s.
  - **`setAutoRenew` / `lock`·`unlock`** (v1-via-PAT) verified; a PAT
    authenticates v1 too (GET 200 / PATCH 204). Reads are **eventually
    consistent** across the v1-write / v3-read boundary — poll, don't assert
    immediately.
  - **`updateContacts`** (v1 PATCH `/contacts`) verified with a reversible
    non-identity round-trip (address change; a registrant name/org/email change
    would trip the ICANN 60-day lock, so it wasn't exercised).
  - **`setPrivacy(false)`** can't disable GoDaddy's **free privacy ("Free DBP")**:
    `DELETE /privacy` returns 409 CONFLICTING_STATUS, and the only alternative —
    `PATCH {exposeWhois:true}` — requires a full WHOIS-exposure **consent block**
    (`agreedAt` + `agreedBy` IP + `agreementKeys`) that `setPrivacy` can't carry.
    The client now returns a clear error pointing to the dashboard. Paid DBP still
    cancels via the DELETE. See `docs/registrars/godaddy.md`.
  - **Domain forwarding** lives on the **v2 customer-scoped** route
    `/v2/customers/{customerId}/domains/forwards/{fqdn}` (the old v1
    `/v1/domains/forwards` routes now 404). It works on a standard account with
    either a PAT or an sso-key — the earlier "reseller-only 403" was an artifact of
    passing the numeric **shopper ID** where the API wants the customer **UUID**.
    The client takes `customerId` as either the UUID (used directly) or the numeric
    shopper ID, which it resolves to the UUID via
    `GET /v1/shoppers/{id}?includes=customerId` (**sso-key only** — that lookup
    rejects a PAT with 401, so the numeric form needs Key/Secret; the UUID form
    doesn't). Per-fqdn `PUT`/`DELETE` (204), and the read/write enums differ: a
    write sends `REDIRECT_PERMANENT`/`REDIRECT_TEMPORARY`, a read returns
    `PERMANENT_REDIRECT`/`TEMPORARY_REDIRECT`. Full set→read→clear round-trip
    verified live 2026-08-29. See `docs/registrars/godaddy.md`.
- **Namecheap** `setAutoRenew` uses the undocumented-but-live `domains.setAutoRenew`
  (DomainName + IsAutoRenew; reads its inner `IsSuccess`). `getDomain`'s `locked`
  reads the dedicated `getRegistrarLock` command — getList's per-row `IsLocked`
  (and `AutoRenew`) lag in the sandbox even after a successful write. Reverting to
  Namecheap DNS is a separate `dns.setDefault` command (setCustom rejects the
  BasicDNS hosts). `setPrivacy` genuinely toggles WhoisGuard (not a no-op). See
  `docs/registrars/namecheap.md`.
- **NameSilo** (live-verified 2026-08-29): forwarding + contacts had latent bugs,
  now fixed. `getDomainForwarding` must gate on `getDomainInfo.traffic_type`
  (`"Forwarded"` vs `"Custom DNS"`) — NameSilo keeps the last `forward_url` after
  forwarding is switched off, so reading `forward_url` alone reports a phantom
  forward (it also returns `"N/A"` for never-forwarded domains). Clearing a forward
  (`setDomainForwarding([])`) must re-point NS at the **DNS-hosting** servers
  (`ns1/2/3.dnsowl.com`), NOT the parking servers `ns1/2.namesilo.com` — the
  parking servers leave the domain forwarded. `getEmailForwarding` must fetch
  `listEmailForwards` as **XML** (`type=json` silently drops the alias, returning
  only nested `forwards_to` arrays). `updateContacts` works but creates a **new
  account contact** on every call (`contactAdd` + associate; no cleanup). See
  `docs/registrars/namesilo.md`.
- **NameSilo OTE sandbox** (verified 2026-08-30): NameSilo issued OTE sandbox
  credentials, so the full read/write surface — **`registerDomain`** (previously
  never run), availability, pricing, `getDomain`, `listDomains`, nameserver
  get/update, lock/unlock, auto-renew, privacy, DNS records add/replace/delete,
  email forwarding, and contacts read — now passes against `ote.namesilo.com`
  via `scripts/ote/namesilo-lifecycle.ts` (22 ops, 0 failures). Sandbox caveats:
  only `NS1..8.NAMESILO.COM` resolve; registrations are permanent (no delete
  endpoint). The OTE gateway intermittently **504s** `dnsSecListRecords`,
  `domainForward`, `contactAdd`, and `renewDomain` (renew once returned a
  spurious `500 "version is not specified"`) — an OTE infra quirk, not a client
  bug; the first three are already prod-verified above, and `renewDomain`
  remains unrun. See `docs/registrars/namesilo.md`.
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
- **GoDaddy / NameBright** `getAuthCode` (live-verified 2026-08-29, PR #33): both
  return the 16-char EPP code synchronously on the domain-detail response —
  GoDaddy's `authCode` on `GET /v1/domains/{domain}` (transfers stay on v1),
  NameBright's `AuthCode` on `GET account/domains/{domain}`. Not email-only. The
  domain must generally be unlocked / out of the 60-day lock for the code to be
  usable for an outbound transfer.

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
- [x] **Cloudflare extended routing** — DONE (live-verified 2026-08-29): email
      forwarding via Email Routing and domain forwarding via the Rules API (a
      redirect rule + a proxied placeholder DNS record). Not implemented via Bulk
      Redirects — the per-zone Rules `http_request_dynamic_redirect` phase is the
      right fit for a single domain's apex/www forward.

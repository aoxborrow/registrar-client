# Registrar Feature Matrix

Cross-provider synthesis of the six original per-registrar research docs in this
folder ([cloudflare](cloudflare.md) · [dynadot](dynadot.md) · [gandi](gandi.md) ·
[godaddy](godaddy.md) · [namecheap](namecheap.md) · [spaceship](spaceship.md)).

> Researched 2026-08-26 against each provider's latest public API docs. This is a
> capability map to drive the library's **common core** vs. **optional/generic**
> method split — not an endpoint reference. See the per-registrar docs for
> endpoints, auth, and access gates.

> **Also researched since (not in the matrix below yet):** implemented —
> [namesilo](namesilo.md) (broad JSON API), [porkbun](porkbun.md) (JSON API; no
> transfer-lock write, renewal needs a price handshake), and
> [namebright](namebright.md) (OAuth2; reads implemented, writes pending
> verification). Not implemented — [squarespace](squarespace.md),
> [networksolutions](networksolutions.md), and [edomains](edomains.md), none of
> which expose a usable public API (reseller/partner-gated or undocumented).

**Legend:** ✓ supported · ~ partial / caveat / indirect · ✗ not in the API

## Master matrix

| #   | Feature                          | CF  | DY  | GA  | GD  | NC  | SP  | Tally (✓ / ✓+~) |
| --- | -------------------------------- | --- | --- | --- | --- | --- | --- | --------------- |
| 1   | Test connection / verify creds   | ~   | ✓   | ~   | ~   | ~   | ~   | 1 / 6           |
| 2   | List domains                     | ~   | ✓   | ✓   | ✓   | ✓   | ✓   | 5 / 6           |
| 3   | Get single domain details        | ~   | ✓   | ✓   | ✓   | ✓   | ✓   | 5 / 6           |
| 4   | **Check availability**           | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | **6 / 6**       |
| 5   | Get pricing (TLD / domain)       | ✓   | ✓   | ✓   | ✓   | ✓   | ✗   | 5 / 5           |
| 6   | **Register a domain**            | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | **6 / 6**       |
| 7   | Renew a domain                   | ✗   | ✓   | ✓   | ✓   | ✓   | ✓   | 5 / 5           |
| 8   | Auto-renew toggle                | ~   | ✓   | ✓   | ✓   | ~   | ✓   | 4 / 6           |
| 9   | Transfer domain in               | ✗   | ✓   | ✓   | ✓   | ✓   | ✓   | 5 / 5           |
| 10  | Transfer out / get auth code     | ✗   | ✓   | ✓   | ~   | ~   | ✓   | 3 / 5           |
| 11  | Update nameservers               | ✗   | ✓   | ✓   | ✓   | ✓   | ✓   | 5 / 5           |
| 12  | Get nameservers                  | ~   | ✓   | ✓   | ✓   | ✓   | ~   | 4 / 6           |
| 13  | Lock / unlock (transfer lock)    | ~   | ✓   | ~   | ✓   | ✓   | ✓   | 4 / 6           |
| 14  | Get / set WHOIS privacy          | ~   | ✓   | ~   | ✓   | ✓   | ✓   | 4 / 6           |
| 15  | Update contact info              | ✗   | ✓   | ✓   | ✓   | ✓   | ✓   | 5 / 5           |
| 16  | DNS record management            | ✗¹  | ✓   | ✓   | ✓   | ✓   | ✓   | 5 / 5           |
| 17  | DNSSEC management                | ✗   | ✓   | ✓   | ~   | ✗   | ✗   | 2 / 3           |
| 18  | Glue / host records              | ✗   | ✓   | ✓   | ✗   | ~   | ✓   | 3 / 4           |
| 19  | Email forwarding / mailbox       | ✗   | ~   | ✓   | ✗   | ~   | ✗   | 1 / 3           |
| 20  | Domain forwarding / URL redirect | ✗   | ✓   | ✓   | ✓   | ✓   | ✗   | 4 / 4           |
| 21  | Webhooks / event notifications   | ✗   | ✓   | ✗   | ~   | ✗   | ✗   | 1 / 2           |

¹ Cloudflare _does_ offer world-class DNS record management — but through its
separate DNS/Zones API, not the Registrar API. DNS is a **headline feature** of
this library, not out of scope, so the Cloudflare provider is expected to route
`getDnsRecords`/`setDnsRecords` (and DNSSEC) through the Zones API rather than
decline them. Same approach applies to its email forwarding (Email Routing) and
redirects (Bulk Redirects) if/when those are wired up.

### The Cloudflare caveat (read before trusting column CF)

Cloudflare is the systematic outlier on write operations, and it's mid-migration:

- The old `registrar/domains` endpoints (which _did_ support `auto_renew`,
  `locked`, and `privacy` toggles) are **deprecated, EOL 2026-09-27**.
- The new `registrar/registrations` + `domain-check` API (April 2026 beta) adds
  **availability, pricing, and registration** — but has **not yet** re-absorbed
  renew, transfer, nameservers, lock, privacy, or contact updates.
- So there is a live functionality gap _in the Registrar API_. Cloudflare is
  still held to the core contract; several core methods just have to route
  through other Cloudflare APIs (DNS via Zones) or wait for the Registrar API to
  catch up, and they throw `NotImplementedError` until then rather than being
  declared unsupported.

## Core vs. extended

There are **no tiers** — a capability is either **core** or **extended**.

**Core is a contract, not a vote.** It's a deliberate, fixed set of capabilities
every provider is expected to fulfil — the surface a provider inherits by
extending `BaseRegistrar`. It is _not_ the intersection of what today's
registrars happen to expose, so a single registrar's missing or undocumented
endpoint never demotes a feature out of core. Where a provider's API path for a
core feature isn't wired up yet — or hasn't been found (Spaceship pricing,
Cloudflare DNS via the Zones API) — the method throws `NotImplementedError`. The
contract is the promise; `NotImplementedError` is the "not yet". There is no
privileged list of registrars that defines core.

**Extended** capabilities are opt-in: each provider declares them in its static
`extendedFeatures`. This is where providers genuinely differ.

Both are defined once, as constants, in
[`src/features.ts`](../../src/features.ts). Reference
features through the `Feature` object (e.g. `Feature.GetPricing`) rather than raw
strings — you get autocomplete, find-all-references, and typo-as-compile-error.

### Core contract (18)

Every provider inherits these; `getPricing` and `setAutoRenew` are here because
they're universal enough to guarantee, even where a specific API path still needs
finding.

| Method                             | `Feature`           |
| ---------------------------------- | ------------------- |
| `testConnection()`                 | `TestConnection`    |
| `listDomains()`                    | `ListDomains`       |
| `getDomain(domain)`                | `GetDomain`         |
| `checkAvailability(domains[])`     | `CheckAvailability` |
| `getPricing(tld \| domain)`        | `GetPricing`        |
| `registerDomain(domain, input)`    | `RegisterDomain`    |
| `renewDomain(domain, years?)`      | `RenewDomain`       |
| `setAutoRenew(domain, on)`         | `SetAutoRenew`      |
| `transferIn(domain, authCode)`     | `TransferIn`        |
| `updateNameservers(domain, ns[])`  | `UpdateNameservers` |
| `getNameservers(domain)`           | `GetNameservers`    |
| `lockDomain(domain)`               | `LockDomain`        |
| `unlockDomain(domain)`             | `UnlockDomain`      |
| `setPrivacy(domain, on)`           | `SetPrivacy`        |
| `getContacts(domain)`              | `GetContacts`       |
| `updateContacts(domain, contacts)` | `UpdateContacts`    |
| `getDnsRecords(domain)`            | `GetDnsRecords`     |
| `setDnsRecords(domain, records)`   | `SetDnsRecords`     |

**DNS record management is core** — one of the library's headline features. The
scan's "not in the Registrar API" cells (notably Cloudflare) mean the provider
routes DNS through another API of that vendor, not that it's unsupported.

### Extended (opt-in; the "declared by" column is what the scan found)

The extended catalog was **pruned to what we intend to build** (2026-08-29).
Removed entirely: glue records, marketplace listing, account push, appraisal,
webhooks, mailbox provisioning, and bulk settings. DNSSEC was narrowed from full
key management to **read-status + disable** (`getDnssec` / `disableDnssec`);
enabling DNSSEC is out of scope for this library for now.

| `Feature`             | Declared by            | Notes                                                                                           |
| --------------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| `GetAuthCode`         | DY, GA, SP             | transfer-out EPP code; NameSilo emails it (can't return it); GD/NC gate it behind the dashboard |
| `GetDnssec`           | DY, GA, NS, PB         | read whether DNSSEC is enabled (DS / key records)                                               |
| `DisableDnssec`       | DY, GA, NS, PB         | turn DNSSEC off; no enable / key management (out of scope)                                      |
| `GetEmailForwarding`  | DY, GA, NC, NS         | read counterpart of `SetEmailForwarding`                                                        |
| `SetEmailForwarding`  | DY, GA, NC, NS         | alias redirect only — **distinct from a mailbox**                                               |
| `GetDomainForwarding` | DY, GA, GD, NC, NS, PB | read counterpart of `SetDomainForwarding`                                                       |
| `SetDomainForwarding` | DY, GA, GD, NC, NS, PB | some model it as `URL`/`URL301`/`FRAME` DNS records; Gandi uses `webredirs` (subdomain-only)    |

**Implementation status:** every declared extended feature above is now
implemented on its provider(s). **Dynadot**, **Gandi**, and **Porkbun** are
verified end-to-end in their sandboxes; **Namecheap** forwarding predates this
work; the rest (**GoDaddy**, **NameSilo**, **Spaceship**) are implemented from
verified endpoint docs but not live-verified (no sandbox credentials available).
Two provider-specific limitations worth noting: **NameSilo** dropped
`GetAuthCode` (its `retrieveAuthCode` emails the code to the registrant rather
than returning it) and reads only the apex URL forward (no forwarding-list
endpoint); **Dynadot** and **NameSilo** forward the whole domain / apex, so their
`DomainForward` support is a single `@` rule and clearing restores default
nameservers. **Gandi** is the inverse — its `webredirs` forward per-subdomain and
cannot forward the apex (`@` is rejected), and updating a redirect is
delete-then-recreate (no PUT). Modeling note: core `setPrivacy` / lock are
sometimes "on by policy" rather than a toggle (Gandi, Cloudflare), so those
setters treat an already-correct state as idempotent success; on Gandi,
`setPrivacy(false)` is additionally a no-op for individual registrants (WHOIS
obfuscation stays on for GDPR).

## Discovery mechanism (implemented)

Capabilities are introspectable statically — no instance or credentials needed —
ideal for a catalog UI or an MCP `list_capabilities` tool:

```ts
import { registrars, createRegistrar, Feature, CORE_FEATURES } from '@aoxborrow/registrar-client';

registrars.dynadot.features; // full set: core + Dynadot's extended
registrars.dynadot.extendedFeatures; // just the extras
CORE_FEATURES.includes(Feature.GetDnsRecords); // true

const p = createRegistrar('godaddy', creds);
p.supports(Feature.RegisterDomain); // true (core)
p.supports(Feature.SetDomainForwarding); // true (its extended)
p.supports(Feature.GetAuthCode); // false
```

- **`Feature`** — the constant for every capability id (use instead of strings).
- **`RegistrarFeature`** — the value type (`(typeof Feature)[keyof typeof Feature]`).
- **`CORE_FEATURES` / `EXTENDED_FEATURES` / `ALL_FEATURES`** — the contract, the
  opt-in set, and the full catalog.
- **`static extendedFeatures`** — what a provider opts into; **`features`**
  (static and instance) is core + extended.
- **`supports(feature)` / `isCoreFeature(feature)`** — runtime checks.

A unit test asserts core and extended partition the catalog with no overlap, and
that every provider's `extendedFeatures` are valid, unique, non-core entries.

### Implementation status

The full 18-method core contract now exists on the `Registrar` interface (with
shared payload types — `Contact`, `DnsRecord`, `DomainAvailability`,
`TldPricing`, `RegisterDomainInput`), and is being implemented one provider at a
time. **GoDaddy** is done first: every core method except `registerDomain` and
`transferIn` (both need GoDaddy's per-TLD legal-agreements + `consent` flow and
spend real money) plus enabling `setPrivacy` (a paid add-on). Its `getPricing`
works per-domain via the availability endpoint; GoDaddy has no per-TLD price API.

**Dynadot** is done next, against its legacy **API3 JSON** endpoint. Every core
method is implemented except `registerDomain`/`transferIn` (paid + consent, same
as GoDaddy) and `getContacts`/`updateContacts` (api3 references a domain's
contacts only by numeric `ContactId`, needing a second `get_contact` per role and
a lossy single-`Name`/split-phone remap — deferred pending live verification).
The main work was a generic envelope unwrapper: api3 wraps each payload in a
per-command `Header`/`Content` pair whose key names and success field
(`SuccessCode` vs `ResponseCode`) are internally inconsistent. `get_dns`/
`set_dns2`/`set_ns` and the envelope are confirmed against real captures; `search`
(availability/pricing), `set_renew_option`, and `set_privacy` are implemented from
docs and flagged inline as not-yet-verified-live. `getPricing` works per-domain
via `search` (like GoDaddy), not the bulk `tld_price` table.

**Namecheap** is done against its XML API (the first XML provider filled in, so
it exercises the `requestText` + `parseXml` path). Implemented: `getDomain`
(getInfo), `checkAvailability` (check, batched at 50/call), `getPricing`
(users.getPricing — the **first real per-TLD price table**, so a bare TLD works),
`getNameservers` (dns.getList), `getContacts`/`updateContacts` (setContacts
requires all four roles, so omitted roles fall back to the registrant), and
`getDnsRecords`/`setDnsRecords` (dns.getHosts/setHosts, full-replace, 1-indexed;
the reader tolerates both `<Host>` per the docs and the live `<host>`). Deferred:
`setAutoRenew` (no public API command — it's a dashboard setting), `setPrivacy`
(WhoisGuard is a separate entity needing its numeric id + a forwarding email the
signature doesn't carry), and `registerDomain`/`transferIn` (paid + consent).

**Spaceship** is done against its modern REST/JSON API, mapped from the official
OpenAPI spec (which also corrected several wrong paths/fields in the pre-existing
skeleton — `renew` not `renewal`, `transfer/lock` not `transfer-lock`, the
`{provider, hosts}` nameserver wrapper, and `lifecycleStatus`/`eppStatuses`/
`privacyProtection.level`/`nameservers.hosts` in the domain mapping). Implemented:
`getDomain`, `getNameservers`, `checkAvailability` (bulk; premium price only),
`setAutoRenew`, `renewDomain` (async; fetches the current expiry as the required
guard), `setPrivacy` (consent-based), `getContacts`/`updateContacts` (resolve/
save contacts by id), and `getDnsRecords`/`setDnsRecords`. DNS is the notable
one: Spaceship's `PUT` is upsert, not atomic replace, so `setDnsRecords` upserts
then deletes stale `(type, name)` pairs (writes cover the common types; SRV/CAA
etc. throw, since our generic record lacks their sub-fields — reads handle all
types). Deferred: `getPricing` (**no pricing endpoint exists** — only per-domain
premium prices via availability) and `registerDomain`/`transferIn` (async, paid).

**Registration & transfer consent** is modeled as a shared, per-operation input:
`RegisterDomainInput.consent` / `TransferDomainInput.consent` (`{ agreedBy,
agreedAt? }`) plus a distinct `ConsentRequiredError` when it's missing. Consent is
per-call, not stored — matching how the registrar APIs work (the consent block
rides in each call's body; there's no server-side "consented once" state). The
caller only affirms who consents (`agreedBy`, an IP for GoDaddy) and optionally
when; the provider fetches the specific per-TLD agreement documents itself.
`registerDomain` **and** `transferIn` are now implemented for all four filled-in
providers, each mapping consent to its own flow: GoDaddy fetches agreement keys
(`forTransfer=true` for transfers) and POSTs a `consent` block; Namecheap sends
the full four-role contact set on `domains.create` (transfer needs only `EPPCode`);
Dynadot relies on the account's default WHOIS contact (api3 takes no inline
contacts); Spaceship saves contacts to ids then references them. `transferIn` takes
a `TransferDomainInput` (`authCode` + optional years/contacts/consent/privacy).
Both spend real money and are documented-but-unverified against funded accounts.
Known gap: Namecheap registration doesn't yet send per-TLD extended attributes
(`.us`, `.eu`, …), so those TLDs aren't registrable there.

### Listing, paging & portfolios

`listDomains` returns the **full account**, paginating internally at each
provider's maximum page size — the fewest requests each API allows (GoDaddy/Gandi
1000, Cloudflare 200, Spaceship/Namecheap/NameSilo/NameBright 100; Porkbun's fixed
1000-domain chunks paged by `start` offset; Dynadot returns everything in one
call). Page size isn't a caller-facing option — the library owns pagination. The
only list option is `search`, a domain-name substring filter, applied server-side
where the API supports it (**Namecheap** `SearchTerm`, **Gandi** `fqdn` wildcard)
and client-side otherwise (via the shared `filterDomains` helper).

**Nameservers in the single list call:** folded in for **GoDaddy** (added
`includes=nameServers` to the list query), **Gandi** (now reads the correct
`nameserver.hosts` field — previously it read a non-existent `nameservers`
property and always came back empty), **Spaceship**, and **Dynadot** (inline
`NameServerSettings`). The list endpoints of **Namecheap**, **Porkbun**,
**NameSilo**, and **NameBright** don't return nameservers at all — they require a
per-domain call — and **Cloudflare** exposes NS only via its Zones API, not the
Registrar list. Two list bugs were fixed in passing: **NameBright** wasn't
paginating (it returned only the API's default first page) and now walks
`page`/`domainsPerPage`; **NameSilo** gained `getDomain`/`getNameservers` (via
`getDomainInfo`) so its NS/status/lock/privacy/auto-renew are reachable per
domain.

**Cross-registrar portfolios:** `listPortfolio(sources, opts)` fans out over
many providers with `Promise.allSettled`, returning `{ domains, errors }` — a
flat domain list (each already tagged with its `.registrar`) plus per-registrar
error isolation, so one provider failing never sinks the combined view. `opts`
(including `search`) is passed to each source.

### Still open (future work)

- **Wire up the remaining providers' core methods** — Gandi and the newer
  additions (namesilo, porkbun, namebright), plus Cloudflare (see its caveat
  above). Four of the original six are done (GoDaddy, Dynadot, Namecheap,
  Spaceship); reuse the shared payload types.
- **Namecheap per-TLD extended attributes** for registration (`.us` nexus, `.eu`,
  `.ca`, `.uk`, `.fr`, …), so those TLDs become registrable.
- **Cloudflare DNS via the Zones API**, so its core `getDnsRecords`/
  `setDnsRecords` (and DNSSEC) stop throwing `NotImplementedError`.
- **Async operation model**: GoDaddy v3 and Spaceship return `202 + poll`; a
  shared `pollOperation(id)` abstraction would cover both.
- **Build out the pruned extended catalog**: wire up method surfaces for
  `getAuthCode` and DNSSEC read/disable (`getDnssec` / `disableDnssec`), and
  extend the existing email/domain-forwarding surface (built only for Namecheap
  today) to the other declared providers.
- **Verify the doc-ambiguous flags** against live sandbox accounts and widen
  `extendedFeatures` (or core) accordingly: NC auto-renew, GD auth-code, and
  per-provider DNSSEC and pricing endpoints.

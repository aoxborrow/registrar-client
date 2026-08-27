# Registrar Feature Matrix

Cross-provider synthesis of the six per-registrar research docs in this folder
([cloudflare](cloudflare.md) · [dynadot](dynadot.md) · [gandi](gandi.md) ·
[godaddy](godaddy.md) · [namecheap](namecheap.md) · [spaceship](spaceship.md)).

> Researched 2026-08-26 against each provider's latest public API docs. This is a
> capability map to drive the library's **common core** vs. **optional/generic**
> method split — not an endpoint reference. See the per-registrar docs for
> endpoints, auth, and access gates.

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
| 20  | Domain forwarding / URL redirect | ✗   | ✓   | ~   | ✓   | ✓   | ✗   | 3 / 4           |
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

| `Feature`             | Declared by | Notes                                                          |
| --------------------- | ----------- | -------------------------------------------------------------- |
| `GetAuthCode`         | DY, GA, SP  | transfer-out EPP code; GD/NC gate it behind the dashboard      |
| `ConfigureDnssec`     | DY, GA      | not exposed via API by every registrar; GD only via DS records |
| `GetGlueRecords`      | DY, GA, SP  | read glue / host records                                       |
| `SetGlueRecords`      | DY, GA, SP  | write glue / host records                                      |
| `SetEmailForwarding`  | DY, GA, NC  | alias redirect only — **distinct from a mailbox**              |
| `ProvisionMailbox`    | GA          | real hosted mailboxes                                          |
| `SetDomainForwarding` | DY, GD, NC  | some model it as `URL`/`URL301`/`FRAME` DNS records            |
| `SubscribeWebhooks`   | DY          | most providers are poll-only                                   |
| `ListOnMarketplace`   | DY, SP      | aftermarket / marketplace listing                              |
| `PushToAccount`       | DY          | instant intra-registrar ownership transfer                     |
| `AppraiseDomain`      | DY          | valuation lookup                                               |
| `ApplyBulkSettings`   | DY          | Smart Folders                                                  |

The "declared by" column is the honest floor from the doc scan — the scan may
have missed endpoints, and several of these (auth-code, DNSSEC especially) are
likely broader than shown. As live testing confirms support, providers add the
feature to `extendedFeatures` (or, if it turns out universal, it's promoted into
the core contract). Two modeling notes: (1) **email is split** —
`setEmailForwarding()` (alias redirect) vs `provisionMailbox()` (real mailbox)
are different capabilities, not one `enableWebmail()`; (2) core `setPrivacy` /
lock are sometimes "on by policy" rather than a toggle (Gandi, Cloudflare), so
those setters treat an already-correct state as idempotent success.

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
p.supports(Feature.SubscribeWebhooks); // false
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

### Still open (future work)

- **Wire up the core methods** that are declared-by-contract but not yet
  implemented (get/register/contacts/DNS/pricing/…) with shared payload types.
- **Cloudflare DNS via the Zones API**, so its core `getDnsRecords`/
  `setDnsRecords` (and DNSSEC) stop throwing `NotImplementedError`.
- **Async operation model**: GoDaddy v3 and Spaceship return `202 + poll`; a
  shared `pollOperation(id)` abstraction would cover both.
- **Verify the doc-ambiguous flags** against live sandbox accounts and widen
  `extendedFeatures` (or core) accordingly: NC auto-renew / glue records, GD
  auth-code, per-provider DNSSEC and pricing endpoints.

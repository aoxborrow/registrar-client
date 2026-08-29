# Integration testing — money-moving operations (DRAFT)

> **Status: draft / planning.** This records the plan and rules for exercising
> the paid, side-effectful operations — `registerDomain`, `renewDomain`,
> `transferIn` — against real accounts. Read-only integration tests
> (`testConnection`, `listDomains`, …) are covered by the credential-gated suite
> in `test/integration/`; this doc is specifically about the operations that
> spend money and move domains.

## Account status

I now have a domain at **every** registrar (I registered `482233.xyz` at NameSilo
specifically because I didn't already have one there). The only outstanding
access issue is **NameBright**, where I'm **waiting to be approved for API
access**.

## Automation boundary (important)

- **CI / automated integration tests: sandbox only.** Automated runs require a
  registrar to have a **sandbox** environment. They cover read-only operations.
  Sandbox-capable registrars: **GoDaddy, Namecheap, Gandi, NameSilo, Porkbun**
  (see `.env.testing.example`). The rest (Dynadot, Spaceship, Cloudflare,
  NameBright) have no sandbox and are therefore **not** part of automated CI.
- **Registration / renewal / transfer: manual scripts only.** These are run via
  specific, deliberate scripts — **never in CI or anything automated** — because
  they cost money and move real domains.

## Consolidation & transfer rules

**Dynadot is my preferred registrar.**

- ❌ **Moving _out of_ Dynadot is forbidden.** Never transfer a domain away from
  Dynadot.
- ✅ **Moving _into_ Dynadot is always allowed.** Transferring a personal domain
  from any other registrar into Dynadot is a valid consolidation move and a good
  way to test `transferIn`.
- ✅ **Moving a personal domain _into_ GoDaddy is allowed** — **as long as the
  domain isn't currently on Dynadot** (that would violate the rule above).
- For **all other registrars** (as a transfer _target_): personal-domain
  consolidation isn't desired, so test `transferIn` with a **numeric throwaway
  domain** instead (see below). The only allowed personal-domain consolidation
  moves are _into Dynadot_ (from anywhere non-Dynadot) and _into GoDaddy_ (from
  anywhere non-Dynadot).

## Renewal rules

- **Only renew personal domains at GoDaddy or Dynadot.** Do **not** renew
  personal domains at any other registrar.
- Reason: **some transfers don't honor an existing renewal**, so renewing a
  personal domain at a registrar I'm about to transfer away from would waste the
  paid year.
- Where no personal domain fits the rules, renewal (and transfer) testing uses a
  **numeric throwaway domain** instead — sparingly.
- Note: a `transferIn` into GoDaddy/Dynadot inherently adds a year, so a
  consolidation transfer doubles as renewal coverage there.

## Test domains (cheap numeric `.xyz`)

`482233.xyz` (currently at NameSilo) is a **6-digit numeric `.xyz`** in the
**"1.111B Class"** — a special low-cost `.xyz` registry tier for 6–9 digit
numeric names. Registry pricing is ~**$0.99/year for registration, renewal, and
transfer**, so a full register→renew→transfer cycle costs about a dollar.

- Only **6–9 digit all-numeric** `.xyz` names get this pricing; normal `.xyz`
  domains don't.
- Numeric domains can be bounced between registrars to test `transferIn` (moving
  _out_ of any registrar is fine **except Dynadot**).
- If a registrar needs a throwaway and doesn't have one, register a fresh
  1.111B-class numeric `.xyz` there.

| Domain       | Currently at | Purpose                           |
| ------------ | ------------ | --------------------------------- |
| `482233.xyz` | NameSilo     | register / renew / transfer tests |

## Per-registrar plan

`transferIn` = transferring a domain _into_ that registrar.

| Registrar  | Sandbox (CI)?           | Register test                                                           | Renew test            | TransferIn test                                                |
| ---------- | ----------------------- | ----------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------- |
| Dynadot    | no                      | numeric `.xyz`                                                          | **personal domain** ✓ | **personal domain → Dynadot** (consolidation; also renews)     |
| GoDaddy    | yes                     | numeric `.xyz`                                                          | **personal domain** ✓ | **personal domain (not from Dynadot) → GoDaddy** (also renews) |
| Namecheap  | yes                     | numeric `.xyz`                                                          | numeric domain        | numeric domain                                                 |
| Gandi      | yes                     | numeric `.xyz`                                                          | numeric domain        | numeric domain                                                 |
| Porkbun    | yes                     | numeric `.xyz`                                                          | numeric domain        | numeric domain                                                 |
| NameSilo   | yes                     | numeric `.xyz`                                                          | numeric domain        | numeric domain                                                 |
| Spaceship  | no                      | numeric `.xyz`                                                          | numeric domain        | numeric domain                                                 |
| NameBright | no (API access pending) | numeric `.xyz`                                                          | numeric domain        | numeric domain                                                 |
| Cloudflare | no                      | n/a — Registrar API mid-migration (no register/renew/transfer endpoint) | n/a                   | n/a                                                            |

## Transfers will be limited for a while

Because of the 60-day lock and the "never out of Dynadot" rule, real
`transferIn` testing is mostly limited to **consolidation moves** (personal
domains into Dynadot/GoDaddy) for the near term, plus occasional numeric-domain
transfers once they clear their lock windows.

**Cheaper signal: fetch the transfer auth code.** Retrieving a domain's
auth/EPP code exercises the registrar's transfer API **without moving the domain
or waiting out the 60-day lock** — a low-risk way to confirm the transfer-out
path works. **This is not implemented yet:**

- There is **no `transferOut` capability** at all (only `transferIn`, which is
  core).
- `getAuthCode` exists only as a **declared extended feature** on **Dynadot,
  Gandi, Spaceship, NameSilo** — but there is **no `getAuthCode` method** on the
  interface or any provider, so it can't actually be called. The flags are
  currently misleading (they report a capability that isn't wired up).

**TODO (pre-transfer-testing):** implement `getAuthCode` as a real extended
method on the providers that declare it (and add the flag + method to others
whose API supports it), so we have a non-destructive transfer-API smoke test.

## Practical constraints

- **60-day ICANN transfer lock:** a domain can't be transferred for 60 days after
  registration or a prior transfer. `482233.xyz` was just registered, so it can't
  be transferred until that window passes — plan numeric-domain transfer tests
  around this.
- **Domain lock / auth code:** `transferIn` needs the domain unlocked at the
  losing registrar and its EPP/auth code.
- Sandbox reg/renew/transfer (where supported) can validate the request/response
  flow for free before any paid production run — but per the boundary above,
  these still run via manual scripts, not CI.

## Open questions / to fill in

- Which specific **personal domains** to use for the GoDaddy and Dynadot renewal
  tests.
- Which personal domain(s) to use for the **consolidation transfers** into
  Dynadot and GoDaddy (source registrar → target), respecting "never out of
  Dynadot."
- Whether one numeric `.xyz` (bounced between registrars) is enough for all the
  numeric transfer tests, or if we want a few to parallelize around the 60-day
  lock.

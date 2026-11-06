# Namefi

```ts
const registrar = createRegistrar('namefi', { apiKey: process.env.NAMEFI_API_KEY! });
```

The public REST API is `https://api.namefi.io/v-next`. Authentication uses an
`x-api-key` header. Redirects are refused so that header is never forwarded to a
redirect destination. There is no sandbox.

Create a **Plain API Key** at <https://namefi.io/api-keys> while signed in to the
account that owns the domains. Keys can expire or be non-expiring; revoke them in
that page. The key is account-wide, not read-only: registration can spend NFSC
and charge a saved card. Keep it private. The adapter does not select an
organization or accept a wallet private key.

## Supported operations

| Method              | Endpoint and behavior                                                                                           | Verification                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `testConnection`    | `GET /user`; requires a nonempty account ID in the response, including for an empty account                     | Live read                      |
| `listDomains`       | `GET /user/domains`; complete personal inventory, then local substring filtering                                | Live read                      |
| `getDomain`         | Finds the exact name in the owned inventory; missing ownership throws `NotFoundError`                           | Live read                      |
| `getNameservers`    | Returns the inventory's nameservers; `requiresNameserversFetch` is false                                        | Live read                      |
| `checkAvailability` | `GET /search/availability?domain=…`, once per distinct requested name                                           | Live read                      |
| `getPricing`        | The same full-name endpoint; never generates a probe domain for a TLD                                           | Live read                      |
| `registerDomain`    | `POST /orders/register-domain`; one requested domain, with an accepted asynchronous order reported as `pending` | Unit-tested only; spends money |
| `setAutoRenew`      | Confirms ownership, then `PUT /domain-config/auto-renew`                                                        | Unit-tested only               |
| `getDnsRecords`     | `GET /dns/records?zoneName=…`; splits MX/SRV numeric fields into the shared record shape                        | Live read                      |
| `setDnsRecords`     | Reconciles existing records using the batch update/create/delete endpoints                                      | Unit-tested only               |

Both email-held and NFT-held registry domains are included. NFT ownership is the
representation of a normal registry domain, not a reason to drop it. The API
promises current ownership. Malformed and duplicate inventory rows reject the
whole read rather than turn a source failure into an empty or partial portfolio.
One list costs one request regardless of the number of domains; each standalone
detail or nameserver lookup costs another inventory request. No per-domain
network fan-out happens inside `listDomains`.

The API reports expiry, auto-renew and nameservers. It does **not** report
creation date, a separate renewal deadline, EPP lifecycle, WHOIS privacy or
transfer-lock state. Their shared defaults remain `null`, `unknown`, and `false`;
apps must not interpret the false flags as observed off/unlocked states.

Prices are major currency units with an ISO currency. `PER_YEAR` is annual;
`MULTI_YEAR` contributes only its explicit `1`-year entry. A missing annual quote
stays absent; a multi-year total is never divided or relabeled. Currency conflicts
and mismatched domain identities reject the response. Bare TLD pricing throws
`NotImplementedError`.

## Registration

Registration uses the saved Namefi profile's contacts and default receiving
account/wallet. Pass `contacts: {}` to explicitly use those defaults; supplied
contacts and explicit WHOIS privacy overrides are rejected before submission.
`years` must be an integer from 1 to 10. Initial nameservers and auto-renew can be
provided. This call does not check out a shared website cart.

An accepted order is not final registry completion. A known successful item is
completed; a created/processing item returns `pending: true` with its order ID.
An invalid or mismatched accepted-order response reports an unknown outcome.
Check the order in Namefi before submitting again. No live registration or
payment was performed for this contribution.

## DNS replacement and failures

Saving an unchanged read sends no mutations, including when it contains managed,
SOA or delegation records. Changed records with the same owner/type update by
ID; additions are created before stale IDs are deleted. Namefi validates each
batch transaction, but the complete multi-request replacement is **not atomic**.
A later failure may leave earlier batches applied; read the zone before retrying.
Unconfirmed writes report an unknown outcome and are not resent by the client.

Managed records, SOA and NS cannot be removed or changed through this generic
editor. Requests to change them stop before the first write. Complex type
transitions that conflict with the current zone can be refused by Namefi; they
do not trigger a delete-all fallback. Normal CNAME target changes use updates.

## Not available

There are no public REST endpoints for manual renewal, transfer-in, post-registration
nameserver delegation, transfer locks, WHOIS privacy or per-domain contact reads
and updates. These core methods throw `NotImplementedError` with a reason.
Extended auth-code, transfer-out, DNSSEC and email-forwarding methods are not
advertised. Namefi's managed forwarding endpoint exists, but its redirect-mode
semantics are not mapped into the shared forwarding contract; this is not wired
up and remains in `docs/TODOS.md`.

## Verification

6 November 2026: live read-only account/inventory/detail/nameserver/DNS and annual
price checks passed. Fixtures use synthetic names; no live domains, account IDs,
wallet addresses, contact information or credentials are committed. Availability
and all documented read paths are checked through the actual adapter. Auto-renew,
DNS mutations and registration remain unit-tested only; no live registrar setting,
DNS record, purchase or payment was changed. See `docs/TODOS.md` for the holds.

Sources: [official OpenAPI specification](https://api.namefi.io/v-next/openapi/doc.json),
[API reference](https://api.namefi.io/v-next/openapi/doc),
[authentication guide](https://namefi.io/llms.txt).

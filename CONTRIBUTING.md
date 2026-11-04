# Contributing

Pull requests are welcome, new registrars most of all. This file covers the
general workflow, then everything a new registrar provider needs before it can
be merged.

## Workflow

```bash
npm ci
npm run lint   # tsc + eslint + prettier --check
npm test       # unit tests; no network
npm run build
```

`npm run lint:fix` applies the formatting. Node 20 or newer.

- A bug fix comes with a test that fails without it.
- Keep a PR to one change. A new registrar is its own PR; a fix to another
  provider you found along the way goes in a separate one.
- Never commit credentials, account IDs or real account data: portfolios,
  domain lists, sales, billing. Fixtures use `example.com`-style names, and a
  captured API response is redacted before it goes into a test.

Using an AI coding agent is fine. Point it at this file before it starts, and
before you open the PR, check the docs and the PR description it wrote against
the final code: notes written while researching go stale when the
implementation changes. You're responsible for what the PR says.

## Adding a registrar

A provider is a class that extends `BaseRegistrar` and overrides the operations
its registrar's API supports. The providers in [`src/registrars/`](src/registrars)
are working references: Porkbun (everything `POST`) and NameSilo (everything
`GET`) for an API whose HTTP method doesn't tell reads from writes, Namecheap for
XML, 101domain and Spaceship for REST.

### Before you start

- Check [`docs/registrars/`](docs/registrars) for earlier research. Squarespace,
  Network Solutions and eDomains were looked at and have no usable public API.
- You need a real account with API access. Most registrars have no sandbox, so
  plan how you'll test writes: on a domain you own and can afford to break, set
  back afterwards.
- If the API has an unusual shape (no list endpoint, async jobs, a cart instead
  of a register call), open an issue or a draft PR with the plan first. Agreeing
  on the approach is cheaper before the code exists.

### Files to touch

| File                                                  | What to add                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/registrars/<id>.ts`                              | The provider. The file is named after the id, unless the id starts with a digit (`101domain` lives in `domain101.ts`).                      |
| `src/registrars/index.ts`                             | The class in the `registrars` map, in alphabetical order by id.                                                                             |
| `src/index.ts`                                        | An export for the class.                                                                                                                    |
| `test/<id>.test.ts`                                   | Unit tests (see [Tests](#tests)).                                                                                                           |
| `test/client.test.ts`                                 | Its `requiresNameserversFetch` value, and its id in the `supportsSandbox` list if it has a sandbox.                                         |
| `test/integration/helpers.ts`, `.env.testing.example` | A `SANDBOX_TARGETS` entry and its variables, if it has a sandbox.                                                                           |
| `.env.example`                                        | The credential variables, with where to get them.                                                                                           |
| `docs/registrars/<id>.md`                             | The provider doc (see [Provider doc](#provider-doc)).                                                                                       |
| `README.md`                                           | The Providers table, both Supported functionality tables and their footnotes, the no-sandbox list, and Security if the key goes in the URL. |
| `docs/registrars/FEATURES.md`                         | A link in the opening list of provider docs.                                                                                                |
| `docs/TODOS.md`                                       | An entry under "Needs live testing" for every path not run against a live account.                                                          |

The id is the registrar's name in lowercase with no punctuation (`namecom` for
Name.com). Apps store it with every account, so it can't change after release.

### Metadata

Static fields an app reads without credentials, to build a catalog and a
credential form:

- `displayName`: the registrar's name as it writes it.
- `website`: its bare public domain, such as `gandi.net`. Apps join on it, for
  example against per-registrar pricing data.
- `configFields`: one entry per credential. Labels are Title Case (`API Key`,
  `Client ID`), and secrets are `type: 'password'`.
- `helpText`: where to create the credential, the scopes or IP allowlisting it
  needs, and the main operations the API can't do. A user reads it while adding
  the account.
- `supportsSandbox`: `true` only when the registrar has a sandbox or test
  environment (a separate host, or a test key like Porkbun's).
- `extendedFeatures`: the extended features you implemented. Core features are
  inherited and never listed here.
- `safeMethods`: `REST_SAFE_METHODS` for a REST API (see
  [Reads, writes and retries](#reads-writes-and-retries)).

One instance field: set `requiresNameserversFetch = false` when `listDomains`
already returns nameservers, or when `getNameservers` only re-reads what
`getDomain` returns.

### Construction and auth

Pass `super()` a `baseUrl` from
`selectBaseUrl(name, options?.environment, { production, sandbox })`, plus the
auth headers. `selectBaseUrl` throws when a sandbox is asked for and there is
none, so a test can't reach production by accident.

Send credentials as headers. If the API only takes them in the query string, say
so in a comment and in the README's Security section. Credentials never appear in
error messages. `BaseRegistrar` redacts the instance's credentials from whatever
a feature throws or returns, but don't build a message from one anyway.

### Reads, writes and retries

The library retries a failed read but never re-sends a write whose outcome is
unknown (see [Retries](README.md#retries)). It tells the two apart by the feature
being called, not the HTTP method, and hands that intent to your method in its
`opts`. So:

- Forward the `opts` your method receives into every `this.http` request.
- For a REST API, set `static override readonly safeMethods = REST_SAFE_METHODS`.
  A `GET` made inside a write is then retried as a read.
- For an API whose HTTP method means nothing (everything `POST`, or everything
  `GET`), pass `asRead(opts)` to each lookup a write makes before it writes: the
  current records, a price, a zone id. Calling another feature method (say
  `this.getDnsRecords()` inside `setDnsRecords`) needs nothing extra, since it
  goes through that feature's own wrapper.
- Don't retry failed requests yourself. Polling an async job until it finishes
  is fine.

### Errors and results

- Throw the typed errors in `src/errors.ts`. `HttpClient` already maps 401, 403,
  404 and 429 to `AuthenticationError`, `AuthorizationError`, `NotFoundError` and
  `RateLimitError`.
- A failure the API reports inside a 200 reply becomes an error or a failed
  result, never a success.
- `testConnection`, and writes that return an `OperationResult`, turn a caught
  error into a result with `failedResult(error)`. It keeps the error's `status`,
  so a caller can tell a rejected key (401) from a rate limit (429) without
  parsing the message. Don't build `{ success: false, message }` from the error
  by hand.
- A write the registrar accepted but hasn't finished (waiting on the registry,
  an async job) returns `pending: true`.
- A write made in several requests that fails partway says what was applied and
  that the caller should re-read before retrying. A partial write is never a
  success.
- Every per-domain read throws `NotFoundError` for a domain the account doesn't
  hold, rather than returning an empty value.

### When the API can't do something

Every core method is part of the contract. A method the API can't do rejects
with a `NotImplementedError` whose message says why:

```ts
override lockDomain(_domainName: string, _opts?: RequestOptions): Promise<OperationResult> {
  return Promise.reject(
    new NotImplementedError(`${this.name}: lockDomain is not available — no transfer-lock endpoint`)
  );
}
```

`✗` in the README tables means the API can't. If the API can and you haven't
wired it up, the message says "not wired up" and why, the README footnote says
the API has it, and `docs/TODOS.md` gets an entry.

### Paid operations

Implement `registerDomain`, `renewDomain` and `transferIn` when the API supports
them, even if you can't afford to run them. Several bundled providers shipped
these built from the API docs and were verified later; list yours as unverified
in `docs/TODOS.md`. Where the registrar wants agreement consent, take it with
`requireConsent`, which throws `ConsentRequiredError` when it's missing.

Leave one out only when wiring it up could charge for more than the caller asked:
a cart shared with the registrar's website, say, where checking out would also
buy whatever else is in it. Explain that in the message, the README footnote and
the provider doc.

### Listing and reading domains

- `listDomains` returns the whole account, paging at the API's largest page
  size. Page size isn't a caller option.
- Apply `search` on the server when the API can, and always pass the result
  through `filterDomains(domains, search)` so every provider filters alike.
- Return only names the account holds now: drop names that transferred out,
  were deleted or cancelled, and incoming transfers that haven't completed. Some
  APIs keep listing such names; the provider doc says how you detect them.
- If the registrar sells things that aren't registry domains (web3 or NFT names,
  for example), the PR says whether `listDomains` includes them, and why.
- Build each `Domain` with `createDomain`, which lowercases the status, parses
  dates and normalizes nameservers.
- A field the API doesn't report keeps its default (`false`, `[]` or `null`).
  Name every such field in the provider doc and the PR ("privacy is not
  reported"), so an app doesn't take `false` to mean off.
- Mind what a full list costs. If it takes a request per domain or per batch,
  use bounded concurrency inside the registrar's rate limit, and give the request
  count and time for a large account in the PR.
- If the API still describes a name that has left the account, `getDomain` may
  return it with `deleted: true` rather than throw `NotFoundError`.

### Availability and pricing

- Prices are in major units (`11.99`, not cents), with an ISO 4217 `currency`.
- Never fill in a price the API didn't give: no estimating a renewal from the
  registration price, and no pricing a bare TLD through a made-up name. If the
  API prices only full names, `getPricing` throws `NotImplementedError` for a
  bare TLD, as Dynadot and GoDaddy do.
- `premium` means the name registers at a premium or aftermarket price. Don't
  derive it from unrelated status fields.
- `checkAvailability` returns one result per name asked about. Drop suggestions
  the API adds, and split the names into batches when there are more than one
  call takes.

### Nameservers

The base class normalizes nameservers going in and coming out (lowercase, no
trailing dot), so the provider doesn't. `updateNameservers` returns
`pending: true` when the registry hasn't applied the change yet.

### DNS records and forwarding

`setDnsRecords` and `setDomainForwarding` replace the whole set. Two rules:

1. **Saving what you read changes nothing.**
   `setDnsRecords(d, await getDnsRecords(d))` sends no changes and leaves the
   zone as it was. That settles how to treat records the user can't edit
   (provider-managed or read-only): skip them on write, or leave them out of the
   read. Test it.
2. **A failure never leaves less than there was.** Reconcile instead of deleting
   everything and adding it back: keep identical records, update changed ones,
   add new ones, delete stale ones last. If the API only offers delete-all, or
   the replace can't be atomic, the provider doc says so, and the failure
   message says what was applied and to re-read before retrying.

Also:

- `DnsRecord` keeps MX and SRV priority, weight and port in their own fields.
  Split them out on read and join them back on write.
- If a record type can't be written, throw for it before anything is written
  rather than dropping it.
- Apex NS records belong to `updateNameservers`, not the records API.
- `setDomainForwarding` starts with `settableForwards(forwards, httpsModes)`,
  which rejects masked forwarding and unsupported `https` modes before any write.

### Tests

Unit tests make no network calls. Most provider tests stub `http.request` and
check the request each method sends and how the reply maps to the shared types
(see `test/porkbun.test.ts`). To test status codes and retries end to end, pass a
stub `fetch` instead: `createRegistrar(id, credentials, { fetch, retries: 0 })`
(see `test/retry.test.ts`). Cover:

- The metadata, and where the credentials go.
- Every implemented method: the request it sends, and the mapping of a realistic
  reply, ideally a redacted capture of a real one.
- Pagination, and each kind of name `listDomains` drops.
- Failures: a rejected key gives `testConnection` `{ success: false, status: 401 }`;
  a failure inside a 200 reply; a write's error reply; a domain not in the
  account.
- The DNS round trip (saving what you read sends no changes), and the message of
  a write that fails partway.
- Every `NotImplementedError`, with its reason.
- If the API sends reads and writes with the same HTTP method: a read is re-sent
  after a 503, and a write isn't.

If the registrar has a sandbox, add it to `SANDBOX_TARGETS` so
`npm run test:integration` runs `testConnection` and `listDomains` there.

### Live verification

Unit tests show the code matches your reading of the API docs. Only a live
account shows the docs are right, and they're often wrong. Before you open the
PR:

- Run every read against a live account or sandbox: `testConnection`,
  `listDomains`, `getDomain`, `getNameservers`, `getDnsRecords`,
  `checkAvailability`, `getPricing`, and any extended reads.
- Run the writes you can on a domain you own and can afford to break: read it,
  change it, read it back, set it back. Never test on someone else's domain.
- Paid operations can stay unrun; say so.
- Record what you ran, and when, in the provider doc, and every path you didn't
  run in `docs/TODOS.md`.

A throwaway script calling `createRegistrar` is enough. Keep it out of the
commit, along with any output that lists your domains.

### Docs

#### Provider doc

`docs/registrars/<id>.md` describes the provider as built: what each method does
against the API, and the limits a caller will run into.
[101domain.md](docs/registrars/101domain.md) is a good model. If the doc began as
API research before the code, rewrite it once the code is done, so every
endpoint, behavior and "verified" claim matches what merges.

1. **Header**: how to construct it (`createRegistrar('<id>', { … })`), the API
   base URL, the auth scheme, and whether there's a sandbox.
2. **Credentials**: where a user creates them, scopes, expiry, IP allowlisting,
   account requirements.
3. **Supported operations and limits**: by area (listing, availability and
   pricing, nameservers, DNS, forwarding, …), the endpoint used, what's dropped
   or left at its default, rate limits and slow calls, and writes that aren't
   atomic with what a partial failure leaves behind.
4. **Not available**: each `NotImplementedError` and why, keeping "the API
   can't" apart from "not wired up yet".
5. **Verification**: what was run live and when, and what is unit-tested only.
6. **Sources**: links to the API docs and spec.

#### README

- **Providers**: one row. Notes is a few words on what's unusual.
- **Supported functionality**: a column in both tables, its abbreviation in the
  key below them, and a footnote for each caveat. Reuse an existing footnote only
  if it's true of the new provider as written; otherwise add a new letter.
- **Sandbox environments**: the id in the list of providers without one, if it
  has none.
- **Security**: the provider, if its credentials go in the URL.

### The pull request

Title it `Add <Registrar> registrar provider`. The description covers:

- The API in a few sentences: its style (REST, JSON actions, XML), auth, and
  sandbox.
- A table of every core and extended method and its status: verified live,
  verified in a sandbox, unit-tested only, or not available (and why).
- The decisions a reviewer should check: endpoints picked over the obvious ones,
  names left out of the list, fields not reported, writes that aren't atomic.
- What a full list costs on a large account, in requests and time.
- Anything left for later.

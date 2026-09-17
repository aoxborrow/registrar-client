// Capability model for registrar providers.
//
// Features are identified by the string constants on `Feature`. Always reference
// them through that object (e.g. `Feature.GetPricing`) rather than writing the
// raw string — you get autocomplete and find-all-references, and typos become
// compile errors.
//
// There are two kinds of feature:
//
//   - CORE — the contract every provider is expected to fulfil. A provider
//     inherits the core surface by extending `BaseRegistrar`; it does not
//     re-declare it. Core is a deliberate product decision about what this
//     library guarantees, NOT the intersection of what today's registrars
//     happen to expose — so a single registrar's missing/undocumented endpoint
//     never demotes a feature out of core. Where a registrar's API path for a
//     core feature isn't wired up yet (or hasn't been found — e.g. DNS via
//     Cloudflare's separate Zones API), the method throws `NotImplementedError`
//     until implemented. The contract is the promise; `NotImplementedError` is
//     the "not yet".
//
//   - EXTENDED — opt-in capabilities a provider declares via its static
//     `extendedFeatures`. This is where providers genuinely differ.
//
// A provider's full capability set is `CORE_FEATURES` ∪ its `extendedFeatures`,
// exposed as `provider.features` (and statically as `Registrar.features`).

// All feature identifiers. Reference these instead of string literals.
export const Feature = {
  // --- core (guaranteed contract; inherited from BaseRegistrar) ---
  TestConnection: 'testConnection', // verify credentials
  ListDomains: 'listDomains', // list domains in the account
  GetDomain: 'getDomain', // fetch a single domain's details
  CheckAvailability: 'checkAvailability', // check whether domains can be registered
  GetPricing: 'getPricing', // TLD/domain pricing lookup
  RegisterDomain: 'registerDomain', // register a new domain
  RenewDomain: 'renewDomain', // renew a domain
  SetAutoRenew: 'setAutoRenew', // toggle auto-renew
  TransferIn: 'transferIn', // transfer a domain into the account
  UpdateNameservers: 'updateNameservers', // replace a domain's nameservers
  GetNameservers: 'getNameservers', // read a domain's nameservers
  LockDomain: 'lockDomain', // enable the transfer lock
  UnlockDomain: 'unlockDomain', // disable the transfer lock
  SetPrivacy: 'setPrivacy', // toggle WHOIS privacy
  GetContacts: 'getContacts', // read registrant/admin/tech contacts
  UpdateContacts: 'updateContacts', // update registrant/admin/tech contacts
  GetDnsRecords: 'getDnsRecords', // read DNS records
  SetDnsRecords: 'setDnsRecords', // write DNS records

  // --- extended (opt-in; declared per provider) ---
  GetAuthCode: 'getAuthCode', // retrieve transfer auth/EPP code (transfer out)
  GetDnssec: 'getDnssec', // read whether DNSSEC is enabled (DS / key records)
  DisableDnssec: 'disableDnssec', // turn DNSSEC off (no enable / key management)
  GetEmailForwarding: 'getEmailForwarding', // read alias-style email forwarding rules
  SetEmailForwarding: 'setEmailForwarding', // alias-style email forwarding (redirect only)
  GetDomainForwarding: 'getDomainForwarding', // read URL redirect / domain forwarding
  SetDomainForwarding: 'setDomainForwarding', // URL redirect / domain forwarding
} as const;

// A registrar capability identifier — the value of one of the `Feature` members.
export type RegistrarFeature = (typeof Feature)[keyof typeof Feature];

// The guaranteed core contract: every provider is expected to support these.
export const CORE_FEATURES = [
  Feature.TestConnection,
  Feature.ListDomains,
  Feature.GetDomain,
  Feature.CheckAvailability,
  Feature.GetPricing,
  Feature.RegisterDomain,
  Feature.RenewDomain,
  Feature.SetAutoRenew,
  Feature.TransferIn,
  Feature.UpdateNameservers,
  Feature.GetNameservers,
  Feature.LockDomain,
  Feature.UnlockDomain,
  Feature.SetPrivacy,
  Feature.GetContacts,
  Feature.UpdateContacts,
  Feature.GetDnsRecords,
  Feature.SetDnsRecords,
] as const satisfies readonly RegistrarFeature[];

// Every feature that is not part of the core contract. A provider opts into any
// of these via its static `extendedFeatures`.
export const EXTENDED_FEATURES = [
  Feature.GetAuthCode,
  Feature.GetDnssec,
  Feature.DisableDnssec,
  Feature.GetEmailForwarding,
  Feature.SetEmailForwarding,
  Feature.GetDomainForwarding,
  Feature.SetDomainForwarding,
] as const satisfies readonly RegistrarFeature[];

// Every feature, core first.
export const ALL_FEATURES = [...CORE_FEATURES, ...EXTENDED_FEATURES] as const;

const CORE_FEATURE_SET: ReadonlySet<RegistrarFeature> = new Set(CORE_FEATURES);

// true if `feature` is part of the guaranteed core contract
export function isCoreFeature(feature: RegistrarFeature): boolean {
  return CORE_FEATURE_SET.has(feature);
}

// How each feature method is served: whether it only reads registrar state or
// may change it, and which positional argument carries its `RequestOptions`.
//
// The intent decides what may be re-sent after a failure (see `HttpClient`). It
// is keyed by feature rather than by HTTP method because the method says
// nothing reliable: Namecheap sends every command, writes included, as a GET,
// and Porkbun sends reads as POSTs.
//
// Typed as a total record so adding a feature without classifying it fails to
// compile. `getAuthCode` is a write: several registrars regenerate the code,
// invalidating the previous one.
export const FEATURE_CALLS: Record<
  RegistrarFeature,
  { intent: 'read' | 'write'; optsIndex: number }
> = {
  testConnection: { intent: 'read', optsIndex: 0 },
  listDomains: { intent: 'read', optsIndex: 0 },
  getDomain: { intent: 'read', optsIndex: 1 },
  checkAvailability: { intent: 'read', optsIndex: 1 },
  getPricing: { intent: 'read', optsIndex: 1 },
  registerDomain: { intent: 'write', optsIndex: 2 },
  renewDomain: { intent: 'write', optsIndex: 2 },
  setAutoRenew: { intent: 'write', optsIndex: 2 },
  transferIn: { intent: 'write', optsIndex: 2 },
  updateNameservers: { intent: 'write', optsIndex: 2 },
  getNameservers: { intent: 'read', optsIndex: 1 },
  lockDomain: { intent: 'write', optsIndex: 1 },
  unlockDomain: { intent: 'write', optsIndex: 1 },
  setPrivacy: { intent: 'write', optsIndex: 2 },
  getContacts: { intent: 'read', optsIndex: 1 },
  updateContacts: { intent: 'write', optsIndex: 2 },
  getDnsRecords: { intent: 'read', optsIndex: 1 },
  setDnsRecords: { intent: 'write', optsIndex: 2 },
  getAuthCode: { intent: 'write', optsIndex: 1 },
  getDnssec: { intent: 'read', optsIndex: 1 },
  disableDnssec: { intent: 'write', optsIndex: 1 },
  getEmailForwarding: { intent: 'read', optsIndex: 1 },
  setEmailForwarding: { intent: 'write', optsIndex: 2 },
  getDomainForwarding: { intent: 'read', optsIndex: 1 },
  setDomainForwarding: { intent: 'write', optsIndex: 2 },
};

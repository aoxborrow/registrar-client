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
  ConfigureDnssec: 'configureDnssec', // manage DNSSEC keys / DS records
  GetGlueRecords: 'getGlueRecords', // read glue / host records
  SetGlueRecords: 'setGlueRecords', // write glue / host records
  SetEmailForwarding: 'setEmailForwarding', // alias-style email forwarding (redirect only)
  ProvisionMailbox: 'provisionMailbox', // provision a real hosted mailbox
  SetDomainForwarding: 'setDomainForwarding', // URL redirect / domain forwarding
  SubscribeWebhooks: 'subscribeWebhooks', // register webhook / event subscriptions
  ListOnMarketplace: 'listOnMarketplace', // list a domain on an aftermarket/marketplace
  PushToAccount: 'pushToAccount', // instant intra-registrar ownership push
  AppraiseDomain: 'appraiseDomain', // domain valuation/appraisal lookup
  ApplyBulkSettings: 'applyBulkSettings', // bulk-apply settings to a group of domains
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
  Feature.ConfigureDnssec,
  Feature.GetGlueRecords,
  Feature.SetGlueRecords,
  Feature.SetEmailForwarding,
  Feature.ProvisionMailbox,
  Feature.SetDomainForwarding,
  Feature.SubscribeWebhooks,
  Feature.ListOnMarketplace,
  Feature.PushToAccount,
  Feature.AppraiseDomain,
  Feature.ApplyBulkSettings,
] as const satisfies readonly RegistrarFeature[];

// Every feature, core first.
export const ALL_FEATURES = [...CORE_FEATURES, ...EXTENDED_FEATURES] as const;

const CORE_FEATURE_SET: ReadonlySet<RegistrarFeature> = new Set(CORE_FEATURES);

// true if `feature` is part of the guaranteed core contract
export function isCoreFeature(feature: RegistrarFeature): boolean {
  return CORE_FEATURE_SET.has(feature);
}

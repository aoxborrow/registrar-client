// `@aoxborrow/registrar-client/utils`: the library's pure helpers and data,
// with no provider code, so a browser UI can use them without loading the
// registrars (the main entry pulls in every provider). Nothing here may
// import a provider or a runtime dependency.

// DNS record syntax and canonical form
export * from './dns-records';
// capability ids and the core/extended feature lists
export * from './features';

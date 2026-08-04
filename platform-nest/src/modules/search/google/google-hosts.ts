// Compatibility shim (WD-23A-1). The real file moved to core/google-oauth/hosts.ts, because the OAuth
// machinery is now shared with surfaces outside search (webdev's Drive link) and core must not import
// from modules/. Kept as a re-export so every existing importer and test resolves unchanged.
export * from "../../../core/google-oauth/hosts";

// WSK-07 — DI token for the abstract StorageAdapter. Nest providers key on this token, not on the
// concrete S3StorageAdapter class, so any consumer (MediaService, tests) injects the interface,
// never the implementation — the other half of the "no MinIO-specific assumption leaks" property
// the abstraction test checks.
export const STORAGE_ADAPTER = Symbol("STORAGE_ADAPTER");

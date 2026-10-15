// Stub for `next/headers`, aliased in vitest.config.ts for the cross-package contract test
// (modules/webdev/webdesk-content-ui-contract.test.ts drives platform-ui's REAL `platformFetch`).
//
// DW-7h (FRONTEND-BFF-CONTRACT §52.2): `platformFetch` now reads the incoming request's headers to forward the client's
// address and browser. platform-nest's CI job installs ONLY platform-nest's node_modules, so `next` does not resolve
// there (the same trap as next-navigation-stub.ts). This throws exactly as Next does outside a request scope, so the UI
// takes its "no request context" path and sends neither header, which is what it does in its own tests and builds.
// Nothing in platform-nest imports `next/headers`, so this alias is inert everywhere else.
export async function headers(): Promise<never> {
  throw new Error("`headers` was called outside a request scope (platform-nest test stub)");
}

export async function cookies(): Promise<never> {
  throw new Error("`cookies` was called outside a request scope (platform-nest test stub)");
}

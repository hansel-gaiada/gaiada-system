// Stub for `react`, aliased in vitest.config.ts for the cross-package contract tests that load platform-ui's REAL lib files
// (modules/webdev/webdesk-content-ui-contract.test.ts, webdesk-writers-dashboard*.test.ts drive platform-ui's `platformFetch`).
//
// DW-9d: platform-ui's `lib/platform.ts` wraps `getMe` in React's `cache()` (one `me` per request). platform-nest's CI job installs
// ONLY platform-nest's node_modules, so `react` does not resolve there (the same trap as next-headers-stub.ts). Outside a React server
// render there is no request scope to memoise in, so `cache` is the identity here: every call runs the function, as React's own
// `cache` does outside a render. Nothing in platform-nest imports `react`, so this alias is inert everywhere else.
export function cache<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}

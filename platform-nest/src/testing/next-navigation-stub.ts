// Stub for `next/navigation`, aliased in vitest.config.ts for the cross-package contract test
// (modules/webdev/webdesk-content-ui-contract.test.ts imports platform-ui's real action module).
//
// platform-nest's CI job installs ONLY platform-nest's node_modules, so `next` does not resolve there:
// `platform-ui/src/lib/webdeskContentActions.ts` imports `redirect` (for the *AndOpenAction variants) and
// the whole file failed to load in CI (1.0.0-alpha.350's first CI run). A gate that installs platform-ui
// first hides this, because the import then resolves.
//
// The contract test never calls the redirecting actions, so this is never reached. If something does call
// it, it throws the same `NEXT_REDIRECT` digest Next uses, so a call is loud rather than silent.
// Nothing in platform-nest imports `next/navigation`, so this alias is inert everywhere else.
export function redirect(url: string): never {
  const err = new Error("NEXT_REDIRECT") as Error & { digest: string };
  err.digest = `NEXT_REDIRECT;replace;${url};307;`;
  throw err;
}

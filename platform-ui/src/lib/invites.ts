// W0-5 — shared invite constants/types.
//
// SEPARATE FROM inviteActions.ts BY NECESSITY, not preference: a "use server" module may export ONLY
// async functions. A plain `export const` in that file compiles under `tsc` and passes vitest, then
// fails the webpack pass of `next build` — which is why this split exists and should not be undone.
export type AcceptResult =
  | { ok: true; email: string }
  | { ok: false; error: string; retryable: boolean };

/** Kept in step with the platform's own check (10) rather than being stricter here: a client bounced
 *  by the UI for a rule the API does not have is a support call, not security. */
export const MIN_PASSWORD_LENGTH = 10;

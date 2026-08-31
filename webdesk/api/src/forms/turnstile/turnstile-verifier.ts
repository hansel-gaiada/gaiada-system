// WSK-10 — Turnstile verify (§11 AC: "Turnstile ... mandatory", ticket brief: "env-swappable dev
// stub — real keys are on the Staging Reopen Register, do NOT activate one"). This file is the
// seam ONLY: an interface plus a factory, so forms.module.ts can wire either implementation behind
// one token without either implementation knowing the other exists.
export const TURNSTILE_VERIFIER = Symbol("TURNSTILE_VERIFIER");

export interface TurnstileVerifier {
  readonly mode: "stub" | "live";
  /** `true` iff the token is valid. Never throws for an invalid/missing token — a caller (the
   *  guard/service) turns `false` into the actual 403; throwing is reserved for genuine
   *  transport/config failures (see cloudflare-turnstile-verifier.ts). */
  verify(token: string | undefined, remoteIp: string | undefined): Promise<boolean>;
}

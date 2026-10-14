// DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48.2) — the `google_gmail` surface, declared against the shared Google registry (as DW-6i's Drive is).
//
//   * `module: null`   Gmail is a CORE surface: its state rows carry no module and declare no module scope.
//   * `scopes`         `gmail.readonly` (read your own threads) and `gmail.send` (send as yourself), plus `openid` and `email` so the
//                      connected account can be shown. Both Gmail scopes are Google "restricted"; the app is an INTERNAL-type OAuth app
//                      (the mail design's §8C, A14), which is how that review is avoided: only the company's own Workspace accounts can
//                      consent. No domain-wide delegation, ever.
//   * `ownerKind`      `user`: the credential is the person's own, `owner_id` = the person.
//   * `authz`          the Cerbos check the callback re-runs after the state signature verifies (defence in depth): `personal_mailbox` ·
//                      `connect`, with `ownerId` = the caller. The policy lets only the owner through, so a state minted for someone
//                      else can never be completed by this caller.
//
// Registered when this file is first imported; `gmail.controller.ts` imports it, and the controller is in app.module.
import { registerGoogleSurface, type GoogleSurface } from "../google-oauth/registry";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_SCOPES: string[] = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE, "openid", "email"];

export const GOOGLE_GMAIL_SURFACE: GoogleSurface = {
  provider: "google_gmail",
  module: null,
  scopes: GMAIL_SCOPES,
  authz: { kind: "personal_mailbox", action: "connect" },
  ownerKind: "user",
};

export function registerGoogleGmailSurface(): void {
  registerGoogleSurface(GOOGLE_GMAIL_SURFACE);
}

registerGoogleGmailSurface();

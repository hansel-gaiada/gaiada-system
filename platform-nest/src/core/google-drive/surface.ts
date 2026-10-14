// DW-6i (docs/FRONTEND-BFF-CONTRACT.md §42.3) — the `google_drive` surface, declared against the shared Google registry.
//
//   * `module: null`   Drive is a CORE surface: its state rows carry no module and declare no module scope (migration 0076's
//                      per-row gate treats NULL as "no module wall"; core/google-oauth/module-gate.db.test.ts pins that).
//   * `scopes`         ONE data scope, `drive.file`, plus `openid` and `email` so the connected account can be shown. `drive.file`
//                      reaches only files the person picks with the Picker (or the app creates); Google classifies it NON-SENSITIVE
//                      (see §42.8 for the page and the date), so no sensitive or restricted scope review is involved.
//   * `ownerKind`      `user`: the credential is the person's own, `owner_id` = the person.
//   * `authz`          the Cerbos check the callback re-runs after the state signature verifies (defence in depth, as search's
//                      does): `integration_connection` · `create`, with `ownerId` = the caller, which is exactly what the
//                      "My connections" self-service rows send (integrations.controller.ts: `connectionAction("create", me, me)`
//                      is `create` for your own row). A plain member passes it for their OWN row only.
//
// Registered when this file is first imported; `google-drive.controller.ts` imports it, and the controller is in app.module, so
// the surface exists whenever the app does (the same "registers with the thing that owns it" idiom as search's property-binding).
import { registerGoogleSurface, type GoogleSurface } from "../google-oauth/registry";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_SCOPES: string[] = [DRIVE_FILE_SCOPE, "openid", "email"];

export const GOOGLE_DRIVE_SURFACE: GoogleSurface = {
  provider: "google_drive",
  module: null,
  scopes: DRIVE_SCOPES,
  authz: { kind: "integration_connection", action: "create" },
  ownerKind: "user",
};

export function registerGoogleDriveSurface(): void {
  registerGoogleSurface(GOOGLE_DRIVE_SURFACE);
}

registerGoogleDriveSurface();

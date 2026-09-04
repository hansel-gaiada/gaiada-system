// DO-NOT-ROTATE TRIPWIRE — VLT-4's stated precondition (see
// docs/plans/2026-09-04-client-hosting-credential-vault.md §2 Gap 1, ruling OQ-2.6.b / WSK-D33 in
// docs/blueprints/webdesk-design-v2.md §14).
//
// The owner's ruling ("use the current key for now") is a decision to NOT rotate
// INTEGRATION_TOKEN_KEY — it is NOT a finding that rotation is safe, because rotation is not
// implemented. secret-box.ts seals every row with the constant TOKEN_KEY_VERSION="v1"
// (integrations.service.ts:259,266) but decryptSecret() (secret-box.ts:87-107) never reads that
// column back to pick a key — loadKey() unconditionally resolves the single current
// INTEGRATION_TOKEN_KEY. So if that env var is EVER changed on this box (a "helpful" rotation, a
// copy-paste into the wrong .env, a restore from a different environment's secrets), every row
// already sealed under the old key silently becomes undecryptable. Nothing at the moment of the
// change notices — GCM's auth-tag check only fires the next time something tries to READ a
// credential, which could be minutes or months later, and surfaces as a provider call failing
// ("token vault not configured" / a malformed-envelope 500), not as a rotation error. After VLT-4's
// import, "later" means a client's hosting deploy failing with no obvious connection to a key change
// that happened weeks earlier.
//
// This module turns that silent-and-delayed failure into a loud-and-immediate one, using nothing but
// the crypto secret-box.ts already provides — no new table, no migration, no KMS:
//
//   1. A canary is a fixed, non-secret constant string (CANARY_PLAINTEXT below), sealed with
//      whatever key is CURRENTLY configured, and its ciphertext is stored in the
//      INTEGRATION_TOKEN_KEY_CANARY env var — deliberately NOT a database row. This box's `platform`
//      compose service has no data volume (infra/compose/docker-compose.vps.yml), so anything
//      written to local disk is lost on the next `up -d` recreation; a canary that resets itself on
//      every deploy would silently "pass" forever and protect nothing. An env var lives in the SAME
//      place, and changes on the SAME cadence, as INTEGRATION_TOKEN_KEY itself (the operator's .env),
//      so the two can only drift apart when a human actually changes one of them.
//   2. The ciphertext is safe to hold in plaintext config, in this file's comments, in a compose
//      file, even in this public repo: AES-256-GCM ciphertext of a KNOWN plaintext leaks nothing
//      about the key that sealed it (that is the whole point of authenticated encryption). Nothing
//      here is a secret; only INTEGRATION_TOKEN_KEY itself is, and this module never touches it
//      beyond calling the same loadKey() every other vault read already calls.
//   3. Every boot decrypts the canary with the key configured for THIS boot:
//        - decrypts to CANARY_PLAINTEXT  -> same key that was configured when the canary was minted.
//          Proceed silently (one quiet log line).
//        - throws (bad auth tag / malformed envelope) or decrypts to anything else -> the configured
//          key is NOT the key the vault's existing rows were sealed under. Throw, which crashes
//          bootstrap() and exits the process non-zero — the loudest signal available: the container
//          fails its healthcheck, `restart: unless-stopped` loops it, and the deploy that changed the
//          key is immediately, unmissably broken, instead of quietly shipping and failing weeks later
//          on a real client's credential read.
//        - INTEGRATION_TOKEN_KEY_CANARY unset -> "not yet armed". This is expected on the very first
//          boot ever to configure INTEGRATION_TOKEN_KEY (there is nothing to compare against yet), so
//          it does NOT block boot — refusing to boot before an operator has ever had the chance to
//          set the canary would make this tripwire uninstallable. It mints one and logs it loudly
//          instead, so the very next deploy has something to check against.
//
// Why boot-time rather than a health/readiness endpoint or a docs-only register entry (the plan's
// three options, §2 Gap 1): a health signal is passive — something else has to notice it, and
// /health in this app already answers immediately by design (main.ts) precisely so a slow
// background job can't be mistaken for an outage; bolting a slow crypto check onto it would fight
// that. A register-entry-only tripwire is the plan's own stated MINIMUM, not its target — it relies
// on a human reading a document at the exact moment they change a key, which is exactly the moment
// this whole gap says they will not. A boot assertion that refuses to serve is the cheapest thing
// that is loud AT THE MOMENT OF THE MISTAKE, matching the precedent already in this codebase
// (main.ts's `assertAdsWriteModeBootSafe` — "a boot error, not a warning").
import { config } from "../config";
import { decryptSecret, encryptSecret, isSealed, tokenVaultConfigured } from "./secret-box";

/** Fixed, non-secret constant. Never treated as a real credential — never a value anyone would want
 *  to keep private. Only its CIPHERTEXT (under the real key) is ever compared against. */
export const CANARY_PLAINTEXT = "gaiada-integration-token-key-tripwire-v1";

/** DO-NOT-ROTATE TRIPWIRE. Call once at boot, before the app starts serving. Throws (crashes boot)
 *  iff a canary IS configured and the current INTEGRATION_TOKEN_KEY cannot reproduce it. Never
 *  throws when no vault key is configured at all (the vault's own fail-closed 503 already covers
 *  that case on every token read/write) or when no canary has been minted yet. */
export function assertIntegrationTokenKeyMatchesCanary(): void {
  if (!tokenVaultConfigured()) return;
  const canary = config.integrationTokenKeyCanary;

  if (!canary) {
    let minted: string;
    try {
      minted = encryptSecret(CANARY_PLAINTEXT);
    } catch {
      // tokenVaultConfigured() just returned true, so this should be unreachable; if the key
      // somehow fails between those two calls, there is nothing safe to mint. Say so and move on —
      // never block boot on an unarmed tripwire.
      // eslint-disable-next-line no-console
      console.warn("[token-key-tripwire] UNARMED: could not mint a canary under the configured INTEGRATION_TOKEN_KEY.");
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[token-key-tripwire] UNARMED — INTEGRATION_TOKEN_KEY_CANARY is not set. This is expected on a " +
        "first-ever boot with this key and is NOT a boot failure, but it means a future key change " +
        "will NOT be caught. Set INTEGRATION_TOKEN_KEY_CANARY to the value below now (safe to store in " +
        "plaintext — it is ciphertext of a fixed non-secret string, not the key) so every later boot " +
        `checks against it: INTEGRATION_TOKEN_KEY_CANARY=${minted} ` +
        "See docs/runbooks/credential-vault-rotation.md.",
    );
    return;
  }

  let plaintext: string;
  try {
    if (!isSealed(canary)) throw new Error("INTEGRATION_TOKEN_KEY_CANARY is not an enc:v1 envelope");
    plaintext = decryptSecret(canary);
  } catch (err) {
    throw new Error(
      "[token-key-tripwire] REFUSING TO BOOT: INTEGRATION_TOKEN_KEY cannot decrypt " +
        `INTEGRATION_TOKEN_KEY_CANARY (${(err as Error).message}). This key does NOT match the key ` +
        "every existing integration_connections row was sealed under -- every sealed credential " +
        "(OAuth tokens today, client hosting credentials after VLT-4) will silently fail to decrypt " +
        "on next use. If this key change was DELIBERATE: STOP. Rotation is not implemented -- " +
        "secret-box.ts has no multi-key lookup and no re-encryption path -- see " +
        "docs/runbooks/credential-vault-rotation.md before doing anything else. If this change was " +
        "UNINTENTIONAL: restore the previous INTEGRATION_TOKEN_KEY value immediately.",
    );
  }
  if (plaintext !== CANARY_PLAINTEXT) {
    throw new Error(
      "[token-key-tripwire] REFUSING TO BOOT: INTEGRATION_TOKEN_KEY_CANARY decrypted to an unexpected " +
        "value under the configured INTEGRATION_TOKEN_KEY. Treat this exactly like a failed decrypt " +
        "(see docs/runbooks/credential-vault-rotation.md) -- do not assume it is safe because no " +
        "exception was thrown.",
    );
  }
  // eslint-disable-next-line no-console
  console.log("[token-key-tripwire] INTEGRATION_TOKEN_KEY matches the canary -- vault key unchanged.");
}

// MAIL-10 — raw token generation + hashing (design §9). Deliberately separate from
// core/client-invites.ts's identically-shaped `hashToken`: that file's token is HMAC-signed
// because `client_invites` is a tenant-scoped FORCE-RLS table and the tenant must travel inside
// the token to route the lookup (see that file's header). `auth_magic_links` is GLOBAL (no
// tenant to route on — see the migration's header), so a plain opaque random token whose hash is
// looked up directly is sufficient; no HMAC key, no second secret to configure for this
// auth-critical path.
import { createHash, randomBytes } from "node:crypto";

/** 256 bits of CSPRNG entropy, base64url-encoded. This exact string is the bearer credential — it
 *  is returned from `mintMagicLink` exactly once and must never be written to any row, cache, or
 *  log line anywhere (see service.ts's header). */
export function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 hex — the ONLY form of the token `auth_magic_links.token_hash` ever stores. */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

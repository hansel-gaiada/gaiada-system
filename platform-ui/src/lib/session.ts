// HMAC-signed session cookie (v1-lite dev auth; the OIDC/IdP swap replaces this file).
// Pure crypto only — no next/headers here, so this stays testable in plain vitest/node.
import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "gaiada_session";

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return s;
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function sealSession(userId: string): string {
  // Payload is kept as plain text (not base64) so tampering with the visible
  // userId in the cookie value actually changes the signed payload — a
  // base64url-encoded payload would hide literal substring edits from the
  // signature check.
  return `${userId}.${sign(userId)}`;
}

export function openSession(sealed: string): string | null {
  const idx = sealed.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = sealed.slice(0, idx);
  const sig = sealed.slice(idx + 1);
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return payload;
}

export const SESSION_COOKIE = COOKIE;

// A session is either the v1-lite dev cookie (just a userId) or a full OIDC/SSO session
// carrying the IdP tokens. Both are stored in the SAME HMAC-signed cookie: the signed payload
// is the userId (dev) or "oidc:<base64url(json)>" (OIDC). Pure encode/decode lives here so it
// stays unit-testable; cookie I/O is in session-server.ts.
export type Session =
  | { mode: "dev"; userId: string }
  | { mode: "oidc"; userId: string; accessToken: string; refreshToken: string; expiresAt: number };

const OIDC_PREFIX = "oidc:";

export function encodeSession(s: Session): string {
  if (s.mode === "dev") return s.userId;
  const j = JSON.stringify({ u: s.userId, a: s.accessToken, r: s.refreshToken, e: s.expiresAt });
  return OIDC_PREFIX + Buffer.from(j, "utf8").toString("base64url");
}

export function decodeSession(payload: string): Session | null {
  if (!payload) return null;
  if (payload.startsWith(OIDC_PREFIX)) {
    try {
      const j = JSON.parse(Buffer.from(payload.slice(OIDC_PREFIX.length), "base64url").toString("utf8")) as {
        u: string; a: string; r: string; e: number;
      };
      return typeof j?.u === "string"
        ? { mode: "oidc", userId: j.u, accessToken: j.a, refreshToken: j.r, expiresAt: j.e }
        : null;
    } catch {
      return null;
    }
  }
  return { mode: "dev", userId: payload };
}

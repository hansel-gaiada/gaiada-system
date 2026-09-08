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

// Absolute session lifetime (fault register finding 08, 2026-09-08): the cookie itself never
// carried an expiry, so a copied cookie value was valid forever and there was no idle/absolute
// cutoff at all. This is the ONE TTL for both the cookie's own `maxAge` (set at the two mint
// sites, `app/login/actions.ts` and `app/auth/callback/route.ts`) AND the signed `iat`/`exp` pair
// embedded in the payload below — the cookie attribute alone is enforced by the browser and does
// nothing against a stolen value replayed directly, which is why the signed pair is the part that
// actually matters.
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h absolute lifetime
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

// A session is either the v1-lite dev cookie or a full OIDC/SSO session carrying the IdP tokens.
// Both are stored in the SAME HMAC-signed cookie. Two payload shapes exist for "dev":
//   - the NEW enveloped form this file now mints: "dev:<base64url(json{u,iat,exp,sv?})>"
//   - the LEGACY bare form: the payload IS the userId, no wrapping, no time component at all.
// The legacy form is still accepted (see decodeSession) because `app/auth/magic/route.ts` (a
// login convenience for mailed magic links, MAIL-10 — not owned by this change) mints a bare
// `sealSession(userId)` cookie directly and cannot be updated here; sessions minted that way are
// NOT covered by the new absolute-lifetime check documented below. `sealSession`/`openSession`
// themselves stay generic (no time semantics) precisely so this dual shape is possible without
// touching the wire format `lib/session-expiry.ts` parses on the Edge.
export type Session =
  | { mode: "dev"; userId: string; iat?: number; exp?: number; sv?: number }
  | {
      mode: "oidc";
      userId: string;
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      iat?: number;
      exp?: number;
      sv?: number;
    };

const OIDC_PREFIX = "oidc:";
const DEV_PREFIX = "dev:";

export function encodeSession(s: Session): string {
  const iat = s.iat ?? Date.now();
  const exp = s.exp ?? iat + SESSION_TTL_MS;
  if (s.mode === "dev") {
    const j = JSON.stringify({ u: s.userId, iat, exp, sv: s.sv });
    return DEV_PREFIX + Buffer.from(j, "utf8").toString("base64url");
  }
  // `e` is the OIDC ACCESS TOKEN's own expiry — `lib/session-expiry.ts` reads exactly this field
  // from the Edge to drive the silent-refresh redirect (fault register finding 01). Never rename
  // or repurpose it; `iat`/`exp` below are a separate, additive pair for the SESSION's own
  // absolute lifetime, which is a different clock entirely.
  const j = JSON.stringify({ u: s.userId, a: s.accessToken, r: s.refreshToken, e: s.expiresAt, iat, exp, sv: s.sv });
  return OIDC_PREFIX + Buffer.from(j, "utf8").toString("base64url");
}

export function decodeSession(payload: string): Session | null {
  if (!payload) return null;
  if (payload.startsWith(OIDC_PREFIX)) {
    try {
      const j = JSON.parse(Buffer.from(payload.slice(OIDC_PREFIX.length), "base64url").toString("utf8")) as {
        u: string; a: string; r: string; e: number; iat?: number; exp?: number; sv?: number;
      };
      return typeof j?.u === "string"
        ? {
            mode: "oidc",
            userId: j.u,
            accessToken: j.a,
            refreshToken: j.r,
            expiresAt: j.e,
            iat: typeof j.iat === "number" ? j.iat : undefined,
            exp: typeof j.exp === "number" ? j.exp : undefined,
            sv: typeof j.sv === "number" ? j.sv : undefined,
          }
        : null;
    } catch {
      return null;
    }
  }
  if (payload.startsWith(DEV_PREFIX)) {
    try {
      const j = JSON.parse(Buffer.from(payload.slice(DEV_PREFIX.length), "base64url").toString("utf8")) as {
        u: string; iat?: number; exp?: number; sv?: number;
      };
      return typeof j?.u === "string"
        ? {
            mode: "dev",
            userId: j.u,
            iat: typeof j.iat === "number" ? j.iat : undefined,
            exp: typeof j.exp === "number" ? j.exp : undefined,
            sv: typeof j.sv === "number" ? j.sv : undefined,
          }
        : null;
    } catch {
      return null;
    }
  }
  // Legacy bare-userId dev payload (pre-migration cookies, and every `app/auth/magic/route.ts`
  // cookie going forward — see the type-level comment above). No time component exists to check.
  return { mode: "dev", userId: payload };
}

/** True when a decoded session carries an absolute expiry that has passed. Sessions with no
 *  `exp` (the legacy bare-dev shape) are never considered expired here — see decodeSession. */
export function isSessionExpired(s: Session, now: number = Date.now()): boolean {
  return typeof s.exp === "number" && now > s.exp;
}

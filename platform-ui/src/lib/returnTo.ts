// Shared same-origin, path-only "?return=" validator (UI-01).
//
// Every login-adjacent surface (middleware, /login, /step-up, /auth/login, /auth/callback) needs
// to remember where the user was headed and land them back there after auth completes. A return
// target is user-controlled and sits ON THE LOGIN PATH, which is the worst place to get an open
// redirect wrong — so there is exactly ONE validator, used at every consumption point, not one
// written ad hoc per file. (Before this, `/step-up`, `/login/page.tsx` and `/login/actions.ts` each
// had their own copy of the same shallow `startsWith("/") && !startsWith("//")` check, and
// `/auth/login` — the SSO entry point — had none at all, which is the UI-01 root cause: the return
// target was simply dropped on the SSO path.)
//
// Kept free of `node:crypto`/`next/headers`/`server-only` on purpose: this runs in the Edge
// middleware, in server components, in `"use server"` actions, and in Node route handlers, and it
// needs to stay importable from plain vitest the way `lib/session.ts` does.
//
// This must be called again at the point a redirect is actually issued, not only when the value is
// first written into a link/cookie/query param — see the call sites for why.

const DEFAULT_RETURN = "/";
const MAX_LEN = 2048;
// Any parse of a validated value must resolve back to this sentinel origin. Real navigation never
// sees this string; it exists purely so we can borrow the browser's own WHATWG URL parser to catch
// tricks (WHATWG's backslash-as-slash quirk for special schemes, control-character stripping, etc.)
// that a hand-rolled string check would miss.
const SENTINEL_ORIGIN = "https://return-to.invalid";

function looksDangerous(s: string): boolean {
  // Backslashes are the classic browser-normalization bypass: `/\evil.com` parses as
  // `//evil.com` (protocol-relative) in any WHATWG-URL-compliant browser once the scheme is
  // "special" (http/https). Reject outright rather than trying to enumerate every state-machine
  // path that makes a backslash dangerous.
  if (s.includes("\\")) return true;
  // Anything that isn't path-absolute, plus protocol-relative (`//evil.com`, `///evil.com`).
  if (!s.startsWith("/") || s.startsWith("//")) return true;
  // A scheme can't legally appear right after a leading "/", but reject defensively in case this
  // string later gets concatenated somewhere that would let it act like one
  // (`javascript:`, `data:`, ...).
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(s)) return true;
  return false;
}

// Repeatedly percent-decodes (bounded) and checks EVERY intermediate form, so a double- or
// triple-encoded protocol-relative/backslash payload (`%252F%252Fevil.com` -> `%2F%2Fevil.com` ->
// `//evil.com`) is caught even though no single decode pass reveals it directly. Malformed
// percent-encoding that can't be decoded is treated as dangerous too — if we can't verify a form
// is safe, we don't get to assume it is.
function anyFormDangerous(raw: string): boolean {
  let cur = raw;
  const MAX_ROUNDS = 6;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    if (looksDangerous(cur)) return true;
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return true;
    }
    if (next === cur) return false; // fixed point — nothing further to reveal
    cur = next;
  }
  return looksDangerous(cur);
}

/**
 * Validate a candidate `return=` target. Returns a safe, same-origin, path-absolute string
 * (defaulting to `/`) — NEVER throws, NEVER returns anything that isn't `/`-prefixed and
 * single-slash-led.
 */
export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.length === 0 || raw.length > MAX_LEN) return DEFAULT_RETURN;
  if (anyFormDangerous(raw)) return DEFAULT_RETURN;

  // Authoritative backstop: parse the ORIGINAL (not decoded — a single accumulated percent-
  // encoding layer is inert as a literal path segment; see the decode-chain check above for why
  // that's still safe) value against the sentinel origin with the real URL parser, and require
  // the result to have stayed on it. This catches anything that smuggles a host past the string
  // checks (control-character stripping, the WHATWG backslash quirk, stray scheme tricks) without
  // relying on us re-deriving every parser quirk by hand.
  try {
    const parsed = new URL(raw, SENTINEL_ORIGIN);
    if (parsed.origin !== SENTINEL_ORIGIN || parsed.protocol !== "https:") return DEFAULT_RETURN;
    const rebuilt = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (!rebuilt.startsWith("/") || rebuilt.startsWith("//")) return DEFAULT_RETURN;
    return rebuilt;
  } catch {
    return DEFAULT_RETURN;
  }
}

/** Convenience for the common `searchParams.get("return")` / `[string | string[] | undefined]` shapes. */
export function sanitizeReturnToParam(v: string | string[] | undefined | null): string {
  return sanitizeReturnTo(Array.isArray(v) ? v[0] : v);
}

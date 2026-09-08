import "server-only";
// Request-context half of session.ts, split out so the pure crypto (session.ts)
// stays importable from plain vitest without pulling in next/headers.
import { cookies } from "next/headers";
import { openSession, decodeSession, isSessionExpired, SESSION_COOKIE, type Session } from "./session";

/** Full session (dev or OIDC), or null if absent/tampered/expired. Fail-soft: never throws.
 *
 *  The `isSessionExpired` check (fault register finding 08) is what actually enforces the
 *  session's absolute lifetime — it runs against the SIGNED `exp` inside the payload, using this
 *  server's own clock, so a copied/replayed cookie value cannot outlive it regardless of what the
 *  browser would have done with the cookie's `maxAge`. Sessions with no `exp` at all (the legacy
 *  bare-userId dev shape — see session.ts) are not held to this and pass through unchanged. */
export async function getSession(): Promise<Session | null> {
  try {
    const jar = await cookies();
    const raw = jar.get(SESSION_COOKIE)?.value;
    if (!raw) return null;
    const payload = openSession(raw);
    if (!payload) return null;
    const session = decodeSession(payload);
    if (!session || isSessionExpired(session)) return null;
    return session;
  } catch {
    return null;
  }
}

export async function getSessionUserId(): Promise<string | null> {
  return (await getSession())?.userId ?? null;
}

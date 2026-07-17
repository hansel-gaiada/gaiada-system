import "server-only";
// Request-context half of session.ts, split out so the pure crypto (session.ts)
// stays importable from plain vitest without pulling in next/headers.
import { cookies } from "next/headers";
import { openSession, decodeSession, SESSION_COOKIE, type Session } from "./session";

/** Full session (dev or OIDC), or null if absent/tampered. Fail-soft: never throws. */
export async function getSession(): Promise<Session | null> {
  try {
    const jar = await cookies();
    const raw = jar.get(SESSION_COOKIE)?.value;
    if (!raw) return null;
    const payload = openSession(raw);
    return payload ? decodeSession(payload) : null;
  } catch {
    return null;
  }
}

export async function getSessionUserId(): Promise<string | null> {
  return (await getSession())?.userId ?? null;
}

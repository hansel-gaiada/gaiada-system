import "server-only";
// Request-context half of session.ts, split out so the pure crypto (session.ts)
// stays importable from plain vitest without pulling in next/headers.
import { cookies } from "next/headers";
import { openSession, SESSION_COOKIE } from "./session";

export async function getSessionUserId(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  return raw ? openSession(raw) : null;
}

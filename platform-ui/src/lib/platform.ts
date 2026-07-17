import "server-only";
// The ONLY backend this UI talks to. Server-side only — tokens never reach the browser.
export class PlatformError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function platformFetch<T>(path: string, userId: string, init: RequestInit = {}): Promise<T> {
  // TEMP DEMO MODE — see lib/demoFixtures.ts. Lets the UI be browsed with no
  // backend running. Inert unless DEMO_MODE=1 is set locally (gitignored .env).
  if (process.env.DEMO_MODE === "1") {
    const { getDemoResponse } = await import("./demoFixtures");
    const body = typeof init.body === "string" ? init.body : undefined;
    const { status, json } = getDemoResponse(init.method ?? "GET", path, body);
    if (status < 200 || status >= 300) {
      throw new PlatformError(status, (json as { error?: string })?.error ?? `platform ${status}`);
    }
    return json as T;
  }
  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";

  // Auth: an OIDC/SSO session presents the user's IdP access token directly (the platform
  // verifies it and resolves the principal). Otherwise the dev BFF path — service token +
  // x-user-id (the platform accepts this in dev/hybrid mode). Resilient: if the session
  // lookup isn't available (e.g. plain vitest, no request context), fall back to the dev path.
  let authHeaders: Record<string, string>;
  let oidc: { accessToken: string } | null = null;
  try {
    const { getSession } = await import("./session-server");
    const s = await getSession();
    if (s?.mode === "oidc") oidc = { accessToken: s.accessToken };
  } catch {
    oidc = null;
  }
  if (oidc) {
    authHeaders = { authorization: `Bearer ${oidc.accessToken}` };
  } else {
    authHeaders = { authorization: `Bearer ${process.env.PLATFORM_SERVICE_TOKEN ?? ""}`, "x-user-id": userId };
  }

  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...authHeaders,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = `platform ${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* keep default */ }
    throw new PlatformError(res.status, msg);
  }
  return (await res.json()) as T;
}

export interface Me {
  userId: string; name: string; email: string; title: string | null; assurance: string;
  companies: { id: string; name: string; type: string | null }[];
  roles: { role: string; scopeType: string; scopeId: string | null }[];
}

export const getMe = (userId: string) => platformFetch<Me>("/api/me", userId);

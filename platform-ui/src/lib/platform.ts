import "server-only";
// The ONLY backend this UI talks to. Server-side only — tokens never reach the browser.
export class PlatformError extends Error {
  // `field` is additive (bot admin proxy 400s as {error, field} per doc §2.3/2.4) —
  // undefined for every existing caller that never sends it.
  constructor(public status: number, message: string, public field?: string) { super(message); }
}

export async function platformFetch<T>(path: string, userId: string, init: RequestInit = {}): Promise<T> {
  // TEMP DEMO MODE — see lib/demoFixtures.ts. Lets the UI be browsed with no
  // backend running. Inert unless DEMO_MODE=1 is set locally (gitignored .env).
  if (process.env.DEMO_MODE === "1") {
    const { getDemoResponse } = await import("./demoFixtures");
    const body = typeof init.body === "string" ? init.body : undefined;
    const { status, json } = getDemoResponse(init.method ?? "GET", path, userId, body);
    if (status < 200 || status >= 300) {
      const body = json as { error?: string; field?: string };
      throw new PlatformError(status, body?.error ?? `platform ${status}`, body?.field);
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
      // Only claim a JSON content-type when a body is actually being sent —
      // Fastify's JSON body parser 400s on an empty body declared as
      // application/json (hit by every bodyless POST, e.g. mark-read /
      // mark-all-read / other no-payload actions).
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = `platform ${res.status}`;
    let field: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; field?: string };
      msg = body.error ?? msg;
      field = body.field;
    } catch { /* keep default */ }
    throw new PlatformError(res.status, msg, field);
  }
  return (await res.json()) as T;
}

// WD-07 (Part A, WD-04 frontend): multipart uploader for the in-ERP audio-upload path
// (`POST /api/:t/meetings/recordings/:id/audio`). Deliberately separate from platformFetch:
// that helper always forces `content-type: application/json` whenever a body is present,
// which would corrupt a multipart body's boundary. This omits any content-type header so
// fetch/undici sets `multipart/form-data; boundary=…` itself from the FormData instance.
// Same auth-header resolution as platformFetch (OIDC session first, dev bearer+x-user-id
// fallback); callers are expected to handle DEMO_MODE themselves (a real binary upload has
// no meaningful demo fixture path — see meetingsActions.ts).
export async function platformUpload<T>(path: string, userId: string, form: FormData): Promise<T> {
  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
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
  const res = await fetch(`${base}${path}`, { method: "POST", headers: authHeaders, body: form, cache: "no-store" });
  if (!res.ok) {
    let msg = `platform ${res.status}`;
    let field: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; field?: string };
      msg = body.error ?? msg;
      field = body.field;
    } catch { /* keep default */ }
    throw new PlatformError(res.status, msg, field);
  }
  return (await res.json()) as T;
}

// A served-company grant materialized by the ORG-6 reconciler for a shared-service
// unit (e.g. an HR staffer placed in a provider company's HR department, serving
// one or more target companies for a given module). `[]` whenever
// SERVICE_ASSIGNMENTS_ENABLED is off or the caller has none (ORG-7b, additive).
export interface ServiceScope {
  companyId: string;
  companyName: string;
  assignmentId: string;
  module: string;
  unitName: string;
  role: "staff" | "manager";
}

export interface Me {
  userId: string; name: string; email: string; title: string | null; assurance: string;
  companies: { id: string; name: string; type: string | null }[];
  roles: { role: string; scopeType: string; scopeId: string | null }[];
  serviceScopes?: ServiceScope[];
}

export const getMe = (userId: string) => platformFetch<Me>("/api/me", userId);

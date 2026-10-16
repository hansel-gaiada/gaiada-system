import "server-only";
import { cache } from "react";
import { isDemoMode } from "./demoMode";
import { SESSION_REVOKED_REASON, withSessionEndedRedirect } from "./sessionEnded";
// The ONLY backend this UI talks to. Server-side only — tokens never reach the browser.
export class PlatformError extends Error {
  // `field` is additive (bot admin proxy 400s as {error, field} per doc §2.3/2.4) —
  // undefined for every existing caller that never sends it.
  // `existing` is additive too (MI-03/MI-05): the webdev triage 409 ("already triaged") carries the
  // artifact a race loser needs to navigate to instead of a bare failure — HttpErrorFilter forwards
  // it verbatim (platform-nest/src/http-error.filter.ts). undefined for every other caller.
  // `reason` — AD-11, additive on the identical rule. The agency-leads invite endpoint's 409
  // ("lead_already_dispositioned") is a MACHINE code, and the FRONTEND-BFF-CONTRACT.md's own rule 5
  // for this feature says a consumer must branch on `reason`, never on `error` text (the human
  // message is free to reword). `HttpErrorFilter` already forwards `reason` in the response body —
  // it was PlatformError that dropped it on the way in, which would have made the documented field
  // one no caller in this app could actually read. undefined for every other caller.
  // `body` — WSK-44, additive on the same rule. The WebDesk content BFF passes Zone B's typed
  // RFC 9457 problems through (409 version-conflict carries `currentHeadVersion`, 422 carries
  // `issues[]`), and the four fields above cannot carry them: without the raw body a caller cannot
  // tell `version-conflict` from `slug-taken`. Only `lib/webdeskContent.ts` reads it; undefined
  // whenever the response had no JSON body.
  constructor(
    public status: number,
    message: string,
    public field?: string,
    public existing?: Record<string, unknown>,
    public reason?: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

/** The longest user agent platform-nest keeps (`security_access_seen.user_agent`, BFF §52.2). */
export const CLIENT_UA_MAX = 512;

/**
 * DW-7h (FRONTEND-BFF-CONTRACT §52.2): who is really calling. platform-nest is reached from this server, never from the
 * browser, so without these it would see this container's address and Node's user agent on every request, and IT's
 * "Connected" page and address blocks would have nothing to go on.
 *   * `x-gaiada-client-ip`: the incoming request's `x-real-ip` (nginx `location /` sets it to `$remote_addr`), else the
 *     RIGHTMOST `x-forwarded-for` entry (the one the nearest proxy appended; the leftmost is whatever the client wrote).
 *   * `x-gaiada-client-ua`: the incoming `user-agent`, cut to 512 characters.
 * platform-nest believes these only on a request that did NOT pass nginx (core/security/client-context.ts), so a
 * browser cannot plant them through the one public nginx path into it.
 *
 * Empty when there is no request (a test, a build, a background job): `headers()` throws there, and the call goes out
 * without them, as before.
 */
export async function forwardedClientHeaders(): Promise<Record<string, string>> {
  let incoming: { get(name: string): string | null };
  try {
    const { headers } = await import("next/headers");
    incoming = await headers();
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  const realIp = incoming.get("x-real-ip")?.trim();
  const rightmost = incoming.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean).pop();
  const ip = realIp || rightmost;
  if (ip) out["x-gaiada-client-ip"] = ip;
  const ua = incoming.get("user-agent")?.trim();
  if (ua) out["x-gaiada-client-ua"] = ua.slice(0, CLIENT_UA_MAX);
  return out;
}

/** BFF §52.4: a refusal of a session IT signed out also redirects to `/auth/ended` (see lib/sessionEnded.ts). Every
 *  other error, including every other 401, is the plain PlatformError it always was. */
function refusal(err: PlatformError): PlatformError {
  return err.status === 401 && err.reason === SESSION_REVOKED_REASON ? withSessionEndedRedirect(err) : err;
}

export async function platformFetch<T>(path: string, userId: string, init: RequestInit = {}): Promise<T> {
  // TEMP DEMO MODE — see lib/demoFixtures.ts. Lets the UI be browsed with no
  // backend running. Inert unless DEMO_MODE=1 is set locally (gitignored .env).
  //
  // `isDemoMode()` rather than reading the env directly: it THROWS if the flag is ever set in a
  // production runtime, so a misconfigured deployment fails loudly here instead of quietly serving
  // fixtures — invented invoices, clients and monitors — to real users behind healthy-looking 200s.
  // See lib/demoMode.ts. This is the only branch in the app that reaches the fixture modules.
  if (isDemoMode()) {
    const { getDemoResponse } = await import("./demoFixtures");
    const body = typeof init.body === "string" ? init.body : undefined;
    const { status, json } = getDemoResponse(init.method ?? "GET", path, userId, body);
    if (status < 200 || status >= 300) {
      const body = json as { error?: string; field?: string; existing?: Record<string, unknown>; reason?: string };
      throw new PlatformError(status, body?.error ?? `platform ${status}`, body?.field, body?.existing, body?.reason, json);
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
      ...(await forwardedClientHeaders()),
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
    let existing: Record<string, unknown> | undefined;
    let reason: string | undefined;
    let rawBody: unknown;
    try {
      const body = (await res.json()) as { error?: string; field?: string; existing?: Record<string, unknown>; reason?: string };
      rawBody = body;
      msg = body.error ?? msg;
      field = body.field;
      existing = body.existing;
      reason = body.reason;
    } catch { /* keep default */ }
    throw refusal(new PlatformError(res.status, msg, field, existing, reason, rawBody));
  }
  return (await res.json()) as T;
}

// WD-07 (Part A, WD-04 frontend): multipart uploader for the in-ERP audio-upload path
// (`POST /api/:t/meetings/recordings/:id/audio`). Deliberately separate from platformFetch:
// that helper always forces `content-type: application/json` whenever a body is present,
// which would corrupt a multipart body's boundary. This omits any content-type header so
/** The auth headers every egress to the platform carries: the OIDC session's access token when
 *  there is one, else the dev path (service bearer + x-user-id). Shared by `platformUpload` and the
 *  streaming upload route (`app/api/meetings/[id]/audio`), which cannot use FormData because it
 *  forwards the browser's multipart body as a stream. */
export async function platformAuthHeaders(userId: string): Promise<Record<string, string>> {
  let oidc: { accessToken: string } | null = null;
  try {
    const { getSession } = await import("./session-server");
    const s = await getSession();
    if (s?.mode === "oidc") oidc = { accessToken: s.accessToken };
  } catch {
    oidc = null;
  }
  if (oidc) return { authorization: `Bearer ${oidc.accessToken}` };
  return { authorization: `Bearer ${process.env.PLATFORM_SERVICE_TOKEN ?? ""}`, "x-user-id": userId };
}

// fetch/undici sets `multipart/form-data; boundary=…` itself from the FormData instance.
// Same auth-header resolution as platformFetch (OIDC session first, dev bearer+x-user-id
// fallback); callers are expected to handle DEMO_MODE themselves (a real binary upload has
// no meaningful demo fixture path — see meetingsActions.ts).
export async function platformUpload<T>(path: string, userId: string, form: FormData): Promise<T> {
  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  const authHeaders = await platformAuthHeaders(userId);
  const res = await fetch(`${base}${path}`, {
    method: "POST", headers: { ...authHeaders, ...(await forwardedClientHeaders()) }, body: form, cache: "no-store",
  });
  if (!res.ok) {
    let msg = `platform ${res.status}`;
    let field: string | undefined;
    let reason: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; field?: string; reason?: string };
      msg = body.error ?? msg;
      field = body.field;
      reason = body.reason;
    } catch { /* keep default */ }
    throw refusal(new PlatformError(res.status, msg, field, undefined, reason));
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
  /** PV5-14 / PV-D40 (dev stage): present only while a SIMULATED second factor holds this sign-in at high
   *  assurance, with when it ends (ISO). The header badge reads them; never shown as real MFA. */
  assuranceSource?: "simulated";
  assuranceExpiresAt?: string | null;
  /** PV1-01 added `vertical` (the company's business line, which selects its pack), `enabledModules`
   *  (the effective set the module gate uses) and `rootCompanyId`. Optional for an older backend:
   *  treat a missing vertical as "general", missing modules as unknown (hide nothing), and a missing
   *  root as "not a root". PV-D31 added `isOperatorRoot`: true only on the one root whose owners
   *  get the Platform area; a missing value (older backend) is "not the operator root". */
  companies: {
    id: string; name: string; type: string | null;
    vertical?: string; enabledModules?: string[]; rootCompanyId?: string | null; isOperatorRoot?: boolean;
  }[];
  roles: { role: string; scopeType: string; scopeId: string | null }[];
  serviceScopes?: ServiceScope[];
  /** PV2-02: companies where the caller is an active client contact. Optional: treat missing as []. */
  clientOf?: { companyId: string; companyName: string }[];
}

// Memoised per request (React `cache`, keyed by userId): the (app) layout, the department layout and the page each ask for the
// caller's `me`, and without this each was its own `/api/me` round trip and its own object, so the caches keyed on the `me`
// object (`myWorkspaces`, `readNowQueue`) never hit across components. Nothing mutates the returned value (it is read-only data).
export const getMe = cache((userId: string) => platformFetch<Me>("/api/me", userId));

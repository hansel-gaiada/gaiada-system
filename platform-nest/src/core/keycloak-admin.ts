// W0-3 — the Keycloak Admin API client used to provision a client-portal contact's account when they
// accept an invite. This is the platform's FIRST Keycloak admin integration; nothing here existed
// before, and `auth/oidc.ts` only ever consumed tokens.
//
// ── THE CONTRACT BELOW WAS MEASURED, NOT ASSUMED ──────────────────────────────────────────────────
// Verified 2026-08-03 against the live `gaiada` realm on gda-aicenter using a purpose-made
// `gaiada-provisioner` service-account client (confidential; standard flow + direct grants OFF; only
// `realm-management` → manage-users + view-users):
//   POST   /admin/realms/{realm}/users                      -> 201, Location: .../users/{id}
//   GET    /admin/realms/{realm}/users?email=&exact=true    -> 200 [ { id, email, emailVerified, ... } ]
//   PUT    /admin/realms/{realm}/users/{id}/reset-password  -> 204
//   PUT    /admin/realms/{realm}/users/{id}   (enabled:false) -> 204
//   DELETE /admin/realms/{realm}/users/{id}                 -> 204
// Boundary probed at the same time: creating a client -> 403, and mapping realm-admin onto a user it
// had just created -> 403 (the mapping verifiably did not stick). It CAN read realm config and list
// roles read-only, so the accurate description is "cannot modify anything but users and cannot
// escalate", NOT "users only".
//
// ── emailVerified: true IS THE POINT OF THIS FILE ─────────────────────────────────────────────────
// `auth/oidc.ts` provisionUser() links a first login to a pre-existing (invited) `users` row by email
// ONLY when the IdP says that email is verified, and THROWS otherwise:
//   "email collides with an existing account but is not IdP-verified — refusing to link"
// So an account created here with emailVerified:false makes the invited contact's very first login
// fail with an internal invariant message. The flag is legitimate because acceptance required
// consuming a single-use token that was delivered to that address — that click IS the proof of
// control the flag is meant to represent. Do not set it any other way, and do not "tidy" it to false.
import { randomUUID } from "node:crypto";
import { config } from "../config";

/** FAIL-CLOSED deployment state, not a caller error — same shape and status as
 *  `GatewayNotConfiguredError`/`GoogleOAuthNotConfiguredError`: a plain 503 with an actionable
 *  message, never a half-attempt against a phantom realm. Extends Error (not HttpException) to match
 *  its siblings; `KeycloakAdminErrorFilter` maps the family. */
export class KeycloakNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = "keycloak_admin_not_configured";
  constructor(missing: string[]) {
    super(
      "Keycloak user provisioning is not configured: set " +
        "KEYCLOAK_ADMIN_BASE_URL, KEYCLOAK_ADMIN_REALM, KEYCLOAK_ADMIN_CLIENT_ID and " +
        "KEYCLOAK_ADMIN_CLIENT_SECRET. The client must be a confidential service-account client " +
        "holding realm-management:manage-users (see docs — `gaiada-provisioner`). Until it is set, no " +
        "client-portal contact can be given an account.",
    );
    this.name = "KeycloakNotConfiguredError";
    this.missing = missing;
  }
  readonly missing: string[];
}

/** The admin API refused or answered unusably. 502 — it arrived from across a network boundary, so
 *  attributing it to the caller would be a lie (the same reasoning GoogleTokenEndpointError uses). */
export class KeycloakAdminError extends Error {
  readonly status = 502;
  readonly code = "keycloak_admin_error";
  constructor(
    readonly operation: string,
    readonly httpStatus: number,
    detail?: string,
  ) {
    super(`Keycloak admin ${operation} failed (HTTP ${httpStatus})${detail ? `: ${detail}` : ""}`);
    this.name = "KeycloakAdminError";
  }
}

/** A username/email already exists in the realm. Distinct from KeycloakAdminError because the caller's
 *  correct response differs: this is reconcilable (adopt the existing account) rather than a fault. */
export class KeycloakUserExistsError extends Error {
  readonly status = 409;
  readonly code = "keycloak_user_exists";
  constructor(readonly email: string) {
    super(`a Keycloak user already exists for ${email}`);
    this.name = "KeycloakUserExistsError";
  }
}

export type FetchImpl = typeof fetch;

export interface KeycloakUser {
  id: string;
  username: string;
  email: string | null;
  emailVerified: boolean;
  enabled: boolean;
}

function cfg(): { baseUrl: string; realm: string; clientId: string; clientSecret: string } {
  const k = config.keycloakAdmin;
  const missing = [
    ...(k.baseUrl ? [] : ["KEYCLOAK_ADMIN_BASE_URL"]),
    ...(k.realm ? [] : ["KEYCLOAK_ADMIN_REALM"]),
    ...(k.clientId ? [] : ["KEYCLOAK_ADMIN_CLIENT_ID"]),
    ...(k.clientSecret ? [] : ["KEYCLOAK_ADMIN_CLIENT_SECRET"]),
  ];
  if (missing.length) throw new KeycloakNotConfiguredError(missing);
  return { baseUrl: k.baseUrl.replace(/\/$/, ""), realm: k.realm, clientId: k.clientId, clientSecret: k.clientSecret };
}

export function keycloakAdminConfigured(): boolean {
  const k = config.keycloakAdmin;
  return !!(k.baseUrl && k.realm && k.clientId && k.clientSecret);
}

// ── Token cache ───────────────────────────────────────────────────────────────────────────────────
// A service-account token is good for minutes and every provisioning step needs one, so an invite
// acceptance would otherwise mint three. Cached with a safety margin and a single-flight promise so a
// burst of concurrent acceptances performs ONE token request rather than N.
let cached: { token: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;
/** Refresh this far BEFORE the stated expiry so a request never races its own token's death. */
const TOKEN_SKEW_MS = 30_000;

/** Exported for tests only — a module-level cache otherwise leaks state between cases and makes a
 *  passing test depend on execution order. */
export function resetKeycloakAdminTokenCache(): void {
  cached = null;
  inFlight = null;
}

async function accessToken(fetchImpl: FetchImpl = fetch): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt - TOKEN_SKEW_MS > now) return cached.token;
  if (inFlight) return inFlight;

  const { baseUrl, realm, clientId, clientSecret } = cfg();
  inFlight = (async () => {
    const res = await fetchImpl(`${baseUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) {
      // Deliberately does NOT echo the response body: a token-endpoint error can quote the request,
      // and the request contains the client secret.
      throw new KeycloakAdminError("token", res.status);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new KeycloakAdminError("token", res.status, "response had no access_token");
    }
    const ttlSec = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 60;
    cached = { token: body.access_token, expiresAt: Date.now() + ttlSec * 1000 };
    return cached.token;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function adminFetch(
  path: string,
  init: RequestInit,
  operation: string,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  const { baseUrl, realm } = cfg();
  const token = await accessToken(fetchImpl);
  const res = await fetchImpl(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
  // A 401 means the cached token died early (realm restart, key rotation). Drop it and retry ONCE, so
  // a long-lived process doesn't need a redeploy to recover.
  if (res.status === 401) {
    cached = null;
    const retryToken = await accessToken(fetchImpl);
    return fetchImpl(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${retryToken}` },
    });
  }
  void operation;
  return res;
}

/** Look a user up by email. `exact=true` matters: without it Keycloak does a prefix/infix search and
 *  `a@b.test` would also match `xa@b.test.uk`, which for an identity lookup is a wrong-account bug. */
export async function findUserByEmail(email: string, fetchImpl: FetchImpl = fetch): Promise<KeycloakUser | null> {
  const q = new URLSearchParams({ email: email.toLowerCase(), exact: "true" });
  const res = await adminFetch(`/users?${q}`, { method: "GET" }, "findUserByEmail", fetchImpl);
  if (!res.ok) throw new KeycloakAdminError("findUserByEmail", res.status);
  const rows = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  const r = Array.isArray(rows) ? rows[0] : undefined;
  if (!r || typeof r.id !== "string") return null;
  return {
    id: r.id,
    username: typeof r.username === "string" ? r.username : "",
    email: typeof r.email === "string" ? r.email : null,
    emailVerified: r.emailVerified === true,
    enabled: r.enabled !== false,
  };
}

export interface CreateUserInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  /** Set on the new account. Optional so a caller may create-then-set separately, but the invite flow
   *  passes it so acceptance is one round trip fewer. */
  password?: string | null;
}

/** Create an ENABLED, EMAIL-VERIFIED user and return its Keycloak id.
 *
 *  Username IS the email: this realm's users are identified by email everywhere (oidc.ts links on it,
 *  client_contacts stores it), and a second identifier would be a second thing to keep in sync.
 *
 *  Idempotent-ish by design: a 409 from Keycloak becomes `KeycloakUserExistsError` so the invite path
 *  can ADOPT an existing account rather than dead-ending. That case is real, not theoretical — the
 *  same person may already be a contact of another client in the same realm. */
export async function createUser(input: CreateUserInput, fetchImpl: FetchImpl = fetch): Promise<string> {
  const email = input.email.toLowerCase();
  const res = await adminFetch(
    "/users",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: email,
        email,
        // ── load-bearing; see this file's header. Never false here. ──
        emailVerified: true,
        enabled: true,
        ...(input.firstName ? { firstName: input.firstName } : {}),
        ...(input.lastName ? { lastName: input.lastName } : {}),
      }),
    },
    "createUser",
    fetchImpl,
  );
  if (res.status === 409) throw new KeycloakUserExistsError(email);
  if (res.status !== 201) {
    throw new KeycloakAdminError("createUser", res.status, (await res.text().catch(() => "")).slice(0, 200));
  }

  // Keycloak returns the new id only in the Location header. Falling back to a lookup rather than
  // failing keeps this working behind a proxy that strips or rewrites Location.
  const loc = res.headers.get("location") ?? "";
  const fromHeader = loc.split("/").filter(Boolean).pop() ?? "";
  const id =
    /^[0-9a-fA-F-]{36}$/.test(fromHeader) ? fromHeader : (await findUserByEmail(email, fetchImpl))?.id ?? "";
  if (!id) throw new KeycloakAdminError("createUser", res.status, "created but the new user id could not be resolved");

  if (input.password) await setPassword(id, input.password, fetchImpl);
  return id;
}

/** Set a permanent password. `temporary: false` on purpose — a temporary credential forces Keycloak's
 *  own UPDATE_PASSWORD screen on first login, which for an external client is an extra unexplained
 *  step immediately after they just chose a password on our own accept screen. */
export async function setPassword(userId: string, password: string, fetchImpl: FetchImpl = fetch): Promise<void> {
  const res = await adminFetch(
    `/users/${encodeURIComponent(userId)}/reset-password`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "password", value: password, temporary: false }),
    },
    "setPassword",
    fetchImpl,
  );
  // 204 is the documented success; accept any 2xx rather than pinning one code.
  if (!res.ok) throw new KeycloakAdminError("setPassword", res.status);
}

/** Set a TEMPORARY password — Keycloak raises its own UPDATE_PASSWORD screen at first login.
 *
 *  ⚠ THE OPPOSITE CHOICE FROM `setPassword()` ABOVE, AND BOTH ARE CORRECT. That one is for the IT
 *  reset-password flow, where an admin reads a generated one-off to someone (often mid-support-call)
 *  and a forced reset screen is an unexplained extra step. This one is for BOOTSTRAP credentials: a
 *  value that is shared, known to more than one person, or written down somewhere. There, surviving
 *  first use is the defect — so the forced change is the entire point.
 *
 *  Deliberately a separate function rather than a `temporary` flag on `setPassword`: a boolean
 *  parameter at the call site reads as a detail, and the existing callers would all have had to pass
 *  it. Two named functions make the choice legible in the caller and impossible to flip by accident. */
export async function setPasswordTemporary(userId: string, password: string, fetchImpl: FetchImpl = fetch): Promise<void> {
  const res = await adminFetch(
    `/users/${encodeURIComponent(userId)}/reset-password`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "password", value: password, temporary: true }),
    },
    "setPasswordTemporary",
    fetchImpl,
  );
  if (!res.ok) throw new KeycloakAdminError("setPasswordTemporary", res.status);
}

/** Disable an account — what REVOKING a client contact does at the IdP.
 *
 *  Disable, never DELETE: the platform `users` row and its audit trail (who signed what, when) must
 *  survive revocation, and deleting the IdP identity would orphan `users.idp_subject` so a later
 *  re-invite of the same person could silently mint a second account. Revocation is reversible; a
 *  delete is not. `deleteUser` exists below for test cleanup only. */
export async function disableUser(userId: string, fetchImpl: FetchImpl = fetch): Promise<void> {
  const res = await adminFetch(
    `/users/${encodeURIComponent(userId)}`,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) },
    "disableUser",
    fetchImpl,
  );
  if (!res.ok) throw new KeycloakAdminError("disableUser", res.status);
}

/** Re-enable a previously revoked account (re-invite of a known contact). */
export async function enableUser(userId: string, fetchImpl: FetchImpl = fetch): Promise<void> {
  const res = await adminFetch(
    `/users/${encodeURIComponent(userId)}`,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) },
    "enableUser",
    fetchImpl,
  );
  if (!res.ok) throw new KeycloakAdminError("enableUser", res.status);
}

/** Hard-delete. NOT part of the revoke path (see disableUser) — this exists so live/integration tests
 *  can clean up the accounts they mint. */
export async function deleteUser(userId: string, fetchImpl: FetchImpl = fetch): Promise<void> {
  const res = await adminFetch(`/users/${encodeURIComponent(userId)}`, { method: "DELETE" }, "deleteUser", fetchImpl);
  if (!res.ok && res.status !== 404) throw new KeycloakAdminError("deleteUser", res.status);
}

/** A reasonable initial password for flows that must mint one (not used when the contact chooses their
 *  own on the accept screen). Crypto-random, and deliberately NOT derived from anything guessable such
 *  as the email or the invite token. */
export function generateInitialPassword(): string {
  return `Ga-${randomUUID()}`;
}

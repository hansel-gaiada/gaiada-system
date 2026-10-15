// W0-3 — unit coverage for the Keycloak admin client. No DB, no network: a scripted fetch stands in
// for the realm, so these run everywhere and pin the SHAPE of every request we send.
//
// The live contract itself was verified separately against the real `gaiada` realm (see
// keycloak-admin.ts's header); what these tests hold is our half — that we send emailVerified:true,
// that a 409 is reconcilable rather than fatal, that the token is cached and single-flighted, that a
// 401 self-heals once, and that revoke DISABLES rather than deletes.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config";
import {
  createUser,
  setPassword,
  setPasswordTemporary,
  listEvents,
  getEventsConfig,
  deleteSession,
  logoutUser,
  KeycloakForbiddenError,
  disableUser,
  enableUser,
  deleteUser,
  findUserByEmail,
  keycloakAdminConfigured,
  resetKeycloakAdminTokenCache,
  KeycloakNotConfiguredError,
  KeycloakAdminError,
  KeycloakUserExistsError,
  generateInitialPassword,
} from "./keycloak-admin";

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };

/** A scripted fetch. `handlers` are matched in order by (method, url substring); the first match wins
 *  and is consumed, so a test can script "401 then 200" for the retry path. */
function fakeFetch(handlers: Array<{ method?: string; match: string; status: number; json?: unknown; headers?: Record<string, string>; text?: string }>) {
  const calls: Call[] = [];
  const remaining = [...handlers];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* form-encoded token request */ }
    } else if (body instanceof URLSearchParams) {
      body = Object.fromEntries(body.entries());
    }
    calls.push({ url, method, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const i = remaining.findIndex((h) => url.includes(h.match) && (!h.method || h.method === method));
    const h = i >= 0 ? remaining.splice(i, 1)[0] : undefined;
    if (!h) throw new Error(`fakeFetch: no handler for ${method} ${url}`);
    return {
      ok: h.status >= 200 && h.status < 300,
      status: h.status,
      headers: { get: (k: string) => h.headers?.[k.toLowerCase()] ?? null },
      json: async () => h.json ?? {},
      text: async () => h.text ?? "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const TOKEN_OK = { match: "/protocol/openid-connect/token", status: 200, json: { access_token: "tok-abc", expires_in: 300 } };
const NEW_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let saved: typeof config.keycloakAdmin;

beforeEach(() => {
  saved = { ...config.keycloakAdmin };
  config.keycloakAdmin = {
    baseUrl: "http://keycloak:8080/idp",
    realm: "gaiada",
    clientId: "gaiada-provisioner",
    clientSecret: "s3cret",
  };
  resetKeycloakAdminTokenCache();
});
afterEach(() => {
  config.keycloakAdmin = saved;
  resetKeycloakAdminTokenCache();
  vi.restoreAllMocks();
});

describe("fail-closed configuration", () => {
  it("reports unconfigured and throws a 503-shaped error naming what is missing", async () => {
    config.keycloakAdmin = { baseUrl: "", realm: "gaiada", clientId: "", clientSecret: "" };
    expect(keycloakAdminConfigured()).toBe(false);
    const { impl, calls } = fakeFetch([]);
    await expect(createUser({ email: "a@b.test" }, impl)).rejects.toBeInstanceOf(KeycloakNotConfiguredError);
    // Fail BEFORE any network attempt — a half-attempt against a phantom realm is the thing to avoid.
    expect(calls).toHaveLength(0);
    try {
      await createUser({ email: "a@b.test" }, impl);
    } catch (e) {
      const err = e as KeycloakNotConfiguredError;
      expect(err.status).toBe(503);
      expect(err.missing).toEqual(expect.arrayContaining(["KEYCLOAK_ADMIN_BASE_URL", "KEYCLOAK_ADMIN_CLIENT_ID"]));
    }
  });

  it("is configured when all four are present", () => {
    expect(keycloakAdminConfigured()).toBe(true);
  });
});

describe("createUser", () => {
  it("sends emailVerified:true — the flag the whole invite flow depends on", async () => {
    const { impl, calls } = fakeFetch([
      TOKEN_OK,
      { method: "POST", match: "/users", status: 201, headers: { location: `http://k/admin/realms/gaiada/users/${NEW_ID}` } },
    ]);
    const id = await createUser({ email: "Contact@Client.Test" }, impl);
    expect(id).toBe(NEW_ID);
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/users"))!;
    const body = create.body as Record<string, unknown>;
    // If this ever flips to false, provisionUser() throws on the contact's FIRST login.
    expect(body.emailVerified).toBe(true);
    expect(body.enabled).toBe(true);
    // Email is lower-cased and doubles as the username: one identifier, nothing to keep in sync.
    expect(body.email).toBe("contact@client.test");
    expect(body.username).toBe("contact@client.test");
  });

  it("hits the configured realm under /admin/realms and carries the bearer token", async () => {
    const { impl, calls } = fakeFetch([
      TOKEN_OK,
      { method: "POST", match: "/users", status: 201, headers: { location: `/users/${NEW_ID}` } },
    ]);
    await createUser({ email: "a@b.test" }, impl);
    const create = calls.find((c) => c.method === "POST" && c.url.includes("/users"))!;
    expect(create.url).toBe("http://keycloak:8080/idp/admin/realms/gaiada/users");
    expect(create.headers.authorization).toBe("Bearer tok-abc");
  });

  it("falls back to a lookup when Location is stripped (proxies do this)", async () => {
    const { impl } = fakeFetch([
      TOKEN_OK,
      { method: "POST", match: "/users", status: 201 }, // no location header
      { method: "GET", match: "/users?", status: 200, json: [{ id: NEW_ID, username: "a@b.test", email: "a@b.test", emailVerified: true, enabled: true }] },
    ]);
    await expect(createUser({ email: "a@b.test" }, impl)).resolves.toBe(NEW_ID);
  });

  it("turns a 409 into a RECONCILABLE error, not a fault", async () => {
    // The same person can legitimately already exist — e.g. a contact of another client in this realm.
    // The invite path adopts that account instead of dead-ending, so this must be its own type.
    const { impl } = fakeFetch([TOKEN_OK, { method: "POST", match: "/users", status: 409 }]);
    await expect(createUser({ email: "dup@b.test" }, impl)).rejects.toBeInstanceOf(KeycloakUserExistsError);
  });

  it("sets the password in the same call when one is supplied", async () => {
    const { impl, calls } = fakeFetch([
      TOKEN_OK,
      { method: "POST", match: "/users", status: 201, headers: { location: `/users/${NEW_ID}` } },
      { method: "PUT", match: "/reset-password", status: 204 },
    ]);
    await createUser({ email: "a@b.test", password: "Passw0rd!" }, impl);
    const pw = calls.find((c) => c.url.includes("/reset-password"))!;
    expect((pw.body as Record<string, unknown>).temporary).toBe(false);
    expect((pw.body as Record<string, unknown>).value).toBe("Passw0rd!");
  });

  it("surfaces an unexpected status as a 502-shaped upstream error", async () => {
    const { impl } = fakeFetch([TOKEN_OK, { method: "POST", match: "/users", status: 500, text: "boom" }]);
    await expect(createUser({ email: "a@b.test" }, impl)).rejects.toBeInstanceOf(KeycloakAdminError);
  });
});

describe("token handling", () => {
  it("mints ONE token for several operations", async () => {
    const { impl, calls } = fakeFetch([
      TOKEN_OK,
      { method: "PUT", match: "/reset-password", status: 204 },
      { method: "PUT", match: `/users/${NEW_ID}`, status: 204 },
    ]);
    await setPassword(NEW_ID, "x", impl);
    await disableUser(NEW_ID, impl);
    expect(calls.filter((c) => c.url.includes("/protocol/openid-connect/token"))).toHaveLength(1);
  });

  it("requests the token as client_credentials and never leaks the secret into an error", async () => {
    const { impl, calls } = fakeFetch([{ match: "/protocol/openid-connect/token", status: 401 }]);
    await expect(findUserByEmail("a@b.test", impl)).rejects.toMatchObject({ code: "keycloak_admin_error" });
    // The token request quotes the secret, so a token failure must not echo the body.
    try {
      await findUserByEmail("a@b.test", impl);
    } catch (e) {
      expect((e as Error).message).not.toContain("s3cret");
    }
    const tokenCall = calls[0];
    expect((tokenCall.body as Record<string, string>).grant_type).toBe("client_credentials");
  });

  it("single-flights concurrent callers into ONE token request", async () => {
    const { impl, calls } = fakeFetch([
      TOKEN_OK,
      { method: "GET", match: "/users?", status: 200, json: [] },
      { method: "GET", match: "/users?", status: 200, json: [] },
      { method: "GET", match: "/users?", status: 200, json: [] },
    ]);
    await Promise.all([findUserByEmail("a@b.test", impl), findUserByEmail("c@b.test", impl), findUserByEmail("d@b.test", impl)]);
    expect(calls.filter((c) => c.url.includes("/openid-connect/token"))).toHaveLength(1);
  });

  it("recovers from a stale token: 401 -> re-mint -> retry ONCE", async () => {
    // A realm restart or key rotation kills a cached token early. Without this a long-lived process
    // would need a redeploy to recover.
    const { impl, calls } = fakeFetch([
      TOKEN_OK,
      { method: "GET", match: "/users?", status: 401 },
      { match: "/protocol/openid-connect/token", status: 200, json: { access_token: "tok-2", expires_in: 300 } },
      { method: "GET", match: "/users?", status: 200, json: [{ id: NEW_ID, username: "a@b.test", email: "a@b.test", emailVerified: true, enabled: true }] },
    ]);
    const u = await findUserByEmail("a@b.test", impl);
    expect(u?.id).toBe(NEW_ID);
    expect(calls.filter((c) => c.url.includes("/openid-connect/token"))).toHaveLength(2);
    expect(calls.at(-1)!.headers.authorization).toBe("Bearer tok-2");
  });
});

describe("findUserByEmail", () => {
  it("uses exact=true — a prefix match would resolve the WRONG account", async () => {
    const { impl, calls } = fakeFetch([TOKEN_OK, { method: "GET", match: "/users?", status: 200, json: [] }]);
    await findUserByEmail("A@B.test", impl);
    const q = calls.find((c) => c.url.includes("/users?"))!.url;
    expect(q).toContain("exact=true");
    expect(q).toContain("email=a%40b.test"); // lower-cased
  });

  it("returns null when the realm has nobody", async () => {
    const { impl } = fakeFetch([TOKEN_OK, { method: "GET", match: "/users?", status: 200, json: [] }]);
    await expect(findUserByEmail("nope@b.test", impl)).resolves.toBeNull();
  });
});

describe("revocation", () => {
  it("DISABLES rather than deletes — the audit trail and idp_subject must survive", async () => {
    const { impl, calls } = fakeFetch([TOKEN_OK, { method: "PUT", match: `/users/${NEW_ID}`, status: 204 }]);
    await disableUser(NEW_ID, impl);
    const call = calls.find((c) => c.method === "PUT")!;
    expect((call.body as Record<string, unknown>).enabled).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("can re-enable a previously revoked contact", async () => {
    const { impl, calls } = fakeFetch([TOKEN_OK, { method: "PUT", match: `/users/${NEW_ID}`, status: 204 }]);
    await enableUser(NEW_ID, impl);
    expect((calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>).enabled).toBe(true);
  });

  it("deleteUser tolerates 404 (idempotent test cleanup)", async () => {
    const { impl } = fakeFetch([TOKEN_OK, { method: "DELETE", match: `/users/${NEW_ID}`, status: 404 }]);
    await expect(deleteUser(NEW_ID, impl)).resolves.toBeUndefined();
  });
});

describe("generateInitialPassword", () => {
  it("is random per call and not derived from anything guessable", () => {
    const a = generateInitialPassword();
    const b = generateInitialPassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("DW-7h: events, sessions and logout (BFF §52.6, §52.7)", () => {
  const eventRow = (over: Record<string, unknown> = {}) => ({
    time: 1_760_000_000_000, type: "LOGIN_ERROR", realmId: "gaiada", clientId: "gaiada-ui", userId: NEW_ID,
    ipAddress: "203.0.113.9", error: "invalid_user_credentials", sessionId: "sess-1",
    details: { username: "a@b.test", auth_method: "openid-connect" },
    ...over,
  });

  it("listEvents asks for each type, cuts the dates to a UTC day and normalises the rows", async () => {
    const { impl, calls } = fakeFetch([TOKEN_OK, { method: "GET", match: "/events?", status: 200, json: [eventRow()] }]);
    const rows = await listEvents(
      { types: ["LOGIN", "LOGIN_ERROR", "LOGOUT"], dateFrom: new Date("2026-10-14T23:59:59Z"), dateTo: "2026-10-15T08:00:00Z", max: 500 },
      impl,
    );
    const url = new URL(calls.find((c) => c.url.includes("/events?"))!.url);
    expect(url.pathname).toBe("/idp/admin/realms/gaiada/events");
    expect(url.searchParams.getAll("type")).toEqual(["LOGIN", "LOGIN_ERROR", "LOGOUT"]);
    expect(url.searchParams.get("dateFrom")).toBe("2026-10-14");
    expect(url.searchParams.get("dateTo")).toBe("2026-10-15");
    expect(url.searchParams.get("max")).toBe("500");
    expect(rows).toEqual([
      {
        time: 1_760_000_000_000, type: "LOGIN_ERROR", userId: NEW_ID, ipAddress: "203.0.113.9",
        error: "invalid_user_credentials", username: "a@b.test", sessionId: "sess-1",
      },
    ]);
  });

  it("listEvents keeps an event with no userId (an unknown username) and skips a malformed row", async () => {
    const { impl } = fakeFetch([
      TOKEN_OK,
      { method: "GET", match: "/events?", status: 200, json: [eventRow({ userId: undefined, details: { username: "ghost@x.test" } }), { type: "LOGIN" }, "junk"] },
    ]);
    const rows = await listEvents({ types: ["LOGIN_ERROR"] }, impl);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    expect(rows[0].username).toBe("ghost@x.test");
  });

  it("🔴 a 403 on events is a typed missing-role error naming view-events, not a generic failure", async () => {
    const { impl } = fakeFetch([TOKEN_OK, { method: "GET", match: "/events?", status: 403 }]);
    const err = await listEvents({ types: ["LOGIN"] }, impl).catch((e) => e);
    expect(err).toBeInstanceOf(KeycloakForbiddenError);
    expect(err).toBeInstanceOf(KeycloakAdminError);
    expect((err as KeycloakForbiddenError).missingRole).toBe("view-events");
  });

  it("any other events failure is a plain KeycloakAdminError", async () => {
    const { impl } = fakeFetch([TOKEN_OK, { method: "GET", match: "/events?", status: 500 }]);
    const err = await listEvents({ types: ["LOGIN"] }, impl).catch((e) => e);
    expect(err).toBeInstanceOf(KeycloakAdminError);
    expect(err).not.toBeInstanceOf(KeycloakForbiddenError);
  });

  it("getEventsConfig tells events OFF from an empty list, and 403 is typed", async () => {
    const off = fakeFetch([TOKEN_OK, { method: "GET", match: "/events/config", status: 200, json: { eventsEnabled: false } }]);
    expect(await getEventsConfig(off.impl)).toEqual({ eventsEnabled: false, enabledEventTypes: [] });
    resetKeycloakAdminTokenCache();
    const on = fakeFetch([
      TOKEN_OK,
      { method: "GET", match: "/events/config", status: 200, json: { eventsEnabled: true, enabledEventTypes: ["LOGIN", 7] } },
    ]);
    expect(await getEventsConfig(on.impl)).toEqual({ eventsEnabled: true, enabledEventTypes: ["LOGIN"] });
    resetKeycloakAdminTokenCache();
    const denied = fakeFetch([TOKEN_OK, { method: "GET", match: "/events/config", status: 403 }]);
    await expect(getEventsConfig(denied.impl)).rejects.toBeInstanceOf(KeycloakForbiddenError);
  });

  it("deleteSession answers ended for 204 and not_found for 404, and throws on anything else", async () => {
    const a = fakeFetch([TOKEN_OK, { method: "DELETE", match: "/sessions/sess%2F1", status: 204 }]);
    expect(await deleteSession("sess/1", a.impl)).toBe("ended");
    expect(a.calls.find((c) => c.method === "DELETE")!.url).toBe("http://keycloak:8080/idp/admin/realms/gaiada/sessions/sess%2F1");
    resetKeycloakAdminTokenCache();
    const b = fakeFetch([TOKEN_OK, { method: "DELETE", match: "/sessions/s2", status: 404 }]);
    expect(await deleteSession("s2", b.impl)).toBe("not_found");
    resetKeycloakAdminTokenCache();
    const c = fakeFetch([TOKEN_OK, { method: "DELETE", match: "/sessions/s3", status: 500 }]);
    await expect(deleteSession("s3", c.impl)).rejects.toBeInstanceOf(KeycloakAdminError);
    resetKeycloakAdminTokenCache();
    const d = fakeFetch([TOKEN_OK, { method: "DELETE", match: "/sessions/s4", status: 403 }]);
    await expect(deleteSession("s4", d.impl)).rejects.toBeInstanceOf(KeycloakForbiddenError);
  });

  it("logoutUser POSTs to the user's logout endpoint and throws when it fails", async () => {
    const ok = fakeFetch([TOKEN_OK, { method: "POST", match: `/users/${NEW_ID}/logout`, status: 204 }]);
    await expect(logoutUser(NEW_ID, ok.impl)).resolves.toBeUndefined();
    expect(ok.calls.some((c) => c.method === "POST" && c.url.endsWith(`/users/${NEW_ID}/logout`))).toBe(true);
    resetKeycloakAdminTokenCache();
    const bad = fakeFetch([TOKEN_OK, { method: "POST", match: "/logout", status: 502 }]);
    await expect(logoutUser(NEW_ID, bad.impl)).rejects.toBeInstanceOf(KeycloakAdminError);
  });

  it("setPasswordTemporary sends temporary:true and setPassword temporary:false", async () => {
    const t = fakeFetch([TOKEN_OK, { method: "PUT", match: "/reset-password", status: 204 }]);
    await setPasswordTemporary(NEW_ID, "pw", t.impl);
    expect((t.calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>).temporary).toBe(true);
    resetKeycloakAdminTokenCache();
    const p = fakeFetch([TOKEN_OK, { method: "PUT", match: "/reset-password", status: 204 }]);
    await setPassword(NEW_ID, "pw", p.impl);
    expect((p.calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>).temporary).toBe(false);
  });
});

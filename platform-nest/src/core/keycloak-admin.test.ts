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

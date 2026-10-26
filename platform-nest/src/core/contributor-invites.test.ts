// M5-W1d — the contributor invite token and the Keycloak calls it needs, with no database and no network.
//
// (1) THE SIBLING BOUNDARY, in all three directions the header of contributor-invites.ts claims: a client token is refused
//     by the contributor parser, a contributor token by the client parser, and a contributor token re-spelled with the
//     client's prefix still fails (the two HMAC keys are domain-separated). Plus the PGL-10 strength properties: a fresh
//     nonce per mint, a tampered tenant or nonce fails, only the canonical spelling verifies.
// (2) The Keycloak client: `createUser` sends the contributor's group and OTP required action in the one POST (and every
//     other caller's request is byte-identical to before); `addUserToGroup` refuses a missing group; `addRequiredAction`
//     keeps the actions an account already has.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "../config";
import {
  ContributorInviteError, hashContributorToken, parseContributorInviteToken, signContributorInviteToken,
} from "./contributor-invites";
import { ClientInviteError, parseInviteToken, signInviteToken } from "./client-invites";
import {
  addRequiredAction, addUserToGroup, createUser, KeycloakGroupMissingError, resetKeycloakAdminTokenCache,
} from "./keycloak-admin";

const INVITE = "11111111-2222-4333-8444-555555555555";
const TENANT = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

let savedKey: string;
beforeEach(() => {
  savedKey = config.integrationTokenKey;
  config.integrationTokenKey = Buffer.alloc(32, 3).toString("base64");
});
afterEach(() => {
  config.integrationTokenKey = savedKey;
});

const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { reason?: string }).reason ?? (e as Error).name;
  }
  return "no error";
};

describe("M5-W1d · the contributor invite token", () => {
  it("round-trips, and every mint draws a fresh nonce (two links for one invite differ)", () => {
    const t1 = signContributorInviteToken(INVITE, TENANT);
    const t2 = signContributorInviteToken(INVITE, TENANT);
    expect(t1).toMatch(/^ctr1\./);
    expect(t1).not.toBe(t2);
    expect(parseContributorInviteToken(t1)).toEqual({ inviteId: INVITE, tenantId: TENANT });
    expect(hashContributorToken(t1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a CLIENT token is refused by the contributor parser, before any database read", () => {
    const client = signInviteToken(INVITE, TENANT);
    expect(() => parseContributorInviteToken(client)).toThrow(ContributorInviteError);
    expect(reason(() => parseContributorInviteToken(client))).toBe("malformed_token");
  });

  it("a CONTRIBUTOR token is refused by the client parser", () => {
    const contributor = signContributorInviteToken(INVITE, TENANT);
    expect(() => parseInviteToken(contributor)).toThrow(ClientInviteError);
  });

  it("re-spelled with the other family's prefix, each still fails its signature (the keys are domain-separated)", () => {
    const contributor = signContributorInviteToken(INVITE, TENANT);
    const asClient = `inv2.${contributor.split(".").slice(1).join(".")}`;
    expect(reason(() => parseInviteToken(asClient))).toBe("bad_signature");
    const client = signInviteToken(INVITE, TENANT);
    const asContributor = `ctr1.${client.split(".").slice(1).join(".")}`;
    expect(reason(() => parseContributorInviteToken(asContributor))).toBe("bad_signature");
  });

  it("a tampered tenant, a tampered nonce, a short nonce or a bad signature is refused", () => {
    const t = signContributorInviteToken(INVITE, TENANT).split(".");
    const tenant = [...t];
    tenant[2] = Buffer.from(OTHER_TENANT, "utf8").toString("base64url");
    expect(reason(() => parseContributorInviteToken(tenant.join(".")))).toBe("bad_signature");
    const nonce = [...t];
    nonce[3] = Buffer.alloc(16, 1).toString("base64url");
    expect(reason(() => parseContributorInviteToken(nonce.join(".")))).toBe("bad_signature");
    const short = [...t];
    short[3] = Buffer.alloc(8, 1).toString("base64url");
    expect(reason(() => parseContributorInviteToken(short.join(".")))).toBe("malformed_token");
    const sig = [...t];
    sig[4] = Buffer.alloc(32, 0).toString("base64url");
    expect(reason(() => parseContributorInviteToken(sig.join(".")))).toBe("bad_signature");
    expect(reason(() => parseContributorInviteToken(""))).toBe("malformed_token");
    expect(reason(() => parseContributorInviteToken("ctr1.a.b.c"))).toBe("malformed_token");
  });

  it("without the signing key the family is NOT CONFIGURED (503), never a guessable default", () => {
    config.integrationTokenKey = "";
    const e = (() => {
      try {
        signContributorInviteToken(INVITE, TENANT);
      } catch (err) {
        return err as ContributorInviteError;
      }
      return null;
    })();
    expect(e?.reason).toBe("not_configured");
    expect(e?.status).toBe(503);
  });
});

// ── the Keycloak additions ───────────────────────────────────────────────────────────────────────────────────────────
type Call = { url: string; method: string; body: unknown };
function fakeFetch(handlers: Array<{ method?: string; match: string; status: number; json?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const remaining = [...handlers];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* form body */ }
    }
    calls.push({ url, method, body });
    const i = remaining.findIndex((h) => url.includes(h.match) && (!h.method || h.method === method));
    const h = i >= 0 ? remaining.splice(i, 1)[0] : undefined;
    if (!h) throw new Error(`fakeFetch: no handler for ${method} ${url}`);
    return {
      ok: h.status >= 200 && h.status < 300, status: h.status,
      headers: { get: (k: string) => h.headers?.[k.toLowerCase()] ?? null },
      json: async () => h.json ?? {}, text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const TOKEN_OK = { match: "/protocol/openid-connect/token", status: 200, json: { access_token: "tok", expires_in: 300 } };
const KC_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("M5-W1d · Keycloak: the contributor group and OTP", () => {
  let saved: typeof config.keycloakAdmin;
  beforeEach(() => {
    saved = { ...config.keycloakAdmin };
    config.keycloakAdmin = { baseUrl: "http://keycloak.test/idp", realm: "gaiada", clientId: "gaiada-provisioner", clientSecret: "s" };
    resetKeycloakAdminTokenCache();
  });
  afterEach(() => {
    config.keycloakAdmin = saved;
    resetKeycloakAdminTokenCache();
  });

  it("createUser sends the group PATH and the OTP required action in the one POST", async () => {
    const { impl, calls } = fakeFetch([
      TOKEN_OK,
      { method: "POST", match: "/admin/realms/gaiada/users", status: 201, headers: { location: `http://keycloak.test/idp/admin/realms/gaiada/users/${KC_ID}` } },
      { method: "PUT", match: `/users/${KC_ID}/reset-password`, status: 204 },
    ]);
    await createUser({ email: "w@w1d.test", password: "pw-long-enough", groups: ["contributors"], requiredActions: ["CONFIGURE_TOTP"] }, impl);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/users"))!;
    expect(post.body).toMatchObject({ email: "w@w1d.test", emailVerified: true, enabled: true, groups: ["/contributors"], requiredActions: ["CONFIGURE_TOTP"] });
  });

  it("every other caller's createUser body is unchanged (no groups, no requiredActions keys)", async () => {
    const { impl, calls } = fakeFetch([
      TOKEN_OK,
      { method: "POST", match: "/admin/realms/gaiada/users", status: 201, headers: { location: `http://keycloak.test/idp/admin/realms/gaiada/users/${KC_ID}` } },
    ]);
    await createUser({ email: "c@w1d.test" }, impl);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/users"))!;
    expect(Object.keys(post.body as object).sort()).toEqual(["email", "emailVerified", "enabled", "username"]);
  });

  it("addUserToGroup finds the group by exact name and PUTs the membership; a missing group FAILS (no silent skip)", async () => {
    const ok = fakeFetch([
      TOKEN_OK,
      { method: "GET", match: "/groups?search=contributors&exact=true", status: 200, json: [{ id: "g-1", name: "contributors", path: "/contributors" }] },
      { method: "PUT", match: `/users/${KC_ID}/groups/g-1`, status: 204 },
    ]);
    await addUserToGroup(KC_ID, "contributors", ok.impl);
    expect(ok.calls.map((c) => `${c.method} ${c.url.replace("http://keycloak.test/idp", "")}`)).toContain(`PUT /admin/realms/gaiada/users/${KC_ID}/groups/g-1`);
    resetKeycloakAdminTokenCache();
    const missing = fakeFetch([TOKEN_OK, { method: "GET", match: "/groups?", status: 200, json: [{ id: "g-2", name: "contributors-old" }] }]);
    await expect(addUserToGroup(KC_ID, "contributors", missing.impl)).rejects.toBeInstanceOf(KeycloakGroupMissingError);
  });

  it("addRequiredAction keeps the actions the account already has, and is a no-op when it is already there", async () => {
    const add = fakeFetch([
      TOKEN_OK,
      { method: "GET", match: `/users/${KC_ID}`, status: 200, json: { requiredActions: ["VERIFY_EMAIL"] } },
      { method: "PUT", match: `/users/${KC_ID}`, status: 204 },
    ]);
    await addRequiredAction(KC_ID, "CONFIGURE_TOTP", add.impl);
    expect(add.calls.find((c) => c.method === "PUT")?.body).toEqual({ requiredActions: ["VERIFY_EMAIL", "CONFIGURE_TOTP"] });
    resetKeycloakAdminTokenCache();
    const noop = fakeFetch([TOKEN_OK, { method: "GET", match: `/users/${KC_ID}`, status: 200, json: { requiredActions: ["CONFIGURE_TOTP"] } }]);
    await addRequiredAction(KC_ID, "CONFIGURE_TOTP", noop.impl);
    expect(noop.calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

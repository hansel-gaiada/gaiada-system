// DW-6i (docs/FRONTEND-BFF-CONTRACT.md §42.7, "Unit") — the parts of Google Drive that need no database: the five settings and the
// not-configured answers, the surface's registration, the signed state round trip, the 5-minute refresh window, and the shared
// token client's new "a surface's own OAuth client" parameter against a fake `fetch` (Google's documented token response shape,
// https://developers.google.com/identity/protocols/oauth2/web-server and .../openid-connect/openid-connect).
// The HTTP suite (google-drive.http.test.ts) drives the same code over the wire against Postgres and Cerbos.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { config, googleDriveConfigured } from "../../config";
import { googleSurfaceFor } from "../google-oauth/registry";
import { parseStateToken, signStateToken } from "../google-oauth/state";
import { buildAuthorizeUrl, exchangeAuthorizationCode, refreshAccessToken, revokeToken } from "../google-oauth/token-endpoint-client";
import { GoogleOAuthNotConfiguredError, GoogleOAuthStateError } from "../google-oauth/errors";
import "./surface";
import { DRIVE_FILE_SCOPE, DRIVE_SCOPES } from "./surface";
import { REFRESH_WITHIN_MS, driveError, needsRefresh, pickerAnswer, startConnect } from "./service";

const saved = { ...config.googleDrive };
const savedKey = config.integrationTokenKey;
const FULL = {
  clientId: "drive-client.apps.googleusercontent.com", clientSecret: "GOCSPX-drive-secret-0001",
  redirectUri: "https://erp.example.test/api/google-drive/callback", pickerApiKey: "AIza-picker-key", pickerAppId: "1234567890",
};
beforeEach(() => { config.integrationTokenKey = randomBytes(32).toString("base64"); });
afterEach(() => { Object.assign(config.googleDrive, saved); config.integrationTokenKey = savedKey; });

describe("the five settings (§42.2)", () => {
  it("has no default for any of them", () => {
    // Every value is exactly its environment variable, or the empty string: nothing is invented.
    expect(Object.keys(config.googleDrive).sort()).toEqual(["clientId", "clientSecret", "pickerApiKey", "pickerAppId", "redirectUri"]);
    expect(saved).toEqual({
      clientId: process.env.GOOGLE_DRIVE_CLIENT_ID ?? "", clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "",
      redirectUri: process.env.GOOGLE_DRIVE_REDIRECT_URI ?? "", pickerApiKey: process.env.GOOGLE_PICKER_API_KEY ?? "",
      pickerAppId: process.env.GOOGLE_PICKER_APP_ID ?? "",
    });
  });
  it("is configured only when ALL FIVE are set; each one missing alone turns it off", () => {
    Object.assign(config.googleDrive, FULL);
    expect(googleDriveConfigured()).toBe(true);
    for (const key of Object.keys(FULL) as Array<keyof typeof FULL>) {
      Object.assign(config.googleDrive, FULL, { [key]: "" });
      expect(googleDriveConfigured(), `without ${key}`).toBe(false);
    }
  });
  it("search's client settings are a different block: setting Drive's changes nothing there", () => {
    const before = { ...config.google };
    Object.assign(config.googleDrive, FULL);
    expect(config.google).toEqual(before);
    expect(config.google.clientId).not.toBe(FULL.clientId);
  });
});

describe("not configured (§42.4: no default is ever invented)", () => {
  beforeEach(() => { Object.assign(config.googleDrive, { clientId: "", clientSecret: "", redirectUri: "", pickerApiKey: "", pickerAppId: "" }); });

  it("the Picker read answers configured:false with no token and no key, before touching any database", async () => {
    expect(await pickerAnswer("00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002")).toEqual({
      configured: false, connected: false, needsReconnect: false, accountEmail: null, accessToken: null, expiresAt: null, apiKey: null, appId: null,
    });
  });
  it("start refuses with the token drive_not_configured (503), before any write", async () => {
    const e = await startConnect("00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002").then(() => null, (x) => x);
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toMatchObject({ reason: "drive_not_configured" });
    expect((e.getResponse() as { message: string }).message.startsWith("drive_not_configured:")).toBe(true);
  });
  it("one of the five unset is enough to refuse (the Picker key is not optional)", async () => {
    Object.assign(config.googleDrive, FULL, { pickerAppId: "" });
    const e = await startConnect("00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002").then(() => null, (x) => x);
    expect(e.getResponse()).toMatchObject({ reason: "drive_not_configured" });
  });
});

describe("driveError", () => {
  it("puts the token at the START of the message and repeats it in `reason`", () => {
    const e = driveError(409, "drive_already_attached", "this Google Drive file is already attached to this task.");
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({ message: "drive_already_attached: this Google Drive file is already attached to this task.", reason: "drive_already_attached" });
  });
});

describe("the surface (§42.3)", () => {
  it("registers google_drive as a core, user-owned surface with exactly drive.file + openid + email", () => {
    const s = googleSurfaceFor("google_drive");
    expect(s).not.toBeNull();
    expect(s).toMatchObject({ provider: "google_drive", module: null, ownerKind: "user" });
    expect(s!.scopes).toEqual(["https://www.googleapis.com/auth/drive.file", "openid", "email"]);
    expect(DRIVE_SCOPES).toEqual(s!.scopes);
    expect(DRIVE_FILE_SCOPE).toBe("https://www.googleapis.com/auth/drive.file");
  });
  it("its authz is what the My-connections self-service rows send: integration_connection · create", () => {
    expect(googleSurfaceFor("google_drive")!.authz).toEqual({ kind: "integration_connection", action: "create" });
  });
  it("asks for no Drive scope wider than drive.file (a restricted scope would put the app under Google's security assessment)", () => {
    for (const s of googleSurfaceFor("google_drive")!.scopes) {
      if (s.includes("/auth/drive")) expect(s).toBe("https://www.googleapis.com/auth/drive.file");
    }
  });
});

describe("the signed state (§42.7: the state round trip)", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  it("round-trips the state id and the tenant, and the tenant comes out of the signature, not out of anything the caller adds", () => {
    const token = signStateToken("22222222-2222-4222-8222-222222222222", T);
    expect(parseStateToken(token)).toEqual({ stateId: "22222222-2222-4222-8222-222222222222", tenantId: T });
  });
  it("refuses a token whose tenant was swapped, or whose signature was cut, or that is not ours", () => {
    const [p, s, , sig] = signStateToken("22222222-2222-4222-8222-222222222222", T).split(".");
    const otherTenant = Buffer.from("33333333-3333-4333-8333-333333333333").toString("base64url");
    for (const bad of [`${p}.${s}.${otherTenant}.${sig}`, `${p}.${s}.${otherTenant}`, "gs1.a.b.c", "junk", ""]) {
      expect(() => parseStateToken(bad), bad).toThrow(GoogleOAuthStateError);
    }
  });
  it("is signed with the vault key: with none set, it fails closed", () => {
    config.integrationTokenKey = "";
    expect(() => signStateToken("22222222-2222-4222-8222-222222222222", T)).toThrow(GoogleOAuthNotConfiguredError);
  });
});

describe("the 5-minute refresh window (§42.4)", () => {
  const NOW = Date.parse("2026-10-14T10:00:00Z");
  it("refreshes at and inside five minutes, not outside; no recorded expiry means nothing to pre-empt", () => {
    expect(REFRESH_WITHIN_MS).toBe(300_000);
    expect(needsRefresh(new Date(NOW + 299_000).toISOString(), NOW)).toBe(true);
    expect(needsRefresh(new Date(NOW + 300_000).toISOString(), NOW)).toBe(true);
    expect(needsRefresh(new Date(NOW + 301_000).toISOString(), NOW)).toBe(false);
    expect(needsRefresh(new Date(NOW - 1_000).toISOString(), NOW)).toBe(true);
    expect(needsRefresh(null, NOW)).toBe(false);
  });
});

describe("the shared token client with a surface's OWN OAuth client (DW-6i)", () => {
  const DRIVE = { clientId: "drive-client.apps.googleusercontent.com", clientSecret: "GOCSPX-drive-secret-0001" };
  const TOKEN_BODY = {
    access_token: "ya29.ACCESS-1", expires_in: 3599, refresh_token: "1//REFRESH-1", token_type: "Bearer",
    scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file", id_token: "h.p.s",
  };
  function stub(status = 200, body: unknown = TOKEN_BODY) {
    const calls: Array<{ url: string; form: URLSearchParams }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), form: new URLSearchParams(String(init?.body ?? "")) });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { f, calls };
  }

  it("exchange sends the Drive client's id and secret (not search's) and surfaces the ID token", async () => {
    const { f, calls } = stub();
    const t = await exchangeAuthorizationCode({ code: "4/0AX", codeVerifier: "v".repeat(43), redirectUri: FULL.redirectUri, client: DRIVE }, f);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(config.google.tokenUrl);
    expect(Object.fromEntries(calls[0].form)).toEqual({
      grant_type: "authorization_code", code: "4/0AX", redirect_uri: FULL.redirectUri, code_verifier: "v".repeat(43),
      client_id: DRIVE.clientId, client_secret: DRIVE.clientSecret,
    });
    expect(t).toMatchObject({ accessToken: "ya29.ACCESS-1", refreshToken: "1//REFRESH-1", idToken: "h.p.s", tokenType: "Bearer" });
    expect(t.scope).toContain("drive.file");
    expect(typeof t.expiresAt).toBe("string");
  });
  it("refresh sends the Drive client's credentials; an answer with no id_token reads as idToken null", async () => {
    const { f, calls } = stub(200, { access_token: "ya29.ACCESS-2", expires_in: 3599, scope: "x", token_type: "Bearer" });
    const t = await refreshAccessToken("1//REFRESH-1", f, DRIVE);
    expect(Object.fromEntries(calls[0].form)).toEqual({
      grant_type: "refresh_token", refresh_token: "1//REFRESH-1", client_id: DRIVE.clientId, client_secret: DRIVE.clientSecret,
    });
    expect(t).toMatchObject({ accessToken: "ya29.ACCESS-2", refreshToken: null, idToken: null });
  });
  it("revoke to Google's own endpoint sends the bare `token=` body Google documents, with no client credentials", async () => {
    const { f, calls } = stub(200, {});
    expect(await revokeToken("1//REFRESH-1", f, DRIVE)).toEqual({ revoked: true, status: 200 });
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/revoke");
    expect(Object.fromEntries(calls[0].form)).toEqual({ token: "1//REFRESH-1" });
  });
  it("the authorize URL carries the Drive client id, access_type=offline, prompt=consent, PKCE S256 and the three scopes", () => {
    const url = new URL(buildAuthorizeUrl({
      scopes: DRIVE_SCOPES, state: "gs1.x.y.z", codeChallenge: "c".repeat(43), redirectUri: FULL.redirectUri, client: DRIVE,
    }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("client_id")).toBe(DRIVE.clientId);
    expect(q.get("redirect_uri")).toBe(FULL.redirectUri);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe(`${DRIVE_FILE_SCOPE} openid email`);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")).toBe("gs1.x.y.z");
    expect(url.toString()).not.toContain(DRIVE.clientSecret);
  });
  it("an incomplete Drive client is refused as not configured, never silently replaced by search's", async () => {
    const { f, calls } = stub();
    await expect(exchangeAuthorizationCode({ code: "c", codeVerifier: "v", redirectUri: "r", client: { clientId: "", clientSecret: "s" } }, f))
      .rejects.toBeInstanceOf(GoogleOAuthNotConfiguredError);
    expect(calls).toEqual([]);
  });
  it("with NO client given it still reads search's settings, exactly as before (a regression guard for search's flow)", async () => {
    const savedG = { clientId: config.google.clientId, clientSecret: config.google.clientSecret };
    config.google.clientId = "search-client-id"; config.google.clientSecret = "search-client-secret";
    try {
      const { f, calls } = stub();
      await exchangeAuthorizationCode({ code: "c", codeVerifier: "v", redirectUri: "r" }, f);
      expect(calls[0].form.get("client_id")).toBe("search-client-id");
      expect(calls[0].form.get("client_secret")).toBe("search-client-secret");
    } finally { Object.assign(config.google, savedG); }
  });
  it("an error from the token endpoint carries no secret, no code and no body", async () => {
    const { f } = stub(400, { error: "invalid_grant", error_description: "Bad Request ya29.LEAK 1//LEAK" });
    const e = await exchangeAuthorizationCode({ code: "4/0AX-SECRET-CODE", codeVerifier: "v", redirectUri: "r", client: DRIVE }, f).then(() => null, (x) => x);
    const dump = `${e.message} ${JSON.stringify(e)}`;
    for (const s of ["LEAK", "4/0AX-SECRET-CODE", DRIVE.clientSecret]) expect(dump).not.toContain(s);
    expect(e).toMatchObject({ status: 502, code: "google_token_endpoint_error", detail: { operation: "exchange", httpStatus: 400, oauthError: "invalid_grant" } });
  });
});

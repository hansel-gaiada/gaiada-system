// SMM-38 phase 38c — the LinkedIn wire client's own unit tests: token exchange/refresh request
// shape, error mapping, and `hasLinkedInAppCredentials`. Every case drives a stub `fetchImpl` —
// no live LinkedIn app credential exists (D-23), and this suite never opens a real socket.
// direct.test.ts covers the org-page publish / media upload / comment-read normalizers through the
// `direct` driver's own methods; this file covers the token endpoint specifically, which the
// driver never touches directly.
import { describe, it, expect, afterEach } from "vitest";
import { config } from "../../../config";
import { SocialPublisherError } from "./types";
import {
  exchangeAuthorizationCode, refreshWithRefreshToken, hasLinkedInAppCredentials, linkedInAppCredentials,
} from "./linkedin-client";

const originalClientId = config.social.direct.linkedin.clientId;
const originalClientSecret = config.social.direct.linkedin.clientSecret;

afterEach(() => {
  config.social.direct.linkedin.clientId = originalClientId;
  config.social.direct.linkedin.clientSecret = originalClientSecret;
});

describe("SMM-38c · hasLinkedInAppCredentials / linkedInAppCredentials", () => {
  it("is false when either half of the pair is empty", () => {
    config.social.direct.linkedin.clientId = "";
    config.social.direct.linkedin.clientSecret = "a-secret";
    expect(hasLinkedInAppCredentials()).toBe(false);
    config.social.direct.linkedin.clientId = "an-id";
    config.social.direct.linkedin.clientSecret = "";
    expect(hasLinkedInAppCredentials()).toBe(false);
  });

  it("is true only when both halves are present", () => {
    config.social.direct.linkedin.clientId = "an-id";
    config.social.direct.linkedin.clientSecret = "a-secret";
    expect(hasLinkedInAppCredentials()).toBe(true);
    expect(linkedInAppCredentials()).toEqual({ clientId: "an-id", clientSecret: "a-secret" });
  });
});

describe("SMM-38c · exchangeAuthorizationCode — the authorization-code exchange", () => {
  it("posts form-encoded, never JSON, with the app's own client id/secret and grant_type=authorization_code", async () => {
    config.social.direct.linkedin.clientId = "client-1";
    config.social.direct.linkedin.clientSecret = "secret-1";
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(config.social.direct.linkedin.tokenUrl);
      expect(init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("the-code");
      expect(body.get("redirect_uri")).toBe("https://erp.example.test/callback");
      expect(body.get("client_id")).toBe("client-1");
      expect(body.get("client_secret")).toBe("secret-1");
      return new Response(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "w_organization_social" }), { status: 200 });
    }) as unknown as typeof fetch;
    const tokens = await exchangeAuthorizationCode({ code: "the-code", redirectUri: "https://erp.example.test/callback" }, { fetchImpl });
    expect(tokens).toEqual({
      accessToken: "at-1", refreshToken: "rt-1", expiresInSeconds: 3600,
      refreshTokenExpiresInSeconds: undefined, scope: "w_organization_social",
    });
  });

  it("refuses publisher_unreachable on a transport failure — typed, never a crash", async () => {
    const fetchImpl = (async () => { throw new Error("dns failure"); }) as unknown as typeof fetch;
    await expect(exchangeAuthorizationCode({ code: "x", redirectUri: "https://x" }, { fetchImpl }))
      .rejects.toMatchObject({ code: "publisher_unreachable" });
  });

  it("refuses publisher_http_error on a non-2xx, carrying LinkedIn's own error name in the message " +
     "but never the raw body verbatim", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "the code has already been used" }), { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeAuthorizationCode({ code: "x", redirectUri: "https://x" }, { fetchImpl }))
      .rejects.toMatchObject({ code: "publisher_http_error", upstreamStatus: 400 });
    try {
      await exchangeAuthorizationCode({ code: "x", redirectUri: "https://x" }, { fetchImpl });
    } catch (err) {
      expect((err as SocialPublisherError).message).toContain("invalid_grant");
      expect((err as SocialPublisherError).message).not.toContain("already been used");
    }
  });

  it("refuses publisher_http_error when the token endpoint returns 200 with no access_token", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await expect(exchangeAuthorizationCode({ code: "x", redirectUri: "https://x" }, { fetchImpl }))
      .rejects.toMatchObject({ code: "publisher_http_error" });
  });
});

describe("SMM-38c · refreshWithRefreshToken — the function registered as LinkedIn's refresher", () => {
  it("posts grant_type=refresh_token with the SAME app credentials, never re-embedding the old access token", async () => {
    config.social.direct.linkedin.clientId = "client-2";
    config.social.direct.linkedin.clientSecret = "secret-2";
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh-token");
      expect(body.get("client_id")).toBe("client-2");
      expect([...body.keys()]).not.toContain("access_token");
      return new Response(JSON.stringify({ access_token: "at-new", expires_in: 1800 }), { status: 200 });
    }) as unknown as typeof fetch;
    const tokens = await refreshWithRefreshToken("old-refresh-token", { fetchImpl });
    expect(tokens.accessToken).toBe("at-new");
    expect(tokens.refreshToken).toBeUndefined();
  });
});

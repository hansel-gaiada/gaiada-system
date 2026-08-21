// SMM-38 phase 38d — the YouTube wire client's own unit tests: token exchange/refresh request
// shape, error mapping, `hasYouTubeAppCredentials`, and the resumable-upload/comment-read wire
// mechanics. Every case drives a stub `fetchImpl` — no live YouTube app credential exists (D-23),
// and this suite never opens a real socket. `direct.test.ts` covers these through the `direct`
// driver's own methods (including quota accounting); this file covers the wire client specifically,
// mirroring `linkedin-client.test.ts`'s own split.
import { describe, it, expect, afterEach } from "vitest";
import { config } from "../../../config";
import { SocialPublisherError } from "./types";
import {
  exchangeAuthorizationCode, refreshWithRefreshToken, hasYouTubeAppCredentials, youTubeAppCredentials,
  initiateResumableUpload, uploadVideoBytes, listVideoCommentThreads, normalizeCommentThreads,
} from "./youtube-client";

const originalClientId = config.social.direct.youtube.clientId;
const originalClientSecret = config.social.direct.youtube.clientSecret;

afterEach(() => {
  config.social.direct.youtube.clientId = originalClientId;
  config.social.direct.youtube.clientSecret = originalClientSecret;
});

describe("SMM-38d · hasYouTubeAppCredentials / youTubeAppCredentials", () => {
  it("is false when either half of the pair is empty", () => {
    config.social.direct.youtube.clientId = "";
    config.social.direct.youtube.clientSecret = "a-secret";
    expect(hasYouTubeAppCredentials()).toBe(false);
    config.social.direct.youtube.clientId = "an-id";
    config.social.direct.youtube.clientSecret = "";
    expect(hasYouTubeAppCredentials()).toBe(false);
  });

  it("is true only when both halves are present", () => {
    config.social.direct.youtube.clientId = "an-id";
    config.social.direct.youtube.clientSecret = "a-secret";
    expect(hasYouTubeAppCredentials()).toBe(true);
    expect(youTubeAppCredentials()).toEqual({ clientId: "an-id", clientSecret: "a-secret" });
  });
});

describe("SMM-38d · exchangeAuthorizationCode — the authorization-code exchange", () => {
  it("posts form-encoded, never JSON, with the app's own client id/secret and grant_type=authorization_code, no PKCE fields", async () => {
    config.social.direct.youtube.clientId = "client-1";
    config.social.direct.youtube.clientSecret = "secret-1";
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(config.social.direct.youtube.tokenUrl);
      expect(init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("the-code");
      expect(body.get("redirect_uri")).toBe("https://erp.example.test/callback");
      expect(body.get("client_id")).toBe("client-1");
      expect(body.get("client_secret")).toBe("secret-1");
      expect(body.get("code_verifier")).toBeNull();
      return new Response(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.upload" }), { status: 200 });
    }) as unknown as typeof fetch;
    const tokens = await exchangeAuthorizationCode({ code: "the-code", redirectUri: "https://erp.example.test/callback" }, { fetchImpl });
    expect(tokens).toEqual({
      accessToken: "at-1", refreshToken: "rt-1", expiresInSeconds: 3600,
      refreshTokenExpiresInSeconds: undefined, scope: "https://www.googleapis.com/auth/youtube.upload",
    });
  });

  it("refuses publisher_unreachable on a transport failure — typed, never a crash", async () => {
    const fetchImpl = (async () => { throw new Error("dns failure"); }) as unknown as typeof fetch;
    await expect(exchangeAuthorizationCode({ code: "x", redirectUri: "https://x" }, { fetchImpl }))
      .rejects.toMatchObject({ code: "publisher_unreachable" });
  });

  it("refuses publisher_http_error on a non-2xx, carrying Google's own error name in the message " +
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

describe("SMM-38d · refreshWithRefreshToken — the function registered as YouTube's refresher", () => {
  it("posts grant_type=refresh_token with the SAME app credentials, never re-embedding the old access token", async () => {
    config.social.direct.youtube.clientId = "client-2";
    config.social.direct.youtube.clientSecret = "secret-2";
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

describe("SMM-38d · initiateResumableUpload — step 1 of the resumable-upload protocol", () => {
  it("POSTs metadata with the X-Upload-Content-* headers and returns the Location header as uploadUrl", async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain("uploadType=resumable&part=snippet,status");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer at-1",
        "X-Upload-Content-Length": "12345",
        "X-Upload-Content-Type": "video/mp4",
      });
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ snippet: { title: "t", description: "" }, status: { privacyStatus: "private" } });
      return new Response("", { status: 200, headers: { Location: "https://upload.example/session" } });
    }) as unknown as typeof fetch;
    const res = await initiateResumableUpload("at-1", { title: "t" }, 12345, "video/mp4", { fetchImpl });
    expect(res).toEqual({ uploadUrl: "https://upload.example/session" });
  });

  it("refuses publisher_http_error when accepted but no Location header is present — ambiguous, never guessed", async () => {
    const fetchImpl = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    await expect(initiateResumableUpload("at-1", { title: "t" }, 1, "video/mp4", { fetchImpl }))
      .rejects.toMatchObject({ code: "publisher_http_error" });
  });

  it("refuses publisher_unreachable on a transport failure", async () => {
    const fetchImpl = (async () => { throw new Error("dns failure"); }) as unknown as typeof fetch;
    await expect(initiateResumableUpload("at-1", { title: "t" }, 1, "video/mp4", { fetchImpl }))
      .rejects.toMatchObject({ code: "publisher_unreachable" });
  });
});

describe("SMM-38d · uploadVideoBytes — step 2, a single complete-body PUT (no Content-Range)", () => {
  it("PUTs the bytes and returns the created video's id", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://upload.example/session");
      expect(init?.method).toBe("PUT");
      expect(init?.headers).toMatchObject({ "Content-Type": "video/mp4", "Content-Length": "3" });
      expect(Object.keys(init?.headers as Record<string, string>).map((k) => k.toLowerCase())).not.toContain("content-range");
      return new Response(JSON.stringify({ id: "yt-video-abc" }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await uploadVideoBytes("https://upload.example/session", bytes, "video/mp4", { fetchImpl });
    expect(res).toEqual({ videoId: "yt-video-abc" });
  });

  it("refuses publisher_http_error when accepted but the response carries no `id` — ambiguous, never guessed", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await expect(uploadVideoBytes("https://upload.example/session", new Uint8Array(), "video/mp4", { fetchImpl }))
      .rejects.toMatchObject({ code: "publisher_http_error" });
  });

  it("refuses publisher_http_error on a non-2xx", async () => {
    const fetchImpl = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(uploadVideoBytes("https://upload.example/session", new Uint8Array(), "video/mp4", { fetchImpl }))
      .rejects.toMatchObject({ code: "publisher_http_error", upstreamStatus: 500 });
  });
});

describe("SMM-38d · listVideoCommentThreads / normalizeCommentThreads", () => {
  it("GETs commentThreads.list with the videoId and normalizes the documented envelope", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    const fetchImpl = (async (url: string | URL) => {
      expect(String(url)).toContain("/commentThreads?part=snippet&videoId=vid-1&textFormat=plainText");
      return new Response(
        JSON.stringify({
          items: [{
            id: "c-1",
            snippet: {
              topLevelComment: {
                snippet: {
                  textDisplay: "hi", authorDisplayName: "Someone",
                  authorChannelId: { value: "UC1" }, publishedAt: "2026-08-02T00:00:00.000Z",
                },
              },
            },
          }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const items = await listVideoCommentThreads("at-1", "vid-1", since, { fetchImpl });
    expect(items).toEqual([{
      externalId: "c-1", externalThreadId: "vid-1", kind: "comment",
      authorHandle: "UC1", authorName: "Someone", body: "hi", postedAt: "2026-08-02T00:00:00.000Z",
    }]);
  });

  it("normalizeCommentThreads skips a row with no id, never guesses one", () => {
    const items = normalizeCommentThreads({ items: [{ snippet: {} }] }, "vid-1", new Date(0));
    expect(items).toEqual([]);
  });

  it("normalizeCommentThreads leaves authorHandle/authorName absent rather than defaulted when omitted", () => {
    const items = normalizeCommentThreads(
      { items: [{ id: "c-2", snippet: { topLevelComment: { snippet: { textDisplay: "x", publishedAt: "2026-08-02T00:00:00.000Z" } } } }] },
      "vid-1",
      new Date(0),
    );
    expect(items).toEqual([{
      externalId: "c-2", externalThreadId: "vid-1", kind: "comment",
      authorHandle: undefined, authorName: undefined, body: "x", postedAt: "2026-08-02T00:00:00.000Z",
    }]);
  });
});

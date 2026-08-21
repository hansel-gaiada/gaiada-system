// SMM-38 phase 38c — the `direct` driver's first REAL capability (LinkedIn org-page publish, media
// upload, comment read), plus the shared port contract suite run against it. No live LinkedIn app
// credential exists (D-23) — every network-touching case below drives a STUB `fetchImpl`, never a
// real socket, per the ticket's own "reuse platform_app_not_registered / drive a stub, never pretend
// to reach a real network" instruction.
//
// SMM-38 phase 38d adds YouTube's own cases below the LinkedIn ones — same STUB-only discipline (no
// live YouTube app credential exists either, D-23).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrgHandle, SocialPublisherError } from "./types";
import { createDirectDriver } from "./direct";
import { runPublisherContractSuite } from "./publisher-contract";
import { resetYouTubeQuotaUsage } from "./youtube-quota";

const ORG = new OrgHandle("row-1", "org-abc", "unused-key");
/** A LinkedIn-shaped handle: `orgId` carries the organization URN, `secret()` carries the
 *  already-resolved bearer token — see direct.ts's header for why `OrgHandle` is repurposed this way
 *  for the `direct` driver. */
const LINKEDIN_ORG = new OrgHandle("acct-1", "urn:li:organization:12345", "bearer-token-never-logged");
/** A YouTube-shaped handle: `orgId` is unused by every 38d method (see direct.ts's header — YouTube's
 *  calls identify the channel implicitly from the bearer token), `secret()` carries the
 *  already-resolved bearer token. */
const YOUTUBE_ORG = new OrgHandle("acct-2", "unused-for-youtube", "yt-bearer-token-never-logged");

beforeEach(() => {
  // Every YouTube quota case in this file must start from a clean day — see youtube-quota.ts's own
  // test seam header.
  resetYouTubeQuotaUsage();
});

/** A fetchImpl that always fails at the transport layer — proves every 38c-real method wraps a
 *  transport failure into a TYPED `publisher_unreachable`, never an untyped crash, without this
 *  suite ever opening a real socket. */
const unreachableFetch = vi.fn(async () => {
  throw new Error("stub: no real network in tests");
}) as unknown as typeof fetch;

describe("SMM-38 · the `direct` driver skeleton (38a) is still honest for everything it does not cover", () => {
  it("advertises 'direct' and EXACTLY the four capabilities 38c/38d made real — nothing more", () => {
    const d = createDirectDriver();
    expect(d.key).toBe("direct");
    expect([...d.capabilities].sort()).toEqual(["inbox_read", "media_upload", "quota_probe", "schedule"]);
  });

  it("sendReply/getCreatorInfo stay ABSENT — SMM-17/TikTok are out of this phase's scope", () => {
    const d = createDirectDriver();
    expect(d.sendReply).toBeUndefined();
    expect(d.getCreatorInfo).toBeUndefined();
  });

  it("listComments is now PRESENT — inbox_read is a real capability, not an optional gap", () => {
    const d = createDirectDriver();
    expect(d.listComments).toBeDefined();
  });

  it("refuses every member 38c/38d did not touch with a TYPED capability_unsupported", async () => {
    const d = createDirectDriver();
    const calls: Array<Promise<unknown>> = [
      d.createOrg({ name: "x" }),
      d.verifyOrg(ORG),
      d.connectUrl(ORG, "linkedin", "https://example.invalid/callback"),
      d.listIntegrations(ORG),
      d.cancelPost(ORG, "p-1"),
      d.getPostStatus(ORG, ["p-1"]),
      d.getAccountMetrics(ORG, "i", { from: "2026-01-01", to: "2026-01-02" }),
      d.getPostMetrics(ORG, ["p-1"]),
    ];
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(SocialPublisherError);
      await expect(call).rejects.toMatchObject({ code: "capability_unsupported" });
    }
  });

  it("getQuota refuses capability_unsupported for a network that is not youtube, even though " +
     "quota_probe IS now advertised driver-wide — the per-network gate the header documents", async () => {
    const d = createDirectDriver();
    await expect(d.getQuota(ORG, { id: "i", network: "linkedin", handle: "@h" }))
      .rejects.toMatchObject({ code: "capability_unsupported" });
    await expect(d.getQuota(ORG, { id: "i", network: "instagram", handle: "@h" }))
      .rejects.toMatchObject({ code: "capability_unsupported" });
  });

  it("estimateCostUsd is $0 for every network — neither LinkedIn nor YouTube is metered", () => {
    const d = createDirectDriver();
    expect(d.estimateCostUsd({ network: "linkedin" })).toBe(0);
    expect(d.estimateCostUsd({ network: "youtube" })).toBe(0);
    expect(d.estimateCostUsd({ network: "x", hasLink: true })).toBe(0);
  });
});

describe("SMM-38c · schedulePost — LinkedIn org-page publish is real; every other network still refuses", () => {
  it("checks the one-shot approval id FIRST, unconditionally — before ever looking at the network", async () => {
    const d = createDirectDriver({ fetchImpl: unreachableFetch });
    await expect(
      d.schedulePost(LINKEDIN_ORG, {
        integrationId: "i", network: "linkedin", body: "hi", approvalId: "", variantId: "v-1",
      }),
    ).rejects.toMatchObject({ code: "approval_required" });
    // No network call was attempted — the stub was never invoked.
    expect(unreachableFetch).not.toHaveBeenCalled();
  });

  it("a non-LinkedIn network refuses capability_unsupported even though `schedule` is advertised " +
     "driver-wide — the per-network gate the header documents", async () => {
    const d = createDirectDriver({ fetchImpl: unreachableFetch });
    await expect(
      d.schedulePost(ORG, { integrationId: "i", network: "instagram", body: "hi", approvalId: "a-1", variantId: "v-1" }),
    ).rejects.toMatchObject({ code: "capability_unsupported" });
  });

  it("YouTube ALSO refuses capability_unsupported — 38d deliberately does NOT give YouTube " +
     "`schedulePost` (a videos.insert call IS the post; see direct.ts's own comment)", async () => {
    const d = createDirectDriver({ fetchImpl: unreachableFetch });
    await expect(
      d.schedulePost(YOUTUBE_ORG, { integrationId: "i", network: "youtube", body: "hi", approvalId: "a-1", variantId: "v-1" }),
    ).rejects.toMatchObject({ code: "capability_unsupported" });
  });

  it("an approved LinkedIn dispatch that cannot reach the network refuses publisher_unreachable, " +
     "never a crash, never a silent success", async () => {
    const d = createDirectDriver({ fetchImpl: unreachableFetch });
    await expect(
      d.schedulePost(LINKEDIN_ORG, {
        integrationId: "i", network: "linkedin", body: "hi", approvalId: "a-1", variantId: "v-1",
      }),
    ).rejects.toMatchObject({ code: "publisher_unreachable" });
  });

  it("a successful LinkedIn publish returns the URN from the `x-restli-id` response header", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain("/rest/posts");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer bearer-token-never-logged" });
      const body = JSON.parse(String(init?.body));
      expect(body.author).toBe("urn:li:organization:12345");
      expect(body.commentary).toBe("hello linkedin");
      return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:999" } });
    }) as unknown as typeof fetch;
    const d = createDirectDriver({ fetchImpl });
    const res = await d.schedulePost(LINKEDIN_ORG, {
      integrationId: "i", network: "linkedin", body: "hello linkedin", approvalId: "a-1", variantId: "v-1",
    });
    expect(res).toEqual({ providerPostId: "urn:li:share:999" });
  });

  it("an accepted-but-id-less response refuses honestly rather than guessing — design §11's " +
     "no-auto-retry-of-ambiguous-outcomes rule", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 201 })) as unknown as typeof fetch;
    const d = createDirectDriver({ fetchImpl });
    await expect(
      d.schedulePost(LINKEDIN_ORG, { integrationId: "i", network: "linkedin", body: "hi", approvalId: "a-1", variantId: "v-1" }),
    ).rejects.toMatchObject({ code: "publisher_http_error" });
  });
});

describe("SMM-38c · uploadMedia — LinkedIn's register→PUT asset flow", () => {
  it("a transport failure refuses publisher_unreachable, never a crash", async () => {
    const d = createDirectDriver({ fetchImpl: unreachableFetch });
    await expect(
      d.uploadMedia(LINKEDIN_ORG, { filename: "a.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) }, "linkedin"),
    ).rejects.toMatchObject({ code: "publisher_unreachable" });
  });

  it("register + PUT succeeds and returns the asset URN as the media id", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("initializeUpload")) {
        return new Response(
          JSON.stringify({ value: { uploadUrl: "https://upload.linkedin.example/put-here", image: "urn:li:image:abc" } }),
          { status: 200 },
        );
      }
      if (u === "https://upload.linkedin.example/put-here") {
        expect(init?.method).toBe("PUT");
        return new Response("", { status: 201 });
      }
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;
    const d = createDirectDriver({ fetchImpl });
    const res = await d.uploadMedia(LINKEDIN_ORG, { filename: "a.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) }, "linkedin");
    expect(res).toEqual({ id: "urn:li:image:abc" });
  });

  it("a non-LinkedIn, non-YouTube network refuses capability_unsupported — the network-routing gap "
     + "38c named, resolved by the port's new `network` parameter", async () => {
    const d = createDirectDriver({ fetchImpl: unreachableFetch });
    await expect(
      d.uploadMedia(ORG, { filename: "a.png", contentType: "image/png", bytes: new Uint8Array() }, "instagram"),
    ).rejects.toMatchObject({ code: "capability_unsupported" });
  });
});

describe("SMM-38d · uploadMedia — YouTube's resumable initiate→PUT upload IS the publish call", () => {
  it("a transport failure on the initiate call refuses publisher_unreachable, never a crash", async () => {
    const d = createDirectDriver({ fetchImpl: unreachableFetch });
    await expect(
      d.uploadMedia(YOUTUBE_ORG, { filename: "clip.mp4", contentType: "video/mp4", bytes: new Uint8Array([1, 2, 3]) }, "youtube"),
    ).rejects.toMatchObject({ code: "publisher_unreachable" });
  });

  it("initiate + PUT succeeds, returns the created video's id, and records ONE videos.insert " +
     "call against the quota accounting — never before both calls succeeded", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("uploadType=resumable")) {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer yt-bearer-token-never-logged",
          "X-Upload-Content-Length": String(bytes.byteLength),
          "X-Upload-Content-Type": "video/mp4",
        });
        const body = JSON.parse(String(init?.body));
        expect(body.snippet.title).toBe("clip.mp4");
        expect(body.status.privacyStatus).toBe("private");
        return new Response("", { status: 200, headers: { Location: "https://upload.example/session-1" } });
      }
      if (u === "https://upload.example/session-1") {
        expect(init?.method).toBe("PUT");
        return new Response(JSON.stringify({ id: "yt-video-abc" }), { status: 200 });
      }
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;
    const d = createDirectDriver({ fetchImpl });

    const before = await d.getQuota(YOUTUBE_ORG, { id: "i", network: "youtube", handle: "@h" });
    expect(before?.youtubeQuota?.videosInsertCallsToday).toEqual({ used: 0, cap: 100 });

    const res = await d.uploadMedia(YOUTUBE_ORG, { filename: "clip.mp4", contentType: "video/mp4", bytes }, "youtube");
    expect(res).toEqual({ id: "yt-video-abc" });

    const after = await d.getQuota(YOUTUBE_ORG, { id: "i", network: "youtube", handle: "@h" });
    expect(after?.youtubeQuota?.videosInsertCallsToday).toEqual({ used: 1, cap: 100 });
    // The OTHER two buckets are untouched by an upload — proving the three-bucket model is not one
    // pool (media-rules.ts's own named trap).
    expect(after?.youtubeQuota?.searchListCallsToday).toEqual({ used: 0, cap: 100 });
    expect(after?.youtubeQuota?.otherUnitsToday).toEqual({ used: 0, cap: 10000 });
  });

  it("a failed PUT never records quota usage — only a call this driver OBSERVED succeeding is counted", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("uploadType=resumable")) {
        return new Response("", { status: 200, headers: { Location: "https://upload.example/session-2" } });
      }
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    const d = createDirectDriver({ fetchImpl });
    await expect(
      d.uploadMedia(YOUTUBE_ORG, { filename: "clip.mp4", contentType: "video/mp4", bytes: new Uint8Array([1]) }, "youtube"),
    ).rejects.toMatchObject({ code: "publisher_http_error" });
    const snapshot = await d.getQuota(YOUTUBE_ORG, { id: "i", network: "youtube", handle: "@h" });
    expect(snapshot?.youtubeQuota?.videosInsertCallsToday).toEqual({ used: 0, cap: 100 });
  });
});

describe("SMM-38c · listComments — pullComments, the reason this phase exists", () => {
  it("is keyed by providerPostId (a LinkedIn share URN), not an account integration id — see the " +
     "header's documented departure from the port's account-wide doc", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("/rest/socialActions/urn%3Ali%3Ashare%3A999/comments");
      return new Response(
        JSON.stringify({
          elements: [
            {
              $URN: "urn:li:comment:1",
              actor: "urn:li:person:abc",
              message: { text: "nice post!" },
              created: { time: Date.parse("2026-08-02T00:00:00Z") },
            },
            // Older than `since` — must be filtered out client-side.
            {
              $URN: "urn:li:comment:0",
              actor: "urn:li:person:xyz",
              message: { text: "too old" },
              created: { time: Date.parse("2026-07-01T00:00:00Z") },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const d = createDirectDriver({ fetchImpl });
    const items = await d.listComments!(LINKEDIN_ORG, "urn:li:share:999", since);
    expect(items).toEqual([
      {
        externalId: "urn:li:comment:1",
        externalThreadId: "urn:li:share:999",
        kind: "comment",
        authorHandle: "urn:li:person:abc",
        authorName: undefined,
        body: "nice post!",
        postedAt: "2026-08-02T00:00:00.000Z",
      },
    ]);
  });
});

describe("SMM-38d · listComments — YouTube's commentThreads.list, told apart from LinkedIn by the " +
  "network's OWN id shape (no port `network` parameter on this method — see direct.ts's header)", () => {
  it("a YouTube video id (never URN-shaped) routes to commentThreads.list, normalizes the response, " +
     "filters by `since`, and records ONE unit against otherUnitsToday", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("/commentThreads?part=snippet&videoId=yt-video-1");
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "yt-comment-1",
              snippet: {
                topLevelComment: {
                  snippet: {
                    textDisplay: "great video!",
                    authorDisplayName: "A Viewer",
                    authorChannelId: { value: "UC-viewer-1" },
                    publishedAt: "2026-08-02T00:00:00.000Z",
                  },
                },
              },
            },
            // Older than `since` — must be filtered out client-side.
            {
              id: "yt-comment-0",
              snippet: {
                topLevelComment: {
                  snippet: { textDisplay: "too old", publishedAt: "2026-07-01T00:00:00.000Z" },
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const d = createDirectDriver({ fetchImpl });
    const items = await d.listComments!(YOUTUBE_ORG, "yt-video-1", since);
    expect(items).toEqual([
      {
        externalId: "yt-comment-1",
        externalThreadId: "yt-video-1",
        kind: "comment",
        authorHandle: "UC-viewer-1",
        authorName: "A Viewer",
        body: "great video!",
        postedAt: "2026-08-02T00:00:00.000Z",
      },
    ]);
    const snapshot = await d.getQuota(YOUTUBE_ORG, { id: "i", network: "youtube", handle: "@h" });
    expect(snapshot?.youtubeQuota?.otherUnitsToday).toEqual({ used: 1, cap: 10000 });
  });

  it("a LinkedIn share URN still routes to LinkedIn's own comment read, unaffected by 38d", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("/rest/socialActions/");
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const d = createDirectDriver({ fetchImpl });
    const items = await d.listComments!(LINKEDIN_ORG, "urn:li:share:999", since);
    expect(items).toEqual([]);
    // LinkedIn's own comment read must NOT touch YouTube's quota accounting.
    const snapshot = await d.getQuota(YOUTUBE_ORG, { id: "i", network: "youtube", handle: "@h" });
    expect(snapshot?.youtubeQuota?.otherUnitsToday).toEqual({ used: 0, cap: 10000 });
  });
});

// SMM-38's own acceptance bar: the shared port contract, generalised, run against this driver too.
// A STUB fetchImpl throughout — the contract suite's "does its job OR refuses with a TYPED error"
// case for `uploadMedia` gets a typed `publisher_unreachable` from the stub, never a real socket.
runPublisherContractSuite("direct (linkedin)", {
  build: () => createDirectDriver({ fetchImpl: unreachableFetch }),
  integration: { id: "urn:li:share:contract", network: "linkedin", handle: "@contract" },
});

// SMM-38d — the SAME shared contract, now run YouTube-shaped: `schedulePost` still hits the
// `capability_unsupported` branch (YouTube never gets `schedule`, direct.ts's own header), while
// `uploadMedia`/`getQuota` exercise YouTube's real, stub-backed implementations.
runPublisherContractSuite("direct (youtube)", {
  build: () => createDirectDriver({ fetchImpl: unreachableFetch }),
  integration: { id: "yt-video-contract", network: "youtube", handle: "@contract" },
});

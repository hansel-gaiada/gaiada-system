// SMM-21 — `listDailyMetrics`/`listPostMetrics` (`lib/social.ts`). Mirrors `approvals.test.ts`'s
// convention of stubbing `global.fetch` directly rather than mocking `lib/platform`.
//
// What each case proves:
//   (1) `engagementId` reaches the query string, and `accountId`/`from`/`to` are added only when
//       given — the exact shape `social.controller.ts`'s `GET metrics/daily` expects.
//   (2) the `{series:[...]}` / `{posts:[...]}` wrapper is unwrapped, matching `listAccounts`'
//       `{accounts:[...]}` convention rather than assuming a bare array.
//   (3) a `null` counter survives the round trip as `null`, never coerced to `0` — the ONE thing
//       this whole ticket exists to guarantee end to end.
//   (4) a genuine 403 sets `forbidden: true` with the empty-array fallback (never thrown, never a
//       silently-empty 200 masquerading as "no data" — `readGuarded`'s own contract).
import { describe, it, expect, afterEach, vi } from "vitest";
import { listDailyMetrics, listPostMetrics } from "./social";
import { PlatformError } from "./platform";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("listDailyMetrics / listPostMetrics", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("(1) sends engagementId always, and accountId/from/to only when provided", async () => {
    let seenUrl = "";
    global.fetch = vi.fn(async (url: string) => {
      seenUrl = url;
      return jsonResponse({ series: [] }, 200);
    }) as unknown as typeof fetch;

    await listDailyMetrics("u-1", "co-1", "eng-1", { accountId: "acc-1", from: "2026-08-01", to: "2026-08-31" });

    expect(seenUrl).toContain("/modules/social/metrics/daily?");
    expect(seenUrl).toContain("engagementId=eng-1");
    expect(seenUrl).toContain("accountId=acc-1");
    expect(seenUrl).toContain("from=2026-08-01");
    expect(seenUrl).toContain("to=2026-08-31");
  });

  it("(1b) omits accountId/from/to entirely when not given", async () => {
    let seenUrl = "";
    global.fetch = vi.fn(async (url: string) => {
      seenUrl = url;
      return jsonResponse({ series: [] }, 200);
    }) as unknown as typeof fetch;

    await listDailyMetrics("u-1", "co-1", "eng-1");
    expect(seenUrl).not.toContain("accountId");
    expect(seenUrl).not.toContain("from=");
    expect(seenUrl).not.toContain("to=");
  });

  it("(2)+(3) unwraps {series:[...]} and preserves null counters exactly, never coerced to 0", async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      series: [
        {
          accountId: "acc-1", network: "instagram", handle: "brand", displayName: "Brand",
          date: "2026-08-15", followers: 900, impressions: 4000,
          reach: null, engagements: null, linkClicks: null, videoViews: null,
        },
      ],
    }, 200)) as unknown as typeof fetch;

    const r = await listDailyMetrics("u-1", "co-1", "eng-1");
    expect(r.forbidden).toBe(false);
    expect(r.data).toHaveLength(1);
    expect(r.data[0].followers).toBe(900);
    expect(r.data[0].reach).toBeNull();
    expect(r.data[0].engagements).toBeNull();
  });

  it("(2)+(3) unwraps {posts:[...]} for listPostMetrics, same null-preservation", async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      posts: [
        {
          variantId: "var-1", postId: "post-1", accountId: "acc-1", network: "instagram",
          publishedAt: "2026-08-05T10:00:00Z", publishedUrl: "https://instagram.example/p/1",
          impressions: 500, likes: 10, comments: null, shares: null, saves: null,
          videoViews: null, clicks: null, fetchedAt: "2026-08-06T00:00:00Z",
        },
      ],
    }, 200)) as unknown as typeof fetch;

    const r = await listPostMetrics("u-1", "co-1", "eng-1");
    expect(r.data).toHaveLength(1);
    expect(r.data[0].impressions).toBe(500);
    expect(r.data[0].comments).toBeNull();
    expect(r.data[0].saves).toBeNull();
  });

  it("(4) a genuine 403 sets forbidden:true with an empty array, never thrown", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ error: "forbidden" }, 403)) as unknown as typeof fetch;
    const r = await listDailyMetrics("u-1", "co-1", "eng-1");
    expect(r.forbidden).toBe(true);
    expect(r.data).toEqual([]);
  });

  it("(4b) a 404 (module dark) is NOT forbidden — an absent module is a legitimate empty state", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ error: "not found" }, 404)) as unknown as typeof fetch;
    const r = await listPostMetrics("u-1", "co-1", "eng-1");
    expect(r.forbidden).toBe(false);
    expect(r.data).toEqual([]);
  });

  it("(5) a real network failure propagates rather than degrading to an empty list", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ error: "internal error" }, 500)) as unknown as typeof fetch;
    await expect(listDailyMetrics("u-1", "co-1", "eng-1")).rejects.toThrow(PlatformError);
  });
});

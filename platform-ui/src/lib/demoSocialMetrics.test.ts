import { describe, it, expect, afterAll, vi } from "vitest";

// SCP-3c (BFF §63.10, §63.16): DEMO_MODE answers a post's metrics from the demo pipeline store, so the post page works with no backend. The store seeds from the day it is first touched,
// so the clock is pinned to mid-month (Friday 16 October 2026, midday in Singapore) before it is imported (hence vi.hoisted). Only Date is faked.
//
// What the demo must show: one live post a BOOST CANDIDATE ("A day in the warehouse": about twice its client's average), the posts at their client's own average that are not, a PULLED
// post with no reach (the null case), and the simulated hotel post marked SIMULATED. Every write test uses a post of its own, so the order does not matter; the read tests of Northwind come
// first and write nothing to it.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { socialDemo } from "./demoSocial";
import { PIPE_POSTS, demoPipelineRead } from "./demoSocialPipeline";
import { asPostMetrics, asStoredMetrics } from "./socialMetrics";

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const BASE = "/api/co-agency/modules/social";
const postOf = (title: string) => PIPE_POSTS.find((p) => p.title === title)!;
const readPost = (title: string): Body => demoPipelineRead(postOf(title).id, "demo-hansel").json as Body;
const officerOf = (title: string): string => readPost(title).officer.id as string;
const variantsOf = (title: string): string[] => (readPost(title).variants as Array<{ id: string }>).map((v) => v.id);
const get = (title: string, user = "demo-hansel") => socialDemo("GET", `${BASE}/posts/${postOf(title).id}/metrics`, new URLSearchParams(), undefined, user)!;
const enter = (variantId: string, body: unknown, user: string) => socialDemo("POST", `${BASE}/variants/${variantId}/metrics`, new URLSearchParams(), JSON.stringify(body), user)!;
const metrics = (title: string) => asPostMetrics(get(title).json);
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

describe("GET posts/:postId/metrics in the demo", () => {
  it("is routed by the social demo and parses as the contract's answer, with exactly its keys", () => {
    const r = get("A day in the warehouse");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json as object).sort()).toEqual(["accountAverageRate", "boostCandidate", "engagementRate", "latest", "simulated"]);
    expect(asPostMetrics(r.json).latest).not.toBeNull();
  });

  it("has a live post that is a boost candidate: about twice the client's average, typed in", () => {
    const m = metrics("A day in the warehouse");
    expect(m.boostCandidate).toBe(true);
    expect(m.engagementRate).toBeCloseTo(0.071, 2);
    expect(m.accountAverageRate).toBeCloseTo(0.036, 2); // the client's other posts with a reach: 3.2% and 4.0% (the pulled one has none)
    expect(m.latest).toMatchObject({ source: "manual" });
    expect(m.simulated).toBe(false);
  });

  it("the client's other live posts are not candidates", () => {
    for (const t of ["Harvest collection arrives", "Reader favourite reshare"]) expect(metrics(t).boostCandidate, t).toBe(false);
    for (const t of ["Closing hours reminder", "Sunday reset ritual"]) expect(metrics(t), t).toMatchObject({ boostCandidate: false });
  });

  it("a pulled post has numbers but no reach: no rate, so no candidate (the null case)", () => {
    const m = metrics("Open until late tonight");
    expect(m.latest).toMatchObject({ source: "pull", reach: null });
    expect(m.latest!.likes).toBeGreaterThan(0);
    expect(m.engagementRate).toBeNull();
    expect(m.boostCandidate).toBe(false);
    expect(m.accountAverageRate).not.toBeNull(); // its client has other posts with a rate
  });

  it("the simulated hotel post says so, and has no average to compare with", () => {
    const m = metrics("Weekend brunch is back");
    expect(m).toMatchObject({ simulated: true, accountAverageRate: null, boostCandidate: false });
    expect(m.latest).toMatchObject({ source: "simulated" });
    expect(m.engagementRate).toBeCloseTo(0.045, 2);
  });

  it("a post that is not live has no numbers of its own (the client's average is still the client's)", () => {
    expect(metrics("Five ways to style a scarf")).toMatchObject({ latest: null, engagementRate: null, boostCandidate: false, simulated: false });
  });

  it("404 for an unknown post, 403 for a client contact (the portal has its own routes), 409 for a Composer post", () => {
    const unknown = socialDemo("GET", `${BASE}/posts/nope/metrics`, new URLSearchParams(), undefined, "demo-hansel")!;
    expect(unknown).toMatchObject({ status: 404, json: { error: "post_not_found" } });
    expect(get("A day in the warehouse", "demo-client").status).toBe(403);
    // a legacy Composer post exists in the demo's other store: its id is not a pipeline post
    const composerId = (socialDemo("GET", `${BASE}/posts`, new URLSearchParams(), undefined, "demo-hansel")!.json as { items?: Array<{ id: string }> }).items?.map((x) => x.id).find((id) => !PIPE_POSTS.some((p) => p.id === id));
    if (composerId) expect(socialDemo("GET", `${BASE}/posts/${composerId}/metrics`, new URLSearchParams(), undefined, "demo-hansel")).toMatchObject({ status: 409, json: { error: "not_a_pipeline_post" } });
  });
});

describe("POST variants/:variantId/metrics in the demo", () => {
  const T = "Sunday reset ritual"; // the spa: its posts are the writes' own
  const T2 = "Closing hours reminder";

  it("the officer types a snapshot in: 201 with the stored row, and the read follows it", () => {
    const [v] = variantsOf(T);
    const officer = officerOf(T);
    const capturedAt = hourAgo();
    const r = enter(v, { capturedAt, reach: 2000, likes: 120, comments: 10, shares: 5, saves: 15, impressions: 2600 }, officer);
    expect(r.status).toBe(201);
    const row = asStoredMetrics(r.json);
    expect(row).toMatchObject({ variantId: v, postId: postOf(T).id, source: "manual", capturedAt, reach: 2000, likes: 120, clicks: null, videoViews: null, enteredBy: officer });
    const m = metrics(T);
    expect(m.latest).toMatchObject({ source: "manual", capturedAt });
    expect(m.latest!.reach).toBeGreaterThanOrEqual(2000); // the post's other variants add theirs
    expect(m.engagementRate).not.toBeNull();
  });

  it("a second entry with a newer capture time becomes the post's latest; an older one does not", () => {
    const [v] = variantsOf(T2);
    const officer = officerOf(T2);
    const newer = new Date(Date.now() - 600_000).toISOString();
    expect(enter(v, { capturedAt: newer, reach: 111, likes: 11 }, officer).status).toBe(201);
    expect(enter(v, { capturedAt: new Date(Date.now() - 86_400_000 * 5).toISOString(), reach: 999999, likes: 1 }, officer).status).toBe(201);
    const latest = metrics(T2).latest!;
    expect(latest.capturedAt).toBe(newer);
  });

  it("is refused 403, even with a bad body, for anyone who is not the client's officer (the superadmin's wildcard aside)", () => {
    const [v] = variantsOf(T2);
    for (const user of ["u-copy", "u-social-design", "u-gm", "demo-owner", "demo-client", "u-dev"]) {
      expect(enter(v, { capturedAt: hourAgo(), reach: 10 }, user).status, user).toBe(403);
      expect(enter(v, { reach: -1 }, user).status, `${user} with a bad body`).toBe(403);
    }
    expect(enter(v, { capturedAt: hourAgo(), reach: 10 }, "demo-hansel").status).toBe(201);
  });

  it("every bad field is 400 with its field", () => {
    const [v] = variantsOf("Weekend brunch is back");
    const officer = officerOf("Weekend brunch is back");
    const ok = { capturedAt: hourAgo(), reach: 10 };
    const cases: Array<[unknown, string, string]> = [
      [{ reach: 5 }, "capturedAt", "missing_field"],
      [{ capturedAt: "yesterday", reach: 5 }, "capturedAt", "invalid_field"],
      [{ capturedAt: "2026-02-30T08:00:00Z", reach: 5 }, "capturedAt", "invalid_field"],
      [{ capturedAt: "2026-10-16T08:00:00", reach: 5 }, "capturedAt", "invalid_field"],
      [{ capturedAt: new Date(Date.now() + 86_400_000).toISOString(), reach: 5 }, "capturedAt", "invalid_field"],
      [{ capturedAt: ok.capturedAt }, "reach", "missing_field"],
      [{ ...ok, reach: -1 }, "reach", "invalid_field"],
      [{ ...ok, reach: 1.5 }, "reach", "invalid_field"],
      [{ ...ok, reach: "10" }, "reach", "invalid_field"],
    ];
    for (const k of ["impressions", "likes", "comments", "shares", "saves", "videoViews", "clicks"]) cases.push([{ ...ok, [k]: -1 }, k, "invalid_field"]);
    for (const [body, field, error] of cases) {
      const r = enter(v, body, officer);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json, JSON.stringify(body)).toEqual({ error, field });
    }
  });

  it("409 post_not_live for a post that is not live; the body is judged first (a bad one is 400)", () => {
    const t = "Five ways to style a scarf";
    const [v] = variantsOf(t);
    const officer = officerOf(t);
    const r = enter(v, { capturedAt: hourAgo(), reach: 10 }, officer);
    expect(r).toMatchObject({ status: 409, json: { error: "post_not_live" } });
    expect(enter(v, { reach: 10 }, officer).status).toBe(400);
  });

  it("404 post_not_found for an unknown variant", () => {
    expect(enter("not-a-variant", { capturedAt: hourAgo(), reach: 10 }, "demo-hansel")).toMatchObject({ status: 404, json: { error: "post_not_found" } });
  });

  it("a live post that had no numbers gets some, and its 'metrics missing' item leaves Needs you", () => {
    const p = PIPE_POSTS.find((x) => x.pipelineStatus === "live" && x.metrics !== null)!;
    const saved = p.metrics;
    p.metrics = null; // as if it had just gone live
    try {
      const v = (demoPipelineRead(p.id, "demo-hansel").json as Body).variants[0].id as string;
      const officer = (demoPipelineRead(p.id, "demo-hansel").json as Body).officer.id as string;
      expect(enter(v, { capturedAt: hourAgo(), reach: 500, likes: 20 }, officer).status).toBe(201);
      expect(p.metrics).not.toBeNull();
      expect(p.metrics!.reach).toBeGreaterThanOrEqual(500);
    } finally {
      p.metrics = saved;
    }
  });
});

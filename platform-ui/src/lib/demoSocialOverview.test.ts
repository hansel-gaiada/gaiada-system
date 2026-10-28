import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-3f: DEMO_MODE's answer for `GET overview` (BFF §63.7), computed from the demo posts. The store seeds from the day it is first touched, so the clock is pinned to
// mid-month (Friday 16 October 2026) before it is imported, as demoSocialPipeline.test.ts does. Only Date is faked.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { PIPE_POSTS, demoCalendar, demoFeed, demoOverview } from "./demoSocialPipeline";
import { scpEngineStatusOf } from "./scpStageMachine";
import { asOverview } from "./socialOverview";
import { socialDemo } from "./demoSocial";

type Card = { id: string; phase: string | null; health: { state: string } | null; pipelineStatus: string };
const allCards = (): Card[] => {
  const r = demoFeed(new URLSearchParams("view=all&limit=100"), "u-social");
  expect(r.status).toBe(200);
  return (r.json as { items: Card[] }).items;
};

describe("demoOverview", () => {
  it("answers the contract's shape, which the UI's own parser accepts, with a boosts-waiting number", () => {
    const r = demoOverview("u-social", 0);
    expect(r.status).toBe(200);
    const o = asOverview(r.json);
    expect(o.tiles.boostsWaiting).toBeGreaterThanOrEqual(1);
    expect(Object.keys((r.json as { tiles: object }).tiles).sort()).toEqual(["boostsWaiting", "failedPosts", "inProduction", "late", "scheduledThisWeek", "withClient"]);
  });

  it("counts the phases and the late posts the feed's own cards show", () => {
    const cards = allCards();
    const o = asOverview(demoOverview("u-social", 0).json);
    expect(o.tiles.inProduction).toBe(cards.filter((c) => c.phase === "in_production").length);
    expect(o.tiles.withClient).toBe(cards.filter((c) => c.phase === "with_client").length);
    expect(o.tiles.late).toBe(cards.filter((c) => c.health?.state === "late").length);
    expect(o.tiles.inProduction).toBeGreaterThan(0);
    expect(o.tiles.withClient).toBeGreaterThan(0);
  });

  it("counts this week's scheduled posts as the calendar shows them, Monday 12 to Sunday 18 October", () => {
    const week = demoCalendar(new URLSearchParams("from=2026-10-12&to=2026-10-18")).json as { items: Array<{ pipelineStatus: string }> };
    const o = asOverview(demoOverview("u-social", 0).json);
    expect(o.tiles.scheduledThisWeek).toBe(week.items.filter((i) => i.pipelineStatus === "scheduled").length);
  });

  it("failed posts are the failed Composer posts passed in (the demo has no failed pipeline post), once", () => {
    expect(PIPE_POSTS.some((p) => ["failed", "partially_published"].includes(String(scpEngineStatusOf({ pipelineStatus: p.pipelineStatus }))))).toBe(false);
    expect(asOverview(demoOverview("u-social", 0).json).tiles.failedPosts).toBe(0);
    expect(asOverview(demoOverview("u-social", 2).json).tiles.failedPosts).toBe(2);
  });

  it("says the simulator is on, because the demo's accounts and posts are simulated", () => {
    expect(asOverview(demoOverview("u-social", 0).json).simulatedIncluded).toBe(true);
  });

  it("refuses a client contact with 403, as the feed does", () => {
    expect(demoOverview("demo-client", 0).status).toBe(403);
    expect(demoFeed(new URLSearchParams("view=all"), "demo-client").status).toBe(403);
  });

  it("is routed from the social demo dispatcher, with the Composer store's failed posts counted by the route", () => {
    const r = socialDemo("GET", "/api/co-agency/modules/social/overview", new URLSearchParams(), undefined, "u-social");
    expect(r?.status).toBe(200);
    expect(asOverview(r?.json).tiles.failedPosts).toBe(0);
    expect(socialDemo("GET", "/api/co-agency/modules/social/overview", new URLSearchParams(), undefined, "demo-client")?.status).toBe(403);
  });
});

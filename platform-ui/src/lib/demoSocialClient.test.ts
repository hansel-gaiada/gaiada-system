import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-1k, SCP-1m: the demo store answers the client calendar, the create and the bulk routes, in the server's order of checks. The store seeds from the day it
// is first touched, so the clock is pinned to mid-month (Friday 16 October 2026, midday in Singapore) before it is imported (hence vi.hoisted). Only Date is
// faked. Northwind Traders (`soc-eng-1`) posts at 09:30 UTC, which is the same day in the display zone, so its days are exact; the spa posts at 18:00 UTC, which
// is the next day there.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { socialDemo } from "./demoSocial";
import { asBulkResults, asCalendarItems, asCycleView } from "./socialClient";

const call = (method: string, path: string, body?: unknown, q: Record<string, string> = {}, userId?: string) =>
  socialDemo(method, `/api/co-agency/modules/social/${path}`, new URLSearchParams(q), body === undefined ? undefined : JSON.stringify(body), userId);

const NORTH_CYCLE = "soc-cyc-soc-eng-1-2026-10";
const SPA_CYCLE = "soc-cyc-soc-eng-3-2026-10";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("GET calendar", () => {
  const october = { from: "2026-10-01", to: "2026-10-31" };

  it("lists one client's scheduled posts of the range, oldest first, with their phase and status", () => {
    const r = call("GET", "calendar", undefined, { ...october, engagementId: "soc-eng-1" });
    expect(r?.status).toBe(200);
    const items = asCalendarItems(r?.json);
    expect(items.map((i) => i.title)).toEqual([
      "Autumn collection teaser", "Last call for the market stall", "Behind the scenes at the studio", "Weekend market date moved", "Five ways to style a scarf",
      "Studio tour in 30 seconds", "Launch day announcement", "Meet the packing team",
    ]); // SCP-2 added a story (the 22nd) and a reel (the 26th) that wait on the client
    const by = (t: string) => items.find((i) => i.title === t)!;
    expect(by("Autumn collection teaser")).toMatchObject({ clientName: "Northwind Traders", pipelineStatus: "scheduled", phase: "client_approved", format: "feed", simulated: false, dateMove: "reschedule", dateMoveRefusal: null });
    expect(by("Five ways to style a scarf")).toMatchObject({ pipelineStatus: "client", phase: "with_client", format: "carousel", dateMove: "locked", dateMoveRefusal: "field_locked" });
    expect(by("Launch day announcement")).toMatchObject({ pipelineStatus: "changes", phase: "client_changes", dateMove: "locked", dateMoveRefusal: "field_locked" });
    expect(by("Autumn collection teaser").scheduledAt).toBe("2026-10-20T09:30:00.000Z");
  });

  it("without a client, lists every client's posts, and marks the simulated one", () => {
    const items = asCalendarItems(call("GET", "calendar", undefined, october)?.json);
    expect(new Set(items.map((i) => i.clientName))).toEqual(new Set(["Northwind Traders", "Saltmarsh Day Spa", "Harborlight Hotel"]));
    expect(items.filter((i) => i.simulated).map((i) => i.title)).toEqual(["Weekend brunch is back"]);
    expect(items.map((i) => i.scheduledAt)).toEqual([...items.map((i) => i.scheduledAt)].sort());
  });

  it("counts both ends of the range, by day in the display zone", () => {
    const one = asCalendarItems(call("GET", "calendar", undefined, { from: "2026-10-20", to: "2026-10-20", engagementId: "soc-eng-1" })?.json);
    expect(one.map((i) => i.title)).toEqual(["Autumn collection teaser"]);
    expect(asCalendarItems(call("GET", "calendar", undefined, { from: "2026-10-21", to: "2026-10-21", engagementId: "soc-eng-1" })?.json)).toEqual([]);
    expect(asCalendarItems(call("GET", "calendar", undefined, { from: "2026-10-21", to: "2026-10-22", engagementId: "soc-eng-1" })?.json).map((i) => i.title)).toEqual(["Last call for the market stall"]);
  });

  it("keeps the posts the cycle's health lists: the same ids for the same client and month", () => {
    const health = asCycleView(call("GET", `cycles/${NORTH_CYCLE}/health`)?.json);
    const items = asCalendarItems(call("GET", "calendar", undefined, { ...october, engagementId: "soc-eng-1" })?.json);
    expect(items.map((i) => i.postId).sort()).toEqual(health.posts.map((p) => p.postId).sort());
  });

  it("refuses a bad range with its field: missing, unreal, reversed, or longer than 62 days (both ends counted)", () => {
    const code = (q: Record<string, string>) => call("GET", "calendar", undefined, q);
    expect(code({ to: "2026-10-31" })).toMatchObject({ status: 400, json: { error: "invalid_field", field: "from" } });
    expect(code({ from: "2026-10-01" })).toMatchObject({ status: 400, json: { field: "to" } });
    expect(code({ from: "2026-02-30", to: "2026-03-05" })).toMatchObject({ status: 400, json: { field: "from" } });
    expect(code({ from: "2026-10-05", to: "2026-10-04" })).toMatchObject({ status: 400, json: { field: "to" } });
    expect(code({ from: "2026-03-01", to: "2026-05-01" })?.status).toBe(200); // 62 days
    expect(code({ from: "2026-03-01", to: "2026-05-02" })).toMatchObject({ status: 400, json: { field: "to" } }); // 63
    expect(code({ ...october, engagementId: "not a client!" })).toMatchObject({ status: 400, json: { field: "engagementId" } });
  });

  it("an engagement that is not there keeps nothing, and is not an error", () => {
    expect(asCalendarItems(call("GET", "calendar", undefined, { ...october, engagementId: "soc-eng-99" })?.json)).toEqual([]);
  });
});

describe("POST cycles/:cycleId/posts", () => {
  const post = (cycleId: string, body: unknown, userId = "demo-hansel") => call("POST", `cycles/${cycleId}/posts`, body, {}, userId);
  const health = (cycleId: string) => asCycleView(call("GET", `cycles/${cycleId}/health`)?.json);

  it("adds a planned post to the cycle: it counts, and the next read shows it", () => {
    const before = health(NORTH_CYCLE).posts.length;
    const r = post(NORTH_CYCLE, { id: uuid(1), title: "A fresh idea", format: "reel", pillar: "Seasonal", scheduledAt: "2026-10-30T10:00:00.000Z", placement: ["instagram"] });
    expect(r?.status).toBe(201);
    expect(r?.json).toMatchObject({ created: true, post: { id: uuid(1), title: "A fresh idea", pipelineStatus: "planned", phase: "brief", isExtra: false, format: "reel", pillar: "Seasonal", placement: ["instagram"] } });
    const after = health(NORTH_CYCLE);
    expect(after.posts).toHaveLength(before + 1);
    expect(after.posts.find((p) => p.postId === uuid(1))).toMatchObject({ status: "planned", isExtra: false, format: "reel" });
    // it is on the calendar, too
    expect(asCalendarItems(call("GET", "calendar", undefined, { from: "2026-10-30", to: "2026-10-30", engagementId: "soc-eng-1" })?.json).map((i) => i.postId)).toContain(uuid(1));
  });

  it("an extra post is flagged and stays outside the target's count", () => {
    const counts = () => (call("GET", "allocation")?.json as { items: Array<{ engagementId: string; thisCycle: { counted: number; extra: number } }> }).items.find((x) => x.engagementId === "soc-eng-1")!.thisCycle;
    const before = counts();
    const r = post(NORTH_CYCLE, { id: uuid(2), title: "Event brief", isExtra: true });
    expect(r?.status).toBe(201);
    expect(r?.json).toMatchObject({ created: true, post: { isExtra: true, pipelineStatus: "planned" } });
    expect(counts()).toEqual({ ...before, extra: before.extra + 1 });
  });

  it("answers a replayed id with 201 and created: false, and adds nothing", () => {
    const n = health(NORTH_CYCLE).posts.length;
    const again = post(NORTH_CYCLE, { id: uuid(1), title: "A fresh idea" });
    expect(again?.status).toBe(201);
    expect(again?.json).toMatchObject({ created: false, post: { id: uuid(1) } });
    expect(health(NORTH_CYCLE).posts).toHaveLength(n);
    // the same id in another cycle is refused: an id taken elsewhere
    expect(post(SPA_CYCLE, { id: uuid(1), title: "x" })).toMatchObject({ status: 400, json: { field: "id" } });
  });

  it("allows the cycle's officer and the four, and refuses anyone else with not_officer_or_approver, before reading the body", () => {
    expect(post(NORTH_CYCLE, { id: uuid(3), title: "By the officer" }, "u-social")?.status).toBe(201);
    for (const [i, who] of ["u-pm", "u-gm", "demo-owner"].entries()) expect(post(NORTH_CYCLE, { id: uuid(10 + i), title: `By ${who}` }, who)?.status, who).toBe(201);
    // another client's officer, and a member who is neither, hold nothing here: and a bad body is still 403
    expect(post(SPA_CYCLE, { id: uuid(4), title: "Wrong officer" }, "u-social")).toMatchObject({ status: 403, json: { error: "not_officer_or_approver" } });
    expect(post(NORTH_CYCLE, { title: "" }, "u-dev")).toMatchObject({ status: 403, json: { error: "not_officer_or_approver" } });
    expect(post(NORTH_CYCLE, { id: uuid(5), title: "A client" }, "demo-client")?.status).toBe(403);
  });

  it("is 404 cycle_not_found for an approver naming no cycle", () => {
    expect(post("soc-cyc-nowhere", { title: "x" })).toMatchObject({ status: 404, json: { error: "cycle_not_found" } });
  });

  it("refuses each value outside its rule with its field", () => {
    const bad = (body: Record<string, unknown>) => post(NORTH_CYCLE, { title: "ok", ...body });
    expect(post(NORTH_CYCLE, {})).toMatchObject({ status: 400, json: { error: "missing_field", field: "title" } });
    expect(bad({ title: "   " })).toMatchObject({ status: 400, json: { field: "title" } });
    expect(bad({ title: "x".repeat(201) })).toMatchObject({ status: 400, json: { field: "title" } });
    expect(bad({ format: "video" })).toMatchObject({ status: 400, json: { field: "format" } });
    expect(bad({ pillar: "p".repeat(61) })).toMatchObject({ status: 400, json: { field: "pillar" } });
    expect(bad({ scheduledAt: "someday" })).toMatchObject({ status: 400, json: { field: "scheduledAt" } });
    expect(bad({ placement: ["instagram", "instagram"] })).toMatchObject({ status: 400, json: { field: "placement" } });
    expect(bad({ placement: ["myspace"] })).toMatchObject({ status: 400, json: { field: "placement" } });
    expect(bad({ isExtra: "yes" })).toMatchObject({ status: 400, json: { field: "isExtra" } });
    expect(bad({ id: "not-a-uuid" })).toMatchObject({ status: 400, json: { field: "id" } });
  });
});

describe("POST posts/actions (bulk)", () => {
  const bulk = (body: unknown) => call("POST", "posts/actions", body);

  it("answers every item in order: a refusal for one never hides another", () => {
    const r = bulk({ action: "send_to_proofread", items: [{ postId: "soc-post-n-6", expectedStatus: "drafting" }, { postId: "nope", expectedStatus: "drafting" }] });
    expect(r?.status).toBe(200);
    const results = asBulkResults(r?.json);
    expect(results.map((x) => x.postId)).toEqual(["soc-post-n-6", "nope"]);
    // Each item runs SCP-1e's runner (demoSocialPipelineRun.ts) in the server's order of checks: this post is not at the step the item names, so it says so.
    expect(results[0]).toMatchObject({ ok: false, error: "status_changed" });
    expect(results[1]).toMatchObject({ ok: false, error: "post_not_found" });
  });

  it("validates the call: the action, then the 1 to 50 items", () => {
    expect(bulk({ items: [] })).toMatchObject({ status: 400, json: { field: "action" } });
    expect(bulk({ action: "discard", items: [{ postId: "a", expectedStatus: "planned" }] })).toMatchObject({ status: 400, json: { error: "invalid_field", field: "action" } });
    expect(bulk({ action: "approve_copy", items: [] })).toMatchObject({ status: 400, json: { field: "items" } });
    expect(bulk({ action: "approve_copy", items: Array.from({ length: 51 }, () => ({ postId: "a", expectedStatus: "proofread" })) })).toMatchObject({ status: 400, json: { field: "items" } });
  });
});

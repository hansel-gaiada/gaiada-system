import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-1a: the demo store answers the allocation and brand-book routes, in the server's order of checks (validation 400, then 404, then 409). It reads
// the current month's cycle from the settings store, which seeds from the day it is first touched, so the clock is pinned to mid-month (Friday 16
// October 2026, midday in Singapore) before it is imported (hence vi.hoisted). Only Date is faked.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { socialDemo } from "./demoSocial";
import { asAllocationRows, asAllocationRow } from "./socialAllocation";
import { asBrandBook } from "./socialBrandBook";

const call = (method: string, path: string, body?: unknown, q: Record<string, string> = {}) =>
  socialDemo(method, `/api/co-agency/modules/social/${path}`, new URLSearchParams(q), body === undefined ? undefined : JSON.stringify(body));

describe("GET allocation", () => {
  it("lists the three demo clients with their allocation, this cycle's counts and canPlan (the demo user is the superadmin)", () => {
    const r = call("GET", "allocation");
    expect(r?.status).toBe(200);
    const rows = asAllocationRows(r?.json);
    expect(rows.map((x) => x.engagementId)).toEqual(["soc-eng-1", "soc-eng-3", "soc-eng-4"]);
    expect(rows.every((x) => x.canPlan)).toBe(true);
    expect(rows[0]).toMatchObject({
      clientName: "Northwind Traders", officer: { id: "u-social", name: "Komang Lestari" }, postsPerCycle: 12, creativeSource: "creatives", deliveryBatch: "B",
      reportFormat: "email", reportDueDay: 5, defaultPostTime: "09:30",
    });
    expect(rows[0].thisCycle).toMatchObject({ month: "2026-10", target: 12, counted: 7, extra: 0, stories: 1 }); // SCP-2 added a reel and a story waiting on Northwind
    expect(rows[1]).toMatchObject({ clientName: "Saltmarsh Day Spa", officer: { id: "u-social-2" }, creativeSource: "in_team", postsPerCycle: 8 });
    expect(rows[1].thisCycle).toMatchObject({ target: 8, counted: 2 });
    expect(rows.map((x) => x.creativeSource)).toEqual(["creatives", "in_team", "creatives"]); // one on the in-team designer, two on Creatives
  });

  it("mine=1 keeps the caller's clients (the default caller is nobody's officer), and mine is validated", () => {
    expect(asAllocationRows(call("GET", "allocation", undefined, { mine: "1" })?.json)).toEqual([]);
    const asOfficer = socialDemo("GET", "/api/co-agency/modules/social/allocation", new URLSearchParams({ mine: "1" }), undefined, "u-social");
    expect(asAllocationRows(asOfficer?.json).map((x) => x.engagementId)).toEqual(["soc-eng-1", "soc-eng-4"]);
    expect(asAllocationRows(asOfficer?.json).every((x) => !x.canPlan)).toBe(true); // an officer is not an approver
    expect(call("GET", "allocation", undefined, { mine: "maybe" })).toMatchObject({ status: 400, json: { field: "mine" } });
  });
});

describe("PATCH engagements/:id/allocation", () => {
  it("validates every field before it looks anything up, and names the field", () => {
    const bad = (body: unknown) => call("PATCH", "engagements/soc-eng-1/allocation", body);
    expect(bad({ postsPerCycle: 201 })).toMatchObject({ status: 400, json: { error: "invalid_field", field: "postsPerCycle" } });
    expect(bad({ postsPerCycle: 1.5 })).toMatchObject({ status: 400, json: { field: "postsPerCycle" } });
    expect(bad({ creativeSource: "agency" })).toMatchObject({ status: 400, json: { field: "creativeSource" } });
    expect(bad({ deliveryBatch: "C" })).toMatchObject({ status: 400, json: { field: "deliveryBatch" } });
    expect(bad({ reportFormat: "post" })).toMatchObject({ status: 400, json: { field: "reportFormat" } });
    expect(bad({ reportDueDay: 0 })).toMatchObject({ status: 400, json: { field: "reportDueDay" } });
    expect(bad({ reportDueDay: 32 })).toMatchObject({ status: 400, json: { field: "reportDueDay" } });
    expect(bad({ platforms: ["instagram", "myspace"] })).toMatchObject({ status: 400, json: { field: "platforms" } });
    expect(bad({ formats: ["gif"] })).toMatchObject({ status: 400, json: { field: "formats" } });
    expect(bad({ defaultPostTime: "25:00" })).toMatchObject({ status: 400, json: { field: "defaultPostTime" } });
    expect(bad({ stepEstimates: { hod: 31 } })).toMatchObject({ status: 400, json: { field: "stepEstimates" } });
    expect(bad({ stepEstimates: { review: 1 } })).toMatchObject({ status: 400, json: { field: "stepEstimates" } });
    expect(bad({ thisCycle: null })).toMatchObject({ status: 400, json: { error: "unknown_field", field: "thisCycle" } });
    expect(bad({ canPlan: true })).toMatchObject({ status: 400, json: { error: "unknown_field", field: "canPlan" } });
    expect(bad({})).toMatchObject({ status: 400, json: { error: "no_fields" } });
    // a bad body on a missing engagement is still 400 (validation first), a good one is 404
    expect(call("PATCH", "engagements/ghost/allocation", { postsPerCycle: 999 })).toMatchObject({ status: 400 });
    expect(call("PATCH", "engagements/ghost/allocation", { postsPerCycle: 3 })).toMatchObject({ status: 404, json: { error: "engagement_not_found" } });
  });

  it("409 officer_not_member for someone who is not one of the company's members", () => {
    expect(call("PATCH", "engagements/soc-eng-1/allocation", { officerId: "u-stranger" })).toMatchObject({ status: 409, json: { error: "officer_not_member" } });
    expect(asAllocationRows(call("GET", "allocation")?.json)[0].officer?.id).toBe("u-social"); // nothing was written
  });

  it("saves any subset and answers the row, leaving the rest as it was; a step-estimates object replaces the old one", () => {
    const r = call("PATCH", "engagements/soc-eng-3/allocation", { officerId: "u-social", postsPerCycle: 9, platforms: ["instagram", "tiktok", "instagram"], stepEstimates: { design: 4 } });
    expect(r?.status).toBe(200);
    const row = asAllocationRow(r?.json);
    expect(row).toMatchObject({ officer: { id: "u-social", name: "Komang Lestari" }, postsPerCycle: 9, platforms: ["instagram", "tiktok"], stepEstimates: { design: 4 } });
    expect(row.creativeSource).toBe("in_team"); // untouched
    expect(row.reportFormat).toBe("meeting"); // untouched
    expect(row.thisCycle).toMatchObject({ target: 9 }); // this cycle's target follows
    // nulls clear the optional fields
    const cleared = asAllocationRow(call("PATCH", "engagements/soc-eng-3/allocation", { reportFormat: null, reportDueDay: null, defaultPostTime: null, deliveryBatch: null, officerId: null, stepEstimates: {} })?.json);
    expect(cleared).toMatchObject({ reportFormat: null, reportDueDay: null, defaultPostTime: null, deliveryBatch: null, officer: null, stepEstimates: {} });
  });
});

describe("GET and PATCH brand-profiles/:clientId", () => {
  it("answers the brand book of the demo client, with the tone summary and hashtag sets also inside their jsonb", () => {
    const r = call("GET", "brand-profiles/cl-1");
    expect(r?.status).toBe(200);
    const raw = r?.json as { tone: Record<string, unknown>; hashtagStrategy: Record<string, unknown> };
    expect(raw.tone.summary).toBe("Warm, direct and a little playful.");
    expect(Array.isArray(raw.hashtagStrategy.sets)).toBe(true);
    const book = asBrandBook(r?.json);
    expect(book.toneSummary).toBe("Warm, direct and a little playful.");
    expect(book.contentPillars).toEqual(["Behind the scenes", "Product stories"]);
    expect(book.hashtagSets[0]).toEqual({ name: "Always", tags: ["northwind", "madewithcare"] });
  });

  it("404 for a client with no profile yet, and the first PATCH creates it", () => {
    expect(call("GET", "brand-profiles/cl-new")).toMatchObject({ status: 404 });
    expect(call("PATCH", "brand-profiles/cl-new", { contentPillars: ["One"] })?.status).toBe(200);
    expect(asBrandBook(call("GET", "brand-profiles/cl-new")?.json).contentPillars).toEqual(["One"]);
  });

  it("validates each field with 400 {field}; nothing is written on a refusal", () => {
    const bad = (body: unknown) => call("PATCH", "brand-profiles/cl-1", body);
    expect(bad({ toneSummary: "x".repeat(201) })).toMatchObject({ status: 400, json: { error: "invalid_field", field: "toneSummary" } });
    expect(bad({ contentPillars: Array.from({ length: 21 }, (_, i) => `p${i}`) })).toMatchObject({ status: 400, json: { field: "contentPillars" } });
    expect(bad({ brandRules: ["x".repeat(301)] })).toMatchObject({ status: 400, json: { field: "brandRules" } });
    expect(bad({ hashtagSets: [{ name: "A", tags: ["#bad"] }] })).toMatchObject({ status: 400, json: { field: "hashtagSets" } });
    expect(bad({ channels: [{ network: "myspace", handle: "x" }] })).toMatchObject({ status: 400, json: { field: "channels" } });
    expect(bad({ keyDates: [{ date: "13-40", label: "x" }] })).toMatchObject({ status: 400, json: { field: "keyDates" } });
    expect(bad({ links: [{ label: "x", url: "ftp://nope" }] })).toMatchObject({ status: 400, json: { field: "links" } });
    expect(bad({})).toMatchObject({ status: 400, json: { error: "no_fields" } });
    expect(asBrandBook(call("GET", "brand-profiles/cl-1")?.json).brandRules).toEqual(["No discount wording"]);
  });

  it("an absent field is untouched, and a tone summary or hashtag-set write keeps the sibling keys of its jsonb", () => {
    const before = call("GET", "brand-profiles/cl-1")?.json as { tone: Record<string, unknown>; hashtagStrategy: Record<string, unknown> };
    expect(call("PATCH", "brand-profiles/cl-1", { toneSummary: "Calm and clear.", hashtagSets: [{ name: "Launch", tags: ["new"] }] })?.status).toBe(200);
    const after = call("GET", "brand-profiles/cl-1")?.json as { tone: Record<string, unknown>; hashtagStrategy: Record<string, unknown>; contentPillars: string[] };
    expect(after.tone).toEqual({ ...before.tone, summary: "Calm and clear." });
    expect(after.tone.traits).toEqual(["warm", "direct"]); // the sibling key survived
    expect(after.hashtagStrategy).toEqual({ ...before.hashtagStrategy, sets: [{ name: "Launch", tags: ["new"] }] });
    expect(after.hashtagStrategy.maxCount).toBe(5);
    expect(after.contentPillars).toEqual(["Behind the scenes", "Product stories"]); // absent field untouched
    // a whole-object `tone` write without a summary keeps the stored summary; an empty toneSummary clears only that key
    call("PATCH", "brand-profiles/cl-1", { tone: { traits: ["calm"] } });
    expect((call("GET", "brand-profiles/cl-1")?.json as { tone: Record<string, unknown> }).tone).toEqual({ traits: ["calm"], summary: "Calm and clear." });
    call("PATCH", "brand-profiles/cl-1", { toneSummary: "" });
    expect((call("GET", "brand-profiles/cl-1")?.json as { tone: Record<string, unknown> }).tone).toEqual({ traits: ["calm"] });
  });
});

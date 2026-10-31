import { describe, it, expect } from "vitest";
import {
  IDEA_WRITE_REASON, METRIC_MAX, SAW_MAX, SUGGESTION_MAX, actionsFor, asIdea, asIdeaAnswer, asIdeaList, buildIdeaBody, cycleChoiceOf, emptyIdeaForm, ideaRefusalText, ideaStatusWords, planMonths,
} from "./socialIdeas";
import { REFUSAL_WORDS } from "./socialPipeline";

// SCP-5 W5-A4 (BFF §63.25): the ideas' answers, the three states in words, which actions a state and the read's `canWrite` allow, the form's checks and the cycle picker's months.

const idea = (over: Record<string, unknown> = {}) => ({
  id: "i1", engagementId: "e1", saw: "Reels got most replies", metric: "Reply rate", suggestion: "Plan two more reels", status: "proposed", reportId: "r1", post: null,
  sharedAt: null, sharedBy: null, createdBy: { id: "u1", name: "Dewi" }, createdAt: "2026-10-02T04:00:00Z", ...over,
});

describe("the ideas read", () => {
  it("is parsed with its post and who shared it, and carries the server's canWrite", () => {
    const list = asIdeaList({ items: [idea(), idea({ id: "i2", status: "planned", post: { id: "p1", title: "Two more reels", pipelineStatus: "planned", cycleMonth: "2026-11" } })], canWrite: true });
    expect(list.canWrite).toBe(true);
    expect(list.items[1].post).toEqual({ id: "p1", title: "Two more reels", pipelineStatus: "planned", cycleMonth: "2026-11" });
    expect(list.items[0]).toMatchObject({ saw: "Reels got most replies", metric: "Reply rate", reportId: "r1", createdBy: { id: "u1", name: "Dewi" } });
    expect(asIdeaList({ items: [] }).canWrite).toBe(false); // no flag: never claimed
  });
  it("throws on a body that is not a list of ideas, so the page says it cannot tell", () => {
    expect(() => asIdeaList({})).toThrow();
    expect(() => asIdeaList({ items: [{ id: "x" }] })).toThrow();
    expect(() => asIdeaAnswer({})).toThrow();
    expect(asIdeaAnswer({ idea: idea() }).id).toBe("i1");
    expect(asIdea(idea({ metric: null })).metric).toBeNull();
  });
});

describe("the three states, in the design's words", () => {
  it("names them, and shows one it does not know as it came", () => {
    expect(["proposed", "shared", "planned"].map(ideaStatusWords)).toEqual(["Proposed", "Shared with client", "Added to plan"]);
    expect(ideaStatusWords("archived")).toBe("archived");
  });
});

describe("which actions an idea shows", () => {
  it("a proposed idea can be shared, planned and deleted; a shared one planned and deleted; a planned one nothing", () => {
    expect(actionsFor({ status: "proposed" }, true)).toEqual({ plan: true, share: true, remove: true });
    expect(actionsFor({ status: "shared" }, true)).toEqual({ plan: true, share: false, remove: true });
    expect(actionsFor({ status: "planned" }, true)).toEqual({ plan: false, share: false, remove: false });
  });
  it("nothing is shown to a person the read says may not write", () => {
    expect(actionsFor({ status: "proposed" }, false)).toEqual({ plan: false, share: false, remove: false });
  });
});

describe("the add form", () => {
  const f = (o: Partial<ReturnType<typeof emptyIdeaForm>> = {}) => ({ ...emptyIdeaForm(), saw: "Saw it", metric: "Reach", suggestion: "Do it", ...o });
  it("trims, and carries the report's id when it was raised from a report", () => {
    expect(buildIdeaBody(f({ saw: "  Saw it  " }), { metricRequired: true, reportId: "r1" })).toEqual({ ok: true, body: { saw: "Saw it", metric: "Reach", suggestion: "Do it", reportId: "r1" } });
    expect(buildIdeaBody(f(), { metricRequired: true })).toEqual({ ok: true, body: { saw: "Saw it", metric: "Reach", suggestion: "Do it" } });
  });
  it("requires what we saw and what we suggest, and the metric when the company says so; a blank metric is null when it does not", () => {
    expect(buildIdeaBody(f({ saw: "  " }), { metricRequired: true })).toMatchObject({ ok: false, field: "saw" });
    expect(buildIdeaBody(f({ suggestion: "" }), { metricRequired: true })).toMatchObject({ ok: false, field: "suggestion" });
    expect(buildIdeaBody(f({ metric: " " }), { metricRequired: true })).toMatchObject({ ok: false, field: "metric", message: "Name the metric this rests on." });
    expect(buildIdeaBody(f({ metric: " " }), { metricRequired: false })).toMatchObject({ ok: true, body: { metric: null } });
  });
  it("holds the server's lengths, counted in characters", () => {
    expect(buildIdeaBody(f({ saw: "x".repeat(SAW_MAX + 1) }), { metricRequired: true })).toMatchObject({ ok: false, field: "saw" });
    expect(buildIdeaBody(f({ saw: "x".repeat(SAW_MAX) }), { metricRequired: true }).ok).toBe(true);
    expect(buildIdeaBody(f({ metric: "x".repeat(METRIC_MAX + 1) }), { metricRequired: true })).toMatchObject({ ok: false, field: "metric" });
    expect(buildIdeaBody(f({ suggestion: "x".repeat(SUGGESTION_MAX + 1) }), { metricRequired: true })).toMatchObject({ ok: false, field: "suggestion" });
    expect(buildIdeaBody(f({ suggestion: "😀".repeat(SUGGESTION_MAX) }), { metricRequired: true }).ok).toBe(true);
  });
});

describe("the cycle picker", () => {
  it("offers the months after the report month, the next open one first, and none that is already over", () => {
    expect(planMonths("2026-10", "2026-10-20")).toEqual(["2026-11", "2026-12", "2027-01"]);
    // a report for last month, viewed in November: this month's plan is still open and is after the report
    expect(planMonths("2026-10", "2026-11-03")).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(planMonths("2026-08", "2026-11-03")).toEqual(["2026-11"]);
  });
  it("an old report still offers this month and the next, never an empty picker", () => {
    expect(planMonths("2026-01", "2026-11-03")).toEqual(["2026-11", "2026-12"]);
  });
  it("takes the client's cycle of a month from the deadline table, or none", () => {
    const rows = [{ engagementId: "e1", cycleId: "c1" }, { engagementId: "e2", cycleId: null }];
    expect(cycleChoiceOf(rows, "e1", "2026-11")).toEqual({ cycleId: "c1", month: "2026-11" });
    expect(cycleChoiceOf(rows, "e2", "2026-11")).toBeNull();
    expect(cycleChoiceOf(rows, "e3", "2026-11")).toBeNull();
  });
});

describe("the refusals, in words", () => {
  it("a 403 says who may write ideas, and an unattended automation keeps its own sentence", () => {
    expect(ideaRefusalText({ status: 403, error: "not_officer_or_approver" })).toBe(`You cannot do this. ${IDEA_WRITE_REASON}`);
    expect(ideaRefusalText({ status: 403, error: "automation_cannot_act" })).toBe(REFUSAL_WORDS.automation_cannot_act);
  });
  it("words the ideas' own codes, never the bare code", () => {
    expect(ideaRefusalText({ status: 409, error: "idea_planned" }, "delete")).toBe(REFUSAL_WORDS.idea_planned);
    expect(ideaRefusalText({ status: 409, error: "cycle_closed" }, "plan")).toBe(REFUSAL_WORDS.cycle_closed);
    expect(ideaRefusalText({ status: 404, error: "idea_not_found" }, "share")).toBe(REFUSAL_WORDS.idea_not_found);
    expect(ideaRefusalText({ status: 404, error: "cycle_not_found" }, "plan")).toMatch(/no plan for that month/);
    expect(ideaRefusalText({ status: 404, error: "engagement_not_found" })).toMatch(/client was not found/);
    for (const code of ["idea_not_found", "idea_planned", "cycle_closed"]) expect(REFUSAL_WORDS[code], code).toMatch(/\.$/);
  });
  it("a 400 names the field", () => {
    expect(ideaRefusalText({ status: 400, error: "missing_field", field: "metric" })).toMatch(/required by your company's rules/);
    expect(ideaRefusalText({ status: 400, error: "invalid_field", field: "reportId" })).toMatch(/monthly report of the same client/);
    expect(ideaRefusalText({ status: 400, error: "invalid_field", field: "cycleId" })).toBe("Pick the plan month first.");
  });
});

import { describe, it, expect } from "vitest";
import { ACTION_DIALOG, REFUSAL_WORDS } from "./socialPipeline";
import type { AllocationRow } from "./socialAllocation";
import type { CycleRow, Health } from "./socialCycles";
import { RING_TOKEN, asFeedPage, dueWords, mainButtonOf, ordinal, reportsDue, ringWords, storyCircles } from "./socialHome";

// SCP-1d: the Social Media Home's pure rules. The server decides who may do what (`nextAction.allowed`, the table's `canPlan`); these tests pin what the Home makes of
// the answers: which button a card draws, which clients get a circle and in what order, and the due days of the reports.

const card = (over: Record<string, unknown> = {}) => ({
  id: "p-1", engagementId: "e-1", clientName: "Northwind Traders", title: "Autumn teaser", format: "feed", isExtra: false, isStory: false, thumbFileId: null,
  pipelineStatus: "drafting", phase: "in_production", holder: { role: "officer", label: "The officer" }, yourTurn: true, health: null, scheduledAt: null,
  statusSince: "2026-10-12T04:00:00.000Z", nextAction: { action: "start_draft", allowed: true }, simulated: false, ...over,
});
const health = (state: Health["state"], over: Partial<Health> = {}): Health => ({ state, spareDays: null, lateDays: null, lateWith: null, latestSafeHandoff: null, readyBy: "2026-10-30", ...over });

describe("asFeedPage", () => {
  it("reads the cards and says whether more are behind the page", () => {
    const page = asFeedPage({ items: [card(), card({ id: "p-2", health: { state: "late", lateDays: 2, lateWith: "designer", readyBy: "2026-10-10" } })], nextCursor: "abc" });
    expect(page.items.map((c) => c.id)).toEqual(["p-1", "p-2"]);
    expect(page.items[1].health).toMatchObject({ state: "late", lateDays: 2, lateWith: "designer" });
    expect(page.hasMore).toBe(true);
    expect(asFeedPage({ items: [], nextCursor: null }).hasMore).toBe(false);
  });

  it("throws on a body that is not a page, so the reader says it cannot tell instead of showing an empty list", () => {
    expect(() => asFeedPage(null)).toThrow();
    expect(() => asFeedPage({ cards: [] })).toThrow();
    expect(() => asFeedPage([])).toThrow();
  });

  it("drops a card with no id or no status, and keeps the reason of a refused next action", () => {
    const page = asFeedPage({ items: [{ title: "no id" }, card({ id: "" }), card({ pipelineStatus: undefined }), card({ nextAction: { action: "approve_copy", allowed: false, reason: "author_cannot_approve" } })] });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].nextAction).toEqual({ action: "approve_copy", allowed: false, reason: "author_cannot_approve" });
  });

  it("reads a card with no next action as null", () => {
    expect(asFeedPage({ items: [card({ nextAction: null })] }).items[0].nextAction).toBeNull();
  });
});

describe("mainButtonOf", () => {
  it("is a live run for an allowed action that asks for nothing", () => {
    expect(ACTION_DIALOG.start_draft).toBeNull();
    expect(mainButtonOf({ nextAction: { action: "start_draft", allowed: true } })).toEqual({ kind: "run", action: "start_draft", label: "Start draft" });
  });

  it("opens the post for an allowed action that needs a note, a date or the checks first", () => {
    for (const action of ["send_to_proofread", "return_copy", "mark_live", "schedule", "record_client_change"]) {
      expect(ACTION_DIALOG[action], action).not.toBeNull();
      expect(mainButtonOf({ nextAction: { action, allowed: true } }).kind, action).toBe("open");
    }
  });

  it("opens the post for an allowed action the page has no entry for, never runs it blind", () => {
    expect(mainButtonOf({ nextAction: { action: "brand_new_step", allowed: true } })).toMatchObject({ kind: "open", label: "brand_new_step" });
  });

  it("is refused, with the reason in words, when the server says not allowed", () => {
    const b = mainButtonOf({ nextAction: { action: "approve_copy", allowed: false, reason: "author_cannot_approve" } });
    expect(b).toEqual({ kind: "refused", action: "approve_copy", label: "Approve copy", reason: REFUSAL_WORDS.author_cannot_approve });
    expect(mainButtonOf({ nextAction: { action: "approve_copy", allowed: false } })).toMatchObject({ kind: "refused", reason: "You cannot take this step." });
  });

  it("has no button for a card with no next action", () => {
    expect(mainButtonOf({ nextAction: null })).toEqual({ kind: "none" });
  });
});

describe("the story circles", () => {
  const row = (id: string, name: string, officer: string | null, h: Health | null): CycleRow => ({
    engagementId: id, clientName: name, officer: officer ? { id: officer, name: officer } : null, deliveryBatch: "A", cycleId: h ? `cy-${id}` : null, deadline: null, readyBy: null,
    prefill: { deadline: null, batch: null }, target: 10, counts: { counted: 0, planned: 0, inProduction: 0, withClient: 0, clientChanges: 0, approved: 0, scheduled: 0, live: 0, extra: 0, stories: 0 }, health: h,
  });
  const rows = [
    row("e-1", "Brand Alpha", "u-1", health("on_track", { spareDays: 3 })),
    row("e-2", "Brand Beta", "u-1", health("late", { lateDays: 2, lateWith: "designer" })),
    row("e-3", "Brand Gamma", "u-9", health("tight")),
    row("e-4", "Brand Delta", "u-1", null),
    row("e-5", "Brand Epsilon", null, health("at_risk")),
  ];

  it("gives an officer a circle for each of their own clients only, the worst state first and a client with no cycle last", () => {
    const c = storyCircles({ rows, canPlan: false }, "u-1");
    expect(c.map((x) => x.clientName)).toEqual(["Brand Beta", "Brand Alpha", "Brand Delta"]);
    expect(c.map((x) => x.state)).toEqual(["late", "on_track", "none"]);
  });

  it("gives one of the four approvers (canPlan) every client, the worst first, their own before others of the same state", () => {
    const c = storyCircles({ rows, canPlan: true }, "u-1");
    expect(c.map((x) => x.clientName)).toEqual(["Brand Beta", "Brand Epsilon", "Brand Gamma", "Brand Alpha", "Brand Delta"]);
  });

  it("gives someone who is nobody's officer no circles", () => {
    expect(storyCircles({ rows, canPlan: false }, "u-copy")).toEqual([]);
  });

  it("writes every state in words, so the ring's colour is never the only signal", () => {
    expect(ringWords(health("late", { lateDays: 2, lateWith: "designer" }))).toBe("Late · 2 days · with the designer");
    expect(ringWords(health("on_track", { spareDays: 3 }))).toBe("On track · 3 spare days");
    expect(ringWords(null)).toBe("No cycle this month");
  });

  it("draws every ring with the existing status token of its state, never a colour of its own", () => {
    expect(RING_TOKEN).toMatchObject({
      on_track: "var(--status-ok)", tight: "var(--status-warning)", at_risk: "var(--status-critical)", late: "var(--status-danger)", done: "var(--status-idle)",
    });
    for (const v of Object.values(RING_TOKEN)) expect(v).toMatch(/^var\(--/);
  });
});

describe("reports due", () => {
  const alloc = (id: string, name: string, day: number | null, fmt: AllocationRow["reportFormat"] = "email"): AllocationRow => ({
    engagementId: id, clientId: `c-${id}`, clientName: name, status: "active", officer: { id: "u-1", name: "Sam" }, postsPerCycle: 10, creativeSource: "creatives", deliveryBatch: "A",
    reportFormat: fmt, reportDueDay: day, platforms: [], formats: [], defaultPostTime: null, stepEstimates: {}, thisCycle: null, canPlan: false,
  });

  it("lists each client with a due day, soonest first, with the days left from today", () => {
    const r = reportsDue([alloc("e-1", "Brand Alpha", 20), alloc("e-2", "Brand Beta", 5), alloc("e-3", "Brand Gamma", null), alloc("e-4", "Brand Delta", 16)], "2026-10-16");
    expect(r.map((x) => [x.clientName, x.dueIso, x.daysLeft])).toEqual([["Brand Beta", "2026-10-05", -11], ["Brand Delta", "2026-10-16", 0], ["Brand Alpha", "2026-10-20", 4]]);
  });

  it("clamps a due day the month does not have to its last day", () => {
    const r = reportsDue([alloc("e-1", "Brand Alpha", 31)], "2026-02-10");
    expect(r[0].dueIso).toBe("2026-02-28");
    expect(r[0].dueDay).toBe(31);
  });

  it("says when a report is due in words", () => {
    expect(dueWords(0)).toBe("Due today");
    expect(dueWords(1)).toBe("Due tomorrow");
    expect(dueWords(4)).toBe("Due in 4 days");
    expect(dueWords(-1)).toBe("Was due yesterday");
    expect(dueWords(-11)).toBe("Was due 11 days ago");
  });

  it("writes the ordinal of a day", () => {
    expect([1, 2, 3, 4, 5, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "5th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
  });
});

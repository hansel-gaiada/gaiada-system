import { describe, it, expect } from "vitest";
import { computeUrgency, urgencyBand, rankByUrgency, type QueueItem } from "./queueUrgency";

const NOW = new Date("2026-07-22T12:00:00Z");
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
const due = (daysFromNow: number) => new Date(NOW.getTime() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

function item(partial: Partial<QueueItem> & Pick<QueueItem, "id" | "type">): QueueItem {
  return {
    title: "x", companyId: "co-a", company: "A", createdAt: iso(0), decidable: true, urgencyScore: 0,
    ...partial,
  };
}

describe("computeUrgency — UX-2 §1.4 default weighting", () => {
  it("ranks the 4 documented tiers: approvals/gates first, then overdue tasks, then due-today, then the rest by age", () => {
    // Our data model gives approvals/gates no due date at all, so "overdue
    // approvals/gates first" is read as tier 1 = every pending approval/gate;
    // within that tier, older still outranks newer (a2 30d old > a1 5d old).
    const overdueApproval = item({ id: "a1", type: "approval", dueDate: undefined, createdAt: iso(5) });
    const overdueGate = item({ id: "g1", type: "gate", dueDate: due(-2), createdAt: iso(2) });
    const staleApprovalNoDue = item({ id: "a2", type: "approval", dueDate: undefined, createdAt: iso(30) });
    const overdueTask = item({ id: "t1", type: "task", dueDate: due(-1), createdAt: iso(1) });
    const dueTodayTask = item({ id: "t2", type: "task", dueDate: due(0), createdAt: iso(1) });
    const freshMention = item({ id: "m1", type: "mention", createdAt: iso(0) });

    const ranked = rankByUrgency([freshMention, dueTodayTask, staleApprovalNoDue, overdueTask, overdueGate, overdueApproval], NOW);
    expect(ranked.map((r) => r.id)).toEqual(["a2", "a1", "g1", "t1", "t2", "m1"]);
    // tier boundaries strictly separate (no in-tier modifier can cross one)
    expect(ranked[2].urgencyScore).toBeGreaterThan(ranked[3].urgencyScore); // last approval/gate > overdue task
    expect(ranked[3].urgencyScore).toBeGreaterThan(ranked[4].urgencyScore); // overdue task > due-today task
    expect(ranked[4].urgencyScore).toBeGreaterThan(ranked[5].urgencyScore); // due-today task > the rest
  });

  it("within the overdue-task tier, more overdue scores higher", () => {
    const a = item({ id: "a", type: "task", dueDate: due(-1) });
    const b = item({ id: "b", type: "task", dueDate: due(-10) });
    expect(computeUrgency(b, NOW)).toBeGreaterThan(computeUrgency(a, NOW));
    // both still safely inside the overdue-task tier, below approval/gate tier
    expect(computeUrgency(a, NOW)).toBeLessThan(30_000);
  });

  it("within a tier, older items outrank newer ones of the same type/date (age tie-break)", () => {
    const older = item({ id: "o", type: "approval", createdAt: iso(10) });
    const newer = item({ id: "n", type: "approval", createdAt: iso(0) });
    expect(computeUrgency(older, NOW)).toBeGreaterThan(computeUrgency(newer, NOW));
  });

  it("in tier 4, age dominates a same-age proximity nudge (never crosses a full day of age)", () => {
    const soonerDue = item({ id: "s", type: "task", dueDate: due(2), createdAt: iso(5) });
    const olderNoDue = item({ id: "n", type: "task", dueDate: undefined, createdAt: iso(6) });
    expect(computeUrgency(olderNoDue, NOW)).toBeGreaterThan(computeUrgency(soonerDue, NOW));
  });

  it("is a pure function — never mutates the input", () => {
    const i = item({ id: "p", type: "task", urgencyScore: 0 });
    const before = { ...i };
    computeUrgency(i, NOW);
    expect(i).toEqual(before);
  });
});

describe("urgencyBand", () => {
  it("approvals/gates are always NOW regardless of due date", () => {
    expect(urgencyBand(item({ id: "1", type: "approval" }), NOW)).toBe("now");
    expect(urgencyBand(item({ id: "2", type: "gate", dueDate: due(5) }), NOW)).toBe("now");
  });
  it("an overdue task is NOW; a due-today task is TODAY; anything else is SOON", () => {
    expect(urgencyBand(item({ id: "3", type: "task", dueDate: due(-1) }), NOW)).toBe("now");
    expect(urgencyBand(item({ id: "4", type: "task", dueDate: due(0) }), NOW)).toBe("today");
    expect(urgencyBand(item({ id: "5", type: "task", dueDate: due(3) }), NOW)).toBe("soon");
    expect(urgencyBand(item({ id: "6", type: "mention" }), NOW)).toBe("soon");
  });
});

describe("rankByUrgency", () => {
  it("breaks exact ties deterministically by id, so re-renders never jitter row order", () => {
    const a = item({ id: "b-item", type: "mention", createdAt: iso(3) });
    const b = item({ id: "a-item", type: "mention", createdAt: iso(3) });
    const ranked = rankByUrgency([a, b], NOW);
    expect(ranked.map((r) => r.id)).toEqual(["a-item", "b-item"]);
  });
});

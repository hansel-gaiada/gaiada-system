import { describe, it, expect } from "vitest";
import { needsYouSummary } from "./needsYouSummary";
import type { QueueItem, QueueItemType } from "./queueUrgency";

const mk = (id: string, type: QueueItemType): QueueItem => ({
  id, type, title: id, companyId: "c", company: "C", createdAt: "2026-10-01", decidable: true, urgencyScore: 0,
});
const many = (type: QueueItemType, n: number) => Array.from({ length: n }, (_, i) => mk(`${type}${i}`, type));

describe("needsYouSummary", () => {
  it("counts approvals and gates together as 'to decide'", () => {
    expect(needsYouSummary([...many("approval", 2), ...many("gate", 1)]).line).toBe("3 to decide");
  });
  it("words each kind, singular and plural", () => {
    expect(needsYouSummary(many("task", 1)).line).toBe("1 task");
    expect(needsYouSummary(many("task", 3)).line).toBe("3 tasks");
    expect(needsYouSummary(many("conversation", 1)).line).toBe("1 reply");
    expect(needsYouSummary(many("conversation", 2)).line).toBe("2 replies");
    expect(needsYouSummary(many("alert", 1)).line).toBe("1 KPI alert");
    expect(needsYouSummary(many("alert", 4)).line).toBe("4 KPI alerts");
    expect(needsYouSummary(many("mention", 1)).line).toBe("1 mention");
    expect(needsYouSummary(many("mention", 2)).line).toBe("2 mentions");
  });
  it("puts the most urgent kinds first", () => {
    const items = [...many("alert", 1), ...many("conversation", 1), ...many("task", 3), ...many("approval", 2)];
    expect(needsYouSummary(items).line).toBe("2 to decide, 3 tasks, 1 reply, 1 KPI alert");
  });
  it("carries at most four parts", () => {
    const items = [...many("approval", 1), ...many("task", 1), ...many("conversation", 1), ...many("alert", 1), ...many("mention", 5)];
    expect(needsYouSummary(items).line).toBe("1 to decide, 1 task, 1 reply, 1 KPI alert");
  });
  it("marks something waiting", () => {
    expect(needsYouSummary(many("task", 1)).waiting).toBe(true);
  });
  it("empty and every source answered: nothing, no dot", () => {
    expect(needsYouSummary([])).toEqual({ line: "Nothing needs you right now", waiting: false });
  });
  it("empty but a company could not be read: never 'nothing'", () => {
    expect(needsYouSummary([], ["Agency"])).toEqual({ line: "Some sources could not be read", waiting: false });
  });
});

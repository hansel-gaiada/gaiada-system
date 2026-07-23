import { describe, it, expect } from "vitest";
import { buildChips, applyQueueFilter } from "./CommandCenterHome";
import type { QueueItem } from "@/lib/queueUrgency";

const NOW = new Date("2026-07-22T12:00:00Z");
const due = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString().slice(0, 10);

function item(p: Partial<QueueItem> & Pick<QueueItem, "id" | "type">): QueueItem {
  return { title: "x", companyId: "co-a", company: "A", createdAt: "2026-01-01", decidable: true, urgencyScore: 0, ...p };
}

const items: QueueItem[] = [
  item({ id: "1", type: "task", dueDate: due(-2) }),   // overdue
  item({ id: "2", type: "task", dueDate: due(0) }),     // due today
  item({ id: "3", type: "approval" }),
  item({ id: "4", type: "gate" }),
  item({ id: "5", type: "mention" }),
  item({ id: "6", type: "task", dueDate: due(5) }),     // due soon, not in any chip
];

describe("buildChips", () => {
  it("counts overdue/due-today tasks, approvals+gates, and mentions", () => {
    const chips = buildChips(items, NOW);
    expect(Object.fromEntries(chips.map((c) => [c.key, c.count]))).toEqual({
      overdue: 1, due_today: 1, approvals: 2, mentions: 1,
    });
  });
});

describe("applyQueueFilter", () => {
  it("undefined filter returns every item unchanged", () => {
    expect(applyQueueFilter(items, undefined, NOW)).toEqual(items);
  });
  it("each filter narrows to exactly its chip's items", () => {
    expect(applyQueueFilter(items, "overdue", NOW).map((i) => i.id)).toEqual(["1"]);
    expect(applyQueueFilter(items, "due_today", NOW).map((i) => i.id)).toEqual(["2"]);
    expect(applyQueueFilter(items, "approvals", NOW).map((i) => i.id)).toEqual(["3", "4"]);
    expect(applyQueueFilter(items, "mentions", NOW).map((i) => i.id)).toEqual(["5"]);
  });
});

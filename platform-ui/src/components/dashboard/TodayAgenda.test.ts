import { describe, it, expect } from "vitest";
import { bucketAgenda } from "./TodayAgenda";
import type { QueueItem } from "@/lib/queueUrgency";

const NOW = new Date("2026-07-22T12:00:00Z");
const due = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString().slice(0, 10);

function item(p: Partial<QueueItem> & Pick<QueueItem, "id" | "type">): QueueItem {
  return { title: "x", companyId: "co-a", company: "A", createdAt: "2026-01-01", decidable: true, urgencyScore: 0, ...p };
}

describe("bucketAgenda", () => {
  it("buckets overdue/today/tomorrow/later/no-date, dropping empty buckets, never dropping an item", () => {
    const items: QueueItem[] = [
      item({ id: "1", type: "task", dueDate: due(-3) }),
      item({ id: "2", type: "task", dueDate: due(0) }),
      item({ id: "3", type: "task", dueDate: due(1) }),
      item({ id: "4", type: "task", dueDate: due(9) }),
      item({ id: "5", type: "task" }), // no due date
    ];
    const buckets = bucketAgenda(items, NOW);
    expect(buckets.map((b) => b.key)).toEqual(["overdue", "today", "tomorrow", "later", "no_date"]);
    expect(buckets.reduce((n, b) => n + b.items.length, 0)).toBe(items.length);
    expect(buckets.find((b) => b.key === "overdue")?.items.map((i) => i.id)).toEqual(["1"]);
    expect(buckets.find((b) => b.key === "no_date")?.items.map((i) => i.id)).toEqual(["5"]);
  });

  it("omits empty buckets entirely (no zero-count sections)", () => {
    const buckets = bucketAgenda([item({ id: "1", type: "task", dueDate: due(0) })], NOW);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].key).toBe("today");
  });

  it("an invalid due-date string degrades to no_date rather than crashing", () => {
    const buckets = bucketAgenda([item({ id: "1", type: "task", dueDate: "not-a-date" })], NOW);
    expect(buckets[0].key).toBe("no_date");
  });
});

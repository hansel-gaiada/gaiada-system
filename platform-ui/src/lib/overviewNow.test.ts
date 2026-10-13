import { describe, it, expect } from "vitest";
import { NEEDS_YOU_LIMIT, dueTodayItems, selectNeedsYou } from "./overviewNow";
import type { QueueItem } from "./queueUrgency";

const NOW = new Date(2026, 9, 13, 10, 0);
const DAY = 24 * 3600 * 1000;
// Local noon of the day `offset` days from NOW, so the queue's local-day arithmetic is the same in any time zone.
const day = (offset: number) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset, 12).toISOString();
const item = (id: string, type: QueueItem["type"], extra: Partial<QueueItem> = {}): QueueItem => ({
  id, type, title: id, companyId: "co-a", company: "Agency", createdAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
  decidable: true, urgencyScore: 0, ...extra,
});

describe("selectNeedsYou", () => {
  it("ranks by the queue's own urgency: approvals first, then overdue, then due today, then the rest", () => {
    const { all } = selectNeedsYou([
      item("rest", "task", { dueDate: day(5) }),
      item("today", "task", { dueDate: day(0) }),
      item("late", "task", { dueDate: day(-2) }),
      item("approve", "approval"),
      item("mention", "mention"),
    ], 6, NOW);
    expect(all.map((i) => i.id)).toEqual(["approve", "late", "today", "rest", "mention"]);
  });

  it("puts the longer-overdue task ahead of the shorter one", () => {
    const { all } = selectNeedsYou([item("a", "task", { dueDate: day(-1) }), item("b", "task", { dueDate: day(-9) })], 6, NOW);
    expect(all.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("takes the top six by default and keeps the whole ranked list in `all`", () => {
    const many = Array.from({ length: 9 }, (_, i) => item(`t${i}`, "task", { dueDate: day(-(i + 1)) }));
    const r = selectNeedsYou(many, undefined, NOW);
    expect(NEEDS_YOU_LIMIT).toBe(6);
    expect(r.top).toHaveLength(6);
    expect(r.all).toHaveLength(9);
    expect(r.total).toBe(9);
    // The top six are the six most overdue.
    expect(r.top.map((i) => i.id)).toEqual(["t8", "t7", "t6", "t5", "t4", "t3"]);
  });

  it("returns everything when there are fewer than the limit, and nothing for nothing", () => {
    expect(selectNeedsYou([item("a", "approval")], 6, NOW).top).toHaveLength(1);
    expect(selectNeedsYou([], 6, NOW)).toEqual({ all: [], top: [], total: 0 });
  });

  it("keeps an id once, so a ball task added a second time never doubles a row", () => {
    const ball = item("pmtask:co-a:t1", "task", { dueDate: day(0) });
    const r = selectNeedsYou([ball, item("approve", "approval"), { ...ball }], 6, NOW);
    expect(r.all.map((i) => i.id)).toEqual(["approve", "pmtask:co-a:t1"]);
    expect(r.total).toBe(2);
  });

  it("does not change its input", () => {
    const input = [item("a", "task"), item("b", "approval")];
    selectNeedsYou(input, 6, NOW);
    expect(input.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("dueTodayItems", () => {
  it("keeps the dated items due today, and drops overdue, future, undated, mentions and approvals", () => {
    const out = dueTodayItems([
      item("today", "task", { dueDate: day(0) }),
      item("late", "task", { dueDate: day(-1) }),
      item("tomorrow", "task", { dueDate: day(1) }),
      item("undated", "task"),
      item("mention", "mention"),
      item("approve", "approval"),
    ], NOW);
    expect(out.map((i) => i.id)).toEqual(["today"]);
  });

  it("is empty when nothing is due today", () => {
    expect(dueTodayItems([item("a", "task", { dueDate: day(3) })], NOW)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { AgendaTaskRow } from "@/lib/agenda";
import { groupMyTasks, isFinishedStatus, todayIsoOf } from "./myTasks";

const row = (id: string, dueDate: string | null, status = "todo"): AgendaTaskRow => ({
  id, title: id, status, dueDate, tenantId: "co-a", company: "Co A", source: "task", href: `/tasks/${id}`,
});

describe("groupMyTasks", () => {
  const TODAY = "2026-10-14";
  it("puts yesterday, today, today+6, today+7 and no date in their own groups", () => {
    const groups = groupMyTasks([
      row("none", null), row("later", "2026-10-21"), row("week", "2026-10-20"), row("today", "2026-10-14"), row("late", "2026-10-13"),
    ], TODAY);
    expect(groups.map((g) => [g.key, g.label, g.rows.map((r) => r.id)])).toEqual([
      ["overdue", "Overdue", ["late"]],
      ["today", "Today", ["today"]],
      ["week", "This week", ["week"]],
      ["later", "Later", ["later"]],
      ["none", "No due date", ["none"]],
    ]);
  });
  it("omits empty groups and keeps the reader's order inside a group", () => {
    const groups = groupMyTasks([row("b", "2026-10-01"), row("a", "2026-09-01")], TODAY);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
  it("returns no groups for no rows", () => {
    expect(groupMyTasks([], TODAY)).toEqual([]);
  });
  it("crosses month and year ends", () => {
    expect(groupMyTasks([row("x", "2027-01-02")], "2026-12-31")[0].key).toBe("week");
    expect(groupMyTasks([row("x", "2026-12-31")], "2027-01-01")[0].key).toBe("overdue");
  });
});

describe("isFinishedStatus", () => {
  it("treats done, completed and cancelled-like statuses as finished", () => {
    for (const s of ["done", "Done", "complete", "completed", "closed", "cancelled", "canceled", "archived"]) expect(isFinishedStatus(s)).toBe(true);
  });
  it("treats open and unknown statuses as open", () => {
    for (const s of ["todo", "in_progress", "blocked", "backlog", "something-new", "", null, undefined]) expect(isFinishedStatus(s)).toBe(false);
  });
  it("splits open from done in a list", () => {
    const rows = [row("a", null, "todo"), row("b", null, "done"), row("c", null, "cancelled")];
    expect(rows.filter((r) => !isFinishedStatus(r.status)).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("todayIsoOf", () => {
  // The display zone defaults to Asia/Singapore (UTC+8) unless NEXT_PUBLIC_DISPLAY_TZ says otherwise.
  const zoned = !process.env.NEXT_PUBLIC_DISPLAY_TZ;
  it.runIf(zoned)("names the display zone's date, not the runtime's (00:00 to 08:00 there is still yesterday in UTC)", () => {
    expect(todayIsoOf(new Date(Date.UTC(2026, 9, 13, 20, 30)))).toBe("2026-10-14");
    expect(todayIsoOf(new Date(Date.UTC(2026, 9, 14, 15, 59)))).toBe("2026-10-14");
    expect(todayIsoOf(new Date(Date.UTC(2026, 9, 14, 16, 0)))).toBe("2026-10-15");
  });
  it("zero-pads month and day", () => {
    expect(todayIsoOf(new Date(Date.UTC(2026, 0, 5, 4, 0)))).toMatch(/^2026-01-0[45]$/);
  });
});

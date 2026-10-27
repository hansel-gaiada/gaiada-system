import { describe, it, expect } from "vitest";
import type { ReportDue } from "./socialHome";
import { HOME_REPORT_CARDS_MAX, reportReminders } from "./socialHomeReminders";

// SCP-Ki: the report cards' window (3 days ago to a week ahead) and cap.
const due = (daysLeft: number, id = `e${daysLeft}`): ReportDue => ({ engagementId: id, clientName: id, dueDay: 1, dueIso: "2026-10-01", daysLeft, format: null });

describe("reportReminders", () => {
  it("keeps -3 and 7, drops -4 and 8", () => {
    const r = reportReminders([due(-4), due(-3), due(7), due(8)]);
    expect(r.cards.map((c) => c.daysLeft)).toEqual([-3, 7]);
    expect(r.more).toBe(0);
  });

  it("keeps the input order, caps at three and counts the in-window rest", () => {
    expect(HOME_REPORT_CARDS_MAX).toBe(3);
    const r = reportReminders([due(-2), due(0), due(1), due(4), due(6), due(30)]);
    expect(r.cards.map((c) => c.daysLeft)).toEqual([-2, 0, 1]);
    expect(r.more).toBe(2);
  });

  it("is empty for nothing in the window", () => {
    expect(reportReminders([])).toEqual({ cards: [], more: 0 });
    expect(reportReminders([due(-10), due(20)])).toEqual({ cards: [], more: 0 });
  });
});

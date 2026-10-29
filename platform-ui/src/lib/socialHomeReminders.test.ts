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

// SCP-5a: a report that is SENT is no longer due, so its card is dropped; the window and the cap still apply to what is left.
describe("reportReminders and the month's reports", () => {
  const rep = (engagementId: string, status: string, over: Record<string, unknown> = {}) => ({ id: `r-${engagementId}`, engagementId, status, kind: "monthly", period: "2026-09", ...over });
  const month = (...rows: ReturnType<typeof rep>[]) => ({ period: "2026-09", rows });

  it("drops the card of a client whose report for the month is delivered, and keeps the others", () => {
    const r = reportReminders([due(-1, "e1"), due(0, "e2"), due(2, "e3")], month(rep("e1", "delivered"), rep("e2", "in_review")));
    expect(r.cards.map((c) => c.engagementId)).toEqual(["e2", "e3"]);
    expect(r.more).toBe(0);
  });
  it("a card carries the month's report (its id and state) when there is one, and none when there is not", () => {
    const r = reportReminders([due(0, "e2"), due(1, "e3")], month(rep("e2", "approved")));
    expect(r.cards).toMatchObject([{ engagementId: "e2", reportId: "r-e2", reportStatus: "approved" }, { engagementId: "e3", reportId: null, reportStatus: null }]);
  });
  it("only the month's own monthly report counts: another month's or another kind's delivered report does not drop the card", () => {
    const r = reportReminders([due(0, "e1"), due(0, "e2")], month(rep("e1", "delivered", { period: "2026-08" }), rep("e2", "delivered", { kind: "campaign" })));
    expect(r.cards.map((c) => c.engagementId)).toEqual(["e1", "e2"]);
  });
  it("fills the three cards from the ones that are still due, and counts the rest", () => {
    const rows = [due(0, "a"), due(0, "b"), due(1, "c"), due(2, "d"), due(3, "e")];
    const r = reportReminders(rows, month(rep("a", "delivered")));
    expect(r.cards.map((c) => c.engagementId)).toEqual(["b", "c", "d"]);
    expect(r.more).toBe(1);
  });
  it("keeps every card when the month's reports could not be read (nothing says it was sent)", () => {
    expect(reportReminders([due(0, "e1")], null).cards.map((c) => c.engagementId)).toEqual(["e1"]);
    expect(reportReminders([due(0, "e1")]).cards).toHaveLength(1);
  });
});

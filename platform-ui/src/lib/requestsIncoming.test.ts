import { describe, it, expect } from "vitest";
import {
  ageText, deliveredOnly, isNeededByOverdue, originsByChangeRequest, requestsPageView, type RequestRow, type WorkState,
} from "./requests";
import { workspaceFor } from "./workspaces";

// DW-5d / DW-5e: the pure parts of the receiving department's pages.

const unit = (id: string, name: string | null) => ({ id, name, unitMissing: name === null });
const row = (over: Partial<RequestRow> & { id: string }): RequestRow => ({
  kind: "assets", title: "Banners", status: "open", neededBy: null, createdAt: "2026-10-01T00:00:00Z", closedAt: null,
  fromUnit: unit("d-mkt", "Marketing"), toUnit: unit("d-cre", "Creatives"), requestedBy: { id: "u1", name: "Ayu" },
  campaign: null, work: { state: "removed" }, assetCount: 0, ...over,
});
const crWork = (id: string): WorkState => ({ state: "live", work: { type: "change_request", id, status: "new", route: null } });

describe("requestsPageView: the department switch", () => {
  const view = (name: string) => requestsPageView(workspaceFor("agency", name).key);
  it("sends Creatives to Incoming, Web Dev to triage, and everyone else to today's page", () => {
    expect(view("Creatives")).toBe("creatives");
    expect(view("Web Dev")).toBe("web-dev");
    expect(view("SEO")).toBe("other");
    expect(view("Brand Studio")).toBe("other");
  });
});

describe("deliveredOnly", () => {
  const rows = [
    row({ id: "a", status: "delivered", closedAt: "2026-10-02T00:00:00Z" }),
    row({ id: "b", status: "declined", closedAt: "2026-10-09T00:00:00Z" }),
    row({ id: "c", status: "delivered", closedAt: "2026-10-08T00:00:00Z" }),
    row({ id: "d", status: "cancelled", closedAt: "2026-10-03T00:00:00Z" }),
  ];
  it("keeps delivered ones, newest delivery first, and counts the others", () => {
    const r = deliveredOnly(rows);
    expect(r.delivered.map((x) => x.id)).toEqual(["c", "a"]);
    expect(r.otherClosed).toBe(2);
  });
  it("is empty, with no others, for an empty list", () => {
    expect(deliveredOnly([])).toEqual({ delivered: [], otherClosed: 0 });
  });
});

describe("originsByChangeRequest (DW-5e join)", () => {
  it("maps a change request id to its request, department and person", () => {
    const m = originsByChangeRequest([
      row({ id: "r1", kind: "engineering", work: crWork("cr-1"), requestedBy: { id: "u", name: "Dana" } }),
      row({ id: "r2", kind: "engineering", work: { state: "removed" } }),
      row({ id: "r3", kind: "assets", work: { state: "live", work: { type: "pm_task", id: "t", projectId: null, status: "todo", isDone: false, responsibleName: null } } }),
    ]);
    expect(m).toEqual({ "cr-1": { requestId: "r1", from: "Marketing", person: "Dana" } });
  });
  it("says a department that left the chart rather than blank", () => {
    const m = originsByChangeRequest([row({ id: "r1", work: crWork("cr-1"), fromUnit: unit("x", null) })]);
    expect(m["cr-1"].from).toMatch(/no longer in the org chart/);
  });
});

describe("ageText and isNeededByOverdue", () => {
  const now = new Date(2026, 9, 14, 12, 0, 0);
  it("words the age", () => {
    expect(ageText(new Date(2026, 9, 14, 8).toISOString(), now)).toBe("Today");
    expect(ageText(new Date(2026, 9, 13, 8).toISOString(), now)).toBe("1 day");
    expect(ageText(new Date(2026, 9, 9, 12).toISOString(), now)).toBe("5 days");
    expect(ageText(null, now)).toBe("—");
  });
  it("marks only a date before today", () => {
    expect(isNeededByOverdue("2026-10-10", now)).toBe(true);
    expect(isNeededByOverdue(new Date(2026, 9, 14, 18).toISOString(), now)).toBe(false);
    expect(isNeededByOverdue(null, now)).toBe(false);
  });
});

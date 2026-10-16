import { describe, it, expect } from "vitest";
import { COMPANY_NOTICES_KEY, NOTICES_KEY, noticesBlockView, noticesWidgetPlaced } from "./overviewNotices";
import { COMPANY_OVERVIEW, GENERIC_WORKSPACE, WORKSPACES } from "./workspaces";
import type { NoticeList, NoticeRow } from "./notices";
import type { ReadResult } from "./readResult";

// DW-10a-2: where the Notices blocks are placed and how a read becomes a block.

const NOW = Date.parse("2026-10-16T12:00:00Z");
const row = (id: string, over: Partial<NoticeRow> = {}): NoticeRow => ({
  id, scope: "unit", unitNodeId: "dept-1", unitName: "Web Dev", title: `Title ${id}`, body: `Body ${id}`, pinned: false, endsOn: null, state: "current",
  author: { id: "u1", name: "Ketut" }, createdAt: "2026-10-16T09:00:00.000Z", editedAt: null, canEdit: false, ...over,
});
const ok = (...items: NoticeRow[]): ReadResult<NoticeList> => ({ kind: "ok", data: { items, nextCursor: null } });

describe("where the blocks are placed", () => {
  it("places the department block only for a workspace with an org node, and leaves every other key alone", () => {
    expect(noticesWidgetPlaced(NOTICES_KEY, { deptId: "dept-1" })).toBe(true);
    expect(noticesWidgetPlaced(NOTICES_KEY, { deptId: null })).toBe(false);
    expect(noticesWidgetPlaced("today", { deptId: null })).toBe(true);
    expect(noticesWidgetPlaced(COMPANY_NOTICES_KEY, { deptId: null })).toBe(true);
  });

  it("registers `notices` in every department workspace and `company-notices` in the company frame, band now right after Today, fixed (DW-D34)", () => {
    for (const ws of [...WORKSPACES, GENERIC_WORKSPACE]) {
      const company = ws.overview === COMPANY_OVERVIEW;
      const now = ws.overview.filter((w) => w.band === "now").map((w) => w.key);
      const key = company ? COMPANY_NOTICES_KEY : NOTICES_KEY;
      const w = ws.overview.find((x) => x.key === key);
      expect(w, ws.key).toMatchObject({ band: "now", placement: "fixed" });
      expect(w?.gate, ws.key).toBeUndefined();
      expect(now.indexOf(key), ws.key).toBe(now.indexOf("today") + 1);
      // The other block never appears in the wrong frame: the Office of the GM (a workspace WITH a node) has the company's, never the department's,
      // so a department read can never narrow the company's notices to the GM's office.
      expect(ws.overview.some((x) => x.key === (company ? NOTICES_KEY : COMPANY_NOTICES_KEY)), ws.key).toBe(false);
    }
  });
});

describe("noticesBlockView", () => {
  it("says unavailable for a refused read and for a failed one, never an empty block", () => {
    expect(noticesBlockView({ kind: "forbidden" }, true, "dept-1", NOW)).toEqual({ kind: "unavailable" });
    expect(noticesBlockView({ kind: "unavailable", reason: "boom" }, false, "dept-1", NOW)).toEqual({ kind: "unavailable" });
  });

  it("draws nothing for a successful empty read when the person may not post", () => {
    expect(noticesBlockView(ok(), false, "dept-1", NOW)).toEqual({ kind: "hidden" });
  });

  it("draws 'No current notices' with the post link for a successful empty read when the person may post", () => {
    expect(noticesBlockView(ok(), true, "dept-1", NOW)).toEqual({ kind: "ok", rows: [], canPost: true });
  });

  it("shows at most three current notices, pinned first, with the unit label, the age, the excerpt and the link", () => {
    const v = noticesBlockView(ok(
      row("a", { createdAt: "2026-10-16T11:00:00.000Z" }),
      row("b", { pinned: true, body: "x".repeat(300) }),
      row("c", { scope: "company", unitNodeId: null, unitName: null }),
      row("d", { unitNodeId: "div", unitName: "Engineering" }),
    ), false, "dept-1", NOW);
    expect(v.kind).toBe("ok");
    if (v.kind !== "ok") return;
    expect(v.rows.map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(v.rows[0]).toMatchObject({ pinned: true, unitLabel: "Web Dev", age: "3 h ago", href: "/departments/dept-1/notices#b" });
    expect([...v.rows[0].excerpt]).toHaveLength(141);
    expect(v.rows[1]).toMatchObject({ pinned: false, age: "1 h ago" });
    expect(v.rows[2]).toMatchObject({ unitLabel: "Whole company", href: "/notices#c" });
  });

  it("says From <unit> for a notice posted to a unit above, and drops a notice the read marked past", () => {
    const v = noticesBlockView(ok(row("up", { unitNodeId: "div", unitName: "Engineering" }), row("old", { state: "past" })), false, "dept-1", NOW);
    expect(v).toMatchObject({ kind: "ok", rows: [{ id: "up", unitLabel: "From Engineering" }] });
    // Only a past notice came back: nothing is current, so it is the empty case.
    expect(noticesBlockView(ok(row("old", { state: "past" })), false, "dept-1", NOW)).toEqual({ kind: "hidden" });
  });
});

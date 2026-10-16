import { describe, it, expect } from "vitest";
import {
  BODY_MAX, EXCERPT_MAX, TITLE_MAX, checkNoticeForm, formatNoticeDay, mayPostNotice, noticeAge, noticeErrorText, noticeExcerpt, noticeHref,
  noticePostedLine, noticeUnitLabel, noticesPastHref, noticesUnitHref, parseNoticeState, pinnedFirst,
} from "./notices";
import type { Me } from "./platform";

// DW-10a-2 (BFF §57): the pure half of the notice board. The rules here are what the pages, the Overview blocks, the form and the Inbox share.

const me = (roles: Me["roles"]): Me => ({ userId: "u1", assurance: "high", roles, companies: [{ id: "co-a", name: "Agency", type: "agency" }] }) as Me;
const admin = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
const head = me([{ role: "member", scopeType: "company", scopeId: "co-a" }, { role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }]);
const member = me([{ role: "member", scopeType: "company", scopeId: "co-a" }]);
const owner = me([{ role: "owner", scopeType: "company", scopeId: "co-a" }]);

describe("noticeHref (the backend's `href`)", () => {
  it("is the unit's board for a unit notice and the company board for a company-wide one", () => {
    expect(noticeHref("unit", "dept-1", "n1")).toBe("/departments/dept-1/notices#n1");
    expect(noticeHref("company", null, "n2")).toBe("/notices#n2");
  });
  it("encodes the unit id and treats a unit notice with no unit as company-wide, exactly as the backend does", () => {
    expect(noticeHref("unit", "a b/c", "n1")).toBe("/departments/a%20b%2Fc/notices#n1");
    expect(noticeHref("unit", null, "n1")).toBe("/notices#n1");
    expect(noticesUnitHref("dept-1")).toBe("/departments/dept-1/notices");
    expect(noticesPastHref("/notices")).toBe("/notices?state=past");
  });
});

describe("parseNoticeState", () => {
  it("is past only for exactly `past`, so a hand-typed value never reaches the backend as a 400", () => {
    expect(parseNoticeState("past")).toBe("past");
    expect(parseNoticeState(["past", "current"])).toBe("past");
    for (const v of ["current", "PAST", "all", "", undefined, null]) expect(parseNoticeState(v)).toBe("current");
  });
});

describe("noticeUnitLabel", () => {
  const unit = (id: string, name: string | null) => ({ scope: "unit" as const, unitNodeId: id, unitName: name });
  it("says Whole company for a company-wide notice", () => {
    expect(noticeUnitLabel({ scope: "company", unitNodeId: null, unitName: null }, "dept-1")).toBe("Whole company");
  });
  it("says From <unit> for a notice posted to a unit above the one being looked at, and the unit's own name for its own", () => {
    expect(noticeUnitLabel(unit("div", "Engineering"), "dept-1")).toBe("From Engineering");
    expect(noticeUnitLabel(unit("dept-1", "Web Dev"), "dept-1")).toBe("Web Dev");
    expect(noticeUnitLabel(unit("dept-1", "Web Dev"), null)).toBe("Web Dev");
  });
  it("names a unit that left the tree, and still shows the notice", () => {
    expect(noticeUnitLabel(unit("gone", null), "dept-1")).toBe("From a former unit");
    expect(noticeUnitLabel(unit("gone", null), "gone")).toBe("A former unit");
  });
});

describe("noticePostedLine (the Inbox)", () => {
  it("reads <unit>: <title> for a unit notice and Whole company: <title> for a company-wide one", () => {
    expect(noticePostedLine("notice.posted", { title: "Release freeze", scope: "unit", unitNodeId: "dept-1", unitName: "Web Dev" })).toBe("Web Dev: Release freeze");
    expect(noticePostedLine("notice.posted", { title: "Office closed", scope: "company", unitNodeId: null, unitName: null })).toBe("Whole company: Office closed");
  });
  it("names a unit that left the tree", () => {
    expect(noticePostedLine("notice.posted", { title: "Hello", scope: "unit", unitName: null })).toBe("a former unit: Hello");
  });
  it("is null for any other type, and for a payload with no title, so the row keeps its own words", () => {
    expect(noticePostedLine("calendar.invite", { title: "x" })).toBeNull();
    expect(noticePostedLine("notice.posted", { scope: "company" })).toBeNull();
    expect(noticePostedLine("notice.posted", { title: 5 })).toBeNull();
    expect(noticePostedLine("notice.posted", null)).toBeNull();
  });
});

describe("dates and ages", () => {
  it("writes a day as `14 Oct 2026` with no Intl, and nothing for a day that is not one", () => {
    expect(formatNoticeDay("2026-10-14")).toBe("14 Oct 2026");
    expect(formatNoticeDay("2026-01-05")).toBe("5 Jan 2026");
    for (const v of ["", "2026-13-01", "2026-10-1", "nope", null, undefined]) expect(formatNoticeDay(v as string)).toBe("");
  });
  it("ages a time in minutes, hours and days, then gives the date", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(noticeAge(at(10_000), now)).toBe("Just now");
    expect(noticeAge(at(5 * 60_000), now)).toBe("5 min ago");
    expect(noticeAge(at(3 * 3_600_000), now)).toBe("3 h ago");
    expect(noticeAge(at(2 * 86_400_000), now)).toBe("2 d ago");
    expect(noticeAge("2026-09-01T10:00:00Z", now)).toBe("1 Sep 2026");
    expect(noticeAge("garbage", now)).toBe("");
  });
});

describe("noticeExcerpt", () => {
  it("collapses whitespace and cuts at 140 characters with an ellipsis", () => {
    expect(noticeExcerpt("a\n\nb   c")).toBe("a b c");
    const long = "x".repeat(300);
    const out = noticeExcerpt(long);
    expect([...out]).toHaveLength(EXCERPT_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
    expect(noticeExcerpt("x".repeat(EXCERPT_MAX))).toBe("x".repeat(EXCERPT_MAX));
  });
  it("is plain text: markup stays as typed", () => {
    expect(noticeExcerpt("<b>bold</b> **x**")).toBe("<b>bold</b> **x**");
  });
});

describe("pinnedFirst", () => {
  it("puts pins first and otherwise keeps the order it was given", () => {
    const rows = [{ id: "a", pinned: false }, { id: "b", pinned: true }, { id: "c", pinned: false }, { id: "d", pinned: true }];
    expect(pinnedFirst(rows).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("mayPostNotice (a mirror of Cerbos, never the authority)", () => {
  it("offers a company admin the form on any unit and company-wide", () => {
    expect(mayPostNotice(admin, "co-a", ["d-web", "root"])).toBe(true);
    expect(mayPostNotice(admin, "co-a", null)).toBe(true);
  });
  it("offers a head the form on their own unit and the units below it, never company-wide", () => {
    expect(mayPostNotice(head, "co-a", ["d-web", "root"])).toBe(true);
    expect(mayPostNotice(head, "co-a", ["d-web-fe", "d-web", "root"])).toBe(true);
    expect(mayPostNotice(head, "co-a", ["d-seo", "root"])).toBe(false);
    expect(mayPostNotice(head, "co-a", null)).toBe(false);
  });
  it("offers a member nothing, and a pure owner nothing (the policy's permission arm is read only)", () => {
    for (const who of [member, owner]) {
      expect(mayPostNotice(who, "co-a", ["d-web", "root"])).toBe(false);
      expect(mayPostNotice(who, "co-a", null)).toBe(false);
    }
  });
  it("does not carry a head's grant into another company", () => {
    expect(mayPostNotice(head, "co-b", ["d-web", "root"])).toBe(false);
  });
});

describe("checkNoticeForm", () => {
  const ok = { title: "  Hello  ", body: "Line one\r\nLine two  ", pinned: true, endsOn: "" };
  it("trims, keeps line breaks (as LF) and turns an empty end date into none", () => {
    expect(checkNoticeForm(ok)).toEqual({ ok: true, title: "Hello", body: "Line one\nLine two", pinned: true, endsOn: null });
    expect(checkNoticeForm({ ...ok, endsOn: "2026-12-31" })).toMatchObject({ ok: true, endsOn: "2026-12-31" });
  });
  it("refuses a missing title or body, an over-long one, and a date that is not one, naming the field", () => {
    expect(checkNoticeForm({ ...ok, title: "   " })).toMatchObject({ ok: false, field: "title" });
    expect(checkNoticeForm({ ...ok, title: "x".repeat(TITLE_MAX + 1) })).toMatchObject({ ok: false, field: "title" });
    expect(checkNoticeForm({ ...ok, title: "x".repeat(TITLE_MAX) })).toMatchObject({ ok: true });
    expect(checkNoticeForm({ ...ok, body: "" })).toMatchObject({ ok: false, field: "body" });
    expect(checkNoticeForm({ ...ok, body: "x".repeat(BODY_MAX + 1) })).toMatchObject({ ok: false, field: "body" });
    expect(checkNoticeForm({ ...ok, endsOn: "2026-02-30" })).toMatchObject({ ok: false, field: "endsOn" });
    expect(checkNoticeForm({ ...ok, endsOn: "tomorrow" })).toMatchObject({ ok: false, field: "endsOn" });
  });
  it("counts characters, not UTF-16 units", () => {
    expect(checkNoticeForm({ ...ok, title: "😀".repeat(TITLE_MAX) })).toMatchObject({ ok: true });
  });
});

describe("noticeErrorText (the server's refusals, in words)", () => {
  it("words a 409 pin_limit for the unit and for the company", () => {
    expect(noticeErrorText({ status: 409, message: "pin_limit", field: "pinned" }, "unit")).toMatch(/This unit already has 3 pinned notices/);
    expect(noticeErrorText({ status: 409, message: "pin_limit" }, "company")).toMatch(/The company already has 3 pinned notices/);
  });
  it("words a 403 by scope", () => {
    expect(noticeErrorText({ status: 403, message: "forbidden" }, "unit")).toMatch(/head and company admins/);
    expect(noticeErrorText({ status: 403, message: "forbidden" }, "company")).toMatch(/Only a company admin/);
  });
  it("words the two 404s", () => {
    expect(noticeErrorText({ status: 404, message: "unit_not_found", field: "unitNodeId" })).toMatch(/not in this company's structure/);
    expect(noticeErrorText({ status: 404, message: "notice_not_found" })).toMatch(/no longer exists, or it was withdrawn/);
  });
  it("passes a 400's own sentence through", () => {
    expect(noticeErrorText({ status: 400, message: "endsOn must not be before today", field: "endsOn" })).toBe("endsOn must not be before today");
  });
});

import { describe, it, expect } from "vitest";
import { meStripTabs, showMeStrip } from "./meTabs";
import { YOU_ROWS } from "@/lib/workspaces";
import { HOTEL, me, member } from "@/lib/workspaceFixtures";

const agencyEmployee = me([member()]);
const hotelEmployee = me([member("co-h")], [HOTEL]);

describe("meStripTabs (DW-8d)", () => {
  it("is the registry's Me row, in order, for a company that has timesheets", () => {
    const tabs = meStripTabs({ me: agencyEmployee, tenantId: "co-a", unitPath: [] });
    expect(tabs.map((t) => t.label)).toEqual(["Summary", "Leave", "Loans", "Pay", "Timesheet", "Account"]);
    const row = YOU_ROWS.find((r) => r.key === "me")!;
    expect(tabs.map((t) => t.href)).toEqual(row.tabs.map((t) => t.href));
  });

  it("drops Timesheet where the company has no timesheets row", () => {
    const tabs = meStripTabs({ me: hotelEmployee, tenantId: "co-h", unitPath: [] });
    expect(tabs.map((t) => t.label)).toEqual(["Summary", "Leave", "Loans", "Pay", "Account"]);
  });
});

describe("showMeStrip (DW-8d)", () => {
  const tabs = meStripTabs({ me: agencyEmployee, tenantId: "co-a", unitPath: [] });

  it.each(["/me", "/me/leave", "/me/loans", "/me/loans/l-1", "/me/pay", "/timesheets", "/account", "/me?x=1"])(
    "shows on %s", (path) => expect(showMeStrip(path, tabs)).toBe(true),
  );

  it.each(["/me/inbox", "/me/tasks", "/me/learning", "/me/inbox?filter=unread", "/approvals"])(
    "does not show on %s", (path) => expect(showMeStrip(path, tabs)).toBe(false),
  );

  it("does not show on /timesheets when the company has no Timesheet tab", () => {
    const hotel = meStripTabs({ me: hotelEmployee, tenantId: "co-h", unitPath: [] });
    expect(showMeStrip("/timesheets", hotel)).toBe(false);
  });
});

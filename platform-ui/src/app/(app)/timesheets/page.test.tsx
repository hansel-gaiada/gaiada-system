import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-8n: /timesheets is also Me › Timesheet, a personal tab, so it shows your OWN time by default. The company view is a
// choice for people who read department-level reports. Found by PV-7: the page used to ask for every entry in the company.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-self") }));
const meMock = vi.fn();
vi.mock("@/lib/platform", () => ({ getMe: (...a: unknown[]) => meMock(...a) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
const listTime = vi.fn(async () => []);
vi.mock("@/lib/entities", () => ({
  listTimeEntries: (...a: unknown[]) => listTime(...(a as [])),
  listProjects: vi.fn(async () => []),
}));
vi.mock("@/lib/clientWorkActions", () => ({ logTimeEntryAction: vi.fn() }));
vi.mock("@/components/forms/ClientWorkForms", () => ({ TimeEntryForm: () => null }));

import TimesheetsPage from "./page";
import { timesheetView } from "@/lib/timesheetView";

const member = { userId: "u-self", roles: [{ role: "member", scopeType: "company", scopeId: "co-a" }], companies: [] };
const admin = { userId: "u-self", roles: [{ role: "company_admin", scopeType: "company", scopeId: "co-a" }], companies: [] };

describe("timesheetView", () => {
  it("is your own time unless the company view is asked for AND allowed", () => {
    expect(timesheetView(undefined, true)).toBe("mine");
    expect(timesheetView("everyone", true)).toBe("everyone");
    expect(timesheetView("everyone", false)).toBe("mine");
    expect(timesheetView("anything", true)).toBe("mine");
  });
});

describe("/timesheets", () => {
  beforeEach(() => { listTime.mockClear(); });

  it("reads only the caller's own entries by default", async () => {
    meMock.mockResolvedValue(member);
    await TimesheetsPage({ searchParams: Promise.resolve({}) });
    expect(listTime).toHaveBeenCalledWith("u-self", "co-a", { mine: true });
  });

  it("a member who asks for everyone still gets their own", async () => {
    meMock.mockResolvedValue(member);
    await TimesheetsPage({ searchParams: Promise.resolve({ view: "everyone" }) });
    expect(listTime).toHaveBeenCalledWith("u-self", "co-a", { mine: true });
  });

  it("someone who reads department reports can choose the company view", async () => {
    meMock.mockResolvedValue(admin);
    await TimesheetsPage({ searchParams: Promise.resolve({ view: "everyone" }) });
    expect(listTime).toHaveBeenCalledWith("u-self", "co-a", {});
  });
});

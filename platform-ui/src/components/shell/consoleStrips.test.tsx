import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SectionTabs, type SectionTab } from "./SectionTabs";
import { FinanceTabs } from "@/components/finance/FinanceTabs";
import { DeptTabs } from "./DeptTabs";
import { bespokeToolkit, visibleGroups, type DeptGroup } from "@/lib/deptToolkits";
import { adminShellModel, inShell } from "./workspaceShellTestKit";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

beforeEach(() => {
  window.sessionStorage.clear();
});

// DW-2b: a console strip hides inside the workspace shell only when the shell's rows offer every one of
// its tabs (plan §2.6 rule 1). The tab lists below mirror the layouts that draw them (app/(app)/hr,
// it, it/network, me, admin layout files); the shell side is the real registry through `buildShellModel`.

const tab = (key: string, href: string): SectionTab => ({ key, label: key, href, icon: "home" });

// hr/layout.tsx without the two payroll tabs, with the Org structure tab for the active company. Since DW-7a the registry
// gates some HR, IT and Finance tabs on the capability their page reads; the shell still hides a console strip for a person
// it gates them away from (`covers` counts a withheld tab as covered), so one strip draws, never two. The tests use a company
// admin (offered every tab) and a plain member (offered fewer, the rest withheld).
const HR_TABS = [
  tab("overview", "/hr"), tab("people", "/hr/people"), tab("leave", "/hr/leave"), tab("attendance", "/hr/attendance"),
  tab("onboarding", "/hr/onboarding"), tab("cases", "/hr/cases"), tab("recruitment", "/hr/recruitment"), tab("reviews", "/hr/reviews"),
  tab("compliance", "/hr/compliance"), tab("analytics", "/hr/analytics"), tab("settings", "/hr/settings"), tab("org", "/companies/co-a/org"),
];
const IT_TABS = [
  tab("overview", "/it"), tab("devices", "/it/devices"), tab("topology", "/it/topology"), tab("network", "/it/network"),
  tab("workflows", "/it/workflows"), tab("accounts", "/it/accounts"),
];
const NETWORK_TABS = [
  tab("connected", "/it/network/presence"), tab("sign-ins", "/it/network"), tab("alerts", "/it/network/threats"), tab("blocks", "/it/network/rules"),
];
const ME_TABS = [
  tab("summary", "/me"), tab("leave", "/me/leave"), tab("loans", "/me/loans"), tab("pay", "/me/pay"),
  tab("timesheet", "/timesheets"), tab("account", "/account"),
];
const ADMIN_TABS = [
  tab("users", "/admin/users"), tab("identity", "/admin/identity"), tab("modules", "/admin/modules"), tab("services", "/admin/services"),
  tab("compliance", "/admin/compliance"), tab("audit", "/admin/audit"), tab("mail", "/admin/mail"), tab("about", "/admin/about"),
];

const section = () => screen.queryByRole("navigation", { name: "Section" });

describe("SectionTabs inside the workspace shell", () => {
  it.each([
    ["HR", HR_TABS, "/hr/people"],
    ["IT", IT_TABS, "/it/devices"],
    ["IT network", NETWORK_TABS, "/it/network/threats"],
    ["Me", ME_TABS, "/me/leave"],
  ])("hides the %s strip, because every tab is a row of the shell", (name, tabs, path) => {
    nav.pathname = path;
    // HR and IT hold gated tabs now; Me's rows are ungated, so the plain employee stays its own case.
    render(inShell(<SectionTabs tabs={tabs} />, name === "Me" ? undefined : adminShellModel));
    expect(section()).toBeNull();
  });

  it.each([["HR", HR_TABS, "/hr/people"], ["IT", IT_TABS, "/it/devices"]])(
    "hides the %s strip for a plain member too: the tabs the registry gates away from them are pages their read refuses (DW-7a)",
    (_name, tabs, path) => {
      nav.pathname = path;
      render(inShell(<SectionTabs tabs={tabs} />));
      expect(section()).toBeNull();
    },
  );

  it("keeps the Admin strip: its pages are not registry tabs", () => {
    // The admin is offered the Admin area (Settings is one tab, `/admin`), but none of the strip's pages.
    const offered = adminShellModel.admin.flatMap((r) => r.tabs.map((t) => t.href));
    expect(offered).toContain("/admin");
    for (const t of ADMIN_TABS) expect(offered).not.toContain(t.href);
    nav.pathname = "/admin/users";
    render(inShell(<SectionTabs tabs={ADMIN_TABS} />, adminShellModel));
    expect(section()).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "users" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps a strip when even one of its tabs is missing from the shell", () => {
    nav.pathname = "/hr/people";
    render(inShell(<SectionTabs tabs={[...HR_TABS, tab("new-tool", "/hr/not-in-the-registry")]} />));
    expect(section()).toBeInTheDocument();
  });

  it("matches a tab on its path, ignoring a query", () => {
    nav.pathname = "/hr/people";
    render(inShell(<SectionTabs tabs={[tab("people", "/hr/people?view=all")]} />));
    expect(section()).toBeNull();
  });
});

describe("SectionTabs outside the workspace shell", () => {
  it.each([["HR", HR_TABS, "/hr/people"], ["Admin", ADMIN_TABS, "/admin/users"], ["Me", ME_TABS, "/me/leave"]])(
    "always draws the %s strip",
    (_name, tabs, path) => {
      nav.pathname = path;
      render(<SectionTabs tabs={tabs} />);
      expect(section()).toBeInTheDocument();
      expect(screen.getAllByRole("link")).toHaveLength(tabs.length);
    },
  );
});

describe("FinanceTabs", () => {
  it("hides inside the workspace shell: Finance's rows offer every tab", () => {
    nav.pathname = "/finance/journals";
    render(inShell(<FinanceTabs />, adminShellModel));
    expect(screen.queryByRole("navigation", { name: "Finance sections" })).toBeNull();
  });

  it("hides for a plain member too, whom the registry offers no Reports, Receivables or Consolidation (DW-7b)", () => {
    nav.pathname = "/finance/journals";
    render(inShell(<FinanceTabs />));
    expect(screen.queryByRole("navigation", { name: "Finance sections" })).toBeNull();
  });

  it("always draws outside the workspace shell", () => {
    nav.pathname = "/finance/journals";
    render(<FinanceTabs />);
    const strip = screen.getByRole("navigation", { name: "Finance sections" });
    expect(strip).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Journals" })).toHaveAttribute("aria-current", "page");
  });
});

describe("DeptTabs", () => {
  // The layout passes the groups the viewer may see: a tab with `requires` is dropped without the right.
  const groups = visibleGroups(bespokeToolkit("web-dev")!.groups, () => false);
  const strips = () => [
    screen.queryByRole("navigation", { name: "Department sections" }),
    screen.queryByRole("navigation", { name: /tools$/ }),
  ];

  it("hides both levels inside the workspace shell when every tab is a row of the shell", () => {
    nav.pathname = "/departments/d-web/board";
    render(inShell(<DeptTabs groups={groups} deptId="d-web" />));
    expect(strips()).toEqual([null, null]);
  });

  it("keeps both levels when one tab is missing from the shell", () => {
    nav.pathname = "/departments/d-web/board";
    const extra: DeptGroup[] = [
      ...groups,
      { key: "extra", label: "Extra", icon: "box", tabs: [{ key: "extra", label: "Extra", path: "not-in-the-registry", icon: "box", blurb: "" }] },
    ];
    render(inShell(<DeptTabs groups={extra} deptId="d-web" />));
    expect(strips()[0]).toBeInTheDocument();
    expect(strips()[1]).toBeInTheDocument();
  });

  it("always draws both levels outside the workspace shell", () => {
    nav.pathname = "/departments/d-web/board";
    render(<DeptTabs groups={groups} deptId="d-web" />);
    expect(strips()[0]).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /tools$/ })).toBeInTheDocument();
  });
});

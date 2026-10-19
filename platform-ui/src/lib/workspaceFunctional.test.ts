import { describe, it, expect } from "vitest";
import type { Me } from "./platform";
import { sidebarRows, workspaceBySlug, type WorkspaceRow } from "./workspaces";
import { concreteRows, withheldTabPaths } from "./workspaceAccess";
import { me, member } from "./workspaceFixtures";

// DW-7a/7b/7c: each HR, Finance and IT row and tab is offered to the people whose page can read what it shows, through the
// capability that mirrors that read (never a new one). What a role holds is `ROLE_CAPS`, so these pin the registry's gates
// against it; the server still decides. Pages whose read has no capability stay ungated and are pinned as such.

const role = (r: string) => ({ role: r, scopeType: "company", scopeId: "co-a" });
const plainMember = me([member()]);
// A module role rides on a member grant, as a placed employee holds it.
const as = (r: string) => me([member(), role(r)]);
const moduleOff = (r: string) =>
  me([member(), role(r)], [{ id: "co-a", name: "Agency", type: null, vertical: "agency", rootCompanyId: "co-root", enabledModules: ["pm"] }]);

/** The Work and Performance rows the shell draws for a workspace, as `{row key: [tab labels]}`. */
function offered(slug: string, m: Me, deptId: string): Record<string, string[]> {
  const model = sidebarRows(workspaceBySlug(slug)!);
  const rows = concreteRows([...model.work, ...model.performance], { me: m, tenantId: "co-a", unitPath: [deptId, "root"], deptId });
  return Object.fromEntries(rows.map((r) => [r.key, r.tabs.map((t) => t.label)]));
}
const hr = (m: Me) => offered("hr", m, "d-hr-co-a");
const finance = (m: Me) => offered("finance", m, "d-finance-co-a");
const itRows = (m: Me) => offered("it", m, "d-it-co-a");

describe("HR rows (DW-7a)", () => {
  it("gives a plain member their own Time, their cases and the policy reads, but no checklists, recruitment, files or Pay", () => {
    const rows = hr(plainMember);
    expect(rows.people).toEqual(["Directory", "Org structure"]);
    expect(rows.time).toEqual(["Leave", "Attendance"]);
    expect(rows.talent).toEqual(["Reviews"]);
    expect(rows.cases).toEqual(["Cases", "Settings"]);
    expect(rows.pay).toBeUndefined();
    expect(rows.analytics).not.toContain("People analytics");
  });

  it("gives hr_staff People, Time, Talent (Recruitment, Reviews) and Cases & compliance, but not Pay", () => {
    const rows = hr(as("hr_staff"));
    expect(rows.people).toEqual(["Directory", "Onboarding", "Org structure"]);
    expect(rows.time).toEqual(["Leave", "Attendance"]);
    expect(rows.talent).toEqual(["Recruitment", "Reviews"]);
    expect(rows.cases).toEqual(["Cases", "Compliance", "Settings"]);
    expect(rows.pay).toBeUndefined();
    expect(rows.analytics).toContain("People analytics");
  });

  it("holds hr_staff to the reader tier even without a member grant", () => {
    const rows = hr(me([role("hr_staff")]));
    expect(rows.people).toEqual(["Directory", "Onboarding", "Org structure"]);
    expect(rows.talent).toEqual(["Recruitment", "Reviews"]);
    expect(rows.pay).toBeUndefined();
  });

  it("gives hr_manager Pay and the appraisal cycles as well", () => {
    const rows = hr(as("hr_manager"));
    expect(rows.pay).toEqual(["Compensation", "Payroll"]);
    expect(rows.talent).toEqual(["Recruitment", "Reviews", "Appraisal cycles"]);
    expect(rows.cases).toEqual(["Cases", "Compliance", "Settings"]);
    expect(rows.analytics).toContain("People analytics");
  });

  it("offers a role with no HR standing no HR-only tab", () => {
    for (const r of ["finance_staff", "it_admin"]) {
      const rows = hr(as(r));
      expect(rows.people, r).toEqual(["Directory", "Org structure"]);
      expect(rows.pay, r).toBeUndefined();
      expect(rows.talent, r).toEqual(["Reviews"]);
    }
  });

  it("keeps the hr module gate: a company with the module off is offered no HR row", () => {
    const rows = hr(moduleOff("hr_manager"));
    for (const key of ["people", "time", "pay", "talent", "cases"]) expect(rows[key], key).toBeUndefined();
    expect(rows.analytics).not.toContain("People analytics");
  });
});

describe("Finance rows (DW-7b)", () => {
  it("gives a plain member the rows whose reads have no capability, and none of the three that do", () => {
    const rows = finance(plainMember);
    // Ungated: no capability mirrors `finance_ledger`, `finance_config`, `finance_ap`, `finance_tax`, `finance_period`,
    // `finance_bank` or `finance_ownership` read (listed in the registry's comment), so these stay offered.
    expect(rows.ledger).toEqual(["Journals", "General ledger", "Chart of accounts"]);
    expect(rows.payables).toEqual(["Payables", "Freelancers"]);
    expect(rows.treasury).toEqual(["Treasury", "Fixed assets"]);
    expect(rows.tax).toEqual(["Tax"]);
    expect(rows.close).toEqual(["Period close", "Ownership", "Cutover", "Settings", "Billing profile"]);
    // Gated on `finance.ar.view` (Receivables; Invoices also needs `company.manage`) and `finance.statement.view`.
    expect(rows.receivables).toBeUndefined();
    expect(rows.close).not.toContain("Consolidation");
    expect(rows.reports).not.toContain("Financial statements");
    // DW-7b-2: Revenue, AR and cash opens with the profit and loss, so it takes the statements' gate.
    expect(rows.analytics).not.toContain("Revenue, AR and cash");
  });

  it("gives finance_staff and finance_manager the receivables, the consolidation and the financial statements, but not Invoices", () => {
    for (const r of ["finance_staff", "finance_manager"]) {
      const rows = finance(as(r));
      expect(rows.receivables, r).toEqual(["Receivables"]);
      expect(rows.close, r).toEqual(["Period close", "Consolidation", "Ownership", "Cutover", "Settings", "Billing profile"]);
      expect(rows.reports, r).toContain("Financial statements");
      expect(rows.analytics, r).toContain("Revenue, AR and cash");
    }
  });

  it("gives a company admin all of it, Invoices included", () => {
    const rows = finance(as("company_admin"));
    expect(rows.receivables).toEqual(["Receivables", "Invoices"]);
    expect(rows.close).toContain("Consolidation");
    expect(rows.reports).toContain("Financial statements");
    expect(rows.analytics).toContain("Revenue, AR and cash");
  });

  it("offers an HR or IT role nothing the finance reads would refuse", () => {
    for (const r of ["hr_manager", "it_admin"]) {
      const rows = finance(as(r));
      expect(rows.receivables, r).toBeUndefined();
      expect(rows.reports, r).not.toContain("Financial statements");
    }
  });
});

describe("IT rows (DW-7c)", () => {
  it("gives a plain member the Devices row and Topology only (`device` read is open to members); the four security tabs read `it_account`, so no accounts, workflows or security", () => {
    const rows = itRows(plainMember);
    expect(rows.devices).toEqual(["Devices"]);
    expect(rows.network).toEqual(["Topology"]);
    expect(rows.accounts).toBeUndefined();
    expect(rows.workflows).toBeUndefined();
  });

  it.each(["it_admin", "it_manager", "it", "company_admin"])("gives %s the IT accounts and the workflows", (r) => {
    const rows = itRows(as(r));
    expect(rows.devices).toEqual(["Devices"]);
    expect(rows.accounts).toEqual(["IT accounts"]);
    expect(rows.workflows).toEqual(["Workflows"]);
    // DW-7h: Topology plus the four ERP-side security tabs, gated like IT accounts (BFF §52.10).
    expect(rows.network).toEqual(["Topology", "Connected", "Sign-ins", "Alerts", "Blocks"]);
  });

  it("offers an HR or finance role neither accounts nor workflows", () => {
    for (const r of ["hr_manager", "finance_manager"]) {
      const rows = itRows(as(r));
      expect(rows.accounts, r).toBeUndefined();
      expect(rows.workflows, r).toBeUndefined();
    }
  });

  it("keeps the it module gate, except on IT accounts, which works with the module off (P2-14)", () => {
    const rows = itRows(moduleOff("it_admin"));
    for (const key of ["devices", "workflows"]) expect(rows[key], key).toBeUndefined();
    expect(rows.accounts).toEqual(["IT accounts"]);
    // DW-7h: the security tabs are not module-gated (`/it/security/*` works with the module off); Topology is.
    expect(rows.network).toEqual(["Connected", "Sign-ins", "Alerts", "Blocks"]);
  });
});

describe("withheldTabPaths (the console strips' `covers`)", () => {
  const tab = (key: string, href: string, extra: object = {}) => ({ key, label: key, href, icon: "home" as const, ...extra });
  const rows: WorkspaceRow[] = [
    { key: "a", label: "A", icon: "home", tabs: [tab("open", "/x/open"), tab("gated", "/x/gated?view=1", { gate: { kind: "cap", cap: "hr.view" } })] },
    { key: "b", label: "B", icon: "home", gate: { kind: "cap", cap: "hr.view" }, tabs: [tab("one", "/x/one"), tab("two", "/x/two")] },
    { key: "c", label: "C", icon: "home", tabs: [tab("soon", "/x/soon", { ticket: "DW-9", gate: { kind: "cap", cap: "hr.view" } }), tab("dept", "/d/{dept}/t", { gate: { kind: "cap", cap: "hr.view" } })] },
    { key: "d", label: "D", icon: "home", ticket: "DW-9", gate: { kind: "cap", cap: "hr.view" }, tabs: [tab("never", "/x/never")] },
  ];
  const ctxFor = (m: Me, deptId: string | null) => ({ me: m, tenantId: "co-a", unitPath: [], deptId });

  it("withholds a tab whose own gate fails (its path, without the query) and every tab of a row whose gate fails", () => {
    expect(withheldTabPaths(rows, ctxFor(plainMember, null)).sort()).toEqual(["/x/gated", "/x/one", "/x/two"]);
  });

  it("does not withhold a planned tab or row, nor a {dept} tab that has no department id", () => {
    const withheld = withheldTabPaths(rows, ctxFor(plainMember, null));
    for (const p of ["/x/soon", "/x/never", "/d/{dept}/t"]) expect(withheld).not.toContain(p);
    // With a department id the {dept} tab is gated away, so it is withheld.
    expect(withheldTabPaths(rows, ctxFor(plainMember, "d-1"))).toContain("/d/d-1/t");
  });

  it("withholds nothing from a person every gate admits", () => {
    expect(withheldTabPaths(rows, ctxFor(as("hr_staff"), "d-1"))).toEqual([]);
  });
});

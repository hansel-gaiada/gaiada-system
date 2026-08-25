import { describe, it, expect } from "vitest";
import {
  GM_SLUG,
  GM_DEFAULT_PERIOD,
  GM_TIER1_LIMIT,
  isGmDept,
  canReadGmConsole,
  parseGmPeriodKind,
} from "./gm";
import { toolkitFor, deptTabs, hasBespokeToolkit } from "./deptToolkits";
import type { Me } from "./platform";

const base: Me = {
  userId: "u1", name: "Edward", email: "edward@gaiada.com", title: "General Manager",
  assurance: "high", companies: [{ id: "c1", name: "Gaia Digital Agency", type: null }], roles: [],
};

const withRole = (role: string): Me => ({ ...base, roles: [{ role, scopeType: "company", scopeId: "c1" }] });

describe("isGmDept", () => {
  it("matches the GM department by NAME slug, not by a hardcoded d-gm id", () => {
    // Keyed on the name so every company in the holding resolves its own GM node.
    expect(isGmDept("GM")).toBe(true);
    expect(isGmDept("  gm  ")).toBe(true);
    expect(isGmDept("Web Dev")).toBe(false);
    // Not a prefix/substring match — "GMS" is a different department, not the GM.
    expect(isGmDept("GMS")).toBe(false);
  });

  it("agrees with the toolkit registry", () => {
    expect(toolkitFor("GM").slug).toBe(GM_SLUG);
    expect(hasBespokeToolkit("GM")).toBe(true);
  });
});

describe("canReadGmConsole", () => {
  // THE regression this pins: the GM console is the only department Home that shows company-grain
  // figures, and `Departments` sidebar rows are ungated by design. A plain member reaching the
  // console must be refused — if this test goes green for `member`, the cockpit is a leak.
  it("refuses a plain member", () => {
    expect(canReadGmConsole(withRole("member"), "c1")).toBe(false);
  });

  it("refuses a department manager", () => {
    // OQ-1's narrowed department-head view is GM-02b and is NOT built (see lib/gm.ts): until the UI
    // can identify a unit lead, a manager gets the same honest refusal a member does. When GM-02b
    // lands this expectation changes deliberately — it is not an accident to be "fixed" quietly.
    expect(canReadGmConsole(withRole("manager"), "c1")).toBe(false);
  });

  it("admits the tenant's own administrator", () => {
    // `company_admin` holds the whole EXEC_ONLY_REPORTS tier including `reports.company.view`.
    // Gating on `rollups.view` instead would have refused this principal while the backend served
    // the same figures at /reports/company — see lib/gm.ts's warning.
    expect(canReadGmConsole(withRole("company_admin"), "c1")).toBe(true);
  });

  it("admits a global superadmin", () => {
    const admin = { ...base, roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] } as Me;
    expect(canReadGmConsole(admin, "c1")).toBe(true);
  });

  it("is company-scoped: a company_admin of one tenant cannot read another's cockpit", () => {
    // The console's subject is the ACTIVE company's business, so switching the tenant in the URL
    // must not carry the grant across.
    expect(canReadGmConsole(withRole("company_admin"), "c2")).toBe(false);
  });
});

describe("parseGmPeriodKind", () => {
  it("defaults to the week (OQ-2)", () => {
    expect(GM_DEFAULT_PERIOD).toBe("week");
    expect(parseGmPeriodKind(undefined)).toBe("week");
  });

  it("accepts month and rejects anything else rather than passing it to the backend", () => {
    expect(parseGmPeriodKind("month")).toBe("month");
    // `day` and `custom` are real ReportPeriodKinds the console deliberately does not offer — a
    // hand-typed query param must not smuggle them in.
    expect(parseGmPeriodKind("day")).toBe("week");
    expect(parseGmPeriodKind("custom")).toBe("week");
    expect(parseGmPeriodKind("../etc/passwd")).toBe("week");
  });
});

describe("the GM toolkit", () => {
  it("is the Home · PM · Command · Oversight · Connections spine", () => {
    expect(toolkitFor("GM").groups.map((g) => g.key)).toEqual([
      "home", "work", "command", "oversight", "connections",
    ]);
  });

  it("declares every tab a route exists for", () => {
    // The registry's standing rule: do NOT register a toolkit until its tab routes exist, or the
    // console points at 404s. These five are the bespoke paths added under
    // app/(app)/departments/[deptId]/ by GM-01.
    const paths = deptTabs(toolkitFor("GM")).map((t) => t.path);
    for (const p of ["review", "decisions", "depts", "money", "people"]) {
      expect(paths, `${p} tab must be declared`).toContain(p);
    }
  });

  it("ships no producer launchers — the GM does not build", () => {
    const keys = toolkitFor("GM").launchers.map((l) => l.key);
    expect(keys).not.toContain("github");
    expect(keys).not.toContain("figma");
    expect(keys).not.toContain("vscode");
  });

  it("caps the cockpit's headline strip inside the cognitive-load budget", () => {
    // 5–9 elements is working memory; past ~12 KPIs engagement collapses (foundation doc §9).
    expect(GM_TIER1_LIMIT).toBeLessThanOrEqual(9);
  });
});

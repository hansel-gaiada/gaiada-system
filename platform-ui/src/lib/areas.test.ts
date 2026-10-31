import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AREA_RULES, areaFor, bestRules, resolveArea, sameArea, type Area, type AreaMatch } from "./areas";
import {
  WORKSPACES, GENERIC_WORKSPACE, sidebarRows, COMPANY_ROWS, ADMIN_ROWS, YOU_ROWS, PERFORMANCE_ROWS, isPlanned,
  type Workspace, type WorkspaceRow, type WorkspaceTab,
} from "./workspaces";
import { SKIN_PERSONAS, modelFor, tabHrefsOf } from "./skinTestKit";
import { allRows, workspaceForArea } from "./shellModel";
import { phoneBarFor, phoneMenuFor, phoneTopFor, pinnedFor } from "./skins";

const APP = resolve(__dirname, "../app/(app)");

/** Every page.tsx under (app) as a route pattern's segments. Route groups drop out; parallel-route slots
 *  (`@drawer`) and the root catch-all (the "not furnished yet" fallback) are skipped. */
function pagePatterns(): string[][] {
  const out: string[][] = [];
  const walk = (dir: string, segs: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const name = entry.name;
        if (name.startsWith("@")) continue;
        if (/^\(.*\)$/.test(name)) walk(resolve(dir, name), segs);
        else if (segs.length === 0 && name === "[...placeholder]") continue;
        else walk(resolve(dir, name), [...segs, name]);
      } else if (entry.name === "page.tsx") out.push(segs);
    }
  };
  walk(APP, []);
  return out;
}

describe("every page has exactly one area", () => {
  it("walks the page files and finds no page with no area or two", () => {
    const patterns = pagePatterns();
    expect(patterns.length).toBeGreaterThan(200);
    const problems: string[] = [];
    for (const segs of patterns) {
      const rules = bestRules(segs);
      const route = `/${segs.join("/")}`;
      if (rules.length === 0) problems.push(`${route}: no area`);
      else if (rules.length > 1) problems.push(`${route}: two areas: ${rules.map((r) => r.path).join(", ")}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("has no catch-all in a rule, and '/' only as an exact rule", () => {
    for (const r of AREA_RULES) {
      expect(r.path, r.path).not.toMatch(/\.\.\./);
      if (r.path === "/") expect(r.subtree, "/").toBeFalsy();
    }
  });
});

const ALL: Workspace[] = [...WORKSPACES, GENERIC_WORKSPACE];
const concrete = (href: string) => areaFor(href.replaceAll("{dept}", "d-x").replaceAll("{company}", "co-x"));
const live = (tabs: readonly WorkspaceTab[]) => tabs.filter((t) => !isPlanned(t));
const liveTabs = (rows: readonly WorkspaceRow[]) => rows.filter((r) => !isPlanned(r)).flatMap((r) => live(r.tabs));

/** Own workspace (this department's id, or this workspace's slug) or a shared page. */
function expectOwnOrShared(ws: Workspace, href: string) {
  const a = concrete(href);
  const own = a.kind === "workspace" && (a.deptId === "d-x" || a.slug === ws.key);
  expect(own || a.kind === "shared", `${ws.key}: ${href} -> ${JSON.stringify(a)}`).toBe(true);
}

describe("every registry href lands in the right area", () => {
  it("puts each workspace's Work rows and Tools & connections in its own workspace or shared", () => {
    for (const ws of ALL) for (const t of liveTabs(sidebarRows(ws).work)) expectOwnOrShared(ws, t.href);
  });

  it("puts each workspace's Analytics and Reports tabs in its own workspace or shared", () => {
    for (const ws of ALL) for (const t of live([...ws.analytics, ...ws.reports])) expectOwnOrShared(ws, t.href);
  });

  it("puts each workspace's Overview in its own workspace", () => {
    for (const ws of ALL) {
      const a = concrete(ws.overviewHref);
      expect(a.kind === "workspace" && (a.deptId === "d-x" || a.slug === ws.key), `${ws.key}: ${JSON.stringify(a)}`).toBe(true);
    }
  });

  it("puts Performance tabs in Performance or shared", () => {
    for (const row of PERFORMANCE_ROWS.filter((r) => !isPlanned(r))) {
      for (const t of live(row.tabs)) {
        const a = concrete(t.href);
        // Analytics > Work is the department's own Charts page: the one Performance tab that is a workspace page.
        const ok = a.kind === "performance" || a.kind === "shared" || (row.key === "analytics" && a.kind === "workspace" && a.deptId === "d-x");
        expect(ok, `${row.key}/${t.key}: ${t.href} -> ${JSON.stringify(a)}`).toBe(true);
      }
    }
  });

  it("puts You tabs in personal", () => {
    for (const t of liveTabs(YOU_ROWS)) expect(concrete(t.href).kind, t.href).toBe("personal");
  });

  it("puts Company tabs in company or shared", () => {
    for (const t of liveTabs(COMPANY_ROWS)) expect(["company", "shared"], t.href).toContain(concrete(t.href).kind);
  });

  it("puts Admin tabs in admin", () => {
    for (const t of liveTabs(ADMIN_ROWS)) expect(concrete(t.href).kind, t.href).toBe("admin");
  });
});

describe("areaFor", () => {
  it("strips the query string, the hash and a trailing slash", () => {
    expect(areaFor("/hr/?tab=1#x")).toEqual({ kind: "workspace", slug: "hr" });
    expect(areaFor("/account/")).toEqual({ kind: "personal" });
    expect(areaFor("/admin#top")).toEqual({ kind: "admin" });
  });

  it("separates /departments (company) from a department's workspace", () => {
    expect(areaFor("/departments")).toEqual({ kind: "company" });
    expect(areaFor("/departments/d-web/board")).toEqual({ kind: "workspace", deptId: "d-web" });
    expect(areaFor("/departments/d%20web")).toEqual({ kind: "workspace", deptId: "d web" });
  });

  // SCP-5d: the Team dashboard page is in exactly one area, the department's own (DW-1c), through its own entry.
  it("puts the Social Media Team dashboard in the department's own workspace area, through one rule", () => {
    expect(bestRules(["departments", "[deptId]", "dashboard"]).map((r) => r.path)).toEqual(["/departments/[deptId]/dashboard"]);
    expect(areaFor("/departments/d-soc/dashboard")).toEqual({ kind: "workspace", deptId: "d-soc" });
    expect(areaFor("/departments/d-soc/dashboard?month=2026-09")).toEqual({ kind: "workspace", deptId: "d-soc" });
  });

  it("lets a static segment beat a dynamic one", () => {
    expect(areaFor("/appraisals/cycles/abc")).toEqual({ kind: "workspace", slug: "hr" });
    expect(areaFor("/appraisals/abc")).toEqual({ kind: "performance" });
    expect(areaFor("/projects/new")).toEqual({ kind: "company" });
    expect(areaFor("/projects/p-1")).toEqual({ kind: "shared" });
  });

  it("tells a company's org page (shared) from its other pages (company)", () => {
    expect(areaFor("/companies/co-1/org")).toEqual({ kind: "shared" });
    expect(areaFor("/companies/co-1/edit")).toEqual({ kind: "company" });
  });

  it("gives owned routes to their workspace", () => {
    expect(areaFor("/reports/company")).toEqual({ kind: "workspace", slug: "gm" });
    expect(areaFor("/pipeline/run-1")).toEqual({ kind: "workspace", slug: "web-dev" });
    expect(areaFor("/billing/anything/else")).toEqual({ kind: "workspace", slug: "finance" });
  });

  it("separates My learning (performance) from the other You pages", () => {
    expect(areaFor("/me/learning")).toEqual({ kind: "performance" });
    expect(areaFor("/me/leave")).toEqual({ kind: "personal" });
    expect(areaFor("/me/loans/l-1")).toEqual({ kind: "personal" });
    // DW-8j: Mail is personal, a thread and the compose page too.
    for (const p of ["/me/mail", "/me/mail/t-1", "/me/mail/new?to=a@b.c"]) expect(areaFor(p)).toEqual({ kind: "personal" });
  });

  it("puts My performance in performance, with its query string, not in You (PV7-06)", () => {
    expect(areaFor("/me/performance")).toEqual({ kind: "performance" });
    expect(areaFor("/me/performance?x=1")).toEqual({ kind: "performance" });
  });

  it("PV7-05: the health board keeps the Clients list's area, and the client report is Performance like the other grains", () => {
    expect(areaFor("/clients")).toEqual({ kind: "shared" });
    expect(areaFor("/clients/health")).toEqual({ kind: "shared" });
    expect(areaFor("/clients/health?state=at_risk")).toEqual({ kind: "shared" });
    expect(areaFor("/clients/cl-1")).toEqual({ kind: "shared" }); // a client record is not swallowed by the static rule
    for (const g of ["person", "project", "client"]) expect(areaFor(`/reports/${g}`)).toEqual({ kind: "performance" });
    expect(areaFor("/reports/client?scopeRef=c-1")).toEqual({ kind: "performance" });
  });

  it("returns shared for a path no rule covers", () => {
    expect(areaFor("/nope")).toEqual({ kind: "shared" });
  });
});

describe("resolveArea", () => {
  const home: Area = { kind: "workspace", deptId: "d-home" };
  const lastWs: Area = { kind: "workspace", slug: "hr" };
  const lastCompany: Area = { kind: "company" };
  const m = (kind: AreaMatch["kind"], rest: Omit<AreaMatch, "kind"> = {}): AreaMatch => ({ kind, ...rest });

  it("returns workspace, company and admin as matched, whatever the last area was", () => {
    expect(resolveArea(m("workspace", { deptId: "d-a" }), lastCompany, home)).toEqual({ kind: "workspace", deptId: "d-a" });
    expect(resolveArea(m("workspace", { slug: "gm" }), null, home)).toEqual({ kind: "workspace", slug: "gm" });
    expect(resolveArea(m("company"), lastWs, home)).toEqual({ kind: "company" });
    expect(resolveArea(m("admin"), null, home)).toEqual({ kind: "admin" });
  });

  it("keeps a workspace sidebar for personal and performance pages", () => {
    for (const kind of ["personal", "performance"] as const) {
      expect(resolveArea(m(kind), lastWs, home), kind).toBe(lastWs);
      expect(resolveArea(m(kind), null, home), kind).toBe(home);
      expect(resolveArea(m(kind), lastCompany, home), kind).toBe(home);
      expect(resolveArea(m(kind), { kind: "admin" }, home), kind).toBe(home);
    }
  });

  it("keeps the last area of any kind for shared pages", () => {
    expect(resolveArea(m("shared"), lastWs, home)).toBe(lastWs);
    expect(resolveArea(m("shared"), lastCompany, home)).toBe(lastCompany);
    expect(resolveArea(m("shared"), { kind: "admin" }, home)).toEqual({ kind: "admin" });
    expect(resolveArea(m("shared"), null, home)).toBe(home);
  });

  it("compares areas", () => {
    expect(sameArea({ kind: "company" }, { kind: "company" })).toBe(true);
    expect(sameArea({ kind: "company" }, { kind: "admin" })).toBe(false);
    expect(sameArea({ kind: "workspace", deptId: "a" }, { kind: "workspace", deptId: "a" })).toBe(true);
    expect(sameArea({ kind: "workspace", deptId: "a" }, { kind: "workspace", deptId: "b" })).toBe(false);
    expect(sameArea({ kind: "workspace", slug: "hr" }, { kind: "workspace", deptId: "a" })).toBe(false);
  });
});

// ── SCP-Kf (plan §8): the one-area rule holds in the Social skin ──────────────────────────────────────────────────────────────────────
// A skin adds no page and moves none. What it adds is a way to REACH pages (the pinned menu, the phone's bar and sheet), so what must hold is
// that every page those open belongs to one area, the one the registry gave it, and that the area decides the same workspace in both skins.
describe.each(SKIN_PERSONAS)("the Social skin keeps every page in one area: $name", (persona) => {
  const std = modelFor(persona, undefined);
  const soc = modelFor(persona, { on: ["standard", "social"] });
  const socials = soc.workspaces.filter((w) => w.skin !== "standard");

  it("has a Social workspace to test (the person is placed in it, or only visits it)", () => {
    expect(socials.map((w) => w.key)).toEqual(["social-media"]);
  });

  it("puts every page a pin, the phone bar, the top or the sheet opens in this workspace, personal, performance or a shared area, as the registry does", () => {
    for (const ws of socials) {
      const pins = pinnedFor(ws.skin, allRows(ws))!;
      const links = [...pins, ...phoneBarFor(ws.skin, pins), ...phoneTopFor(ws.skin, pins), ...phoneMenuFor(ws.skin, pins)].flatMap((p) => (p.kind === "link" ? [p] : []));
      expect(links.length).toBeGreaterThan(3);
      for (const p of links) {
        const a = areaFor(p.href);
        const own = a.kind === "workspace" && (a.deptId === ws.deptId || a.slug === ws.key);
        expect(own || ["personal", "performance", "shared"].includes(a.kind), `${p.key}: ${p.href} -> ${JSON.stringify(a)}`).toBe(true);
        // The same page, asked of the Standard model's own rows, is in the same area: a skin does not re-home it.
        const stdWs = std.workspaces.find((w) => w.id === ws.id)!;
        expect(tabHrefsOf(stdWs), `${p.key}: ${p.href}`).toContain(p.href);
      }
      // Home is the workspace's own Overview.
      const home = pins.find((p) => p.key === "home")!;
      expect(home.kind === "link" && areaFor(home.href)).toMatchObject({ kind: "workspace", deptId: ws.deptId });
    }
  });

  it("chooses the same workspace for every page in both skins (the area decides, the skin only dresses it)", () => {
    const hrefs = new Set<string>();
    for (const ws of std.workspaces) for (const h of tabHrefsOf(ws)) hrefs.add(h.split(/[?#]/)[0]);
    expect(hrefs.size).toBeGreaterThan(50);
    for (const href of hrefs) {
      const area = (m: typeof std) => workspaceForArea(m, resolveArea(areaFor(href), null, m.home))?.id ?? null;
      expect(area(soc), href).toBe(area(std));
    }
  });

  it("gives the Social workspace its skin only on its own pages, and every other area stays Standard", () => {
    for (const ws of soc.workspaces) expect(ws.skin === "social", ws.key).toBe(ws.key === "social-media");
  });
});

// SCP-5a (BFF §63.17): the two Social reports pages sit in exactly one area each, the department's own, and the department's /reports page (SEO's) is not either of them.
describe("the Social reports pages' areas (SCP-5a)", () => {
  it("each page has exactly one rule, and it is the department's workspace area", () => {
    for (const segs of [["departments", "[deptId]", "social-reports"], ["departments", "[deptId]", "social-reports", "[reportId]"]]) {
      const rules = bestRules(segs);
      expect(rules, segs.join("/")).toHaveLength(1);
      expect(rules[0].kind, segs.join("/")).toBe("workspace");
    }
    expect(areaFor("/departments/d-x/social-reports")).toMatchObject({ kind: "workspace", deptId: "d-x" });
    expect(areaFor("/departments/d-x/social-reports/r-1")).toMatchObject({ kind: "workspace", deptId: "d-x" });
  });
  it("the list and a report are the same area, and /reports is its own page with its own rule", () => {
    expect(areaFor("/departments/d-x/social-reports")).toEqual(areaFor("/departments/d-x/social-reports/r-1"));
    expect(bestRules(["departments", "[deptId]", "reports"])).toHaveLength(1);
    expect(bestRules(["departments", "[deptId]", "reports"])[0].path).not.toMatch(/social-reports/);
  });
});

// SCP-5e, SCP-5g (BFF §63.17): the Saved page and the two audit pages sit in exactly one area each, the department's own; the audit is `{D}/social-audit`, and `{D}/audit` (SEO's Site Audit) is not.
describe("the Saved and social audit pages' areas (SCP-5e, SCP-5g)", () => {
  const pages = [["departments", "[deptId]", "saved"], ["departments", "[deptId]", "social-audit"], ["departments", "[deptId]", "social-audit", "[auditId]"], ["departments", "[deptId]", "onboarding"]];
  it("each page has exactly one rule, and it is the department's workspace area", () => {
    for (const segs of pages) {
      const rules = bestRules(segs);
      expect(rules, segs.join("/")).toHaveLength(1);
      expect(rules[0].kind, segs.join("/")).toBe("workspace");
    }
    expect(areaFor("/departments/d-x/saved")).toMatchObject({ kind: "workspace", deptId: "d-x" });
    expect(areaFor("/departments/d-x/social-audit")).toMatchObject({ kind: "workspace", deptId: "d-x" });
    expect(areaFor("/departments/d-x/social-audit/a-1")).toMatchObject({ kind: "workspace", deptId: "d-x" });
    expect(areaFor("/departments/d-x/onboarding")).toMatchObject({ kind: "workspace", deptId: "d-x" });
  });
  it("the audit list and one audit are the same area, and /audit stays SEO's own page with its own rule", () => {
    expect(areaFor("/departments/d-x/social-audit")).toEqual(areaFor("/departments/d-x/social-audit/a-1"));
    expect(bestRules(["departments", "[deptId]", "audit"])).toHaveLength(1);
    expect(bestRules(["departments", "[deptId]", "audit"])[0].path).not.toMatch(/social-audit/);
  });
});

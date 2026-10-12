import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AREA_RULES, areaFor, bestRules, resolveArea, sameArea, type Area, type AreaMatch } from "./areas";
import {
  WORKSPACES, GENERIC_WORKSPACE, sidebarRows, COMPANY_ROWS, ADMIN_ROWS, YOU_ROWS, PERFORMANCE_ROWS, isPlanned,
  type Workspace, type WorkspaceRow, type WorkspaceTab,
} from "./workspaces";

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

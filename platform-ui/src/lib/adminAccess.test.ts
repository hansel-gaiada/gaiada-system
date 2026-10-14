import { describe, it, expect, vi } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Me } from "./platform";
import { ADMIN_ROUTES, adminRouteAllowed } from "./adminAccess";
import { ADMIN_ROWS } from "./workspaces";
import { AGENCY, HOTEL, ROOT, me, member, type Company } from "./workspaceFixtures";

// DW-D20: who may open each Admin-area page. Personas are fixtures, not real people.
const grant = (role: string, scopeType: "global" | "company", scopeId: string | null = null) => ({ role, scopeType, scopeId });
const OPERATOR_ROOT: Company = { ...ROOT, isOperatorRoot: true };
const CUSTOMER_ROOT: Company = { id: "co-cust", name: "Customer", type: null, vertical: "holding", rootCompanyId: "co-cust" };

const SETTINGS = ["/admin/users", "/admin/identity", "/admin/modules", "/admin/services", "/admin/compliance", "/admin/audit", "/admin/mail", "/admin/about"];
const GROUP = ["/group", "/group/reports", "/rollups"];
const PLATFORM = ["/systems/bot", "/systems/gateway", "/systems/hub", "/systems/observability", "/systems/automation"];
const ALL = ["/admin", ...SETTINGS, ...GROUP, ...PLATFORM];

const opened = (m: Me, tenant: string | null, routes = ALL) => routes.filter((r) => adminRouteAllowed(r, m, tenant) === true);

const platformAdmin = me([grant("platform_admin", "global")], [AGENCY]);
const operatorOwner = me([grant("owner", "company", "co-root")], [OPERATOR_ROOT, AGENCY]);
const customerOwner = me([grant("owner", "company", "co-cust")], [CUSTOMER_ROOT]);
const companyAdmin = me([grant("company_admin", "company", "co-a")], [AGENCY]);
const globalCompanyAdmin = me([grant("company_admin", "global")], [AGENCY]);
const manager = me([grant("manager", "company", "co-a")], [AGENCY]);
const plainMember = me([member()], [AGENCY]);
const viewer = me([grant("viewer", "company", "co-a")], [AGENCY]);
const itStaff = me([grant("it_admin", "company", "co-a")], [AGENCY]);
const client = me([grant("client", "company", "co-a")], [AGENCY]);

describe("adminRouteAllowed: who may open what", () => {
  it("a platform admin opens every Admin page", () => {
    expect(opened(platformAdmin, "co-a")).toEqual(ALL);
  });

  it("a company admin reaches Settings (Users & Roles included) but not Mail, Group or Platform", () => {
    expect(opened(companyAdmin, "co-a")).toEqual(["/admin", "/admin/users", "/admin/identity", "/admin/modules", "/admin/services", "/admin/compliance", "/admin/audit", "/admin/about"]);
    expect(opened(globalCompanyAdmin, "co-a")).toEqual(opened(companyAdmin, "co-a"));
  });

  it("a company admin of another company does not reach Users & Roles here", () => {
    expect(adminRouteAllowed("/admin/users", companyAdmin, "co-other")).toBe(false);
  });

  it("the operator root's owner reaches Platform, Group and Settings, but not the platform_admin-only Mail log", () => {
    const got = opened(operatorOwner, "co-root");
    for (const r of [...PLATFORM, ...GROUP, "/admin", "/admin/users", "/admin/about"]) expect(got, r).toContain(r);
    expect(got).not.toContain("/admin/mail");
  });

  it("a customer root's owner reaches Group and Settings but not Platform", () => {
    const got = opened(customerOwner, "co-cust");
    for (const r of [...GROUP, "/admin", "/admin/users"]) expect(got, r).toContain(r);
    for (const r of PLATFORM) expect(got, r).not.toContain(r);
    expect(got).not.toContain("/admin/mail");
  });

  it("an owner of a child company does not reach Group (only the root's owner does)", () => {
    const childOwner = me([grant("owner", "company", "co-a")], [AGENCY, ROOT]);
    for (const r of GROUP) expect(adminRouteAllowed(r, childOwner, "co-a"), r).toBe(false);
  });

  it("a root owner who is working in a child company still reaches Group (its own notice says to switch)", () => {
    const owner = me([grant("owner", "company", "co-root")], [ROOT, HOTEL]);
    expect(adminRouteAllowed("/group", owner, "co-h")).toBe(true);
  });

  it("a manager reaches Users & Roles, Modules & Fields and Audit, nothing else", () => {
    expect(opened(manager, "co-a")).toEqual(["/admin", "/admin/users", "/admin/modules", "/admin/audit"]);
  });

  it("a member, a viewer and a client reach none of the Admin area", () => {
    for (const p of [plainMember, viewer, client]) expect(opened(p, "co-a")).toEqual([]);
  });

  it("IT staff reach the Automation page (the workflow endpoints admit them) and no other Platform page", () => {
    expect(adminRouteAllowed("/systems/automation", itStaff, "co-a")).toBe(true);
    for (const r of PLATFORM.filter((p) => p !== "/systems/automation")) expect(adminRouteAllowed(r, itStaff, "co-a"), r).toBe(false);
  });

  it("a role the UI does not model is never denied a Settings page (the server's own refusal answers)", () => {
    const custom = me([grant("custom_auditor", "company", "co-a")], [AGENCY]);
    for (const r of ["/admin/users", "/admin/audit", "/admin/compliance"]) expect(adminRouteAllowed(r, custom, "co-a"), r).toBe(true);
    // Platform and the Mail log are code gates, not role data: still denied.
    expect(adminRouteAllowed("/systems/hub", custom, "co-a")).toBe(false);
    expect(adminRouteAllowed("/admin/mail", custom, "co-a")).toBe(false);
  });

  it("with no active company a company-scoped admin is not denied", () => {
    expect(adminRouteAllowed("/admin/users", companyAdmin, null)).toBe(true);
  });
});

describe("route matching", () => {
  it("covers deeper paths, query strings and trailing slashes by the longest known prefix", () => {
    expect(adminRouteAllowed("/admin/mail/3f2b", platformAdmin, "co-a")).toBe(true);
    expect(adminRouteAllowed("/admin/mail/3f2b", companyAdmin, "co-a")).toBe(false);
    expect(adminRouteAllowed("/admin/users/?x=1", plainMember, "co-a")).toBe(false);
    // /group/reports is its own entry, and not shadowed by /group.
    expect(ADMIN_ROUTES.map((r) => r.path)).toContain("/group/reports");
  });

  it("returns undefined for a route the table does not know, so nothing new 404s by accident", () => {
    for (const r of ["/", "/departments", "/admin-tools", "/systems", "/systems/github", "/systems/new-thing", "/groups"]) {
      expect(adminRouteAllowed(r, plainMember, "co-a"), r).toBeUndefined();
    }
  });

  it("knows every page the Admin menu offers (a new Admin row must be added to the table)", () => {
    for (const row of ADMIN_ROWS) {
      for (const tab of row.tabs) expect(adminRouteAllowed(tab.href, plainMember, "co-a"), tab.href).toBeDefined();
    }
  });
});

// DW-8f: every page file of the Admin area has a rule. A page with no rule would 404 by default (the
// table returns undefined), so a new page must come with its row here. The walk copies areas.test.ts.
const APP = resolve(__dirname, "../app/(app)");
const ADMIN_FOLDERS = ["admin", "group", "rollups", "systems"];

/** Every page.tsx under the Admin folders as a URL path. A dynamic segment (`[id]`) becomes `x1`. */
function adminPagePaths(): string[] {
  const out: string[] = [];
  const walk = (dir: string, segs: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(resolve(dir, entry.name), [...segs, entry.name.replace(/^\[.+\]$/, "x1")]);
      else if (entry.name === "page.tsx") out.push(`/${segs.join("/")}`);
    }
  };
  for (const folder of ADMIN_FOLDERS) walk(resolve(APP, folder), [folder]);
  return out;
}

describe("every Admin-area page has a 404 rule", () => {
  it("walks the Admin folders and finds a rule for every page (only /systems/github is exempt)", () => {
    const pages = adminPagePaths();
    expect(pages.length).toBeGreaterThan(10);
    expect(pages).toContain("/admin/mail/x1");
    const problems: string[] = [];
    for (const path of pages) {
      if (path === "/systems/github") continue;
      if (adminRouteAllowed(path, platformAdmin, "co-a") === undefined) problems.push(`${path}: page has no rule in ADMIN_ROUTES`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

describe("guardAdminRoute", () => {
  it("is a 404 for a denied route and silent for an allowed or unknown one", async () => {
    vi.resetModules();
    vi.doMock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
    const { guardAdminRoute } = await import("./adminGuard");
    expect(() => guardAdminRoute("/admin/users", plainMember, "co-a")).toThrow("NEXT_NOT_FOUND");
    expect(() => guardAdminRoute("/systems/hub", companyAdmin, "co-a")).toThrow("NEXT_NOT_FOUND");
    expect(() => guardAdminRoute("/admin/users", companyAdmin, "co-a")).not.toThrow();
    expect(() => guardAdminRoute("/departments", plainMember, "co-a")).not.toThrow();
    vi.doUnmock("next/navigation");
  });
});

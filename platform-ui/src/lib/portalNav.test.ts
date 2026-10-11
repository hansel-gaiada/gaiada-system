import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PORTAL_AREAS, activePortalNav, portalBadges } from "./portalNav";

// Every page.tsx under src/app/(portal)/portal becomes a URL (dynamic segments filled with a sample
// value), so a future page with no nav mapping fails here instead of lighting no tab in production.
const ROOT = join(__dirname, "..", "app", "(portal)", "portal");

function pages(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) pages(full, out);
    else if (name === "page.tsx") out.push(full);
  }
  return out;
}

function routeOf(file: string): string {
  const segs = relative(ROOT, file).split(sep).slice(0, -1);
  const parts = segs.flatMap((s) => {
    if (s.startsWith("[[...")) return []; // optional catch-all: the bare route is valid
    if (s.startsWith("[")) return ["x1"];
    return [s];
  });
  return "/portal" + (parts.length ? "/" + parts.join("/") : "");
}

describe("activePortalNav", () => {
  it("maps every page under (portal)/portal to an area and a tab", () => {
    const routes = pages(ROOT).map(routeOf);
    expect(routes.length).toBeGreaterThanOrEqual(16);
    for (const r of routes) {
      const nav = activePortalNav(r);
      expect(nav.areaKey, r).not.toBeNull();
      expect(nav.tabHref, r).not.toBeNull();
      const area = PORTAL_AREAS.find((a) => a.key === nav.areaKey)!;
      expect(area.tabs.map((t) => t.href), r).toContain(nav.tabHref);
    }
  });

  it.each([
    ["/portal", "overview", "/portal"],
    ["/portal/projects", "projects", "/portal/projects"],
    ["/portal/projects/p1", "projects", "/portal/projects"],
    ["/portal/approvals", "projects", "/portal/approvals"],
    ["/portal/approvals/r1", "projects", "/portal/approvals"],
    ["/portal/deliverables", "projects", "/portal/deliverables"],
    ["/portal/requests", "projects", "/portal/requests"],
    ["/portal/social-reviews", "projects", "/portal/social-reviews"],
    ["/portal/social-reviews/s1", "projects", "/portal/social-reviews"],
    ["/portal/timeline", "projects", "/portal/timeline"],
    ["/portal/company", "business", "/portal/company"],
    ["/portal/company/mk/web", "business", "/portal/company"],
    // WSK-49d: the Website area lives in Business, at every depth of its routes.
    ["/portal/website", "business", "/portal/website"],
    ["/portal/website/gaiada/site-1", "business", "/portal/website"],
    ["/portal/website/gaiada/site-1/service", "business", "/portal/website"],
    ["/portal/website/gaiada/site-1/service/service.seo/history", "business", "/portal/website"],
    ["/portal/website/gaiada/site-1/~media", "business", "/portal/website"],
    ["/portal/contracts", "billing", "/portal/contracts"],
    ["/portal/contracts/k1", "billing", "/portal/contracts"],
    ["/portal/invoices", "billing", "/portal/invoices"],
    ["/portal/invoices/i1", "billing", "/portal/invoices"],
    ["/portal/profile", "people", "/portal/profile"],
  ])("%s lights %s / %s", (path, areaKey, tabHref) => {
    expect(activePortalNav(path)).toEqual({ areaKey, tabHref });
  });

  it("lights only Overview on /portal, and Overview on no other path", () => {
    for (const area of PORTAL_AREAS) {
      for (const t of area.tabs) {
        if (t.href !== "/portal") expect(activePortalNav(t.href).areaKey).not.toBe("overview");
      }
    }
  });

  it("returns nulls for unknown paths without throwing", () => {
    for (const p of ["/portal/xyz", "/portal/projectsX", "/", "", "/staff/projects"]) {
      expect(activePortalNav(p)).toEqual({ areaKey: null, tabHref: null });
    }
  });

  it("tolerates a trailing slash and a query string", () => {
    expect(activePortalNav("/portal/invoices/?a=1").tabHref).toBe("/portal/invoices");
  });

  it("keeps the existing client-facing paths and the area layout", () => {
    expect(PORTAL_AREAS.map((a) => a.key)).toEqual(["overview", "projects", "business", "billing", "people"]);
    const all = PORTAL_AREAS.flatMap((a) => a.tabs.map((t) => t.href));
    expect(all).toHaveLength(12);
    expect(new Set(all).size).toBe(12);
    // WSK-49d added exactly one: Website, second tab of Business (offered only to a website editor, see PortalTabs).
    expect(PORTAL_AREAS.find((a) => a.key === "business")!.tabs.map((t) => t.href)).toEqual(["/portal/company", "/portal/website"]);
  });
});

describe("portalBadges", () => {
  const item = (kind: "gate" | "contract") => ({ kind });
  const cur = (overdueCount: number) => ({ overdueCount });
  it("splits gates from contracts and adds overdue invoices to billing", () => {
    const o = {
      needsYou: [item("gate"), item("gate"), item("contract")],
      finance: { byCurrency: [cur(2), cur(1)] },
    } as never;
    expect(portalBadges(o)).toEqual({ projectsBadge: 2, billingBadge: 4 });
  });
  it("is zero for a null or empty overview", () => {
    expect(portalBadges(null)).toEqual({ projectsBadge: 0, billingBadge: 0 });
    expect(portalBadges({ needsYou: [], finance: { byCurrency: [] } } as never)).toEqual({ projectsBadge: 0, billingBadge: 0 });
  });
});

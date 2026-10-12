import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PACKS } from "./packs";
import { deptSlug, toolkitFor, hasBespokeToolkit, tabHref, deptTabs } from "./deptToolkits";

describe("deptSlug", () => {
  it("normalises names to stable slugs", () => {
    expect(deptSlug("Web Dev")).toBe("web-dev");
    expect(deptSlug("Social Media")).toBe("social-media");
    expect(deptSlug("  GM  ")).toBe("gm");
    expect(deptSlug("R&D / Ops")).toBe("r-d-ops");
  });
});

describe("toolkitFor", () => {
  it("returns the bespoke Web Dev toolkit grouped into the Home·Work·Build·Website·Connections spine", () => {
    const tk = toolkitFor("agency", "Web Dev");
    expect(tk.slug).toBe("web-dev");
    expect(tk.groups.map((g) => g.key)).toEqual(["home", "work", "build", "website", "connections"]);
    // Flattened tabs preserve the full route set (paths unchanged from the flat model).
    expect(deptTabs(tk).map((t) => t.key)).toEqual([
      "home", "projects", "board", "ball", "timeline", "charts", "activity", "prd", "requests", "repositories", "deliverables", "portfolio", "content", "media", "analytics", "leads", "connections",
    ]);
    expect(tk.launchers.some((l) => l.key === "claude-code")).toBe(true);
  });

  // 2026-09-03, owner decision. The Build group carried BOTH a "Portfolio" tab and an "Operations"
  // tab (`key: "sites"`). They read the SAME endpoint, flattened it with the same helper, grouped by
  // server with a verbatim copy of the same function and drew the same chips; Operations' one
  // distinct column was health, sourced from `webdev_sites.last_http_status`/`last_seen_at` — two
  // columns nothing in this program has ever written. It said "Not checked" on every row forever.
  //
  // This case is the guard against it coming back as a tab. The PATH still resolves (it
  // `permanentRedirect`s to the portfolio) so no deep link breaks — it is simply not advertised in
  // the strip, because one dataset does not get two entries.
  it("no longer advertises a second site tab — Operations was merged into Portfolio", () => {
    const tabs = deptTabs(toolkitFor("agency", "Web Dev"));
    expect(tabs.some((t) => t.key === "sites")).toBe(false);
    expect(tabs.some((t) => t.label === "Operations")).toBe(false);
    // Exactly ONE tab points at the site surface, and it is the portfolio.
    const siteTabs = tabs.filter((t) => t.path.startsWith("sites"));
    expect(siteTabs.map((t) => t.path)).toEqual(["sites/portfolio"]);
  });
  it("returns the bespoke Creatives toolkit with a two-tab Studio group and the Work spine", () => {
    const tk = toolkitFor("agency", "Creatives");
    expect(tk.slug).toBe("creatives");
    expect(tk.groups.map((g) => g.key)).toEqual(["home", "work", "studio", "connections"]);
    const studio = tk.groups.find((g) => g.key === "studio");
    expect(studio?.tabs.map((t) => t.path)).toEqual(["studio", "assets"]);
    // The dead "Build Tools" redirect tab is gone from the toolkit.
    expect(deptTabs(tk).some((t) => t.path === "tools")).toBe(false);
    expect(tk.launchers.length).toBeGreaterThan(0);
  });
  // "Legal" is the fallback case now that Social Media is built (SMM-11) — "SMM" stopped being a
  // safe placeholder the moment the addendum corrected the department's real name to "Social
  // Media" (slug `social-media`, NOT `smm`; see deptToolkits.ts's own SOCIAL_MEDIA comment).
  // Pointed at a genuinely unbuilt department rather than deleted — the generic shell is what
  // every department gets before its craft group exists, so it needs a guard.
  it("falls back to a generic Home-only toolkit for unbuilt departments", () => {
    const tk = toolkitFor("agency", "Legal");
    expect(tk.slug).toBe("legal");
    expect(tk.groups.map((g) => g.key)).toEqual(["home"]);
    expect(deptTabs(tk).map((t) => t.key)).toEqual(["home"]);
    expect(tk.launchers).toEqual([]);
  });

  // SEO (SM-11) is the first three-craft-group console: D-10 ratified Accounts /
  // Optimize / Campaigns as separate primary-strip divisions because SEM cannot
  // honestly fit inside four SEO sub-tabs.
  it("gives SEO the Home · Work · Accounts · Optimize · Campaigns · Connections spine", () => {
    const tk = toolkitFor("agency", "SEO");
    expect(tk.slug).toBe("seo");
    expect(tk.groups.map((g) => g.key)).toEqual([
      "home", "work", "accounts", "optimize", "campaigns", "connections",
    ]);
    expect(tk.launchers.length).toBeGreaterThan(0);
  });

  // Every tab a toolkit advertises must have a real route, or the console links
  // people at a 404. These are the paths SM-11 created.
  it("advertises only SEO tab paths that exist as routes", () => {
    const paths = deptTabs(toolkitFor("agency", "SEO")).map((t) => t.path);
    expect(paths).toEqual([
      "", // Home
      "projects", "board", "ball", "timeline", "charts", "activity", // Project Management (generic)
      "engagements", "ledger", "reports",
      "audit", "keywords", "rankings", "gsc-ga4", "briefs", "ai-visibility",
      "planner", "ads", "search-terms", "pacing",
      "connections",
    ]);
  });
});

// WSK-44 — the Website craft group (write-plane design §10, Decision H). Home · Work · Build ·
// **Website** · Connections: the group sits AFTER Build and BEFORE Connections, holds two tabs (Content, and
// since WSK-43c Media), and no other department inherits it.
describe("Website group (WSK-44)", () => {
  const website = () => toolkitFor("agency", "Web Dev").groups.find((g) => g.key === "website");

  it("sits between Build and Connections in the Web Dev primary strip", () => {
    const keys = toolkitFor("agency", "Web Dev").groups.map((g) => g.key);
    expect(keys.indexOf("website")).toBe(keys.indexOf("build") + 1);
    expect(keys.indexOf("website")).toBe(keys.indexOf("connections") - 1);
  });

  it("holds four tabs: Content (the whole /website/content sub-tree), Media (WSK-43c), Analytics (M5-A4) and Leads (M5-L6)", () => {
    expect(website()?.label).toBe("Website");
    expect(website()?.tabs.map((t) => [t.key, t.label, t.path])).toEqual([["content", "Content", "website/content"], ["media", "Media", "website/media"], ["analytics", "Analytics", "website/analytics"], ["leads", "Leads", "website/leads"]]);
    expect(tabHref("dept-1", website()!.tabs[0])).toBe("/departments/dept-1/website/content");
    expect(tabHref("dept-1", website()!.tabs[1])).toBe("/departments/dept-1/website/media");
    expect(tabHref("dept-1", website()!.tabs[2])).toBe("/departments/dept-1/website/analytics");
    expect(tabHref("dept-1", website()!.tabs[3])).toBe("/departments/dept-1/website/leads");
  });

  it("is a Web Dev craft group only: no other department's toolkit advertises it", () => {
    for (const name of ["Creatives", "SEO", "Social Media", "Legal"]) {
      expect(toolkitFor("agency", name).groups.some((g) => g.key === "website")).toBe(false);
      expect(deptTabs(toolkitFor("agency", name)).some((t) => t.key === "content" || t.key === "media")).toBe(false);
    }
  });

  it("keeps the Website tabs' paths unique, and neither a prefix of the other (DeptTabs lights the deepest prefix)", () => {
    const paths = deptTabs(toolkitFor("agency", "Web Dev")).map((t) => t.path);
    expect(new Set(paths).size).toBe(paths.length);
    const web = paths.filter((p) => p.startsWith("website"));
    expect(web.length).toBe(4);
    expect(web.some((a) => web.some((b) => a !== b && b.startsWith(`${a}/`)))).toBe(false);
  });

  // A tab that links at a route which does not exist is a 404 in the strip. Guard it on disk, the way
  // `requireWebsiteCtx` guards the page the other way round (a page 404s without the tab).
  it("advertises a tab whose route file exists, with every route the design's table names", () => {
    const root = resolve(__dirname, "../app/(app)/departments/[deptId]/website");
    for (const rel of [
      "page.tsx",
      "content/page.tsx",
      "content/[tenant]/[site]/page.tsx",
      "content/[tenant]/[site]/[collection]/page.tsx",
      "content/[tenant]/[site]/[collection]/[slug]/page.tsx",
      "content/[tenant]/[site]/[collection]/[slug]/history/page.tsx",
      "media/page.tsx",
      "media/[tenant]/[site]/page.tsx",
      "analytics/page.tsx",
      "analytics/[tenant]/[site]/page.tsx",
      "leads/page.tsx",
      "leads/[tenant]/[site]/page.tsx",
    ]) {
      expect(existsSync(resolve(root, rel)), rel).toBe(true);
    }
  });
});

describe("hasBespokeToolkit", () => {
  it("is true only for departments with a built-out toolkit", () => {
    expect(hasBespokeToolkit("agency", "Web Dev")).toBe(true);
    expect(hasBespokeToolkit("agency", "SEO")).toBe(true);
    expect(hasBespokeToolkit("agency", "Social Media")).toBe(true);
    expect(hasBespokeToolkit("agency", "Legal")).toBe(false);
  });
});

// PV1-04 / PV-D15: a bespoke toolkit belongs to a VERTICAL's pack, not to a department name. The
// same names in a hospitality company (or one with no known vertical) get the generic Home shell.
describe("toolkits follow the vertical's pack", () => {
  it("gives every department slug the agency pack lists a toolkit of that slug", () => {
    for (const slug of PACKS.agency.toolkitDepartments) {
      expect(toolkitFor("agency", slug).slug).toBe(slug);
      expect(hasBespokeToolkit("agency", slug)).toBe(true);
    }
  });
  it("falls back to the generic Home-only toolkit outside the agency vertical", () => {
    for (const vertical of ["hospitality", "holding", "catering", "general", "no-such-vertical", null, undefined]) {
      expect(hasBespokeToolkit(vertical, "Web Dev")).toBe(false);
      expect(hasBespokeToolkit(vertical, "GM")).toBe(false);
      const tk = toolkitFor(vertical, "Web Dev");
      expect(tk.groups.map((g) => g.key)).toEqual(["home"]);
      expect(tk.label).toBe("Web Dev");
      expect(tk.launchers).toEqual([]);
    }
  });
});

// Social Media (SMM-11) — D-18/Δ12: named "Social Media" (slug `social-media`, NOT "SMM"/`smm`),
// inherits Home/Work/Connections unchanged, and adds exactly one new craft group: "Publish".
describe("Social Media toolkit (SMM-11)", () => {
  it("gives Social Media the Home · Work · Publish · Connections spine, slug social-media", () => {
    const tk = toolkitFor("agency", "Social Media");
    expect(tk.slug).toBe("social-media");
    expect(tk.groups.map((g) => g.key)).toEqual(["home", "work", "publish", "connections"]);
    const publish = tk.groups.find((g) => g.key === "publish");
    expect(publish?.tabs.map((t) => t.path)).toEqual(["calendar", "composer", "inbox", "analytics"]);
  });

  it("advertises only tab paths that exist as routes", () => {
    const paths = deptTabs(toolkitFor("agency", "Social Media")).map((t) => t.path);
    expect(paths).toEqual([
      "", // Home
      "projects", "board", "ball", "timeline", "charts", "activity", // Project Management (generic)
      "calendar", "composer", "inbox", "analytics",
      "connections",
    ]);
  });
});

describe("tabHref", () => {
  it("routes the home tab to the console root and others to sub-paths", () => {
    const tk = toolkitFor("agency", "Web Dev");
    const [home, projects] = deptTabs(tk);
    expect(tabHref("dept-1", home)).toBe("/departments/dept-1");
    expect(tabHref("dept-1", projects)).toBe("/departments/dept-1/projects");
  });
});

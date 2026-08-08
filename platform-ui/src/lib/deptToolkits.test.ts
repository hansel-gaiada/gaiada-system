import { describe, it, expect } from "vitest";
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
  it("returns the bespoke Web Dev toolkit grouped into the Home·Work·Build·Connections spine", () => {
    const tk = toolkitFor("Web Dev");
    expect(tk.slug).toBe("web-dev");
    expect(tk.groups.map((g) => g.key)).toEqual(["home", "work", "build", "connections"]);
    // Flattened tabs preserve the full route set (paths unchanged from the flat model).
    expect(deptTabs(tk).map((t) => t.key)).toEqual([
      "home", "projects", "board", "timeline", "charts", "activity", "prd", "requests", "repositories", "deliverables", "connections",
    ]);
    expect(tk.launchers.some((l) => l.key === "claude-code")).toBe(true);
  });
  it("returns the bespoke Creatives toolkit with a two-tab Studio group and the Work spine", () => {
    const tk = toolkitFor("Creatives");
    expect(tk.slug).toBe("creatives");
    expect(tk.groups.map((g) => g.key)).toEqual(["home", "work", "studio", "connections"]);
    const studio = tk.groups.find((g) => g.key === "studio");
    expect(studio?.tabs.map((t) => t.path)).toEqual(["studio", "assets"]);
    // The dead "Build Tools" redirect tab is gone from the toolkit.
    expect(deptTabs(tk).some((t) => t.path === "tools")).toBe(false);
    expect(tk.launchers.length).toBeGreaterThan(0);
  });
  // SMM is the fallback case now that SEO is built (SM-11). Kept pointed at a
  // genuinely unbuilt department rather than deleted — the generic shell is what
  // every department gets before its craft group exists, so it needs a guard.
  it("falls back to a generic Home-only toolkit for unbuilt departments", () => {
    const tk = toolkitFor("SMM");
    expect(tk.slug).toBe("smm");
    expect(tk.groups.map((g) => g.key)).toEqual(["home"]);
    expect(deptTabs(tk).map((t) => t.key)).toEqual(["home"]);
    expect(tk.launchers).toEqual([]);
  });

  // SEO (SM-11) is the first three-craft-group console: D-10 ratified Accounts /
  // Optimize / Campaigns as separate primary-strip divisions because SEM cannot
  // honestly fit inside four SEO sub-tabs.
  it("gives SEO the Home · Work · Accounts · Optimize · Campaigns · Connections spine", () => {
    const tk = toolkitFor("SEO");
    expect(tk.slug).toBe("seo");
    expect(tk.groups.map((g) => g.key)).toEqual([
      "home", "work", "accounts", "optimize", "campaigns", "connections",
    ]);
    expect(tk.launchers.length).toBeGreaterThan(0);
  });

  // Every tab a toolkit advertises must have a real route, or the console links
  // people at a 404. These are the paths SM-11 created.
  it("advertises only SEO tab paths that exist as routes", () => {
    const paths = deptTabs(toolkitFor("SEO")).map((t) => t.path);
    expect(paths).toEqual([
      "", // Home
      "projects", "board", "timeline", "charts", "activity", // Work (generic)
      "engagements", "ledger", "reports",
      "audit", "keywords", "rankings", "gsc-ga4", "briefs", "ai-visibility",
      "planner", "ads", "search-terms", "pacing",
      "connections",
    ]);
  });
});

describe("hasBespokeToolkit", () => {
  it("is true only for departments with a built-out toolkit", () => {
    expect(hasBespokeToolkit("Web Dev")).toBe(true);
    expect(hasBespokeToolkit("SEO")).toBe(true);
    expect(hasBespokeToolkit("SMM")).toBe(false);
  });
});

describe("tabHref", () => {
  it("routes the home tab to the console root and others to sub-paths", () => {
    const tk = toolkitFor("Web Dev");
    const [home, projects] = deptTabs(tk);
    expect(tabHref("dept-1", home)).toBe("/departments/dept-1");
    expect(tabHref("dept-1", projects)).toBe("/departments/dept-1/projects");
  });
});

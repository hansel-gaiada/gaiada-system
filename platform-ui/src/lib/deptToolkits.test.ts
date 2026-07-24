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
      "home", "projects", "board", "timeline", "charts", "activity", "prd", "repositories", "deliverables", "connections",
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
  it("falls back to a generic Home-only toolkit for unbuilt departments", () => {
    const tk = toolkitFor("SEO");
    expect(tk.slug).toBe("seo");
    expect(tk.groups.map((g) => g.key)).toEqual(["home"]);
    expect(deptTabs(tk).map((t) => t.key)).toEqual(["home"]);
    expect(tk.launchers).toEqual([]);
  });
});

describe("hasBespokeToolkit", () => {
  it("is true only for departments with a built-out toolkit", () => {
    expect(hasBespokeToolkit("Web Dev")).toBe(true);
    expect(hasBespokeToolkit("SEO")).toBe(false);
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

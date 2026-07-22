import { describe, it, expect } from "vitest";
import { deptSlug, toolkitFor, hasBespokeToolkit, tabHref } from "./deptToolkits";

describe("deptSlug", () => {
  it("normalises names to stable slugs", () => {
    expect(deptSlug("Web Dev")).toBe("web-dev");
    expect(deptSlug("Social Media")).toBe("social-media");
    expect(deptSlug("  GM  ")).toBe("gm");
    expect(deptSlug("R&D / Ops")).toBe("r-d-ops");
  });
});

describe("toolkitFor", () => {
  it("returns the bespoke Web Dev toolkit with its full tab set", () => {
    const tk = toolkitFor("Web Dev");
    expect(tk.slug).toBe("web-dev");
    expect(tk.tabs.map((t) => t.key)).toEqual([
      "home", "projects", "board", "timeline", "activity", "prd", "repositories", "deliverables", "connections",
    ]);
    expect(tk.launchers.some((l) => l.key === "claude-code")).toBe(true);
  });
  it("returns the bespoke Creatives toolkit with the Image Studio tab", () => {
    const tk = toolkitFor("Creatives");
    expect(tk.slug).toBe("creatives");
    expect(tk.tabs.map((t) => t.key)).toEqual(["home", "studio", "tools"]);
    expect(tk.tabs.some((t) => t.path === "studio")).toBe(true);
    expect(tk.launchers.length).toBeGreaterThan(0);
  });
  it("falls back to a generic Home-only toolkit for unbuilt departments", () => {
    const tk = toolkitFor("SEO");
    expect(tk.slug).toBe("seo");
    expect(tk.tabs.map((t) => t.key)).toEqual(["home"]);
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
    const [home, projects] = tk.tabs;
    expect(tabHref("dept-1", home)).toBe("/departments/dept-1");
    expect(tabHref("dept-1", projects)).toBe("/departments/dept-1/projects");
  });
});

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
    expect(tk.tabs.map((t) => t.key)).toEqual(["overview", "workflow", "prd", "tools"]);
    expect(tk.launchers.some((l) => l.key === "claude-code")).toBe(true);
  });
  it("falls back to a generic Overview-only toolkit for unbuilt departments", () => {
    const tk = toolkitFor("Creatives");
    expect(tk.slug).toBe("creatives");
    expect(tk.tabs.map((t) => t.key)).toEqual(["overview"]);
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
  it("routes the overview tab to the console root and others to sub-paths", () => {
    const tk = toolkitFor("Web Dev");
    const [overview, workflow] = tk.tabs;
    expect(tabHref("dept-1", overview)).toBe("/departments/dept-1");
    expect(tabHref("dept-1", workflow)).toBe("/departments/dept-1/workflow");
  });
});

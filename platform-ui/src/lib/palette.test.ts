import { describe, it, expect } from "vitest";
import { buildNavEntries, buildDeptEntries } from "./palette";
import type { NavGroup } from "@/components/shell/nav";

describe("palette entry builders", () => {
  it("buildNavEntries flattens every group's items, tagging each with its section", () => {
    const groups: NavGroup[] = [
      { label: "Workspace", pinned: true, items: [{ label: "Dashboard", href: "/", icon: "home" }] },
      { label: "Business", items: [{ label: "Clients", href: "/clients", icon: "finance" }] },
    ];
    const entries = buildNavEntries(groups);
    expect(entries).toEqual([
      { id: "nav:/", label: "Dashboard", href: "/", section: "Workspace", icon: "home" },
      { id: "nav:/clients", label: "Clients", href: "/clients", section: "Business", icon: "finance" },
    ]);
  });

  it("falls back to 'Navigate' for the unlabelled Settings group", () => {
    const groups: NavGroup[] = [{ label: "", items: [{ label: "Settings", href: "/admin", icon: "settings" }] }];
    expect(buildNavEntries(groups)[0].section).toBe("Navigate");
  });

  it("buildDeptEntries lists every non-Home tab, skipping the department's own root", () => {
    const entries = buildDeptEntries([{ id: "dept-1", name: "Web Dev" }]);
    expect(entries.every((e) => e.href !== "/departments/dept-1")).toBe(true);
    expect(entries.some((e) => e.label === "Web Dev · Activity")).toBe(true);
    expect(entries.every((e) => e.section === "Departments")).toBe(true);
  });

  it("buildDeptEntries falls back to the generic Home-only toolkit for an unregistered department name", () => {
    // The generic toolkit has only the Home tab, which is deliberately skipped — so this
    // department contributes zero tier-2 entries, not a crash.
    expect(buildDeptEntries([{ id: "dept-9", name: "Legal" }])).toEqual([]);
  });
});

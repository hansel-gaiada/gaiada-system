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
    const entries = buildDeptEntries([{ id: "dept-1", name: "Web Dev" }], "agency");
    expect(entries.every((e) => e.href !== "/departments/dept-1")).toBe(true);
    expect(entries.some((e) => e.label === "Web Dev · Activity")).toBe(true);
    expect(entries.every((e) => e.section === "Departments")).toBe(true);
  });

  // M5-V3-i: a tab that names a capability is offered only when `allow` says the viewer holds it (no palette link that would 404).
  it("buildDeptEntries leaves out a tab the viewer may not open, and offers it to one who may", () => {
    const labels = (allow?: (t: { requires?: string }) => boolean) => buildDeptEntries([{ id: "dept-1", name: "Web Dev" }], "agency", allow as never).map((e) => e.label);
    expect(labels()).toContain("Web Dev · Visitors");
    expect(labels((t) => !t.requires)).not.toContain("Web Dev · Visitors");
    expect(labels((t) => !t.requires)).toContain("Web Dev · Analytics");
    expect(labels((t) => t.requires === "search.visitors.read")).toContain("Web Dev · Visitors");
  });

  it("buildDeptEntries falls back to the generic Home-only toolkit for an unregistered department name", () => {
    // The generic toolkit has only the Home tab, which is deliberately skipped — so this
    // department contributes zero tier-2 entries, not a crash.
    expect(buildDeptEntries([{ id: "dept-9", name: "Legal" }], "agency")).toEqual([]);
  });

  it("buildDeptEntries gives a bespoke department name no tier-2 tabs outside the agency vertical", () => {
    expect(buildDeptEntries([{ id: "dept-1", name: "Web Dev" }], "hospitality")).toEqual([]);
    expect(buildDeptEntries([{ id: "dept-1", name: "Web Dev" }], undefined)).toEqual([]);
  });
});

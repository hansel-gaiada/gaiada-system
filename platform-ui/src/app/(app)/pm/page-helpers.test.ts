import { describe, it, expect } from "vitest";
import { isSwimlane, isView, representativeTag, PM_SWIMLANES } from "./page-helpers";
import type { Tag } from "@/lib/pm";

describe("pm page-helpers", () => {
  it("isSwimlane accepts exactly the four board axes this page mounts", () => {
    expect(isSwimlane("status")).toBe(true);
    expect(isSwimlane("assignee")).toBe(true);
    expect(isSwimlane("ball")).toBe(true);
    expect(isSwimlane("priority")).toBe(true);
    // Division/grid swimlanes are deliberately NOT here — they only mean something inside one
    // department (see the page.tsx header note) and stay on the department board.
    expect(isSwimlane("division")).toBe(false);
    expect(isSwimlane("grid-division")).toBe(false);
    expect(isSwimlane(undefined)).toBe(false);
  });

  it("PM_SWIMLANES lists exactly what isSwimlane accepts, in the same order", () => {
    expect(PM_SWIMLANES.map((s) => s.value)).toEqual(["status", "assignee", "ball", "priority"]);
    for (const s of PM_SWIMLANES) expect(isSwimlane(s.value)).toBe(true);
  });

  it("isView accepts only the three mounted views", () => {
    expect(isView("board")).toBe(true);
    expect(isView("gantt")).toBe(true);
    expect(isView("charts")).toBe(true);
    expect(isView("home")).toBe(false);
    expect(isView("productivity")).toBe(false);
    expect(isView(undefined)).toBe(false);
  });

  it("representativeTag returns the first registry hit for a label, undefined when no project carries it", () => {
    const registries: Record<string, Tag[]> = {
      "p-1": [{ id: "t1", label: "Urgent", color: "clay" }],
      "p-2": [{ id: "t2", label: "Urgent", color: "slate" }, { id: "t3", label: "Design", color: "moss" }],
    };
    expect(representativeTag("Urgent", registries)?.color).toBe("clay");
    expect(representativeTag("Design", registries)?.color).toBe("moss");
    expect(representativeTag("Nope", registries)).toBeUndefined();
  });

  it("representativeTag on an empty registry map returns undefined", () => {
    expect(representativeTag("Anything", {})).toBeUndefined();
  });
});

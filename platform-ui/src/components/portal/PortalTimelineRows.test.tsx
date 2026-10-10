import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PortalProjectRanges, PortalTimelineStream } from "./PortalTimelineRows";
import type { PortalProject, PortalTimelineEvent } from "@/lib/portal";

// The `.cp-tl__row` grid has three columns (when · rail · body). Until 1.0.0-alpha.347 the project
// rows rendered only rail + body, so the body sat in the 14px rail column and "Viceroy Bali — web,
// SEO & social" wrapped one word per line on the live portal. Every row in both lists must render
// exactly these three cells, in this order, dated or not.
const CELLS = ["cp-tl__when", "cp-tl__rail", "cp-tl__body"];

const cellsOf = (row: Element) => Array.from(row.children).map((c) => c.className);

const now = new Date("2026-10-11T03:00:00Z");

const project = (over: Partial<PortalProject>): PortalProject => ({
  id: "p1", name: "Viceroy Bali — web, SEO & social", status: "active", finished: false,
  startDate: "2026-09-01", dueDate: "2026-12-20", clientId: "c1", clientName: "Viceroy Bali",
  progressPercent: 40, milestoneCount: 3, milestonesDone: 1, deliverableCount: 3, nextMilestoneDue: null,
  ...over,
});

const event = (over: Partial<PortalTimelineEvent>): PortalTimelineEvent => ({
  kind: "deliverable", id: "d1", label: "Website", status: "in_progress", at: "2026-11-02",
  tense: "due", context: "Viceroy Bali — web, SEO & social", projectId: "p1",
  ...over,
});

describe("PortalProjectRanges — every row fills the three-column grid", () => {
  it("a dated and an undated project each render when, rail and body", () => {
    const { container } = render(
      <PortalProjectRanges
        now={now}
        projects={[project({}), project({ id: "p2", startDate: null, dueDate: null, progressPercent: 0 })]}
      />,
    );
    const rows = container.querySelectorAll(".cp-tl__row");
    expect(rows).toHaveLength(2);
    rows.forEach((row) => expect(cellsOf(row)).toEqual(CELLS));
  });

  it("the project name and range sit in the body; the due date sits in the when column", () => {
    const { container } = render(<PortalProjectRanges now={now} projects={[project({})]} />);
    const row = container.querySelector(".cp-tl__row")!;
    expect(row.querySelector(".cp-tl__body")!.textContent).toContain("Viceroy Bali — web, SEO & social");
    expect(row.querySelector(".cp-tl__body")!.textContent).toContain("40% complete");
    expect(row.querySelector(".cp-tl__when")!.textContent).toContain("2026");
    expect(row.querySelector(".cp-tl__body a")).toHaveAttribute("href", "/portal/projects/p1");
  });
});

describe("PortalTimelineStream — every row fills the three-column grid", () => {
  it("a dated and an undated event each render when, rail and body", () => {
    const { container } = render(
      <PortalTimelineStream now={now} events={[event({}), event({ id: "d2", label: "SEO", at: null })]} />,
    );
    const rows = container.querySelectorAll(".cp-tl__row");
    expect(rows).toHaveLength(2);
    rows.forEach((row) => expect(cellsOf(row)).toEqual(CELLS));
  });
});

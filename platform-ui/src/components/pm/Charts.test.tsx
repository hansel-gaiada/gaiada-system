import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Charts, tagDistribution } from "./Charts";
import type { TagBreakdownRow, FlowSeries, BurndownPoint, BurndownOverlayPoint } from "@/lib/pm";

// P4-A7: the tag-distribution donut (reusing `components/reports/charts/Donut` unmodified)
// alongside the existing ranked bars, at every PM scope (this component is unchanged by scope —
// `pmScope-data.ts` is what varies).

const emptyFlow: FlowSeries = { dates: [], bands: [], counts: [], stacked: [] };
const emptyBurndown: BurndownPoint[] = [];
const emptyOverlay: BurndownOverlayPoint[] = [];

describe("tagDistribution", () => {
  it("maps tag rows to donut slices, keyed and labelled for a tag-distribution chart", () => {
    const rows: TagBreakdownRow[] = [
      { tagId: "t-1", label: "SEO", color: "clay", count: 3, pct: 60 },
      { tagId: "t-2", label: "Design", color: "moss", count: 1, pct: 20 },
    ];
    const dist = tagDistribution(rows);
    expect(dist.kind).toBe("donut");
    expect(dist.slices).toEqual([
      { label: "SEO", value: 3, ref: { kind: "tag", id: "t-1" } },
      { label: "Design", value: 1, ref: { kind: "tag", id: "t-2" } },
    ]);
  });

  // The whole reason this isn't a one-line "just pass tagRows to Donut": tagBreakdown is a tag
  // CLOUD (a task can count toward several tags), so its own `pct` is "share of tasks" and can sum
  // past 100% — a donut's angles have to sum to 360°, so the Untagged row (which answers "how many
  // tasks have NO tag", a different question from "how are the tags distributed") must not become
  // a slice, or the donut and the ranked bars would show two different numbers for the same label
  // that both call themselves a percentage.
  it("drops the trailing Untagged row — a donut's slices must sum to a whole, tagBreakdown's pct does not", () => {
    const rows: TagBreakdownRow[] = [
      { tagId: "t-1", label: "SEO", color: "clay", count: 2, pct: 50 },
      { tagId: null, label: "Untagged", color: null, count: 2, pct: 50 },
    ];
    const dist = tagDistribution(rows);
    expect(dist.slices.map((s) => s.label)).toEqual(["SEO"]);
  });

  it("no tags anywhere -> empty slices, never throws", () => {
    expect(tagDistribution([]).slices).toEqual([]);
    expect(tagDistribution([{ tagId: null, label: "Untagged", color: null, count: 4, pct: 100 }]).slices).toEqual([]);
  });
});

describe("Charts — tag breakdown section", () => {
  const kpis = { open: 1, done: 1, avgProgress: 50 };

  it("renders both the donut and the ranked bars for the same tag rows", () => {
    const tagRows: TagBreakdownRow[] = [
      { tagId: "t-1", label: "SEO", color: "clay", count: 3, pct: 75 },
      { tagId: null, label: "Untagged", color: null, count: 1, pct: 25 },
    ];
    const { container } = render(
      <Charts kpis={kpis} flow={emptyFlow} burndownSeries={emptyBurndown} burndownOverlay={emptyOverlay} tagRows={tagRows} />,
    );
    // The donut (rc- chart kit) and the ranked bars (pm-tagbar) both render off the SAME rows.
    expect(container.querySelector(".rc-viz")).toBeTruthy();
    expect(container.querySelectorAll(".pm-tagbar")).toHaveLength(2);
    // Untagged shows in the bars (it's a real row of the ranked list) …
    expect(container.textContent).toContain("Untagged");
    // … but the donut's own legend only ever lists tagged slices (see `tagDistribution`).
    const donutLegend = container.querySelector(".rc-legend")?.textContent ?? "";
    expect(donutLegend).toContain("SEO");
    expect(donutLegend).not.toContain("Untagged");
  });

  it("no tasks at all -> one EmptyNote, no donut and no bars", () => {
    const { container } = render(
      <Charts kpis={{ open: 0, done: 0, avgProgress: 0 }} flow={emptyFlow} burndownSeries={emptyBurndown} burndownOverlay={emptyOverlay} tagRows={[]} />,
    );
    expect(container.querySelector(".rc-viz")).toBeNull();
    expect(container.querySelectorAll(".pm-tagbar")).toHaveLength(0);
    expect(container.textContent).toContain("No tasks yet");
  });

  it("tags exist but every task is untagged -> bars show Untagged, donut falls back to its own empty state", () => {
    const tagRows: TagBreakdownRow[] = [{ tagId: null, label: "Untagged", color: null, count: 2, pct: 100 }];
    const { container } = render(
      <Charts kpis={kpis} flow={emptyFlow} burndownSeries={emptyBurndown} burndownOverlay={emptyOverlay} tagRows={tagRows} />,
    );
    expect(container.querySelectorAll(".pm-tagbar")).toHaveLength(1);
    expect(container.querySelector(".rc-viz")).toBeNull();
    expect(container.textContent).toContain("No data yet for tag distribution");
  });
});

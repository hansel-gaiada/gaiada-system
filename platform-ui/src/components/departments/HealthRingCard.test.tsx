import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { HealthRingCard } from "./HealthRingCard";

const COMPOSITION = { done: 5, blocked: 1, overdue: 3, onTrack: 0, total: 9 };

describe("HealthRingCard", () => {
  it("leads with the open count and states the total and milestone underneath", () => {
    render(
      <HealthRingCard
        projectName="Client Portal Revamp"
        href="/projects/abc"
        progressPct={72}
        openCount={5}
        nextMilestone={{ label: "Beta launch", dueDate: "2026-08-01" }}
        atRisk={false}
        composition={COMPOSITION}
      />
    );
    expect(screen.getByRole("link", { name: "Client Portal Revamp" })).toBeInTheDocument();
    expect(screen.getByText("5", { selector: ".dept-ring-card__lead-value" })).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    // The date is its own nowrap element, so it is not part of the paragraph's own text nodes.
    expect(screen.getByText(/of 9 tasks · 72% complete · Beta launch/)).toBeInTheDocument();
    expect(screen.getByText("1 Aug")).toHaveClass("dept-ring-card__date");
    expect(screen.queryByText("At risk")).not.toBeInTheDocument();
  });

  it("draws one ring segment per non-empty bucket and a legend row to read it by", () => {
    const { container } = render(
      <HealthRingCard projectName="P" progressPct={55} openCount={4} atRisk composition={COMPOSITION} />
    );
    // onTrack is 0, so three segments — an empty bucket must not draw a zero-length slice.
    expect(container.querySelectorAll(".dept-ring__seg")).toHaveLength(3);
    expect(container.querySelector(".dept-ring__seg--onTrack")).toBeNull();
    expect(container.querySelectorAll(".dept-ring-legend__row")).toHaveLength(3);
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText("blocked")).toBeInTheDocument();
    expect(screen.getByText("overdue")).toBeInTheDocument();
    // The ring is an image to a screen reader; the legend it stands for is its label.
    expect(screen.getByRole("img")).toHaveAccessibleName("9 tasks: 5 done, 1 blocked, 3 overdue");
  });

  it("shows the at-risk badge, and does NOT repeat the reason when the legend already states it", () => {
    render(
      <HealthRingCard
        projectName="SEO Migration"
        progressPct={30}
        openCount={9}
        nextMilestone={null}
        atRisk
        atRiskReason="3 overdue · 1 blocked"
        composition={COMPOSITION}
      />
    );
    expect(screen.getByText("At risk")).toBeInTheDocument();
    expect(screen.queryByText("3 overdue · 1 blocked")).not.toBeInTheDocument();
  });

  it("falls back to the reason line for a caller that passes no composition", () => {
    const { container } = render(
      <HealthRingCard projectName="Legacy" progressPct={30} openCount={9} atRisk atRiskReason="2 overdue" />
    );
    expect(container.querySelector(".dept-ring")).toBeNull();
    expect(screen.getByText("2 overdue")).toBeInTheDocument();
  });

  it("names an empty project instead of drawing a 0% ring", () => {
    const { container } = render(
      <HealthRingCard
        projectName="Fresh"
        progressPct={0}
        openCount={0}
        atRisk={false}
        composition={{ done: 0, blocked: 0, overdue: 0, onTrack: 0, total: 0 }}
      />
    );
    expect(container.querySelector(".dept-ring")).toBeNull();
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
  });

  it("pins the milestone date's locale and time zone so server and client agree", () => {
    render(
      <HealthRingCard
        projectName="P"
        progressPct={0}
        openCount={1}
        nextMilestone={{ label: "Launch", dueDate: "2026-07-20" }}
        atRisk={false}
        composition={{ done: 0, blocked: 0, overdue: 0, onTrack: 1, total: 1 }}
      />
    );
    // en-GB + UTC: never "Jul 19" from a negative-offset runtime, never "20/07/2026" from en-GB
    // defaults, never a US "Jul 20" from an en-US one.
    expect(screen.getByText("20 Jul")).toBeInTheDocument();
  });
});

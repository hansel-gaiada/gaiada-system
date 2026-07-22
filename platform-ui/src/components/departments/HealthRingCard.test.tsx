import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { HealthRingCard } from "./HealthRingCard";

describe("HealthRingCard", () => {
  it("renders progress, open count, and next milestone", () => {
    render(
      <HealthRingCard
        projectName="Client Portal Revamp"
        href="/projects/abc"
        progressPct={72}
        openCount={5}
        nextMilestone={{ label: "Beta launch", dueDate: "2026-08-01" }}
        atRisk={false}
      />
    );
    expect(screen.getByRole("link", { name: "Client Portal Revamp" })).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText(/Beta launch/)).toBeInTheDocument();
    expect(screen.queryByText("At risk")).not.toBeInTheDocument();
  });

  it("shows the at-risk badge and reason when atRisk is true", () => {
    render(
      <HealthRingCard
        projectName="SEO Migration"
        progressPct={30}
        openCount={9}
        nextMilestone={null}
        atRisk
        atRiskReason="2 overdue · 1 blocked"
      />
    );
    expect(screen.getByText("At risk")).toBeInTheDocument();
    expect(screen.getByText("2 overdue · 1 blocked")).toBeInTheDocument();
    expect(screen.getByText("None set")).toBeInTheDocument();
  });
});

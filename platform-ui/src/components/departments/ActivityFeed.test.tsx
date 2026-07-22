import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ActivityFeed } from "./ActivityFeed";

describe("ActivityFeed", () => {
  it("renders the teach empty-state when there are no items", () => {
    render(<ActivityFeed items={[]} emptyCtaLabel="Connect a repository" emptyCtaHref="/departments/web-dev/connections" />);
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect a repository" })).toHaveAttribute("href", "/departments/web-dev/connections");
  });

  it("renders activity rows with actor, verb, object, and source", () => {
    render(
      <ActivityFeed
        items={[
          { id: "1", actor: "Priya Shah", verb: "shipped", objectLabel: "Task: Fix login redirect", occurredAt: new Date().toISOString(), source: "pm", href: "/departments/web-dev/board" },
          { id: "2", verb: "opened a PR for", objectLabel: "Repo: web-storefront", occurredAt: new Date(Date.now() - 90_000).toISOString(), source: "github" },
        ]}
      />
    );
    expect(screen.getByText("Priya Shah")).toBeInTheDocument();
    expect(screen.getByText(/Fix login redirect/)).toBeInTheDocument();
    expect(screen.getByText("PM")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
  });
});

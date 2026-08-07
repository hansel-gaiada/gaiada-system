import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MyWorkRail } from "./MyWorkRail";

describe("MyWorkRail", () => {
  it("renders empty copy for both sections when there is nothing to show", () => {
    render(<MyWorkRail today={[]} waiting={[]} />);
    expect(screen.getByText("My work today")).toBeInTheDocument();
    expect(screen.getByText("Nothing due — a clear day.")).toBeInTheDocument();
    expect(screen.getByText("Waiting on me")).toBeInTheDocument();
    expect(screen.getByText("Nothing waiting on you.")).toBeInTheDocument();
  });

  it("badges an overdue task and labels an approval waiting item", () => {
    // P4-G5: the rail no longer derives the badge itself from `dueDate` (that was a local
    // `new Date()` comparison — exactly the drift the urgency ticket exists to close). The tier
    // is now precomputed by the caller and handed in via `urgencyTier`, same as every other render
    // site; this test pins that the rail renders whatever tier it's given, verbatim.
    const { container } = render(
      <MyWorkRail
        today={[{ id: "t1", title: "Wire the org-structure endpoint", href: "/tasks/t1", dueDate: "2020-01-01", urgencyTier: "overdue", priority: "high" }]}
        waiting={[{ id: "w1", title: "Creative asset sign-off", kind: "approval", waitingOn: "Client review", href: "/approvals/w1" }]}
      />
    );
    expect(screen.getByText("Wire the org-structure endpoint")).toBeInTheDocument();
    // The dot + its sr-only child both carry the "Overdue …" text — assert via class, same
    // reasoning as UrgencyChip.test.tsx / Board.test.tsx.
    expect(container.querySelector(".pm-urg--overdue")).toBeTruthy();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("Approval")).toBeInTheDocument();
    expect(screen.getByText("Client review")).toBeInTheDocument();
  });

  it("renders no urgency indicator when the caller supplies no tier (undated/never resolved)", () => {
    render(
      <MyWorkRail
        today={[{ id: "t2", title: "No due date yet", href: "/tasks/t2" }]}
        waiting={[]}
      />
    );
    expect(screen.getByText("No due date yet")).toBeInTheDocument();
    expect(document.querySelector(".pm-urg")).toBeNull();
  });

  // P4-K3 — the ball-holder queue section is entirely optional so every render site that has not
  // wired the ball queue yet keeps compiling and rendering exactly as before.
  it("omits the ball section entirely when the prop is not supplied", () => {
    render(<MyWorkRail today={[]} waiting={[]} />);
    expect(screen.queryByText(/is with you/)).toBeNull();
  });

  it("shows the ball empty state when the caller supplies an empty array", () => {
    render(<MyWorkRail today={[]} waiting={[]} ball={[]} />);
    expect(screen.getByText("Ball is with you")).toBeInTheDocument();
    expect(screen.getByText("Nothing on your ball right now.")).toBeInTheDocument();
  });

  it("renders ball items with readiness and a precomputed urgency tier, never deriving either", () => {
    const { container } = render(
      <MyWorkRail
        today={[]}
        waiting={[]}
        ball={[
          { id: "b1", title: "Ship the deck", href: "/tasks/b1", projectName: "Northwind rebrand", dueDate: "2020-01-01", urgencyTier: "overdue", readiness: "ready" },
          { id: "b2", title: "Review copy", readiness: "blocked" },
        ]}
      />
    );
    expect(screen.getByText("Ball is with you")).toBeInTheDocument();
    expect(screen.getByText("Ship the deck")).toBeInTheDocument();
    expect(screen.getByText("Northwind rebrand")).toBeInTheDocument();
    expect(container.querySelector(".pm-urg--overdue")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });

  it("renders a custom ball empty-state message when supplied", () => {
    render(<MyWorkRail today={[]} waiting={[]} ball={[]} ballEmptyText="Nobody's turn — all clear." />);
    expect(screen.getByText("Nobody's turn — all clear.")).toBeInTheDocument();
  });
});

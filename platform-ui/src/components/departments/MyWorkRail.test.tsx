import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MyWorkRail } from "./MyWorkRail";

describe("MyWorkRail", () => {
  it("collapses an empty section to its heading plus a one-word verdict", () => {
    const { container } = render(<MyWorkRail today={[]} waiting={[]} />);
    expect(screen.getByText("My work today")).toBeInTheDocument();
    expect(screen.getByText("Waiting on me")).toBeInTheDocument();
    // Two sections, two verdicts, no body sentences: an idle rail must not out-weigh a busy one.
    expect(container.querySelectorAll(".dept-rail__section--clear")).toHaveLength(2);
    expect(container.querySelectorAll(".dept-rail__clear")).toHaveLength(2);
    expect(container.querySelector(".dept-rail__list")).toBeNull();
  });

  it("puts a count on every non-empty section heading", () => {
    const { container } = render(
      <MyWorkRail
        today={[{ id: "t1", title: "A" }, { id: "t2", title: "B" }]}
        waiting={[{ id: "w1", title: "C", kind: "approval" }]}
      />
    );
    expect([...container.querySelectorAll(".dept-rail__count")].map((n) => n.textContent)).toEqual(["2", "1"]);
  });

  it("prints the kind on a waiting row only when the list is mixed", () => {
    const approvalsOnly = render(
      <MyWorkRail today={[]} waiting={[{ id: "w1", title: "A", kind: "approval" }, { id: "w2", title: "B", kind: "approval" }]} />
    );
    // Uniform list: the heading already said what these are, so five identical "APPROVAL" labels
    // down one column are dropped.
    expect(approvalsOnly.container.querySelector(".dept-rail__kind")).toBeNull();
    approvalsOnly.unmount();

    const mixed = render(
      <MyWorkRail today={[]} waiting={[{ id: "w1", title: "A", kind: "approval" }, { id: "w2", title: "B", kind: "blocked_task" }]} />
    );
    expect([...mixed.container.querySelectorAll(".dept-rail__kind")].map((n) => n.textContent)).toEqual(["Approval", "Blocked"]);
  });

  it("shows the caller's wait age and marks only the stale rows", () => {
    const { container } = render(
      <MyWorkRail
        today={[]}
        waiting={[
          { id: "w1", title: "Ad spend increase", kind: "approval", age: "8d", stale: true },
          { id: "w2", title: "PM review", kind: "approval", age: "2d" },
        ]}
      />
    );
    expect(screen.getByText("8d")).toBeInTheDocument();
    expect(screen.getByText("2d")).toBeInTheDocument();
    // The rust bar only means "this needs you" while most rows do not carry it.
    expect(container.querySelectorAll(".dept-rail__item--stale")).toHaveLength(1);
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
    // One kind in the list, so the row prints no "Approval" label — the section heading is the
    // label. The caption survives, because it is the part that differs per row.
    expect(container.querySelector(".dept-rail__kind")).toBeNull();
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
    const { container } = render(<MyWorkRail today={[]} waiting={[]} ball={[]} />);
    expect(screen.getByText("Ball is with you")).toBeInTheDocument();
    expect(container.querySelectorAll(".dept-rail__section--clear")).toHaveLength(3);
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
    render(<MyWorkRail today={[]} waiting={[]} ball={[]} ballEmptyText="nobody's turn" />);
    expect(screen.getByText("nobody's turn")).toBeInTheDocument();
  });
});

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
});

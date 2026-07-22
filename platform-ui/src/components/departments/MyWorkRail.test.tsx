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
    render(
      <MyWorkRail
        today={[{ id: "t1", title: "Wire the org-structure endpoint", href: "/tasks/t1", dueDate: "2020-01-01", priority: "high" }]}
        waiting={[{ id: "w1", title: "Creative asset sign-off", kind: "approval", waitingOn: "Client review", href: "/approvals/w1" }]}
      />
    );
    expect(screen.getByText("Wire the org-structure endpoint")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("Approval")).toBeInTheDocument();
    expect(screen.getByText("Client review")).toBeInTheDocument();
  });
});

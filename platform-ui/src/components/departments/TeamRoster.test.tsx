import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TeamRoster } from "./TeamRoster";

const member = (id: string, name: string, openCount = 0, blockedCount = 0) => ({ id, name, openCount, blockedCount });

describe("TeamRoster", () => {
  it("groups people under their division label and links each name", () => {
    render(
      <TeamRoster
        groups={[{ id: "d1", label: "Frontend", people: [member("u1", "Made Putra", 4, 1)] }]}
        personHref={(id) => `/people/${id}`}
      />
    );
    expect(screen.getByText("Frontend")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Made Putra/ })).toHaveAttribute("href", "/people/u1");
    expect(screen.getByText("4 open")).toBeInTheDocument();
    // Blocked is announced in words — the visible mark plus a digit says nothing on its own.
    expect(screen.getByRole("img", { name: "1 blocked" })).toBeInTheDocument();
  });

  it("says a person has nothing open rather than leaving the number blank", () => {
    const { container } = render(<TeamRoster groups={[{ id: "d1", label: "Frontend", people: [member("u1", "A")] }]} />);
    expect(screen.getByText("nothing open")).toBeInTheDocument();
    // A blank would read as "we failed to count", so no empty load cell is emitted.
    expect(container.querySelector(".dept-team__open")).toBeNull();
    expect(container.querySelector(".dept-team__blocked")).toBeNull();
  });

  it("renders an unstaffed division as one line, not as an empty list", () => {
    const { container } = render(<TeamRoster groups={[{ id: "d2", label: "Backend", people: [] }]} />);
    expect(screen.getByText("No one placed yet")).toBeInTheDocument();
    expect(container.querySelector(".dept-team__list")).toBeNull();
  });

  it("renders names as plain text when no href builder is passed", () => {
    render(<TeamRoster groups={[{ id: "d1", label: "Frontend", people: [member("u1", "Made Putra")] }]} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Made Putra")).toBeInTheDocument();
  });
});

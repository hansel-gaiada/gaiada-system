import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { PositionRow } from "./PositionRow";

// SCP-1q (SCP-Q23): nobody edits a position they hold. The SERVER refuses it (the `position` update self-EDIT DENY); this is the
// mirror, which only stops offering the three edit controls on a seat the viewer holds and says why. Retire is not an edit.

const noop = async () => ({ ok: true as const, message: "done" });
const base = {
  positionId: "p1",
  title: "Head of Web",
  status: "active" as const,
  unitOptions: [{ value: "d-web", label: "Web" }],
  roleOptions: [{ value: "r1", label: "member" }],
  memberOptions: [{ value: "u1", label: "Pat (pat@example.test)" }],
  attachedRoles: [{ roleId: "r1", role: "member" }],
  canCompose: true,
  canPlace: true,
  attachRole: noop, detachRole: noop, assignPosition: noop, requestAssignment: noop, updatePosition: noop, retirePosition: noop,
};

describe("PositionRow: the viewer's own seat (SCP-Q23)", () => {
  it("a seat the viewer does not hold keeps Attach role, Detach role, Edit and Retire", () => {
    render(<PositionRow {...base} heldByMe={false} />);
    for (const name of ["Attach role", "Detach role", "Edit", "Retire"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByTestId("position-self-edit-note")).toBeNull();
  });

  it("an omitted heldByMe (an older server) reads as not held", () => {
    render(<PositionRow {...base} />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("a seat the viewer holds shows the reason in place of Attach role, Detach role and Edit, and keeps Retire", () => {
    render(<PositionRow {...base} heldByMe />);
    expect(screen.getByTestId("position-self-edit-note")).toHaveTextContent("you hold this seat");
    for (const name of ["Attach role", "Detach role", "Edit"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Retire" })).toBeInTheDocument();
  });

  it("a viewer who cannot compose sees no reason note (there is nothing to disable)", () => {
    render(<PositionRow {...base} canCompose={false} heldByMe />);
    expect(screen.queryByTestId("position-self-edit-note")).toBeNull();
  });
});

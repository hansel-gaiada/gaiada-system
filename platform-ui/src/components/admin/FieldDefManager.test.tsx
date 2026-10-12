import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { FieldDefManager, type AdminActionState } from "./FieldDefManager";
import type { FieldDef } from "@/lib/entities";

// Deleting a def revalidates /admin/modules; since Next 16.3 the refreshed defs (the row gone) are applied
// right after the action. The rerender below stands in for that refresh: "Field deleted." must survive it.
const def = (key: string): FieldDef => ({ key, label: key.toUpperCase(), data_type: "text", required: false } as FieldDef);
const create = vi.fn(async (): Promise<AdminActionState> => ({ ok: true }));

describe("FieldDefManager delete confirmation", () => {
  it("still says 'Field deleted.' after the refresh removes the row", async () => {
    const del = vi.fn(async (): Promise<AdminActionState> => ({ ok: true }));
    const props = { entityType: "client", createAction: create, deleteAction: del };
    const { rerender } = render(<FieldDefManager {...props} defs={[def("a"), def("b")]} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    await screen.findByText("Field deleted.");
    rerender(<FieldDefManager {...props} defs={[def("b")]} />);
    expect(screen.getByText("Field deleted.")).toBeInTheDocument();
    expect(screen.getByText("Field deleted.")).toHaveAttribute("role", "status");
  });

  it("a refusal shows the error and no success", async () => {
    const del = vi.fn(async (): Promise<AdminActionState> => ({ ok: false, error: "In use." }));
    render(<FieldDefManager entityType="client" createAction={create} deleteAction={del} defs={[def("a")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText("In use.");
    expect(screen.queryByText("Field deleted.")).toBeNull();
  });
});

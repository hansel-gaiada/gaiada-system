import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RoleManager, type AdminActionState } from "./RoleManager";

// Revoking a grant revalidates /admin/users; since Next 16.3 the refreshed grants (the chip gone) are
// applied right after the action. The rerender stands in for that refresh: "Role revoked." must survive it.
const ok = async (): Promise<AdminActionState> => ({ ok: true });
const grant = (id: string, role: string) => ({ grantId: id, role, scopeType: "company", scopeId: null });

describe("RoleManager revoke confirmation", () => {
  it("still says 'Role revoked.' after the refresh removes the chip", async () => {
    const props = { userId: "u-1", roles: [], orgUnits: [], assign: ok, revoke: vi.fn(ok), revokeSession: ok };
    const { rerender } = render(<RoleManager {...props} currentRoles={[grant("g1", "Manager"), grant("g2", "Editor")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke Manager" }));
    await screen.findByText("Role revoked.");
    rerender(<RoleManager {...props} currentRoles={[grant("g2", "Editor")]} />);
    expect(screen.getByText("Role revoked.")).toHaveAttribute("role", "status");
  });
});

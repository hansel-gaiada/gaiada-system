import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ModuleToggle, type AdminActionState } from "./ModuleToggle";

// The toggle's toast must name what the submission DID, not the `enabled` prop. The action revalidates
// /admin/modules, and since Next 16.3 the refreshed (already flipped) prop arrives with the result —
// the rerender below stands in for that refresh.
describe("ModuleToggle", () => {
  const ok = (): ((p: AdminActionState | null, f?: FormData) => Promise<AdminActionState>) => vi.fn(async () => ({ ok: true }));

  it("enabling says 'enabled' even after the refresh flips the prop", async () => {
    const action = ok();
    const { rerender } = render(<ModuleToggle module="pm" enabled={false} action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await screen.findByText("Module enabled.");
    rerender(<ModuleToggle module="pm" enabled action={action} />);
    expect(screen.getByText("Module enabled.")).toBeInTheDocument();
    expect(screen.queryByText("Module disabled.")).toBeNull();
  });

  it("disabling says 'disabled' even after the refresh flips the prop", async () => {
    const action = ok();
    const { rerender } = render(<ModuleToggle module="pm" enabled action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await screen.findByText("Module disabled.");
    rerender(<ModuleToggle module="pm" enabled={false} action={action} />);
    expect(screen.getByText("Module disabled.")).toBeInTheDocument();
    expect(screen.queryByText("Module enabled.")).toBeNull();
  });

  it("a refusal toasts the server's error, not a success", async () => {
    const action = vi.fn(async () => ({ ok: false, error: "Module 'pm' is required." }));
    render(<ModuleToggle module="pm" enabled action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await screen.findByText("Module 'pm' is required.");
    expect(screen.queryByText(/Module (enabled|disabled)\./)).toBeNull();
  });
});

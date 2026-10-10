import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UserMenu } from "./UserMenu";

vi.mock("@/app/(app)/account/actions", () => ({ logout: vi.fn() }));

// PV2-06: "Client view" appears only when the caller is an active client contact somewhere
// (TopBar computes `clientView` from `(me.clientOf ?? []).length > 0`).
function openMenu(clientView: boolean) {
  const { container } = render(
    <UserMenu name="Viceroy Marketer" secondary="Marketing lead" initials="VM" compact clientView={clientView} />,
  );
  fireEvent.click(container.querySelector(".erp-usermenu__trigger") as HTMLElement);
  return screen.getByRole("menu");
}

describe("UserMenu — Client view link (PV2-06)", () => {
  it("shows Client view to a staff member who is also a client contact (demo-viceroy-marketing)", () => {
    const menu = openMenu(true);
    const link = screen.getByRole("menuitem", { name: "Client view" });
    expect(link).toHaveAttribute("href", "/portal");
    expect(menu).toContainElement(link);
  });

  it("hides Client view for staff with no clientOf (demo-hansel)", () => {
    openMenu(false);
    expect(screen.queryByRole("menuitem", { name: "Client view" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Account settings" })).toBeInTheDocument();
  });
});

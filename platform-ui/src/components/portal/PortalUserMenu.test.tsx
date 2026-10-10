import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PortalUserMenu } from "./PortalUserMenu";

vi.mock("@/app/(app)/account/actions", () => ({ logout: vi.fn() }));

// PV2-06: "Back to workspace" appears only for staff. The caller computes `staff` with isStaff(me).
function openMenu(staff: boolean) {
  const { container } = render(<PortalUserMenu initials="VM" staff={staff} />);
  fireEvent.click(container.querySelector(".erp-usermenu__trigger") as HTMLElement);
  return screen.getByRole("menu");
}

describe("PortalUserMenu — Back to workspace link (PV2-06)", () => {
  it("shows Back to workspace to a staff member who is also a client (demo-viceroy-marketing)", () => {
    openMenu(true);
    const link = screen.getByRole("menuitem", { name: "Back to workspace" });
    expect(link).toHaveAttribute("href", "/");
  });

  it("hides Back to workspace for a pure client (demo-client)", () => {
    openMenu(false);
    expect(screen.queryByRole("menuitem", { name: "Back to workspace" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Your profile" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });
});

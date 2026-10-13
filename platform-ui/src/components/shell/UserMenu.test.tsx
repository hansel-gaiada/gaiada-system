import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UserMenu } from "./UserMenu";
import { setShellLayoutAction } from "@/lib/prefsActions";

vi.mock("@/app/(app)/account/actions", () => ({ logout: vi.fn() }));
vi.mock("@/lib/prefsActions", () => ({ setShellLayoutAction: vi.fn(async () => {}), setThemeAction: vi.fn(async () => {}) }));

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

describe("UserMenu — accessible name", () => {
  it("names the compact (avatar-only) trigger by the user, not their initials", () => {
    render(<UserMenu name="Clement Hansel" secondary="AI Manager" initials="CH" compact />);
    expect(screen.getByRole("button", { name: "Clement Hansel" })).toHaveAttribute("aria-haspopup", "menu");
  });
});

// DW-2a: the visible pilot switch between the classic shell and the workspace shell.
describe("UserMenu — the layout switch (DW-2a)", () => {
  function open(shellLayout?: "classic" | "workspaces") {
    const { container } = render(<UserMenu name="U" secondary="x" initials="U" compact shellLayout={shellLayout} />);
    fireEvent.click(container.querySelector(".erp-usermenu__trigger") as HTMLElement);
  }

  it("offers the new layout from the classic one, and stores the choice", async () => {
    vi.mocked(setShellLayoutAction).mockClear();
    open("classic");
    fireEvent.click(screen.getByRole("menuitem", { name: "Try the new layout" }));
    await waitFor(() => expect(setShellLayoutAction).toHaveBeenCalledWith("workspaces"));
    expect(screen.queryByRole("menuitem", { name: "Back to the classic layout" })).toBeNull();
  });

  it("offers the way back from the new layout", async () => {
    vi.mocked(setShellLayoutAction).mockClear();
    open("workspaces");
    fireEvent.click(screen.getByRole("menuitem", { name: "Back to the classic layout" }));
    await waitFor(() => expect(setShellLayoutAction).toHaveBeenCalledWith("classic"));
  });

  it("shows no switch when the caller passes no layout", () => {
    open();
    expect(screen.queryByRole("menuitem", { name: /layout/ })).toBeNull();
  });
});

// DW-2c: the workspace top bar passes `theme`, which puts the Theme control in the menu.
describe("UserMenu — the Theme control (DW-2c)", () => {
  function open(theme?: "auto" | "light" | "dark") {
    const { container } = render(<UserMenu name="U" secondary="x" initials="U" compact theme={theme} />);
    fireEvent.click(container.querySelector(".erp-usermenu__trigger") as HTMLElement);
    return screen.getByRole("menu");
  }

  it("shows Theme first in the menu, with the current theme checked", () => {
    const menu = open("dark");
    expect(menu.firstElementChild).toBe(screen.getByRole("group", { name: "Theme" }));
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(screen.getByRole("menuitem", { name: "Account settings" })).toBeInTheDocument();
  });

  it("shows nothing of it without the prop, so the classic menu is as it was", () => {
    open();
    expect(screen.queryByRole("group", { name: "Theme" })).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});

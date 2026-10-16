import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UserMenu } from "./UserMenu";

vi.mock("@/app/(app)/account/actions", () => ({ logout: vi.fn() }));
vi.mock("@/lib/prefsActions", () => ({ setThemeAction: vi.fn(async () => {}) }));

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

// DW-D38: there is one layout, so the avatar menu has no layout switch to offer.
describe("UserMenu — no layout switch (DW-D38)", () => {
  it("offers Account settings and Sign out and nothing about the layout, with or without a theme", () => {
    for (const theme of [undefined, "dark" as const]) {
      const { container, unmount } = render(<UserMenu name="U" secondary="x" initials="U" compact theme={theme} />);
      fireEvent.click(container.querySelector(".erp-usermenu__trigger") as HTMLElement);
      const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
      expect(items).toEqual(expect.arrayContaining(["Account settings", "Sign out"]));
      expect(items.join("|")).not.toMatch(/layout|classic/i);
      unmount();
    }
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
    expect(screen.getByRole("menuitem", { name: "Account settings" })).toBeInTheDocument();
  });

  it("offers the themes as menu radios inside the menu, never a radiogroup there (DW-9b-2: aria-required-children)", () => {
    open("dark");
    const theme = screen.getByRole("group", { name: "Theme" });
    expect(within(theme).getAllByRole("menuitemradio").map((b) => b.getAttribute("aria-label"))).toEqual(["Match device", "Light", "Dark"]);
    expect(within(theme).getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    expect(within(theme).getByRole("menuitemradio", { name: "Light" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("shows nothing of it without the prop, so the menu is as it was", () => {
    open();
    expect(screen.queryByRole("group", { name: "Theme" })).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});

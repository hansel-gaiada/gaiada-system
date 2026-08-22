import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Menu, MenuItem } from "./Menu";

describe("Menu", () => {
  it("opens the panel when the trigger fires toggle, closes on outside click", () => {
    render(
      <div>
        <Menu label="Actions" trigger={(s) => <button type="button" onClick={s.toggle}>Open</button>}>
          <MenuItem>One</MenuItem>
        </Menu>
        <button type="button">Outside</button>
      </div>,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("menu", { name: "Actions" })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape", () => {
    render(
      <Menu label="Actions" trigger={(s) => <button type="button" onClick={s.toggle}>Open</button>}>
        <MenuItem>One</MenuItem>
      </Menu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("MenuItem renders as a checkbox item when `checked` is set", () => {
    render(
      <Menu label="Columns" trigger={(s) => <button type="button" onClick={s.toggle}>Open</button>}>
        <MenuItem checked>Name</MenuItem>
      </Menu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Name" })).toHaveAttribute("aria-checked", "true");
  });
});

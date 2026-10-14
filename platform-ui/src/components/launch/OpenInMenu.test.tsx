import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OpenInMenu, type OpenInEntry } from "./OpenInMenu";

const entries: OpenInEntry[] = [
  { key: "github", label: "GitHub", href: "https://github.com/gaiada/web-site/pulls?q=WEB-12", contextual: true, detail: "gaiada/web-site pull requests for WEB-12", glyph: "⎇" },
  { key: "figma", label: "Figma", href: "https://www.figma.com", contextual: false, glyph: "△" },
];

describe("OpenInMenu", () => {
  it("renders nothing without entries", () => {
    const { container } = render(<OpenInMenu entries={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("is a button with aria-expanded that toggles the list", () => {
    render(<OpenInMenu entries={entries} />);
    const btn = screen.getByRole("button", { name: "Open in" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Open in" })).toBeInTheDocument();
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on Escape and on an outside click", () => {
    render(<div><OpenInMenu entries={entries} /><button type="button">Outside</button></div>);
    const btn = screen.getByRole("button", { name: "Open in" });
    fireEvent.click(btn);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(btn);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("names what each link opens, and opens each in a new tab safely", () => {
    render(<OpenInMenu entries={entries} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in" }));
    const gh = screen.getByRole("menuitem", { name: "GitHub, gaiada/web-site pull requests for WEB-12" });
    expect(gh).toHaveAttribute("href", "https://github.com/gaiada/web-site/pulls?q=WEB-12");
    const fig = screen.getByRole("menuitem", { name: "Figma, home page" });
    expect(fig).toHaveAttribute("href", "https://www.figma.com");
    for (const a of [gh, fig]) {
      expect(a).toHaveAttribute("target", "_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("marks a home link with a quiet 'home' note and a contextual link with its detail", () => {
    render(<OpenInMenu entries={entries} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in" }));
    expect(screen.getByRole("menuitem", { name: /^Figma/ }).textContent).toContain("home");
    expect(screen.getByRole("menuitem", { name: /^GitHub/ }).textContent).toContain("gaiada/web-site pull requests for WEB-12");
  });

  it("lists the entries in the order given", () => {
    render(<OpenInMenu entries={entries} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in" }));
    expect(screen.getAllByRole("menuitem").map((a) => a.getAttribute("href"))).toEqual(entries.map((e) => e.href));
  });
});

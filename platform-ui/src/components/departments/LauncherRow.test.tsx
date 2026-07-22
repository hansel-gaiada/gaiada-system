import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LauncherRow } from "./LauncherRow";

describe("LauncherRow", () => {
  it("renders the teach empty-state when there are no tools configured", () => {
    render(<LauncherRow items={[]} />);
    expect(screen.getByText("No tools configured yet")).toBeInTheDocument();
  });

  it("renders external tool chips and seat-mapping state", () => {
    render(
      <LauncherRow
        items={[
          { key: "github", label: "GitHub", desc: "Repositories, PRs, and CI.", href: "https://github.com", glyph: "⎇" },
          { key: "claude-code", label: "Claude Code", href: "https://claude.ai/code", glyph: "⌘", seatStatus: "mapped", seatLabel: "opens as hansel@gaiada.com" },
          { key: "figma", label: "Figma", href: "https://www.figma.com", glyph: "△", seatStatus: "unmapped" },
        ]}
      />
    );
    const github = screen.getByRole("link", { name: /GitHub/ });
    expect(github).toHaveAttribute("target", "_blank");
    expect(screen.getByText("opens as hansel@gaiada.com")).toBeInTheDocument();
    expect(screen.getByText("Map your seat")).toBeInTheDocument();
  });
});

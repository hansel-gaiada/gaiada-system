import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LauncherRow } from "./LauncherRow";

describe("LauncherRow", () => {
  it("renders the teach empty-state when there are no tools configured", () => {
    render(<LauncherRow items={[]} />);
    expect(screen.getByText("No tools configured yet")).toBeInTheDocument();
  });

  it("renders icon-only links whose accessible name carries the tool and its seat state", () => {
    const { container } = render(
      <LauncherRow
        items={[
          { key: "github", label: "GitHub", desc: "Repositories, PRs, and CI.", href: "https://github.com", glyph: "⎇" },
          { key: "claude-code", label: "Claude Code", href: "https://claude.ai/code", glyph: "⌘", seatStatus: "mapped", seatLabel: "opens as hansel@gaiada.com" },
          { key: "figma", label: "Figma", href: "https://www.figma.com", glyph: "△", seatStatus: "unmapped" },
        ]}
      />
    );
    // The row shows nothing but glyphs, so the accessible name is the whole label — a link named
    // only "⎇" is unusable, and that is the risk this layout takes on.
    const github = screen.getByRole("link", { name: "GitHub — Repositories, PRs, and CI." });
    expect(github).toHaveAttribute("target", "_blank");
    // Seat state outranks the description in both the name and the tooltip.
    expect(screen.getByRole("link", { name: "Claude Code — opens as hansel@gaiada.com" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Figma — Map your seat" })).toBeInTheDocument();
    // Tooltip text is present but hidden from assistive tech, so it never doubles the name.
    expect(screen.getByText("opens as hansel@gaiada.com")).toBeInTheDocument();
    expect(container.querySelectorAll(".dept-launcher-icon__tip[aria-hidden='true']")).toHaveLength(3);
    // An unmapped seat is marked without a hover — it is why a click will not do what is expected.
    expect(container.querySelectorAll(".dept-launcher-icon--unmapped")).toHaveLength(1);
    // No `title`: the native tooltip is keyboard-unreachable and would fire alongside ours.
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("draws the vendored brand SVG when the tool has one and the glyph when it does not", () => {
    const { container } = render(
      <LauncherRow
        items={[
          { key: "github", label: "GitHub", href: "https://github.com", glyph: "⎇", icon: "github" },
          { key: "looker", label: "Looker Studio", href: "https://lookerstudio.google.com", glyph: "▤" },
        ]}
      />
    );
    const marks = container.querySelectorAll(".dept-launcher-icon__mark");
    expect(marks[0].querySelector("svg")).not.toBeNull();
    expect(marks[0]).toHaveClass("dept-launcher-icon__mark--svg");
    // A tool the icon set has no mark for keeps its letterform rather than borrowing a near-miss.
    expect(marks[1].querySelector("svg")).toBeNull();
    expect(marks[1]).toHaveTextContent("▤");
  });

  it("gives every vendored mark its own clipPath ids", () => {
    // All seven source files ship id="a". Rendered together with that id intact, each clip-path
    // resolves to the first match in the document and most of the row draws clipped to one shape.
    const { container } = render(
      <LauncherRow
        items={[
          { key: "figma", label: "Figma", href: "https://www.figma.com", glyph: "△", icon: "figma" },
          { key: "vscode", label: "VS Code", href: "vscode://", glyph: "‹›", icon: "vscode" },
          { key: "gsc", label: "Search Console", href: "https://search.google.com/search-console", glyph: "◎", icon: "google" },
        ]}
      />
    );
    const ids = [...container.querySelectorAll("clipPath")].map((n) => n.getAttribute("id"));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    // And every reference points at an id that exists in this document.
    for (const el of container.querySelectorAll("[clip-path]")) {
      const ref = (el.getAttribute("clip-path") ?? "").replace(/^url\(#|\)$/g, "");
      expect(ids).toContain(ref);
    }
  });
});

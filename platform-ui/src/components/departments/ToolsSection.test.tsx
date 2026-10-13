import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ToolsSection } from "./ToolsSection";
import { workspaceFor } from "@/lib/workspaces";
import type { SeatRow } from "@/lib/claudeSeats";

const seat: SeatRow = {
  id: "s1", tenantId: "t1", personId: "u1", codeSeatEmail: "hansel@gaiada.com", designLogin: null,
  status: "linked", scopes: [], mapped: true, createdBy: "u1",
  createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
};

const web = workspaceFor("agency", "Web Dev");
const toggle = vi.fn().mockResolvedValue(undefined);

const rows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>("li[data-tool]")];
const pinButton = (li: HTMLElement) => within(li).getByRole("button");

// Eight tools, so that a person can hold six pins and still have tools left to pin.
const eight = {
  key: "big",
  tools: ["a", "b", "c", "d", "e", "f", "g", "h"].map((key) => ({ key, label: key.toUpperCase(), desc: `tool ${key}`, url: `https://${key}.test`, glyph: "x" })),
};

describe("ToolsSection", () => {
  it("lists the workspace's tools in registry order, each opening in a new tab", () => {
    const { container } = render(<ToolsSection workspace={web} pins={{}} seat={undefined} seatsUnavailable={false} toggleAction={toggle} />);
    expect(rows(container).map((li) => li.dataset.tool)).toEqual(["claude-code", "claude", "claude-design", "github", "figma", "vscode"]);
    const github = within(rows(container)[3]).getByRole("link");
    expect(github).toHaveAttribute("href", "https://github.com");
    expect(github).toHaveAttribute("target", "_blank");
  });

  it("shows the effective pins: with nothing stored the first six read as pinned", () => {
    const { container } = render(<ToolsSection workspace={web} pins={{}} seat={undefined} seatsUnavailable={false} toggleAction={toggle} />);
    for (const li of rows(container)) expect(pinButton(li)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Unpin Figma from the Overview" })).toBeInTheDocument();
  });

  it("marks a stored pin set with aria-pressed and names each button for what it does", () => {
    const { container } = render(<ToolsSection workspace={web} pins={{ "web-dev": ["claude", "github"] }} seat={undefined} seatsUnavailable={false} toggleAction={toggle} />);
    const state = Object.fromEntries(rows(container).map((li) => [li.dataset.tool, pinButton(li).getAttribute("aria-pressed")]));
    expect(state).toEqual({ "claude-code": "false", claude: "true", "claude-design": "false", github: "true", figma: "false", vscode: "false" });
    expect(screen.getByRole("button", { name: "Pin Figma to the Overview" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Unpin GitHub from the Overview" })).toBeEnabled();
  });

  it("is a real button inside a form, so it posts without JavaScript", () => {
    const { container } = render(<ToolsSection workspace={web} pins={{}} seat={undefined} seatsUnavailable={false} toggleAction={toggle} />);
    for (const li of rows(container)) {
      const btn = pinButton(li);
      expect(btn.tagName).toBe("BUTTON");
      expect(btn).toHaveAttribute("type", "submit");
      expect(btn.closest("form")).not.toBeNull();
    }
  });

  it("disables every unpinned tool's button once six are pinned, and says at most 6 can be pinned", () => {
    const { container } = render(<ToolsSection workspace={eight} pins={{}} seat={undefined} seatsUnavailable={false} toggleAction={toggle} />);
    const [pinned, unpinned] = [rows(container).slice(0, 6), rows(container).slice(6)];
    for (const li of pinned) { expect(pinButton(li)).toHaveAttribute("aria-pressed", "true"); expect(pinButton(li)).toBeEnabled(); }
    for (const li of unpinned) { expect(pinButton(li)).toHaveAttribute("aria-pressed", "false"); expect(pinButton(li)).toBeDisabled(); }
    expect(screen.getByText(/At most 6 tools can be pinned/)).toBeInTheDocument();
  });

  it("keeps every button enabled while fewer than six are pinned", () => {
    const { container } = render(<ToolsSection workspace={eight} pins={{ big: ["a", "b"] }} seat={undefined} seatsUnavailable={false} toggleAction={toggle} />);
    for (const li of rows(container)) expect(pinButton(li)).toBeEnabled();
  });

  it("shows the person's seat on the Claude tools only, as the department Home does", () => {
    const { container } = render(<ToolsSection workspace={web} pins={{}} seat={seat} seatsUnavailable={false} toggleAction={toggle} />);
    const by = (k: string) => rows(container).find((li) => li.dataset.tool === k)!;
    for (const k of ["claude-code", "claude", "claude-design"]) {
      expect(within(by(k)).getAllByText("opens as hansel@gaiada.com").length).toBeGreaterThan(0);
    }
    for (const k of ["github", "figma", "vscode"]) expect(within(by(k)).queryByText(/opens as/)).toBeNull();
    expect(within(by("claude-code")).getByRole("link", { name: "Claude Code — opens as hansel@gaiada.com" })).toBeInTheDocument();
  });

  it("says 'Map your seat' on a Claude tool when no seat is mapped, and nothing when the read failed", () => {
    const { container, rerender } = render(<ToolsSection workspace={web} pins={{}} seat={undefined} seatsUnavailable={false} toggleAction={toggle} />);
    expect(within(rows(container)[1]).getAllByText("Map your seat").length).toBeGreaterThan(0);
    rerender(<ToolsSection workspace={web} pins={{}} seat={undefined} seatsUnavailable toggleAction={toggle} />);
    expect(screen.queryByText("Map your seat")).toBeNull();
  });

  it("shows one quiet line for a workspace with no tools", () => {
    const { container } = render(<ToolsSection workspace={workspaceFor(null, "Housekeeping")} pins={{}} seat={undefined} seatsUnavailable={false} toggleAction={toggle} />);
    expect(screen.getByText("No tools are set up for this department yet.")).toBeInTheDocument();
    expect(rows(container)).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

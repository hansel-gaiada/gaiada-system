import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { DetailsPanel, DETAILS_TABS, type DetailsTab } from "./DetailsPanel";

// The three panels load their own data; this test is about the Details panel's own structure and keys.
vi.mock("./MemoryPanel", () => ({ MemoryPanel: ({ activeThreadId }: { activeThreadId: string | null }) => <div data-testid="memory-body">{activeThreadId}<input aria-label="draft" /></div> }));
vi.mock("./RosterPanel", () => ({ RosterPanel: () => <div data-testid="roster-body" /> }));
vi.mock("./CapabilitiesPanel", () => ({ CapabilitiesPanel: () => <div data-testid="capabilities-body" /> }));

function Harness({ initial = "memory", onClose = () => {} }: { initial?: DetailsTab; onClose?: () => void }) {
  const [tab, setTab] = useState<DetailsTab>(initial);
  return <DetailsPanel tab={tab} onTab={setTab} onClose={onClose} activeThreadId="t1" />;
}

// DW-2h — Memory, Roster and Capabilities are three tabs of ONE panel.
describe("DetailsPanel", () => {
  it("is one panel with three tabs, Memory, Roster and Capabilities, in that order", () => {
    render(<Harness />);
    expect(screen.getByRole("complementary", { name: "Assistant details" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Details" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Memory", "Roster", "Capabilities"]);
    expect(DETAILS_TABS.map((t) => t.key)).toEqual(["memory", "roster", "capabilities"]);
  });

  it("shows only the selected tab's body, and moves to another tab on click", () => {
    render(<Harness />);
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("memory-body")).toHaveTextContent("t1"); // the active thread reaches the panel
    expect(screen.queryByTestId("roster-body")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));
    expect(screen.getByRole("tab", { name: "Roster" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("roster-body")).toBeInTheDocument();
    expect(screen.queryByTestId("memory-body")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Capabilities" }));
    expect(screen.getByTestId("capabilities-body")).toBeInTheDocument();
  });

  it("opens on the tab it is given, focused, with the tab panel named by that tab", () => {
    render(<Harness initial="capabilities" />);
    const tab = screen.getByRole("tab", { name: "Capabilities" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tab.id);
  });

  it("follows the tabs pattern: only the selected tab is in the Tab order, arrows and Home/End move between them", () => {
    render(<Harness />);
    const [memory, roster, capabilities] = screen.getAllByRole("tab");
    expect(memory).toHaveAttribute("tabindex", "0");
    expect(roster).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(memory, { key: "ArrowRight" });
    expect(roster).toHaveAttribute("aria-selected", "true");
    expect(roster).toHaveFocus();
    fireEvent.keyDown(roster, { key: "End" });
    expect(capabilities).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(capabilities, { key: "ArrowRight" }); // wraps
    expect(memory).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(memory, { key: "ArrowLeft" }); // wraps back
    expect(capabilities).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(capabilities, { key: "Home" });
    expect(memory).toHaveAttribute("aria-selected", "true");
  });

  it("closes from its close button and on Escape, but Escape inside a field belongs to the field", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Memory" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByLabelText("draft"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

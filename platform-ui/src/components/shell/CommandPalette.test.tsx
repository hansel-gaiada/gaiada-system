import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CommandPalette } from "./CommandPalette";
import type { PaletteEntry } from "@/lib/palette";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const entries: PaletteEntry[] = [
  { id: "nav:/", label: "Dashboard", href: "/", section: "Workspace", icon: "home" },
  { id: "nav:/clients", label: "Clients", href: "/clients", section: "Business", icon: "finance" },
  { id: "nav:/agency", label: "Agency", href: "/agency", section: "Business", icon: "sales" },
];

function renderPalette(opts: { entries?: PaletteEntry[] } = {}) {
  return render(<CommandPalette entries={opts.entries ?? entries} />);
}

beforeEach(() => {
  push.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ groups: [] }) }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CommandPalette", () => {
  it("renders nothing until opened", () => {
    renderPalette();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on Cmd/Ctrl-K from anywhere and focuses the combobox input", async () => {
    renderPalette();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy());
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("opens on the gaiada:palette:open DOM event (the TopBar trigger's mechanism)", async () => {
    renderPalette();
    window.dispatchEvent(new Event("gaiada:palette:open"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });

  it("Escape closes the palette", async () => {
    renderPalette();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows static (tier 1/2) entries grouped by section with no query", async () => {
    renderPalette();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => screen.getByRole("dialog"));
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("Clients")).toBeTruthy();
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.getByText("Business")).toBeTruthy();
  });

  it("filters static entries as the query changes", async () => {
    renderPalette();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "client" } });
    expect(screen.getByText("Clients")).toBeTruthy();
    expect(screen.queryByText("Dashboard")).toBeNull();
  });

  it("ArrowDown/ArrowUp move aria-activedescendant across the flattened option list", async () => {
    renderPalette();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => screen.getByRole("dialog"));
    const input = screen.getByRole("combobox");
    const first = input.getAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const second = input.getAttribute("aria-activedescendant");
    expect(second).not.toBe(first);
    expect(second).toBeTruthy();
  });

  it("Enter navigates to the active option's href and closes", async () => {
    renderPalette();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => screen.getByRole("dialog"));
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("queries the single-egress palette route (tier 3) once the query reaches 2 characters, debounced", async () => {
    vi.useFakeTimers();
    renderPalette();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await vi.waitFor(() => screen.getByRole("dialog"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ga" } });
    expect(fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/search/palette?q=ga"));
    vi.useRealTimers();
  });

  it("clicking (mousedown) an option navigates to its href", async () => {
    renderPalette();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.mouseDown(screen.getByText("Agency"));
    expect(push).toHaveBeenCalledWith("/agency");
  });

  it("restores focus to the element that had focus before the shortcut opened it", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    renderPalette();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

// DW-2c: the workspace top bar's one search field hands its text over, and Enter always lands somewhere.
describe("CommandPalette — search field handover (DW-2c)", () => {
  it("opens with the text a trigger passes in the event's detail, already filtering", async () => {
    renderPalette();
    window.dispatchEvent(new CustomEvent("gaiada:palette:open", { detail: { query: "client" } }));
    await waitFor(() => screen.getByRole("dialog"));
    expect(screen.getByRole("combobox")).toHaveValue("client");
    expect(screen.getByText("Clients")).toBeTruthy();
    expect(screen.queryByText("Dashboard")).toBeNull();
  });

  it("opens empty when the event carries no text, and again empty after a close", async () => {
    renderPalette();
    window.dispatchEvent(new CustomEvent("gaiada:palette:open", { detail: { query: "client" } }));
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    window.dispatchEvent(new Event("gaiada:palette:open"));
    await waitFor(() => screen.getByRole("dialog"));
    expect(screen.getByRole("combobox")).toHaveValue("");
  });

  it("tells the trigger when it closes, before it returns focus", async () => {
    const order: string[] = [];
    const trigger = document.createElement("input");
    trigger.addEventListener("focus", () => order.push("focus"));
    document.body.appendChild(trigger);
    trigger.focus();
    order.length = 0;
    renderPalette();
    window.dispatchEvent(new CustomEvent("gaiada:palette:open", { detail: { onClose: () => order.push("closed") } }));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(order).toEqual(["closed", "focus"]);
    trigger.remove();
  });

  it("Enter with nothing highlighted goes to /search?q= with the text, encoded", async () => {
    renderPalette();
    window.dispatchEvent(new CustomEvent("gaiada:palette:open", { detail: { query: "zzz & co" } }));
    await waitFor(() => screen.getByRole("dialog"));
    const input = screen.getByRole("combobox");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/search?q=zzz%20%26%20co");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Enter with nothing highlighted and nothing typed does nothing", async () => {
    renderPalette({ entries: [] });
    window.dispatchEvent(new Event("gaiada:palette:open"));
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});


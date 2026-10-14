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
    // No entries, so nothing can be highlighted whatever the timing; and Enter waits until the handed-over
    // text is in the field (it flaked in another branch's CI when it pressed Enter on the dialog's first frame).
    renderPalette({ entries: [] });
    window.dispatchEvent(new CustomEvent("gaiada:palette:open", { detail: { query: "zzz & co" } }));
    const input = await waitFor(() => {
      const el = screen.getByRole("combobox") as HTMLInputElement;
      expect(el.value).toBe("zzz & co");
      return el;
    });
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/search?q=zzz%20%26%20co");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Enter with nothing highlighted and nothing typed does nothing", async () => {
    renderPalette({ entries: [] });
    window.dispatchEvent(new Event("gaiada:palette:open"));
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  describe("knowledge search action (DW-8i)", () => {
    async function openAndType(text: string) {
      renderPalette();
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
      await waitFor(() => screen.getByRole("dialog"));
      fireEvent.change(screen.getByRole("combobox"), { target: { value: text } });
    }

    it("is absent under 2 characters", async () => {
      await openAndType("a");
      expect(screen.queryByText(/Search company knowledge for/)).toBeNull();
    });

    it("appears from 2 characters and opens /knowledge?q= with the text encoded", async () => {
      await openAndType("kick off & co");
      const opt = await screen.findByText("Search company knowledge for 'kick off & co'");
      fireEvent.mouseDown(opt);
      expect(push).toHaveBeenCalledWith("/knowledge?q=kick%20off%20%26%20co");
    });

    it("is not the default highlight: Enter with nothing else matching still goes to /search", async () => {
      await openAndType("zzz");
      await screen.findByText("Search company knowledge for 'zzz'");
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
      expect(push).toHaveBeenCalledWith("/search?q=zzz");
    });
  });
});


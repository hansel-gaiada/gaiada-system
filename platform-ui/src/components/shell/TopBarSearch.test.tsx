import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TopBarSearch } from "./TopBarSearch";
import { CommandPalette } from "./CommandPalette";
import type { PaletteOpenDetail } from "./CommandPalette";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

// What each `gaiada:palette:open` carried.
let opened: (PaletteOpenDetail | undefined)[] = [];
const onOpen = (e: Event) => { opened.push((e as CustomEvent<PaletteOpenDetail | undefined>).detail); };

beforeEach(() => {
  opened = [];
  push.mockClear();
  window.addEventListener("gaiada:palette:open", onOpen);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ groups: [] }) }));
});
afterEach(() => {
  window.removeEventListener("gaiada:palette:open", onOpen);
  vi.unstubAllGlobals();
});

const field = () => screen.getByRole("searchbox", { name: "Search" });
const later = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe("TopBarSearch: the no-JS shape", () => {
  it("is a real GET form to /search around a named q input, with the ⌘K hint", () => {
    render(<TopBarSearch />);
    const form = screen.getByRole("search");
    expect(form.tagName).toBe("FORM");
    expect(form).toHaveAttribute("action", "/search");
    expect(form).toHaveAttribute("method", "get");
    expect(field()).toHaveAttribute("name", "q");
    expect(form).toHaveTextContent("⌘K");
    expect(field()).toHaveAttribute("placeholder", "Search pages, people, records…");
  });

  it("is one field: the only input is the search box (the phone's icon is a link)", () => {
    const { container } = render(<TopBarSearch />);
    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Find anything" })).toHaveAttribute("href", "/search");
  });
});

describe("TopBarSearch: opens the palette", () => {
  it("on focus", () => {
    render(<TopBarSearch />);
    fireEvent.focus(field());
    expect(opened).toHaveLength(1);
    expect(opened[0]?.query).toBe("");
  });

  it("on click", () => {
    render(<TopBarSearch />);
    fireEvent.click(field());
    expect(opened).toHaveLength(1);
  });

  it("hands over what was typed before the palette took focus, and clears the field", () => {
    render(<TopBarSearch />);
    fireEvent.change(field(), { target: { value: "gaia" } });
    expect(opened.at(-1)?.query).toBe("gaia");
    expect(field()).toHaveValue("");
  });

  it("the phone's icon opens it too, and does not navigate", () => {
    render(<TopBarSearch />);
    const proceeded = fireEvent.click(screen.getByRole("link", { name: "Find anything" }));
    expect(proceeded).toBe(false); // preventDefault was called
    expect(opened).toHaveLength(1);
  });

  it("does not reopen on the focus the palette gives back when it closes", async () => {
    render(<TopBarSearch />);
    fireEvent.focus(field());
    const detail = opened[0] as PaletteOpenDetail;
    // The palette tells the field it closed, then refocuses it.
    detail.onClose?.();
    fireEvent.focus(field());
    expect(opened).toHaveLength(1);
    // A later, real focus opens it again.
    await later(5);
    fireEvent.focus(field());
    expect(opened).toHaveLength(2);
  });
});

describe("TopBarSearch with the real palette", () => {
  const entries = [{ id: "nav:/clients", label: "Clients", href: "/clients", section: "Business", icon: "finance" as const }];

  it("opens on focus, and stays closed after Escape returns focus to the field", async () => {
    render(<><TopBarSearch /><CommandPalette entries={entries} /></>);
    field().focus();
    await waitFor(() => screen.getByRole("dialog"));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(field()).toHaveFocus();
    await later(20);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("text typed first arrives in the palette's field", async () => {
    render(<><TopBarSearch /><CommandPalette entries={entries} /></>);
    fireEvent.change(field(), { target: { value: "client" } });
    await waitFor(() => screen.getByRole("dialog"));
    expect(screen.getByRole("combobox")).toHaveValue("client");
    expect(screen.getByText("Clients")).toBeTruthy();
  });

  it("Enter with nothing highlighted goes to /search?q=", async () => {
    render(<><TopBarSearch /><CommandPalette entries={entries} /></>);
    fireEvent.change(field(), { target: { value: "nothing like it" } });
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/search?q=nothing%20like%20it");
  });
});

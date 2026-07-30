import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BotTabs } from "./BotTabs";

// Stub next/navigation the same way Board.test.tsx does — this renders
// outside a real app-router tree.
const replace = vi.fn();
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/systems/bot",
  useSearchParams: () => searchParams,
}));

describe("BotTabs", () => {
  beforeEach(() => {
    replace.mockClear();
    searchParams = new URLSearchParams();
  });

  it("defaults to the Connect tab and shows only its content", () => {
    render(
      <BotTabs
        connect={<div>connect-content</div>}
        controls={<div>controls-content</div>}
        chats={<div>chats-content</div>}
        groups={<div>groups-content</div>}
        logs={<div>logs-content</div>}
        config={<div>config-content</div>}
      />,
    );
    expect(screen.getByText("connect-content")).toBeInTheDocument();
    expect(screen.queryByText("chats-content")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Connect" })).toHaveAttribute("aria-selected", "true");
  });

  it("honors ?tab= for deep-linking", () => {
    searchParams = new URLSearchParams("tab=logs");
    render(
      <BotTabs
        connect={<div>connect-content</div>}
        controls={<div>controls-content</div>}
        chats={<div>chats-content</div>}
        groups={<div>groups-content</div>}
        logs={<div>logs-content</div>}
        config={<div>config-content</div>}
      />,
    );
    expect(screen.getByText("logs-content")).toBeInTheDocument();
    expect(screen.queryByText("connect-content")).not.toBeInTheDocument();
  });

  it("falls back to Connect for an unknown ?tab= value", () => {
    searchParams = new URLSearchParams("tab=bogus");
    render(
      <BotTabs
        connect={<div>connect-content</div>}
        controls={<div>controls-content</div>}
        chats={<div>chats-content</div>}
        groups={<div>groups-content</div>}
        logs={<div>logs-content</div>}
        config={<div>config-content</div>}
      />,
    );
    expect(screen.getByText("connect-content")).toBeInTheDocument();
  });

  it("honors ?tab=controls for the Controls tab", () => {
    searchParams = new URLSearchParams("tab=controls");
    render(
      <BotTabs
        connect={<div>connect-content</div>}
        controls={<div>controls-content</div>}
        chats={<div>chats-content</div>}
        groups={<div>groups-content</div>}
        logs={<div>logs-content</div>}
        config={<div>config-content</div>}
      />,
    );
    expect(screen.getByText("controls-content")).toBeInTheDocument();
    expect(screen.queryByText("connect-content")).not.toBeInTheDocument();
  });

  it("clicking a tab unmounts the previous content and syncs the URL query", () => {
    render(
      <BotTabs
        connect={<div>connect-content</div>}
        controls={<div>controls-content</div>}
        chats={<div>chats-content</div>}
        groups={<div>groups-content</div>}
        logs={<div>logs-content</div>}
        config={<div>config-content</div>}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    expect(screen.getByText("chats-content")).toBeInTheDocument();
    expect(screen.queryByText("connect-content")).not.toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith("/systems/bot?tab=chats", { scroll: false });
  });
});

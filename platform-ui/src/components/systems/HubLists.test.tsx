import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { HubToolsTable, HubAuditTable, HubResourcesTable, HubPromptsTable } from "./HubLists";

describe("HubToolsTable", () => {
  afterEach(() => vi.useRealTimers());

  it("paginates 40 tools at 30/page and searches by name/description/source", async () => {
    vi.useFakeTimers();
    const tools = Array.from({ length: 40 }, (_, i) => ({
      name: i === 0 ? "llm.summarize" : `tool.${i}`,
      description: i === 0 ? "Summarize text via the gateway" : `Does thing ${i}`,
      minAssurance: "basic",
      source: "core",
    }));

    render(<HubToolsTable tools={tools} />);

    expect(screen.getByText("1–30 of 40")).toBeInTheDocument();
    expect(screen.queryByText("tool.31")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search tools" }), {
      target: { value: "summarize" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("llm.summarize")).toBeInTheDocument();
    expect(screen.queryByText("tool.1")).not.toBeInTheDocument();
  });

  it("shows the not-connected state (no search box) when there are no tools", () => {
    render(<HubToolsTable tools={[]} />);
    expect(screen.getByText(/Not connected yet/)).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});

describe("HubAuditTable", () => {
  afterEach(() => vi.useRealTimers());

  it("paginates 45 audit rows at 30/page and searches across tool/principal/decision", async () => {
    vi.useFakeTimers();
    const audit = Array.from({ length: 45 }, (_, i) => ({
      ts: i,
      tool: i === 0 ? "hr.delete" : "hr.read",
      principal: { provider: "wa", externalId: `user-${i}`, assurance: "basic" },
      decision: (i === 0 ? "deny" : "allow") as "allow" | "deny",
    }));

    render(<HubAuditTable audit={audit} hasUnfilteredEntries={false} />);
    expect(screen.getByText("1–30 of 45")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search decision audit" }), {
      target: { value: "hr.delete" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("hr.delete")).toBeInTheDocument();
    expect(screen.queryByText("hr.read")).not.toBeInTheDocument();
  });

  it("distinguishes 'nothing decided yet' from 'no entries match this filter'", () => {
    const { rerender } = render(<HubAuditTable audit={[]} hasUnfilteredEntries={false} />);
    expect(screen.getByText("No tool calls have been decided yet.")).toBeInTheDocument();

    rerender(<HubAuditTable audit={[]} hasUnfilteredEntries />);
    expect(screen.getByText("No entries match this filter.")).toBeInTheDocument();
  });
});

describe("HubResourcesTable / HubPromptsTable", () => {
  it("paginates 32 resources at 30/page", () => {
    const resources = Array.from({ length: 32 }, (_, i) => ({
      uriTemplate: `gaiada://thing/${i}`,
      name: `Thing ${i}`,
      description: "d",
      mimeType: "text/plain",
    }));
    render(<HubResourcesTable resources={resources} />);
    expect(screen.getByText("1–30 of 32")).toBeInTheDocument();
  });

  it("renders prompts with joined argument names", () => {
    render(
      <HubPromptsTable
        prompts={[{ name: "summarize", description: "d", arguments: [{ name: "text", description: "", required: true }] }]}
      />,
    );
    expect(screen.getByText("text*")).toBeInTheDocument();
  });
});

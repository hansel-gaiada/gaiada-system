import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChainTable } from "./ChainTable";

describe("ChainTable", () => {
  it("renders providers in failover order with an explanation of each state", () => {
    render(
      <ChainTable
        title="LLM failover chain"
        chain={{
          order: ["ollama", "gemini", "whisper"],
          providers: [
            { name: "ollama", position: 1, state: "ok", available: true, consecutiveFails: 0 },
            { name: "gemini", position: 2, state: "open", available: true, rateLimited: true, openUntil: "2026-07-05T09:05:00Z" },
          ],
        }}
      />,
    );
    expect(screen.getByText("ollama")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
    // A rate-limit breaker must read differently from a failure breaker — they need different fixes.
    expect(screen.getByText(/Rate limited upstream/)).toBeTruthy();
  });

  it("surfaces providers configured in the env but never built by the gateway", () => {
    render(
      <ChainTable
        title="LLM failover chain"
        chain={{
          order: ["ollama", "typo-provider"],
          providers: [{ name: "ollama", position: 1, state: "ok", available: true }],
        }}
      />,
    );
    expect(screen.getByText(/Configured but not built/)).toBeTruthy();
    expect(screen.getByText(/typo-provider/)).toBeTruthy();
  });

  it("distinguishes an unconfigured provider from a tripped one", () => {
    render(
      <ChainTable
        title="Media failover chain"
        chain={{ order: ["whisper"], providers: [{ name: "whisper", position: 1, state: "unconfigured", available: false }] }}
      />,
    );
    expect(screen.getByText(/No credential\/endpoint configured/)).toBeTruthy();
  });

  it("reports the configured order when the gateway built nothing, instead of an empty card", () => {
    render(<ChainTable title="LLM failover chain" chain={{ order: ["ollama", "gemini"], providers: [] }} />);
    expect(screen.getByText(/Configured as ollama → gemini/)).toBeTruthy();
  });

  it("falls back to a not-connected note with no chain at all", () => {
    render(<ChainTable title="LLM failover chain" />);
    expect(screen.getByText(/once the gateway admin API is reachable/)).toBeTruthy();
  });
});

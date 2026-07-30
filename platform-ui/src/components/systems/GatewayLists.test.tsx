import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GatewayProvidersTable, GatewayAuditTable, GatewayTenantSpendTable } from "./GatewayLists";

describe("GatewayProvidersTable", () => {
  it("renders the empty state when there are no providers", () => {
    render(<GatewayProvidersTable providers={[]} />);
    expect(screen.getByText(/Provider inventory appears once/)).toBeInTheDocument();
  });

  it("searches providers by name", async () => {
    vi.useFakeTimers();
    const providers = Array.from({ length: 5 }, (_, i) => ({
      name: i === 0 ? "gemini" : `provider-${i}`,
      keyRequired: true,
      keyConfigured: true,
    }));
    render(<GatewayProvidersTable providers={providers} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search providers" }), { target: { value: "gemini" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("gemini")).toBeInTheDocument();
    expect(screen.queryByText("provider-1")).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("GatewayAuditTable", () => {
  afterEach(() => vi.useRealTimers());

  it("paginates 200 audit rows at 30/page and searches by capability/provider/decision", async () => {
    vi.useFakeTimers();
    const audit = Array.from({ length: 200 }, (_, i) => ({
      capability: i === 0 ? "media" : "llm",
      provider: "gemini",
      decision: i === 0 ? "blocked" : "allow",
    }));

    render(<GatewayAuditTable audit={audit} hasFilter={false} />);
    expect(screen.getByText("1–30 of 200")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search egress audit" }), {
      target: { value: "blocked" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    // Filtered down to the single "blocked" row (others are "allow") — StatusBadge title-cases it.
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
  });

  it("distinguishes an unfiltered empty audit from a filter matching nothing", () => {
    const { rerender } = render(<GatewayAuditTable audit={[]} hasFilter={false} />);
    expect(screen.getByText(/Egress audit appears once/)).toBeInTheDocument();

    rerender(<GatewayAuditTable audit={[]} hasFilter />);
    expect(screen.getByText("No entries match this filter.")).toBeInTheDocument();
  });
});

describe("GatewayTenantSpendTable", () => {
  it("paginates 33 tenants at 30/page", () => {
    const tenantSpend: Array<[string, number]> = Array.from({ length: 33 }, (_, i) => [`tenant-${i}`, i]);
    render(<GatewayTenantSpendTable tenantSpend={tenantSpend} perTenantCap={100} />);
    expect(screen.getByText("1–30 of 33")).toBeInTheDocument();
  });
});

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ApprovalsPanel } from "./ApprovalsPanel";

const items = [
  { id: "a1", tenantId: "t1", company: "Agency A", subject: "Banner v2", campaign: "Launch", created_at: "2026-07-01" },
];

describe("ApprovalsPanel", () => {
  it("renders pending items with approve/decline controls", () => {
    render(<ApprovalsPanel items={items} decide={vi.fn(async () => ({ ok: true }))} />);
    expect(screen.getByText("Banner v2")).toBeInTheDocument();
    expect(screen.getByTitle("Approve")).toBeInTheDocument();
    expect(screen.getByTitle("Decline")).toBeInTheDocument();
  });
  it("optimistically removes an item and shows the empty state after the last decision", async () => {
    const decide = vi.fn(async () => ({ ok: true }));
    render(<ApprovalsPanel items={items} decide={decide} />);
    fireEvent.click(screen.getByTitle("Approve"));
    await waitFor(() => expect(screen.queryByText("Banner v2")).not.toBeInTheDocument());
    expect(decide).toHaveBeenCalledWith("t1", "a1", "approved");
    expect(screen.getByText(/All clear/)).toBeInTheDocument();
  });
});

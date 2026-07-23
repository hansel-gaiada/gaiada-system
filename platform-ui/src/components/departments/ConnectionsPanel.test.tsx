import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ConnectionsPanel } from "./ConnectionsPanel";
import type { ConnectionRow } from "@/lib/connections";
import type { SeatRow } from "@/lib/claudeSeats";

const noop = vi.fn().mockResolvedValue({ ok: true });

const actions = {
  connect: noop, update: noop, revoke: noop,
  mapSeat: noop, updateSeat: noop, unmapSeat: noop,
};

function conn(over: Partial<ConnectionRow>): ConnectionRow {
  return {
    id: "c1", tenantId: "t1", ownerKind: "user", ownerId: "u1", provider: "github",
    externalAccount: "hansel-gh", scopes: [], status: "pending", hasToken: false, hasRefreshToken: false,
    tokenExpiresAt: null, tokenKeyVersion: null, meta: {}, createdBy: "u1", originSite: "central",
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

const seat: SeatRow = {
  id: "s1", tenantId: "t1", personId: "u1", codeSeatEmail: "hansel@gaiada.com", designLogin: null,
  status: "linked", scopes: [], mapped: true, createdBy: "u1",
  createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
};

describe("ConnectionsPanel", () => {
  it("shows a Connect prompt for an unconfigured provider and a mapped Claude seat", () => {
    render(<ConnectionsPanel seat={seat} actions={actions} />);
    // GitHub/Drive are unconnected -> inline connect form with a "Connect" button.
    expect(screen.getAllByText("Connect").length).toBe(2);
    // Claude seat is mapped -> shows the seat email, no "Map your seat" prompt.
    expect(screen.getByText("hansel@gaiada.com")).toBeInTheDocument();
    expect(screen.queryByText("Map your seat")).not.toBeInTheDocument();
  });

  it("shows the account + Edit/Revoke actions for a connected provider, and the unmapped seat prompt", () => {
    render(<ConnectionsPanel github={conn({})} actions={actions} />);
    expect(screen.getByText("hansel-gh")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Revoke")).toBeInTheDocument();
    expect(screen.getByText("Map your seat")).toBeInTheDocument();
  });
});

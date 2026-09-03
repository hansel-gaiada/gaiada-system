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
  it("shows a Save prompt for a provider with no mapping, and a mapped Claude seat", () => {
    render(<ConnectionsPanel seat={seat} actions={actions} />);
    // GitHub/Drive have no mapping -> inline form. The button says "Save", NOT "Connect":
    // pressing it writes an account name and obtains no credential (2026-09-03 honesty pass).
    expect(screen.getAllByText("Save").length).toBe(2);
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
    // Claude seat is mapped -> shows the seat email, no "Map your seat" prompt.
    expect(screen.getByText("hansel@gaiada.com")).toBeInTheDocument();
    expect(screen.queryByText("Map your seat")).not.toBeInTheDocument();
  });

  it("shows the account + Edit/Remove actions for a mapped provider, and the unmapped seat prompt", () => {
    render(<ConnectionsPanel github={conn({})} actions={actions} />);
    expect(screen.getByText("hansel-gh")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    // "Remove", not "Revoke" — there is no credential here to revoke.
    expect(screen.getByText("Remove")).toBeInTheDocument();
    expect(screen.getByText("Map your seat")).toBeInTheDocument();
  });

  // ── The regression this pins (2026-09-03) ────────────────────────────────────────────────────
  // The badge rendered `row.status` verbatim. Every row the Phase-1 HTTP surface can create is
  // inserted `status='unconfigured'` and nothing user-owned can ever reach 'linked' (the only path
  // that sets it, `setConnectionTokens`, is not exposed over HTTP). So a mapping you had just saved
  // displayed "unconfigured" next to your own username — the write succeeded and the badge called
  // it a failure.
  it("does not label a saved mapping 'unconfigured'", () => {
    render(<ConnectionsPanel github={conn({ status: "unconfigured" })} actions={actions} />);
    expect(screen.getByText("hansel-gh")).toBeInTheDocument();
    expect(screen.queryByText("Unconfigured")).not.toBeInTheDocument();
    expect(screen.getByText("Mapped")).toBeInTheDocument();
  });

  it("says 'connected' only when the vault actually holds a credential", () => {
    // hasToken is Phase-2 territory (no HTTP path sets it today), but the distinction is the whole
    // point of the badge, so it must be driven by the credential and not by the status string.
    render(<ConnectionsPanel github={conn({ hasToken: true, status: "linked" })} actions={actions} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("surfaces an error status rather than flattening it into 'mapped'", () => {
    render(<ConnectionsPanel github={conn({ status: "error" })} actions={actions} />);
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("states that these rows are mappings, not sign-ins", () => {
    // The tab is called "Connections" and the button used to say "Connect"; without this line a
    // reader concludes the ERP can act on their behalf on GitHub, which it cannot.
    render(<ConnectionsPanel actions={actions} />);
    expect(screen.getByText(/account mappings/i)).toBeInTheDocument();
  });
});

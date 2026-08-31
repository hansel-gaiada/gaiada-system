import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ContractCard } from "./ContractCard";
import type { ContractPinStatus } from "@/lib/webdesk";

describe("ContractCard — locale coverage row is honest, not fabricated (WSK-D18)", () => {
  it("states the gap explicitly instead of rendering a fake coverage figure, even with a real pin", () => {
    const pin: ContractPinStatus = {
      webdeskTenantSlug: "acme-site",
      pinned: { snapshotId: "sn1", contractVersion: "1.0", vocabularyVersion: "1.0", contentHash: "h1", fetchedAt: "2026-08-01T00:00:00Z" },
      latest: { version: "1.0", vocabularyVersion: "1.0", stale: false, source: "live", asOf: "2026-08-25T00:00:00Z", reason: "live_control_channel_read" },
    };
    render(<ContractCard pin={pin} pinsAvailable />);
    expect(screen.getByText(/Not available/i)).toBeInTheDocument();
    expect(screen.getByText(/WSK-D18/i)).toBeInTheDocument();
    // Must NOT render any invented "X of Y pages" / percentage style figure.
    expect(screen.queryByText(/\d+ of \d+/)).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("even with no pin at all, still shows the locale row rather than omitting it", () => {
    render(<ContractCard pin={null} pinsAvailable />);
    expect(screen.getByText(/Locale coverage/i)).toBeInTheDocument();
  });
});

describe("ContractCard — pinned vs latest never claims 'current' when the answer is unknown", () => {
  it("behind:true renders the rust/critical wording", () => {
    const pin: ContractPinStatus = {
      webdeskTenantSlug: "acme-site",
      pinned: { snapshotId: "sn1", contractVersion: "1.0", vocabularyVersion: "1.0", contentHash: "h1", fetchedAt: "2026-08-01T00:00:00Z" },
      latest: { version: "1.2", vocabularyVersion: "1.0", stale: false, source: "live", asOf: "2026-08-25T00:00:00Z", reason: "live_control_channel_read" },
    };
    render(<ContractCard pin={pin} pinsAvailable />);
    expect(screen.getByText(/Pinned older than latest/i)).toBeInTheDocument();
  });

  it("unknown latest (source unavailable) renders 'can't tell', never 'up to date'", () => {
    const pin: ContractPinStatus = {
      webdeskTenantSlug: "acme-site",
      pinned: { snapshotId: "sn1", contractVersion: "1.0", vocabularyVersion: "1.0", contentHash: "h1", fetchedAt: "2026-08-01T00:00:00Z" },
      latest: { version: null, vocabularyVersion: null, stale: true, source: "unavailable", asOf: null, reason: "control_channel_egress_error" },
    };
    render(<ContractCard pin={pin} pinsAvailable />);
    expect(screen.getByText(/Can.t tell whether this site is behind/i)).toBeInTheDocument();
    expect(screen.queryByText(/Pinned to the latest published contract\./i)).not.toBeInTheDocument();
  });

  it("pinsAvailable:false renders a refusal note, not a silent empty card", () => {
    render(<ContractCard pin={null} pinsAvailable={false} />);
    expect(screen.getByText(/couldn.t be read/i)).toBeInTheDocument();
  });
});

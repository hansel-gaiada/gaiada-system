import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SiteRegistryPanel, backendEnvState } from "./SiteRegistryPanel";
import type { SiteConsoleRow, ContractPinStatus, DegradeMeta } from "@/lib/webdesk";

const STALE_META: DegradeMeta = { stale: true, source: "facts", asOf: "2026-08-25T10:00:00Z", reason: "zone_b_has_no_live_environment_status_read_endpoint_yet" };

function row(over: Partial<SiteConsoleRow> = {}): SiteConsoleRow {
  return {
    id: "s1", tenantId: "co-1", pipelineRunId: null, provider: "provision", providerRef: null,
    slug: "acme-site", framework: "vite", repoUrl: null, stagingUrl: "https://acme-site.gaiada.online",
    status: "live", failureReason: null, requestedBy: null, approvalId: null, lastReconciledAt: null,
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
    // Lineage (platform-nest 0.45.0): this fixture is a row that pre-dates the columns.
    clientId: null, projectId: null,
    lastKnownDeployment: null, lastKnownPromotion: null, lastKnownRollback: null,
    ...over,
  };
}

describe("SiteRegistryPanel — the staleness banner is present on the real, normal registry", () => {
  it("shows the degrade banner above the table, not just an empty-state one-off", () => {
    render(<SiteRegistryPanel deptId="dept-1" sites={[row()]} meta={STALE_META} pins={[]} pinsAvailable />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("data-stale", "true");
    expect(screen.getByText("acme-site")).toBeInTheDocument();
  });

  it("renders the teach-state (not a bare empty table) when zero sites, but the registry read itself is still fine", () => {
    render(<SiteRegistryPanel deptId="dept-1" sites={[]} meta={STALE_META} pins={[]} pinsAvailable />);
    expect(screen.getByText(/No sites provisioned yet/i)).toBeInTheDocument();
  });
});

describe("SiteRegistryPanel — the two-column env split (design §08 v1.1)", () => {
  it("frontend deployment column is the SAME honest 'not reported' sentence on every row, never a fabricated per-row value", () => {
    render(<SiteRegistryPanel deptId="dept-1" sites={[row({ slug: "a" }), row({ slug: "b" })]} meta={STALE_META} pins={[]} pinsAvailable />);
    const notes = screen.getAllByText(/WSK-D26 \(delphi\/helios\/Hostinger\) has no deploy state reaching the ERP yet/i);
    expect(notes).toHaveLength(2);
  });

  it("backend env: no facts on file reads as 'No deploy on file', not a guessed status", () => {
    expect(backendEnvState(row())).toEqual({ label: "No deploy on file", asOf: null });
  });

  it("backend env: a deploy fact with no promotion reads as Staging", () => {
    const s = row({ lastKnownDeployment: { kind: "deploy.done", receivedAt: "2026-08-20T00:00:00Z", data: {} } });
    expect(backendEnvState(s)).toEqual({ label: "Staging", asOf: "2026-08-20T00:00:00Z" });
  });

  it("backend env: promotion after the deploy reads as Production (newest fact wins)", () => {
    const s = row({
      lastKnownDeployment: { kind: "deploy.done", receivedAt: "2026-08-20T00:00:00Z", data: {} },
      lastKnownPromotion: { kind: "promote.done", receivedAt: "2026-08-21T00:00:00Z", data: {} },
    });
    expect(backendEnvState(s)).toEqual({ label: "Production", asOf: "2026-08-21T00:00:00Z" });
  });

  it("backend env: a rollback newer than the promotion is surfaced distinctly, not silently reverted to Production", () => {
    const s = row({
      lastKnownPromotion: { kind: "promote.done", receivedAt: "2026-08-20T00:00:00Z", data: {} },
      lastKnownRollback: { kind: "rollback.done", receivedAt: "2026-08-22T00:00:00Z", data: {} },
    });
    expect(backendEnvState(s)).toEqual({ label: "Rolled back", asOf: "2026-08-22T00:00:00Z" });
  });
});

describe("SiteRegistryPanel — contract pin status per row", () => {
  it("renders 'behind' distinctly from 'current', and never claims 'current' when latest is unknown", () => {
    const pins: ContractPinStatus[] = [
      {
        webdeskTenantSlug: "acme-site",
        pinned: { snapshotId: "sn1", contractVersion: "1.0", vocabularyVersion: "1.0", contentHash: "h1", fetchedAt: "2026-08-01T00:00:00Z" },
        latest: { version: "1.1", vocabularyVersion: "1.0", stale: false, source: "live", asOf: "2026-08-25T00:00:00Z", reason: "live_control_channel_read" },
      },
    ];
    render(<SiteRegistryPanel deptId="dept-1" sites={[row({ slug: "acme-site" })]} meta={STALE_META} pins={pins} pinsAvailable />);
    expect(screen.getByText(/behind — latest 1.1/i)).toBeInTheDocument();
  });

  it("renders a dash, not a fabricated pin status, when the contract-pins read itself failed", () => {
    render(<SiteRegistryPanel deptId="dept-1" sites={[row()]} meta={STALE_META} pins={[]} pinsAvailable={false} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SiteRepoCard } from "./SiteRepoCard";
import type { ProvisionedSite } from "@/lib/webdevProvisionedSites";

const actions = { provision: vi.fn(), reconcile: vi.fn() };

function site(over: Partial<ProvisionedSite>): ProvisionedSite {
  return {
    id: "s1", tenantId: "co", pipelineRunId: "run-1", provider: "erp_repo", providerRef: "appr-9",
    slug: "my-site", framework: "astro", repoUrl: null, stagingUrl: null, status: "pending",
    failureReason: null, requestedBy: null, approvalId: null, lastReconciledAt: null,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", clientId: null, projectId: null,
    ...over,
  };
}
const renderCard = (sites: ProvisionedSite[], mayProvision = true) =>
  render(<SiteRepoCard runId="run-1" list={{ kind: "ok", sites }} mayProvision={mayProvision} actions={actions} />);

describe("SiteRepoCard", () => {
  it("offers WordPress as an enabled option", () => {
    renderCard([]);
    const wp = screen.getByRole("option", { name: "WordPress" }) as HTMLOptionElement;
    expect(wp.disabled).toBe(false);
    expect((screen.getByRole("option", { name: /Static/ }) as HTMLOptionElement).disabled).toBe(false);
  });

  it("a pending repo-control row reads Awaiting approval and links to the approval", () => {
    renderCard([site({})]);
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
    expect(screen.queryByText("Provisioning")).toBeNull();
    expect(screen.getByRole("link", { name: /review the approval/i })).toHaveAttribute("href", "/approvals/appr-9");
  });

  it("any other pending row keeps today's status label and has no approval link", () => {
    renderCard([site({ provider: "provision", providerRef: "p-1" })]);
    expect(screen.getByText(/^pending$/i)).toBeInTheDocument();
    expect(screen.queryByText("Awaiting approval")).toBeNull();
    expect(screen.queryByRole("link", { name: /approval/i })).toBeNull();
  });

  it("a failed row shows its reason as text", () => {
    renderCard([site({ status: "failed", failureReason: "no template configured for kind wp <b>x</b>" })]);
    expect(screen.getByText(/no template configured for kind wp <b>x<\/b>/)).toBeInTheDocument();
  });

  // Provisioning revalidates the page; the refreshed read has an active site, so the form (and any
  // message it held) unmounts. The rerender stands in for that refresh.
  it("still says 'Started' after the refresh replaces the provision form with the new site", async () => {
    const created = site({ status: "pending" });
    const provision = vi.fn(async () => ({ ok: true as const, site: created }));
    const props = { runId: "run-1", mayProvision: true, actions: { ...actions, provision } };
    const { rerender } = render(<SiteRepoCard {...props} list={{ kind: "ok", sites: [] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Provision" }));
    await screen.findByText(/^Started/);
    rerender(<SiteRepoCard {...props} list={{ kind: "ok", sites: [created] }} />);
    expect(screen.queryByRole("button", { name: "Provision" })).toBeNull();
    expect(screen.getByText(/^Started — /)).toHaveAttribute("role", "status");
  });
});

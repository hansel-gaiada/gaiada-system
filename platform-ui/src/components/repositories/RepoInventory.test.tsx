import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RepoInventory, type RepoInventoryActions } from "./RepoInventory";
import type { RepoRow } from "@/lib/repoInventory";
import type { ProvisionedSite } from "@/lib/webdevProvisionedSites";

const okSite = { ok: true as const, site: { status: "live" } as ProvisionedSite };

function row(over: Partial<RepoRow> & { id: string }): RepoRow {
  return {
    name: "northwind-site-redesign-kickoff", status: "live", framework: "nextjs", frameworkLabel: "Next.js",
    repoUrl: "https://github.com/Gaia-Digital-Agency/northwind-site-redesign-kickoff",
    stagingUrl: "https://northwind-site-redesign-kickoff.gaiada.online",
    clientName: "Northwind Traders", projectName: "Client site redesign",
    run: { id: "run-demo-1", title: "Northwind — site redesign kickoff" },
    requestedAt: "2026-07-18T03:30:00Z", lastCheckedAt: "2026-07-21T09:00:00Z",
    failure: null, canReconcile: false, ...over,
  };
}
const actions = (over: Partial<RepoInventoryActions> = {}): RepoInventoryActions => ({
  reconcile: vi.fn(async () => okSite),
  ...over,
});
const github = { status: "pending" as const, account: "hansel-gh" };

describe("RepoInventory — preview with sample data is unmistakable", () => {
  it("empty and module-off states offer the preview; preview shows a banner and an exit", () => {
    const { rerender } = render(<RepoInventory state={{ kind: "ok", rows: [] }} github={null} mayReconcile={false} actions={actions()} pipelineHref="/pipeline" previewHref="?preview=sample" />);
    expect(screen.getByRole("link", { name: /preview with sample data/i })).toHaveAttribute("href", "?preview=sample");
    rerender(<RepoInventory state={{ kind: "not_enabled" }} github={null} mayReconcile={false} actions={actions()} pipelineHref="/pipeline" previewHref="?preview=sample" />);
    expect(screen.getByRole("link", { name: /preview with sample data/i })).toBeInTheDocument();
    rerender(<RepoInventory state={{ kind: "ok", rows: [row({ id: "s1" })] }} github={null} mayReconcile={false} actions={actions()} pipelineHref="/pipeline" sample={{ exitHref: "/departments/dept-1/repositories" }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/sample data/i);
    expect(screen.getByRole("status")).toHaveTextContent(/nothing here is from your platform/i);
    expect(screen.getByRole("link", { name: /back to real data/i })).toHaveAttribute("href", "/departments/dept-1/repositories");
    // Sample rows never offer real actions.
    expect(screen.queryByRole("button", { name: /check status now/i })).not.toBeInTheDocument();
  });
});

describe("RepoInventory — the department's code, one row per repo", () => {
  it("summarises the inventory in one line and lists each repo with its links and lineage", () => {
    render(<RepoInventory state={{ kind: "ok", rows: [row({ id: "s1" })] }} github={github} mayReconcile={false} actions={actions()} pipelineHref="/pipeline" />);
    expect(screen.getByText(/1 repo · 1 live/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "northwind-site-redesign-kickoff" })).toHaveAttribute("href", "https://github.com/Gaia-Digital-Agency/northwind-site-redesign-kickoff");
    expect(screen.getByText("Northwind Traders · Client site redesign")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /northwind-site-redesign-kickoff\.gaiada\.online/i })).toHaveAttribute("href", "https://northwind-site-redesign-kickoff.gaiada.online");
    expect(screen.getByRole("link", { name: /Northwind — site redesign kickoff/ })).toHaveAttribute("href", "/pipeline/run-demo-1");
    expect(screen.getByText("Next.js")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("a failed repo says why in plain words and offers Check status only when a re-check can help", async () => {
    const reconcile = vi.fn<RepoInventoryActions["reconcile"]>(async () => okSite);
    const rows = [
      row({ id: "f1", status: "failed", repoUrl: null, stagingUrl: null, failure: { title: "Still working — this isn't final", body: "Provisioning started…", remedy: "reconcile" }, canReconcile: true }),
      row({ id: "f2", name: "taken-slug", status: "failed", repoUrl: null, stagingUrl: null, failure: { title: "That name belongs to someone else's site", body: "Pick a different slug.", remedy: "reprovision" }, canReconcile: false }),
    ];
    render(<RepoInventory state={{ kind: "ok", rows }} github={github} mayReconcile actions={actions({ reconcile })} pipelineHref="/pipeline" />);
    expect(screen.getByText(/still working — this isn't final/i)).toBeInTheDocument();
    expect(screen.getByText(/that name belongs to someone else's site/i)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /check status now/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(reconcile.mock.calls[0][0].get("siteId")).toBe("f1");
    expect(reconcile.mock.calls[0][0].get("runId")).toBe("run-demo-1");
    // The one that needs a new provision points at the run, where provisioning lives.
    expect(screen.getByRole("link", { name: /start a new provision/i })).toHaveAttribute("href", "/pipeline/run-demo-1");
  });

  it("a repo without a URL yet says so instead of rendering a dead link", () => {
    render(<RepoInventory state={{ kind: "ok", rows: [row({ id: "p", status: "pending", repoUrl: null, stagingUrl: null })] }} github={github} mayReconcile={false} actions={actions()} pipelineHref="/pipeline" />);
    expect(screen.getByText("northwind-site-redesign-kickoff")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "northwind-site-redesign-kickoff" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/not available yet/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Provisioning")).toBeInTheDocument();
  });

  it("empty: says where repos come from, not 'connect GitHub'", () => {
    render(<RepoInventory state={{ kind: "ok", rows: [] }} github={github} mayReconcile={false} actions={actions()} pipelineHref="/pipeline" />);
    expect(screen.getByText(/no repositories yet/i)).toBeInTheDocument();
    expect(screen.getByText(/created when a prd run is provisioned/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open the pipeline/i })).toHaveAttribute("href", "/pipeline");
    expect(screen.queryByText(/connect github/i)).not.toBeInTheDocument();
  });

  it("module off and read refused are stated as what they are", () => {
    const { rerender } = render(<RepoInventory state={{ kind: "not_enabled" }} github={github} mayReconcile={false} actions={actions()} pipelineHref="/pipeline" />);
    expect(screen.getByText(/isn.t turned on for this company/i)).toBeInTheDocument();
    rerender(<RepoInventory state={{ kind: "refused" }} github={github} mayReconcile={false} actions={actions()} pipelineHref="/pipeline" />);
    expect(screen.getByText(/don.t have access to view/i)).toBeInTheDocument();
  });

  it("the GitHub line is honest about what the connection can and cannot do yet", () => {
    const { rerender } = render(<RepoInventory state={{ kind: "ok", rows: [row({ id: "s1" })] }} github={null} mayReconcile={false} actions={actions()} pipelineHref="/pipeline" />);
    expect(screen.getByText(/github: not connected/i)).toBeInTheDocument();
    expect(screen.getByText(/commit and pr activity appears once the github app is connected/i)).toBeInTheDocument();
    rerender(<RepoInventory state={{ kind: "ok", rows: [row({ id: "s1" })] }} github={{ status: "pending", account: "hansel-gh" }} mayReconcile={false} actions={actions()} pipelineHref="/pipeline" />);
    expect(screen.getByText(/github: hansel-gh · identity only/i)).toBeInTheDocument();
    rerender(<RepoInventory state={{ kind: "ok", rows: [row({ id: "s1" })] }} github={{ status: "linked", account: "hansel-gh" }} mayReconcile={false} actions={actions()} pipelineHref="/pipeline" />);
    expect(screen.getByText(/github: hansel-gh · linked/i)).toBeInTheDocument();
  });
});

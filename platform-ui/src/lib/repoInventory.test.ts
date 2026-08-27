import { describe, it, expect } from "vitest";
import { buildRepoInventory, repoCounts, REPO_STATUS_LABEL, type RepoRow } from "./repoInventory";
import type { ProvisionedSite } from "./webdevProvisionedSites";

function site(over: Partial<ProvisionedSite> & { id: string }): ProvisionedSite {
  return {
    tenantId: "co-agency", pipelineRunId: "run-1", provider: "provision", providerRef: "p-1",
    slug: "northwind-site", framework: "nextjs", repoUrl: "https://github.com/gda/northwind-site",
    stagingUrl: "https://northwind-site.gaiada.online", status: "live", failureReason: null,
    requestedBy: "u-1", approvalId: null, lastReconciledAt: "2026-07-21T00:00:00Z",
    createdAt: "2026-07-18T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z", ...over,
  };
}
const runs = [
  { id: "run-1", title: "Northwind — site redesign kickoff", client_id: "cl-1", project_id: "p-web-1", source_meeting_id: null, status: "delivery_active" as const, mom_ref: null, created_at: "2026-07-18T00:00:00Z", updated_at: "2026-07-18T00:00:00Z" },
  { id: "run-seo", title: "Cedar — SEO landing", client_id: "cl-2", project_id: "p-seo-1", source_meeting_id: null, status: "extracting" as const, mom_ref: null, created_at: "2026-07-19T00:00:00Z", updated_at: "2026-07-19T00:00:00Z" },
  { id: "run-noproj", title: "Hand-started", client_id: null, project_id: null, source_meeting_id: null, status: "extracting" as const, mom_ref: null, created_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" },
];
const names = { clients: new Map([["cl-1", "Northwind Traders"], ["cl-2", "Cedar Group"]]), projects: new Map([["p-web-1", "Client site redesign"], ["p-seo-1", "SEO audit — Q3"]]) };
const webDev = new Set(["p-web-1"]);

describe("buildRepoInventory — one row per repo, joined to its run, client and project, scoped to the department", () => {
  it("joins a site to its run and names the client and project", () => {
    const rows = buildRepoInventory([site({ id: "s1" })], runs, names, webDev);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject<Partial<RepoRow>>({
      id: "s1", name: "northwind-site", status: "live", framework: "nextjs",
      repoUrl: "https://github.com/gda/northwind-site", stagingUrl: "https://northwind-site.gaiada.online",
      clientName: "Northwind Traders", projectName: "Client site redesign",
      run: { id: "run-1", title: "Northwind — site redesign kickoff" },
    });
  });

  it("keeps only repos whose run's project belongs to the department", () => {
    const rows = buildRepoInventory([site({ id: "s1" }), site({ id: "s2", pipelineRunId: "run-seo", slug: "cedar" })], runs, names, webDev);
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
  });

  it("drops repos whose run is unknown or has no project — they cannot be attributed", () => {
    const rows = buildRepoInventory(
      [site({ id: "s1", pipelineRunId: "run-noproj" }), site({ id: "s2", pipelineRunId: "run-gone" }), site({ id: "s3", pipelineRunId: null })],
      runs, names, webDev,
    );
    expect(rows).toEqual([]);
  });

  it("orders problems first: failed, then provisioning, then provisioned, then live; newest first within a group", () => {
    const rows = buildRepoInventory([
      site({ id: "live-old", status: "live", createdAt: "2026-07-01T00:00:00Z" }),
      site({ id: "live-new", status: "live", createdAt: "2026-07-10T00:00:00Z" }),
      site({ id: "prov", status: "provisioned" }),
      site({ id: "pend", status: "pending", repoUrl: null, stagingUrl: null }),
      site({ id: "req", status: "requested", repoUrl: null, stagingUrl: null }),
      site({ id: "fail", status: "failed", failureReason: "slug_conflict_foreign", repoUrl: null }),
    ], runs, names, webDev);
    expect(rows.map((r) => r.id)).toEqual(["fail", "pend", "req", "prov", "live-new", "live-old"]);
  });

  it("a failed repo carries its plain-language reason and whether it can be re-checked", () => {
    const [row] = buildRepoInventory([site({ id: "f", status: "failed", failureReason: "poll_timeout", repoUrl: null })], runs, names, webDev);
    expect(row.failure?.title).toMatch(/still working/i);
    expect(row.failure?.remedy).toBe("reconcile");
    expect(row.canReconcile).toBe(true);
  });
});

describe("repoCounts — the one-line summary", () => {
  it("counts live, staging (provisioned), provisioning (requested+pending) and failed", () => {
    const rows = buildRepoInventory([
      site({ id: "a", status: "live" }), site({ id: "b", status: "live" }),
      site({ id: "c", status: "provisioned" }),
      site({ id: "d", status: "pending" }), site({ id: "e", status: "requested" }),
      site({ id: "f", status: "failed", failureReason: "crash" }),
    ], runs, names, webDev);
    expect(repoCounts(rows)).toEqual({ total: 6, live: 2, staging: 1, provisioning: 2, failed: 1 });
  });
});

describe("REPO_STATUS_LABEL — the status column speaks in environments", () => {
  it("maps the backend's provisioning states to Provisioning / Staging / Live / Failed", () => {
    expect(REPO_STATUS_LABEL).toEqual({ requested: "Provisioning", pending: "Provisioning", provisioned: "Staging", live: "Live", failed: "Failed" });
  });
});

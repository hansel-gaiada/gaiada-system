import { describe, it, expect } from "vitest";
import { buildRepoInventory, repoCounts, runsEligibleForRepo, suggestSlug, REPO_STATUS_LABEL, type RepoRow } from "./repoInventory";
import type { ProvisionedSite } from "./webdevProvisionedSites";

function site(over: Partial<ProvisionedSite> & { id: string }): ProvisionedSite {
  return {
    tenantId: "co-agency", pipelineRunId: "run-1", provider: "provision", providerRef: "p-1",
    slug: "northwind-site", framework: "nextjs", repoUrl: "https://github.com/gda/northwind-site",
    stagingUrl: "https://northwind-site.gaiada.online", status: "live", failureReason: null,
    requestedBy: "u-1", approvalId: null, lastReconciledAt: "2026-07-21T00:00:00Z",
    createdAt: "2026-07-18T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z", clientId: null, projectId: null, ...over,
  };
}
const runs = [
  { id: "run-1", title: "Northwind — site redesign kickoff", client_id: "cl-1", project_id: "p-web-1", source_meeting_id: null, status: "delivery_active" as const, mom_ref: null, created_at: "2026-07-18T00:00:00Z", updated_at: "2026-07-18T00:00:00Z" },
  { id: "run-seo", title: "Cedar — SEO landing", client_id: "cl-2", project_id: "p-seo-1", source_meeting_id: null, status: "extracting" as const, mom_ref: null, created_at: "2026-07-19T00:00:00Z", updated_at: "2026-07-19T00:00:00Z" },
  { id: "run-noproj", title: "Hand-started", client_id: null, project_id: null, source_meeting_id: null, status: "extracting" as const, mom_ref: null, created_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" },
];
const names = { clients: new Map([["cl-1", "Northwind Traders"], ["cl-2", "Cedar Group"]]), projects: new Map([["p-web-1", "Client site redesign"], ["p-seo-1", "SEO audit — Q3"]]) };
const webDev = new Set(["p-web-1"]);
const DEPT = "dept-1";

describe("buildRepoInventory — one row per repo, joined to its run, client and project, scoped to the department", () => {
  it("joins a site to its run and names the client and project", () => {
    const rows = buildRepoInventory([site({ id: "s1" })], runs, names, DEPT, webDev);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject<Partial<RepoRow>>({
      id: "s1", name: "northwind-site", status: "live", framework: "nextjs",
      repoUrl: "https://github.com/gda/northwind-site", stagingUrl: "https://northwind-site.gaiada.online",
      clientName: "Northwind Traders", projectName: "Client site redesign",
      run: { id: "run-1", title: "Northwind — site redesign kickoff" },
    });
  });

  it("a run's stored department_id decides first; project is the fallback for older runs", () => {
    const stored = [
      { ...runs[0], id: "run-stored", project_id: null, department_id: "dept-1" },
      { ...runs[0], id: "run-other", project_id: "p-web-1", department_id: "dept-3" },
    ];
    const rows = buildRepoInventory([site({ id: "a", pipelineRunId: "run-stored" }), site({ id: "b", pipelineRunId: "run-other" })], stored, names, DEPT, webDev);
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("keeps only repos whose run's project belongs to the department", () => {
    const rows = buildRepoInventory([site({ id: "s1" }), site({ id: "s2", pipelineRunId: "run-seo", slug: "cedar" })], runs, names, DEPT, webDev);
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
  });

  it("drops repos whose run is unknown or has no project — they cannot be attributed to a department", () => {
    const rows = buildRepoInventory(
      [site({ id: "s1", pipelineRunId: "run-noproj" }), site({ id: "s2", pipelineRunId: "run-gone" })],
      runs, names, DEPT, webDev,
    );
    expect(rows).toEqual([]);
  });

  it("a standalone repo (created by hand, no run) is listed, unlinked — the webdev module owns it", () => {
    const [row] = buildRepoInventory([site({ id: "s3", pipelineRunId: null, slug: "marketing-microsite" })], runs, names, DEPT, webDev);
    expect(row).toMatchObject<Partial<RepoRow>>({ id: "s3", name: "marketing-microsite", run: null, clientName: null, projectName: null });
  });

  it("a standalone repo that carries its own client/project (0.45.0) shows them, and a project in this department attributes it", () => {
    const rows = buildRepoInventory([
      site({ id: "own", pipelineRunId: null, slug: "cedar-brand", clientId: "cl-2", projectId: "p-seo-1" }),   // SEO project → not Web Dev's
      site({ id: "mine", pipelineRunId: null, slug: "nw-micro", clientId: "cl-1", projectId: "p-web-1" }),
      site({ id: "bare", pipelineRunId: null, slug: "bare" }),                                                 // no lineage → listed (module owner), unlinked
    ], runs, names, DEPT, webDev);
    expect(rows.map((r) => r.id)).toEqual(["mine", "bare"]);
    expect(rows[0]).toMatchObject<Partial<RepoRow>>({ clientName: "Northwind Traders", projectName: "Client site redesign", run: null });
  });

  it("the site's own client/project win over the run's when both exist", () => {
    const [row] = buildRepoInventory([site({ id: "s1", clientId: "cl-2", projectId: "p-web-1" })], runs, names, DEPT, webDev);
    expect(row.clientName).toBe("Cedar Group");
  });

  it("orders problems first: failed, then provisioning, then provisioned, then live; newest first within a group", () => {
    const rows = buildRepoInventory([
      site({ id: "live-old", status: "live", createdAt: "2026-07-01T00:00:00Z" }),
      site({ id: "live-new", status: "live", createdAt: "2026-07-10T00:00:00Z" }),
      site({ id: "prov", status: "provisioned" }),
      site({ id: "pend", status: "pending", repoUrl: null, stagingUrl: null }),
      site({ id: "req", status: "requested", repoUrl: null, stagingUrl: null }),
      site({ id: "fail", status: "failed", failureReason: "slug_conflict_foreign", repoUrl: null }),
    ], runs, names, DEPT, webDev);
    expect(rows.map((r) => r.id)).toEqual(["fail", "pend", "req", "prov", "live-new", "live-old"]);
  });

  it("a failed repo carries its plain-language reason and whether it can be re-checked", () => {
    const [row] = buildRepoInventory([site({ id: "f", status: "failed", failureReason: "poll_timeout", repoUrl: null })], runs, names, DEPT, webDev);
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
    ], runs, names, DEPT, webDev);
    expect(repoCounts(rows)).toEqual({ total: 6, live: 2, staging: 1, provisioning: 2, failed: 1 });
  });
});

describe("REPO_STATUS_LABEL — the status column speaks in environments", () => {
  it("maps the backend's provisioning states to Provisioning / Staging / Live / Failed", () => {
    expect(REPO_STATUS_LABEL).toEqual({ requested: "Provisioning", pending: "Provisioning", provisioned: "Staging", live: "Live", failed: "Failed" });
  });
});

describe("runsEligibleForRepo — which PRD runs can get a repository created", () => {
  it("offers this department's runs that have no active (non-failed) site yet, newest first, with the client named", () => {
    const deptRuns = [
      { ...runs[0] }, // run-1 has a live site below → not eligible
      { id: "run-2", title: "Lumen — portfolio discovery", client_id: "cl-3", project_id: "p-web-2", source_meeting_id: null, status: "extracting" as const, mom_ref: null, created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-20T00:00:00Z" },
      { id: "run-3", title: "Northwind — checkout scope", client_id: "cl-1", project_id: "p-web-1", source_meeting_id: null, status: "extracting" as const, mom_ref: null, created_at: "2026-08-25T00:00:00Z", updated_at: "2026-08-25T00:00:00Z" },
      { id: "run-done", title: "Old complete run", client_id: "cl-1", project_id: "p-web-1", source_meeting_id: null, status: "complete" as const, mom_ref: null, created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z" },
    ];
    const sites = [
      site({ id: "s1", pipelineRunId: "run-1", status: "live" }),
      site({ id: "s3f", pipelineRunId: "run-3", status: "failed", failureReason: "slug_conflict_foreign" }), // failed does not hold the slot
    ];
    const eligible = runsEligibleForRepo(deptRuns, sites, names.clients);
    expect(eligible.map((r) => r.id)).toEqual(["run-3", "run-2", "run-done"]);
    expect(eligible[0]).toEqual({ id: "run-3", title: "Northwind — checkout scope", clientName: "Northwind Traders", retry: true });
    expect(eligible[1].clientName).toBeNull();
    expect(eligible[1].retry).toBe(false);
  });
});

describe("suggestSlug — a repo name from a run title", () => {
  it("lowercases, replaces everything that is not a-z0-9 with single hyphens, trims them, caps at 40", () => {
    expect(suggestSlug("Northwind — Checkout flow scope call")).toBe("northwind-checkout-flow-scope-call");
    expect(suggestSlug("  Lumen / Portfolio (v2)!  ")).toBe("lumen-portfolio-v2");
    expect(suggestSlug("A".repeat(60))).toHaveLength(40);
    expect(suggestSlug("---")).toBe("");
  });
});

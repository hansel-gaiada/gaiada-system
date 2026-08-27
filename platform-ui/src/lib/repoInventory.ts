// Repositories tab — pure, zero-I/O, client-safe.
//
// The department's code inventory: one row per repository the delivery pipeline provisioned
// (`webdev_provisioned_sites`), joined to the PRD run it came from and, through the run, to the
// client, the project and therefore the department. Same attribution rule as PRD Studio: a repo is
// this department's iff its run's project is. Repos whose run is unknown or project-less cannot be
// attributed and are left to the run workspace. Ordered problems-first so what needs a person is at
// the top. Copy for failures and the reconcile rule come from `webdevProvisionedSites.ts` — one source.
import type { PipelineRun } from "./pipeline";
import {
  FRAMEWORK_LABEL, canReconcile, failureCopy,
  type FailureCopy, type ProvisionedSite, type SiteFramework, type SiteStatus,
} from "./webdevProvisionedSites";

export interface RepoRow {
  id: string;
  /** The repo's short name (the provisioning slug). */
  name: string;
  status: SiteStatus;
  framework: SiteFramework;
  frameworkLabel: string;
  repoUrl: string | null;
  stagingUrl: string | null;
  clientName: string | null;
  projectName: string | null;
  run: { id: string; title: string };
  requestedAt: string;
  lastCheckedAt: string | null;
  /** Plain-language failure, only when `status === "failed"`. */
  failure: FailureCopy | null;
  canReconcile: boolean;
}

export interface NameLookups {
  clients: Map<string, string>;
  projects: Map<string, string>;
}

const RANK: Record<SiteStatus, number> = { failed: 0, pending: 1, requested: 1, provisioned: 2, live: 3 };

/** The status column speaks in environments, not provisioning internals: a `provisioned` site is
 *  reachable on its staging URL (TLS may still be settling), so it reads "Staging". The run workspace
 *  keeps the finer `STATUS_LABEL` ("Provisioned (SSL pending)") because that is where provisioning is
 *  operated. */
export const REPO_STATUS_LABEL: Record<SiteStatus, string> = {
  requested: "Provisioning",
  pending: "Provisioning",
  provisioned: "Staging",
  live: "Live",
  failed: "Failed",
};

export function buildRepoInventory(
  sites: ProvisionedSite[],
  runs: PipelineRun[],
  names: NameLookups,
  deptProjectIds: Set<string>,
): RepoRow[] {
  const runById = new Map(runs.map((r) => [r.id, r]));
  const rows: RepoRow[] = [];
  for (const s of sites) {
    if (!s.pipelineRunId) continue;
    const run = runById.get(s.pipelineRunId);
    if (!run || !run.project_id || !deptProjectIds.has(run.project_id)) continue;
    rows.push({
      id: s.id,
      name: s.slug,
      status: s.status,
      framework: s.framework,
      frameworkLabel: FRAMEWORK_LABEL[s.framework] ?? s.framework,
      repoUrl: s.repoUrl,
      stagingUrl: s.stagingUrl,
      clientName: run.client_id ? names.clients.get(run.client_id) ?? null : null,
      projectName: names.projects.get(run.project_id) ?? null,
      run: { id: run.id, title: run.title ?? "(untitled run)" },
      requestedAt: s.createdAt,
      lastCheckedAt: s.lastReconciledAt,
      failure: s.status === "failed" ? failureCopy(s.failureReason) : null,
      canReconcile: canReconcile(s),
    });
  }
  // Stable sort: problems first, newest first inside a group.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => RANK[a.r.status] - RANK[b.r.status] || b.r.requestedAt.localeCompare(a.r.requestedAt) || a.i - b.i)
    .map(({ r }) => r);
}

export interface RepoCounts { total: number; live: number; staging: number; provisioning: number; failed: number }

export function repoCounts(rows: RepoRow[]): RepoCounts {
  const c: RepoCounts = { total: rows.length, live: 0, staging: 0, provisioning: 0, failed: 0 };
  for (const r of rows) {
    if (r.status === "live") c.live++;
    else if (r.status === "provisioned") c.staging++;
    else if (r.status === "failed") c.failed++;
    else c.provisioning++;
  }
  return c;
}

// ── Creating a repository ─────────────────────────────────────────────────────────────────────────
// A repository is created by provisioning a site for a PRD run (`POST /modules/webdev/provision`);
// direct GitHub repo creation is fail-closed on the backend by design (WS11: a PM step). So the form
// offers RUNS, not a blank name: this department's runs that have no active site yet. A `failed` row
// does not hold the run's slot (partial-unique on non-failed rows), so a run whose only attempt
// failed is offered again, flagged as a retry.
export interface EligibleRun { id: string; title: string; clientName: string | null; retry: boolean }

export function runsEligibleForRepo(
  deptRuns: PipelineRun[],
  sites: ProvisionedSite[],
  clientNames: Map<string, string>,
): EligibleRun[] {
  const byRun = new Map<string, ProvisionedSite[]>();
  for (const s of sites) {
    if (!s.pipelineRunId) continue;
    (byRun.get(s.pipelineRunId) ?? byRun.set(s.pipelineRunId, []).get(s.pipelineRunId)!).push(s);
  }
  return deptRuns
    .filter((run) => !(byRun.get(run.id) ?? []).some((s) => s.status !== "failed"))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((run) => ({
      id: run.id,
      title: run.title ?? "(untitled run)",
      clientName: run.client_id ? clientNames.get(run.client_id) ?? null : null,
      retry: (byRun.get(run.id) ?? []).length > 0,
    }));
}

/** A repo name from a run title, in provision's slug grammar (`^[a-z0-9-]{1,40}$`). */
export function suggestSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

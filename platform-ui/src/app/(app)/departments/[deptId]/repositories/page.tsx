import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getDepartment } from "@/lib/departments";
import { deptTabs, toolkitFor } from "@/lib/deptToolkits";
import { listPipelineRuns } from "@/lib/pipeline";
import { listClients, listProjects } from "@/lib/entities";
import { listConnections } from "@/lib/connections";
import { listProvisionedSites } from "@/lib/webdevProvisionedSites-data";
import { provisionSiteAction, reconcileSiteAction } from "@/lib/webdevProvisionedSitesActions";
import { buildRepoInventory, runsEligibleForRepo } from "@/lib/repoInventory";
import { SAMPLE_REPO_ROWS } from "@/lib/repoInventory.sample";
import { RepoInventory, type RepoInventoryState } from "@/components/repositories/RepoInventory";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { BackendPending } from "@/components/BackendPending";
import { listGithubRepos, type ListGithubReposResult } from "@/lib/githubRepos-data";
import type { LinkCandidate } from "@/lib/githubRepos";
import { linkGithubRepoAction, unlinkGithubRepoAction } from "@/lib/githubReposActions";
import { GithubRepoRegistry } from "@/components/github/GithubRepoRegistry";

type Params = Promise<{ deptId: string }>;
type Search = Promise<{ preview?: string | string[]; archived?: string }>;

// Repositories — the department's code inventory: every repository the delivery pipeline has
// provisioned for this department's projects (`webdev_provisioned_sites`, read tenant-wide, then
// attributed through run → project → department, the same rule PRD Studio uses). Each row: name →
// GitHub, client · project, status, staging URL, the PRD run it came from, last check; failures say
// why and offer the one action that helps.
//
// The old note here said commits, PRs and non-pipeline repos "need the GitHub App on the org
// (WD-21/22, owner action)". Stale as of 2026-08-31 — the App is installed and 221 repos carry that
// state. They are not missing, they live in the SECOND section below (the org registry), which is a
// different dataset on a different tenant scope. Two labelled sections, not one merged table.
export default async function DepartmentRepositoriesPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  const { preview, archived } = await searchParams;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  if (!deptTabs(toolkitFor(dept.name)).some((t) => t.key === "repositories")) notFound();

  const basePath = `/departments/${deptId}/repositories`;
  // `?preview=sample` — the layout with sample rows behind an unmistakable banner, for a platform
  // where nothing has been provisioned yet. Real reads are skipped entirely so the two can never mix.
  if (preview === "sample") {
    const connections = await listConnections(userId, tenant, { owner: "me", provider: "github" });
    const gh = connections.rows.find((r) => r.provider === "github") ?? null;
    return (
      <Card title="Repositories">
        <RepoInventory
          state={{ kind: "ok", rows: SAMPLE_REPO_ROWS }}
          github={gh ? { status: gh.status, account: gh.externalAccount } : null}
          mayReconcile={false}
          actions={{ reconcile: reconcileSiteAction }}
          pipelineHref="/pipeline"
          sample={{ exitHref: basePath }}
        />
      </Card>
    );
  }

  // AGN-3: the run list is what attributes repos to this department — a refusal is stated, not
  // rendered as "no repositories".
  const runsResult = await listPipelineRuns(userId, tenant);
  if (runsResult.kind === "forbidden") return <ReadRefusal subject="this department's delivery runs" kind="forbidden" />;
  if (runsResult.kind === "unavailable") return <ReadRefusal subject="This department's delivery runs" kind="unavailable" reason={runsResult.reason} />;

  const [sitesResult, clients, projects, connections] = await Promise.all([
    listProvisionedSites(userId, tenant),
    listClients(userId, tenant),
    listProjects(userId, tenant).catch(() => []),
    listConnections(userId, tenant, { owner: "me", provider: "github" }),
  ]);

  const deptProjectIds = new Set(projects.filter((p) => p.department_id === deptId).map((p) => p.id));
  const state: RepoInventoryState = !sitesResult.ok
    ? { kind: sitesResult.reason }
    : {
        kind: "ok",
        rows: buildRepoInventory(
          sitesResult.sites,
          runsResult.data,
          { clients: new Map(clients.map((c) => [c.id, c.name])), projects: new Map(projects.map((p) => [p.id, p.name])) },
          deptId,
          deptProjectIds,
        ),
      };

  const gh = connections.rows.find((r) => r.provider === "github") ?? null;
  const github = gh ? { status: gh.status, account: gh.externalAccount } : null;
  const mayProvision = can(me, "webdev.provision", tenant);

  // "Create repository" = provision a site for one of this department's runs that has none yet.
  // Offered only when the person may provision AND the webdev module answers (a module that is off
  // cannot provision either).
  const deptRuns = runsResult.data.filter((r) => (r.department_id ? r.department_id === deptId : !!r.project_id && deptProjectIds.has(r.project_id)));
  const create = mayProvision && sitesResult.ok
    ? {
        runs: runsEligibleForRepo(deptRuns, sitesResult.sites, new Map(clients.map((c) => [c.id, c.name]))),
        // Standalone lineage pickers: this department's projects, and the clients they belong to.
        clients: clients.map((c) => ({ id: c.id, name: c.name })),
        projects: projects.filter((p) => p.department_id === deptId).map((p) => ({ id: p.id, name: p.name, client_id: p.client_id })),
        actions: { provision: provisionSiteAction },
        prdHref: `/departments/${deptId}/prd`,
      }
    : undefined;

  // GH-10 — link-target candidates for the org registry's suggestion engine, tenant-wide (never
  // scoped to this one department: the registry below lists every repo in the org, so the sites/
  // projects it can suggest against must be every site/project in the company too, not just this
  // department's — a repo belonging to another department's site must still be suggestible).
  // Reuses the two reads this page already made for the pipeline card above rather than issuing a
  // second round trip for the same tenant-wide rows.
  const siteCandidates: LinkCandidate[] = sitesResult.ok ? sitesResult.sites.map((s) => ({ id: s.id, name: s.slug })) : [];
  const projectCandidates: LinkCandidate[] = projects.map((p) => ({ id: p.id, name: p.name }));
  const mayLinkRepos = can(me, "github.link", tenant);

  return (
    <>
      <Card title="Provisioned by the pipeline">
        <RepoInventory
          state={state}
          github={github}
          mayReconcile={mayProvision}
          actions={{ reconcile: reconcileSiteAction }}
          pipelineHref="/pipeline"
          previewHref={`${basePath}?preview=sample`}
          create={create}
        />
      </Card>
      <OrgRegistry
        userId={userId}
        tenant={tenant}
        includeArchived={archived === "1"}
        basePath={basePath}
        mayLink={mayLinkRepos}
        siteCandidates={siteCandidates}
        projectCandidates={projectCandidates}
      />
    </>
  );
}

// ── The org-wide GitHub registry (blueprint §5.4), MOVED HERE from /systems/github 2026-08-31 ──────
// Owner decision. Web Dev already owns Repositories / Sites / Portfolio, so a second "Sites & Repos"
// under Systems was a trap: someone looking for repositories opens the department's Repositories tab,
// finds only the pipeline-provisioned list, and concludes the registry is empty. That happened on the
// very first real look at it.
//
// The two sections are DIFFERENT DATASETS and are labelled rather than merged. Above:
// `webdev_provisioned_sites` — what the delivery pipeline built for THIS department, with client and
// project lineage and a provision action. Below: `github_repos` — every repo GitHub reports for the
// org, the superset, including repos no pipeline created. This file's original comment said that
// second view "needs the GitHub App on the org (WD-21/22, owner action)". That is now done, and this
// is it.
function refusalOrPending(result: Extract<ListGithubReposResult, { ok: false }>) {
  if (result.reason === "refused") {
    return (
      <ReadRefusal
        subject="the org-wide GitHub registry"
        kind="forbidden"
        detail="Your account is not authorized to read the repository registry. The github_repo policy is live, so this is a real authorization decision, not a pending feature and not an outage."
      />
    );
  }
  return (
    <BackendPending
      what="The org-wide GitHub registry isn't reachable right now."
      contract="GET /api/:t/github/repos (docs/FRONTEND-BFF-CONTRACT.md §25)"
    />
  );
}

async function OrgRegistry({
  userId,
  tenant,
  includeArchived,
  basePath,
  mayLink,
  siteCandidates,
  projectCandidates,
}: {
  userId: string;
  tenant: string;
  includeArchived: boolean;
  basePath: string;
  /** GH-10: `can(me, "github.link", tenant)` — a mirror only. The 403 a Cerbos denial would still
   *  produce is the real authority; this decides whether the controls are even OFFERED, so a
   *  principal who cannot link never sees a button that would just refuse them. */
  mayLink: boolean;
  siteCandidates: LinkCandidate[];
  projectCandidates: LinkCandidate[];
}) {
  // `archived: undefined` (param omitted) means "both states" per §25 — there is no third value.
  const archivedFilter = includeArchived ? undefined : false;
  const [linkedResult, unlinkedResult, archivedCountResult] = await Promise.all([
    listGithubRepos(userId, tenant, { linked: true, archived: archivedFilter, limit: 200 }),
    listGithubRepos(userId, tenant, { linked: false, archived: archivedFilter, limit: 200 }),
    listGithubRepos(userId, tenant, { archived: true, limit: 1 }),
  ]);

  if (!linkedResult.ok) return <Card title="Everything in the GitHub org">{refusalOrPending(linkedResult)}</Card>;
  if (!unlinkedResult.ok) return <Card title="Everything in the GitHub org">{refusalOrPending(unlinkedResult)}</Card>;

  if (linkedResult.data.total === 0 && unlinkedResult.data.total === 0) {
    return (
      <Card title="Everything in the GitHub org">
        <EmptyNote>No repositories on file yet. The initial org crawl (GH-06) seeds this table.</EmptyNote>
      </Card>
    );
  }

  return (
    <Card title="Everything in the GitHub org">
      <GithubRepoRegistry
        linked={linkedResult.data}
        unlinked={unlinkedResult.data}
        archivedTotal={archivedCountResult.ok ? archivedCountResult.data.total : null}
        includeArchived={includeArchived}
        basePath={basePath}
        mayLink={mayLink}
        siteCandidates={siteCandidates}
        projectCandidates={projectCandidates}
        actions={{ link: linkGithubRepoAction, unlink: unlinkGithubRepoAction }}
      />
    </Card>
  );
}

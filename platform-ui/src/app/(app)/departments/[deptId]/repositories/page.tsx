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

type Params = Promise<{ deptId: string }>;
type Search = Promise<{ preview?: string | string[] }>;

// Repositories — the department's code inventory: every repository the delivery pipeline has
// provisioned for this department's projects (`webdev_provisioned_sites`, read tenant-wide, then
// attributed through run → project → department, the same rule PRD Studio uses). Each row: name →
// GitHub, client · project, status, staging URL, the PRD run it came from, last check; failures say
// why and offer the one action that helps. What it cannot show yet — commits, PRs, repos created
// outside the pipeline — needs the GitHub App on the org (WD-21/22, owner action), and the page says
// so rather than pretending.
export default async function DepartmentRepositoriesPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  const { preview } = await searchParams;
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

  return (
    <Card title="Repositories">
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
  );
}

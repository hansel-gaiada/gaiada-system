import { getPrefs } from "@/lib/prefs";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { activeCompany } from "@/lib/companyContext";
import { getProject } from "@/lib/entities";
import { listDepartmentBriefs } from "@/lib/departments";
import { workspaceFor } from "@/lib/workspaces";
import { myWorkspaces } from "@/lib/workspaces-data";
import { listGithubRepos } from "@/lib/githubRepos-data";
import { listProperties } from "@/lib/searchMarketing";
import { toolContextLinks, type FigmaLinkRef, type RepoRef, type SearchPropertyRef } from "@/lib/toolContext";
import type { ReadResult } from "@/lib/readResult";
import type { FigmaLinks } from "@/lib/figma";
import type { DeptLauncher } from "@/lib/deptToolkits";
import { OpenInMenu } from "./OpenInMenu";

// DW-6c2: the "Open in" menu's server half. Pilot only: it renders nothing unless `prefs.shell === "workspaces"`,
// so the classic pages stay byte-identical. Everything it reads is a convenience, so a failed read never breaks
// the page: a repository list that cannot be read falls back to the tools' home links, never to "no repository".
//
//   task / project  the tools of the project's department's workspace (projects.department_id -> the org tree's
//                   department name -> workspaceFor). No department, no menu.
//   client          the tools of the viewer's home workspace. A Company home, or no tools, no menu.
export type OpenInScope =
  | {
      scope: "task"; projectId: string; /** `ABC-12`, from the task's `displayCode`. */ taskKey?: string | null;
      /** DW-6k: the task's Figma links, read ONCE by the page for its Designs section and passed here, never read twice. */
      figma?: ReadResult<FigmaLinks>;
    }
  | { scope: "project"; projectId: string }
  | { scope: "client"; clientId: string };

/** The linked repositories of one project, from ONE registry read (never one per repo). `undefined` = cannot say. */
async function linkedRepos(userId: string, tenant: string, projectId: string): Promise<RepoRef[] | undefined> {
  const r = await listGithubRepos(userId, tenant, { linked: true, archived: false, limit: 200 }).catch(() => null);
  if (!r || !r.ok) return undefined; // refused / no_org / unavailable: unknown, not "none"
  // A truncated page may be missing this project's repo: unknown again, not "none".
  if (r.data.total > r.data.repos.length) return undefined;
  return r.data.repos.filter((x) => x.projectId === projectId).map((x) => ({ fullName: x.fullName }));
}

export async function OpenInSlot(props: OpenInScope) {
  const prefs = await getPrefs();
  if (prefs.shell !== "workspaces") return null;

  const userId = await getSessionUserId();
  if (!userId) return null;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return null;

  let tools: readonly DeptLauncher[] = [];
  let repos: RepoRef[] | undefined;
  let searchProperties: SearchPropertyRef[] | undefined;
  let taskKey: string | null = null;
  let figmaLinks: FigmaLinkRef[] | undefined;

  if (props.scope === "client") {
    const mine = await myWorkspaces(me, tenant);
    if (mine.home.kind !== "workspace") return null;
    tools = mine.home.ref.workspace.tools;
    if (tools.some((t) => t.key === "gsc")) {
      const all = await listProperties(userId, tenant).catch(() => []);
      // The row carries `domain` and `siteUrl` but no field that says which kind of property it is, so `kind`
      // stays unset and Search Console opens its home (toolContext.ts never guesses).
      searchProperties = all.filter((p) => p.clientId === props.clientId).map((p) => ({ domain: p.domain, siteUrl: p.siteUrl }));
    }
  } else {
    const project = await getProject(userId, tenant, props.projectId).catch(() => null);
    const deptId = project?.department_id;
    if (!deptId) return null;
    const dept = (await listDepartmentBriefs(userId, tenant)).find((d) => d.id === deptId);
    if (!dept) return null;
    tools = workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).tools;
    if (tools.some((t) => t.key === "github" || t.key === "vscode")) repos = await linkedRepos(userId, tenant, props.projectId);
    if (props.scope === "task") {
      taskKey = props.taskKey ?? null;
      // A failed or refused links read is "cannot say": Figma then opens its home, never "no links".
      if (props.figma?.kind === "ok") figmaLinks = props.figma.data.items.map((l) => ({ url: l.url, title: l.title }));
    }
  }

  if (tools.length === 0) return null;
  const glyphs = new Map(tools.map((t) => [t.key, t.glyph]));
  const entries = toolContextLinks(tools, { repos, taskKey, searchProperties, figmaLinks }).map((l) => ({ ...l, glyph: glyphs.get(l.key) }));
  return <OpenInMenu entries={entries} />;
}

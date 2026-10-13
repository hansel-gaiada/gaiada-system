import type { OverviewWidgetProps } from "./index";
import { listProjects } from "@/lib/entities";
import { readProjectPmInputs } from "@/lib/pm";
import { readResult } from "@/lib/readResult";
import { isOpenProject, projectRow, projectsView } from "@/lib/overviewWork";
import { ProjectsBlock } from "./WorkBlocks";

// DW-3f: "Projects", the Work band's block: the department's own projects (the BFF's `departmentId` facet), the top
// four by risk, each with its health and next due date. The list is read through `readResult`, never `.catch(() => [])`,
// and so is each project's work: a refusal or a failure says "No access" or "Unavailable" in its place and is never
// a quiet "on track" or "no projects".
export async function Projects({ me, tenantId, deptId }: OverviewWidgetProps) {
  // Nothing to scope to without a department: the frame does not place the block then, and this keeps it so.
  if (!deptId) return null;
  const now = new Date();
  const href = `/departments/${deptId}/projects`;
  const list = await readResult(listProjects(me.userId, tenantId, undefined, deptId));
  if (list.kind !== "ok") return <ProjectsBlock view={{ kind: list.kind }} href={href} />;
  const open = list.data.filter(isOpenProject);
  const rows = await Promise.all(open.map(async (p) => projectRow(p, await readProjectPmInputs(me.userId, tenantId, p.id), now)));
  return <ProjectsBlock view={projectsView({ kind: "ok", data: rows })} href={href} />;
}

import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getFieldDefs, listMembers } from "@/lib/entities";
import { listDepartmentBriefs } from "@/lib/departments";
import { PageHeader } from "@/components/PageHeader";
import { ProjectForm } from "@/components/forms/ProjectForm";
import { createProject } from "../actions";

type Search = Promise<{ departmentId?: string | string[] }>;

// `?departmentId=` pre-selects the owning department — the department consoles' "New project" button
// arrives with it, so a Web Dev lead does not re-pick their own department.
export default async function NewProjectPage({ searchParams }: { searchParams: Search }) {
  const { departmentId } = await searchParams;
  const defaultDepartmentId = typeof departmentId === "string" ? departmentId : undefined;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/projects");

  const [defs, members, departments] = await Promise.all([
    getFieldDefs(userId, tenant, "project"),
    listMembers(userId, tenant),
    listDepartmentBriefs(userId, tenant).catch(() => []),
  ]);

  return (
    <>
      <PageHeader eyebrow="Project" title="New project" breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: "New project" }]} />
      <ProjectForm action={createProject} defs={defs} members={members} departments={departments} defaultDepartmentId={defaultDepartmentId} />
    </>
  );
}

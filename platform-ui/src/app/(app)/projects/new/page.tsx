import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getFieldDefs, listClients, listMembers } from "@/lib/entities";
import { listDepartmentBriefs } from "@/lib/departments";
import { PageHeader } from "@/components/PageHeader";
import { ProjectForm } from "@/components/forms/ProjectForm";
import { createProject } from "../actions";

type Search = Promise<{ departmentId?: string | string[]; clientId?: string | string[] }>;

// `?departmentId=` pre-selects the owning department — the department consoles' "New project" button
// arrives with it, so a Web Dev lead does not re-pick their own department.
export default async function NewProjectPage({ searchParams }: { searchParams: Search }) {
  const { departmentId, clientId } = await searchParams;
  const defaultDepartmentId = typeof departmentId === "string" ? departmentId : undefined;
  const defaultClientId = typeof clientId === "string" ? clientId : undefined;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/projects");

  const [defs, members, departments, clients] = await Promise.all([
    getFieldDefs(userId, tenant, "project"),
    listMembers(userId, tenant),
    listDepartmentBriefs(userId, tenant).catch(() => []),
    listClients(userId, tenant),
  ]);

  return (
    <>
      <PageHeader eyebrow="Project" title="New project" breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: "New project" }]} />
      <ProjectForm action={createProject} defs={defs} members={members} departments={departments} defaultDepartmentId={defaultDepartmentId} clients={clients} defaultClientId={defaultClientId} />
    </>
  );
}

import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getFieldDefs, getProject, listClients, listMembers } from "@/lib/entities";
import { listDepartmentBriefs } from "@/lib/departments";
import { PageHeader } from "@/components/PageHeader";
import { ProjectForm } from "@/components/forms/ProjectForm";
import { updateProject } from "../../actions";

export default async function EditProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  let project;
  try {
    project = await getProject(userId, tenant, projectId);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) notFound();
    throw e;
  }

  const [defs, members, departments, clients] = await Promise.all([
    getFieldDefs(userId, tenant, "project"),
    listMembers(userId, tenant),
    listDepartmentBriefs(userId, tenant).catch(() => []),
    listClients(userId, tenant),
  ]);

  return (
    <>
      <PageHeader eyebrow="Project" title={`Edit ${project.name}`} breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: project.name, href: `/projects/${projectId}` }, { label: "Edit" }]} />
      <ProjectForm action={updateProject.bind(null, projectId)} defs={defs} members={members} departments={departments} clients={clients} project={project} />
    </>
  );
}

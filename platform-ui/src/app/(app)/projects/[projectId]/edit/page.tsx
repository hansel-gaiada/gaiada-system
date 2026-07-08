import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getFieldDefs, getProject, listMembers } from "@/lib/entities";
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

  const [defs, members] = await Promise.all([getFieldDefs(userId, tenant, "project"), listMembers(userId, tenant)]);

  return (
    <>
      <PageHeader eyebrow="Project" title={`Edit ${project.name}`} />
      <ProjectForm action={updateProject.bind(null, projectId)} defs={defs} members={members} project={project} />
    </>
  );
}

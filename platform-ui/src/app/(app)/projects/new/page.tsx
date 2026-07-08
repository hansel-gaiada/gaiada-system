import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getFieldDefs, listMembers } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { ProjectForm } from "@/components/forms/ProjectForm";
import { createProject } from "../actions";

export default async function NewProjectPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/projects");

  const [defs, members] = await Promise.all([getFieldDefs(userId, tenant, "project"), listMembers(userId, tenant)]);

  return (
    <>
      <PageHeader eyebrow="Project" title="New project" />
      <ProjectForm action={createProject} defs={defs} members={members} />
    </>
  );
}

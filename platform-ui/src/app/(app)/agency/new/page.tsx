import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listProjects } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { CampaignForm } from "@/components/forms/CampaignForm";
import { createCampaign } from "../actions";

export default async function NewCampaignPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/agency");

  const projects = await listProjects(userId, tenant);

  return (
    <>
      <PageHeader eyebrow="Campaign" title="New campaign" />
      <CampaignForm action={createCampaign} projects={projects} />
    </>
  );
}

import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { Card } from "@/components/ui";
import { BackendPending } from "@/components/BackendPending";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Inbox (SMM-11 route, SMM-15/16 backend) — comments/DMs across every connected account. The
// route exists so the "Publish" craft group's toolkit entry doesn't 404 (deptToolkits.ts's own
// standing rule), but `pullInbox`/AI triage (SMM-15/16) are both still 0.0.0 — an honest
// BackendPending shell, never an empty inbox that would read as "nothing waiting."
export default async function DepartmentSocialInboxPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  return (
    <Card title="Inbox">
      <BackendPending
        what="Engagement-inbox sync and AI triage haven't shipped yet."
        contract="modules/social — SMM-15 (pullInbox) / SMM-16 (triage)"
      />
    </Card>
  );
}

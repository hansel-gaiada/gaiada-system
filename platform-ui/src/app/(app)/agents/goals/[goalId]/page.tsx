import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getAgentGoal } from "@/lib/admin";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { GoalDetailClient } from "./GoalDetailClient";

type Params = Promise<{ goalId: string }>;

// Goal detail (B4, doc §3.4): blackboard, run summaries, and a WS4 approvals
// deep-link when suspended. Tenant-pinned exactly like every other reader
// here — a goal from another company (or an unknown id) degrades to the
// "not available" state rather than ever probing across tenants.
export default async function AgentGoalDetailPage({ params }: { params: Params }) {
  const { goalId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const goal = tenant ? await getAgentGoal(userId, tenant, goalId) : null;

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Agent goal"
        subtitle={goal?.goal ?? "Goal detail, blackboard and run history."}
        breadcrumbs={[{ label: "AI Agents", href: "/agents" }, { label: goalId.slice(0, 8) }]}
      />
      {tenant ? (
        <GoalDetailClient goalId={goalId} initialGoal={goal} />
      ) : (
        <EmptyNote>Select a company to see this goal.</EmptyNote>
      )}
    </>
  );
}

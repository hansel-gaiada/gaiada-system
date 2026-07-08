import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getSystemStatus, getAgentGoals } from "@/lib/admin";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { StatusCard } from "@/components/systems/StatusCard";
import { EmptyNote } from "@/components/systems/EmptyNote";

// Agents are tenant-scoped — the supervisor orchestrator runs a per-tenant
// goal tree (blackboard, cycle guard, per-goal budget), so the console shows
// the active company's goals only.
export default async function AgentsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  const [status, goals] = await Promise.all([
    getSystemStatus(userId, "agents"),
    tenant ? getAgentGoals(userId, tenant) : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="AI Agents"
        subtitle="The supervisor orchestrator's goal tree for this company — specialist fan-out, budget spend and status per goal."
      />

      <StatusCard status={status} />

      <div style={{ marginTop: 20 }}>
        <Card title="Goals">
          {goals.length > 0 ? (
            <HairlineTable
              columns={[{ label: "Goal" }, { label: "Status" }, { label: "Budget" }, { label: "Fan-out" }]}
              rows={goals.map((g) => [
                g.goal,
                <StatusBadge key={`${g.id}-status`} label={g.status} />,
                `${g.budgetSpent ?? 0} / ${g.budgetTotal ?? "—"}`,
                g.fanOut ?? "—",
              ])}
            />
          ) : (
            <EmptyNote>Agent goals appear once the agents admin API is connected.</EmptyNote>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Run history">
          <EmptyNote>Run history and blackboard inspection arrive with the agents admin API.</EmptyNote>
        </Card>
      </div>
    </>
  );
}

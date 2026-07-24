import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getSystemStatus, getAgentGoals, agentOptions } from "@/lib/admin";
import { isElevated } from "@/lib/rbac";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { StatusCard } from "@/components/systems/StatusCard";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { GoalsTable } from "./GoalsTable";
import { AgentTriggerCard } from "./AgentTriggerCard";

// Agents are tenant-scoped — the supervisor orchestrator runs a per-tenant
// goal tree (blackboard, cycle guard, per-goal budget), so the console shows
// the active company's goals only. B4 (doc §3.4): real status probe now that
// the agent-runner exists, an elevated-gated trigger card, and a goals table
// that links into per-goal detail + polls while anything is in flight.
export default async function AgentsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  const [status, goals] = await Promise.all([
    getSystemStatus(userId, "agents"),
    tenant ? getAgentGoals(userId, tenant) : Promise.resolve([]),
  ]);

  const elevated = isElevated(me);

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="AI Agents"
        subtitle="The supervisor orchestrator's goal tree for this company — specialist fan-out, budget spend and status per goal."
      />

      <StatusCard status={status} />

      {elevated && (
        <div style={{ marginTop: 20 }}>
          <Card title="Trigger a goal">
            {tenant ? (
              <AgentTriggerCard agentOptions={agentOptions(status)} />
            ) : (
              <EmptyNote>Select a company to trigger an agent goal.</EmptyNote>
            )}
          </Card>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <Card title="Goals">
          {tenant ? (
            <GoalsTable initialGoals={goals} />
          ) : (
            <EmptyNote>Select a company to see its agent goals.</EmptyNote>
          )}
        </Card>
      </div>
    </>
  );
}

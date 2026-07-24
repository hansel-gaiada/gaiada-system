import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getAgentRun } from "@/lib/admin";
import { isElevated } from "@/lib/rbac";
import { PageHeader } from "@/components/PageHeader";
import { Card, StatusBadge, KpiTile } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { TranscriptView } from "./TranscriptView";

type Params = Promise<{ runId: string }>;

// Run transcript (B4, doc §3.4/§3.3) — elevated-only on the backend (a
// transcript can carry tool output fetched under the triggering user's
// authority), so this page also hides itself from non-elevated callers
// (cosmetic; nest's `isElevated` on GET /api/:t/agents/runs/:runId is the
// real gate — a direct non-elevated request there degrades to null via
// skipUnavailable's 403 handling, never a thrown error).
export default async function AgentRunDetailPage({ params }: { params: Params }) {
  const { runId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const elevated = isElevated(me);

  const run = tenant && elevated ? await getAgentRun(userId, tenant, runId) : null;

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Agent run"
        subtitle="Full step transcript for this run — model and tool activity, rendered as inert text only."
        breadcrumbs={[
          { label: "AI Agents", href: "/agents" },
          ...(run ? [{ label: "Goal", href: `/agents/goals/${run.goalId}` }] : []),
          { label: runId.slice(0, 8) },
        ]}
      />

      {!elevated ? (
        <EmptyNote>Run transcripts are visible to platform administrators and owners only.</EmptyNote>
      ) : !tenant ? (
        <EmptyNote>Select a company to see this run.</EmptyNote>
      ) : !run ? (
        <EmptyNote>
          This run isn&apos;t available — it may belong to another company, or the agents admin API isn&apos;t connected yet.
        </EmptyNote>
      ) : (
        <>
          <Card title="Summary">
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
              <StatusBadge label={run.status} />
              <KpiTile label="Agent" value={run.agent} />
              <KpiTile label="Model calls" value={String(run.modelCalls ?? 0)} />
              <KpiTile label="Tool calls" value={String(run.toolCalls ?? 0)} />
              {run.provider && <KpiTile label="Provider" value={run.provider} />}
            </div>
            {(run.toolsCalled?.length ?? 0) > 0 && (
              <div style={{ marginTop: 16 }}>
                <DescriptionList items={[{ label: "Tools called", value: run.toolsCalled!.join(", ") }]} />
              </div>
            )}
            {run.outcome && (
              <div style={{ marginTop: 16 }}>
                <DescriptionList items={[{ label: "Outcome", value: run.outcome }]} />
              </div>
            )}
          </Card>

          <div style={{ marginTop: 20 }}>
            <Card title="Transcript">
              <TranscriptView steps={run.steps} />
            </Card>
          </div>
        </>
      )}
    </>
  );
}

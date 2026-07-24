"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, HairlineTable, StatusBadge, KpiTile } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { EmptyNote } from "@/components/systems/EmptyNote";
import type { AgentGoalDetail } from "@/lib/admin";

const POLL_MS = 4000;

// Mirrors lib/admin.ts's hasActiveGoal — see GoalsTable.tsx's comment for why
// this is duplicated rather than imported (admin.ts is "server-only").
function isActive(status: string): boolean {
  return status === "queued" || status === "running";
}

// Goal detail (doc §3.4): status/budget/fan-out header, blackboard entries,
// run summaries linking to transcripts, and a WS4 approvals deep-link when
// suspended. Self-polls every 4s while the goal is queued/running.
//
// IMPORTANT: `goal.goal`, blackboard `task`/`summary`, and every other field
// here is rendered as plain React text children (auto-escaped, never
// dangerouslySetInnerHTML) — this is untrusted goal text / model-summarized
// output, same posture as the run transcript view.
export function GoalDetailClient({ goalId, initialGoal }: { goalId: string; initialGoal: AgentGoalDetail | null }) {
  const [goal, setGoal] = useState<AgentGoalDetail | null>(initialGoal);

  useEffect(() => {
    if (!goal || !isActive(goal.status)) return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/admin/agents/goals?goalId=${encodeURIComponent(goalId)}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { goal?: AgentGoalDetail | null };
        if (!cancelled) setGoal(data.goal ?? null);
      } catch {
        // Transient network hiccup — the next tick retries.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal, goalId]);

  if (!goal) {
    return (
      <EmptyNote>
        This goal isn&apos;t available — it may belong to another company, or the agents admin API isn&apos;t connected yet.
      </EmptyNote>
    );
  }

  return (
    <>
      <Card title="Status">
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
          <StatusBadge label={goal.status} />
          <KpiTile label="Budget" value={`${goal.budgetSpent ?? 0} / ${goal.budgetTotal ?? "—"}`} />
          <KpiTile label="Fan-out" value={String(goal.fanOut ?? 0)} />
          {goal.agent && <KpiTile label="Agent" value={goal.agent} />}
        </div>
        <div style={{ marginTop: 16 }}>
          <DescriptionList
            items={[
              { label: "Goal", value: goal.goal },
              { label: "Created", value: goal.createdAt ?? "—" },
              { label: "Ended", value: goal.endedAt ?? "—" },
              ...(goal.errorKind ? [{ label: "Error kind", value: goal.errorKind }] : []),
            ]}
          />
        </div>
        {goal.status === "suspended" && goal.approvalId && (
          <div style={{ marginTop: 16 }}>
            <Link
              href="/approvals?origin=agent"
              className="lux-btn lux-btn--solid lux-btn--sm"
              style={{ textDecoration: "none", display: "inline-block" }}
            >
              Review in Approvals (#{goal.approvalId.slice(0, 8)})
            </Link>
          </div>
        )}
      </Card>

      <div style={{ marginTop: 20 }}>
        <Card title="Blackboard">
          {goal.blackboard && goal.blackboard.length > 0 ? (
            <HairlineTable
              columns={[{ label: "Specialist" }, { label: "Task" }, { label: "Status" }, { label: "Summary" }]}
              rows={goal.blackboard.map((b, i) => [
                b.specialist,
                b.task,
                <StatusBadge key={`bb-${i}`} label={b.status} />,
                b.summary,
              ])}
            />
          ) : (
            <EmptyNote>
              {goal.agent === "supervisor"
                ? "No specialist fan-out recorded for this goal yet."
                : "This goal ran a single specialist directly — see Runs below for its transcript."}
            </EmptyNote>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Runs">
          {goal.runs.length > 0 ? (
            <HairlineTable
              columns={[{ label: "Run" }, { label: "Agent" }, { label: "Status" }, { label: "Model / tool calls" }]}
              rows={goal.runs.map((r) => [
                <Link
                  key={r.runId}
                  href={`/agents/runs/${r.runId}`}
                  style={{ color: "var(--text-primary)", textDecoration: "none", fontWeight: 500 }}
                >
                  {r.runId.slice(0, 8)}
                </Link>,
                r.agent,
                <StatusBadge key={`${r.runId}-status`} label={r.status} />,
                `${r.modelCalls ?? 0} / ${r.toolCalls ?? 0}`,
              ])}
            />
          ) : (
            <EmptyNote>No runs recorded for this goal yet.</EmptyNote>
          )}
        </Card>
      </div>
    </>
  );
}

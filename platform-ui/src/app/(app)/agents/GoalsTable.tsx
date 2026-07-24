"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import type { AgentGoal } from "@/lib/admin";

const POLL_MS = 4000;

// Mirrors lib/admin.ts's hasActiveGoal (kept inline here, not imported —
// admin.ts is "server-only" and this is a client component; see
// ConfigField.tsx for the same type-only-import boundary this file respects).
function isActive(status: string): boolean {
  return status === "queued" || status === "running";
}

// The /agents goals table (doc §3.4): server-rendered on first paint, then
// self-polls the same-origin route handler every 4s WHILE any goal is
// queued/running, and stops the moment none are (no polling at rest).
export function GoalsTable({ initialGoals }: { initialGoals: AgentGoal[] }) {
  const [goals, setGoals] = useState<AgentGoal[]>(initialGoals);

  useEffect(() => {
    if (!goals.some((g) => isActive(g.status))) return; // nothing in flight — no interval
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/admin/agents/goals", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { goals?: AgentGoal[] };
        if (!cancelled) setGoals(data.goals ?? []);
      } catch {
        // Transient network hiccup — the next tick retries.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // Re-evaluated whenever `goals` changes so the interval is torn down the
    // instant the active set empties (a goal finishing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goals]);

  if (goals.length === 0) {
    return <EmptyNote>Agent goals appear once a goal has been triggered for this company.</EmptyNote>;
  }

  return (
    <HairlineTable
      columns={[{ label: "Goal" }, { label: "Status" }, { label: "Budget" }, { label: "Fan-out" }]}
      rows={goals.map((g) => [
        <Link
          key={`${g.id}-link`}
          href={`/agents/goals/${g.id}`}
          style={{ color: "var(--text-primary)", textDecoration: "none", fontWeight: 500 }}
        >
          {g.goal}
        </Link>,
        <StatusBadge key={`${g.id}-status`} label={g.status} />,
        `${g.budgetSpent ?? 0} / ${g.budgetTotal ?? "—"}`,
        g.fanOut ?? "—",
      ])}
    />
  );
}

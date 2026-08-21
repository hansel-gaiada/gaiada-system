import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getObservability } from "@/lib/observability-data";
import { hostRowFromSnapshot } from "@/lib/observability";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ObservabilityConsole } from "@/components/systems/ObservabilityConsole";

export const metadata = { title: "Observability" };
export const dynamic = "force-dynamic";

// PLANE A — this box (or boxes, see below), staff only. The client-facing property monitoring is
// /monitoring (Plane B), a different module with different tenancy; the two never merge
// (monitoring-program.md §8.1).
//
// MON-10 — rebuilt as a dense, sortable/filterable HOST TABLE (ObservabilityHostTable) with a
// per-host drilldown (ObservabilityDrilldown), because the audience is an on-call engineer
// triaging, not a dashboard browser: "which host is unhappy, since when, is it getting worse, what
// do I look at next" beats a wall of KPI cards, and it has to scale past one box without a rebuild.
//
// TODAY there is exactly ONE real endpoint (`GET /api/admin/observability`, `lib/observability-
// data.ts`) and it answers for exactly one, unnamed box — no hostname, no environment tag. Rather
// than fabricate either (the recurring "frontend-first drift" failure this codebase keeps naming),
// `hostRowFromSnapshot` produces a single `HostRow` with `environment: null` and the generic label
// "This box", and the table/drilldown render that honestly ("not tagged", with the reason on
// hover) instead of inventing a name. `HostRow` (lib/observability.ts) is written host-shaped for
// exactly this reason: when a multi-host, environment-tagged endpoint exists, only this file's
// mapping changes.
export default async function ObservabilityPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const snap = await getObservability(userId);

  // null = 403/404. "You may not see this" is NOT "the box is unmonitored", so it gets its own words.
  if (!snap) {
    return (
      <>
        <PageHeader title="Observability" subtitle="Platform infrastructure health" />
        <EmptyNote>
          This console is restricted to platform administrators, or the endpoint is not deployed on
          the running backend yet. Metrics are unaffected either way — this is a visibility gate, not
          a monitoring outage.
        </EmptyNote>
      </>
    );
  }

  // `available:false` (Prometheus unset/unreachable) is no longer a page-level dead end: it becomes
  // a single host row in the "not measured" tier, with the reason attached, flowing through the
  // same table + drilldown as every other state. That is the multi-host-honest behaviour — some
  // hosts can be reachable while one is dark, and the table is where that has to show up.
  const rows = [hostRowFromSnapshot(snap)];

  return (
    <>
      <PageHeader
        title="Observability"
        subtitle="Our infrastructure's health — staff-only, not tenant-scoped. Grouped/filtered by environment once that's wired; today this is the one box the backend can see."
      />
      <ObservabilityConsole rows={rows} />
    </>
  );
}

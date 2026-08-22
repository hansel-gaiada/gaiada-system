import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getObservability } from "@/lib/observability-data";
import { hostRowFromEstateHost } from "@/lib/observability";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ObservabilityConsole } from "@/components/systems/ObservabilityConsole";

export const metadata = { title: "Observability" };
export const dynamic = "force-dynamic";

// PLANE A — our own infrastructure, staff only. The client-facing property monitoring is
// /monitoring (Plane B), a different module with different tenancy; the two never merge
// (monitoring-program.md §8.1).
//
// MSO-06 — consumes the estate shape (contract §20.1a, `EstateObservabilitySnapshot`): many hosts,
// merged against the `infra_hosts` inventory so a host that stopped reporting still appears, plus
// unregistered hosts derived from series with no inventory row. Superseded MON-10's single
// synthesized "This box" row — `hostRowFromEstateHost` now maps a REAL `HostSnapshot` per host,
// carrying real `env`/`role`/`status`/`freshness` instead of the old `environment: null` placeholder.
export default async function ObservabilityPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const snap = await getObservability(userId);

  // null = 403/404. "You may not see this" is NOT "the estate is unmonitored", so it gets its own
  // words.
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

  // `available` covers ONLY the central Prometheus (contract §20.1a note 5). `hosts`/`estate` are
  // null exactly when it is false — there is nothing host-shaped to list. Alertmanager is fetched
  // independently (note 9) so `alerts`/`alertsNote`/`estate?.alertsActive` can still be populated
  // here even when Prometheus itself is unreadable — the console must not go dark on alerts just
  // because it went dark on hosts.
  const rows = (snap.hosts ?? []).map((h) => hostRowFromEstateHost(h, snap.alerts));

  return (
    <>
      <PageHeader
        title="Observability"
        subtitle="Our infrastructure's health, estate-wide — staff-only, not tenant-scoped. Freshness is the lead signal: a host can look calm on stale data."
      />
      <ObservabilityConsole
        rows={rows}
        available={snap.available}
        reason={snap.reason ?? null}
        grafanaHint={snap.grafanaHint}
        collectedAt={snap.collectedAt}
        estate={snap.estate}
        alerts={snap.alerts}
        alertsNote={snap.alertsNote ?? null}
      />
    </>
  );
}

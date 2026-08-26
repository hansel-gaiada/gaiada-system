import Link from "next/link";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { BackendPending } from "@/components/BackendPending";
import { getSummary } from "@/lib/monitoring";

// The GM cockpit's client-monitoring tile (B3).
//
// ── PLANE B, NOT PLANE A — AND THAT IS THE WHOLE POINT ───────────────────────────────────────────
// This reads **client** property and service health: the websites and services the agency monitors
// FOR customers, which is client work and the surface the business intends to sell. It is not our own
// infrastructure. Platform observability — Prometheus / Grafana / Loki / Tempo, container health,
// scrape targets — is Plane A, lives outside the ERP behind an SSH tunnel, and is deliberately not a
// nav row at all (`docs/blueprints/monitoring-program.md` §0, and the 2026-08-13 entry in
// `docs/sidebar-nav-map.md` that put Monitoring under Business rather than Systems for exactly this
// reason).
//
// So a GM reading this card is asking "is the work we sell our clients healthy?", never "are our
// containers up?". Mixing the two would re-merge the planes the design keeps apart, and would put a
// number in front of the GM that they cannot act on commercially.
//
// ── WAS "BLOCKED", AND WAS NOT ──────────────────────────────────────────────────────────────────
// B3 sat blocked all build as "monitoring has no backend at all — BFF contract §20, every row
// PENDING". That was true when written and is not now: `platform-nest/src/modules/monitoring` ships a
// real controller (`summary`, `monitors`, `incidents`, `maintenance`, `kinds`, heartbeat ingest) and
// the module is enabled. This is the **third** time this session a "blocked" row turned out to be
// stale — after the finance module unblocked GM-09 and `reports.department.view` unblocked GM-02b.
// The habit worth keeping: re-read the blocker before quoting it.
//
// ── NULL IS NOT ZERO, AND THE LIB ALREADY SAYS SO ───────────────────────────────────────────────
// `getSummary` returns `null` when the endpoint is unavailable — its own comment: the caller "can say
// 'monitoring backend not connected' instead of rendering a confident all-zero all-clear". An all-zero
// monitoring card is the worst possible failure on this surface: it reads as "everything is up".
//
// `lastSweepAt: null` is a second, subtler honesty case the lib flags ("the runner has never
// reported: show it"). Counts can look perfectly healthy while nothing has actually probed anything —
// so when the runner has never run, that is stated instead of being implied by green numbers.

const KPI_ROW: React.CSSProperties = {
  display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
};

export async function GmMonitoringCard({ userId, tenantId }: { userId: string; tenantId: string }) {
  const s = await getSummary(userId, tenantId);

  if (s === null) {
    return (
      <Card title="Client monitoring">
        <BackendPending
          what="The monitoring service did not answer, so client property and service health is unknown — not healthy."
          contract="GET /api/:t/monitoring/summary"
        />
      </Card>
    );
  }

  if (s.total === 0) {
    return (
      <Card
        title="Client monitoring"
        headerRight={<Link href="/monitoring/new" className="lux-btn lux-btn--ghost lux-btn--sm">Add a monitor</Link>}
      >
        <EmptyNote>
          Nothing is being monitored for any client yet. This is a real zero — the service answered
          and has no monitors — which is different from the service being unreachable.
        </EmptyNote>
      </Card>
    );
  }

  // "Needs attention" leads, because it is the only figure on this card a GM acts on. Down and
  // degraded are summed: both mean a client's service is not performing as sold, and splitting them
  // on a cockpit tile asks the reader to add two numbers to answer one question. The split is one
  // click away on /monitoring.
  const attention = s.down + s.degraded;
  const healthy = s.up;
  const neverSwept = !s.lastSweepAt;

  return (
    <Card
      title="Client monitoring"
      headerRight={<Link href="/monitoring" className="lux-btn lux-btn--ghost lux-btn--sm">Monitoring</Link>}
    >
      <div style={KPI_ROW}>
        <KpiTile
          label="Needs attention"
          value={String(attention)}
          foot={attention === 0 ? `all ${s.total} monitored services up` : `${s.down} down · ${s.degraded} degraded`}
          hint="Down and degraded together — both mean a client's service is not performing as sold. The split is on the Monitoring page."
        />
        <KpiTile
          label="Open incidents"
          value={String(s.openIncidents)}
          foot={s.openIncidents === 0 ? "none unresolved" : "unacknowledged or unresolved"}
        />
        <KpiTile
          label="Monitored services"
          value={String(s.total)}
          foot={`${healthy} up${s.maintenance ? ` · ${s.maintenance} in maintenance` : ""}${s.unknown ? ` · ${s.unknown} unknown` : ""}`}
          hint="Client properties and services under monitoring. This is Plane B — the work sold to clients, not our own infrastructure, which lives outside the ERP entirely."
        />
      </div>
      {neverSwept && (
        <p style={{ margin: "12px 0 0", font: "400 12px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          <strong>The runner has never reported a sweep</strong>, so every status above is the stored
          value rather than a recent probe — healthy-looking counts here are not evidence of health.
        </p>
      )}
    </Card>
  );
}

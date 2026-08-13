import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  getMonitor,
  listResults,
  ageSeconds,
  formatAge,
  formatUptime,
  isStale,
  daysUntil,
  expiryLevel,
  type MonitorResult,
} from "@/lib/monitoring";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
// Pinned locale + timeZone. A bare toLocaleString renders differently on server and client and
// trips React hydration error #418 — see platform-ui/CLAUDE.md's hydration-divergence trap.
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Uptime strip — one cell per check, oldest → newest. Deliberately NOT a chart: the question this
 * answers is "when did it break and for how long", which a dense run of cells answers at a glance.
 * Gaps in coverage render as gaps, never as filler, so a period with no data cannot read as green.
 */
function UptimeStrip({ results }: { results: MonitorResult[] }) {
  if (results.length === 0) {
    return <EmptyNote>No check history in this window.</EmptyNote>;
  }
  const ordered = [...results].sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
  return (
    <div
      role="img"
      aria-label={`${ordered.length} checks, oldest first. ${ordered.filter((r) => r.status === "up").length} up, ${ordered.filter((r) => r.status === "down").length} down.`}
      style={{ display: "flex", gap: 2, alignItems: "flex-end", flexWrap: "wrap" }}
    >
      {ordered.map((r, i) => (
        <span
          key={`${r.checkedAt}-${i}`}
          title={`${formatDateTime(r.checkedAt)} — ${r.status}${r.latencyMs != null ? ` (${r.latencyMs}ms)` : ""}${r.detail ? ` — ${r.detail}` : ""}`}
          style={{
            width: 6,
            height: 22,
            borderRadius: 2,
            background: `var(--status-${
              r.status === "up" ? "ok" : r.status === "down" || r.status === "degraded" ? "critical" : "idle"
            })`,
          }}
        />
      ))}
    </div>
  );
}

export default async function MonitorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  }

  const [monitor, results] = await Promise.all([
    getMonitor(userId, tenant, id),
    listResults(userId, tenant, id, "24h"),
  ]);

  if (!monitor) {
    return (
      <>
        <p style={{ marginBottom: 12 }}>
          <Link href="/monitoring">← Monitoring</Link>
        </p>
        <EmptyNote>
          This monitor is not available. Either it does not exist, or the monitoring backend is not
          connected yet — those are different situations and the backend cannot currently tell them
          apart. See <code>docs/blueprints/monitoring-program.md</code>.
        </EmptyNote>
      </>
    );
  }

  const now = Date.now();
  const stale = isStale(monitor, now);
  const certDays = daysUntil(monitor.certExpiresAt, now);
  const domainDays = daysUntil(monitor.domainExpiresAt, now);
  const history = results.length > 0 ? results : monitor.results ?? [];

  return (
    <>
      <p style={{ marginBottom: 12 }}>
        <Link href="/monitoring">← Monitoring</Link>
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>{monitor.name}</h1>
        <StatusBadge label={monitor.status} />
        {!monitor.enabled && <StatusBadge label="suspended" />}
        {monitor.inMaintenanceUntil && <StatusBadge label="on hold" />}
      </div>
      <p style={{ opacity: 0.7, marginBottom: 20, fontSize: 14 }}>
        {monitor.clientName ? `${monitor.clientName} · ` : ""}
        {monitor.kind}
        {monitor.target ? ` · ${monitor.target}` : ""} · checks every {monitor.intervalSec}s
      </p>

      {/* Staleness is stated before any figure below it, because every figure below is only as
          trustworthy as the last check that produced it. */}
      {stale && (
        <div style={{ marginBottom: 16 }}>
          <EmptyNote>
            Last check was {formatAge(ageSeconds(monitor.lastCheckedAt, now))} — older than three
            check intervals. The status and uptime shown below are not current.
          </EmptyNote>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          marginBottom: 20,
        }}
      >
        <KpiTile
          label="Last check"
          value={formatAge(ageSeconds(monitor.lastCheckedAt, now))}
          foot={formatDateTime(monitor.lastCheckedAt)}
        />
        <KpiTile
          label="Latency"
          value={monitor.lastLatencyMs != null ? `${monitor.lastLatencyMs}ms` : "—"}
        />
        <KpiTile label="Uptime 24h" value={formatUptime(monitor.uptime24h)} />
        <KpiTile label="Uptime 30d" value={formatUptime(monitor.uptime30d)} />
        <KpiTile
          label="TLS certificate"
          value={certDays === null ? "—" : certDays < 0 ? "expired" : `${certDays}d`}
          foot={expiryLevel(certDays) !== "none" ? "renew now" : undefined}
        />
        <KpiTile
          label="Domain"
          value={domainDays === null ? "—" : domainDays < 0 ? "expired" : `${domainDays}d`}
          foot={expiryLevel(domainDays) !== "none" ? "renew now" : undefined}
        />
      </div>

      <Card title="Last 24 hours" hint="One cell per check, oldest first. Hover a cell for the exact result.">
        <UptimeStrip results={history} />
      </Card>

      <div style={{ marginTop: 20 }}>
        <Card title="Incidents">
          {(monitor.incidents ?? []).length === 0 ? (
            <EmptyNote>No incidents recorded for this monitor.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[
                { label: "Opened" },
                { label: "Closed" },
                { label: "Severity" },
                { label: "Cause" },
                { label: "Acknowledged" },
              ]}
              rows={(monitor.incidents ?? []).map((i) => [
                formatDateTime(i.openedAt),
                i.closedAt ? formatDateTime(i.closedAt) : "open",
                <StatusBadge key={`sv-${i.id}`} label={i.severity === "page" ? "critical" : "at risk"} />,
                i.cause ?? "—",
                i.acknowledgedAt
                  ? `${formatDateTime(i.acknowledgedAt)}${i.acknowledgedBy ? ` · ${i.acknowledgedBy}` : ""}`
                  : "—",
              ])}
            />
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Recent checks">
          {history.length === 0 ? (
            <EmptyNote>No check results yet.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[
                { label: "When" },
                { label: "Status" },
                { label: "Latency", align: "right" },
                { label: "Detail" },
              ]}
              rows={[...history]
                .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))
                .slice(0, 50)
                .map((r, i) => [
                  formatDateTime(r.checkedAt),
                  <StatusBadge key={`rs-${i}`} label={r.status} />,
                  r.latencyMs != null ? `${r.latencyMs}ms` : "—",
                  r.detail ?? "—",
                ])}
            />
          )}
        </Card>
      </div>
    </>
  );
}

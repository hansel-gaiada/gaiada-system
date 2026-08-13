import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  listMonitors,
  listIncidents,
  getSummary,
  sortForBoard,
  ageSeconds,
  formatAge,
  formatUptime,
  isStale,
  daysUntil,
  expiryLevel,
  type Monitor,
} from "@/lib/monitoring";
import { Card, KpiTile, HairlineTable, StatusBadge, statusColor } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
// Pinned locale + timeZone. A bare toLocaleString renders differently on server and client and
// trips React hydration error #418 — see platform-ui/CLAUDE.md's hydration-divergence trap.
import { formatDateTime } from "@/lib/format";

export const metadata = { title: "Monitoring" };

// The board is a live operational surface; never serve it from a static cache.
export const dynamic = "force-dynamic";

/**
 * Cert/domain expiry cell — the classic silent outage, so it earns a column on the board.
 * Inside 30 days the day count is coloured (attention family); beyond that it stays quiet text,
 * because a board where every row is highlighted highlights nothing.
 */
function ExpiryCell({ iso }: { iso: string | null | undefined }) {
  const days = daysUntil(iso);
  if (days === null) return <span style={{ opacity: 0.5 }}>—</span>;
  const level = expiryLevel(days);
  const text = days < 0 ? `expired ${Math.abs(days)}d ago` : `${days}d`;
  if (level === "none") return <span>{text}</span>;
  // Colour the DAY COUNT rather than swapping it for a StatusBadge. A badge reading "Critical"
  // tells an operator the tier but hides the number, and "5 days" vs "0 days" is the whole
  // decision — so the urgency is carried by colour and the figure stays on screen. `statusColor`
  // keys off the shared STATUS_FAMILY palette, so this stays consistent with every other surface.
  return <span style={{ color: statusColor(level === "critical" ? "critical" : "at risk") }}>{text}</span>;
}

export default async function MonitoringBoardPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  }

  const [monitors, incidents, summary] = await Promise.all([
    listMonitors(userId, tenant),
    listIncidents(userId, tenant, 15),
    getSummary(userId, tenant),
  ]);

  // `summary === null` means the backend module is absent — which is NOT the same as "everything is
  // fine". Gaia Nexus's dashboard always looked green; this surface must never be able to.
  const backendAbsent = summary === null && monitors.length === 0;
  const rows = sortForBoard(monitors);
  const now = Date.now();
  const staleCount = rows.filter((m) => isStale(m, now)).length;

  const counts = summary ?? {
    total: rows.length,
    up: rows.filter((m) => m.status === "up").length,
    down: rows.filter((m) => m.status === "down").length,
    degraded: rows.filter((m) => m.status === "degraded").length,
    maintenance: rows.filter((m) => m.status === "maintenance").length,
    unknown: rows.filter((m) => m.status === "unknown").length,
    openIncidents: incidents.length,
    lastSweepAt: null as string | null,
  };

  if (backendAbsent) {
    return (
      <>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Monitoring</h1>
        <p style={{ opacity: 0.7, marginBottom: 20, fontSize: 14 }}>
          Client property and service monitoring.
        </p>
        <EmptyNote>
          The monitoring backend is not connected yet. This is <strong>not</strong> an all-clear — no
          checks are running, so no incident would be detected. See{" "}
          <code>docs/blueprints/monitoring-program.md</code> (tickets MON-10 → MON-12).
        </EmptyNote>
      </>
    );
  }

  return (
    <>
      <div style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap", marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Monitoring</h1>
        <span style={{ display: "flex", gap: 12, fontSize: 13 }}>
          <Link href="/monitoring/new">+ New monitor</Link>
          <Link href="/monitoring/channels">Alert channels</Link>
        </span>
      </div>
      <p style={{ opacity: 0.7, marginBottom: 20, fontSize: 14 }}>
        Client property and service monitoring.{" "}
        {counts.lastSweepAt
          ? `Last sweep ${formatAge(ageSeconds(counts.lastSweepAt, now))}.`
          : "The runner has not reported a sweep yet."}
      </p>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          marginBottom: 20,
        }}
      >
        <KpiTile label="Monitors" value={String(counts.total)} foot={`${counts.unknown} unknown`} />
        <KpiTile label="Up" value={String(counts.up)} />
        <KpiTile label="Degraded" value={String(counts.degraded)} />
        <KpiTile label="Down" value={String(counts.down)} />
        <KpiTile
          label="Open incidents"
          value={String(counts.openIncidents)}
          foot={counts.maintenance ? `${counts.maintenance} in maintenance` : undefined}
        />
      </div>

      {/* Staleness is its own signal. A monitor whose last check is old is not evidence of health,
          and the board says so rather than leaving a reassuring tile in place. */}
      {staleCount > 0 && (
        <div style={{ marginBottom: 16 }}>
          <EmptyNote>
            {staleCount} monitor{staleCount === 1 ? "" : "s"} stale — last check is older than three
            intervals, so the status shown for {staleCount === 1 ? "it" : "them"} is not current.
          </EmptyNote>
        </div>
      )}

      <Card
        title="Monitors"
        hint="Sorted worst-first: down, degraded, unknown, maintenance, up. Maintenance ranks below real failures on purpose."
      >
        {rows.length === 0 ? (
          <EmptyNote>
            No monitors configured. Nothing is being checked — add a monitor to start coverage.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Monitor" },
              { label: "Client" },
              { label: "Kind" },
              { label: "Status" },
              { label: "Checked" },
              { label: "Uptime 24h", align: "right" },
              { label: "Cert", align: "right" },
              { label: "Domain", align: "right" },
            ]}
            rows={rows.map((m: Monitor) => {
              const stale = isStale(m, now);
              return [
                <Link key={`n-${m.id}`} href={`/monitoring/${m.id}`}>
                  {m.name}
                </Link>,
                m.clientName ?? "—",
                m.kind,
                <span key={`s-${m.id}`} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <StatusBadge label={m.status} />
                  {!m.enabled && <StatusBadge label="suspended" />}
                </span>,
                <span key={`c-${m.id}`} style={stale ? { opacity: 0.75, fontStyle: "italic" } : undefined}>
                  {formatAge(ageSeconds(m.lastCheckedAt, now))}
                  {stale ? " (stale)" : ""}
                </span>,
                formatUptime(m.uptime24h),
                <ExpiryCell key={`ce-${m.id}`} iso={m.certExpiresAt} />,
                <ExpiryCell key={`de-${m.id}`} iso={m.domainExpiresAt} />,
              ];
            })}
          />
        )}
      </Card>

      <div style={{ marginTop: 20 }}>
        <Card title="Open incidents">
          {incidents.length === 0 ? (
            <EmptyNote>No open incidents.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[
                { label: "Opened" },
                { label: "Monitor" },
                { label: "Client" },
                { label: "Severity" },
                { label: "Cause" },
                { label: "Acknowledged" },
              ]}
              rows={incidents.map((i) => [
                formatDateTime(i.openedAt),
                <Link key={`i-${i.id}`} href={`/monitoring/${i.monitorId}`}>
                  {i.monitorName ?? i.monitorId}
                </Link>,
                i.clientName ?? "—",
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
    </>
  );
}

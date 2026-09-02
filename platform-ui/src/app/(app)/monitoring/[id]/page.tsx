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
  RESULTS_WINDOWS,
  type MonitorResult,
  type ResultsWindow,
} from "@/lib/monitoring";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
// Pinned locale + timeZone. A bare toLocaleString renders differently on server and client and
// trips React hydration error #418 — see platform-ui/CLAUDE.md's hydration-divergence trap.
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ window?: string }>;

function parseWindow(raw: string | undefined): ResultsWindow {
  return RESULTS_WINDOWS.includes(raw as ResultsWindow) ? (raw as ResultsWindow) : "24h";
}

const WINDOW_LABEL: Record<ResultsWindow, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

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

export default async function MonitorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const win = parseWindow((await searchParams).window);
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  }

  // MON-20 — `getMonitor` and `listResults` are two independent reads on purpose: the detail 404'd
  // and crashed this whole page once already (that regression is the reason this comment exists),
  // and `listResults` is written so a 404 there NEVER throws — it comes back as `{available:false}`,
  // handled below, instead of taking the page down with it.
  const [monitor, windowed] = await Promise.all([
    getMonitor(userId, tenant, id),
    listResults(userId, tenant, id, win),
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

  // MON-20 — three distinct states, not two. `windowed.available` tells "clean" apart from "could
  // not ask" (the [id]/page.tsx:70 regression this file used to carry a comment about); the 24h
  // embedded fallback exists only so a monitor still shows SOMETHING useful while the dedicated
  // `/results` endpoint is still being built, and it is clearly labelled as a fallback rather than
  // silently passed off as the real windowed query.
  const usingEmbeddedFallback = !windowed.available && win === "24h";
  const history = usingEmbeddedFallback ? (monitor.results ?? []) : windowed.results;
  const historyUnavailable = !windowed.available && !usingEmbeddedFallback;

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

      <Card
        title={`History — last ${WINDOW_LABEL[win]}`}
        hint="One cell per check, oldest first. Hover a cell for the exact result."
        headerRight={
          <span style={{ display: "flex", gap: 10, fontSize: 12 }}>
            {RESULTS_WINDOWS.map((w) => (
              <Link
                key={w}
                href={`/monitoring/${id}?window=${w}`}
                style={w === win ? { fontWeight: 700 } : { opacity: 0.7 }}
                aria-current={w === win ? "true" : undefined}
              >
                {WINDOW_LABEL[w]}
              </Link>
            ))}
          </span>
        }
      >
        {historyUnavailable ? (
          <EmptyNote>
            The dedicated history endpoint isn&apos;t available for this window yet — that is not the
            same as &quot;no incidents&quot;, it means this page could not ask. See{" "}
            <code>docs/blueprints/monitoring-program.md</code>.
          </EmptyNote>
        ) : (
          <>
            {usingEmbeddedFallback && (
              <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
                Showing the last 24 hours embedded in the monitor record — the dedicated windowed
                history endpoint isn&apos;t connected yet, so 7d/30d aren&apos;t available.
              </p>
            )}
            <UptimeStrip results={history} />
          </>
        )}
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
          {historyUnavailable ? (
            <EmptyNote>
              Not available for this window yet — see the history card above.
            </EmptyNote>
          ) : history.length === 0 ? (
            <EmptyNote>No check results in this window.</EmptyNote>
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

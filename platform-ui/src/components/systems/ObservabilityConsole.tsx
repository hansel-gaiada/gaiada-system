"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import { ObservabilityHostTable } from "./ObservabilityHostTable";
import { ObservabilityDrilldown } from "./ObservabilityDrilldown";
import {
  ageSeconds,
  alarmRank,
  diskProjectionNote,
  formatAge,
  hostAlarmState,
  remoteWriteStalledActive,
  unattributedAlerts,
  type EstateAlert,
  type EstateSummary,
  type HostRow,
} from "@/lib/observability";
import "./observability.css";

// MSO-06 — client orchestrator: owns selection, the fleet summary strips, the estate-wide banners
// (RemoteWriteStalled / Prometheus down / expected-but-dark / unregistered), and the manual/auto
// refresh control. The server page fetches + maps rows; everything interactive lives here so the
// page itself can stay a plain server component (platform-ui/CLAUDE.md's module-trio convention).
export function ObservabilityConsole({
  rows,
  available,
  reason,
  grafanaHint,
  collectedAt,
  estate,
  alerts,
  alertsNote,
}: {
  rows: HostRow[];
  /** Covers ONLY the central Prometheus (contract §20.1a note 5) — NOT per-host reachability, which
   *  is `HostRow.freshness`. */
  available: boolean;
  reason: string | null;
  grafanaHint: string;
  collectedAt: string;
  /** null exactly when `available` is false — nothing host-shaped to summarize. */
  estate: EstateSummary | null;
  /** Alertmanager-sourced, fetched independently of `available` (note 9) — can be populated even
   *  when Prometheus itself is down. null = Alertmanager unreadable (see `alertsNote`). */
  alerts: EstateAlert[] | null;
  alertsNote: string | null;
}) {
  const router = useRouter();
  // Default selection is the MOST URGENT row by `alarmRank`, not just `rows[0]` (the backend's own
  // alphabetical-by-key order) — the table already opens sorted worst-first by default, and the
  // drilldown should focus attention on the same host on first paint rather than an arbitrary one.
  const [selectedId, setSelectedId] = useState<string | null>(
    () => [...rows].sort((a, b) => alarmRank(a) - alarmRank(b))[0]?.id ?? null,
  );
  const [autoRefresh, setAutoRefresh] = useState(false);
  // Re-render tick so a host's "as of Xm ago" freshness age keeps advancing even if the operator
  // never touches the page. It only moves the displayed clock, never the classification
  // (fresh/stale/dark/never) itself — that is the server's call, refreshed for real by
  // router.refresh() or the auto-refresh toggle below.
  //
  // SSR-safe on purpose: seeding this from `Date.now()` made the server render (at request time)
  // and the client's hydration pass (a moment later, wall-clock) compute two DIFFERENT elapsed-age
  // strings for the same host — a real hydration mismatch this ticket's own live-browser drive
  // caught (React regenerated the tree and logged a warning). Seeding from `collectedAt` instead is
  // deterministic between server and client (both parse the same prop), so the very first render
  // always reads "0s elapsed since the snapshot" — which is also the semantically correct answer
  // before the client clock has had a chance to run. The effect below then corrects to the real
  // wall clock and starts ticking, safely AFTER hydration has already reconciled.
  const [now, setNow] = useState(() => Date.parse(collectedAt));
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [collectedAt]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, router]);

  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;

  const stalled = remoteWriteStalledActive(alerts);
  const estateAlertsUnattributed = useMemo(() => unattributedAlerts(alerts), [alerts]);

  const grouping = useMemo(() => {
    const stoppedReporting = rows.filter((r) => hostAlarmState(r) === "stopped-reporting");
    const expectedPending = rows.filter((r) => hostAlarmState(r) === "expected-pending");
    const unregistered = rows.filter((r) => !r.registered);
    const envDrift = rows.filter((r) => r.envDrift);
    const unhappy = rows.filter((r) => r.tier === "critical" || r.tier === "warn");
    const trendingDown = rows.filter((r) => (r.host ? diskProjectionNote(r.host.diskFreeGb, r.host.diskFreeGb24h) : null) !== null);
    const containersNote = rows.find((r) => r.containersRunning.value === null && r.containersRunning.note)?.containersRunning.note ?? null;
    const envCounts = new Map<string, number>();
    for (const r of rows) {
      const key = r.registered ? (r.env ?? "—") : "unregistered";
      envCounts.set(key, (envCounts.get(key) ?? 0) + 1);
    }
    return { stoppedReporting, expectedPending, unregistered, envDrift, unhappy, trendingDown, containersNote, envCounts };
  }, [rows]);

  return (
    <>
      {/* ── Estate-level banners, most dangerous first. RemoteWriteStalled and "Prometheus down" can
          BOTH be true at once (Alertmanager is fetched independently — note 9), so they stack rather
          than branch. */}
      {stalled && (
        <div className="obs-banner obs-banner--critical" role="alert">
          <strong>RemoteWriteStalled is firing.</strong> The estate&apos;s telemetry feed is unstable
          — every reading below is UNKNOWN, not healthy, until this clears. Do not read a calm host
          as reassurance while this banner is up.
        </div>
      )}
      {!available && (
        <div className="obs-banner obs-banner--critical" role="alert">
          <strong>Central Prometheus unreachable.</strong> {reason ?? "No reason given."} No hosts
          can be listed. Full dashboards: <code>{grafanaHint}</code>.
        </div>
      )}

      {grouping.stoppedReporting.length > 0 && (
        <div className="obs-banner obs-banner--critical" role="alert">
          <strong>
            {grouping.stoppedReporting.length} expected host{grouping.stoppedReporting.length === 1 ? "" : "s"} stopped reporting:
          </strong>{" "}
          {grouping.stoppedReporting.map((r) => `${r.label} (${formatAge(r.freshness.lastSampleAgeSeconds)})`).join(", ")}.
          These are provisioned, active hosts with no recent sample — the inventory is what makes
          this visible; a live-series-only view would have silently dropped them.
        </div>
      )}

      {grouping.unregistered.length > 0 && (
        <div className="obs-banner obs-banner--warn" role="alert">
          <strong>
            {grouping.unregistered.length} unregistered host{grouping.unregistered.length === 1 ? "" : "s"} sending data:
          </strong>{" "}
          {grouping.unregistered.map((r) => r.label).join(", ")}. Series exist with no matching{" "}
          <code>infra_hosts</code> row — drift in the other direction from a dark host.
        </div>
      )}

      {grouping.unhappy.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <EmptyNote>
            {grouping.unhappy.length} of {rows.length} host{rows.length === 1 ? "" : "s"} need attention:{" "}
            {grouping.unhappy.map((r) => r.label).join(", ")}. See the table below — sorted
            worst-first by default.
          </EmptyNote>
        </div>
      )}

      {grouping.envDrift.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <EmptyNote>
            {grouping.envDrift.length} host{grouping.envDrift.length === 1 ? "" : "s"} report an{" "}
            <code>env</code> label that disagrees with the inventory: {grouping.envDrift.map((r) => r.label).join(", ")}.
            The inventory is authoritative; check the collector config on those boxes.
          </EmptyNote>
        </div>
      )}

      {grouping.expectedPending.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <EmptyNote>
            {grouping.expectedPending.length} host{grouping.expectedPending.length === 1 ? "" : "s"} onboarding, not yet reporting:{" "}
            {grouping.expectedPending.map((r) => r.label).join(", ")}. Expected-pending, not an
            incident — distinct from a host that stopped reporting.
          </EmptyNote>
        </div>
      )}

      {available && estate && (
        <>
          {/* Freshness FIRST — the lead signal, kept as its own axis from health below. */}
          <div className="obs-fleet obs-fleet--freshness">
            <KpiTile label="Fresh" value={estate.hosts.fresh} hint="Last sample within 90s." />
            <KpiTile label="Stale" value={estate.hosts.stale} hint="Last sample within 10 minutes but past 90s — looks calm, is aging." />
            <KpiTile label="Dark" value={estate.hosts.dark} hint="No sample in over 10 minutes — the same boundary the RemoteWriteStalled alert uses." />
            <KpiTile label="Never reported" value={estate.hosts.never} hint="No sample in the 48h lookback. Includes onboarding hosts waiting for their first sample." />
          </div>

          <div className="obs-fleet">
            <KpiTile label="Hosts" value={rows.length} />
            <KpiTile
              label="Critical"
              value={rows.filter((r) => r.tier === "critical").length}
              hint="Down datastore, down scrape target, a page-severity active alert, or a resource past its alert threshold."
            />
            <KpiTile label="At risk" value={rows.filter((r) => r.tier === "warn").length} hint="A resource is climbing but nothing has crossed an alert threshold yet." />
            <KpiTile
              label="Alerts active"
              value={estate.alertsActive === null ? "—" : estate.alertsActive}
              hint={estate.alertsActive === null ? (alertsNote ?? "Alertmanager unreadable — never rendered as 0.") : "From Alertmanager, independent of Prometheus."}
            />
            <KpiTile
              label="Alerts suppressed"
              value={estate.alertsSuppressed === null ? "—" : estate.alertsSuppressed}
              hint={estate.alertsSuppressed === null ? (alertsNote ?? "Alertmanager unreadable — never rendered as 0.") : "Silenced or inhibited — still tracked, not hidden."}
            />
            <KpiTile
              label="Environments"
              value={[...grouping.envCounts.keys()].filter((k) => k !== "unregistered").length}
              foot={[...grouping.envCounts.entries()].map(([k, n]) => `${k} ${n}`).join(" · ")}
              hint="Real env labels from the infra_hosts inventory, grouped and filterable in the table below."
            />
            <KpiTile label="Trending down (disk)" value={grouping.trendingDown.length} hint="Live hosts whose 24h linear disk projection is below today's free space." />
          </div>
        </>
      )}

      {!available && alerts !== null && (
        <div className="obs-fleet">
          <KpiTile label="Alerts active" value={alerts.filter((a) => a.state === "active").length} hint="Alertmanager answered independently of Prometheus (note 9) — still trustworthy while hosts cannot be listed." />
          <KpiTile label="Alerts suppressed" value={alerts.filter((a) => a.state === "suppressed").length} />
        </div>
      )}

      {grouping.containersNote && (
        <p className="obs-limitation-inline">
          <span className="obs-dot obs-dot--unknown" aria-hidden="true" /> Per-container metrics: unavailable estate-wide — {grouping.containersNote}
        </p>
      )}

      {available && (
        <div className="obs-refresh" style={{ marginBottom: 16 }}>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => router.refresh()}>
            Refresh now
          </button>
          <label className="obs-refresh__label">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh every 30s
          </label>
          <span className="obs-refresh__stamp">Snapshot generated {formatAge(ageSeconds(collectedAt, now))}</span>
        </div>
      )}

      {available && (
        <>
          <ObservabilityHostTable rows={rows} selectedId={selected?.id ?? null} onSelect={setSelectedId} collectedAt={collectedAt} now={now} />

          <div style={{ marginTop: 20 }}>
            <Card title={selected ? `${selected.label} — details` : "Details"}>
              {selected ? (
                <ObservabilityDrilldown row={selected} collectedAt={collectedAt} now={now} grafanaHint={grafanaHint} />
              ) : (
                <EmptyNote>No host to show.</EmptyNote>
              )}
            </Card>
          </div>
        </>
      )}

      {estateAlertsUnattributed.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <Card title="Estate-level alerts" hint="Not attributable to one host — app-level firing/suppressed alerts.">
            <ul className="obs-alert-list">
              {estateAlertsUnattributed.map((a, i) => (
                <li key={i} className={`obs-alert-list__item obs-alert-list__item--${a.state}`}>
                  <span className="obs-alert-list__name">{a.name}</span>
                  <span className="obs-alert-list__meta">{a.severity} · {a.state}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import { ObservabilityHostTable } from "./ObservabilityHostTable";
import { ObservabilityDrilldown } from "./ObservabilityDrilldown";
import { ageSeconds, diskProjectionNote, freshnessTier, type HostRow } from "@/lib/observability";
import "./observability.css";

// MON-10 — client orchestrator: owns selection, the fleet summary strip, the "anything genuinely
// wrong reads above the fold" banner, and the manual/auto refresh control. The server page fetches
// and maps rows; everything interactive lives here so the page itself can stay a plain server
// component (the repo's convention — see platform-ui/CLAUDE.md's module-trio section).
export function ObservabilityConsole({ rows }: { rows: HostRow[] }) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(rows[0]?.id ?? null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  // Re-render tick so "aging"/"stale" freshness advances even if the operator never touches the
  // page — the whole point of a console meant to stay open all day. Ten seconds is frequent enough
  // to feel live without hammering a re-render; it only moves the clock, not the data (that still
  // needs router.refresh() or the auto-refresh toggle below).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  // Opt-in auto-refresh (off by default — a page that silently rewrites itself while someone is
  // mid-read is its own hazard). Uses router.refresh() so the server component re-fetches the real
  // endpoint; no client-side polling fetch and no new dependency.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, router]);

  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;

  const summary = useMemo(() => {
    const c = { ok: 0, warn: 0, critical: 0, unknown: 0 };
    let stale = 0;
    let trendingDown = 0;
    for (const r of rows) {
      c[r.tier]++;
      if (freshnessTier(ageSeconds(r.collectedAt, now)) === "stale") stale++;
      const note = r.host ? diskProjectionNote(r.host.diskFreeGb, r.host.diskFreeGb24h) : null;
      if (note) trendingDown++;
    }
    const environments = new Set(rows.map((r) => r.environment).filter((e): e is string => e !== null));
    const untagged = rows.some((r) => r.environment === null);
    const envLabel = environments.size === 0 ? "untagged" : untagged ? `${environments.size} + untagged` : String(environments.size);
    return { ...c, stale, trendingDown, envCount: environments.size, untagged, envLabel };
  }, [rows, now]);

  const unhappy = rows.filter((r) => r.tier === "critical" || r.tier === "warn");

  return (
    <>
      {/* Anything genuinely wrong is stated ABOVE the summary tiles — a reader who stops at the
          first screenful must not come away thinking everything is fine. */}
      {unhappy.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <EmptyNote>
            {unhappy.length} of {rows.length} host{rows.length === 1 ? "" : "s"} need attention:{" "}
            {unhappy.map((r) => r.label).join(", ")}. See the table below — sorted worst-first by
            default.
          </EmptyNote>
        </div>
      )}
      {summary.stale > 0 && (
        <div style={{ marginBottom: 12 }}>
          <EmptyNote>
            {summary.stale} host{summary.stale === 1 ? "" : "s"} reporting stale data (15+ minutes
            old). A host that looks calm on stale data is the dangerous case, not the reassuring one.
          </EmptyNote>
        </div>
      )}

      <div className="obs-fleet">
        <KpiTile label="Hosts" value={rows.length} />
        <KpiTile
          label="Critical"
          value={summary.critical}
          hint="Down datastore, down scrape target, a page-severity alert, or a resource past its alert threshold."
        />
        <KpiTile label="At risk" value={summary.warn} hint="A resource is climbing but nothing has crossed an alert threshold yet." />
        <KpiTile
          label="Not measured"
          value={summary.unknown}
          hint="available:false, or available:true with nothing this snapshot actually reads a value for. Never counted as healthy."
        />
        <KpiTile label="Trending down (disk)" value={summary.trendingDown} hint="Hosts whose 24h linear disk projection is below today's free space." />
        <KpiTile
          label="Environments"
          value={summary.envLabel}
          hint="Environment tagging is not sent by the backend yet — see the 'not tagged' badge in the table. This tile will read real environment counts once that contract lands."
        />
      </div>

      <div className="obs-refresh" style={{ marginBottom: 16 }}>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => router.refresh()}>
          Refresh now
        </button>
        <label className="obs-refresh__label">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          Auto-refresh every 30s
        </label>
      </div>

      <ObservabilityHostTable rows={rows} selectedId={selected?.id ?? null} onSelect={setSelectedId} now={now} />

      <div style={{ marginTop: 20 }}>
        <Card title={selected ? `${selected.label} — details` : "Details"}>
          {selected ? <ObservabilityDrilldown row={selected} now={now} /> : <EmptyNote>No host to show.</EmptyNote>}
        </Card>
      </div>
    </>
  );
}

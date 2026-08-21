"use client";
import { useMemo, useState } from "react";
import { Eyebrow } from "@/components/ui";
import {
  ageSeconds,
  fmt,
  formatAge,
  freshnessTier,
  tierRank,
  utilLevel,
  type Freshness,
  type HostRow,
  type Tier,
} from "@/lib/observability";
import "./observability.css";

// MON-10 — the dense, sortable, filterable host table. Built to answer an on-call engineer's actual
// first question ("which host is unhappy, since when, is it getting worse") without scrolling past
// ~20 rows, and to scale from today's ONE real host to N without touching this file: it operates
// entirely on `HostRow[]` (lib/observability.ts), which is deliberately shaped for a future
// multi-host endpoint to fill in directly.
//
// A bespoke <table> rather than the shared `DataTable`/`SearchableTable`: those take plain-string
// cells (or a `format` enum), and this table needs a genuine 4-tier status dot plus tier-coloured
// figures in nearly every column — richer than "text | status | date | number" supports. It reuses
// the same interaction shape (sortable header buttons, live count, hairline visual language) rather
// than inventing a new one; see observability.css's header comment.

type SortKey = "tier" | "label" | "environment" | "cpu" | "mem" | "disk" | "load" | "uptime" | "targets" | "datastores" | "alerts" | "freshness";

const TIER_LABEL: Record<Tier, string> = { ok: "Healthy", warn: "At risk", critical: "Critical", unknown: "Not measured" };
const FRESH_LABEL: Record<Freshness, string> = { fresh: "fresh", aging: "aging", stale: "stale" };

function TierDot({ tier }: { tier: Tier }) {
  return <span className={`obs-dot obs-dot--${tier}`} aria-hidden="true" />;
}

/** Status cell: dot + text label together — colour is never the only carrier of the state. */
function TierCell({ tier }: { tier: Tier }) {
  return (
    <span className={`obs-tier obs-tier--${tier}`}>
      <TierDot tier={tier} />
      {TIER_LABEL[tier]}
    </span>
  );
}

/** A percentage metric cell: figure + its own tier dot (a host can be `ok` overall while one
 *  resource is climbing — the per-metric dot lets that show without opening the drilldown). */
function MetricCell({ r, suffix }: { r: { value: number | null; note?: string | null }; suffix: string }) {
  const level = utilLevel(r.value);
  if (r.value === null) {
    return (
      <span className="obs-metric obs-metric--dim" title={r.note ?? "asked, got nothing"}>
        not measured
      </span>
    );
  }
  return (
    <span className="obs-metric" title={r.note ?? undefined}>
      <TierDot tier={level} />
      {fmt(r, suffix)}
    </span>
  );
}

function EnvBadge({ environment }: { environment: string | null }) {
  if (environment === null) {
    return (
      <span className="obs-env obs-env--unset" title="Not sent by the backend yet — the multi-host/environment contract is unbuilt (see docs/FRONTEND-BFF-CONTRACT.md §20.1)">
        not tagged
      </span>
    );
  }
  return <span className="obs-env">{environment}</span>;
}

function numOrNull(r: { value: number | null } | undefined): number | null {
  return r?.value ?? null;
}

/** Missing values always sort to the end, in EITHER direction — a null CPU reading is not "the
 *  smallest CPU reading", it is not a CPU reading at all, and burying it mid-list either direction
 *  would misrepresent it as a real measured extreme. */
function numCompare(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dir;
}

export function ObservabilityHostTable({
  rows,
  selectedId,
  onSelect,
  now,
}: {
  rows: HostRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Injected so ages are stable across a render pass and testable — see the console's useEffect ticker. */
  now: number;
}) {
  const [query, setQuery] = useState("");
  const [envFilter, setEnvFilter] = useState<string>("__all__");
  const [tierFilter, setTierFilter] = useState<Tier | "__all__">("__all__");
  const [sortKey, setSortKey] = useState<SortKey>("tier");
  const [dir, setDir] = useState<1 | -1>(1);

  const environments = useMemo(() => {
    const set = new Set<string>();
    let hasUnset = false;
    for (const r of rows) (r.environment === null ? (hasUnset = true) : set.add(r.environment));
    return { known: [...set].sort(), hasUnset };
  }, [rows]);

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { ok: 0, warn: 0, critical: 0, unknown: 0 };
    for (const r of rows) c[r.tier]++;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (tierFilter !== "__all__" && r.tier !== tierFilter) return false;
      if (envFilter === "__unset__" && r.environment !== null) return false;
      else if (envFilter !== "__all__" && envFilter !== "__unset__" && r.environment !== envFilter) return false;
      if (!needle) return true;
      const haystack = [
        r.label,
        r.environment ?? "",
        ...(r.targets?.downJobs ?? []),
        ...(r.alerts ?? []).map((a) => a.name),
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, query, envFilter, tierFilter]);

  const sorted = useMemo(() => {
    const accessor = (r: HostRow): number | string => {
      switch (sortKey) {
        case "tier": return tierRank(r.tier);
        case "label": return r.label.toLowerCase();
        case "environment": return (r.environment ?? "￿").toLowerCase(); // unset sorts last ascending
        case "cpu": return numOrNull(r.host?.cpuBusyPct) ?? Number.NaN;
        case "mem": return numOrNull(r.host?.memUsedPct) ?? Number.NaN;
        case "disk": return numOrNull(r.host?.diskUsedPct) ?? Number.NaN;
        case "load": return numOrNull(r.host?.load1) ?? Number.NaN;
        case "uptime": return numOrNull(r.host?.uptimeDays) ?? Number.NaN;
        case "targets": return r.targets?.down ?? -1;
        case "datastores": {
          const down = (r.datastores?.postgres ?? []).filter((d) => !d.up).length + (r.datastores?.redis ?? []).filter((d) => !d.up).length;
          return down;
        }
        case "alerts": return r.alerts?.length ?? -1;
        case "freshness": return ageSeconds(r.collectedAt, now);
        default: return 0;
      }
    };
    const withKey = filtered.map((r) => ({ r, k: accessor(r) }));
    withKey.sort((a, b) => {
      if (typeof a.k === "string" || typeof b.k === "string") {
        return String(a.k).localeCompare(String(b.k)) * dir;
      }
      return numCompare(Number.isNaN(a.k) ? null : a.k, Number.isNaN(b.k) ? null : b.k, dir);
    });
    return withKey.map((x) => x.r);
  }, [filtered, sortKey, dir, now]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setDir(1); }
  };

  const Header = ({ label, sortKeyFor, align }: { label: string; sortKeyFor: SortKey; align?: "right" }) => (
    <th className={align === "right" ? "obs-table--right" : undefined} scope="col">
      <button type="button" className="obs-sort" onClick={() => toggleSort(sortKeyFor)}>
        {label}
        <span className="obs-sort__arrow">{sortKey === sortKeyFor ? (dir === 1 ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );

  return (
    <div>
      <div className="obs-toolbar">
        <label className="obs-toolbar__search">
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Filter hosts</Eyebrow>
          <input
            type="search"
            aria-label="Filter hosts by name, environment, down job or alert"
            placeholder="Search hosts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <label className="obs-toolbar__field">
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Environment</Eyebrow>
          <select aria-label="Filter by environment" value={envFilter} onChange={(e) => setEnvFilter(e.target.value)}>
            <option value="__all__">All environments</option>
            {environments.known.map((e) => <option key={e} value={e}>{e}</option>)}
            {environments.hasUnset && <option value="__unset__">Not tagged</option>}
          </select>
        </label>

        <div className="obs-chips" role="group" aria-label="Filter by health tier">
          {(["__all__", "critical", "warn", "unknown", "ok"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`obs-chip${tierFilter === t ? " obs-chip--active" : ""}`}
              aria-pressed={tierFilter === t}
              onClick={() => setTierFilter(t)}
            >
              {t !== "__all__" && <span className={`obs-chip__dot obs-dot--${t}`} />}
              {t === "__all__" ? "All" : TIER_LABEL[t]}
              {t !== "__all__" ? ` (${tierCounts[t]})` : ` (${rows.length})`}
            </button>
          ))}
        </div>

        <span className="obs-count">
          {sorted.length} of {rows.length} host{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="obs-table-wrap">
        <table className="obs-table">
          <thead>
            <tr>
              <Header label="Status" sortKeyFor="tier" />
              <Header label="Host" sortKeyFor="label" />
              <Header label="Environment" sortKeyFor="environment" />
              <Header label="CPU" sortKeyFor="cpu" align="right" />
              <Header label="Mem" sortKeyFor="mem" align="right" />
              <Header label="Disk" sortKeyFor="disk" align="right" />
              <Header label="Load 1m" sortKeyFor="load" align="right" />
              <Header label="Uptime" sortKeyFor="uptime" align="right" />
              <Header label="Targets" sortKeyFor="targets" align="right" />
              <Header label="Datastores" sortKeyFor="datastores" align="right" />
              <Header label="Alerts" sortKeyFor="alerts" align="right" />
              <Header label="Freshness" sortKeyFor="freshness" align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td className="obs-empty-row" colSpan={12}>No hosts match this filter.</td></tr>
            ) : sorted.map((r) => {
              const age = ageSeconds(r.collectedAt, now);
              const fresh = freshnessTier(age);
              const dsDown = (r.datastores?.postgres ?? []).filter((d) => !d.up).length + (r.datastores?.redis ?? []).filter((d) => !d.up).length;
              const dsTotal = (r.datastores?.postgres.length ?? 0) + (r.datastores?.redis.length ?? 0);
              const alertCount = r.alerts?.length ?? 0;
              return (
                <tr
                  key={r.id}
                  className={r.id === selectedId ? "obs-row--selected" : undefined}
                  onClick={() => onSelect(r.id)}
                  tabIndex={0}
                  // Deliberately NOT role="button" — that would override the native "row" role and
                  // sever the row/cell association a screen reader needs to read this as a table
                  // (announcing each cell against its column header). `aria-label` is a global ARIA
                  // attribute and is honoured on an implicit "row" role, so the row still gets one
                  // accessible name for its activation semantics without losing table structure.
                  aria-label={`${r.label}, ${TIER_LABEL[r.tier]}${r.id === selectedId ? ", selected" : ""}. Activate to view details.`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(r.id); }
                  }}
                >
                  <td><TierCell tier={r.tier} /></td>
                  <td style={{ color: "var(--text-primary)", fontWeight: 700 }}>{r.label}</td>
                  <td><EnvBadge environment={r.environment} /></td>
                  <td className="obs-table--right">{r.host ? <MetricCell r={r.host.cpuBusyPct} suffix="%" /> : "—"}</td>
                  <td className="obs-table--right">{r.host ? <MetricCell r={r.host.memUsedPct} suffix="%" /> : "—"}</td>
                  <td className="obs-table--right">{r.host ? <MetricCell r={r.host.diskUsedPct} suffix="%" /> : "—"}</td>
                  <td className="obs-table--right">{r.host ? fmt(r.host.load1) : "—"}</td>
                  <td className="obs-table--right">{r.host ? fmt(r.host.uptimeDays, "d") : "—"}</td>
                  <td className="obs-table--right">
                    {r.targets ? (
                      <span style={{ color: r.targets.down > 0 ? "var(--status-critical-fg)" : "var(--ink-muted)", fontWeight: r.targets.down > 0 ? 700 : 400 }}>
                        {r.targets.up}/{r.targets.up + r.targets.down}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="obs-table--right">
                    {dsTotal === 0 ? (
                      <span className="obs-metric--dim">not measured</span>
                    ) : (
                      <span style={{ color: dsDown > 0 ? "var(--status-critical-fg)" : "var(--ink-muted)", fontWeight: dsDown > 0 ? 700 : 400 }}>
                        {dsTotal - dsDown}/{dsTotal}
                      </span>
                    )}
                  </td>
                  <td className="obs-table--right">
                    <span style={{ color: alertCount > 0 ? "var(--status-warning-fg)" : "var(--ink-muted)", fontWeight: alertCount > 0 ? 700 : 400 }}>
                      {alertCount}
                    </span>
                  </td>
                  <td className="obs-table--right">
                    <span className={`obs-fresh obs-fresh--${fresh}`} title={`Snapshot generated ${formatAge(age)} (${FRESH_LABEL[fresh]})`}>
                      {formatAge(age)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

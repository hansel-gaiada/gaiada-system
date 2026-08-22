"use client";
import { useMemo, useState } from "react";
import { Eyebrow } from "@/components/ui";
import {
  alarmRank,
  fmt,
  formatAge,
  liveSampleAgeSeconds,
  utilLevel,
  FRESHNESS_LABEL,
  hostAlarmState,
  type HostAlarmState,
  type HostFreshnessState,
  type HostRow,
  type Tier,
} from "@/lib/observability";
import "./observability.css";

// MON-10 / MSO-06 — the dense, sortable, filterable host table. Built to answer an on-call
// engineer's actual first question ("which host is unhappy, since when, is it getting worse")
// without scrolling past ~20 rows. Now driven by the real estate endpoint (§20.1a): every row is a
// real host from `infra_hosts` merged with live series, so the table has to carry TWO axes that
// must never collapse into one — health (`tier`) and freshness (`HostRow.freshness`) — plus a third,
// row-level alarm state (`hostAlarmState`) that is what actually decides whether a host reads as
// "the dangerous kind of fine".
//
// A bespoke <table> rather than the shared `DataTable`/`SearchableTable`: those take plain-string
// cells (or a `format` enum), and this table needs a genuine 4-tier status dot plus tier-coloured
// figures in nearly every column — richer than "text | status | date | number" supports.

type SortKey = "alarm" | "label" | "environment" | "freshness" | "cpu" | "mem" | "disk" | "load" | "uptime" | "targets" | "datastores" | "alerts";

const TIER_LABEL: Record<Tier, string> = { ok: "Healthy", warn: "At risk", critical: "Critical", unknown: "Not measured" };
const ALARM_LABEL: Record<HostAlarmState, string> = {
  reporting: "Reporting",
  "expected-pending": "Onboarding",
  "stopped-reporting": "Stopped reporting",
  "decommissioned-muted": "Decommissioned",
  unregistered: "Unregistered",
};
const FRESH_DOT: Record<HostFreshnessState, string> = { fresh: "ok", stale: "warn", dark: "critical", never: "unknown" };

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

/** Environment + registry cell. `registered:false` is visibly abnormal regardless of env; an
 *  `envDrift` host still shows its real (inventory) env plus a drift flag — the inventory is
 *  authoritative, per contract §20.1a. */
function EnvCell({ row }: { row: HostRow }) {
  if (!row.registered) {
    return (
      <span className="obs-env obs-env--unregistered" title="Series arriving with no infra_hosts row">
        unregistered
      </span>
    );
  }
  return (
    <span className="obs-env-wrap">
      <span className="obs-env">{row.env}</span>
      {row.envDrift && (
        <span className="obs-env-drift" title="This host's series report a different env label than the inventory">
          drift
        </span>
      )}
    </span>
  );
}

/** Freshness cell — the LEAD signal (contract §20.1a note 1), a separate axis from `tier`. `dark`
 *  and `never` render bold and impossible to mistake for calm; `stale` is bold amber precisely
 *  because it is the state that otherwise looks fine. */
function FreshnessCell({ row, collectedAt, now }: { row: HostRow; collectedAt: string; now: number }) {
  const age = liveSampleAgeSeconds(row.freshness, collectedAt, now);
  const state = row.freshness.state;
  return (
    <span className={`obs-fresh obs-fresh--${state}`} title={`${FRESHNESS_LABEL[state]} — ${formatAge(age)}`}>
      <TierDot tier={FRESH_DOT[state] as Tier} /> {FRESHNESS_LABEL[state]} · {formatAge(age)}
    </span>
  );
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
  collectedAt,
  now,
}: {
  rows: HostRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  collectedAt: string;
  /** Injected so ages are stable across a render pass and testable — see the console's useEffect ticker. */
  now: number;
}) {
  const [query, setQuery] = useState("");
  const [envFilter, setEnvFilter] = useState<string>("__all__");
  const [tierFilter, setTierFilter] = useState<Tier | "__all__">("__all__");
  const [freshnessFilter, setFreshnessFilter] = useState<HostFreshnessState | "__all__">("__all__");
  const [sortKey, setSortKey] = useState<SortKey>("alarm");
  const [dir, setDir] = useState<1 | -1>(1);

  const environments = useMemo(() => {
    const set = new Set<string>();
    let hasUnregistered = false;
    for (const r of rows) (r.registered && r.env ? set.add(r.env) : (hasUnregistered = true));
    return { known: [...set].sort(), hasUnregistered };
  }, [rows]);

  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { ok: 0, warn: 0, critical: 0, unknown: 0 };
    for (const r of rows) c[r.tier]++;
    return c;
  }, [rows]);

  const freshnessCounts = useMemo(() => {
    const c: Record<HostFreshnessState, number> = { fresh: 0, stale: 0, dark: 0, never: 0 };
    for (const r of rows) c[r.freshness.state]++;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (tierFilter !== "__all__" && r.tier !== tierFilter) return false;
      if (freshnessFilter !== "__all__" && r.freshness.state !== freshnessFilter) return false;
      if (envFilter === "__unregistered__" && r.registered) return false;
      else if (envFilter !== "__all__" && envFilter !== "__unregistered__" && r.env !== envFilter) return false;
      if (!needle) return true;
      const haystack = [
        r.label,
        r.env ?? "",
        r.role ?? "",
        ...(r.targets?.downJobs ?? []),
        ...r.alerts.map((a) => a.name),
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, query, envFilter, tierFilter, freshnessFilter]);

  const sorted = useMemo(() => {
    const accessor = (r: HostRow): number | string => {
      switch (sortKey) {
        case "alarm": return alarmRank(r);
        case "label": return r.label.toLowerCase();
        case "environment": return (r.registered ? r.env ?? "" : "￿").toLowerCase(); // unregistered sorts last ascending
        case "freshness": return liveSampleAgeSeconds(r.freshness, collectedAt, now) ?? Number.MAX_SAFE_INTEGER;
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
        case "alerts": return r.alerts.length;
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
  }, [filtered, sortKey, dir, collectedAt, now]);

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
            aria-label="Filter hosts by name, environment, role, down job or alert"
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
            {environments.hasUnregistered && <option value="__unregistered__">Unregistered</option>}
          </select>
        </label>

        <div className="obs-chips" role="group" aria-label="Filter by freshness">
          {(["__all__", "dark", "never", "stale", "fresh"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`obs-chip${freshnessFilter === f ? " obs-chip--active" : ""}`}
              aria-pressed={freshnessFilter === f}
              onClick={() => setFreshnessFilter(f)}
            >
              {f !== "__all__" && <span className={`obs-chip__dot obs-dot--${FRESH_DOT[f]}`} />}
              {f === "__all__" ? "All freshness" : FRESHNESS_LABEL[f]}
              {f !== "__all__" ? ` (${freshnessCounts[f]})` : ""}
            </button>
          ))}
        </div>

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
              {t === "__all__" ? "All health" : TIER_LABEL[t]}
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
              <Header label="Status" sortKeyFor="alarm" />
              <Header label="Host" sortKeyFor="label" />
              <Header label="Freshness" sortKeyFor="freshness" />
              <Header label="Environment" sortKeyFor="environment" />
              <Header label="CPU" sortKeyFor="cpu" align="right" />
              <Header label="Mem" sortKeyFor="mem" align="right" />
              <Header label="Disk" sortKeyFor="disk" align="right" />
              <Header label="Load 1m" sortKeyFor="load" align="right" />
              <Header label="Uptime" sortKeyFor="uptime" align="right" />
              <Header label="Targets" sortKeyFor="targets" align="right" />
              <Header label="Datastores" sortKeyFor="datastores" align="right" />
              <Header label="Alerts" sortKeyFor="alerts" align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td className="obs-empty-row" colSpan={12}>No hosts match this filter.</td></tr>
            ) : sorted.map((r) => {
              const alarm = hostAlarmState(r);
              const dsDown = (r.datastores?.postgres ?? []).filter((d) => !d.up).length + (r.datastores?.redis ?? []).filter((d) => !d.up).length;
              const dsTotal = (r.datastores?.postgres.length ?? 0) + (r.datastores?.redis.length ?? 0);
              const alertCount = r.alerts.length;
              return (
                <tr
                  key={r.id}
                  className={[
                    r.id === selectedId ? "obs-row--selected" : "",
                    alarm === "stopped-reporting" ? "obs-row--stopped" : "",
                    alarm === "unregistered" ? "obs-row--unregistered" : "",
                    alarm === "decommissioned-muted" ? "obs-row--muted" : "",
                  ].filter(Boolean).join(" ") || undefined}
                  onClick={() => onSelect(r.id)}
                  tabIndex={0}
                  // Deliberately NOT role="button" — that would override the native "row" role and
                  // sever the row/cell association a screen reader needs to read this as a table
                  // (announcing each cell against its column header). `aria-label` is a global ARIA
                  // attribute and is honoured on an implicit "row" role, so the row still gets one
                  // accessible name for its activation semantics without losing table structure.
                  aria-label={`${r.label}, ${ALARM_LABEL[alarm]}, ${TIER_LABEL[r.tier]}${r.id === selectedId ? ", selected" : ""}. Activate to view details.`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(r.id); }
                  }}
                >
                  <td>
                    <TierCell tier={r.tier} />
                    {alarm !== "reporting" && (
                      <span className={`obs-alarm-badge obs-alarm-badge--${alarm}`}>{ALARM_LABEL[alarm]}</span>
                    )}
                  </td>
                  <td style={{ color: "var(--text-primary)", fontWeight: 700 }}>
                    {r.label}
                    {r.role && <span className="obs-role">{r.role}</span>}
                  </td>
                  <td><FreshnessCell row={r} collectedAt={collectedAt} now={now} /></td>
                  <td><EnvCell row={r} /></td>
                  <td className="obs-table--right">{r.host ? <MetricCell r={r.host.cpuBusyPct} suffix="%" /> : <span className="obs-metric--dim">—</span>}</td>
                  <td className="obs-table--right">{r.host ? <MetricCell r={r.host.memUsedPct} suffix="%" /> : <span className="obs-metric--dim">—</span>}</td>
                  <td className="obs-table--right">{r.host ? <MetricCell r={r.host.diskUsedPct} suffix="%" /> : <span className="obs-metric--dim">—</span>}</td>
                  <td className="obs-table--right">{r.host ? fmt(r.host.load1) : <span className="obs-metric--dim">—</span>}</td>
                  <td className="obs-table--right">{r.host ? fmt(r.host.uptimeDays, "d") : <span className="obs-metric--dim">—</span>}</td>
                  <td className="obs-table--right">
                    {r.targets ? (
                      <span style={{ color: r.targets.down > 0 ? "var(--status-critical-fg)" : "var(--ink-muted)", fontWeight: r.targets.down > 0 ? 700 : 400 }}>
                        {r.targets.up}/{r.targets.up + r.targets.down}
                      </span>
                    ) : <span className="obs-metric--dim">no data</span>}
                  </td>
                  <td className="obs-table--right">
                    {!r.datastores ? (
                      <span className="obs-metric--dim">n/a</span>
                    ) : dsTotal === 0 ? (
                      <span className="obs-metric--dim">none shipped</span>
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

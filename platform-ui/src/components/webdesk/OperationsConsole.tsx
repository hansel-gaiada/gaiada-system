"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { useDebouncedValue } from "@/components/systems/useDebouncedValue";
import { serverOf, flattenSites, type PortfolioResult, type FlatSite } from "@/lib/webdeskPortfolio";
import "@/components/dashboard/dashboard.css";
import "@/components/systems/systems.css";
import "@/components/forms/forms.css";

// The Web Dev OPERATIONS console — "when something happens, where do I look".
//
// ── WHY THIS IS NOT THE PORTFOLIO ──────────────────────────────────────────────────────────────
// Portfolio answers "what sites exist and whose are they" (inventory). This answers "is it up, when
// was it last seen, and how do I get to it" (incident response). Same underlying rows, opposite
// question — so this groups by server (during an incident you look by box: "everything on helios is
// down"), leads with health, and every row is one click from the live site and the server it sits on.
//
// ── HEALTH IS SHOWN HONESTLY, NEVER SYNTHESISED ────────────────────────────────────────────────
// `lastHttpStatus`/`lastSeenAt` are whatever was last recorded — they are NOT a live check, and most
// rows have never been checked. A blank check must read as "not checked", never as "up": a dashboard
// that turns absence-of-data green is the exact failure the monitoring program was written to kill.
// Active per-site probing is the monitoring module's job and is gated on per-client consent
// (OQ-2.4); until a monitor exists, this surface reports what is known and links to where a check
// would be set up, rather than inventing a status.

const MUTED = { color: "var(--erp-ink-50)" } as const;

function environmentLabel(env: string): string {
  return ({ production: "Production", staging: "Staging", preview: "Preview", development: "Dev" } as Record<string, string>)[env] ?? env;
}

/** Relative age without a date library — good enough for "when last seen", and it degrades to an
 *  absolute-ish bucket rather than pretending precision the data does not have. */
function ago(iso: string | null): string {
  if (!iso) return "never checked";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Health cell. Three honest states: OK (2xx/3xx), a problem (the status code), or NOT CHECKED.
 *  A null status is never rendered as healthy. */
function healthCell(site: FlatSite) {
  const code = site.lastHttpStatus;
  if (code == null) {
    return <span style={MUTED} title="No check on record — this is NOT a healthy result, it is an unknown one">Not checked</span>;
  }
  const ok = code >= 200 && code < 400;
  return (
    <span title={`Last recorded HTTP ${code}${site.lastSeenAt ? ` · ${site.lastSeenAt}` : ""}`}>
      <StatusBadge label={ok ? `HTTP ${code}` : `HTTP ${code} ⚠`} />
      <span style={{ ...MUTED, display: "block", fontSize: 12 }}>{ago(site.lastSeenAt)}</span>
    </span>
  );
}

function investigateCell(site: FlatSite) {
  // The three things you actually reach for when a site misbehaves: load it, know which box to SSH,
  // and see recent code. The live-site link is the fastest "is it even up" check.
  const sv = serverOf(site);
  return (
    <span style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      <a href={`https://${site.domain}`} target="_blank" rel="noreferrer noopener">Open&nbsp;↗</a>
      <span style={MUTED} title="The server this site is on — where to SSH / look at logs">{sv.label}</span>
      {site.repoUrl && /^https?:\/\//.test(site.repoUrl) ? (
        <a href={site.repoUrl} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12 }}>repo&nbsp;↗</a>
      ) : null}
    </span>
  );
}

function searchText(s: FlatSite): string {
  return [s.domain, s.notes, s.clientName, s.projectName, serverOf(s).label].filter(Boolean).join(" ").toLowerCase();
}

interface Group { key: string; label: string; kind: string; sites: FlatSite[] }
function groupByServer(sites: FlatSite[]): Group[] {
  const map = new Map<string, Group>();
  for (const s of sites) {
    const sv = serverOf(s);
    let g = map.get(sv.key);
    if (!g) { g = { key: sv.key, label: sv.label, kind: sv.kind, sites: [] }; map.set(sv.key, g); }
    g.sites.push(s);
  }
  const ours = new Set(["helios", "delphi", "gda-ce01", "gda-aicenter"]);
  return [...map.values()].sort((a, b) => {
    const ao = ours.has(a.key) ? 0 : 1, bo = ours.has(b.key) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    if (b.sites.length !== a.sites.length) return b.sites.length - a.sites.length;
    return a.label.localeCompare(b.label);
  });
}

function Chip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`filter-chip${active ? " filter-chip--active" : ""}`}>
      <span className="filter-chip__label">{label}</span>
      <span className="filter-chip__count">{count}</span>
    </button>
  );
}

export function OperationsConsole({ data }: { data: PortfolioResult }) {
  const allSites = useMemo(() => flattenSites(data), [data]);
  const [query, setQuery] = useState("");
  const [server, setServer] = useState<string | null>(null);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const q = useDebouncedValue(query, 250).trim().toLowerCase();

  const isProblem = (s: FlatSite) => s.lastHttpStatus != null && !(s.lastHttpStatus >= 200 && s.lastHttpStatus < 400);

  const visible = useMemo(
    () => allSites.filter((s) =>
      (!server || serverOf(s).key === server) &&
      (!problemsOnly || isProblem(s)) &&
      (!q || searchText(s).includes(q))),
    [allSites, server, problemsOnly, q],
  );
  const groups = useMemo(() => groupByServer(visible), [visible]);

  const serverChips = useMemo(() => {
    const base = allSites.filter((s) => (!problemsOnly || isProblem(s)) && (!q || searchText(s).includes(q)));
    return groupByServer(base).map((g) => ({ key: g.key, label: g.label, count: g.sites.length }));
  }, [allSites, problemsOnly, q]);

  const problems = allSites.filter(isProblem).length;
  const checked = allSites.filter((s) => s.lastHttpStatus != null).length;

  if (data.counts.sites === 0) {
    return (
      <Card title="Operations">
        <EmptyNote>No sites to operate yet. Sites appear here once they are in the portfolio.</EmptyNote>
      </Card>
    );
  }

  return (
    <>
      <Card title="Operations" hint="Where to look when something breaks — health and quick links per site, grouped by server.">
        <p style={{ marginTop: 0 }}>
          {data.counts.sites} site{data.counts.sites === 1 ? "" : "s"} · {checked} with a recorded check ·{" "}
          {problems > 0 ? <strong>{problems} showing a problem</strong> : "none showing a problem"} ·{" "}
          {data.counts.sites - checked} not checked
        </p>
        <p style={{ ...MUTED, marginBottom: 14 }}>
          Health is the LAST RECORDED status, not a live probe — a blank check means unknown, not
          healthy. Active per-site probing is set up in Monitoring and is gated on client consent.
        </p>

        <div className="sys-searchable__toolbar" style={{ marginBottom: 12 }}>
          <label className="sys-searchable__label">
            <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Find a site</Eyebrow>
            <input type="search" className="lux-field__control" aria-label="Find a site to investigate"
              placeholder="domain, client, server…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <Link href="/monitoring" className="filter-chip" style={{ textDecoration: "none" }}>
            <span className="filter-chip__label">Open Monitoring ↗</span>
          </Link>
        </div>

        <div className="filter-chips" role="group" aria-label="Filter operations" style={{ marginBottom: 4 }}>
          <Chip active={server === null && !problemsOnly} onClick={() => { setServer(null); setProblemsOnly(false); }} label="All" count={allSites.length} />
          <Chip active={problemsOnly} onClick={() => setProblemsOnly((v) => !v)} label="Problems only" count={problems} />
          {serverChips.map((c) => (
            <Chip key={c.key} active={server === c.key} onClick={() => setServer(server === c.key ? null : c.key)} label={c.label} count={c.count} />
          ))}
        </div>
      </Card>

      {groups.length === 0 ? (
        <Card title="No matches"><EmptyNote>Nothing matches the current filters.</EmptyNote></Card>
      ) : groups.map((g) => (
        <Card key={g.key} title={g.label} headerRight={<span style={MUTED}>{g.kind} · {g.sites.length} site{g.sites.length === 1 ? "" : "s"}</span>}>
          <HairlineTable
            tcols="2fr 1fr 1.2fr 2.2fr"
            columns={[{ label: "Domain" }, { label: "Environment" }, { label: "Health (last recorded)" }, { label: "Investigate" }]}
            rows={g.sites.map((s) => [
              <a key="d" href={`https://${s.domain}`} target="_blank" rel="noreferrer noopener">{s.domain}</a>,
              environmentLabel(s.environment),
              healthCell(s),
              investigateCell(s),
            ])}
          />
        </Card>
      ))}
    </>
  );
}

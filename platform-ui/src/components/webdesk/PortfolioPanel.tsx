"use client";
import { useMemo, useState } from "react";
import { Card, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { useDebouncedValue } from "@/components/systems/useDebouncedValue";
import {
  serverOf, flattenSites,
  type PortfolioResult, type FlatSite,
} from "@/lib/webdeskPortfolio";
import "@/components/dashboard/dashboard.css";
import "@/components/systems/systems.css";
import "@/components/forms/forms.css";

// The estate portfolio — every site we know of, whether or not it is on the platform.
// Design: docs/blueprints/webdesk-design-v2.md §07. Backend: FRONTEND-BFF-CONTRACT §24.
//
// ── WHY THIS GROUPS BY SERVER, NOT BY PROJECT ──────────────────────────────────────────────────
// The estate is spread across many hosts — our helios/delphi/ce01 boxes, a Hostinger shared "WP
// pipeline" with dozens of sites, a Hostinger VPS, clients' own cPanels. The first question an
// operator asks is "what is on helios / on the shared WP box", so the server is the primary axis.
// Each site still carries its client/project as a column, so the "whose is this" answer the old
// project grouping gave is not lost — it just stops being the outermost bucket.
//
// ── NO DEGRADE BANNER HERE, DELIBERATELY ───────────────────────────────────────────────────────
// This panel reads Zone A's own tables; there is nothing to be stale about (unlike SiteRegistryPanel,
// whose Zone B control plane has no live reads). A banner "for consistency" would teach people to
// ignore it where it means something.

const MUTED = { color: "var(--erp-ink-50)" } as const;

function environmentLabel(env: string): string {
  // `preview` and `staging` are distinct in the schema for a reason (v2.0 §04): staging is durable
  // and client-visible, preview slots are ephemeral and machine-generated.
  return ({ production: "Production", staging: "Staging", preview: "Preview", development: "Dev" } as Record<string, string>)[env] ?? env;
}

/** `null` means NOT SURVEYED — never "no stack". An outside probe cannot see past a CDN, and most of
 *  these were never surveyed. A dash with an explanation is honest; "Unknown" as a finding is not. */
function stackCell(site: FlatSite) {
  const detected = site.kind ?? site.stack;
  if (!detected) return <span style={MUTED} title="Not surveyed — an external probe cannot always determine the stack">—</span>;
  return <StatusBadge label={detected === "wp" ? "wordpress" : detected} />;
}

function repoCell(site: FlatSite) {
  if (!site.repoUrl) return <span style={MUTED}>—</span>;
  const isHttp = /^https?:\/\//.test(site.repoUrl);
  const name = site.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
  if (!isHttp) {
    // A non-http remote (an SSH GitLab URL for a site another agency builds) is real, but not a
    // navigable link — show it plainly rather than as a dead anchor.
    return <span title={site.repoUrl}>{name}</span>;
  }
  return (
    <a href={site.repoUrl} target="_blank" rel="noreferrer noopener">
      {name}{site.repoBranch ? <span style={MUTED}> @{site.repoBranch}</span> : null}
    </a>
  );
}

/** The consent gate as a column. A site nobody may probe looks exactly like a healthy one in a
 *  monitoring list, and the difference is the whole compliance position. */
function consentCell(site: FlatSite) {
  return site.crawlConsent
    ? <span title="Consent recorded — MON-01 probes this site">Yes</span>
    : <span style={MUTED} title="No recorded consent — this site is NOT probed">Not recorded</span>;
}

/** The likely target a machine-generated staging host name encodes, pulled from notes so it is
 *  searchable and legible — `goldenmonkeybali-com-303701.hostingersite.com` is opaque; the note
 *  says what it is going to be. */
function targetHint(site: FlatSite): string | null {
  const m = site.notes?.match(/(?:likely target|project by repo):\s*([^\s;]+)/i);
  return m ? m[1] : null;
}

function domainCell(site: FlatSite) {
  const hint = targetHint(site);
  return (
    <span>
      <a href={`https://${site.domain}`} target="_blank" rel="noreferrer noopener">{site.domain}</a>
      {hint ? <span style={{ ...MUTED, display: "block", fontSize: 12 }}>→ {hint}</span> : null}
    </span>
  );
}

function whoseCell(site: FlatSite) {
  if (site.clientName) {
    return <span>{site.clientName}{site.projectName ? <span style={{ ...MUTED, display: "block", fontSize: 12 }}>{site.projectName}</span> : null}</span>;
  }
  if (site.projectName) return <span>{site.projectName}</span>;
  return <span style={MUTED}>Unassigned</span>;
}

function searchText(s: FlatSite): string {
  return [s.domain, s.notes, s.repoUrl, s.clientName, s.projectName, s.kind, s.stack, serverOf(s).label]
    .filter(Boolean).join(" ").toLowerCase();
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
  // Our own boxes first, then the rest, each by size then name, so the busy shared box does not
  // hide at the bottom.
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
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`filter-chip${active ? " filter-chip--active" : ""}`}>
      <span className="filter-chip__label">{label}</span>
      <span className="filter-chip__count">{count}</span>
    </button>
  );
}

export function PortfolioPanel({ data }: { data: PortfolioResult }) {
  const allSites = useMemo(() => flattenSites(data), [data]);
  const [query, setQuery] = useState("");
  const [server, setServer] = useState<string | null>(null);
  const [env, setEnv] = useState<string | null>(null);
  const q = useDebouncedValue(query, 250).trim().toLowerCase();

  const serverCount = useMemo(() => groupByServer(allSites).length, [allSites]);

  // Server chips are derived from ALL sites (so a server never vanishes just because a search hid
  // its rows). Counts respect the OTHER active facets, so they stay truthful as you filter.
  const serverChips = useMemo(() => {
    const base = allSites.filter((s) => (!env || s.environment === env) && (!q || searchText(s).includes(q)));
    return groupByServer(base).map((g) => ({ key: g.key, label: g.label, count: g.sites.length }));
  }, [allSites, env, q]);

  const envChips = useMemo(() => {
    const base = allSites.filter((s) => (!server || serverOf(s).key === server) && (!q || searchText(s).includes(q)));
    const order = ["production", "staging", "development", "preview"];
    return order
      .map((e) => ({ key: e, label: environmentLabel(e), count: base.filter((s) => s.environment === e).length }))
      .filter((c) => c.count > 0);
  }, [allSites, server, q]);

  const visible = useMemo(
    () => allSites.filter((s) =>
      (!server || serverOf(s).key === server) &&
      (!env || s.environment === env) &&
      (!q || searchText(s).includes(q))),
    [allSites, server, env, q],
  );
  const groups = useMemo(() => groupByServer(visible), [visible]);

  if (data.counts.sites === 0) {
    return (
      <Card title="Site portfolio">
        <EmptyNote>
          No sites recorded yet. This is the estate inventory — every site we build or operate,
          including the ones hosted elsewhere that we only track.
        </EmptyNote>
      </Card>
    );
  }

  const wp = allSites.filter((s) => s.kind === "wp" || s.stack === "wordpress").length;
  const faceted = Boolean(q || server || env);

  return (
    <>
      <Card title="Site portfolio">
        <p style={{ marginTop: 0 }}>
          {data.counts.sites} site{data.counts.sites === 1 ? "" : "s"} across {serverCount} server
          {serverCount === 1 ? "" : "s"} · {wp} WordPress · {data.counts.withoutConsent} without recorded probe consent
        </p>
        <p style={{ ...MUTED, marginBottom: 14 }}>
          Grouped by the server each site is on. Tracked sites are never modified — they are listed
          so that nothing is invisible.
        </p>

        <div className="sys-searchable__toolbar" style={{ marginBottom: 12 }}>
          <label className="sys-searchable__label">
            <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Search domain, repo, client</Eyebrow>
            <input type="search" className="lux-field__control" aria-label="Search the portfolio"
              placeholder="e.g. goldenmonkey, essentialbali, dmsviceroy…"
              value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <span className="sys-searchable__count">{faceted ? `${visible.length} of ${allSites.length}` : `${allSites.length}`}</span>
        </div>

        <Eyebrow style={{ fontSize: 10, opacity: 0.6, display: "block", marginBottom: 6 }}>Server</Eyebrow>
        <div className="filter-chips" role="group" aria-label="Filter by server" style={{ marginBottom: 10 }}>
          <Chip active={server === null} onClick={() => setServer(null)} label="All servers"
            count={allSites.filter((s) => (!env || s.environment === env) && (!q || searchText(s).includes(q))).length} />
          {serverChips.map((c) => (
            <Chip key={c.key} active={server === c.key} onClick={() => setServer(server === c.key ? null : c.key)} label={c.label} count={c.count} />
          ))}
        </div>

        {envChips.length > 1 ? (
          <>
            <Eyebrow style={{ fontSize: 10, opacity: 0.6, display: "block", marginBottom: 6 }}>Environment</Eyebrow>
            <div className="filter-chips" role="group" aria-label="Filter by environment">
              <Chip active={env === null} onClick={() => setEnv(null)} label="All" count={visible.length} />
              {envChips.map((c) => (
                <Chip key={c.key} active={env === c.key} onClick={() => setEnv(env === c.key ? null : c.key)} label={c.label} count={c.count} />
              ))}
            </div>
          </>
        ) : null}
      </Card>

      {groups.length === 0 ? (
        <Card title="No matches">
          <EmptyNote>Nothing matches the current search and filters.</EmptyNote>
        </Card>
      ) : groups.map((g) => (
        <Card key={g.key} title={g.label} headerRight={<span style={MUTED}>{g.kind} · {g.sites.length} site{g.sites.length === 1 ? "" : "s"}</span>}>
          <HairlineTable
            tcols="2.2fr 1fr 1fr 1.6fr 1.4fr 0.9fr"
            columns={[
              { label: "Domain" }, { label: "Environment" }, { label: "Stack" },
              { label: "Repository" }, { label: "Client / project" }, { label: "Probe consent" },
            ]}
            rows={g.sites.map((s) => [
              domainCell(s), environmentLabel(s.environment), stackCell(s),
              repoCell(s), whoseCell(s), consentCell(s),
            ])}
          />
        </Card>
      ))}
    </>
  );
}

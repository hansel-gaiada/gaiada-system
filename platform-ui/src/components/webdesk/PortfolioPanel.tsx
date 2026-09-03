"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, HairlineTable, StatusBadge, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { useDebouncedValue } from "@/components/systems/useDebouncedValue";
import {
  serverOf, flattenSites, groupByServer, environmentLabel, ENVIRONMENT_ORDER,
  searchText, targetHint, portfolioStats, sortSites,
  ADOPTION_ORDER, ADOPTION_COPY, PORTFOLIO_SORTS,
  type PortfolioResult, type FlatSite, type PortfolioSortKey, type SortDir,
} from "@/lib/webdeskPortfolio";
import {
  indexMonitorsByDomain, siteMonitoring, coverageStats, createMonitorHref,
  type MonitoringFeed, type SiteMonitoring,
} from "@/lib/siteMonitoring";
import "./webdesk.css";
import "@/components/forms/forms.css";

// The estate portfolio — every site we know of, whether or not it is on the platform.
// Design: docs/blueprints/webdesk-design-v2.md §07. Backend: FRONTEND-BFF-CONTRACT §24.
//
// ── THIS IS NOW THE ONLY SITE SURFACE IN WEB DEV (2026-09-03) ──────────────────────────────────
// It used to have a twin: an "Operations" tab reading the SAME endpoint, grouping it the same way,
// with the same chips, differing only in which columns it drew — plus a health column fed by two
// database columns nothing has ever written. Owner decision: the twin is deleted, this page is the
// inventory, and HEALTH belongs to Business > Monitoring (live sweeps, uptime, incidents, certs) —
// one health surface for the company, not a per-department copy.
//
// ── WHY THE OLD LAYOUT WAS UNREADABLE, AND WHAT REPLACED IT ────────────────────────────────────
// It rendered one table PER SERVER, each in its own Card, under a run-on summary sentence and two
// full rows of filter chips — so on a laptop the first data row sat below the fold, and three of
// six cells stacked a second muted line, which made every row a different height. The rebuild:
//   · figures as figures (KpiTile), not prose;
//   · ONE table, with the server as a sortable COLUMN — sorting by it reproduces the old grouping
//     without spending a card header and a fold on each one;
//   · one toolbar line (search + three selects) instead of two chip rows;
//   · every cell single-line and uniform height; what used to be a stacked sub-line now lives on
//     the per-site page, which is also where anything new about a site belongs.
//
// ── NO DEGRADE BANNER HERE, DELIBERATELY ───────────────────────────────────────────────────────
// This panel reads Zone A's own tables; there is nothing to be stale about (unlike SiteRegistryPanel,
// whose Zone B control plane has no live reads). A banner "for consistency" would teach people to
// ignore it where it means something.

/** `null` for BOTH `kind` and `stack` means NOT SURVEYED — never "no stack". An outside probe cannot
 *  see past a CDN, and most of these were never surveyed. A dash with an explanation is honest;
 *  "Unknown" as a finding is not. */
function stackCell(site: FlatSite) {
  const detected = site.kind ?? site.stack;
  if (!detected) {
    return <span className="wd-pf__none" title="Not surveyed — an external probe cannot always determine the stack">—</span>;
  }
  return <StatusBadge label={detected === "wp" ? "wordpress" : detected} />;
}

/** The consent gate as a column. A site nobody may probe looks exactly like a healthy one in a
 *  monitoring list, and the difference is the whole compliance position. */
function consentCell(site: FlatSite) {
  return site.crawlConsent
    ? <span className="wd-pf__consent" title="Consent recorded — the monitoring module may probe this site">Yes</span>
    : <span className="wd-pf__consent wd-pf__none" title="No recorded consent — this site is NOT probed">Not recorded</span>;
}

/** The monitoring cell — the honest replacement for the deleted Operations tab.
 *
 *  The tab it replaces printed a health column fed by two database columns nothing has ever
 *  written, so every row said "Not checked" forever. This column has no value of its own to
 *  invent: it reports what the MONITORING module says, and when it cannot reach that module it
 *  says so rather than reporting the estate as uncovered.
 *
 *  Five states, each rendering as itself:
 *    unavailable  — monitoring is off here, or you may not read it. Never "no monitor".
 *    watched      — the monitor's own status, linked to it. Plus the anomaly case below.
 *    anomaly      — watched with NO consent on record. Probing without consent is the one state
 *                   nobody wants to be in, so it is called out rather than shown as healthy.
 *    no-consent   — not probed BY RULE. Not a coverage gap and not ours to close by clicking.
 *    none         — consented and genuinely unwatched, with the one action that fixes it.
 */
function monitoringCell(state: SiteMonitoring, site: FlatSite) {
  switch (state.kind) {
    case "unavailable":
      return (
        <span
          className="wd-pf__none"
          title={state.reason === "refused"
            ? "You are not authorized to read monitoring for this company, so coverage is unknown — this is NOT 'no monitor'."
            : "The monitoring module is not enabled for this company, so coverage is unknown — this is NOT 'no monitor'."}
        >
          Unknown
        </span>
      );

    case "watched": {
      const m = state.monitor;
      return (
        <span className="wd-pf__watch">
          <Link href={`/monitoring/${m.id}`} title={`${m.name} — open in Monitoring`}>
            <StatusBadge label={m.status} />
          </Link>
          {/* A suspended monitor is not evidence of health, so it is stated, not implied. */}
          {!m.enabled ? <StatusBadge label="suspended" /> : null}
          {!state.consented ? (
            <StatusBadge label="no consent" />
          ) : null}
        </span>
      );
    }

    case "no-consent":
      return (
        <span className="wd-pf__none" title="No crawl consent on record, so monitoring never probes this domain. A rule, not an outage.">
          Not probed
        </span>
      );

    case "none":
      return (
        <span className="wd-pf__watch">
          <span className="wd-pf__none">No monitor</span>
          <Link
            href={createMonitorHref(site, state.clientId)}
            className="wd-pf__watch-add"
            title={state.clientId
              ? "Create a monitor for this site"
              : "Create a monitor — this site has no client on record yet, and a monitor needs one"}
          >
            Add
          </Link>
        </span>
      );
  }
}

/** Client · project on ONE line. It used to stack the project under the client as a second muted
 *  line, which is what made the row heights ragged; the full pair is still in the title and on the
 *  site's own page. */
function whoseCell(site: FlatSite) {
  if (site.clientName) {
    return (
      <span className="wd-pf__truncate" title={site.projectName ? `${site.clientName} · ${site.projectName}` : site.clientName}>
        {site.clientName}
        {site.projectName ? <span className="wd-pf__dim"> · {site.projectName}</span> : null}
      </span>
    );
  }
  if (site.projectName) return <span className="wd-pf__truncate" title={site.projectName}>{site.projectName}</span>;
  return <span className="wd-pf__none" title="Not attached to a client or project yet">Unassigned</span>;
}

/** The domain cell, and the whole row's click target.
 *
 *  ── WHAT THE ROW DOES NOW (2026-09-04, owner request) ─────────────────────────────────────────
 *  Clicking anywhere on the row opens that site's RECORD (the per-site page). The domain itself is
 *  a link to the ACTUAL SITE. This is the reverse of how it shipped: the domain used to open the
 *  record and a small arrow beside it opened the site.
 *
 *  ── WHY THIS IS TWO REAL ANCHORS AND AN OVERLAY, NOT AN onClick ON THE ROW ────────────────────
 *  The two requirements are in direct tension in HTML: "the whole row links to the record" and
 *  "a link inside the row goes somewhere else" cannot both be plain nesting, because an anchor may
 *  not contain another anchor. The obvious escape is a click handler on the row div, and it is the
 *  wrong one — a div with onClick is not reachable by keyboard, announces as nothing to a screen
 *  reader, and cannot be opened in a new tab or copied as a link. This surface already carries the
 *  program's rule that a control must BE the thing it claims to be (see `HairlineTable`'s sortable
 *  header, which is a real `<button>` for the same reason).
 *
 *  So: the record link is a REAL `<Link>` whose `::after` is stretched over the whole row (the row
 *  is `position: relative`), and every other interactive thing in the row — the domain, the monitor
 *  status, the "Add" action — is lifted above that overlay with `z-index`. Both links are tabbable,
 *  both have honest hrefs, middle-click and "copy link" work on each, and the mouse gets the whole
 *  row. The one real cost is that text in the row can no longer be selected by dragging across it;
 *  the full value of every truncated cell is in its `title`, and the record page has all of it.
 */
function domainCell(site: FlatSite, basePath: string) {
  const hint = targetHint(site);
  return (
    <span className="wd-pf__domain">
      {/* The domain goes to the SITE. `noreferrer noopener` because this is an outbound link to a
          third party we do not control — including client-owned hosting. */}
      <a
        href={`https://${site.domain}`}
        target="_blank"
        rel="noreferrer noopener"
        className="wd-pf__domain-link"
        title={hint ? `Open ${site.domain} — machine-named host, likely ${hint}` : `Open ${site.domain} in a new tab`}
      >
        {site.domain}
        {/* aria-hidden: the anchor's own text plus its title already say where this goes, and
            "north east arrow" read aloud on all 81 rows is noise. */}
        <span aria-hidden="true" className="wd-pf__ext">↗</span>
      </a>

      {/* The row's click target. Icon-only, so the accessible name has to be explicit — and it
          names the DOMAIN, because "Open record" repeated 81 times distinguishes nothing. */}
      <Link
        href={`${basePath}/${site.id}`}
        className="wd-pf__rowlink"
        aria-label={`Open the portfolio record for ${site.domain}`}
        title="Open this site's record"
      >
        <span aria-hidden="true">›</span>
      </Link>
    </span>
  );
}

/** The monitoring facets, as data so the labels and the matcher cannot drift apart.
 *  "Needs a monitor" is first because it is the only one with an action attached. */
const COVERAGE_FACETS = [
  { key: "needs", label: "Needs a monitor" },
  { key: "watched", label: "Monitored" },
  { key: "problem", label: "Not up right now" },
  { key: "anomaly", label: "Probed without consent" },
  { key: "no-consent", label: "Not probed (no consent)" },
] as const;

function matchesCoverage(state: SiteMonitoring | undefined, facet: string): boolean {
  if (!state) return false;
  switch (facet) {
    case "needs":      return state.kind === "none";
    case "watched":    return state.kind === "watched";
    // Excludes `maintenance`: suppressed on purpose is not a problem to chase. Includes `unknown`
    // and `degraded`, because neither is evidence of health.
    case "problem":    return state.kind === "watched" && state.monitor.status !== "up" && state.monitor.status !== "maintenance";
    case "anomaly":    return state.kind === "watched" && !state.consented;
    case "no-consent": return state.kind === "no-consent";
    default:           return true;
  }
}

export function PortfolioPanel({ data, basePath, monitoring }: {
  data: PortfolioResult;
  basePath: string;
  /** Carries its OWN availability. An unavailable feed makes the column say "unknown" — never
   *  "no monitor", which would be a confident false claim about coverage. */
  monitoring: MonitoringFeed;
}) {
  const allSites = useMemo(() => flattenSites(data), [data]);
  const [query, setQuery] = useState("");
  const [server, setServer] = useState("");
  const [env, setEnv] = useState("");
  const [adoption, setAdoption] = useState("");
  // The monitoring facet. Separate from the sortable columns on purpose — see the table below.
  const [coverageFacet, setCoverageFacet] = useState("");
  const [sort, setSort] = useState<{ key: PortfolioSortKey; dir: SortDir }>({ key: "server", dir: "asc" });
  const q = useDebouncedValue(query, 250).trim().toLowerCase();

  const stats = useMemo(() => portfolioStats(data, allSites), [data, allSites]);

  // Built once per feed, not per row: the domain index is O(monitors) and the alternative is a
  // linear scan of every monitor for every site.
  const monitorIndex = useMemo(
    () => monitoring.available ? indexMonitorsByDomain(monitoring.monitors, monitoring.properties) : new Map(),
    [monitoring],
  );
  const stateFor = useMemo(() => {
    const m = new Map<string, SiteMonitoring>();
    for (const s of allSites) m.set(s.id, siteMonitoring(s, monitoring, monitorIndex));
    return m;
  }, [allSites, monitoring, monitorIndex]);
  const coverage = useMemo(() => coverageStats([...stateFor.values()]), [stateFor]);

  // Server options come from ALL sites, so a server never disappears from the picker just because
  // the current search hid its rows — a filter you cannot get back to is a trap. The COUNT beside
  // each one respects the other active facets, so it stays truthful as you narrow.
  const serverOptions = useMemo(() => {
    const base = allSites.filter((s) =>
      (!env || s.environment === env) && (!adoption || s.adoption === adoption) && (!q || searchText(s).includes(q)));
    const counts = new Map(groupByServer(base).map((g) => [g.key, g.sites.length]));
    return groupByServer(allSites).map((g) => ({ key: g.key, label: g.label, count: counts.get(g.key) ?? 0 }));
  }, [allSites, env, adoption, q]);

  const envOptions = useMemo(() => {
    const base = allSites.filter((s) =>
      (!server || serverOf(s).key === server) && (!adoption || s.adoption === adoption) && (!q || searchText(s).includes(q)));
    return ENVIRONMENT_ORDER
      .map((e) => ({ key: e as string, label: environmentLabel(e), count: base.filter((s) => s.environment === e).length }))
      .filter((o) => o.count > 0 || o.key === env);
  }, [allSites, server, adoption, q, env]);

  const adoptionOptions = useMemo(() => {
    const base = allSites.filter((s) =>
      (!server || serverOf(s).key === server) && (!env || s.environment === env) && (!q || searchText(s).includes(q)));
    return ADOPTION_ORDER
      .map((a) => ({ key: a as string, label: ADOPTION_COPY[a] ?? a, count: base.filter((s) => s.adoption === a).length }))
      .filter((o) => o.count > 0 || o.key === adoption);
  }, [allSites, server, env, q, adoption]);

  const visible = useMemo(() => {
    const filtered = allSites.filter((s) =>
      (!server || serverOf(s).key === server) &&
      (!env || s.environment === env) &&
      (!adoption || s.adoption === adoption) &&
      (!coverageFacet || matchesCoverage(stateFor.get(s.id), coverageFacet)) &&
      (!q || searchText(s).includes(q)));
    return sortSites(filtered, sort.key, sort.dir);
  }, [allSites, server, env, adoption, coverageFacet, stateFor, q, sort]);

  // Options built from the states actually present, so the picker never offers a filter that
  // returns nothing, and never hides one the operator is currently standing in.
  const coverageOptions = useMemo(() => {
    if (!monitoring.available) return [];
    const present = [...stateFor.values()];
    return COVERAGE_FACETS
      .map((f) => ({ ...f, count: present.filter((st) => matchesCoverage(st, f.key)).length }))
      .filter((o) => o.count > 0 || o.key === coverageFacet);
  }, [monitoring.available, stateFor, coverageFacet]);

  // Clicking the active column reverses it; clicking another column starts that one ascending.
  const onSort = (key: string) => {
    setSort((cur) => cur.key === key
      ? { key: cur.key, dir: cur.dir === "asc" ? "desc" : "asc" }
      : { key: key as PortfolioSortKey, dir: "asc" });
  };

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

  const faceted = Boolean(q || server || env || adoption || coverageFacet);

  return (
    <>
      <div className="wd-pf__kpis">
        <KpiTile label="Sites" value={String(stats.sites)} foot={`across ${stats.servers} server${stats.servers === 1 ? "" : "s"}`} />
        <KpiTile label="On our servers" value={String(stats.ourServers)} foot={`${stats.sites - stats.ourServers} hosted elsewhere`} />
        <KpiTile label="WordPress" value={String(stats.wordpress)} foot={stats.unsurveyed > 0 ? `${stats.unsurveyed} stacks unsurveyed` : undefined} />
        <KpiTile label="No probe consent" value={String(stats.withoutConsent)} foot="not probed, by rule" />
        {/* The tile the deleted Operations tab was reaching for, sourced from monitors that exist
            rather than from two columns nothing writes. When the feed is unavailable it says so
            instead of showing a zero, because "0 unmonitored" and "we could not ask" are opposite
            claims that happen to look identical as a figure. */}
        {coverage.available ? (
          <KpiTile
            label="Monitored"
            value={`${coverage.watched}/${coverage.watched + coverage.unwatched}`}
            foot={
              coverage.anomalies > 0
                ? `${coverage.anomalies} probed without consent`
                : coverage.problems > 0
                  ? `${coverage.problems} not up right now`
                  : coverage.unwatched > 0 ? `${coverage.unwatched} consented, unwatched` : "every consented site"
            }
            hint="Counts only sites monitoring is permitted to probe (consent on record). Health itself lives in Monitoring — this is coverage, not status."
          />
        ) : (
          <KpiTile label="Monitored" value="—" foot="monitoring unavailable" hint="The monitoring module is off for this company or you may not read it, so coverage is unknown. This is not a claim that nothing is monitored." />
        )}
      </div>

      <Card
        title="Site portfolio"
        hint="Every site we build or operate, including ones hosted elsewhere that we only track. Tracked sites are never modified — they are listed so nothing is invisible. Live health lives in Monitoring."
        headerRight={<Link href="/monitoring" className="wd-pf__link">Monitoring ↗</Link>}
      >
        <div className="wd-pf__toolbar">
          <label className="wd-pf__search">
            <span className="type-eyebrow wd-pf__label">Search</span>
            <input
              type="search"
              className="lux-field__control"
              aria-label="Search the portfolio by domain, repo, client or server"
              placeholder="domain, repo, client, server…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          <label className="wd-pf__facet">
            <span className="type-eyebrow wd-pf__label">Server</span>
            <select className="lux-field__control" value={server} onChange={(e) => setServer(e.target.value)}>
              <option value="">All servers</option>
              {serverOptions.map((o) => <option key={o.key} value={o.key}>{o.label} ({o.count})</option>)}
            </select>
          </label>

          <label className="wd-pf__facet">
            <span className="type-eyebrow wd-pf__label">Environment</span>
            <select className="lux-field__control" value={env} onChange={(e) => setEnv(e.target.value)}>
              <option value="">All</option>
              {envOptions.map((o) => <option key={o.key} value={o.key}>{o.label} ({o.count})</option>)}
            </select>
          </label>

          <label className="wd-pf__facet">
            <span className="type-eyebrow wd-pf__label">Adoption</span>
            <select className="lux-field__control" value={adoption} onChange={(e) => setAdoption(e.target.value)}>
              <option value="">All</option>
              {adoptionOptions.map((o) => <option key={o.key} value={o.key}>{o.label} ({o.count})</option>)}
            </select>
          </label>

          {coverageOptions.length > 0 ? (
            <label className="wd-pf__facet">
              <span className="type-eyebrow wd-pf__label">Monitoring</span>
              <select className="lux-field__control" value={coverageFacet} onChange={(e) => setCoverageFacet(e.target.value)}>
                <option value="">All</option>
                {coverageOptions.map((o) => <option key={o.key} value={o.key}>{o.label} ({o.count})</option>)}
              </select>
            </label>
          ) : null}

          <p className="wd-pf__count" aria-live="polite">
            {faceted ? `${visible.length} of ${allSites.length}` : `${allSites.length} site${allSites.length === 1 ? "" : "s"}`}
            {faceted ? (
              <button type="button" className="wd-pf__clear" onClick={() => { setQuery(""); setServer(""); setEnv(""); setAdoption(""); setCoverageFacet(""); }}>
                Clear
              </button>
            ) : null}
          </p>
        </div>

        {visible.length === 0 ? (
          <EmptyNote>Nothing matches the current search and filters.</EmptyNote>
        ) : (
          // `--lux-table-min`: this table carries domains and client names, so it is set at the wide
          // end of the range ui.css documents for that case rather than left on the 640px default.
          <div className="lux-table-scroll wd-pf__scroll">
            <HairlineTable
              tcols="2fr 1.15fr 0.8fr 0.8fr 1.25fr 0.8fr 1.5fr"
              sort={sort}
              onSort={onSort}
              // Monitoring is NOT sortable: its value comes from a second module that may be
              // unavailable, and a sort axis whose rows can all read "unknown" is a control that
              // does nothing. Filter by it instead (the "Needs a monitor" facet above).
              columns={[
                ...PORTFOLIO_SORTS.map((c) => ({ label: c.label, sortKey: c.key })),
                { label: "Monitoring" },
              ]}
              rows={visible.map((s) => [
                domainCell(s, basePath),
                <span key="sv" className="wd-pf__truncate" title={serverOf(s).kind}>{serverOf(s).label}</span>,
                environmentLabel(s.environment),
                stackCell(s),
                whoseCell(s),
                consentCell(s),
                monitoringCell(stateFor.get(s.id) ?? { kind: "unavailable", reason: "not_enabled" }, s),
              ])}
            />
          </div>
        )}
      </Card>
    </>
  );
}

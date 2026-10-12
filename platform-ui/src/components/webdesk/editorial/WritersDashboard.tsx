import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import {
  PERIODS, DEFAULT_PERIOD, decayStatusWords, filterOptions, filterQuery, formatCount, formatSeconds, formatWindow, trendInfo, unavailableSources,
  type CountWithTrend, type DashboardFilters, type DashboardItem, type Metric, type WritersDashboard,
} from "@/lib/webdeskDashboardModel";
import "./dashboard.css";

/**
 * `writers/dashboard/[tenant]/[site]` — how the site's published articles are doing: views and time (analytics), search clicks and
 * queries (Search Console), the leads that landed on or sent a form from the page, and a decay alert. COUNTS ONLY: the BFF sends no
 * visitor and no lead identity, so this component has none to show.
 *
 * Three rules every tile follows:
 *  - a figure the BFF could not read is "Unavailable" and its reason in words, never a 0 (and the card stays);
 *  - a trend is an arrow AND words, and only appears when both periods are real numbers;
 *  - a view count under 5 reads "fewer than 5".
 */

function Tile({ label, testId, metric, children }: { label: string; testId: string; metric: Metric<unknown>; children: ReactNode }) {
  if (metric.reason !== null) {
    return (
      <div className="wdb-tile wdb-tile--na" data-testid={testId} data-available="false">
        <dt>{label}</dt>
        <dd><span className="wdb-na">Unavailable</span><span data-testid={`${testId}-reason`}>{metric.reason.text}</span></dd>
      </div>
    );
  }
  return (
    <div className="wdb-tile" data-testid={testId} data-available="true">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Figure({ f, unit, testId }: { f: CountWithTrend; unit: string; testId: string }) {
  const t = trendInfo(f.trend);
  return (
    <>
      <span className="wdb-value" data-testid={`${testId}-value`}>{formatCount(f.current)}</span>
      <span>{unit}</span>
      {t ? (
        <span className={`wdb-trend wdb-trend--${f.trend}`} data-testid={`${testId}-trend`} data-trend={f.trend}>
          <span aria-hidden="true">{t.glyph}</span><span>{t.word}</span>
        </span>
      ) : null}
      {f.previous !== null ? <span data-testid={`${testId}-previous`}>Period before: {formatCount(f.previous)}</span> : null}
    </>
  );
}

function ArticleCard({ it, editorHref }: { it: DashboardItem; editorHref: string }) {
  const m = it.metrics;
  const finding = it.decay.value !== null && it.decay.value !== "none" ? it.decay.value : null;
  return (
    <li className="wdb-card" data-testid="dash-card" data-item={it.itemId}>
      <div className="wdb-head">
        <h3 className="wdb-title"><Link href={editorHref}>{it.title || it.slug}</Link></h3>
        <div className="wdb-meta">
          <span className="wc-muted">{it.collectionKey} · {it.locale} · v{it.publishedVersion}</span>
          {it.mine ? <span className="wc-chip wc-chip--info" data-testid="mine-chip">Your article</span> : null}
        </div>
      </div>

      {it.pagePath !== null ? (
        <p className="wdb-path" data-testid="page-path">Page address: <code>{it.pagePath}</code></p>
      ) : (
        <p className="wdb-path wdb-path--na" data-testid="page-path-na">
          No public page address, so no figures can be shown for this article. {it.pagePathReason?.text}
        </p>
      )}

      <dl className="wdb-grid">
        <Tile label="Views" testId="tile-views" metric={m.views}>
          {m.views.value ? <Figure f={m.views.value} unit="page views" testId="views" /> : null}
        </Tile>
        <Tile label="Time on the page" testId="tile-time" metric={m.avgSeconds}>
          {m.avgSeconds.value ? <><span className="wdb-value" data-testid="time-value">{formatSeconds(m.avgSeconds.value.seconds)}</span><span>average per visit that includes this page</span></> : null}
        </Tile>
        <Tile label="Search clicks" testId="tile-clicks" metric={m.clicks}>
          {m.clicks.value ? <Figure f={m.clicks.value} unit="clicks from Google" testId="clicks" /> : null}
        </Tile>
        <Tile label="Search impressions" testId="tile-impressions" metric={m.impressions}>
          {m.impressions.value ? <Figure f={m.impressions.value} unit="times shown in results" testId="impressions" /> : null}
        </Tile>
        <Tile label="Top search queries" testId="tile-queries" metric={m.topQueries}>
          {m.topQueries.value && m.topQueries.value.length > 0 ? (
            <ol className="wdb-queries" data-testid="queries-list">
              {m.topQueries.value.map((q) => <li key={q.query}>{q.query} <span className="wc-muted">({q.clicks.toLocaleString("en-GB")} clicks, {q.impressions.toLocaleString("en-GB")} impressions)</span></li>)}
            </ol>
          ) : <span data-testid="queries-none">No query had enough impressions to list in this period.</span>}
        </Tile>
        <Tile label="Leads" testId="tile-leads" metric={m.leads}>
          {m.leads.value ? <Figure f={m.leads.value} unit="web leads that landed on, or sent a form from, this page" testId="leads" /> : null}
        </Tile>
      </dl>

      <div className="wdb-decay" data-testid="decay">
        {it.decay.value === null ? (
          <span className="wc-chip" data-testid="decay-na">Decay check unavailable</span>
        ) : it.decay.value === "none" ? (
          <span className="wc-chip wc-chip--ok" data-testid="decay-none">No decay alert</span>
        ) : (
          <a className="wc-chip wc-chip--warn" href={`#finding-${it.decay.value.findingId}`} data-testid="decay-badge">Losing traffic</a>
        )}
        {it.decay.value === null ? <span className="wc-muted" data-testid="decay-na-reason">{it.decay.reason.text}</span> : null}
        {finding ? (
          <div className="wdb-finding" id={`finding-${finding.findingId}`} data-testid="decay-finding">
            <p style={{ margin: 0 }}><strong>{finding.reason}</strong></p>
            <p>{decayStatusWords(finding.status)}. Found {formatDateTime(finding.detectedAt)}.</p>
            <p><Link href={editorHref}>Open the article to refresh it</Link></p>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function WritersDashboard({
  data, filters, filterAction, editorBase, collections, locales,
}: {
  data: WritersDashboard;
  filters: DashboardFilters;
  /** This page's own path (the filter form submits here with GET). */
  filterAction: string;
  /** `…/website/content/:tenant/:site` — card links are `${editorBase}/${collection}/${slug}?locale=`. */
  editorBase: string;
  /** The site's collection keys and languages, for the filter lists (the rows on screen are added). */
  collections: readonly string[];
  locales: readonly string[];
}) {
  const unavailable = unavailableSources(data.sources);
  const filtered = !!(filters.collection || filters.locale || filters.mine || (filters.period && filters.period !== DEFAULT_PERIOD));
  const nextHref = data.page.hasMore && data.page.cursor ? `${filterAction}${filterQuery({ ...filters, cursor: data.page.cursor })}` : null;
  const colOpts = filterOptions(collections, data.items.map((i) => i.collectionKey), filters.collection);
  const locOpts = filterOptions(locales, data.items.map((i) => i.locale), filters.locale);
  const t = data.windows.traffic;
  const s = data.windows.search;

  return (
    <div className="wc-page" data-testid="writers-dashboard">
      <p className="wc-lede">
        How the published articles are doing. Counts only: no visitor, and no lead&apos;s name or details, is ever shown here.
        {" "}{data.scope === "scoped" ? "You see the articles your access lets you see." : "You see every article on this site."}
      </p>
      <p className="wc-muted" data-testid="dash-windows">
        Views, time and leads: {formatWindow(t.current)}, compared with {formatWindow(t.previous)}.
        {" "}Search figures: {formatWindow(s.current)}, compared with {formatWindow(s.previous)} (Search Console settles a few days late).
      </p>

      {unavailable.length > 0 ? (
        <div className="wc-banner wc-banner--warn" role="note" data-testid="dash-sources">
          <div className="wc-banner__body">
            <strong>Some figures are unavailable right now.</strong> They are marked on each article; nothing is shown as zero.
            <ul className="wdb-sources">
              {unavailable.map((u) => <li key={u.label} data-testid={`source-${u.label.split(" ")[0].toLowerCase()}`}>{u.label}: {u.reason.text}</li>)}
            </ul>
          </div>
        </div>
      ) : null}

      {/* keyed on the filters: a soft navigation (Clear, Next page) must reset the uncontrolled selects, or the form would submit stale choices */}
      <form key={filterQuery({ ...filters, cursor: undefined })} method="get" action={filterAction} className="wc-filter" aria-label="Filter the dashboard">
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="wdb-period">Period</label>
          <select id="wdb-period" name="period" className="lux-field__control" defaultValue={filters.period ?? DEFAULT_PERIOD}>
            {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="wdb-collection">Collection</label>
          <select id="wdb-collection" name="collection" className="lux-field__control" defaultValue={filters.collection ?? ""}>
            <option value="">All collections</option>
            {colOpts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="wdb-locale">Language</label>
          <select id="wdb-locale" name="locale" className="lux-field__control" defaultValue={filters.locale ?? ""}>
            <option value="">All languages</option>
            {locOpts.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="wdb-mine">Show</label>
          <select id="wdb-mine" name="mine" className="lux-field__control" defaultValue={filters.mine ? "true" : "false"}>
            <option value="false">All articles I can see</option>
            <option value="true">My articles</option>
          </select>
        </div>
        <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Apply</button>
        {filtered && <Link href={filterAction} className="lux-btn lux-btn--ghost lux-btn--sm">Clear</Link>}
      </form>

      {data.items.length === 0 ? (
        <Card title="Articles">
          <EmptyNote>
            {data.page.hasMore
              ? "None of the articles on this page can be shown for these filters. Try the next page."
              : filtered ? "No published articles match these filters." : "There are no published articles to show yet."}
          </EmptyNote>
        </Card>
      ) : (
        <ul className="wdb-list" aria-label="Published articles">
          {data.items.map((it) => (
            <ArticleCard key={it.itemId} it={it} editorHref={`${editorBase}/${encodeURIComponent(it.collectionKey)}/${encodeURIComponent(it.slug)}?locale=${encodeURIComponent(it.locale)}`} />
          ))}
        </ul>
      )}
      {nextHref && <div className="wc-pager"><Link href={nextHref} className="lux-btn lux-btn--ghost lux-btn--sm" data-testid="dash-next">Next page</Link></div>}
    </div>
  );
}

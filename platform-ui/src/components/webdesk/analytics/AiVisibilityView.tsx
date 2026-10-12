import type { ReactNode } from "react";
import Link from "next/link";
import { Card, KpiTile } from "@/components/ui";
import type { Read } from "@/lib/aiVisibility";
import {
  bySeries, engineLabel, fmtHits, groupStatus,
  type CrawlerSummary, type CrawlerSummaryOk, type VisibilitySummary,
} from "@/lib/aiVisibilityModel";
import "../content/content.css";
import "./analytics.css";
import "./aiVisibility.css";

const SERIES = 6; // distinct bot colours; every further bot is grouped as "Other bots"

/** A read that is not `ok` becomes words, in place of its panel content. */
function Gate<T>({ read, children }: { read: Read<T>; children: (data: T) => ReactNode }) {
  if (read.state !== "ok") return <p className="wa-note" role="status" data-testid="ai-state-unavailable">{read.message}</p>;
  return <>{children(read.data)}</>;
}

function CrawlerGate({ data, children }: { data: CrawlerSummary; children: (d: CrawlerSummaryOk) => ReactNode }) {
  if (data.state !== "ok") return <p className="wa-note" role="status" data-testid={`ai-state-${data.state}`}>{data.message}</p>;
  return <>{children(data)}</>;
}

function OverTime({ d }: { d: CrawlerSummaryOk }) {
  const s = bySeries(d.byDay, d.range.from, d.range.to);
  const shown = s.bots.slice(0, SERIES);
  const hasOther = s.bots.length > SERIES;
  const legend = hasOther ? [...shown, "Other bots"] : shown;
  const cellOf = (day: string) => {
    const row = s.cells[day] ?? {};
    const parts = shown.map((b, i) => ({ label: b, series: i, hits: row[b] ?? 0 }));
    const other = Object.entries(row).filter(([b]) => !shown.includes(b)).reduce((n, [, h]) => n + h, 0);
    if (other > 0) parts.push({ label: "Other bots", series: SERIES, hits: other });
    return parts;
  };
  return (
    <>
      <div className="av-chart" role="img" aria-label={`AI-crawler hits per day from ${d.range.from} to ${d.range.to}, by bot. The table below has the same numbers.`} data-testid="ai-over-time">
        {s.days.map((day) => {
          const parts = cellOf(day);
          const total = parts.reduce((n, p) => n + p.hits, 0);
          return (
            <div key={day} className="av-col" title={`${day}: ${fmtHits(total)} hits`}>
              {parts.filter((p) => p.hits > 0).map((p) => (
                <span key={p.label} className={`av-seg av-s${p.series}`} style={{ height: `${Math.max(2, Math.round((p.hits / s.max) * 100))}%` }} />
              ))}
            </div>
          );
        })}
      </div>
      <ul className="av-legend" aria-label="Bots">
        {legend.map((b, i) => <li key={b}><span className={`av-swatch av-s${i}`} aria-hidden="true" />{b}</li>)}
      </ul>
      <details className="av-details">
        <summary>Show the daily numbers</summary>
        <table className="wa-table">
          <thead><tr><th>Day</th>{legend.map((b) => <th key={b} className="wa-num">{b}</th>)}</tr></thead>
          <tbody>
            {s.days.map((day) => {
              const parts = cellOf(day);
              return (
                <tr key={day}><td>{day}</td>{legend.map((b) => {
                  const p = parts.find((x) => x.label === b);
                  return <td key={b} className="wa-num">{fmtHits(p?.hits ?? 0)}</td>;
                })}</tr>
              );
            })}
          </tbody>
        </table>
        <p className="wa-foot">A day with 0 is a day in the shipped log with no AI-crawler request. The log covers {d.coverage.firstDay} to {d.coverage.lastDay}; days outside it were not shipped, not quiet.</p>
      </details>
    </>
  );
}

export interface AiVisibilityViewProps {
  siteName: string;
  action: string;
  analyticsHref: string;
  range: { from: string; to: string; error: string | null };
  crawlers: Read<CrawlerSummary>;
  visibility: Read<VisibilitySummary>;
}

export function AiVisibilityView({ siteName, action, analyticsHref, range, crawlers, visibility }: AiVisibilityViewProps) {
  return (
    <div className="wa-page" data-testid="ai-visibility">
      <p className="wc-lede">
        How AI assistants and AI search engines see {siteName}: which AI crawlers fetch its pages (from the web server&apos;s access log),
        and whether the brand is mentioned or cited in AI answers. <Link href={analyticsHref}>Back to visitor analytics</Link>.
      </p>
      <form method="get" action={action} className="wa-range" aria-label="Date range">
        <div className="lux-field"><label className="lux-field__label" htmlFor="av-from">From</label>
          <input id="av-from" name="from" type="date" className="lux-field__control" defaultValue={range.from} /></div>
        <div className="lux-field"><label className="lux-field__label" htmlFor="av-to">To</label>
          <input id="av-to" name="to" type="date" className="lux-field__control" defaultValue={range.to} /></div>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--md">Show</button>
        {range.error ? <p className="wa-range__err" role="alert">{range.error} Showing {range.from} to {range.to}.</p> : null}
      </form>

      <h2 className="av-h">AI crawlers</h2>
      <Gate read={crawlers}>{(c) => (
        <CrawlerGate data={c}>{(d) => {
          const unverified = d.byBot.reduce((n, b) => n + b.unverified, 0);
          const verified = d.byBot.reduce((n, b) => n + b.verified, 0);
          const groups = groupStatus(d.statusMix);
          const maxPath = d.topPaths.reduce((m, p) => Math.max(m, p.hits), 0);
          const maxGroup = groups.reduce((m, g) => Math.max(m, g.hits), 0);
          return (
            <>
              <div className="wa-kpis">
                <KpiTile label="AI-crawler hits" value={fmtHits(d.totalHits)} />
                <KpiTile label="Bots seen" value={fmtHits(d.byBot.length)} />
                {verified + unverified > 0 ? <KpiTile label="Unverified claims" value={fmtHits(unverified)} /> : null}
              </div>
              <div className="wa-grid">
                <Card title="Hits over time, by bot"><OverTime d={d} /></Card>
                <Card title="By bot">
                  <table className="wa-table" data-testid="ai-by-bot">
                    <thead><tr><th>Bot</th><th className="wa-num">Hits</th><th className="wa-num">Verified</th><th className="wa-num">Unverified</th></tr></thead>
                    <tbody>{d.byBot.map((b) => (
                      <tr key={b.bot}><td>{b.bot}</td><td className="wa-num">{fmtHits(b.hits)}</td>
                        <td className="wa-num">{verified + unverified > 0 ? fmtHits(b.verified) : "n/a"}</td>
                        <td className="wa-num">{verified + unverified > 0 ? fmtHits(b.unverified) : "n/a"}</td></tr>
                    ))}</tbody>
                  </table>
                  <p className="wa-foot">
                    {verified + unverified > 0
                      ? "Unverified means the request named an AI crawler but did not come from that vendor's published addresses, so it may be a copycat."
                      : "Verification is off on this server, so every bot is a claim taken from the request's user-agent; n/a means not checked."}
                  </p>
                </Card>
                <Card title="Most crawled pages">
                  <table className="wa-table" data-testid="ai-top-paths">
                    <thead><tr><th>Page</th><th className="wa-num">Hits</th><th aria-hidden="true" /></tr></thead>
                    <tbody>{d.topPaths.map((p) => (
                      <tr key={p.path}><td>{p.path}</td><td className="wa-num">{fmtHits(p.hits)}</td>
                        <td className="wa-barcell" aria-hidden="true"><div className="wa-bar"><span style={{ width: `${Math.max(2, Math.round((p.hits / maxPath) * 100))}%` }} /></div></td></tr>
                    ))}</tbody>
                  </table>
                </Card>
                <Card title="What the site answered">
                  <table className="wa-table" data-testid="ai-status-mix">
                    <thead><tr><th>Answer</th><th className="wa-num">Hits</th><th aria-hidden="true" /></tr></thead>
                    <tbody>{groups.map((g) => (
                      <tr key={g.key} className={g.key === "blocked" || g.key === "server_error" ? "av-warn" : undefined}>
                        <td>{g.label}<span className="av-codes"> {g.statuses.join(", ")}</span></td><td className="wa-num">{fmtHits(g.hits)}</td>
                        <td className="wa-barcell" aria-hidden="true"><div className="wa-bar"><span style={{ width: `${Math.max(2, Math.round((g.hits / maxGroup) * 100))}%` }} /></div></td></tr>
                    ))}</tbody>
                  </table>
                  <p className="wa-foot">Blocked means the site refused the crawler; if that is not intended, check robots rules and firewall settings.</p>
                </Card>
              </div>
            </>
          );
        }}</CrawlerGate>
      )}</Gate>

      <h2 className="av-h">AI answers</h2>
      <Gate read={visibility}>{(v) => v.state !== "ok" ? (
        <p className="wa-note" role="status" data-testid="ai-state-vis-no_data">{v.message}</p>
      ) : (
        <div className="wa-grid">
          <Card title="Brand mentions and citations, by engine">
            {v.anySimulated ? <p className="wa-note av-sim" data-testid="ai-simulated">Some results come from the simulated provider mode: sample data, not real answers.</p> : null}
            <table className="wa-table" data-testid="ai-engines">
              <thead><tr><th>Engine</th><th className="wa-num">Queries</th><th className="wa-num">Mentioned</th><th className="wa-num">Cited</th><th className="wa-num">Changed</th></tr></thead>
              <tbody>{v.engines.map((e) => (
                <tr key={e.engine}><td>{engineLabel(e.engine)}</td><td className="wa-num">{e.queries}</td><td className="wa-num">{e.mentioned}</td><td className="wa-num">{e.cited}</td><td className="wa-num">{e.changed}</td></tr>
              ))}</tbody>
            </table>
            <p className="wa-foot">Newest check per engine and query; &quot;changed&quot; compares it with the check before. Last check {v.lastCapturedAt.slice(0, 10)}.</p>
          </Card>
          <Card title="Latest result per query">
            <table className="wa-table" data-testid="ai-latest">
              <thead><tr><th>Query</th><th>Engine</th><th>Mentioned</th><th>Cited</th></tr></thead>
              <tbody>{v.latest.map((r) => (
                <tr key={`${r.engine}|${r.query}`}>
                  <td>{r.query}</td><td>{engineLabel(r.engine)}{r.simulated ? " (sample)" : ""}</td>
                  <td>{r.brandMentioned ? "Yes" : "No"}{r.changed ? " (changed)" : ""}</td>
                  <td>{r.cited ? (r.citedUrl ? `Yes: ${r.citedUrl}` : "Yes") : "No"}</td>
                </tr>
              ))}</tbody>
            </table>
          </Card>
        </div>
      )}</Gate>
      <p className="wa-foot">The crawler numbers come from access logs shipped by the server team; they are daily counts per bot and page. No visitor address or browser string is kept.</p>
    </div>
  );
}

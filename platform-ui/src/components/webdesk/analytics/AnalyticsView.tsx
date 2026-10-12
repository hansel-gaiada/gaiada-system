import type { ReactNode } from "react";
import Link from "next/link";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import type { AnalyticsReads } from "@/lib/websiteAnalytics";
import {
  barPct, fmtCount, fmtDuration, fmtPct, fmtReach, maxCount,
  type AnalyticsData, type AnalyticsKind, type AnalyticsRead, type Count, type MetricRow,
} from "@/lib/websiteAnalyticsModel";
import "../content/content.css";
import "./analytics.css";

/** A read that is not `ok` becomes words, in place of its table. */
function Gate<K extends AnalyticsKind>({ read, children }: { read: AnalyticsRead<K>; children: (data: AnalyticsData[K]) => ReactNode }) {
  if (read.state !== "ok") {
    return <p className="wa-note" role="status" data-testid={`analytics-state-${read.state}`}>{read.message}</p>;
  }
  return <>{children(read.data)}</>;
}

function Rows({ rows, head, empty }: { rows: MetricRow[]; head: string; empty: string }) {
  // A successful read with zero rows is a real answer ("nothing recorded in this range"), said in words.
  if (rows.length === 0) return empty ? <EmptyNote>{empty}</EmptyNote> : null;
  const max = maxCount(rows.map((r) => r.count));
  return (
    <table className="wa-table">
      <thead><tr><th>{head}</th><th className="wa-num">Count</th><th aria-hidden="true" /></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td className="wa-num">{fmtCount(r.count)}</td>
            <td className="wa-barcell" aria-hidden="true"><div className="wa-bar"><span style={{ width: `${barPct(r.count, max)}%` }} /></div></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const cell = (c: Count) => <td className="wa-num">{fmtCount(c)}</td>;

export interface AnalyticsViewProps {
  siteName: string;
  /** Where the range form submits (this page). */
  action: string;
  range: { from: string; to: string; error: string | null };
  reads: AnalyticsReads;
}

export function AnalyticsView({ siteName, action, range, reads }: AnalyticsViewProps) {
  const sum = reads.summary;
  return (
    <div className="wa-page" data-testid="website-analytics">
      <p className="wc-lede">
        How visitors use {siteName}, from Umami. Visitors who declined analytics are not counted. Any count under 5 shows as &quot;&lt;5&quot; so no small group can be picked out.
      </p>
      <p className="wa-note"><Link href={`${action}/ai-visibility`} data-testid="ai-visibility-link">AI visibility</Link>: which AI crawlers read this site, and whether AI answers mention it.</p>
      <form method="get" action={action} className="wa-range" aria-label="Date range">
        <div className="lux-field"><label className="lux-field__label" htmlFor="wa-from">From</label>
          <input id="wa-from" name="from" type="date" className="lux-field__control" defaultValue={range.from} /></div>
        <div className="lux-field"><label className="lux-field__label" htmlFor="wa-to">To</label>
          <input id="wa-to" name="to" type="date" className="lux-field__control" defaultValue={range.to} /></div>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--md">Show</button>
        {range.error ? <p className="wa-range__err" role="alert">{range.error} Showing {range.from} to {range.to}.</p> : null}
      </form>

      {sum.state !== "ok" ? (
        // Summary failed, so every read would say the same: one notice, no tables, no zeros.
        <div className={`wc-notice${sum.state === "unreachable" || sum.state === "rejected" ? " wc-notice--bad" : ""}`} role="alert" data-testid={`analytics-state-${sum.state}`}>
          <h2>{sum.state === "unreachable" ? "Umami unreachable" : sum.state === "rejected" ? "Umami refused the request" : "Analytics is not available yet"}</h2>
          <p>{sum.message}</p>
        </div>
      ) : (
        <>
          <div className="wa-kpis">
            <KpiTile label="Visitors" value={fmtCount(sum.data.visitors)} />
            <KpiTile label="Visits" value={fmtCount(sum.data.visits)} />
            <KpiTile label="Page views" value={fmtCount(sum.data.pageviews)} />
            <KpiTile label="Bounce rate" value={fmtPct(sum.data.bounceRate)} />
            <KpiTile label="Avg. visit time" value={fmtDuration(sum.data.avgVisitSeconds)} />
          </div>
          <div className="wa-grid">
            <Card title="Top pages"><Gate read={reads.pages}>{(d) => <Rows rows={d} head="Page" empty="No page views recorded in this range." />}</Gate></Card>
            <Card title="Sources">
              <Gate read={reads.sources}>{(d) => (
                <>
                  <p className="wa-ai" data-testid="ai-search-total">AI search (ChatGPT, Perplexity, Gemini, Copilot, Claude): {fmtCount(d.aiSearch.total)} visits</p>
                  <Rows rows={d.aiSearch.hosts} head="AI search referrer" empty="" />
                  <Rows rows={d.referrers} head="All referrers" empty="No external referrers recorded in this range." />
                </>
              )}</Gate>
            </Card>
            <Card title="Section map">
              <Gate read={reads.sections}>{(d) => d.length === 0 ? <EmptyNote>No section views recorded in this range.</EmptyNote> : (
                <>
                  <table className="wa-table">
                    <thead><tr><th>Section</th><th className="wa-num">Views</th><th className="wa-num">Reach</th></tr></thead>
                    <tbody>{d.map((r) => <tr key={r.sectionId}><td>{r.sectionId}</td>{cell(r.views)}<td className="wa-num">{fmtReach(r.reachPct)}</td></tr>)}</tbody>
                  </table>
                  <p className="wa-foot">Reach is section views as a share of page views.</p>
                </>
              )}</Gate>
            </Card>
            <Card title="CTA clicks by location"><Gate read={reads.ctas}>{(d) => <Rows rows={d} head="Where on the page" empty="No button clicks recorded in this range." />}</Gate></Card>
            <Card title="Form funnel">
              <Gate read={reads.forms}>{(d) => d.length === 0 ? <EmptyNote>No form activity recorded in this range.</EmptyNote> : (
                <table className="wa-table">
                  <thead><tr><th>Form</th><th className="wa-num">Started</th><th className="wa-num">Steps</th><th className="wa-num">Sent</th><th className="wa-num">Leads</th></tr></thead>
                  <tbody>{d.map((r) => <tr key={r.formId}><td>{r.formId}</td>{cell(r.lead_form_start)}{cell(r.lead_form_step)}{cell(r.lead_form_send)}{cell(r.generate_lead)}</tr>)}</tbody>
                </table>
              )}</Gate>
            </Card>
            <Card title="Core Web Vitals">
              <Gate read={reads.vitals}>{(d) => (
                <>
                  <Rows rows={d.byMetric} head="Metric reports (LCP, CLS, INP)" empty="No Web Vitals recorded in this range." />
                  <Rows rows={d.byRating} head="Rating (all metrics)" empty="" />
                </>
              )}</Gate>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

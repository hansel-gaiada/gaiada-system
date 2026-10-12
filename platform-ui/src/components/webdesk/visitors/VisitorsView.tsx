import Link from "next/link";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import type { Read } from "@/lib/visitors";
import {
  HEADER_LINE, STATUS_TITLE, fmtWhen, interestChips, placeLabel, shortId, statusWords, whoLabel,
  type ListQuery, type VisitorList, type VisitorStatus,
} from "@/lib/visitorsModel";
import "../content/content.css";
import "./visitors.css";

/** The pipeline's state, in words. `ok` is a quiet line (when it last ingested); anything else is a notice that comes BEFORE the list,
 *  because an empty list is only a claim about a working pipeline. */
function StatusNotice({ status }: { status: Read<VisitorStatus> }) {
  if (status.state === "unavailable") {
    return (
      <div className="wc-notice wc-notice--bad" role="alert" data-testid="visitors-status-unavailable">
        <h2>The visitor pipeline status could not be read</h2>
        <p>{status.message}</p>
      </div>
    );
  }
  const s = status.data;
  if (s.state === "ok") {
    return <p className="wv-note" data-testid="visitors-status-ok">Visitor profiles are being collected. Last successful read: {fmtWhen(s.lastOkIngestAt)}.</p>;
  }
  return (
    <div className={`wc-notice${s.state === "unreachable" || s.state === "rejected" ? " wc-notice--bad" : ""}`} role="alert" data-testid={`visitors-status-${s.state}`}>
      <h2>{STATUS_TITLE[s.state]}</h2>
      <p>{statusWords(s)}</p>
      {s.lastRunAt ? <p className="wv-note">Last run: {fmtWhen(s.lastRunAt)}{s.lastOutcome ? `. ${s.lastOutcome}` : ""}.</p> : null}
    </div>
  );
}

export interface VisitorsViewProps {
  siteName: string;
  /** This page's path, no query. */
  here: string;
  /** `…/visitors/:tenant/:site/` + visitorId is the detail. */
  detailBase: string;
  rulesHref: string;
  status: Read<VisitorStatus>;
  list: Read<VisitorList>;
  query: ListQuery;
  /** Filters the page could not use, named so the viewer knows the list is not filtered by them. */
  ignored: string[];
}

export function VisitorsView({ siteName, here, detailBase, rulesHref, status, list, query, ignored }: VisitorsViewProps) {
  const pipelineOk = status.state === "ok" && status.data.state === "ok";
  const nextHref = (cursor: string) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v && k !== "cursor") p.set(k, v);
    p.set("cursor", cursor);
    return `${here}?${p.toString()}`;
  };
  const filtered = Object.entries(query).some(([k, v]) => !!v && k !== "cursor");

  return (
    <div className="wv-page" data-testid="website-visitors">
      <p className="wc-lede" data-testid="visitors-header">{HEADER_LINE}</p>
      <p className="wv-note">
        {siteName}: who the site&apos;s consented visitors are, from the collector. <Link href={rulesHref} data-testid="interest-rules-link">Interest rules</Link> decide which interests a page visit counts towards.
      </p>

      <StatusNotice status={status} />

      <form method="get" action={here} className="wv-filters" aria-label="Filter visitors">
        <div className="lux-field"><label className="lux-field__label" htmlFor="wv-min">Minimum score</label>
          <input id="wv-min" name="minScore" type="number" min={0} max={100} className="lux-field__control" defaultValue={query.minScore ?? ""} /></div>
        <div className="lux-field"><label className="lux-field__label" htmlFor="wv-order">Order</label>
          <select id="wv-order" name="order" className="lux-field__control" defaultValue={query.order ?? "score"}>
            <option value="score">Highest score first</option><option value="recent">Most recent first</option>
          </select></div>
        <div className="lux-field"><label className="lux-field__label" htmlFor="wv-lead">Lead</label>
          <select id="wv-lead" name="hasLead" className="lux-field__control" defaultValue={query.hasLead ?? ""}>
            <option value="">Any</option><option value="true">Has a lead</option><option value="false">No lead</option>
          </select></div>
        <div className="lux-field"><label className="lux-field__label" htmlFor="wv-facet">Interest kind</label>
          <select id="wv-facet" name="facet" className="lux-field__control" defaultValue={query.facet ?? ""}>
            <option value="">Any</option><option value="industry">Industry</option><option value="service">Service</option>
          </select></div>
        <div className="lux-field"><label className="lux-field__label" htmlFor="wv-tag">Interest tag</label>
          <input id="wv-tag" name="tag" type="text" className="lux-field__control" defaultValue={query.tag ?? ""} /></div>
        <div className="lux-field"><label className="lux-field__label" htmlFor="wv-seen">Seen from</label>
          <input id="wv-seen" name="seenFrom" type="date" className="lux-field__control" defaultValue={query.seenFrom ?? ""} /></div>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--md">Show</button>
      </form>
      {ignored.length > 0 ? <p className="wv-err" role="alert" data-testid="visitors-ignored">Not used, because the value was not valid: {ignored.join(", ")}.</p> : null}

      {list.state === "unavailable" ? (
        <div className="wc-notice wc-notice--bad" role="alert" data-testid="visitors-list-unavailable">
          <h2>The visitor list could not be read</h2>
          <p>{list.message}</p>
          <p className="wv-note">This is not an empty list: nothing is shown because nothing could be read.</p>
        </div>
      ) : list.data.visitors.length === 0 ? (
        <Card title="Visitors">
          {pipelineOk ? (
            <EmptyNote>{filtered ? "No consented visitor matches these filters." : "No visitor who accepted analytics has been recorded for this site yet."}</EmptyNote>
          ) : (
            <p className="wv-note" data-testid="visitors-empty-not-ok">
              Nothing is listed, but the pipeline is not confirmed to be working (see above), so this does not mean the site had no visitors.
            </p>
          )}
        </Card>
      ) : (
        <Card title={`Visitors (${list.data.visitors.length}${list.data.nextCursor ? "+" : ""})`}>
          <table className="wv-table">
            <thead>
              <tr><th>Visitor</th><th>Last seen</th><th className="wv-num">Visits</th><th>Where</th><th>Network or company</th><th>Top interests</th><th className="wv-num">Score</th><th>Lead</th></tr>
            </thead>
            <tbody>
              {/* Rows keep the server's order: this map never sorts. */}
              {list.data.visitors.map((v) => {
                const chips = interestChips(v.interests);
                return (
                  <tr key={v.visitorId} data-testid="visitor-row">
                    <td><Link className="wv-id" href={`${detailBase}/${encodeURIComponent(v.visitorId)}`} data-testid="visitor-id">{shortId(v.visitorId)}</Link></td>
                    <td className="wv-nowrap">{fmtWhen(v.lastSeenAt)}</td>
                    <td className="wv-num">{v.visits}</td>
                    <td>{placeLabel(v)}</td>
                    <td data-testid="visitor-who">{whoLabel(v)}</td>
                    <td>{chips.length ? <div className="wv-chips">{chips.map((t) => <span key={t} className="wc-chip">{t}</span>)}</div> : <span className="wc-muted">none yet</span>}</td>
                    <td className="wv-num">{v.score}</td>
                    <td>{v.lead.state === "linked" ? <span className="wc-chip wc-chip--info" data-testid="lead-linked">Lead linked</span> : <span className="wc-muted">none</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.data.nextCursor ? <p className="wv-actions"><Link href={nextHref(list.data.nextCursor)} data-testid="visitors-next" className="lux-btn lux-btn--ghost lux-btn--sm">Next page</Link></p> : null}
          <p className="wv-note">The score only orders this list. Open a visitor to see how it was made up.</p>
        </Card>
      )}
    </div>
  );
}

import Link from "next/link";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import {
  HEADER_LINE, LEAD_RESTRICTED_WORDS, PART_LABELS, fmtWhen, placeLabel, shortId, whoLabel,
  type ScoreParts, type VisitorDetail, type VisitorEvent,
} from "@/lib/visitorsModel";
import { RecordingsCard, type RecordingsSectionData } from "./RecordingsCard";
import "../content/content.css";
import "./visitors.css";

const dataText = (d: VisitorEvent["data"]): string => (d ? Object.entries(d).map(([k, v]) => `${k}: ${String(v)}`).join(", ") : "");

/** `recordings` is the Recordings card's data, and is only passed for a viewer who holds `search.replay.view` (V6-c): without it there is no card. */
export function VisitorDetailView({
  visitor: v, listHref, recordings, recordingsBase,
}: { visitor: VisitorDetail; listHref: string; recordings?: RecordingsSectionData; recordingsBase?: string }) {
  const partKeys = Object.keys(PART_LABELS) as Array<keyof ScoreParts>;
  const shown = shortId(v.visitorId);
  return (
    <div className="wv-page" data-testid="visitor-detail">
      <p className="wc-lede">{HEADER_LINE}</p>
      <h2 className="wc-lede" data-testid="visitor-detail-id">Visitor {shown}</h2>

      <div className="wv-grid">
        <Card title="Summary">
          <dl className="wv-facts">
            <dt>First seen</dt><dd>{fmtWhen(v.firstSeenAt)}</dd>
            <dt>Last seen</dt><dd>{fmtWhen(v.lastSeenAt)}</dd>
            <dt>Visits</dt><dd>{v.visits}</dd>
            <dt>Page views</dt><dd>{v.pageviews}</dd>
            <dt>Device</dt><dd>{v.device}</dd>
            <dt>Where</dt><dd>{placeLabel(v)}</dd>
            <dt>Network or company</dt><dd>{whoLabel(v)}</dd>
          </dl>
        </Card>

        <Card title={`Score ${v.score}`}>
          <table className="wv-table" data-testid="score-parts">
            <thead><tr><th>Part</th><th className="wv-num">Points</th><th className="wv-num">Most</th></tr></thead>
            <tbody>
              {partKeys.map((k) => <tr key={k}><td>{PART_LABELS[k]}</td><td className="wv-num">{v.scoreParts[k]}</td><td className="wv-num">{v.scoreMax[k]}</td></tr>)}
            </tbody>
          </table>
          <p className="wv-note">The score is the sum of its parts. It is a guide for follow-up and orders the list; nothing acts on it, and no decision is made about a person because of it.</p>
        </Card>

        <Card title="Interests">
          {v.interests.industry.length + v.interests.service.length === 0 ? (
            <EmptyNote>No interests yet. Interests come only from the interest rules, so with no matching rule a visitor has none.</EmptyNote>
          ) : (
            <dl className="wv-facts">
              {v.interests.industry.length ? <><dt>Industry</dt><dd>{v.interests.industry.map((e) => `${e.tag} (${e.score})`).join(", ")}</dd></> : null}
              {v.interests.service.length ? <><dt>Service</dt><dd>{v.interests.service.map((e) => `${e.tag} (${e.score})`).join(", ")}</dd></> : null}
            </dl>
          )}
        </Card>

        <Card title="Linked lead">
          {v.lead.state === "readable" ? (
            <p data-testid="lead-readable"><Link href={`/agency/leads/${encodeURIComponent(v.lead.id)}`} className="lux-btn lux-btn--ghost lux-btn--sm" data-testid="lead-link">Open the lead</Link></p>
          ) : v.lead.state === "restricted" ? (
            <p className="wv-note" data-testid="lead-restricted">This visitor is linked to {v.lead.message || LEAD_RESTRICTED_WORDS}.</p>
          ) : (
            <p className="wv-note" data-testid="lead-none">No lead is linked to this visitor.</p>
          )}
        </Card>
      </div>

      {recordings && recordingsBase ? <RecordingsCard section={recordings} playerBase={recordingsBase} /> : null}

      <Card title={`Timeline (${v.events.length}${v.eventsTruncated ? "+" : ""})`}>
        {v.events.length === 0 ? (
          <EmptyNote>No events are stored for this visitor.</EmptyNote>
        ) : (
          <table className="wv-table" data-testid="visitor-timeline">
            <thead><tr><th>When</th><th>What</th><th>Page</th><th>Details</th></tr></thead>
            <tbody>
              {/* Newest first, as the server sent them: never re-sorted. */}
              {v.events.map((e, i) => (
                <tr key={`${e.occurredAt}-${i}`} data-testid="visitor-event">
                  <td className="wv-nowrap">{fmtWhen(e.occurredAt)}</td>
                  <td>{e.kind === "pageview" ? "Page view" : e.name ?? "Event"}</td>
                  <td>{e.path ?? <span className="wc-muted">none</span>}</td>
                  <td>{dataText(e.data) || <span className="wc-muted">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {v.eventsTruncated ? <p className="wv-note" data-testid="events-truncated">Only the latest 200 events are shown.</p> : null}
      </Card>

      <p className="wv-actions"><Link href={listHref} className="lux-btn lux-btn--ghost lux-btn--sm">Back to all visitors</Link></p>
    </div>
  );
}

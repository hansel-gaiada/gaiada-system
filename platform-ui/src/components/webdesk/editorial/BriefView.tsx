import Link from "next/link";
import { authorLabel } from "@/lib/webdeskContentModel";
import { formatDateTime } from "@/lib/format";
import type { BriefDetail } from "@/lib/webdeskCalendarModel";
import "./editorial.css";

/**
 * A content brief, read-only (`GET …/briefs/:briefId`). The search facts a writer needs: what to target, what readers ask, what is missing
 * from the current content, the outline. The brief's search provenance is never drawn here. Editing is not offered: this page has no
 * action buttons, because the BFF's `allowed` for a brief is not part of the read.
 */
export function BriefView({ brief, boardHref, calendarHref, authors }: { brief: BriefDetail; boardHref: string; calendarHref: string; authors: Record<string, string> }) {
  const list = (items: string[], empty: string, ordered = false) =>
    items.length === 0 ? <p className="wc-muted">{empty}</p> : ordered ? <ol>{items.map((x, i) => <li key={i}>{x}</li>)}</ol> : <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
  return (
    <div className="we-brief" data-testid="brief-view">
      <p className="wc-muted">
        {brief.status === "approved" ? "Approved brief" : "Draft brief"}
        {brief.collectionKey ? ` · ${brief.collectionKey}` : ""}{brief.locale ? ` · ${brief.locale}` : ""}
        {" · "}Assigned to {brief.assigneeId ? authorLabel(brief.assigneeId, authors) : "nobody"}
        {" · "}Updated {formatDateTime(brief.updatedAt)}
      </p>
      <p className="wc-muted" data-testid="brief-links">
        {brief.itemId ? "A draft is linked to this brief: open it from the board or the calendar." : "No draft is linked to this brief yet."}
        {" · "}<Link href={boardHref}>Board</Link>{" · "}<Link href={calendarHref}>Calendar</Link>
      </p>
      <section><h3>TARGET QUERY</h3><p>{brief.targetQuery ?? "None set."}</p></section>
      <section><h3>SEARCH INTENT</h3><p>{brief.searchIntent ?? "None set."}</p></section>
      <section><h3>QUESTIONS READERS ASK</h3>{list(brief.aiQuestions, "None listed.")}</section>
      <section><h3>CONTENT GAPS</h3>{list(brief.contentGaps, "None listed.")}</section>
      <section><h3>OUTLINE</h3>{list(brief.outline, "No outline yet.", true)}</section>
      {brief.geoNotes && <section><h3>GEO NOTES</h3><pre>{brief.geoNotes}</pre></section>}
      {brief.body && <section><h3>NOTES</h3><pre>{brief.body}</pre></section>}
    </div>
  );
}

import Link from "next/link";
import { authorLabel } from "@/lib/webdeskContentModel";
import { otherDates, placementInfo, requestBadge, type CalendarEntry } from "@/lib/webdeskCalendarModel";
import { ReviewStateChip } from "./ReviewStateChip";
import "./editorial.css";

/**
 * One item on the calendar or in the unscheduled list. Links go to the item editor and to the brief; there are NO action buttons here
 * (the review actions live in the editor, driven by `allowed`). The placement kind is a glyph AND a word, never a colour alone.
 */
export function CalendarEntryLine({
  entry, editorBase, briefBase, authors,
}: {
  entry: CalendarEntry;
  editorBase: string;
  /** `…/writers/briefs/:tenant/:site`; a brief link is `${briefBase}/${briefId}`. */
  briefBase: string;
  authors: Record<string, string>;
}) {
  const e = entry;
  const info = e.placement ? placementInfo(e.placement.kind) : null;
  const badge = requestBadge(e.requests);
  const others = otherDates(e);
  return (
    <li className="we-entry" data-testid="calendar-entry" data-placement={e.placement?.kind ?? "none"}>
      <span className="we-entry__top">
        {info && <span className="we-entry__kind" title={info.sentence} data-testid="entry-kind"><span aria-hidden="true">{info.glyph}</span> {info.label}</span>}
        <Link href={`${editorBase}/${encodeURIComponent(e.collectionKey)}/${encodeURIComponent(e.slug)}?locale=${encodeURIComponent(e.locale)}`}>{e.title || e.slug}</Link>
      </span>
      <span className="wc-muted">{e.collectionKey} · {e.locale}{e.inFlow ? "" : " · not in review"}</span>
      {e.inFlow && <ReviewStateChip state={e.reviewState} />}
      <span className="wc-muted">Author: {e.authorSub ? authorLabel(e.authorSub, authors) : "nobody"}</span>
      {others.length > 0 && <span className="wc-muted" data-testid="entry-other-dates">{others.join(" · ")}</span>}
      {badge && <span className="we-badge" data-testid="entry-request">{badge}</span>}
      {e.brief ? (
        <Link href={`${briefBase}/${encodeURIComponent(e.brief.id)}`} className="we-entry__brief" data-testid="entry-brief">Brief: {e.brief.topic}</Link>
      ) : e.briefHidden ? (
        <span className="wc-muted" data-testid="entry-brief-hidden">A brief is linked; you can&apos;t read it.</span>
      ) : e.briefRef ? (
        <span className="wc-muted" data-testid="entry-brief-missing">A brief is linked, but it could not be found.</span>
      ) : null}
    </li>
  );
}

import Link from "next/link";
import { formatNoticeDay, noticeAge, noticeUnitLabel, type NoticeList, type NoticeRow, type NoticeState } from "@/lib/notices";
import type { ReadResult } from "@/lib/readResult";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { NoticeControls } from "./NoticeControls";
import "./notices.css";

// DW-10a-2 (BFF §57.8): the list of notices a page draws, as a pure view of a `ReadResult`. A refused or failed read is a refusal in the list's
// own place and NEVER an empty list: "No current notices" is said only after a read that succeeded. The body is PLAIN TEXT: a text node, with
// its line breaks kept by CSS (`white-space: pre-wrap`), never HTML or Markdown.

function Meta({ row, here, now }: { row: NoticeRow; here: string | null; now: number }) {
  const parts = [
    noticeUnitLabel(row, here),
    row.author.name ? `by ${row.author.name}` : "",
    noticeAge(row.createdAt, now),
    row.editedAt ? "edited" : "",
    row.endsOn ? `${row.state === "past" ? "ended" : "until"} ${formatNoticeDay(row.endsOn)}` : "",
  ].filter(Boolean);
  return <p className="nt-meta">{parts.join(" · ")}</p>;
}

function Notice({ row, tenantId, here, now }: { row: NoticeRow; tenantId: string; here: string | null; now: number }) {
  const read = (
    <>
      <div className="nt-item__head">
        {row.pinned && row.state === "current" && <span className="nt-pin">Pinned</span>}
        <h3 className="nt-item__title">{row.title}</h3>
      </div>
      <Meta row={row} here={here} now={now} />
      <p className="nt-body">{row.body}</p>
    </>
  );
  return (
    <li id={row.id} className="nt-item" data-notice={row.id} data-pinned={row.pinned && row.state === "current" ? "true" : undefined}>
      {row.canEdit ? <NoticeControls tenantId={tenantId} notice={row}>{read}</NoticeControls> : read}
    </li>
  );
}

export function NoticeBoard({ result, tenantId, here, state, nextHref, now = Date.now() }: {
  result: ReadResult<NoticeList>;
  tenantId: string;
  /** The unit whose page this is, so a notice posted to a unit above it reads "From <unit>". Null on the company-wide page. */
  here: string | null;
  state: NoticeState;
  /** The page's address for the next page of results (`nextCursor`), when there is one. */
  nextHref?: string | null;
  now?: number;
}) {
  if (result.kind === "forbidden") return <ReadRefusal subject="this unit's notices" kind="forbidden" detail="A unit's notices are for its people, its heads and the company-wide roles." />;
  if (result.kind === "unavailable") return <ReadRefusal subject="The notices" kind="unavailable" reason={result.reason} />;
  const { items } = result.data;
  if (items.length === 0) {
    return <p className="nt-empty" data-state="empty">{state === "past" ? "No past notices." : "No current notices."}</p>;
  }
  return (
    <>
      <ul className="nt-list" aria-label={state === "past" ? "Past notices" : "Current notices"}>
        {items.map((row) => <Notice key={row.id} row={row} tenantId={tenantId} here={here} now={now} />)}
      </ul>
      {nextHref && <p className="nt-more"><Link href={nextHref} className="nt-link">Next notices</Link></p>}
    </>
  );
}

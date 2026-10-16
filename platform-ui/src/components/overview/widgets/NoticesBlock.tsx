import Link from "next/link";
import type { NoticesBlockView } from "@/lib/overviewNotices";
import { UNAVAILABLE } from "@/lib/overviewWork";
import "@/components/notices/notices.css";

// DW-10a-2: the Overview's notice blocks (BFF §57.8), the department's "Notices" and the company's "Company notices". A pure view of its model
// (`noticesBlockView`): "Unavailable" for a read that did not return data (never an empty block), at most three current notices pinned first
// (title, where it was posted, age, the first 140 characters), "All notices" to the board, and, for a person who may post and has nothing
// current, "No current notices" with "Post a notice". A successful, empty read for someone who may not post draws nothing at all.

export function NoticesBlock({ view, title, allHref }: {
  view: NoticesBlockView;
  /** The block's own name: "Notices" or "Company notices". */
  title: string;
  /** The board: `/departments/<unit>/notices` or `/notices`. */
  allHref: string;
}) {
  if (view.kind === "hidden") return null;
  if (view.kind === "unavailable") {
    return (
      <section className="ov-block ov-block--unavailable" aria-label={title} data-state="unavailable">
        <h3 className="ov-block__title">{title}</h3>
        <p className="ov-block__note">{UNAVAILABLE}</p>
      </section>
    );
  }
  return (
    <section className="ov-block" aria-label={title} data-state={view.rows.length === 0 ? "empty" : "ok"}>
      <h3 className="ov-block__title">{title}</h3>
      {view.rows.length === 0 ? (
        <p className="ov-block__note">No current notices</p>
      ) : (
        <ul className="ov-work__list">
          {view.rows.map((r) => (
            <li key={r.id} className="ov-work__item nt-block__row" data-notice={r.id}>
              <span className="nt-block__line">
                {r.pinned && <span className="nt-pin">Pinned</span>}
                <Link href={r.href} className="ov-work__name">{r.title}</Link>
              </span>
              <span className="ov-work__meta">{[r.unitLabel, r.age].filter(Boolean).join(" · ")}</span>
              <span className="nt-block__excerpt">{r.excerpt}</span>
            </li>
          ))}
        </ul>
      )}
      <span className="nt-block__links">
        <Link href={allHref} className="ov-nums__link">All notices</Link>
        {view.canPost && <Link href={allHref} className="ov-nums__link">Post a notice</Link>}
      </span>
    </section>
  );
}

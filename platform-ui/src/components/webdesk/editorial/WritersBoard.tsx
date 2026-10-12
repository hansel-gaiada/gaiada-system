import Link from "next/link";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import { authorLabel } from "@/lib/webdeskContentModel";
import { groupBoard, REVIEW_STATES, reviewStateInfo, type EditorialBoard } from "@/lib/webdeskEditorialModel";
import { formatDateTime } from "@/lib/format";
import { ReviewStateChip } from "./ReviewStateChip";
import "./editorial.css";

/**
 * `writers/[tenant]/[site]` — the site's review board: the items in the review flow, grouped by review state.
 *
 * COUNTS: `board.counts` is the whole site's per-state count. A caller whose read is scoped to some collections or languages gets
 * `countsWithheld: true` and NO counts (they would disclose the size of what they may not see). That is said in words, and the
 * column heads then show only how many cards are on screen: a withheld count is never drawn as 0.
 */
export function WritersBoard({
  board, editorBase, authors, filters, filterAction, peopleHref, dashboardHref,
}: {
  board: EditorialBoard;
  /** `…/website/content/:tenant/:site` — card links are `${editorBase}/${collection}/${slug}?locale=`. */
  editorBase: string;
  authors: Record<string, string>;
  filters: { state?: string; collection?: string };
  filterAction: string;
  /** The people (grants) page for this site; passed for every viewer: the page itself answers 403 for a non-publisher. */
  peopleHref: string;
  /** M5-W8: the writer dashboard for this site (how the published articles are doing). Optional: absent draws no link. */
  dashboardHref?: string;
}) {
  const reviewOn = board.policies.filter((p) => p.reviewRequired);
  const collections = Array.from(new Set([...board.policies.map((p) => p.collectionKey), ...board.items.map((i) => i.collectionKey)])).sort();
  const cols = groupBoard(board.items);
  const filtered = !!(filters.state || filters.collection);
  const nextHref = board.page.hasMore && board.page.cursor
    ? `${filterAction}?${new URLSearchParams({ ...(filters.state ? { state: filters.state } : {}), ...(filters.collection ? { collection: filters.collection } : {}), cursor: board.page.cursor }).toString()}`
    : null;

  return (
    <div className="wc-page" data-testid="writers-board">
      <p className="wc-lede">
        Everything on this site that is in the review flow, by where it stands. Open an item to read it, comment, send it for review or review it.
        {" "}<Link href={peopleHref} data-testid="people-link">Manage writers</Link>
        {dashboardHref ? <>{" "}<Link href={dashboardHref} data-testid="dashboard-link">Writer dashboard</Link></> : null}
      </p>

      {board.countsWithheld ? (
        <div className="wc-banner wc-banner--info" role="note" data-testid="counts-withheld">
          <span className="wc-banner__body"><strong>Counts are hidden for your access.</strong> The site-wide totals would include items you aren&apos;t allowed to see, so they aren&apos;t shown. The columns below list only the items you can see.</span>
        </div>
      ) : board.counts ? (
        <ul className="we-counts" aria-label="Items per review state" data-testid="board-counts">
          {REVIEW_STATES.map((s) => <li key={s} data-testid={`count-${s}`}>{reviewStateInfo(s).label}: <strong>{board.counts![s]}</strong></li>)}
        </ul>
      ) : null}

      <p className="wc-muted" data-testid="review-policies">
        {reviewOn.length > 0
          ? `Review is turned on for: ${reviewOn.map((p) => `${p.collectionKey}${p.seoSignoffRequired ? " (with SEO sign-off)" : ""}`).join(", ")}.`
          : board.countsWithheld
            ? "No collection you can see has review turned on."
            : "Review is not turned on for any collection on this site yet, so nothing moves through review."}
      </p>

      <form method="get" action={filterAction} className="wc-filter" aria-label="Filter the board">
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="wb-state">Review state</label>
          <select id="wb-state" name="state" className="lux-field__control" defaultValue={filters.state ?? ""}>
            <option value="">Any state</option>
            {REVIEW_STATES.map((s) => <option key={s} value={s}>{reviewStateInfo(s).label}</option>)}
          </select>
        </div>
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="wb-collection">Collection</label>
          <select id="wb-collection" name="collection" className="lux-field__control" defaultValue={filters.collection ?? ""}>
            <option value="">All collections</option>
            {collections.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Apply</button>
        {filtered && <Link href={filterAction} className="lux-btn lux-btn--ghost lux-btn--sm">Clear</Link>}
      </form>

      {board.items.length === 0 ? (
        <Card title="Review board">
          <EmptyNote>{filtered ? "No items match these filters." : "No items are in the review flow yet."}</EmptyNote>
        </Card>
      ) : (
        <div className="we-board">
          {cols.filter((c) => !filters.state || c.state === filters.state || c.state === "other").map((col) => (
            <section key={col.state} className="we-col" aria-labelledby={`wb-h-${col.state}`} data-testid={`col-${col.state}`}>
              <div className="we-col__head">
                <h3 id={`wb-h-${col.state}`} className="wc-group-head" style={{ margin: 0 }}>{col.state === "other"
                    ? <span className="we-state we-state--neutral" data-testid="col-chip-other"><span className="we-state__glyph" aria-hidden="true">?</span>{col.info.label}</span>
                    : <ReviewStateChip state={col.state} testId={`col-chip-${col.state}`} />}</h3>
                <span className="we-col__count" data-testid={`col-count-${col.state}`}>
                  {col.state !== "other" && board.counts ? `${col.items.length} of ${board.counts[col.state]}` : `${col.items.length}`}
                </span>
              </div>
              {col.items.length === 0 ? (
                <p className="wc-muted">{col.state !== "other" && board.counts && board.counts[col.state] > 0 ? "None on this page." : "None."}</p>
              ) : col.items.map((it) => (
                <article key={it.itemId} className="we-card" data-testid="board-card">
                  <Link href={`${editorBase}/${encodeURIComponent(it.collectionKey)}/${encodeURIComponent(it.slug)}?locale=${encodeURIComponent(it.locale)}`}>{it.title || it.slug}</Link>
                  <span className="wc-muted">{it.collectionKey} · {it.locale} · v{it.headVersion}</span>
                  <span className="wc-muted">Author: {it.editorial.authorSub === undefined ? "unknown" : it.editorial.authorSub ? authorLabel(it.editorial.authorSub, authors) : "nobody"}</span>
                  {it.editorial.dueAt && <span className="wc-muted">Due {formatDateTime(it.editorial.dueAt)}</span>}
                  {(it.editorial.openComments ?? 0) > 0 && <span className="wc-muted">{it.editorial.openComments} open comment{it.editorial.openComments === 1 ? "" : "s"}</span>}
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
      {nextHref && <div className="wc-pager"><Link href={nextHref} className="lux-btn lux-btn--ghost lux-btn--sm">Next page</Link></div>}
    </div>
  );
}

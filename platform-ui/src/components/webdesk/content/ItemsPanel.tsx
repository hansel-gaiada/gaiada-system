import Link from "next/link";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import { authorLabel, type ItemListBody } from "@/lib/webdeskContentModel";
import { formatDateTime } from "@/lib/format";
import { isReviewState, reviewStateInfo, REVIEW_STATES } from "@/lib/webdeskEditorialModel";
import { ReviewStateChip } from "../editorial/ReviewStateChip";
import { StateChip } from "./StateChip";
import "../editorial/editorial.css";
import "./content.css";

export const ITEM_STATES = ["draft", "live", "scheduled", "unpublished", "deleted", "pending"] as const;

/** `content/[tenant]/[site]/[collection]` — the item list with locale / state / review state / pending / search
 *  filters. The filters are a plain GET form: the view stays server-rendered and shareable.
 *
 *  REVIEW (M5-W2e): each row shows its review state (words + shape, see `ReviewStateChip`). The review filter is sent to the server
 *  (`?reviewState=`, WebDesk's own filter), so it narrows the WHOLE collection and the pager follows the filtered list. */
export function ItemsPanel({
  list, locales, filters, editorBase, authors, filterAction,
}: {
  list: ItemListBody;
  locales: string[];
  filters: { locale?: string; state?: string; q?: string; review?: string };
  /** `…/[collection]` — item links are `${editorBase}/${slug}?locale=` */
  editorBase: string;
  authors: Record<string, string>;
  filterAction: string;
}) {
  const review = filters.review && isReviewState(filters.review) ? filters.review : undefined;
  const filtered = !!(filters.locale || filters.state || filters.q || review);
  const nextHref = list.page.hasMore && list.page.cursor
    ? `${filterAction}?${new URLSearchParams({ ...(filters.locale ? { locale: filters.locale } : {}), ...(filters.state ? { state: filters.state } : {}), ...(filters.q ? { q: filters.q } : {}), ...(review ? { review } : {}), cursor: list.page.cursor }).toString()}`
    : null;
  // Review column: shown when WebDesk reported a review member for at least one row (an older WebDesk sends none: no column, no claim).
  const showReview = list.items.some((i) => i.editorial !== undefined);
  const rows = list.items;
  return (
    <div className="wc-page">
      <form method="get" action={filterAction} className="wc-filter" aria-label="Filter items">
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="f-locale">Locale</label>
          <select id="f-locale" name="locale" className="lux-field__control" defaultValue={filters.locale ?? ""}>
            <option value="">All locales</option>
            {locales.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="f-state">State</label>
          <select id="f-state" name="state" className="lux-field__control" defaultValue={filters.state ?? ""}>
            <option value="">Any state</option>
            {ITEM_STATES.map((s) => <option key={s} value={s}>{s === "pending" ? "Pending changes" : s}</option>)}
          </select>
        </div>
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="f-review">Review state</label>
          <select id="f-review" name="review" className="lux-field__control" defaultValue={review ?? ""} data-testid="filter-review">
            <option value="">Any review state</option>
            {REVIEW_STATES.map((s) => <option key={s} value={s}>{reviewStateInfo(s).label}</option>)}
          </select>
        </div>
        <div className="lux-field wc-filter__q">
          <label className="lux-field__label" htmlFor="f-q">Search</label>
          <input id="f-q" name="q" className="lux-field__control" defaultValue={filters.q ?? ""} placeholder="Slug or title" />
        </div>
        <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Apply</button>
        {filtered && <Link href={filterAction} className="lux-btn lux-btn--ghost lux-btn--sm">Clear</Link>}
      </form>

      {rows.length === 0 ? (
        <Card title="Items">
          <EmptyNote>{filtered ? "No items match these filters." : "This collection has no items yet."}</EmptyNote>
        </Card>
      ) : (
        <div className="wc-scroll">
          <table className="wc-table" data-testid="items-table">
            <thead>
              <tr><th scope="col">Title</th><th scope="col">Slug</th><th scope="col">Locale</th><th scope="col">State</th>{showReview && <th scope="col">Review</th>}<th scope="col">Head / live</th><th scope="col">Updated</th><th scope="col">By</th></tr>
            </thead>
            <tbody>
              {rows.map((it) => (
                <tr key={it.itemId}>
                  <td><Link href={`${editorBase}/${encodeURIComponent(it.slug)}?locale=${encodeURIComponent(it.locale)}`}>{it.title || it.slug}</Link></td>
                  <td className="wc-mono">{it.slug}</td>
                  <td>{it.locale}</td>
                  <td><StateChip state={it.publishState} deleted={it.deletedAt !== null} />{it.pendingChanges && <> <span className="wc-chip wc-chip--warn">pending changes</span></>}</td>
                  {showReview && (
                    <td data-testid="review-cell">
                      {it.editorial === undefined
                        ? <span className="wc-muted">unknown</span>
                        : it.editorial.reviewRequired
                          ? <ReviewStateChip state={it.editorial.state} testId="row-review-state" />
                          : <span className="wc-muted" title="Review is not turned on for this collection">no review</span>}
                    </td>
                  )}
                  <td>v{it.headVersion} / {it.publishedVersion !== null ? `v${it.publishedVersion}` : "—"}</td>
                  <td>{formatDateTime(it.updatedAt)}</td>
                  <td title={`Last edited ${formatDateTime(it.headCreatedAt)}`}>{authorLabel(it.headCreatedBy, authors)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextHref && <div className="wc-pager"><Link href={nextHref} className="lux-btn lux-btn--ghost lux-btn--sm">Next page</Link></div>}
    </div>
  );
}

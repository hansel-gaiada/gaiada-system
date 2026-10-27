import Link from "next/link";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import { authorLabel } from "@/lib/webdeskContentModel";
import { groupBoard, REVIEW_STATES, reviewStateInfo, type EditorialBoard } from "@/lib/webdeskEditorialModel";
import { formatDateTime } from "@/lib/format";
import { requestBadge, shortDay, dayOf, placementInfo, TRUNCATED_WORDS, type WorkflowCard } from "@/lib/webdeskCalendarModel";
import { ReviewStateChip } from "./ReviewStateChip";
import { WorkflowNav } from "./WorkflowNav";
import "./editorial.css";

/**
 * `writers/[tenant]/[site]` — the site's review board: the items in the review flow, grouped by review state.
 *
 * COUNTS: `board.counts` is the whole site's per-state count. A caller whose read is scoped to some collections or languages gets
 * `countsWithheld: true` and NO counts (they would disclose the size of what they may not see). That is said in words, and the
 * column heads then show only how many cards are on screen: a withheld count is never drawn as 0.
 */
export function WritersBoard({
  board, editorBase, authors, filters, filterAction, peopleHref, workflow, dashboardHref, uploadsHref,
}: {
  /** M5-W5: a `WorkflowBoard` (the calendar read) carries each card's brief, pending publish requests and placement; a plain board draws without them. */
  board: EditorialBoard & { truncated?: boolean };
  /** `…/website/content/:tenant/:site` — card links are `${editorBase}/${collection}/${slug}?locale=`. */
  editorBase: string;
  authors: Record<string, string>;
  filters: { state?: string; collection?: string; locale?: string; assignee?: "me" };
  filterAction: string;
  /** The people (grants) page for this site; passed for every viewer: the page itself answers 403 for a non-publisher. */
  peopleHref: string;
  /** M5-W8: the writer dashboard for this site (how the published articles are doing). Optional: absent draws no link. */
  dashboardHref?: string;
  /**
   * M5-W1q2: the contributor-upload review desk for this site. Passed ONLY when the BFF let this caller read the review queue (its own Cerbos answer,
   * `webdesk_media_asset:review`): absent draws no link, so nobody is sent to a page that would tell them they may not review. `uploadsWaiting` is
   * the number held (`+` when there are more than one page); absent draws the link without a count.
   */
  uploadsHref?: { href: string; waiting?: { count: number; more: boolean } };
  /** M5-W5: the workflow view's extras. Absent = the plain board (no tabs, no locale or "mine" filter, no brief links). */
  workflow?: { calendarHref: string; briefBase: string; locales: readonly string[] };
}) {
  const reviewOn = board.policies.filter((p) => p.reviewRequired);
  const collections = Array.from(new Set([...board.policies.map((p) => p.collectionKey), ...board.items.map((i) => i.collectionKey)])).sort();
  const cols = groupBoard(board.items);
  const filtered = !!(filters.state || filters.collection || filters.locale || filters.assignee);
  const nextHref = board.page.hasMore && board.page.cursor
    ? `${filterAction}?${new URLSearchParams({ ...(filters.state ? { state: filters.state } : {}), ...(filters.collection ? { collection: filters.collection } : {}), cursor: board.page.cursor }).toString()}`
    : null;
  const locales = workflow ? Array.from(new Set([...workflow.locales, ...board.items.map((i) => i.locale)])).sort() : [];

  return (
    <div className="wc-page" data-testid="writers-board">
      {workflow && <WorkflowNav boardHref={filterAction} calendarHref={workflow.calendarHref} current="board" />}
      <p className="wc-lede">
        Everything on this site that is in the review flow, by where it stands. Open an item to read it, comment, send it for review or review it.
        {" "}<Link href={peopleHref} data-testid="people-link">Manage writers</Link>
        {dashboardHref ? <>{" "}<Link href={dashboardHref} data-testid="dashboard-link">Writer dashboard</Link></> : null}
        {uploadsHref ? (
          <>{" "}<Link href={uploadsHref.href} data-testid="uploads-link">
            Uploads awaiting review{uploadsHref.waiting ? ` (${uploadsHref.waiting.count}${uploadsHref.waiting.more ? "+" : ""})` : ""}
          </Link></>
        ) : null}
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

      {board.truncated && (
        <div className="wc-banner wc-banner--warn" role="alert" data-testid="board-truncated">
          <span className="wc-banner__body"><strong>Some items may be missing.</strong> {TRUNCATED_WORDS}</span>
        </div>
      )}

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
        {workflow && (
          <>
            <div className="lux-field">
              <label className="lux-field__label" htmlFor="wb-locale">Language</label>
              <select id="wb-locale" name="locale" className="lux-field__control" defaultValue={filters.locale ?? ""}>
                <option value="">All languages</option>
                {locales.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <label className="we-check" htmlFor="wb-mine">
              <input id="wb-mine" type="checkbox" name="assignee" value="me" defaultChecked={filters.assignee === "me"} /> Assigned to me
            </label>
          </>
        )}
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
              ) : col.items.map((it) => {
                const wf = it as Partial<WorkflowCard>;
                const badge = wf.requests ? requestBadge(wf.requests) : null;
                return (
                <article key={it.itemId} className="we-card" data-testid="board-card">
                  <Link href={`${editorBase}/${encodeURIComponent(it.collectionKey)}/${encodeURIComponent(it.slug)}?locale=${encodeURIComponent(it.locale)}`}>{it.title || it.slug}</Link>
                  <span className="wc-muted">{it.collectionKey} · {it.locale} · v{it.headVersion}</span>
                  <span className="wc-muted">Author: {it.editorial.authorSub === undefined ? "unknown" : it.editorial.authorSub ? authorLabel(it.editorial.authorSub, authors) : "nobody"}</span>
                  {it.editorial.dueAt && <span className="wc-muted">Due {formatDateTime(it.editorial.dueAt)}</span>}
                  {(it.editorial.openComments ?? 0) > 0 && <span className="wc-muted">{it.editorial.openComments} open comment{it.editorial.openComments === 1 ? "" : "s"}</span>}
                  {workflow && it.editorial.plannedPublishAt && <span className="wc-muted" data-testid="card-planned">Planned for {shortDay(dayOf(it.editorial.plannedPublishAt))}</span>}
                  {workflow && wf.placement?.kind === "publish_at" && <span className="wc-muted" data-testid="card-publish-at">{placementInfo("publish_at").label} {shortDay(dayOf(wf.placement.at))}</span>}
                  {badge && <span className="we-badge" data-testid="card-request">{badge}</span>}
                  {workflow && (wf.brief ? (
                    <Link href={`${workflow.briefBase}/${encodeURIComponent(wf.brief.id)}`} data-testid="card-brief">Brief: {wf.brief.topic}</Link>
                  ) : wf.briefHidden ? (
                    <span className="wc-muted" data-testid="card-brief-hidden">A brief is linked; you can&apos;t read it.</span>
                  ) : wf.briefRef ? (
                    <span className="wc-muted" data-testid="card-brief-missing">A brief is linked, but it could not be found.</span>
                  ) : null)}
                </article>
                );
              })}
            </section>
          ))}
        </div>
      )}
      {nextHref && <div className="wc-pager"><Link href={nextHref} className="lux-btn lux-btn--ghost lux-btn--sm">Next page</Link></div>}
    </div>
  );
}

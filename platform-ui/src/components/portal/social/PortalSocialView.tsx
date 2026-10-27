"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { approveAllItems, dayLabel, portalSocialFileHref, surfaceLabel, type PortalSocialPost, type PortalSocialTab } from "@/lib/portalSocial";
import { PortalSocialPostCard } from "./PortalSocialPostCard";
import { PortalSocialStories } from "./PortalSocialStories";
import { useApproveAll } from "./usePostDecision";
import "./portalSocial.css";

// SCP-2 (BFF §63.9) — the month's approval page, the interactive part: the stories circle, the tabs (a server-rendered nav passed in as `tabs`: they are
// links, `?tab=`), and the tab's content: To review (a card per post, with "Approve all"), Grid preview (a 3-column grid by date) or Approved.
//
// ONE place holds what the client has been shown NEW: when a decision is refused with `content_changed` the post is re-read and the new version (with its
// new `reviewHash`) is kept here, so the card, "Approve all" and the story viewer all send the hash of what is on screen now, not the one the page loaded.
//
// THE WAY IN (`?post=<id>`, plan SCP-2f): the server page has already chosen the tab that holds the post; here the post's card is scrolled to and focused,
// or, for a story, the story opens. Focus after a decision: a decided card leaves the list, so focus goes to the list's heading and not to the page's top.
export function PortalSocialView({ tab, items, stories, tenant, tabs, focusPostId, openStoryId, nextHref, missingPost }: {
  tab: PortalSocialTab;
  items: PortalSocialPost[];
  stories: PortalSocialPost[];
  tenant: string;
  /** The tab links (server-rendered). */
  tabs: ReactNode;
  focusPostId: string | null;
  openStoryId: string | null;
  nextHref: string | null;
  /** The `?post=` link named a post this contact cannot see. */
  missingPost: boolean;
}) {
  const [overrides, setOverrides] = useState<Record<string, PortalSocialPost>>({});
  const [storyId, setStoryId] = useState<string | null>(openStoryId);
  const listHeading = useRef<HTMLHeadingElement>(null);

  // The new version wins over the page's copy only while the page's copy is the stale one (a refresh brings the same hash).
  const live = useCallback((p: PortalSocialPost): PortalSocialPost => {
    const o = overrides[p.id];
    return o && o.reviewHash !== p.reviewHash ? o : p;
  }, [overrides]);
  const onReloaded = useCallback((p: PortalSocialPost) => setOverrides((cur) => ({ ...cur, [p.id]: p })), []);
  const shown = useMemo(() => items.map(live), [items, live]);
  const shownStories = useMemo(() => stories.map(live), [stories, live]);

  const focusList = useCallback(() => { setTimeout(() => listHeading.current?.focus(), 0); }, []);
  const closeStory = useCallback(() => {
    setStoryId(null);
    // the ring that opened the viewer may be gone (a decided story leaves the circle): never leave focus on the page's body
    setTimeout(() => { if (document.activeElement === document.body) listHeading.current?.focus(); }, 0);
  }, []);

  useEffect(() => {
    if (!focusPostId || openStoryId) return;
    const el = document.getElementById(`post-${focusPostId}`);
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    el.focus({ preventScroll: true });
  }, [focusPostId, openStoryId]);

  const titles = useMemo(() => new Map(items.map((p) => [p.id, p.title])), [items]);
  const approveAll = useApproveAll(useCallback((id: string) => titles.get(id) ?? "A post", [titles]));
  const [confirming, setConfirming] = useState(false);
  const waiting = tab === "to_review" ? approveAllItems(shown) : [];
  const waitingCount = shown.filter((p) => p.state === "to_review").length;

  const TITLE: Record<PortalSocialTab, string> = { to_review: "Waiting for you", grid: "Grid preview", approved: "Approved" };

  return (
    <>
      {missingPost && (
        <div className="ps-notice" role="status">That post is not available to you. It may have been withdrawn, or belong to another account.</div>
      )}
      <PortalSocialStories stories={shownStories} tenant={tenant} openId={storyId} onOpen={setStoryId} onClose={closeStory} onReloaded={onReloaded} />
      {tabs}

      <section className="ps-list" aria-labelledby="ps-list-h">
        <div className="ps-list__head">
          <h2 id="ps-list-h" className="ps-list__title" tabIndex={-1} ref={listHeading}>{TITLE[tab]} <span className="ps-list__n">({shown.length})</span></h2>
          {waiting.length >= 2 && !confirming && (
            <button type="button" className="btn btn-primary ps-btn" onClick={() => setConfirming(true)} disabled={approveAll.busy}>
              Approve all {waiting.length}
            </button>
          )}
        </div>

        {confirming && (
          <div className="ps-confirm" role="group" aria-label="Confirm approving all">
            <p>
              Approve all {waiting.length} posts shown here{waitingCount > waiting.length ? ` (the first ${waiting.length} of ${waitingCount})` : ""}? Each goes out as you see it, and you can undo for 10 seconds.
              Posts that changed while you were looking are skipped, and we will say which.
            </p>
            <div className="ps-actions">
              <button
                type="button" className="btn btn-primary ps-btn" disabled={approveAll.busy}
                onClick={() => void approveAll.run(waiting.map((w) => ({ postId: w.postId, seenHash: w.seenHash }))).then((done) => { if (done) { setConfirming(false); focusList(); } })}
              >
                {approveAll.busy ? "Approving…" : `Yes, approve all ${waiting.length}`}
              </button>
              <button type="button" className="btn ps-btn" onClick={() => setConfirming(false)} disabled={approveAll.busy}>Not yet</button>
            </div>
            {approveAll.error && <div className="cp-form__error" role="alert">{approveAll.error}</div>}
          </div>
        )}

        {shown.length === 0 ? (
          <p className="ps-empty">
            {tab === "to_review" ? "No posts wait for you here. We will let you know when the next posts are ready."
              : tab === "approved" ? "No approved posts to show yet."
                : "No posts to show here yet."}
          </p>
        ) : tab === "grid" ? (
          <ul className="ps-grid">
            {shown.map((p) => <GridCell key={p.id} post={p} tenant={tenant} />)}
          </ul>
        ) : (
          <div className="ps-feed">
            {shown.map((p) => (
              <PortalSocialPostCard key={p.id} post={p} tenant={tenant} onReloaded={onReloaded} onDecided={focusList} />
            ))}
          </div>
        )}

        {nextHref && <p className="ps-more"><Link className="btn ps-btn" href={nextHref}>Show the next posts</Link></p>}
      </section>
    </>
  );
}

/** What a grid square says under its picture: live posts are published, so they carry no mark; every other state says where the post stands. */
export function gridMark(state: PortalSocialPost["state"]): string | null {
  switch (state) {
    case "live": return null;
    case "to_review": return "To approve";
    case "changes_asked": return "Changes asked";
    default: return "Planned";
  }
}

/** One square of the grid preview: the post's first picture, its day, and a mark when it is still planned (not yet published). Opens the post's own page. */
function GridCell({ post, tenant }: { post: PortalSocialPost; tenant: string }) {
  const img = post.images[0];
  const mark = gridMark(post.state);
  return (
    <li className={`ps-cell${mark ? " ps-cell--planned" : ""}`}>
      <Link href={`/portal/social/${encodeURIComponent(post.id)}`} className="ps-cell__link">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={portalSocialFileHref(tenant, img.thumbFileId)} alt={post.title} loading="lazy" className="ps-cell__img" />
        ) : <span className="ps-cell__none">{post.title}</span>}
        <span className="ps-cell__day">{dayLabel(post.plannedAt)}</span>
        {mark && <span className="ps-cell__mark">{mark}</span>}
        {post.format !== "feed" && <span className="ps-cell__kind">{surfaceLabel(post.format)}</span>}
      </Link>
    </li>
  );
}

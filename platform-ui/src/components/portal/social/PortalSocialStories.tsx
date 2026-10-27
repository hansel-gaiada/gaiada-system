"use client";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/components/overlay/useFocusTrap";
import { decisionLine, networkLabel, portalSocialFileHref, stateLabel, whenLabel, type PortalSocialPost } from "@/lib/portalSocial";
import { PortalSocialChangeDialog } from "./PortalSocialChangeDialog";
import { usePostDecision } from "./usePostDecision";
import "./portalSocial.css";

// SCP-2 (BFF §63.9, plan SCP-2a) — the STORIES CIRCLE: Instagram-style rings, one per story waiting on the client and one per recent live story. A ring
// opens the story full-screen in a 9:16 frame, with the same Approve / Ask for changes controls as the card (the same `usePostDecision`: one decision, the
// same refusals in the same words).
//
// A ring that waits for the client is drawn in the accent; one already decided or live is drawn quietly. The words say the same (the ring's name ends
// "waiting for you"), because a colour alone is not a signal.
//
// THE VIEWER is a dialog: it takes focus when it opens, keeps Tab inside, closes on Escape, locks the page's scroll and gives focus back to the ring that
// opened it. Left and Right move between stories. While "Ask for changes" is open over it, the viewer's own trap steps aside (two traps would both take
// Escape). After a decision the viewer moves on to the next story, or closes on the last one.
/** The ring's visible label, which the button's accessible name starts with (the name must contain the words the eye reads). */
const ringName = (s: PortalSocialPost): string => (s.variants[0]?.handle ?? s.clientName).replace(/^@/, "");

export function PortalSocialStories({ stories, tenant, openId, onOpen, onClose, onReloaded }: {
  stories: PortalSocialPost[];
  tenant: string;
  openId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
  onReloaded: (post: PortalSocialPost) => void;
}) {
  if (stories.length === 0) return null;
  const ix = openId ? stories.findIndex((s) => s.id === openId) : -1;
  return (
    <section className="ps-stories-wrap" aria-label="Stories">
      <ul className="ps-stories">
        {stories.map((s) => {
          const waiting = s.state === "to_review";
          const img = s.images[0];
          return (
            <li key={s.id}>
              <button
                type="button" className={`ps-ring${waiting ? " ps-ring--new" : ""}`} onClick={() => onOpen(s.id)}
                aria-label={`${ringName(s)}: open the story "${s.title}"${waiting ? ", waiting for you" : `, ${stateLabel(s.state).toLowerCase()}`}`}
              >
                <span className="ps-ring__pic">
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={portalSocialFileHref(tenant, img.thumbFileId)} alt="" loading="lazy" />
                  ) : <span className="ps-ring__blank" aria-hidden="true" />}
                </span>
                <span className="ps-ring__label">{ringName(s)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {ix >= 0 && (
        <StoryViewer
          key="viewer" story={stories[ix]} index={ix} count={stories.length} tenant={tenant}
          onClose={onClose} onPrev={() => ix > 0 && onOpen(stories[ix - 1].id)} onNext={() => ix < stories.length - 1 && onOpen(stories[ix + 1].id)}
          onAfterDecision={() => (ix < stories.length - 1 ? onOpen(stories[ix + 1].id) : onClose())} onReloaded={onReloaded}
        />
      )}
    </section>
  );
}

function StoryViewer({ story, index, count, tenant, onClose, onPrev, onNext, onAfterDecision, onReloaded }: {
  story: PortalSocialPost; index: number; count: number; tenant: string;
  onClose: () => void; onPrev: () => void; onNext: () => void; onAfterDecision: () => void; onReloaded: (p: PortalSocialPost) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState(false);
  const decide = usePostDecision(story, onReloaded, onAfterDecision);
  useFocusTrap(ref, !asking, onClose);

  // Focus in on open and back to the ring that opened it on close; the page behind does not scroll meanwhile.
  useEffect(() => {
    const prevActive = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      prevActive?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (asking) return;
      if (e.key === "ArrowLeft") onPrev();
      else if (e.key === "ArrowRight") onNext();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asking, onPrev, onNext]);

  const waiting = story.state === "to_review";
  const img = story.images[0];
  const handle = story.variants[0]?.handle ?? `@${story.clientName}`;
  return (
    <div className="ps-viewer" role="dialog" aria-modal="true" aria-label={`Story: ${story.title}`} tabIndex={-1} ref={ref}>
      <div className="ps-viewer__top">
        <span className="ps-viewer__who"><strong>{handle}</strong> · {story.placement.map(networkLabel).join(", ") || "Story"} · {whenLabel(story.plannedAt)}</span>
        <span className="ps-viewer__pos" role="status">Story {index + 1} of {count}</span>
        <button type="button" className="btn ps-btn" onClick={onClose} aria-label="Close the story">Close</button>
      </div>
      <div className="ps-viewer__stage">
        <button type="button" className="ps-nav ps-nav--prev" onClick={onPrev} disabled={index === 0} aria-label="Previous story">‹</button>
        <div className="ps-media ps-media--story ps-viewer__frame">
          {img ? (
            // The full file, not the thumbnail the circle shows.
            // eslint-disable-next-line @next/next/no-img-element
            <img className="ps-viewer__img" src={portalSocialFileHref(tenant, img.fileId)} alt={img.alt} />
          ) : <div className="ps-media__none">No picture yet</div>}
        </div>
        <button type="button" className="ps-nav ps-nav--next" onClick={onNext} disabled={index === count - 1} aria-label="Next story">›</button>
      </div>
      <div className="ps-viewer__foot">
        <p className="ps-caption"><strong>{story.title}</strong>{story.caption ? `: ${story.caption}` : ""}</p>
        {story.onAssetText && <p className="ps-meta">Words on the story: {story.onAssetText}</p>}
        {decide.notice && <div className="ps-notice" role="status">{decide.notice}</div>}
        {decide.error && <div className="cp-form__error" role="alert">{decide.error}</div>}
        {waiting ? (
          <div className="ps-actions">
            <button type="button" className="btn btn-primary ps-btn" onClick={() => void decide.approve()} disabled={decide.busy} aria-label={`Approve the story ${story.title}`}>Approve</button>
            <button type="button" className="btn ps-btn" onClick={() => setAsking(true)} disabled={decide.busy} aria-label={`Ask for changes to the story ${story.title}`}>Ask for changes</button>
          </div>
        ) : (
          <p className="ps-decision__line">{story.decision ? decisionLine(story.decision) : stateLabel(story.state)}</p>
        )}
      </div>
      <PortalSocialChangeDialog post={story} tenant={tenant} open={asking} onClose={() => setAsking(false)} onSubmit={decide.askChanges} busy={decide.busy} />
    </div>
  );
}

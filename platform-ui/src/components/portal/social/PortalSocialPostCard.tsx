"use client";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { PinOverlay, pinsFromComments, type Pin } from "@/components/social/PinOverlay";
import {
  decisionLine, networkLabel, portalSocialFileHref, stateLabel, stateTone, surfaceLabel, whenLabel, type PortalSocialPost,
} from "@/lib/portalSocial";
import { portalSocialUndo } from "@/lib/portalSocialActions";
import { PortalSocialChangeDialog } from "./PortalSocialChangeDialog";
import { useSocialToasts } from "./PortalSocialToasts";
import { usePostDecision } from "./usePostDecision";
import "./portalSocial.css";

// SCP-2 (BFF §63.9, plan §6.5) — one post as the client reviews it: it LOOKS LIKE THE NETWORK IT WILL APPEAR ON (an Instagram-style card: the
// account's handle, the picture or the carousel, the caption with its hashtags, the date, time and placement; a story or a reel in a 9:16 frame), and
// carries the decision.
//
// THE CONTROLS. A visible "Approve" button is the main control and "Ask for changes" is the other; DOUBLE-TAP on the picture is a SHORTCUT for Approve and
// never the only way (a double-tap alone is not accessible, plan §10). Both go through `usePostDecision`, so a double-tap and a button press are one
// decision (a second while one is in flight is dropped).
//
// IMAGES: the list shows `thumbFileId` through the portal's file route, loaded lazily; the dialog and the story viewer open the full `fileId`.
//
// WHAT IT NEVER SHOWS: a staff status, holder, check or name. A decision recorded by our team reads "Recorded by our team on your behalf (via WhatsApp)"
// and carries no name; the only staff name on the card is the author of a comment written for the client.
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 40;

export function PortalSocialPostCard({ post, tenant, onReloaded, onDecided, detail = false, headingLevel = 3 }: {
  post: PortalSocialPost;
  tenant: string;
  /** The server said the post changed: the page swaps in the new version (and its new `reviewHash`). */
  onReloaded: (post: PortalSocialPost) => void;
  onDecided?: () => void;
  /** The post's own page: every comment and every network's wording shown. */
  detail?: boolean;
  headingLevel?: 2 | 3;
}) {
  const decide = usePostDecision(post, onReloaded, onDecided);
  const toasts = useSocialToasts();
  const [asking, setAsking] = useState(false);
  const [selectedPin, setSelectedPin] = useState<string | null>(null);
  const waiting = post.state === "to_review";
  const handle = post.variants[0]?.handle ?? `@${post.clientName}`;
  const tags = post.hashtags.map((h) => `#${h.replace(/^#/, "")}`);
  const pins = useMemo(() => pinsFromComments(post.comments ?? []), [post.comments]);
  const titleId = `ps-title-${post.id}`;
  const Heading = headingLevel === 2 ? "h2" : "h3";

  // DOUBLE-TAP, the shortcut. A mouse double-click fires `dblclick`; a touch double-tap is detected from two quick, close taps (a browser may or may not
  // synthesise `dblclick` for it, so both are listened to, and the shortcut fires once: `lastFire` drops the second).
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const lastFire = useRef(0);
  const fire = () => {
    const now = Date.now();
    if (!waiting || now - lastFire.current < 600) return;
    lastFire.current = now;
    void decide.approve();
  };
  const fromControl = (e: { target: EventTarget | null }) => (e.target as HTMLElement | null)?.closest?.("button, a, [role='button']") != null;
  const onMediaDoubleClick = (e: ReactMouseEvent) => { if (!fromControl(e)) fire(); };
  const onMediaPointerUp = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse" || fromControl(e)) return;
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && now - prev.t <= DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) <= DOUBLE_TAP_PX) {
      lastTap.current = null;
      fire();
    } else lastTap.current = { t: now, x: e.clientX, y: e.clientY };
  };

  const undoOpen = useUndoWindow(post.decision?.undoUntil);
  async function undoHere() {
    if (!post.decision) return;
    try {
      const r = await portalSocialUndo(post.decision.decisionId, post.id);
      toasts.push(r.ok ? { message: "Undone. The post is back with you." } : { message: r.error ?? "That could not be undone.", tone: "error" });
    } catch {
      toasts.push({ message: "That could not be undone. Refresh the page and try again.", tone: "error" });
    }
  }

  const differing = detail ? post.variants.filter((v) => v.body.trim() !== [post.caption, tags.join(" ")].filter(Boolean).join("\n\n").trim()) : [];
  const clientComments = post.comments ?? [];
  const shownComments = detail ? clientComments : clientComments.slice(0, 2);

  return (
    <article
      id={`post-${post.id}`} className={`ps-card ps-card--${post.format}`} aria-labelledby={titleId} tabIndex={-1} data-post-id={post.id} data-state={post.state}
    >
      <header className="ps-card__head">
        <span className="ps-avatar" aria-hidden="true">{handle.replace(/^@/, "").charAt(0).toUpperCase()}</span>
        <div className="ps-card__who">
          <div className="ps-handle">{[...new Set(post.variants.map((v) => v.handle))].join(" · ") || handle}</div>
          <div className="ps-meta">
            {surfaceLabel(post.format)}
            {post.placement.length > 0 && <> · {post.placement.map(networkLabel).join(", ")}</>}
            {" · "}{whenLabel(post.plannedAt)}
          </div>
        </div>
        <span className="ps-state" style={{ color: `var(--status-${stateTone(post.state)}-fg)` }}>
          <span className="ps-state__dot" aria-hidden="true" style={{ background: `var(--status-${stateTone(post.state)})` }} />
          {stateLabel(post.state)}
        </span>
      </header>

      <Media post={post} tenant={tenant} pins={pins} selectedPin={selectedPin} onSelectPin={(p) => setSelectedPin((cur) => (cur === p.id ? null : p.id))}
        onDoubleClick={onMediaDoubleClick} onPointerUp={onMediaPointerUp} />
      {waiting && <p className="ps-tip">Tip: double-tap the picture to approve it.</p>}

      <div className="ps-card__body">
        <Heading id={titleId} className="ps-title">{post.title}</Heading>
        {post.simulated && <p className="ps-sim">Simulated: this is a rehearsal, not a post on a real account.</p>}
        <p className="ps-caption"><strong>{handle}</strong> {post.caption || <em>No caption yet.</em>}</p>
        {tags.length > 0 && <p className="ps-tags">{tags.map((t) => <span key={t} className="ps-tag">{t}</span>)}</p>}
        {(post.onAssetText || post.cta) && (
          <dl className="ps-facts">
            {post.onAssetText && <div><dt>Words on the picture</dt><dd>{post.onAssetText}</dd></div>}
            {post.cta && <div><dt>Call to action</dt><dd>{post.cta}</dd></div>}
          </dl>
        )}
        {differing.map((v) => (
          <p key={v.id} className="ps-variant"><strong>On {networkLabel(v.network)}:</strong> {v.body}</p>
        ))}

        {shownComments.length > 0 && (
          <div className="ps-comments">
            <h4 className="ps-comments__h">Notes from our team</h4>
            <ul>
              {shownComments.map((c) => {
                const pin = pins.find((p) => p.id === c.id);
                return (
                  <li key={c.id} className="ps-comment">
                    <span className="ps-comment__by">{c.author.name}</span>{" "}
                    <span className="ps-comment__when">{whenLabel(c.createdAt)}</span>
                    <p>{c.body}</p>
                    {pin && (
                      <button type="button" className="cp-linkbtn" aria-pressed={selectedPin === pin.id} onClick={() => setSelectedPin((cur) => (cur === pin.id ? null : pin.id))}>
                        {selectedPin === pin.id ? `Pin ${pin.n} is shown on the picture` : `Show pin ${pin.n} on the picture`}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {!detail && clientComments.length > shownComments.length && <p className="ps-meta">There are more notes on the post&apos;s own page.</p>}
          </div>
        )}

        {decide.notice && <div className="ps-notice" role="status">{decide.notice}</div>}
        {decide.error && <div className="cp-form__error" role="alert">{decide.error}</div>}

        {waiting ? (
          <div className="ps-actions">
            <button type="button" className="btn btn-primary ps-btn" onClick={() => void decide.approve()} disabled={decide.busy} aria-label={`Approve ${post.title}`}>
              Approve
            </button>
            <button type="button" className="btn ps-btn" onClick={() => setAsking(true)} disabled={decide.busy} aria-label={`Ask for changes to ${post.title}`}>
              Ask for changes
            </button>
          </div>
        ) : (
          <div className="ps-decision">
            {post.decision ? (
              <>
                <p className="ps-decision__line">{decisionLine(post.decision)}</p>
                {post.decision.note && <p className="ps-decision__note">&ldquo;{post.decision.note}&rdquo;</p>}
                {post.decision.anchor && <p className="ps-meta">You pinned the spot on the picture.</p>}
                {undoOpen && (
                  <button type="button" className="btn ps-btn" onClick={() => void undoHere()} aria-label={`Undo your decision on ${post.title}`}>Undo</button>
                )}
              </>
            ) : post.state === "changes_asked" ? (
              <p className="ps-decision__line">Our team is working on the changes. We will send it back to you.</p>
            ) : null}
            {post.liveUrl && /^https?:\/\//i.test(post.liveUrl) && (
              <p><a className="ps-link" href={post.liveUrl} target="_blank" rel="noopener noreferrer">View the published post<span className="cp-sr-only"> (opens in a new tab)</span></a></p>
            )}
          </div>
        )}
      </div>

      <PortalSocialChangeDialog post={post} tenant={tenant} open={asking} onClose={() => setAsking(false)} onSubmit={decide.askChanges} busy={decide.busy} />
    </article>
  );
}

/** True while an undo window (`decision.undoUntil`) is open: false on the server and on the first render (the clock is the browser's), then true until it ends. */
function useUndoWindow(undoUntil: string | undefined): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const left = undoUntil ? Date.parse(undoUntil) - Date.now() : 0;
    if (!(left > 0)) { setOpen(false); return; }
    setOpen(true);
    const t = setTimeout(() => setOpen(false), left);
    return () => clearTimeout(t);
  }, [undoUntil]);
  return open;
}

function Media({ post, tenant, pins, selectedPin, onSelectPin, onDoubleClick, onPointerUp }: {
  post: PortalSocialPost; tenant: string; pins: Pin[]; selectedPin: string | null; onSelectPin: (p: Pin) => void;
  onDoubleClick: (e: ReactMouseEvent) => void; onPointerUp: (e: ReactPointerEvent) => void;
}) {
  const [ix, setIx] = useState(0);
  const n = post.images.length;
  return (
    <div className={`ps-media ps-media--${post.format}`} onDoubleClick={onDoubleClick} onPointerUp={onPointerUp}>
      {n === 0 ? (
        <div className="ps-media__none">No picture yet</div>
      ) : (
        post.images.map((img, i) => (
          <div key={img.fileId} className="ps-slide" hidden={i !== ix}>
            <PinOverlay
              src={portalSocialFileHref(tenant, img.thumbFileId)} alt={img.alt} fileId={img.fileId} pins={pins}
              selectedId={selectedPin} onSelectPin={onSelectPin} loading="lazy"
            />
          </div>
        ))
      )}
      {n > 1 && (
        <>
          <button type="button" className="ps-nav ps-nav--prev" onClick={() => setIx((v) => (v + n - 1) % n)} aria-label="Previous picture">‹</button>
          <button type="button" className="ps-nav ps-nav--next" onClick={() => setIx((v) => (v + 1) % n)} aria-label="Next picture">›</button>
          <span className="ps-count" role="status" aria-label={`Picture ${ix + 1} of ${n}`}>{ix + 1} / {n}</span>
        </>
      )}
    </div>
  );
}

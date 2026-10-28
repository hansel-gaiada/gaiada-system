"use client";
// SCP-3d — the Feed preview tab (BFF §63.10): the client's grid, newest date first, three to a row, as an Instagram profile shows it. Planned, in-work, approved,
// scheduled and live posts are all in it; a SWAP of two posts' publish dates is the only thing it does.
//
//   Drag one post onto another, or (the keyboard path, and the one a screen reader uses) press Enter or Space on a post to SELECT it and again on another to swap
//   the two dates; Escape lets go; the arrow keys move between posts. Nothing happens until the second post is chosen.
//   A post whose move asks the client again (approved or scheduled: SCP-Q13) is said so BEFORE the swap, and the swap waits for a confirmation.
//   A live post is locked: it is not draggable, and cannot be picked as either side of a swap. Any other post whose date is locked at its step (with the copywriter,
//   an approver, the designer or the client, or blocked) says so, and is not draggable either.
//
// The server decides everything (the date-move rule, Cerbos, the locks): `dateMove` and the words here are hints so the page can say what will happen before
// the drop; a refusal comes back in the contract's own code and is shown in words. The swap is all or nothing on the server, and this page changes nothing
// on its own until the server has answered.
//
// SCP-Sg (plan §5): the grid is also the client's live feed as the network, or the simulator, reports it. "Last synced <time>" (or "Not synced yet") sits above it;
// each live tile says its reach ("Reach not reported", never "Reach 0", when nobody reported one) and links to the post on the network. A simulated post's address
// (`simulated.invalid`) opens nothing real, so the tile says "Simulated post" instead of linking out.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";
import { swapFeedPreview } from "@/lib/socialClientActions";
import { formatDateTime } from "@/lib/format";
import { lastSyncedText } from "@/lib/socialAccountsSummary";
import { PHASE_LEGEND, formatWords, phaseStyle, postHref, statusLabel } from "@/lib/socialClient";
import {
  FEED_PREVIEW_LIVE_CAP, byNewest, isMovable, liveLinkOf, moveWords, reachText, swapAsksClient, swapDoneText, swapInput, type FeedItem, type SwappedPost,
} from "@/lib/socialFeedPreview";

type Note = { kind: "info" | "ok" | "error"; text: string };

export function FeedPreview({
  deptId, engagementId, items, liveHidden, lastSyncedAt,
}: {
  deptId: string; engagementId: string; items: readonly FeedItem[]; liveHidden: number;
  /** SCP-Sg: the newest sync of the client's accounts; null says "Not synced yet", and a caller that does not read it omits it (nothing is claimed). */
  lastSyncedAt?: string | null;
}) {
  const router = useRouter();
  const [list, setList] = useState<FeedItem[]>(() => [...items]);
  const [picked, setPicked] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ a: FeedItem; b: FeedItem } | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [pending, start] = useTransition();
  const gridRef = useRef<HTMLUListElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const helpId = useId();
  const confirmId = useId();

  // The server re-renders the page after a swap (the action revalidates): the new answer replaces the local one.
  useEffect(() => setList([...items]), [items]);
  useEffect(() => { if (confirm) confirmRef.current?.focus(); }, [confirm]);

  const byId = useMemo(() => new Map(list.map((i) => [i.postId, i])), [list]);
  const titleOf = (id: string): string | null => byId.get(id)?.title ?? null;
  const unlockedCount = list.filter(isMovable).length;

  function clear() { setPicked(null); setConfirm(null); setDragId(null); setOverId(null); }

  /** Two posts are proposed for a swap (a drop, or the second pick). Says what will happen first when the client will be asked again. */
  function propose(aId: string, bId: string) {
    const a = byId.get(aId);
    const b = byId.get(bId);
    if (!a || !b || a.postId === b.postId) return;
    const stuck = [a, b].find((x) => !isMovable(x));
    if (stuck) {
      setNote({ kind: "error", text: `${stuck.title}: ${moveWords(stuck)} Nothing was changed.` });
      setPicked(null);
      return;
    }
    if (a.scheduledAt === b.scheduledAt) {
      setNote({ kind: "error", text: "The two posts are on the same date and time, so there is nothing to swap." });
      setPicked(null);
      return;
    }
    if (swapAsksClient(a, b)) {
      setConfirm({ a, b });
      setNote(null);
      return;
    }
    run(a, b);
  }

  function run(a: FeedItem, b: FeedItem) {
    setConfirm(null);
    setNote({ kind: "info", text: "Swapping the dates…" });
    start(async () => {
      const r = await swapFeedPreview(engagementId, swapInput(a, b), { [a.postId]: a.title, [b.postId]: b.title });
      if (!r.ok) {
        setNote({ kind: "error", text: `${r.message} Nothing was changed.` });
        clear();
        if (r.error === "status_changed" || r.error === "post_not_found") router.refresh();
        return;
      }
      setList((cur) => applySwap(cur, r.posts));
      clear();
      setNote({ kind: "ok", text: swapDoneText(r.posts, titleOf) });
      router.refresh();
    });
  }

  /** A post is chosen (Enter or Space on its tile, or a click): the first choice selects it, the second asks for the swap. */
  function choose(id: string) {
    if (pending) return;
    const it = byId.get(id);
    if (!it) return;
    if (picked === null) {
      if (!isMovable(it)) {
        setNote({ kind: "error", text: `${it.title}: ${moveWords(it)}` });
        return;
      }
      setPicked(id);
      setNote({ kind: "info", text: `${it.title} is selected. Choose another post to swap dates with, or press Escape to let go.` });
      return;
    }
    if (picked === id) {
      setPicked(null);
      setNote({ kind: "info", text: "Selection cleared." });
      return;
    }
    propose(picked, id);
  }

  function onGridKey(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key === "Escape" && (picked !== null || confirm !== null)) {
      e.preventDefault();
      clear();
      setNote({ kind: "info", text: "Nothing was swapped." });
      return;
    }
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? 3 : e.key === "ArrowUp" ? -3 : 0;
    if (step === 0) return;
    const tiles = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-tile]") ?? []);
    const at = tiles.findIndex((t) => t === document.activeElement);
    if (at < 0) return;
    const next = tiles[at + step];
    if (next) { e.preventDefault(); next.focus(); }
  }

  function onDragStart(e: DragEvent<HTMLLIElement>, it: FeedItem) {
    if (!isMovable(it) || pending) { e.preventDefault(); return; }
    setDragId(it.postId);
    setPicked(null);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", it.postId);
    }
  }
  function onDragOver(e: DragEvent<HTMLLIElement>, it: FeedItem) {
    if (!dragId || dragId === it.postId) return;
    e.preventDefault(); // a drop is allowed anywhere: a drop on a locked post is answered in words, not by a silent no-drop cursor
    if (e.dataTransfer) e.dataTransfer.dropEffect = isMovable(it) ? "move" : "none";
    if (overId !== it.postId) setOverId(it.postId);
  }
  function onDrop(e: DragEvent<HTMLLIElement>, it: FeedItem) {
    e.preventDefault();
    const from = dragId ?? e.dataTransfer?.getData("text/plain") ?? null;
    setDragId(null);
    setOverId(null);
    if (from && from !== it.postId) propose(from, it.postId);
  }

  if (list.length === 0) {
    return <p className="scp-note">This client has no dated posts yet, so there is no feed to preview. A planned post with a date appears here.</p>;
  }

  return (
    <section aria-label="Feed preview" className="scp-feedwrap">
      {lastSyncedAt !== undefined && <p className="scp-note scp-feed__sync" data-synced={lastSyncedAt ? "true" : "false"}>{lastSyncedText(lastSyncedAt)}</p>}
      <p id={helpId} className="scp-note scp-feed__help">
        This is the client&apos;s grid, newest first. Drag a post onto another to swap their dates. With the keyboard, press Enter on a post, then Enter on the one to
        swap with; Escape lets go. A post that is approved or scheduled goes back to the client when its date moves. Live posts are locked.
      </p>
      <p className="scp-feed__status" role="status" aria-live="polite" data-kind={note?.kind ?? "none"}>{note?.text ?? ""}</p>

      {confirm && (
        <div className="scp-feed__confirm" role="alertdialog" aria-labelledby={confirmId} aria-describedby={`${confirmId}-d`}>
          <p id={confirmId} className="scp-feed__confirm-title">Swap the dates of &ldquo;{confirm.a.title}&rdquo; and &ldquo;{confirm.b.title}&rdquo;?</p>
          <p id={`${confirmId}-d`} className="scp-feed__confirm-body">
            {[confirm.a, confirm.b].filter((x) => x.dateMove === "reschedule").map((x) => `“${x.title}” is ${statusLabel(x.pipelineStatus).toLowerCase()}`).join(" and ")}
            : its new date goes back to the client, who will be asked to approve it again. A post that is scheduled is taken off its schedule first.
          </p>
          <div className="scp-feed__confirm-act">
            <button ref={confirmRef} type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={() => run(confirm.a, confirm.b)}>
              Swap and ask the client again
            </button>
            <button type="button" className="lux-btn lux-btn--sm" disabled={pending} onClick={() => { clear(); setNote({ kind: "info", text: "Nothing was swapped." }); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <ul ref={gridRef} className="scp-feed" aria-label="The client's posts, newest first" aria-describedby={helpId} aria-busy={pending} onKeyDown={onGridKey}>
        {list.map((it) => {
          const movable = isMovable(it);
          const label = [
            it.title, formatWords(it.format), statusLabel(it.pipelineStatus), formatDateTime(it.scheduledAt), it.simulated ? "Simulated" : null,
            reachText(it) || null, moveWords(it), picked === it.postId ? "Selected" : null,
          ].filter(Boolean).join(". ");
          const live = liveLinkOf(it);
          return (
            <li
              key={it.postId} className="scp-feed__cell" style={phaseStyle(it.phase) as CSSProperties} data-phase={it.phase ?? ""} data-locked={it.locked ? "true" : undefined}
              data-movable={movable ? "true" : "false"} data-picked={picked === it.postId ? "true" : undefined} data-over={overId === it.postId ? "true" : undefined}
              data-dragging={dragId === it.postId ? "true" : undefined} draggable={movable && !pending}
              onDragStart={(e) => onDragStart(e, it)} onDragEnd={() => { setDragId(null); setOverId(null); }} onDragOver={(e) => onDragOver(e, it)}
              onDragLeave={() => { if (overId === it.postId) setOverId(null); }} onDrop={(e) => onDrop(e, it)}
            >
              <button type="button" data-tile className="scp-feed__tile" aria-pressed={picked === it.postId} aria-disabled={!movable || undefined} aria-label={label} onClick={() => choose(it.postId)}>
                <span className="scp-feed__media" data-format={it.format ?? ""}>
                  {it.thumbFileId
                    // eslint-disable-next-line @next/next/no-img-element -- the file route streams the stored bytes; the tile's name carries the post
                    ? <img src={`/api/files/${encodeURIComponent(it.thumbFileId)}`} alt="" loading="lazy" decoding="async" draggable={false} />
                    : <span className="scp-feed__ph" aria-hidden="true">{it.title}</span>}
                </span>
                <span className="scp-feed__cap" aria-hidden="true">
                  <span className="scp-feed__dot" />
                  <span className="scp-feed__st">{statusLabel(it.pipelineStatus)}</span>
                  <span className="scp-feed__when">{formatDateTime(it.scheduledAt)}</span>
                  {it.locked && <span className="scp-feed__reach">{reachText(it)}</span>}
                </span>
                {it.locked && <span className="scp-feed__lock" aria-hidden="true">Live · locked</span>}
                {!it.locked && !movable && <span className="scp-feed__lock" aria-hidden="true">Date locked</span>}
                {it.simulated && <span className="scp-feed__sim" aria-hidden="true">SIMULATED</span>}
              </button>
              <Link href={postHref(deptId, it.postId)} className="scp-feed__open" aria-label={`Open ${it.title}`} draggable={false}>Open</Link>
              {live?.kind === "link" && (
                <a href={live.href} className="scp-feed__live" target="_blank" rel="noopener noreferrer" draggable={false} aria-label={`View ${it.title} on the network (opens in a new tab)`}>
                  View post
                </a>
              )}
              {live?.kind === "simulated" && <span className="scp-feed__live scp-feed__live--sim" title="A simulated post: its address opens nothing real.">Simulated post</span>}
            </li>
          );
        })}
      </ul>

      <ul className="scp-legend" aria-label="Phase colours">
        {PHASE_LEGEND.map((p) => (
          <li key={p.key} className="scp-legend__item">
            <span className="scp-legend__dot" style={{ "--scp-phase": p.token } as CSSProperties} aria-hidden="true" />
            {p.label}
          </li>
        ))}
      </ul>
      <p className="scp-note">
        {liveHidden > 0
          ? `Showing every post that is not live yet and the newest ${FEED_PREVIEW_LIVE_CAP} live posts; ${liveHidden} older live ${liveHidden === 1 ? "post is" : "posts are"} not shown. `
          : ""}
        {unlockedCount < 2 ? "Fewer than two posts can have their date moved, so there is nothing to swap yet." : ""}
      </p>
    </section>
  );
}

/** The list after a swap the server answered: each named post takes the new date and step; one that was asked of the client is now with the client, whose date is locked. */
function applySwap(list: readonly FeedItem[], posts: readonly SwappedPost[]): FeedItem[] {
  const by = new Map(posts.map((p) => [p.postId, p]));
  return list
    .map((i) => {
      const p = by.get(i.postId);
      if (!p) return i;
      return {
        ...i,
        scheduledAt: p.scheduledAt ?? i.scheduledAt,
        pipelineStatus: p.pipelineStatus ?? i.pipelineStatus,
        ...(p.askedClient ? { dateMove: "locked" as const, dateMoveRefusal: "field_locked" as const, phase: "with_client" } : {}),
      };
    })
    .sort(byNewest);
}

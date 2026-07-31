"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Comment } from "@/lib/pm";
import { EmptyNote } from "@/components/systems/EmptyNote";
import "./pm.css";

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

type Res = { ok: boolean; error?: string };

// Closed 8-emoji reaction set (P3-09, locked BE contract). Kept as a plain
// client-safe constant HERE (not lib/pm.ts, which is `server-only`) so this
// popover strip renders with no runtime import of that module.
const REACTION_EMOJI = ["👍", "❤️", "🎉", "👀", "✅", "💡", "🙏", "🔥"] as const;

interface Props {
  comments: Comment[];
  post: (body: string) => Promise<Res>;
  // Optional: ProjectWorkspaceView's generic Discussion thread (lib/entities.ts
  // comments, a plain Comment[] with no `reactions` field) doesn't wire these —
  // its cards simply render with no reaction row rather than a dead-end "+".
  addReaction?: (commentId: string, emoji: string) => Promise<Res>;
  removeReaction?: (commentId: string, emoji: string) => Promise<Res>;
}

export function CommentThread({ comments, post, addReaction, removeReaction }: Props) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    const v = body.trim();
    if (!v) return;
    setBody("");
    startTransition(async () => { await post(v); router.refresh(); });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {comments.length === 0 ? (
        <EmptyNote>No comments yet.</EmptyNote>
      ) : (
        <div className="pm-thread">
          {comments.map((c) => (
            <div key={c.id} className="pm-comment">
              <div className="pm-comment__head">
                <span className="pm-comment__author">{c.author_name ?? "Someone"}</span>
                {c.ai && <span className="pm-ai-badge">AI Tracker</span>}
                <span className="pm-comment__time">{when(c.created_at)}</span>
              </div>
              <div className="pm-comment__body">{c.body}</div>
              {addReaction && removeReaction && (
                <ReactionRow comment={c} addReaction={addReaction} removeReaction={removeReaction} />
              )}
            </div>
          ))}
        </div>
      )}
      <form action={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <textarea
          className="lux-field__control lux-field__control--textarea"
          placeholder="Write a comment…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || !body.trim()}>
            {pending ? "Posting…" : "Comment"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---- per-comment reaction chip row + "+" popover (P3-09) ----
// Hairline chips (accent border + tinted fill when `mine`), toggling off on a
// second click. Optimistic via useTransition + router.refresh(), same pattern
// as StatusSelect/ProgressControl; local state resets whenever the server's
// own `comment.reactions` array changes identity (i.e. after a refresh).
function ReactionRow({ comment, addReaction, removeReaction }: {
  comment: Comment;
  addReaction: (commentId: string, emoji: string) => Promise<Res>;
  removeReaction: (commentId: string, emoji: string) => Promise<Res>;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<Map<string, { count: number; mine: boolean }> | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const base = new Map((comment.reactions ?? []).map((r) => [r.emoji, { count: r.count, mine: r.mine }]));
  useEffect(() => { setOptimistic(null); }, [comment.reactions]);
  const state = optimistic ?? base;
  const shown = REACTION_EMOJI.filter((e) => (state.get(e)?.count ?? 0) > 0);

  // Same open/close/focus-return/Esc contract as ColorSwatchPicker's popover.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node) && e.target !== triggerRef.current) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle(emoji: string) {
    const cur = state.get(emoji);
    const removing = !!cur?.mine;
    const next = new Map(state);
    if (removing) {
      const count = Math.max(0, (cur?.count ?? 1) - 1);
      if (count === 0) next.delete(emoji); else next.set(emoji, { count, mine: false });
    } else {
      next.set(emoji, { count: (cur?.count ?? 0) + 1, mine: true });
    }
    setOptimistic(next);
    setOpen(false);
    triggerRef.current?.focus();
    startTransition(async () => {
      await (removing ? removeReaction(comment.id, emoji) : addReaction(comment.id, emoji));
      router.refresh();
    });
  }

  return (
    <div className="pm-rx-row">
      {shown.map((emoji) => {
        const s = state.get(emoji)!;
        return (
          <button
            key={emoji}
            type="button"
            className={`pm-rx-chip${s.mine ? " pm-rx-chip--mine" : ""}`}
            aria-pressed={s.mine}
            onClick={() => toggle(emoji)}
          >
            <span aria-hidden>{emoji}</span>
            <span className="pm-rx-chip__count">{s.count}</span>
          </button>
        );
      })}
      <span className="pm-rx-add-wrap">
        <button
          type="button"
          ref={triggerRef}
          className="pm-rx-add"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="Add reaction"
          onClick={() => setOpen((o) => !o)}
        >
          +
        </button>
        {open && (
          <div ref={popRef} role="listbox" aria-label="Pick a reaction" className="pm-rx-pop">
            {REACTION_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="option"
                aria-selected={!!state.get(emoji)?.mine}
                className={`pm-rx-pop__item${state.get(emoji)?.mine ? " pm-rx-pop__item--mine" : ""}`}
                onClick={() => toggle(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </span>
    </div>
  );
}

// ---- Follow toggle (P3-09) ----
// Colocated here rather than a new component file: this ticket's file
// ownership covers CommentThread.tsx (already the "use client" boundary for
// PM comments) and TaskDetailView.tsx (a server component that can't hold
// hooks itself) — TaskDetailView imports FollowToggle directly from here.
interface FollowProps {
  me: { id: string; name: string };
  followers: { id: string; name: string }[];
  follow: () => Promise<Res>;
  unfollow: () => Promise<Res>;
}
export function FollowToggle({ me, followers, follow, unfollow }: FollowProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);

  const baseFollowing = followers.some((f) => f.id === me.id);
  const isFollowing = optimistic ?? baseFollowing;
  let displayFollowers = followers;
  if (optimistic === true && !baseFollowing) displayFollowers = [...followers, me];
  if (optimistic === false && baseFollowing) displayFollowers = followers.filter((f) => f.id !== me.id);

  function toggle() {
    const next = !isFollowing;
    setOptimistic(next);
    startTransition(async () => {
      await (next ? follow() : unfollow());
      router.refresh();
    });
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <button
        type="button"
        className="lux-btn lux-btn--ghost lux-btn--sm"
        onClick={toggle}
        disabled={pending}
        aria-pressed={isFollowing}
      >
        <span className="pm-follow-glyph" style={isFollowing ? { color: "var(--status-critical-fg)" } : undefined} aria-hidden>
          {isFollowing ? "♥" : "♡"}
        </span>
        {isFollowing ? "Following" : "Follow"}
      </button>
      {displayFollowers.length > 0 && (
        <span className="pm-follow-meta" title={displayFollowers.map((f) => f.name).join(", ")}>
          {displayFollowers.length} following
        </span>
      )}
    </span>
  );
}

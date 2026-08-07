"use client";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Comment } from "@/lib/pm";
import { EmptyNote } from "@/components/systems/EmptyNote";
import "./pm.css";
// Colocated here rather than a new file, same rationale as `FollowToggle` below: this ticket's
// file ownership is CommentThread.tsx + TaskDetailView.tsx + task-detail.css, and this is the
// only "use client" boundary in that set. The composer's own CSS lives in `task-detail.css`
// (not `pm.css`, which is another agent's file right now) and needs importing here too, because
// `ProjectWorkspaceView`'s Discussion thread mounts this component without ever importing
// `task-detail.css` itself.
import "./task-detail.css";

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

type Res = { ok: boolean; error?: string };

// Closed 8-emoji reaction set (P3-09, locked BE contract). Kept as a plain
// client-safe constant HERE (not lib/pm.ts, which is `server-only`) so this
// popover strip renders with no runtime import of that module. The composer
// (P4-F1) reuses the same set for its emoji-insert button rather than
// inventing a second palette.
const REACTION_EMOJI = ["👍", "❤️", "🎉", "👀", "✅", "💡", "🙏", "🔥"] as const;

// Who `@`-mention can complete to. Same shape as `AssignablePerson` in the
// server-only `lib/pm.ts` (assignable units' member list, the source
// `AssigneePicker` already draws from) — a plain local type rather than a
// value import so this file never needs a runtime import of that module.
export interface MentionCandidate { id: string; name: string }

// ---- minimal, escaped markdown subset (P4-F1) ---------------------------------------------
// Deliberately NOT a markdown library — runtime deps here are capped at 4 (next/react/
// react-dom/server-only) and bold/italic/code/link/list doesn't justify a 5th. Renders straight
// to React elements, never `dangerouslySetInnerHTML`: any literal "<" or "&" the user typed stays
// exactly that, because React escapes text nodes — there is no HTML-injection surface to review.
// A link target must be `http(s)://…` or the whole `[text](url)` span renders as plain text, so a
// `javascript:`/`data:` URI can never become a clickable link.
const MD_INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;

function renderMdInline(text: string, keyBase: string): ReactNode[] {
  return text
    .split(MD_INLINE_RE)
    .filter((part) => part !== "")
    .map((part, i) => {
      const key = `${keyBase}-${i}`;
      if (part.startsWith("`") && part.endsWith("`")) return <code key={key} className="pm-md-code">{part.slice(1, -1)}</code>;
      if (part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("*") && part.endsWith("*")) return <em key={key}>{part.slice(1, -1)}</em>;
      const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (link) return <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer nofollow ugc">{link[1]}</a>;
      return part;
    });
}

/** `-`/`*` lines become one `<ul>`; every other non-blank line is its own paragraph. */
export function renderMiniMarkdown(body: string): ReactNode {
  const lines = body.split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length === 0) return;
    const items = list;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="pm-md-list">
        {items.map((item, i) => <li key={i}>{renderMdInline(item, `li-${blocks.length}-${i}`)}</li>)}
      </ul>,
    );
    list = [];
  };
  lines.forEach((line, i) => {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { list.push(bullet[1]); return; }
    flushList();
    if (line.trim() === "") return;
    blocks.push(<p key={`p-${i}`} className="pm-md-p">{renderMdInline(line, `p-${i}`)}</p>);
  });
  flushList();
  return blocks.length > 0 ? blocks : <p className="pm-md-p pm-desc--empty">Nothing to preview.</p>;
}

interface Props {
  comments: Comment[];
  post: (body: string) => Promise<Res>;
  // Optional: ProjectWorkspaceView's generic Discussion thread (lib/entities.ts
  // comments, a plain Comment[] with no `reactions` field) doesn't wire these —
  // its cards simply render with no reaction row rather than a dead-end "+".
  addReaction?: (commentId: string, emoji: string) => Promise<Res>;
  removeReaction?: (commentId: string, emoji: string) => Promise<Res>;
  // Optional (P4-F1): who `@` can complete to. Absent on the generic Discussion
  // thread, same degrade-gracefully convention as the reactions props above —
  // the `@` toolbar button still inserts the character, it just has nobody to
  // suggest.
  mentionCandidates?: MentionCandidate[];
}

export function CommentThread({ comments, post, addReaction, removeReaction, mentionCandidates }: Props) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState<number | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiPopRef = useRef<HTMLDivElement>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!emojiOpen) return;
    function onDown(e: MouseEvent) {
      if (emojiPopRef.current && !emojiPopRef.current.contains(e.target as Node) && e.target !== emojiBtnRef.current) setEmojiOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setEmojiOpen(false); emojiBtnRef.current?.focus(); }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [emojiOpen]);

  const submit = () => {
    const v = body.trim();
    if (!v) return;
    setBody("");
    setMode("write");
    setMentionQuery(null);
    startTransition(async () => { await post(v); router.refresh(); });
  };

  // Reads the caret straight off the DOM node rather than tracking it in state — the caret moves
  // on every keystroke and click, and mirroring that in React state would just be a slower path to
  // the same value `textarea.selectionStart` already holds.
  function insertAtCursor(insert: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = body.slice(0, start) + insert + body.slice(end);
    setBody(next);
    const pos = start + insert.length;
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
  }

  function handleBodyChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setBody(value);
    if (!mentionCandidates || mentionCandidates.length === 0) { setMentionQuery(null); return; }
    const caret = e.target.selectionStart ?? value.length;
    const m = value.slice(0, caret).match(/@([\w.-]*)$/);
    if (m) { setMentionQuery(m[1]); setMentionAnchor(caret - m[1].length - 1); }
    else { setMentionQuery(null); setMentionAnchor(null); }
  }

  function pickMention(name: string) {
    const el = textareaRef.current;
    if (mentionAnchor == null) return;
    const caret = el?.selectionStart ?? body.length;
    const next = `${body.slice(0, mentionAnchor)}@${name} ${body.slice(caret)}`;
    setBody(next);
    setMentionQuery(null);
    setMentionAnchor(null);
    const pos = mentionAnchor + name.length + 2;
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
  }

  const mentionMatches = mentionQuery !== null && mentionCandidates
    ? mentionCandidates.filter((c) => c.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6)
    : [];

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
        <div className="pm-composer__tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "write"} className={`pm-composer__tab${mode === "write" ? " pm-composer__tab--active" : ""}`} onClick={() => setMode("write")}>Write</button>
          <button type="button" role="tab" aria-selected={mode === "preview"} className={`pm-composer__tab${mode === "preview" ? " pm-composer__tab--active" : ""}`} onClick={() => setMode("preview")}>Preview</button>
        </div>

        {mode === "write" ? (
          <>
            <textarea
              ref={textareaRef}
              className="lux-field__control lux-field__control--textarea"
              placeholder="Write a comment… **bold**, *italic*, `code`, [link](https://…), - list, @mention"
              value={body}
              onChange={handleBodyChange}
            />
            <div className="pm-composer__toolbar">
              <span style={{ position: "relative" }}>
                <button type="button" className="pm-composer__tool" aria-label="Mention someone" onClick={() => insertAtCursor("@")}>@</button>
                {mentionQuery !== null && (
                  <div role="listbox" aria-label="Mention someone" className="pm-mention-pop">
                    {mentionMatches.map((c) => (
                      <button key={c.id} type="button" role="option" className="pm-mention-pop__item" onClick={() => pickMention(c.name)}>{c.name}</button>
                    ))}
                    {mentionMatches.length === 0 && <span className="pm-mention-pop__empty">No match</span>}
                  </div>
                )}
              </span>
              <span style={{ position: "relative" }}>
                <button
                  type="button"
                  ref={emojiBtnRef}
                  className="pm-composer__tool"
                  aria-haspopup="listbox"
                  aria-expanded={emojiOpen}
                  aria-label="Insert emoji"
                  onClick={() => setEmojiOpen((o) => !o)}
                >
                  😊
                </button>
                {emojiOpen && (
                  <div ref={emojiPopRef} role="listbox" aria-label="Insert emoji" className="pm-emoji-pop">
                    {REACTION_EMOJI.map((e) => (
                      <button key={e} type="button" role="option" className="pm-emoji-pop__item" onClick={() => { insertAtCursor(e); setEmojiOpen(false); }}>
                        {e}
                      </button>
                    ))}
                  </div>
                )}
              </span>
            </div>
          </>
        ) : (
          <div className="pm-composer__preview">{renderMiniMarkdown(body)}</div>
        )}

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

// ---- "Set to me" (P4-F4) ----
// One-click on either slot of `Assignee` — the Ball (`assignee.refId`/`kind`) or the Responsible
// (`assignee.responsibleId`), per plan §1.5: two independent slots on one field, not two axes.
// Colocated for the same reason `FollowToggle` is: this ticket's file ownership is
// CommentThread.tsx + TaskDetailView.tsx + task-detail.css, and this is the only "use client"
// boundary in that set — `TaskDetailView` (a server component) binds `taskId` (and, for
// Responsible, the caller's own id) into `act` and renders this.
interface SetToMeProps {
  /** Always `PM_TERMS.setToMe` from the caller — kept as a prop rather than hardcoded here so
   *  this file never inlines the word itself (the vocabulary rule the ticket is pinned on). */
  label: string;
  act: () => Promise<Res>;
}
export function SetToMeButton({ label, act }: SetToMeProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="lux-btn lux-btn--ghost lux-btn--sm"
        disabled={pending}
        onClick={() => startTransition(async () => {
          const r = await act();
          if (r.ok) { setMsg(null); router.refresh(); } else setMsg(r.error ?? "Couldn't set.");
        })}
      >
        {pending ? "Setting…" : label}
      </button>
      {msg && <span className="pm-setme-msg">{msg}</span>}
    </span>
  );
}

// ---- "Today" quick-schedule (P4-F3) ----
// One click to set the due date to the day the server resolved as "today" when it rendered the
// page (never `Date.now()` in a client component — hydration divergence trap, same rule
// `pmUrgency.ts` pins `today` on). `TaskDetailView` binds `rescheduleTask(taskId, task.startDate,
// today)` and passes it in, so this component stays a plain dumb button with no date logic of
// its own — one definition of "today", same as urgency.
export function TodayScheduleButton({ act }: { act: () => Promise<Res> }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <span className="pm-schedule">
      <button
        type="button"
        className="lux-btn lux-btn--ghost lux-btn--sm"
        disabled={pending}
        onClick={() => startTransition(async () => {
          const r = await act();
          if (r.ok) { setMsg(null); router.refresh(); } else setMsg(r.error ?? "Couldn't schedule.");
        })}
      >
        {pending ? "Setting…" : "Today"}
      </button>
      {msg && <span className="pm-schedule-msg">{msg}</span>}
    </span>
  );
}

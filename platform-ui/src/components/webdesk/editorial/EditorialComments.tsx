"use client";
import { useState } from "react";
import { authorLabel } from "@/lib/webdeskContentModel";
import { anchorLabel, validAnchor, type EditorialComment } from "@/lib/webdeskEditorialModel";
import { formatDateTime } from "@/lib/format";
import { locateField } from "../content/ContentChecksCard";
import "./editorial.css";

const BODY_MAX = 4000;

/** Pointers of the fields on the page right now (`data-pointer`), for the "Field" suggestions. Read when the input is focused. */
function pagePointers(): string[] {
  if (typeof document === "undefined") return [];
  const seen = new Set<string>();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-pointer]"))) {
    const p = el.getAttribute("data-pointer");
    if (p && p.startsWith("/") && p.length > 1) seen.add(p);
  }
  return Array.from(seen).slice(0, 80);
}

/**
 * The item's review comments: a list (open first), an "add a comment" form and a Resolve button per open comment. A comment may be
 * anchored to a field by an RFC 6901 pointer (`anchor`); "Show field" scrolls to and focuses that field when the editor has it.
 * `canAdd` / `canResolve` come from the item's `allowed.comment`; with neither the list is read-only. A history that could not be
 * read is said in words (`problem`), never drawn as "no comments".
 */
export function EditorialComments({
  comments, truncated, problem, canAdd, canResolve, busy, authors, onAdd, onResolve,
}: {
  comments: EditorialComment[] | null;
  truncated: boolean;
  /** Why `comments` is null (a sentence). */
  problem: string | null;
  canAdd: boolean;
  canResolve: boolean;
  /** Something is in flight (a command, or the re-read): every control here waits. */
  busy: boolean;
  authors: Record<string, string>;
  /** Resolves true when the comment was added (the form then clears); false keeps what was typed. */
  onAdd: (body: string, anchor: string | undefined) => Promise<boolean>;
  onResolve: (commentId: string) => void;
}) {
  const [body, setBody] = useState("");
  const [anchor, setAnchor] = useState("");
  const [hints, setHints] = useState<string[]>([]);
  const [missed, setMissed] = useState<string | null>(null);

  const anchorTrim = anchor.trim();
  const anchorOk = anchorTrim === "" || validAnchor(anchorTrim);
  const bodyOk = body.trim().length > 0 && body.trim().length <= BODY_MAX;

  const go = (pointer: string) => {
    const el = locateField(pointer);
    if (!el) { setMissed(pointer); return; }
    setMissed(null);
    el.scrollIntoView?.({ block: "center" });
    el.focus?.();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bodyOk || !anchorOk || busy) return;
    const ok = await onAdd(body.trim(), anchorTrim === "" ? undefined : anchorTrim);
    if (ok) { setBody(""); setAnchor(""); }
  };

  const open = (comments ?? []).filter((c) => c.resolvedAt === null);
  const done = (comments ?? []).filter((c) => c.resolvedAt !== null);

  return (
    <section className="we-comments-block" aria-labelledby="we-comments-h" data-testid="editorial-comments">
      <h4 id="we-comments-h" className="wc-group-head">Comments{comments ? ` (${open.length} open)` : ""}</h4>

      {comments === null ? (
        <p className="we-why" role="note" data-testid="comments-unavailable">{problem ?? "The comments could not be loaded."} This is not a statement that there are none.</p>
      ) : comments.length === 0 ? (
        <p className="wc-publish__sub" data-testid="comments-empty">No comments yet.</p>
      ) : (
        <ul className="we-comments">
          {[...open, ...done].map((c) => {
            const where = anchorLabel(c.anchor);
            return (
              <li key={c.id} className={`we-comment${c.resolvedAt ? " we-comment--resolved" : ""}`} data-testid="comment" data-resolved={c.resolvedAt ? "true" : "false"}>
                <span className="we-comment__meta">
                  <strong>{authorLabel(c.authorSub, authors)}</strong>
                  <span>{formatDateTime(c.createdAt)}</span>
                  <span>on v{c.version}</span>
                  {where && <span className="we-anchor" data-testid="comment-anchor">About: {where}</span>}
                  {c.resolvedAt && <span data-testid="comment-resolved">Resolved{c.resolvedBy ? ` by ${authorLabel(c.resolvedBy, authors)}` : ""}</span>}
                </span>
                <p className="we-comment__body">{c.body}</p>
                <span className="we-actions">
                  {c.anchor && c.anchor !== "" && (
                    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => go(c.anchor as string)} data-testid="comment-show-field">Show field</button>
                  )}
                  {!c.resolvedAt && canResolve && (
                    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => onResolve(c.id)} disabled={busy} data-testid="comment-resolve">Resolve</button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {truncated && <p className="wc-publish__sub" role="note">Only the newest comments are shown.</p>}
      {missed && <p className="wc-publish__sub" role="note" data-testid="field-missed">That field isn&apos;t on this form ({missed}).</p>}

      {canAdd ? (
        <form className="we-form" onSubmit={submit} aria-label="Add a comment" data-testid="comment-form">
          <div className="lux-field">
            <label className="lux-field__label" htmlFor="we-comment-body">Add a comment</label>
            <textarea id="we-comment-body" className="lux-field__control lux-field__control--textarea" rows={3} maxLength={BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} data-testid="comment-body" />
          </div>
          <div className="lux-field">
            <label className="lux-field__label" htmlFor="we-comment-anchor">Field (optional)</label>
            <input
              id="we-comment-anchor" className={`lux-field__control${anchorOk ? "" : " lux-field__control--error"}`} list="we-anchor-hints" value={anchor}
              onChange={(e) => setAnchor(e.target.value)} onFocus={() => setHints(pagePointers())}
              placeholder="/blocks/0/props/h1" autoComplete="off" spellCheck={false} aria-invalid={!anchorOk || undefined} data-testid="comment-anchor-input"
            />
            <datalist id="we-anchor-hints">{hints.map((h) => <option key={h} value={h} />)}</datalist>
            {!anchorOk && <span className="lux-field__error">A field reference starts with / (for example /blocks/0/props/h1).</span>}
          </div>
          <div className="we-actions">
            <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={!bodyOk || !anchorOk || busy} data-testid="comment-add">Add comment</button>
          </div>
        </form>
      ) : (
        <p className="we-why" role="note" data-testid="comment-no-add">You can read the comments, but you can&apos;t add one on this item.</p>
      )}
    </section>
  );
}

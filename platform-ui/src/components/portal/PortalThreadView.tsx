"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CONVERSATION_BODY_MAX, formatBytes, linkifyText, messageEditable,
  type PortalMessage, type PortalThread,
} from "@/lib/portal";
import {
  portalEditMessage, portalRetractMessage, type PortalActionResult,
} from "@/lib/portalActions";
import { PortalReplyForm } from "./PortalReplyForm";

// PV4-08 — one conversation: the messages, oldest first, then the reply box (or, on a closed thread, a plain line).
//
// ── ACCESSIBILITY: THE LIST IS NOT A LIVE REGION ──────────────────────────────────────────────────
// The message list is an ordinary <ol>. It is deliberately NOT `role="log"` and carries no `aria-live`: a live region
// around the whole history re-announces it on every refresh (the page re-renders on each live frame and each poll)
// and buries the one thing a screen-reader user wants to know. Instead a SEPARATE, visually hidden, polite status
// region announces only messages that arrived since the page was opened, from other people. The first render
// announces nothing.
//
// ── TEXT ONLY ─────────────────────────────────────────────────────────────────────────────────────
// A body is rendered as React text nodes plus <a> for http(s) URLs (`linkifyText`). There is no
// dangerouslySetInnerHTML and no Markdown, so `<img onerror=...>` in a message shows as those characters.

/** "13 Oct 2026, 14:02". UTC until mounted (so the server and first client render agree), then the reader's own
 *  time zone: a message time that is hours off is worse than a one-frame change. */
export function formatMessageTime(iso: string, local: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
  return d.toLocaleString("en-GB", local ? opts : { ...opts, timeZone: "UTC" }) + (local ? "" : " UTC");
}

function Stamp({ iso, local }: { iso: string; local: boolean }) {
  return <time dateTime={iso} className="cp-msg__time">{formatMessageTime(iso, local)}</time>;
}

function Body({ text }: { text: string }) {
  return (
    <p className="cp-msg__body">
      {linkifyText(text).map((p, i) =>
        p.kind === "link"
          ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow">{p.text}</a>
          : <span key={i}>{p.text}</span>,
      )}
    </p>
  );
}

function sideLabel(m: PortalMessage): string {
  if (m.mine) return "You";
  return m.authorSide === "staff" ? "Our team" : "Your organisation";
}

export function PortalThreadView({ thread, messages, tenant, serverNow }: {
  thread: PortalThread;
  messages: PortalMessage[];
  /** The company id in `/api/:t/portal/files/:id` (the portal's OWN download route). */
  tenant: string;
  /** The server's clock when the page rendered: the first render uses it, so the edit window agrees with the HTML. */
  serverNow: string;
}) {
  const [now, setNow] = useState(() => new Date(serverNow));
  const [local, setLocal] = useState(false);
  const [announce, setAnnounce] = useState<{ n: number; text: string }>({ n: 0, text: "" });
  const seen = useRef<Set<string>>(new Set(messages.map((m) => m.id)));

  // Time zone + a slow tick so the edit/remove controls disappear when the window closes while the page is open.
  useEffect(() => {
    setLocal(true);
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Announce only NEW messages from other people (the page was refreshed by the live stream or the poll).
  useEffect(() => {
    const fresh = messages.filter((m) => !seen.current.has(m.id));
    if (fresh.length === 0) return;
    fresh.forEach((m) => seen.current.add(m.id));
    const others = fresh.filter((m) => !m.mine);
    if (others.length === 0) return;
    const text = others.length === 1
      ? `New message from ${others[0].authorName ?? (others[0].authorSide === "staff" ? "our team" : "your organisation")}`
      : `${others.length} new messages`;
    setAnnounce((a) => ({ n: a.n + 1, text }));
  }, [messages]);

  const closed = thread.status === "closed";
  return (
    <>
      {/* The ONLY live region on the page. Polite: it never interrupts. Keyed so the same text announces again. */}
      <div className="cp-sr-only" role="status" aria-live="polite" aria-atomic="true">
        <span key={announce.n}>{announce.text}</span>
      </div>

      {messages.length === 0 ? (
        <p className="cp-field__hint">No messages yet.</p>
      ) : (
        <ol className="cp-msgs" aria-label="Messages, oldest first">
          {messages.map((m) => (
            <MessageItem key={m.id} m={m} threadId={thread.id} tenant={tenant} now={now} local={local} />
          ))}
        </ol>
      )}

      <div style={{ marginTop: 20 }}>
        {closed ? (
          <div className="cp-callout cp-callout--calm" role="note">
            <strong style={{ font: "600 14px/1.4 var(--font-body)", color: "var(--ink-strong)" }}>This conversation is closed</strong>
            <p style={{ margin: "4px 0 0", font: "400 13px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
              Our team closed it, so it can&apos;t take new messages. If something is still open,{" "}
              <Link href="/portal/conversation" style={{ color: "var(--ink-strong)", textDecoration: "underline" }}>start a new conversation</Link>.
            </p>
          </div>
        ) : (
          <PortalReplyForm threadId={thread.id} />
        )}
      </div>
    </>
  );
}

function MessageItem({ m, threadId, tenant, now, local }: {
  m: PortalMessage; threadId: string; tenant: string; now: Date; local: boolean;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const editBtn = useRef<HTMLButtonElement>(null);
  const editable = messageEditable(m, now);
  const wasEditing = useRef(false);

  // Back from the editor: put focus on the control that opened it (the form unmounted under the cursor).
  useEffect(() => {
    if (mode === "view" && wasEditing.current) editBtn.current?.focus();
    wasEditing.current = mode !== "view";
  }, [mode]);

  const name = m.mine ? "You" : (m.authorName ?? (m.authorSide === "staff" ? "Our team" : "A colleague"));
  if (m.retracted) {
    return (
      <li className={`cp-msg cp-msg--removed${m.mine ? " cp-msg--mine" : ""}`} tabIndex={-1}>
        <div className="cp-msg__head">
          <span className="cp-msg__who">{name}</span>
          <Stamp iso={m.createdAt} local={local} />
        </div>
        <p className="cp-msg__body">Message removed</p>
      </li>
    );
  }
  return (
    <li className={`cp-msg${m.mine ? " cp-msg--mine" : ""}`} tabIndex={-1}>
      <div className="cp-msg__head">
        <span className="cp-msg__who">{name}</span>
        {!m.mine && <span className="cp-msg__side">{sideLabel(m)}</span>}
        <Stamp iso={m.createdAt} local={local} />
        {m.edited && (
          <span className="cp-msg__edited" title={m.editedAt ? formatMessageTime(m.editedAt, local) : undefined}>edited</span>
        )}
      </div>

      {mode === "edit" ? (
        <EditForm m={m} threadId={threadId} onDone={() => setMode("view")} />
      ) : (
        <Body text={m.body ?? ""} />
      )}

      {m.attachments.length > 0 && (
        <ul className="cp-msg__files" aria-label="Attached files">
          {m.attachments.map((a) => (
            <li key={a.id}>
              {/* The portal's OWN download route (§16b): never the staff `/files/:id/content`. */}
              <a className="cp-msg__file" href={`/api/${tenant}/portal/files/${a.id}`} download>
                {a.filename} ({formatBytes(a.byteSize)})
              </a>
            </li>
          ))}
        </ul>
      )}

      {editable && mode !== "edit" && (
        <div className="cp-msg__actions">
          {mode === "confirm" ? (
            <RetractForm m={m} threadId={threadId} onCancel={() => setMode("view")} />
          ) : (
            <>
              <button type="button" className="cp-linkbtn" ref={editBtn} onClick={() => setMode("edit")}
                      aria-label={`Edit your message from ${formatMessageTime(m.createdAt, local)}`}>
                Edit
              </button>
              <button type="button" className="cp-linkbtn" onClick={() => setMode("confirm")}
                      aria-label={`Remove your message from ${formatMessageTime(m.createdAt, local)}`}>
                Remove
              </button>
              <span className="cp-msg__hint">
                You can change this until {m.editableUntil ? formatMessageTime(m.editableUntil, local) : ""}.
              </span>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function EditForm({ m, threadId, onDone }: { m: PortalMessage; threadId: string; onDone: () => void }) {
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(portalEditMessage, null);
  const [text, setText] = useState(m.body ?? "");
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { area.current?.focus(); }, []);
  useEffect(() => { if (state?.ok) onDone(); }, [state, onDone]);
  const over = text.length > CONVERSATION_BODY_MAX;
  return (
    <form action={formAction} className="cp-form" aria-label="Editing your message">
      <input type="hidden" name="messageId" value={m.id} />
      <input type="hidden" name="threadId" value={threadId} />
      {state && !state.ok && <div className="cp-form__error" role="alert">{state.error}</div>}
      <div className="cp-field">
        <label className="cp-field__label" htmlFor={`cv-edit-${m.id}`}>Edit your message</label>
        <textarea id={`cv-edit-${m.id}`} ref={area} className="cp-textarea" name="body" rows={4}
                  value={text} onChange={(e) => setText(e.target.value)} disabled={pending}
                  aria-invalid={over ? true : undefined} />
        {over && <span className="cp-composer__count cp-composer__count--over" role="status">
          {text.length.toLocaleString("en-US")} of {CONVERSATION_BODY_MAX.toLocaleString("en-US")} characters. Shorten it.
        </span>}
      </div>
      <div className="cp-composer__row">
        <button type="submit" className="btn btn-primary" disabled={pending || over || text.trim().length === 0}>
          {pending ? "Saving…" : "Save changes"}
        </button>
        <button type="button" className="btn" onClick={onDone} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}

function RetractForm({ m, threadId, onCancel }: { m: PortalMessage; threadId: string; onCancel: () => void }) {
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(portalRetractMessage, null);
  return (
    <form action={formAction} className="cp-composer__row" aria-label="Remove your message">
      <input type="hidden" name="messageId" value={m.id} />
      <input type="hidden" name="threadId" value={threadId} />
      {state && !state.ok && <span className="cp-form__error" role="alert">{state.error}</span>}
      <span className="cp-msg__hint">Remove this message for everyone?</span>
      <button type="submit" className="cp-linkbtn" disabled={pending}>{pending ? "Removing…" : "Yes, remove it"}</button>
      <button type="button" className="cp-linkbtn" onClick={onCancel} disabled={pending}>Keep it</button>
    </form>
  );
}

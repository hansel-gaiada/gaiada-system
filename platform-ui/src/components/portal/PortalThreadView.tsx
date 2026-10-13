"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatBytes, type PortalMessage, type PortalThread } from "@/lib/portal";
import { linkify } from "@/lib/linkify";
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
// A body is rendered as React text nodes plus <a> for http(s) URLs (`linkify`). There is no
// dangerouslySetInnerHTML and no Markdown, so `<img onerror=...>` in a message shows as those characters.
//
// ── MESSAGES ARE PERMANENT (PV-D34) ───────────────────────────────────────────────────────────────
// There is no edit and no remove: a message is final from the moment it is posted, and a correction is a new message.
// The composer says so (PortalComposerFields). Nothing here renders "edited" or "Message removed".

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
      {linkify(text).map((p, i) =>
        p.type === "link"
          ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow">{p.value}</a>
          : <span key={i}>{p.value}</span>,
      )}
    </p>
  );
}

function sideLabel(m: PortalMessage): string {
  if (m.mine) return "You";
  return m.authorSide === "staff" ? "Our team" : "Your organisation";
}

export function PortalThreadView({ thread, messages, tenant }: {
  thread: PortalThread;
  messages: PortalMessage[];
  /** The company id in `/api/:t/portal/files/:id` (the portal's OWN download route). */
  tenant: string;
}) {
  const [local, setLocal] = useState(false);
  const [announce, setAnnounce] = useState<{ n: number; text: string }>({ n: 0, text: "" });
  const seen = useRef<Set<string>>(new Set(messages.map((m) => m.id)));

  // Switch message times from UTC to the reader's own time zone once mounted.
  useEffect(() => { setLocal(true); }, []);

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
            <MessageItem key={m.id} m={m} tenant={tenant} local={local} />
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

function MessageItem({ m, tenant, local }: { m: PortalMessage; tenant: string; local: boolean }) {
  const name = m.mine ? "You" : (m.authorName ?? (m.authorSide === "staff" ? "Our team" : "A colleague"));
  return (
    <li className={`cp-msg${m.mine ? " cp-msg--mine" : ""}`} tabIndex={-1}>
      <div className="cp-msg__head">
        <span className="cp-msg__who">{name}</span>
        {!m.mine && <span className="cp-msg__side">{sideLabel(m)}</span>}
        <Stamp iso={m.createdAt} local={local} />
      </div>

      <Body text={m.body} />

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
    </li>
  );
}

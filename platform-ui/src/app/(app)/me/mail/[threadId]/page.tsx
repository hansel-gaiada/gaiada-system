import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { readGmailStatus, readThread } from "@/lib/gmail-data";
import { NOT_CONNECTED_TEXT, NO_MAILBOX_FOR_ROLE, replyDraft } from "@/lib/gmail";
import { formatDateTime } from "@/lib/format";
import { Card } from "@/components/ui";
import { SimulatedLabel } from "@/components/mail/SimulatedLabel";
import { MessageBody } from "@/components/mail/MessageBody";
import { ComposeForm } from "@/components/mail/ComposeForm";
import "@/components/mail/mail.css";

// `/me/mail/[threadId]`: one conversation, rendered on demand (BFF §48.3). HTML bodies show only in a `sandbox=""` iframe, text as text,
// attachments by name only. Nothing is kept.
export default async function MailThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { threadId } = await params;
  if (!tenant) return <p className="gm-note">Select a company first.</p>;

  const status = await readGmailStatus(userId, tenant);
  if (status.kind === "forbidden") return <Card><p className="gm-note">{NO_MAILBOX_FOR_ROLE}</p></Card>;
  if (status.kind === "unavailable") return <Card><p className="gm-note" role="alert">{status.reason}</p></Card>;
  if (!status.data.connected) {
    return <Card><SimulatedLabel mode={status.data.mode} /><p className="gm-note">{NOT_CONNECTED_TEXT}</p><Link href="/me/mail" className="lux-btn lux-btn--ghost lux-btn--sm">Go to Mail</Link></Card>;
  }

  const thread = await readThread(userId, tenant, threadId);
  if (thread.kind === "forbidden") return <Card><p className="gm-note">{NO_MAILBOX_FOR_ROLE}</p></Card>;
  if (thread.kind === "unavailable") {
    return <Card><SimulatedLabel mode={status.data.mode} /><p className="gm-note" role="alert">{thread.reason}</p><Link href="/me/mail" className="lux-btn lux-btn--ghost lux-btn--sm">Back to Mail</Link></Card>;
  }

  const t = thread.data;
  const draft = replyDraft(t, status.data.accountEmail);
  return (
    <Card title={t.messages[0]?.subject || "(no subject)"} headerRight={<Link href="/me/mail" className="lux-btn lux-btn--ghost lux-btn--sm">Back to Mail</Link>}>
      <SimulatedLabel mode={status.data.mode} />
      {t.messages.map((m) => (
        <article key={m.id} className="gm-msg">
          <div className="gm-head">
            <span>From: {m.from}</span>
            <span>To: {m.to}</span>
            {m.cc && <span>Cc: {m.cc}</span>}
            <span>{formatDateTime(m.date)}</span>
          </div>
          <MessageBody text={m.text} html={m.html} />
          {m.attachments.length > 0 && (
            <p className="gm-attach">Attachments (names only): {m.attachments.map((a) => a.filename).join(", ")}</p>
          )}
        </article>
      ))}
      {draft && (
        <details className="gm-actions" style={{ display: "block" }}>
          <summary className="lux-btn lux-btn--solid lux-btn--sm" style={{ display: "inline-block" }}>Reply</summary>
          <div style={{ marginTop: 16 }}>
            <ComposeForm initial={{ to: draft.to, subject: draft.subject }} inReplyTo={draft.inReplyTo} submitLabel="Send reply" />
          </div>
        </details>
      )}
    </Card>
  );
}

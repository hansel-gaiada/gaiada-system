import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { readGmailStatus, readThreads } from "@/lib/gmail-data";
import {
  NEEDS_RECONNECT_TEXT, NOT_CONFIGURED_TEXT, NOT_CONNECTED_TEXT, NO_MAILBOX_FOR_ROLE, isMailLabel, type MailLabel,
} from "@/lib/gmail";
import { formatDateTime } from "@/lib/format";
import { Card } from "@/components/ui";
import { SimulatedLabel } from "@/components/mail/SimulatedLabel";
import { ConnectGmail } from "@/components/mail/ConnectGmail";
import { DisconnectGmail } from "@/components/mail/DisconnectGmail";
import "@/components/mail/mail.css";

// `/me/mail`: your OWN mailbox through Gmail (DW-8j, BFF §48). Rendered on demand: nothing from the mailbox is cached or stored.
// Honest states: no mailbox for the role, not set up, not connected, needs a reconnect, unreachable. A failed read is a sentence,
// never an empty mailbox.
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function MailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const sp = await searchParams;
  if (!tenant) return <p className="gm-note">Select a company first.</p>;

  const status = await readGmailStatus(userId, tenant);
  if (status.kind === "forbidden") return <Card><p className="gm-note">{NO_MAILBOX_FOR_ROLE}</p></Card>;
  if (status.kind === "unavailable") return <Card><p className="gm-note" role="alert">{status.reason}</p></Card>;
  const st = status.data;

  if (!st.configured) {
    return <Card><SimulatedLabel mode={st.mode} /><p className="gm-note">{NOT_CONFIGURED_TEXT}</p></Card>;
  }
  if (!st.connected) {
    return (
      <Card>
        <SimulatedLabel mode={st.mode} />
        <p className="gm-note">{st.needsReconnect ? NEEDS_RECONNECT_TEXT : NOT_CONNECTED_TEXT}</p>
        <ConnectGmail label={st.needsReconnect ? "Reconnect your Gmail" : "Connect your Gmail"} />
      </Card>
    );
  }

  const label: MailLabel = isMailLabel(one(sp.label)) ? (one(sp.label) as MailLabel) : "INBOX";
  const pageToken = one(sp.pageToken) ?? null;
  const threads = await readThreads(userId, tenant, label, pageToken);
  const href = (l: MailLabel, token?: string | null) => {
    const q = new URLSearchParams({ label: l });
    if (token) q.set("pageToken", token);
    return `/me/mail?${q.toString()}`;
  };

  return (
    <Card
      title={st.accountEmail ? `Mail · ${st.accountEmail}` : "Mail"}
      headerRight={<Link href="/me/mail/new" className="lux-btn lux-btn--solid lux-btn--sm">New message</Link>}
    >
      <SimulatedLabel mode={st.mode} />
      {one(sp.sent) === "1" && <p className="gm-note" role="status">Sent</p>}
      <nav className="gm-switch" aria-label="Mailbox">
        <Link href={href("INBOX")} aria-current={label === "INBOX" ? "page" : undefined}>Inbox</Link>
        <Link href={href("SENT")} aria-current={label === "SENT" ? "page" : undefined}>Sent</Link>
      </nav>
      {threads.kind === "forbidden" ? (
        <p className="gm-note">{NO_MAILBOX_FOR_ROLE}</p>
      ) : threads.kind === "unavailable" ? (
        <p className="gm-note" role="alert">{threads.reason}</p>
      ) : threads.data.threads.length === 0 ? (
        <p className="gm-note">{label === "SENT" ? "Nothing in Sent." : "Your inbox is empty."}</p>
      ) : (
        <ul className="gm-list">
          {threads.data.threads.map((t) => (
            <li key={t.id} className={`gm-row${t.unread ? " gm-row--unread" : ""}`}>
              <Link href={`/me/mail/${encodeURIComponent(t.id)}`}>
                <span className="gm-dot" role="img" aria-label={t.unread ? "Unread" : "Read"} style={t.unread ? undefined : { visibility: "hidden" }} />
                <span>
                  <span className="gm-subject">{t.subject || "(no subject)"}</span>
                  <span className="gm-meta"> · {t.from}</span>
                  {t.snippet && <span className="gm-snippet">{t.snippet}</span>}
                </span>
                <span className="gm-meta">{formatDateTime(t.lastMessageDate)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {threads.kind === "ok" && (
        <div className="gm-actions">
          {pageToken && <Link href={href(label)} className="lux-btn lux-btn--ghost lux-btn--sm">Newest</Link>}
          {threads.data.nextPageToken && (
            <Link href={href(label, threads.data.nextPageToken)} className="lux-btn lux-btn--ghost lux-btn--sm">Older</Link>
          )}
        </div>
      )}
      <DisconnectGmail />
    </Card>
  );
}

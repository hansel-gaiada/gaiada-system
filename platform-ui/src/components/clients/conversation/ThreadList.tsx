import Link from "next/link";
import { sortThreads, threadScope, threadTitle, type StaffThread } from "@/lib/conversation";
import { formatDateTime } from "@/lib/format";
import { ClientVisibilityMarker } from "@/components/clients/ClientVisibilityMarker";
import { EmptyNote } from "@/components/systems/EmptyNote";
import "./conversation.css";

// PV4-09 — a client's conversation threads. "Awaiting our reply" first, then by last activity (`sortThreads`).
// Each row says, in words and not only colour: awaiting our reply, how many messages are unread, how many
// agent drafts are waiting for a person. "Client sees this" comes from the backend's field (trap 9).
// Server-renderable on purpose (no hooks): the hub page and the project panel both mount it.
export function ThreadList({ threads, clientId }: { threads: StaffThread[]; clientId: string }) {
  if (threads.length === 0) {
    return <EmptyNote>No conversations with this client yet. Start one below, and the client will see it in their portal.</EmptyNote>;
  }
  return (
    <ul className="cv-list" aria-label="Conversations">
      {sortThreads(threads).map((t) => (
        <li key={t.id} className="cv-list__item" data-thread-id={t.id}>
          <Link className="cv-list__title" href={`/clients/${clientId}/work/conversation/${t.id}`}>
            {threadTitle(t)}
          </Link>
          <span className="cv-list__flags">
            {t.awaitingReply && <span className="cv-pill cv-pill--waiting">Awaiting our reply</span>}
            {t.unreadCount > 0 && <span className="cv-pill cv-pill--count">{t.unreadCount} unread</span>}
            {t.pendingDrafts > 0 && (
              <span className="cv-pill cv-pill--draft">{t.pendingDrafts === 1 ? "1 draft waiting" : `${t.pendingDrafts} drafts waiting`}</span>
            )}
          </span>
          <span className="cv-list__meta">
            <span>{threadScope(t)}</span>
            <span>{t.status === "closed" ? "Closed" : "Open"}</span>
            <span>{t.lastMessageAt ? `Last message ${formatDateTime(t.lastMessageAt)}` : "No messages yet"}</span>
            <ClientVisibilityMarker clientVisible={t.clientVisible} />
          </span>
        </li>
      ))}
    </ul>
  );
}

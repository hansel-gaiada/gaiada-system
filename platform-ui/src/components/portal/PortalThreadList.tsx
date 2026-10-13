import Link from "next/link";
import { groupThreads, portalDate, threadTitle, type PortalThread } from "@/lib/portal";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalStatus } from "./PortalBits";

// PV4-08 — the Conversation list: General pinned on top (only for a client in `generalClientIds`, the server's per-client
// answer, PV4-13), then one group per project. Presentational and server-safe: the grouping rule lives in `groupThreads` (lib/portal.ts).
//
// `unreadCount` is the server's count of the OTHER side's messages newer than the caller's read marker; the badge is
// a text count ("2 new"), never colour alone.
export function PortalThreadList({ threads, generalClientIds }: { threads: PortalThread[]; generalClientIds: readonly string[] }) {
  const { general, projects } = groupThreads(threads, generalClientIds);
  const multiClient = new Set(threads.map((t) => t.clientId)).size > 1;
  if (general.length === 0 && projects.length === 0) {
    return <EmptyNote>No conversations yet. Start one above and our team will reply here.</EmptyNote>;
  }
  return (
    <div className="cp-stack">
      {general.length > 0 && (
        <section className="cp-conv-group" aria-labelledby="cv-general">
          <h3 className="cp-conv-group__title" id="cv-general">General</h3>
          <ul className="cp-conv-list">
            {general.map((t) => <ThreadRow key={t.id} t={t} multiClient={multiClient} />)}
          </ul>
        </section>
      )}
      {projects.map((g) => (
        <section className="cp-conv-group" key={g.key} aria-labelledby={`cv-p-${g.key}`}>
          <h3 className="cp-conv-group__title" id={`cv-p-${g.key}`}>{g.title}</h3>
          <ul className="cp-conv-list">
            {g.threads.map((t) => <ThreadRow key={t.id} t={t} multiClient={multiClient} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function ThreadRow({ t, multiClient = false }: { t: PortalThread; multiClient?: boolean }) {
  const unread = t.unreadCount ?? 0;
  return (
    <li>
      <Link href={`/portal/conversation/${t.id}`} className="cp-conv-row">
        <span style={{ minWidth: 0, flex: "1 1 220px" }}>
          <span className="cp-conv-row__title" style={{ display: "block" }}>{threadTitle(t, multiClient)}</span>
          <span className="cp-conv-row__meta">
            {t.lastMessageAt ? `Last message ${portalDate(t.lastMessageAt)}` : `Started ${portalDate(t.createdAt)}`}
          </span>
        </span>
        {t.status === "closed" && <PortalStatus status="closed" tone="neutral" />}
        {unread > 0 && <span className="cp-conv-unread">{unread} new</span>}
      </Link>
    </li>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listNotifications, type NotificationItem } from "@/lib/entities";
import { markAllReadAction, markReadAction } from "../../notifications/actions";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { MailThreadPanel } from "@/components/mail/MailThreadPanel";

// `/me/inbox` — the employee's personal inbox (employee-portal wave F).
//
// WHAT THIS IS, precisely: the platform has per-user NOTIFICATIONS and entity-scoped MAIL THREADS,
// but no personal mailbox — there is no "messages addressed to me" store, and inventing one would
// mean a second unread model to keep in sync. So this page unifies what actually exists: the
// notification feed, plus the mail thread for whichever item you open. That is the honest shape of
// an employee inbox on this backend, and it is why a notification row is the unit here.
//
// It reuses `/notifications`' server actions rather than forking them, so "read" means the same
// thing in both places and there is one mark-read implementation. `/notifications` remains the
// cross-cutting feed reachable from the bell; this is the same feed addressed to the employee, in
// the section where they look for their own things.
//
// Only notifications carrying an entityType/entityId can have a thread; opening one sets ?thread=
// and renders a SINGLE MailThreadPanel rather than one panel per row (which would be N BFF reads
// for a page the employee mostly scans).

type SP = Promise<{ filter?: string; thread?: string }>;

type Severity = "info" | "warning" | "critical";
const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", warning: "Warning", info: "Info" };
// Rust (--status-critical) is reserved as the only-signal colour for real risk (the WSUX-11 rule);
// `warning` takes the same bronze accent the rest of the app uses for attention states.
const SEVERITY_COLOR: Record<Severity, string | undefined> = {
  critical: "var(--status-critical-fg)",
  warning: "var(--accent)",
  info: undefined,
};

function severityOf(n: NotificationItem): Severity {
  return n.payload?.severity ?? "info";
}

function when(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Locale AND timeZone pinned: unpinned toLocale* diverges between server and client ICU and
  // produces a hydration mismatch.
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Makassar",
  });
}

export default async function MeInboxPage({ searchParams }: { searchParams: SP }) {
  const { filter = "all", thread } = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const all = await listNotifications(userId, tenant);
  const unreadCount = all.filter((n) => !n.read_at).length;
  const items = filter === "unread" ? all.filter((n) => !n.read_at) : all;

  const open = thread ? all.find((n) => n.id === thread) ?? null : null;
  const openEntity = open?.payload?.entityType && open?.payload?.entityId
    ? { entityType: open.payload.entityType, entityId: open.payload.entityId }
    : null;

  const tabs: { key: string; label: string }[] = [
    { key: "all", label: `All${all.length ? ` (${all.length})` : ""}` },
    { key: "unread", label: `Unread${unreadCount ? ` (${unreadCount})` : ""}` },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/me/inbox${t.key === "all" ? "" : "?filter=unread"}`}
            style={{
              font: filter === t.key ? "500 13px var(--font-body)" : "400 13px var(--font-body)",
              color: filter === t.key ? "var(--erp-ink)" : "var(--erp-ink-50)",
              textDecoration: "none",
              borderBottom: filter === t.key ? "1px solid var(--erp-ink)" : "1px solid transparent",
              paddingBottom: 2,
            }}
          >
            {t.label}
          </Link>
        ))}
        <span style={{ flex: 1 }} />
        {unreadCount > 0 && (
          <form action={markAllReadAction}>
            <button type="submit" className="lux-btn lux-btn--sm">Mark all read</button>
          </form>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyNote>
          {filter === "unread" ? "Nothing unread — you are up to date." : "Nothing has arrived for you yet."}
        </EmptyNote>
      ) : (
        <div style={{ border: "0.5px solid var(--erp-hairline)" }}>
          {items.map((n, i) => {
            const sev = severityOf(n);
            const color = SEVERITY_COLOR[sev];
            const hasEntity = Boolean(n.payload?.entityType && n.payload?.entityId);
            const isOpen = thread === n.id;
            return (
              <div
                key={n.id}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 14, padding: "14px 18px",
                  borderTop: i === 0 ? "none" : "0.5px solid var(--erp-hairline)",
                  // Unread is carried by weight + a leading marker, not a background wash.
                  borderLeft: n.read_at ? "2px solid transparent" : "2px solid var(--erp-ink)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    margin: 0,
                    font: `${n.read_at ? "400" : "500"} 14px var(--font-body)`,
                    color: "var(--erp-ink)",
                  }}>
                    {n.payload?.href ? (
                      <Link href={n.payload.href} style={{ color: "inherit", textDecoration: "none" }}>
                        {n.payload?.title ?? n.type}
                      </Link>
                    ) : (
                      n.payload?.title ?? n.type
                    )}
                  </p>
                  {n.payload?.body && (
                    <p style={{ margin: "4px 0 0", font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
                      {n.payload.body}
                    </p>
                  )}
                  <p style={{ margin: "5px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
                    {when(n.created_at)}
                    {color ? ` · ${SEVERITY_LABEL[sev]}` : ""}
                    {n.payload?.entityType ? ` · ${n.payload.entityType.replace(/_/g, " ")}` : ""}
                  </p>
                </div>

                {color && (
                  <span aria-hidden style={{ width: 6, height: 6, background: color, marginTop: 6, flexShrink: 0 }} />
                )}

                <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                  {hasEntity && (
                    <Link
                      href={isOpen ? "/me/inbox" : `/me/inbox?thread=${n.id}`}
                      className="lux-btn lux-btn--sm"
                    >
                      {isOpen ? "Hide replies" : "Replies"}
                    </Link>
                  )}
                  {!n.read_at && (
                    <form action={markReadAction.bind(null, n.id)}>
                      <button type="submit" className="lux-btn lux-btn--sm">Mark read</button>
                    </form>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openEntity && (
        <MailThreadPanel
          userId={userId} tenantId={tenant}
          entityType={openEntity.entityType} entityId={openEntity.entityId}
          title={`Replies — ${open?.payload?.title ?? openEntity.entityType.replace(/_/g, " ")}`}
        />
      )}
    </div>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listNotifications, type NotificationItem } from "@/lib/entities";
import { markAllReadAction, markReadAction } from "./actions";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { MailThreadPanel } from "@/components/mail/MailThreadPanel";
import { noticePostedLine } from "@/lib/notices";

// `/me/inbox` — the employee's personal inbox (employee-portal wave F).
//
// WHAT THIS IS, precisely: the platform has per-user NOTIFICATIONS and entity-scoped MAIL THREADS,
// but no personal mailbox — there is no "messages addressed to me" store, and inventing one would
// mean a second unread model to keep in sync. So this page unifies what actually exists: the
// notification feed, plus the mail thread for whichever item you open. That is the honest shape of
// an employee inbox on this backend, and it is why a notification row is the unit here.
//
// DW-8b: this is the ONE inbox. `/notifications` used to render the same feed with severity and
// unread filters; those filters live here now (same `?filter=` values, so old links keep their
// meaning) and `/notifications` redirects here (next.config.ts), query string included. The bell and
// the top bars point here too. The mark-read actions sit next to this page (`./actions`).
//
// Only notifications carrying an entityType/entityId can have a thread; opening one sets ?thread=
// and renders a SINGLE MailThreadPanel rather than one panel per row (which would be N BFF reads
// for a page the employee mostly scans).

type SP = Promise<{ filter?: string; thread?: string }>;

type Severity = "info" | "warning" | "critical";
type Filter = "all" | "unread" | Severity;
const FILTERS: Filter[] = ["all", "unread", "critical", "warning", "info"];

/** `/me/inbox` with the filter kept (and a thread open, when given). `all` is the bare URL. */
function inboxHref(filter: Filter, thread?: string): string {
  const q = new URLSearchParams();
  if (filter !== "all") q.set("filter", filter);
  if (thread) q.set("thread", thread);
  const s = q.toString();
  return s ? `/me/inbox?${s}` : "/me/inbox";
}
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

/** The row's headline: a `notice.posted` reads "<unit or Whole company>: <title>" (BFF §57.6), anything else its own title (else its type). */
function headline(n: NotificationItem): string {
  return noticePostedLine(n.type, n.payload) ?? n.payload?.title ?? n.type;
}

/** A notice has no thread (comments are out of scope for the notice board), though its payload carries an entity for the record. */
const hasThread = (n: NotificationItem): boolean => n.type !== "notice.posted" && Boolean(n.payload?.entityType && n.payload?.entityId);

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
  const { filter: rawFilter, thread } = await searchParams;
  const filter: Filter = FILTERS.includes(rawFilter as Filter) ? (rawFilter as Filter) : "all";
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  let all: NotificationItem[];
  try {
    all = await listNotifications(userId, tenant);
  } catch (e) {
    // listNotifications already absorbs 404/403 (module not enabled) into an empty list, so a throw
    // here means the backend was unreachable: say so rather than render a misleading empty inbox.
    return (
      <EmptyNote>
        {e instanceof PlatformError
          ? "Couldn't reach your inbox right now. Try again shortly."
          : "Your inbox is temporarily unavailable."}
      </EmptyNote>
    );
  }
  const unreadCount = all.filter((n) => !n.read_at).length;
  const bySeverity = { info: 0, warning: 0, critical: 0 } as Record<Severity, number>;
  for (const n of all) bySeverity[severityOf(n)] += 1;
  const items = all.filter((n) => {
    if (filter === "all") return true;
    if (filter === "unread") return !n.read_at;
    return severityOf(n) === filter;
  });

  const open = thread ? all.find((n) => n.id === thread) ?? null : null;
  const openEntity = open && hasThread(open) && open.payload?.entityType && open.payload?.entityId
    ? { entityType: open.payload.entityType, entityId: open.payload.entityId }
    : null;

  // Severity tabs only appear when there is something of that severity, as /notifications did.
  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: `All${all.length ? ` (${all.length})` : ""}` },
    { key: "unread", label: `Unread${unreadCount ? ` (${unreadCount})` : ""}` },
    ...(bySeverity.critical > 0 ? [{ key: "critical" as const, label: `Critical (${bySeverity.critical})` }] : []),
    ...(bySeverity.warning > 0 ? [{ key: "warning" as const, label: `Warning (${bySeverity.warning})` }] : []),
    ...(bySeverity.info > 0 ? [{ key: "info" as const, label: `Info (${bySeverity.info})` }] : []),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={inboxHref(t.key)}
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
          {all.length === 0
            ? "Nothing has arrived for you yet."
            : filter === "unread"
              ? "Nothing unread — you are up to date."
              : "Nothing matches this filter."}
        </EmptyNote>
      ) : (
        <div style={{ border: "0.5px solid var(--erp-hairline)" }}>
          {items.map((n, i) => {
            const sev = severityOf(n);
            const color = SEVERITY_COLOR[sev];
            const hasEntity = hasThread(n);
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
                        {headline(n)}
                      </Link>
                    ) : (
                      headline(n)
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
                      href={inboxHref(filter, isOpen ? undefined : n.id)}
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

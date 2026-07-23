import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listNotifications, type NotificationItem } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { markAllReadAction, markReadAction } from "./actions";

const SUBTITLE = "Approvals, mentions and record changes that involve you.";

type Severity = "info" | "warning" | "critical";
type Filter = "all" | "unread" | Severity;

// Next 15: searchParams is async.
type SP = Promise<{ filter?: string }>;

// Risk-colour discipline (WSUX-11 rule): rust (#B5622F) is the only-signal
// color for real risk, so it's reserved for `critical`. `warning` gets the
// same bronze the rest of the app uses for in-flight/attention states
// (components/ui.tsx STATUS_COLORS); `info` (and legacy rows shipped before
// WSUX-4, which never gained a severity) get no color treatment at all.
const SEVERITY_COLOR: Record<Severity, string | undefined> = {
  critical: "#B5622F",
  warning: "#6E5A43",
  info: undefined,
};
const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", warning: "Warning", info: "Info" };

function severityOf(n: NotificationItem): Severity {
  return n.payload?.severity ?? "info";
}

function when(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function header() {
  return <PageHeader eyebrow="Workspace" title="Notifications" subtitle={SUBTITLE} />;
}

export default async function NotificationsPage({ searchParams }: { searchParams: SP }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return (
      <>
        {header()}
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  let items: NotificationItem[];
  try {
    items = await listNotifications(userId, tenant);
  } catch (e) {
    // listNotifications already absorbs 404/403 (module not enabled) into an
    // empty list — anything that still throws here means the backend itself
    // wasn't reachable, so say that plainly rather than rendering a
    // misleading "nothing to see" empty state.
    return (
      <>
        {header()}
        <Card>
          <EmptyNote>
            {e instanceof PlatformError
              ? "Couldn't reach notifications right now. Try again shortly."
              : "Notifications are temporarily unavailable."}
          </EmptyNote>
        </Card>
      </>
    );
  }

  const { filter: rawFilter } = await searchParams;
  const filter: Filter = (["all", "unread", "info", "warning", "critical"] as Filter[]).includes(
    rawFilter as Filter,
  )
    ? (rawFilter as Filter)
    : "all";

  const unread = items.filter((n) => !n.read_at);
  const bySeverity = { info: 0, warning: 0, critical: 0 } as Record<Severity, number>;
  for (const n of items) bySeverity[severityOf(n)] += 1;

  const visible = items.filter((n) => {
    if (filter === "all") return true;
    if (filter === "unread") return !n.read_at;
    return severityOf(n) === filter;
  });

  const tab = (label: string, value: Filter, count?: number) => (
    <Link
      href={value === "all" ? "/notifications" : `/notifications?filter=${value}`}
      className="lux-btn lux-btn--ghost lux-btn--sm"
      style={{
        textDecoration: "none",
        ...(filter === value ? { borderColor: "var(--erp-accent)", color: "var(--erp-accent)" } : {}),
      }}
    >
      {label}{count !== undefined ? ` (${count})` : ""}
    </Link>
  );

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Notifications"
        subtitle={SUBTITLE}
        actions={
          unread.length > 0 ? (
            <form action={markAllReadAction}>
              <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Mark all read</button>
            </form>
          ) : undefined
        }
      />

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {tab("All", "all", items.length)}
        {tab("Unread", "unread", unread.length)}
        {bySeverity.critical > 0 && tab("Critical", "critical", bySeverity.critical)}
        {bySeverity.warning > 0 && tab("Warning", "warning", bySeverity.warning)}
        {bySeverity.info > 0 && tab("Info", "info", bySeverity.info)}
      </div>

      <Card title={items.length ? `${unread.length} unread · ${items.length} total` : undefined}>
        {items.length === 0 ? (
          <EmptyNote>You&apos;re all caught up. Nothing needs your attention right now.</EmptyNote>
        ) : visible.length === 0 ? (
          <EmptyNote>Nothing matches this filter.</EmptyNote>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {visible.map((n) => {
              const p = n.payload ?? {};
              const title = p.title || n.type.replace(/[._]/g, " ");
              const isUnread = !n.read_at;
              const severity = severityOf(n);
              const color = SEVERITY_COLOR[severity];
              return (
                <div
                  key={n.id}
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "flex-start",
                    padding: "14px 4px",
                    borderBottom: "0.5px solid var(--erp-hairline-soft)",
                  }}
                >
                  <span
                    aria-hidden="true"
                    title={SEVERITY_LABEL[severity]}
                    style={{
                      marginTop: 6,
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: color ?? (isUnread ? "var(--erp-accent)" : "transparent"),
                      border: color || isUnread ? "none" : "0.5px solid rgba(26,25,22,.25)",
                    }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ font: `${isUnread ? 700 : 400} 14px var(--font-body)`, color: color ?? "var(--text-primary)" }}>
                        {p.href ? <Link href={p.href} style={{ color: "inherit", textDecoration: "none" }}>{title}</Link> : title}
                      </div>
                      {severity !== "info" && (
                        <span style={{ font: "600 10px var(--font-body)", letterSpacing: ".04em", textTransform: "uppercase", color }}>
                          {SEVERITY_LABEL[severity]}
                        </span>
                      )}
                    </div>
                    {p.body && <div style={{ font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-60)", marginTop: 2 }}>{p.body}</div>}
                    <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 4 }}>
                      {p.href && <Link href={p.href} style={{ font: "400 12px var(--font-body)", color: "var(--erp-accent)", textDecoration: "none" }}>Open →</Link>}
                      {isUnread && (
                        <form action={markReadAction.bind(null, n.id)}>
                          <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ font: "400 12px var(--font-body)", padding: "2px 8px" }}>
                            Mark read
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                  <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)", whiteSpace: "nowrap" }}>{when(n.created_at)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listNotifications, type NotificationItem } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { markAllReadAction } from "./actions";

const SUBTITLE = "Approvals, mentions and record changes that involve you.";

// Best-effort human summary from an opaque payload — the backend notification
// shape is still settling, so we read a few likely fields and fall back to type.
function summarize(n: NotificationItem): { title: string; body?: string; href?: string } {
  const p = n.payload ?? {};
  const title =
    (typeof p.title === "string" && p.title) ||
    (typeof p.subject === "string" && p.subject) ||
    n.type.replace(/[._]/g, " ");
  const body =
    (typeof p.message === "string" && p.message) ||
    (typeof p.body === "string" && p.body) ||
    undefined;
  const href = typeof p.href === "string" && p.href.startsWith("/") ? p.href : undefined;
  return { title: title.charAt(0).toUpperCase() + title.slice(1), body, href };
}

function when(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default async function NotificationsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Workspace" title="Notifications" subtitle={SUBTITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const items = await listNotifications(userId, tenant);
  const unread = items.filter((n) => !n.read_at);

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

      <Card title={items.length ? `${unread.length} unread · ${items.length} total` : undefined}>
        {items.length === 0 ? (
          <EmptyNote>You&apos;re all caught up. Nothing needs your attention right now.</EmptyNote>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {items.map((n) => {
              const s = summarize(n);
              const isUnread = !n.read_at;
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
                    style={{
                      marginTop: 6,
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: isUnread ? "var(--erp-accent)" : "transparent",
                      border: isUnread ? "none" : "0.5px solid rgba(26,25,22,.25)",
                    }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ font: `${isUnread ? 700 : 400} 14px var(--font-body)`, color: "var(--text-primary)" }}>
                      {s.href ? <Link href={s.href} style={{ color: "inherit", textDecoration: "none" }}>{s.title}</Link> : s.title}
                    </div>
                    {s.body && <div style={{ font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-60)", marginTop: 2 }}>{s.body}</div>}
                    {s.href && <Link href={s.href} style={{ font: "400 12px var(--font-body)", color: "var(--erp-accent)", textDecoration: "none", marginTop: 4, display: "inline-block" }}>Open →</Link>}
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

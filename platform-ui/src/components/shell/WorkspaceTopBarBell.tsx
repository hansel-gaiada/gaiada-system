import type { Me } from "@/lib/platform";
import { listNotifications } from "@/lib/entities";
import { noticePostedLine } from "@/lib/notices";
import { NotificationBell, type BellItem } from "./NotificationBell";
import { ShellNotificationsSettle } from "./WorkspaceShellContext";

// DW-2c: the bell of the workspace top bar, split out of `WorkspaceTopBar` so its read can stream (the bar draws the bell with no
// count behind a <Suspense> until this resolves). Bell text is unchanged once resolved.

/** How many notifications the bell's pop-over lists. */
const BELL_ITEMS = 5;

/** The bell with its unread read. An async server child, so the read streams in behind `<Suspense>` (below) instead of holding the
 *  whole shell's first byte: `listNotifications` is a backend round trip and nothing else in the bar waits on it. */
export async function WorkspaceTopBarBell({ me, tenantId }: { me: Me; tenantId: string | null }) {
  // The unread read: a thrown read is `null`, so the bell shows no count and says it could not load.
  // (listNotifications itself already turns a 403/404, a tenant without the feature, into an empty list.)
  let unread: { count: number; items: BellItem[] } | null = { count: 0, items: [] };
  if (tenantId) {
    try {
      const rows = await listNotifications(me.userId, tenantId, true);
      unread = {
        count: rows.length,
        items: [...rows]
          .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
          .slice(0, BELL_ITEMS)
          .map((n) => ({ id: n.id, title: noticePostedLine(n.type, n.payload) ?? (n.payload?.title || n.type), createdAt: n.created_at })),
      };
    } catch {
      unread = null;
    }
  }
  // The same count goes to the shell (SCP-Kc), so the Social menu's Notifications entry needs no second read.
  return (
    <>
      <NotificationBell unread={unread?.count ?? null} items={unread?.items ?? []} />
      <ShellNotificationsSettle unread={unread?.count ?? null} />
    </>
  );
}

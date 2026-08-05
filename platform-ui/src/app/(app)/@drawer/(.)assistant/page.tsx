import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listThreads, resolvePageContextRef } from "@/lib/assistant-data";
import { AssistantDrawer } from "@/components/assistant/AssistantDrawer";
import { AssistantWorkspace } from "@/components/assistant/AssistantWorkspace";

// ASST-22 — the intercepted `/assistant` route: a client-side navigation to `/assistant` FROM ANY
// page under `(app)` (the FAB, `components/shell/AssistantFab.tsx`) renders the SAME workspace in a
// slide-over instead of replacing the page — exactly the pattern
// `@drawer/(.)tasks/[taskId]/page.tsx` already established for the task detail drawer (read that
// file's header first). A hard load of `/assistant` — a shared link, a refresh, a new tab — still
// renders the full page at `app/(app)/assistant/page.tsx`, untouched by this ticket. One route, two
// presentations, both mounting the exact same `AssistantWorkspace` tree.
//
// `ctx` is how the FAB tells this route what page it was opened from — `usePathname()` read INSIDE
// this file would report `/assistant` itself (the intercepted segment's own URL), not the page the
// user was actually looking at, since `(app)/layout.tsx`'s `children` slot never re-renders on this
// navigation. See `lib/assistantContext.ts`'s header for the full reasoning. `ctx` is resolved here
// (server-side, via the SAME citation-resolution endpoint the `@`-mention/citation chips already
// use) rather than trusted as-is — an unresolvable ref (stale, deleted, malformed, forged) means the
// drawer opens with NO pin, never a fake one.
type SP = Promise<{ thread?: string; ctx?: string }>;

export default async function AssistantDrawerPage({ searchParams }: { searchParams: SP }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { thread: requestedThreadId, ctx } = await searchParams;

  if (!tenant) {
    return (
      <AssistantDrawer>
        <p className="asst-drawer__empty">Select a company to open the assistant.</p>
      </AssistantDrawer>
    );
  }

  const [initial, pageContext] = await Promise.all([
    listThreads(userId, tenant).catch(() => ({ items: [], total: 0 })),
    ctx ? resolvePageContextRef(userId, tenant, ctx).catch(() => null) : Promise.resolve(null),
  ]);
  const initialActiveThreadId = requestedThreadId && initial.items.some((t) => t.id === requestedThreadId)
    ? requestedThreadId
    : null;

  return (
    <AssistantDrawer>
      <AssistantWorkspace
        initialThreads={initial.items}
        initialActiveThreadId={initialActiveThreadId}
        variant="drawer"
        pageContext={pageContext}
      />
    </AssistantDrawer>
  );
}

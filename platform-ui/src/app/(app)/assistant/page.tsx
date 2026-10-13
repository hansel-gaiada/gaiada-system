import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPrefs } from "@/lib/prefs";
import { listThreads, resolveOrigin, withRequestedThread } from "@/lib/assistant-data";
import { AssistantWorkspace } from "@/components/assistant/AssistantWorkspace";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PageHeader } from "@/components/PageHeader";

// ASST-07 — the `/assistant` workspace. Owner-only end to end (ASST-02's Cerbos policy has no
// admin/company_admin/group_executive bypass), so this page needs no `can()` capability check —
// every signed-in staff user gets their OWN threads, nothing more, exactly like the backend already
// enforces. The heavy lifting (rail, thread view, composer, streaming) all lives in
// `AssistantWorkspace`, one client component tree — see its header for why this can't be a series
// of page navigations.
//
// `?thread=<id>` is how a hard reload lands back on the thread you were viewing: `page.tsx` stays
// a single route (not `/assistant/[id]`, per the ticket's file list), so the client writes the
// active thread id into the URL via a plain `history.replaceState` (no Next.js navigation, no
// re-fetch — see AssistantWorkspace) purely so THIS read exists for the next real page load. A
// request for a thread that doesn't exist in the caller's OWN list is ignored, never trusted
// blindly — the owner-only fetch a moment later is still the real check.
//
// DW-2h — `?from=<path>` is the page the person opened the assistant from (the drawer's "Open in full
// page" carries it over). It names the department in the chip, picks that department's starter prompts,
// and is where "Close" goes back to. A full page opened without it shows no department and no Close.
type SP = Promise<{ thread?: string; from?: string }>;

export default async function AssistantPage({ searchParams }: { searchParams: SP }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return <EmptyNote>Select a company to open the assistant.</EmptyNote>;
  }

  const { thread: requestedThreadId, from } = await searchParams;
  const [initial, prefs, origin] = await Promise.all([
    listThreads(userId, tenant).catch(() => ({ items: [], total: 0 })),
    getPrefs(),
    resolveOrigin(me, tenant, from),
  ]);
  const items = await withRequestedThread(userId, tenant, initial.items, requestedThreadId);
  const initialActiveThreadId = requestedThreadId && items.some((t) => t.id === requestedThreadId)
    ? requestedThreadId
    : null;

  return (
    <div className="asst-page">
      <PageHeader
        title="AI Assistant"
        actions={origin ? (
          <Link href={origin.path} className="asst-close-link" aria-label="Close the assistant and go back to the page you came from">
            Close ✕
          </Link>
        ) : undefined}
      />
      <AssistantWorkspace
        initialThreads={items}
        initialActiveThreadId={initialActiveThreadId}
        initialRailCollapsed={prefs.assistantRailCollapsed}
        origin={origin}
      />
    </div>
  );
}

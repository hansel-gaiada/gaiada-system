import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listThreads } from "@/lib/assistant-data";
import { AssistantWorkspace } from "@/components/assistant/AssistantWorkspace";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Eyebrow } from "@/components/ui";

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
type SP = Promise<{ thread?: string }>;

export default async function AssistantPage({ searchParams }: { searchParams: SP }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return <EmptyNote>Select a company to open the assistant.</EmptyNote>;
  }

  const { thread: requestedThreadId } = await searchParams;
  const initial = await listThreads(userId, tenant).catch(() => ({ items: [], total: 0 }));
  const initialActiveThreadId = requestedThreadId && initial.items.some((t) => t.id === requestedThreadId)
    ? requestedThreadId
    : null;

  return (
    <div className="asst-page">
      <div style={{ marginBottom: 18 }}>
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Assistant" }]} />
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 6, display: "block" }}>Intelligence</Eyebrow>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 30, lineHeight: 1.1 }}>Assistant</h1>
      </div>
      <AssistantWorkspace initialThreads={initial.items} initialActiveThreadId={initialActiveThreadId} />
    </div>
  );
}

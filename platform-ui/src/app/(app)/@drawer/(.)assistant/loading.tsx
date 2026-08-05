import { AssistantDrawer } from "@/components/assistant/AssistantDrawer";

// Belt-and-braces boundary for a hard navigation into the slot — see
// `@drawer/(.)tasks/[taskId]/loading.tsx`'s identical note: the real coverage for the common
// client-side case would need a Suspense boundary around the async data fetch in `page.tsx`, but
// that fetch (list threads + resolve one context ref) is fast enough, and un-risky enough to leave
// un-streamed, that this route keeps it simple — a single `await` in a small server component,
// same shape as `app/(app)/assistant/page.tsx` itself.
export default function AssistantDrawerLoading() {
  return (
    <AssistantDrawer>
      <p className="asst-drawer__empty">Loading…</p>
    </AssistantDrawer>
  );
}

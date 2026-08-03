import { Suspense } from "react";
import { TaskDrawer } from "@/components/pm/TaskDrawer";
import { TaskDetailView } from "@/components/pm/TaskDetailView";
import { TaskDetailSkeleton } from "@/components/pm/TaskDetailSkeleton";
import "@/components/pm/task-detail.css";

// Intercepted task route. A client-side navigation to /tasks/:id from anywhere under (app) renders
// the detail in a slide-over instead of replacing the page — the pattern Linear/Monday/Asana use.
//
// The point of intercepting rather than rewriting call sites: all 132 existing `/tasks/:id` links
// (lists, calendar chips, boards, rails, search results, notifications) keep working untouched, and
// a hard load of the same URL — a shared link, a refresh, a new tab, an email — still renders the
// full page at app/(app)/tasks/[taskId]. One URL, two presentations, no duplicated data fetching:
// both mount the same TaskDetailView.
export default async function TaskDrawerPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  // Suspense, not just the route's loading.tsx: a loading boundary on an intercepted slot did not
  // fire in practice (verified with a 1.5s delay on the task payload — the panel stayed absent and
  // the list simply froze). Suspending only the BODY lets the drawer chrome flush immediately while
  // the detail streams, so the click is acknowledged within a frame either way.
  return (
    <TaskDrawer>
      <Suspense fallback={<TaskDetailSkeleton />}>
        <TaskDetailView taskId={taskId} backHref="/tasks" backLabel="Tasks" chrome="drawer" />
      </Suspense>
    </TaskDrawer>
  );
}

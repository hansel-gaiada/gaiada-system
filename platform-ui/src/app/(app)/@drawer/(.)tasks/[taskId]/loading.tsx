import { TaskDetailSkeleton } from "@/components/pm/TaskDetailSkeleton";
import "@/components/pm/task-detail.css";

// Kept as a belt-and-braces boundary for a hard navigation into the slot; the Suspense boundary in
// page.tsx is what actually covers the common client-side case (see the note there).
export default function TaskDrawerLoading() {
  return (
    <>
      <div className="pm-drawer__scrim" />
      <div className="pm-drawer">
        <div className="pm-drawer__bar"><span className="pm-drawer__crumb">Task</span></div>
        <div className="pm-drawer__body"><TaskDetailSkeleton /></div>
      </div>
    </>
  );
}

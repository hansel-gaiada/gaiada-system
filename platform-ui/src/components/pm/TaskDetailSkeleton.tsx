import { Skeleton } from "@/components/Feedback";

// The shape of the task detail, used as the Suspense fallback inside the drawer (and by the route's
// loading boundary). Mirrors the real two-zone layout so nothing jumps when the content arrives.
export function TaskDetailSkeleton() {
  return (
    <div role="status" aria-label="Loading task">
      <div className="pm-detail__head" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Skeleton width={70} height={10} />
        <Skeleton width="55%" height={26} />
        <Skeleton width={170} height={13} />
      </div>
      <div className="pm-detail">
        <div className="pm-detail__main" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Skeleton width={90} height={10} />
          <Skeleton width="100%" height={13} />
          <Skeleton width="85%" height={13} />
          <Skeleton width={90} height={10} style={{ marginTop: 14 }} />
          <Skeleton width="70%" height={13} />
          <Skeleton width="60%" height={13} />
        </div>
        <aside className="pm-detail__side" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <Skeleton width={60} height={10} />
              <Skeleton width={104} height={12} />
            </div>
          ))}
        </aside>
      </div>
      <span className="fb-sr-only">Loading task…</span>
    </div>
  );
}

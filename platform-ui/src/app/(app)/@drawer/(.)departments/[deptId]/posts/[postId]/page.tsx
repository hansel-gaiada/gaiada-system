import { Suspense } from "react";
import { PostDrawer } from "@/components/social/PostDrawer";
import { PostView } from "@/components/social/PostView";
import "@/components/pm/task-detail.css";

// SCP-1e — the intercepted post route: a client-side navigation to `{D}/posts/[postId]` from any list under `(app)` renders the post in a slide-over instead of
// replacing the list. It is `@drawer/(.)tasks/[taskId]` for a Social Media post (read that file's header for why the body, not the route, is suspended), and a hard
// load of the same URL renders the full page at `app/(app)/departments/[deptId]/posts/[postId]`. Both mount the same `PostView`.
export default async function PostDrawerPage({ params }: { params: Promise<{ deptId: string; postId: string }> }) {
  const { deptId, postId } = await params;
  return (
    <PostDrawer>
      <Suspense fallback={<p className="scp-note" role="status">Loading the post…</p>}>
        <PostView deptId={deptId} postId={postId} chrome="drawer" />
      </Suspense>
    </PostDrawer>
  );
}

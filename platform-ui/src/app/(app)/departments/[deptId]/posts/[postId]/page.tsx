import { PostView } from "@/components/social/PostView";

type Params = Promise<{ deptId: string; postId: string }>;

// SCP-1e (BFF §63.17, plan §6.3) — the Social Media post page, at `{D}/posts/[postId]`. A hard load of this URL (a shared link, a refresh, a new tab, an email)
// renders it here, as a page; a client-side navigation to it from any list under the workspace is intercepted by `app/(app)/@drawer/(.)departments/[deptId]/posts/[postId]`
// and renders the SAME `PostView` in a slide-over, the way `/tasks/[taskId]` does (read that route's header). One URL, two presentations, no duplicated data fetching.
// It is not a menu row: a post is opened from a list, and `lib/areas.ts` gives the URL its one area (the department's own).
export default async function SocialPostPage({ params }: { params: Params }) {
  const { deptId, postId } = await params;
  return <PostView deptId={deptId} postId={postId} chrome="page" />;
}

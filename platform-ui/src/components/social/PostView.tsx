import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { isDemoMode } from "@/lib/demoMode";
import { canDesignPost } from "@/lib/socialPipeline";
import { readAssetChoices, readPipelinePost, readPostComments, readPostMetrics } from "@/lib/socialPipeline-data";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { PostPage } from "@/components/social/PostPage";
import "@/components/social/cycles.css";

// SCP-1e (BFF §63.6.2, §63.17) — the server half of the post page, mounted BOTH by the full page (`departments/[deptId]/posts/[postId]/page.tsx`) and by the
// drawer over a list (`@drawer/(.)departments/[deptId]/posts/[postId]/page.tsx`), the way `TaskDetailView` serves the task page and its drawer. It re-resolves its own
// session, company and department (a drawer is a separate route tree, so nothing is inherited), reads the post and its thread through the BFF, and hands both to
// the client page. Every read is a `ReadResult`: a refusal is said as a refusal, never as an empty post.
//
//   403            "You do not have access" (the person has neither `read` nor `design` on the post);
//   404            `post_not_found`: the page is a 404;
//   409            `not_a_pipeline_post`: a Composer post, so the page says so and links to the Composer (a redirect would stream a meta refresh under the shell);
//   anything else  "cannot be read right now", with the server's own words.
// The comments, the Asset Library and a live post's metrics are secondary reads: when one fails the page says so beside its section and keeps the post.
type Chrome = "page" | "drawer";

export async function PostView({ deptId, postId, chrome }: { deptId: string; postId: string; chrome: Chrome }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  // Posts belong to the Social Media workspace only.
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const [post, comments] = await Promise.all([readPipelinePost(userId, tenant, postId), readPostComments(userId, tenant, postId)]);
  if (post.kind === "forbidden") return <ReadRefusal subject="this post" kind="forbidden" detail="Reading it needs a Social Media read tier, or the design of this client's posts." inline={chrome === "drawer"} />;
  if (post.kind === "unavailable") {
    if (post.reason === "post_not_found") notFound();
    if (post.reason === "not_a_pipeline_post") {
      return (
        <Card title="A Composer post">
          <p className="scp-note">This post is not in the content pipeline: it has no steps, designs or client review of its own.</p>
          <p><Link href={`/departments/${deptId}/composer/${postId}`} className="scp-link">Open it in the Composer</Link></p>
        </Card>
      );
    }
    return <ReadRefusal subject="This post" kind="unavailable" reason={post.reason} inline={chrome === "drawer"} />;
  }

  // The designer's picker needs the library; nobody else reads it for this page.
  const assets = canDesignPost(post.data) ? await readAssetChoices(userId, tenant) : null;
  // SCP-3c: a live post's metrics are a secondary read too: when it fails the block says so and the page keeps the post.
  const metrics = post.data.pipelineStatus === "live" ? await readPostMetrics(userId, tenant, postId) : null;
  const body = (
    <PostPage
      deptId={deptId} post={post.data} comments={comments.kind === "ok" ? comments.data : null}
      assets={assets && assets.kind === "ok" ? assets.data : null} metrics={post.data.pipelineStatus !== "live" ? undefined : metrics?.kind === "ok" ? metrics.data : null}
      viewerId={userId} demo={isDemoMode()} chrome={chrome}
    />
  );
  return chrome === "page" ? <Card>{body}</Card> : body;
}

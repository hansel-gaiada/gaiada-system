import "server-only";
// SCP-1e (BFF §63.6.2, §63.8): the post page's readers. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person has no read on this post, which is not "nothing here";
//   unavailable anything else, with the server's own code in `reason` (`post_not_found` 404 and `not_a_pipeline_post` 409 included: the page decides
//               what each means, a missing post is a 404 page and a Composer post is sent to the Composer).
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { readCreativeAssets } from "./creativeReviews-data";
import { asPipelinePost, type AssetChoice, type PipelinePost } from "./socialPipeline";
import { asPostMetrics, type PostMetrics } from "./socialMetrics";
import type { Comment } from "./entities";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET posts/:postId/pipeline` (`social_post` · `read`, or `design` on the same post). */
export function readPipelinePost(userId: string, tenantId: string, postId: string): Promise<ReadResult<PipelinePost>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/posts/${encodeURIComponent(postId)}/pipeline`, userId).then(asPipelinePost));
}

/** `GET posts/:postId/metrics` (`social_post` · `read`, SCP-3c, BFF §63.10): the numbers, the rate, the client's average and the boost mark of a post. */
export function readPostMetrics(userId: string, tenantId: string, postId: string): Promise<ReadResult<PostMetrics>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/posts/${encodeURIComponent(postId)}/metrics`, userId).then(asPostMetrics));
}

/** The post's thread (`GET comments`, entity `social_post`): team and client comments, with their pins. The server gives the thread the post's audience. */
export function readPostComments(userId: string, tenantId: string, postId: string): Promise<ReadResult<Comment[]>> {
  const q = new URLSearchParams({ entityType: "social_post", entityId: postId });
  return readResult(platformFetch<Comment[]>(`/api/${encodeURIComponent(tenantId)}/comments?${q.toString()}`, userId));
}

/** The Asset Library's latest versions, for the designer's picker. A refusal or an unreadable library leaves the picker with links only (the page says so). */
export async function readAssetChoices(userId: string, tenantId: string): Promise<ReadResult<AssetChoice[]>> {
  const r = await readCreativeAssets(userId, tenantId, {});
  if (r.kind !== "ok") return r;
  return {
    kind: "ok",
    data: r.data.map((a) => ({ groupId: a.versionGroupId ?? a.id, versionId: a.id, versionNo: a.versionNo ?? 1, name: a.name })),
  };
}

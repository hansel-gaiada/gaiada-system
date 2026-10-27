// SCP-1h (FRONTEND-BFF-CONTRACT §63.6.6, §32) — the social posts that joined a work request: the request detail's additive
// `socialPosts`. The request is the cycle's month request to Creatives (`social_posts.creative_request_id`, set by
// `approve_for_design` when the engagement's designs come from Creatives); a request no post joined answers [].
//
// The detail route is gated by `work_request` · `read` (every member of the company), as the request itself is, and the request's
// own title already names the client. Each row carries only what the page needs to link to the post: its title, the client, its
// status and the creative state. Opening the post is the post page's own gate (`read`, or `design` for the assigned designer).
//
// Read under the social module scope (`{ modules: ["social"] }`): the social tables carry the third wall, and an unset scope reads
// ZERO rows silently. A company without the social module on has no such posts, so it answers [] without reading (the wall checks
// only the DECLARED scope, never the company's enabled modules).
import { withTenants } from "../../../db";
import { isModuleEnabled } from "../../registry";
import { findDepartmentBySlug } from "./pipeline-data";

export interface RequestSocialPost {
  postId: string;
  title: string;
  clientName: string;
  pipelineStatus: string;
  creativeState: string | null;
  /** The post page, `/departments/{social media}/posts/{postId}`; null when the company has no Social Media department. */
  href: string | null;
}

export async function socialPostsOfRequest(tenantId: string, requestId: string): Promise<RequestSocialPost[]> {
  if (!(await isModuleEnabled(tenantId, "social"))) return [];
  return withTenants([tenantId], async (c) => {
    const { rows } = await c.query<{ id: string; title: string; client_name: string; pipeline_status: string; creative_state: string | null }>(
      `SELECT p.id::text AS id, p.title, cl.name AS client_name, p.pipeline_status, p.creative_state
         FROM social_posts p
         JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id
         JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
        WHERE p.tenant_id = $1 AND p.creative_request_id = $2 AND p.pipeline_status IS NOT NULL
          AND p.deleted_at IS NULL AND p.archived_at IS NULL
        ORDER BY p.created_at, p.id`,
      [tenantId, requestId],
    );
    if (rows.length === 0) return [];
    const dept = await findDepartmentBySlug(c, tenantId, "social-media");
    return rows.map((r) => ({
      postId: r.id, title: r.title, clientName: r.client_name, pipelineStatus: r.pipeline_status, creativeState: r.creative_state,
      href: dept ? `/departments/${encodeURIComponent(dept.id)}/posts/${r.id}` : null,
    }));
  }, { modules: ["social"] });
}

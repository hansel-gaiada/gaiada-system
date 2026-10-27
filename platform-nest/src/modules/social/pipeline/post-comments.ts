// SCP-1l (BFF §63.8, PERMISSION-CONTRACT §53.12) — the rules of a `social_post` comment thread, kept in one place so the
// shared thread's controller (`core/collab.controller.ts`) stays a thin caller and the portal (SCP-2) reads the same rule.
//
// The thread is the shared `comments` table (entity `social_post`). A comment is `team` (default) or `client`, and may carry
// a pin `{x, y, fileId}` on the post's image. What this file decides:
//   - WHO may read or write the thread: `social_post` · `read`, or `design` when `read` is refused (a Creatives designer on
//     the month request has no social read tier), in ONE Cerbos call, with the resource built from the rows by
//     `loadSocialPostAuthz` + `socialPostResource` (a client-supplied scope is never trusted).
//   - WHO may write a client-visible comment: it speaks to the client, so it also needs `social_post` · `record_client`
//     (the officer and the two seats; 403 `not_officer_or_approver`).
//   - WHO a reaction, a reply and an @mention reach (SCP-1t): a reaction is a write to the thread, so it needs the thread's gate on the comment's
//     post (`authorizeReactionTarget`); a reply takes its parent's visibility (`loadReplyParent`, `resolveReplyVisibility`), so a team note never
//     shows to the client out of context; an @mention notifies only a person who can read the post (`mentionsWhoCanRead`), the rest are dropped
//     and the author is told which.
//   - WHICH file a pin may sit on: a file of THAT post (a live design row's `file_id`, or a `files` row targeting the post).
//   - WHICH comments the client may see (`clientVisibleComments`): the `client` ones, and only once the post has reached
//     the client (`social_posts.client_first_sent_at`). The portal reads through this, so the rule lives here and nowhere else.
//
// Order: authorization first, validation second (BFF §63.0). A refused caller never reads a 400. Throwers set `message`,
// never `error` (http-error.filter.ts).
import { BadRequestException, ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenants } from "../../../db";
import { authorize, explainDenial } from "../../../core/http";
import { deniedOnlyForAssurance } from "../../../auth/step-up";
import { assemblePrincipal, auditDecision, type Principal } from "../../../rbac/principal";
import { checkActions, type Resource } from "../../../rbac/cerbos";
import { loadSocialPostAuthz, socialPostResource } from "../pipeline-authz";
import { declareSocialModuleScope } from "../module-scope";
import { cerbosDecisionsFor } from "./pipeline.service";

const SOCIAL = { modules: ["social"] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SOCIAL_POST_ENTITY = "social_post";
export type CommentVisibility = "team" | "client";

/** A pin on the post's image: x and y are fractions of the image (0 to 1), fileId is the file the pin sits on. */
export interface CommentAnchor { x: number; y: number; fileId: string }

export interface SocialPostThreadAccess {
  resource: Resource;
  /** `social_post` · `record_client` for the caller: may write a client-visible comment. */
  canRecordClient: boolean;
}

/**
 * The gate of a `social_post` thread, read or write: the post exists in the company (404 `post_not_found`), then
 * `social_post` · `read` or, when that is refused, `design`, in one Cerbos call that also answers `record_client`. A caller
 * with neither is refused 403 (audited exactly as `authorize()` audits a denial). Runs AFTER the generic `comment` check.
 */
export async function authorizeSocialPostThread(principal: Principal, tenantId: string, postId: string): Promise<SocialPostThreadAccess> {
  const facts = await withTenants([tenantId], (c) => loadSocialPostAuthz(c, tenantId, postId), SOCIAL);
  if (!facts) throw new NotFoundException("post_not_found");
  const resource = socialPostResource(tenantId, facts);
  const decided = await cerbosDecisionsFor(principal, resource, ["read", "design", "record_client"]);
  if (!decided.read && !decided.design) {
    await authorize(principal, resource, "read"); // audits the denial and throws 403
    throw new ForbiddenException("not authorized: cerbos denied read on social_post"); // unreachable unless Cerbos flips between calls
  }
  return { resource, canRecordClient: decided.record_client === true };
}

/** A client-visible comment needs `record_client` as well: 403 `not_officer_or_approver`, audited like any denial. */
export async function requireRecordClient(principal: Principal, tenantId: string, access: SocialPostThreadAccess): Promise<void> {
  if (access.canRecordClient) return;
  const reason = explainDenial(principal, "not_officer_or_approver: cerbos denied record_client on social_post");
  await auditDecision(tenantId, principal, "record_client", "social_post", access.resource.id ?? null, false, reason);
  const assurance = await deniedOnlyForAssurance(principal, access.resource, "record_client").catch(() => false);
  throw new HttpException({ message: "not_officer_or_approver", ...(assurance ? { reason: "assurance_required" } : {}) }, 403);
}

/** PURE. `visibility` as the body gave it: absent is `team`; anything but `team` or `client` is 400 `{field: "visibility"}`. */
export function parseVisibility(raw: unknown): CommentVisibility {
  if (raw === undefined) return "team";
  if (raw === "team" || raw === "client") return raw;
  throw new BadRequestException({ message: "invalid_visibility", field: "visibility" });
}

/**
 * PURE. The visibility of a REPLY (SCP-1t, BFF §63.8). `given` is the body's `visibility` and `parent` the comment it answers (null for a top
 * comment). A reply with no visibility given takes its parent's; one that is not `team` or `client` is 400 `{field: "visibility"}` as ever; and a
 * `client` reply to a `team` comment is 400 `{field: "visibility"}`: the client would read an answer to a note it never saw. A `team` reply to a
 * `client` comment is allowed (the team's own aside under a comment the client can see). A top comment's default is `team`.
 */
export function resolveReplyVisibility(given: unknown, parent: { visibility: CommentVisibility } | null): CommentVisibility {
  if (given !== undefined) {
    const v = parseVisibility(given);
    if (v === "client" && parent !== null && parent.visibility === "team") {
      throw new BadRequestException({ message: "reply_visibility_exceeds_parent", field: "visibility" });
    }
    return v;
  }
  return parent ? parent.visibility : "team";
}

/**
 * The comment a reply answers, on the SAME post's thread (SCP-1t): a live comment whose target is this post, else 400 `{field: "parentCommentId"}`
 * (a comment of another thread would hand the reply that thread's visibility). `null` for a top comment (no `parentCommentId`).
 */
export async function loadReplyParent(
  tenantId: string, postId: string, parentCommentId: unknown,
): Promise<{ visibility: CommentVisibility } | null> {
  if (parentCommentId === undefined || parentCommentId === null) return null;
  const bad = () => new BadRequestException({ message: "invalid_parent_comment", field: "parentCommentId" });
  if (typeof parentCommentId !== "string" || !UUID_RE.test(parentCommentId)) throw bad();
  const r = await withTenants([tenantId], (c) => c.query<{ visibility: string }>(
    `SELECT visibility FROM comments
      WHERE tenant_id = $1 AND id = $2 AND target_entity_type = 'social_post' AND target_entity_id = $3 AND deleted_at IS NULL`,
    [tenantId, parentCommentId, postId],
  ));
  const row = r.rows[0];
  if (!row) throw bad();
  return { visibility: row.visibility === "client" ? "client" : "team" };
}

/**
 * A reaction is a write to the comment's thread (SCP-1t). When the comment is on a `social_post` thread, the caller needs that thread's gate on the
 * comment's post (`social_post` · `read`, or `design`): 404 `post_not_found`, or 403 audited like any denial. A comment on any other thread, or no
 * such comment, is left to the caller's own handling (nothing changes for them).
 */
export async function authorizeReactionTarget(principal: Principal, tenantId: string, commentId: string): Promise<void> {
  if (typeof commentId !== "string" || !UUID_RE.test(commentId)) return;
  const r = await withTenants([tenantId], (c) => c.query<{ target_entity_type: string; target_entity_id: string }>(
    `SELECT target_entity_type, target_entity_id FROM comments WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, commentId],
  ));
  const row = r.rows[0];
  if (row && row.target_entity_type === SOCIAL_POST_ENTITY) await authorizeSocialPostThread(principal, tenantId, row.target_entity_id);
}

/**
 * Who of `mentions` may be told about a comment on a post (SCP-1t): the people who can read it (`social_post` · `read`, or `design`), judged on the
 * post's resource for each person as the system would judge them on a normal sign-in. Everyone else is dropped: an @mention must not be a way to
 * pull a post's existence or a note's words to someone the post's audience excludes. Ids that are not a user, not active, or not a uuid are dropped
 * too. Order and duplicates are the caller's; the answer keeps the first sight of each id.
 */
export async function mentionsWhoCanRead(resource: Resource, mentions: readonly string[]): Promise<{ readers: string[]; dropped: string[] }> {
  const readers: string[] = [];
  const dropped: string[] = [];
  for (const id of Array.from(new Set(mentions))) {
    let allowed = false;
    if (typeof id === "string" && UUID_RE.test(id)) {
      const p = await assemblePrincipal(id, "high");
      if (p) {
        const d = await checkActions(p, resource, ["read", "design"]);
        allowed = d.read === true || d.design === true;
      }
    }
    (allowed ? readers : dropped).push(id);
  }
  return { readers, dropped };
}

/** PURE. `anchor` as the body gave it: undefined/null is no pin; else `{x, y, fileId}` with x and y numbers from 0 to 1 and
 *  a uuid `fileId`, or 400 `{field: "anchor"}`. Only those three keys are kept. */
export function parseAnchor(raw: unknown): CommentAnchor | null {
  if (raw === undefined || raw === null) return null;
  const bad = () => new BadRequestException({ message: "invalid_anchor", field: "anchor" });
  if (typeof raw !== "object" || Array.isArray(raw)) throw bad();
  const { x, y, fileId } = raw as Record<string, unknown>;
  const inUnit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  if (!inUnit(x) || !inUnit(y) || typeof fileId !== "string" || !UUID_RE.test(fileId)) throw bad();
  return { x, y, fileId: fileId.toLowerCase() };
}

/** `fileId` is a file of post `postId`: named by a live design row (`social_post_designs.file_id`), or a live `files` row that
 *  targets the post (a reference image). The caller owns the transaction and its tenant scope. */
export async function fileBelongsToPost(c: PoolClient, tenantId: string, postId: string, fileId: string): Promise<boolean> {
  if (!UUID_RE.test(fileId)) return false;
  await declareSocialModuleScope(c);
  const r = await c.query(
    `SELECT 1 FROM social_post_designs
      WHERE tenant_id = $1 AND post_id = $2 AND file_id = $3::uuid AND removed_at IS NULL
     UNION ALL
     SELECT 1 FROM files
      WHERE tenant_id = $1 AND target_entity_type = 'social_post' AND target_entity_id = $2 AND id = $3::uuid AND deleted_at IS NULL
     LIMIT 1`,
    [tenantId, postId, fileId],
  );
  return r.rows.length > 0;
}

/** 400 `{field: "anchor"}` unless the pin's file belongs to the post. */
export async function assertAnchorOnPostFile(tenantId: string, postId: string, anchor: CommentAnchor): Promise<void> {
  const ok = await withTenants([tenantId], (c) => fileBelongsToPost(c, tenantId, postId, anchor.fileId), SOCIAL);
  if (!ok) throw new BadRequestException({ message: "anchor_file_not_on_post", field: "anchor" });
}

export interface ClientVisibleComment {
  id: string;
  authorName: string | null;
  body: string;
  parentCommentId: string | null;
  anchor: CommentAnchor | null;
  createdAt: string;
}

/**
 * The comments the CLIENT may see on one post (BFF §63.8): the `client` ones, and only once the post has reached the client
 * (`social_posts.client_first_sent_at` set). A team comment is never returned, and a post that has not reached the client
 * answers []. For the portal (SCP-2): it reads the thread through this and nowhere else. The caller owns the transaction and
 * its tenant scope; the module scope is declared here (the post is a third-walled table).
 */
export async function clientVisibleComments(c: PoolClient, tenantId: string, postId: string): Promise<ClientVisibleComment[]> {
  if (!UUID_RE.test(postId)) return [];
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{
    id: string; author_name: string | null; body: string; parent_comment_id: string | null; anchor: CommentAnchor | null; created_at: Date | string;
  }>(
    `SELECT co.id, u.name AS author_name, co.body, co.parent_comment_id, co.anchor, co.created_at
       FROM social_posts p
       JOIN comments co ON co.tenant_id = p.tenant_id AND co.target_entity_type = 'social_post' AND co.target_entity_id = p.id
       LEFT JOIN users u ON u.id = co.author_id
      WHERE p.tenant_id = $1 AND p.id = $2 AND p.deleted_at IS NULL AND p.client_first_sent_at IS NOT NULL
        AND co.visibility = 'client' AND co.deleted_at IS NULL
      ORDER BY co.created_at, co.id`,
    [tenantId, postId],
  );
  return rows.map((r) => ({
    id: r.id,
    authorName: r.author_name,
    body: r.body,
    parentCommentId: r.parent_comment_id,
    anchor: r.anchor ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

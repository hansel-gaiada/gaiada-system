// SMM-31 — the client portal's decide surface for social posts (addendum D-16, owner decision
// 2026-08-12). Modelled directly on `PortalController.decideGate`
// (`POST /api/:tenantId/portal/gates/:id/decide`) — same shape: address by the REVIEW's own id
// (never the variant id, mirroring "addressed by gate id" there), resolve the caller's own scope,
// verify ownership in the SAME query as the read, then a single guarded UPDATE.
//
// ── WHY THIS LIVES IN `src/core/`, NOT `src/modules/social/` ────────────────────────────────────
// Same placement decision as `webdev-change-requests-portal.controller.ts` (MI-02): the client
// portal is ONE surface with FOUR controllers (portal/workspace/commerce/profile) plus this module-
// specific extension, and every portal controller shares `AuthGuard` + `resolvePortalScope` +
// `client-notify.ts`. The DOMAIN the row belongs to (social) does not move the controller into that
// module's own directory — the portal is core, and its controllers stay together.
//
// ── THE THIRD WALL, DELIBERATELY DECLARED HERE (the trap this ticket's brief names by name) ───────
// `social_post_client_reviews` (0105) is the ONE plain-tenant-wall table in the social module — see
// `modules/social/client-review.ts`'s header for D-16's full reasoning. This controller's own read/
// write of THAT table needs no module scope. But `decide()` below ALSO joins to
// `social_post_variants`/`social_posts` (to read the variant's LIVE `args_sha256`, so
// `reviewed_args_sha256` snapshots what the client is deciding against RIGHT NOW, not what they saw
// when a stale detail page loaded) — and those two ARE third-walled. Portal controllers declare no
// module scope by convention (D-16's own words: "portal controllers are core and declare no module
// scope"), so this file calls `declareSocialModuleScope` explicitly, exactly where the join needs it
// and nowhere else. Omit it and the join returns ZERO ROWS, silently — every legitimate decide would
// read as "review not found" (see `social-client-review-portal.controller.test.ts`'s regression case).
//
// ── IDEMPOTENT DECISION ────────────────────────────────────────────────────────────────────────────
// The guarded `UPDATE ... WHERE status = 'pending'` is the SAME single-row compare-and-swap idiom
// `dispatch.ts`'s `stampDispatchOutcome` uses — no advisory lock needed (unlike the pipeline-gate
// decide path, which spans MULTIPLE rows under `lockPipelineRun`): Postgres's own MVCC row lock
// makes a concurrent second UPDATE on the same row either wait and then see `status <> 'pending'`,
// or race the first and lose, atomically. A retry that lands after the row already moved therefore
// affects ZERO rows; this file distinguishes that from "does not exist" (existence-oracle-unsafe if
// merged with the not-found case, so it is only ever reached AFTER ownership was already proven by
// the read above) and answers:
//   - retry carries the SAME decision already on file  -> 200, `alreadyDecided: true`, no side effect
//     re-run (no second event, no second notification) — deciding twice must not double-apply.
//   - retry carries a DIFFERENT decision                -> 409, a genuine conflict, never silently
//     overwritten.
import { BadRequestException, Body, ConflictException, Controller, HttpCode, NotFoundException, Param, Post, Get, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { resolvePortalScope } from "./portal-scope";
import { declareSocialModuleScope } from "../modules/social/publish-precondition";

const DECISIONS = new Set(["approved", "changes_requested"]);

interface ReviewOwnerRow {
  variant_id: string;
  engagement_id: string;
  live_args_sha256: string | null;
}

type DecideOutcome =
  | { kind: "not_found" }
  | { kind: "already_decided"; status: string; variantId: string }
  | { kind: "ok"; variantId: string; engagementId: string };

@Controller("api")
@UseGuards(AuthGuard)
export class SocialClientReviewPortalController {
  /** "Posts awaiting my brand's sign-off" (and, with `?status=`, the caller's full history). Same
   *  200-row cap every other portal list uses. */
  @Get(":tenantId/portal/social-reviews")
  async list(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      // The variant/post/account joins are third-walled — see this file's header.
      await declareSocialModuleScope(c);
      const params: unknown[] = [scope.clientIds];
      const statusClause = status ? (params.push(status), `AND r.status = $${params.length}`) : "";
      const rows = await c.query(
        `SELECT r.id, r.status, r.comment, r.requested_at AS "requestedAt", r.decided_at AS "decidedAt",
                v.id AS "variantId", v.body, v.media, v.settings, v.scheduled_at AS "scheduledAt",
                a.network, p.title AS "postTitle"
           FROM social_post_client_reviews r
           JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id
           JOIN social_posts p         ON p.id = v.post_id    AND p.tenant_id = v.tenant_id
           JOIN social_accounts a      ON a.id = v.account_id AND a.tenant_id = v.tenant_id
          WHERE r.client_id = ANY($1::uuid[]) ${statusClause}
          ORDER BY r.requested_at DESC LIMIT 200`,
        params,
      );
      return rows.rows;
    });
  }

  @Post(":tenantId/portal/social-reviews/:id/decide")
  @HttpCode(200)
  async decide(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { decision?: string; comment?: string },
  ) {
    const { decision, comment } = body ?? {};
    if (!decision || !DECISIONS.has(decision)) {
      throw new BadRequestException("decision must be approved|changes_requested");
    }
    await authorize(req.principal, { kind: "portal", tenantId }, "approve_post");

    const decided = await withTenants([tenantId], async (c): Promise<DecideOutcome> => {
      const scope = await resolvePortalScope(c, req.principal);
      // Third wall for the variant/post joins below — see this file's header.
      await declareSocialModuleScope(c);

      // Ownership resolved HERE, in the same query as the content the decision snapshots — a review
      // outside the caller's client set reads as "not found", never "not yours" (0075's rule 1, the
      // same existence-oracle avoidance every portal read in this estate applies).
      const owner = await c.query<ReviewOwnerRow>(
        `SELECT r.variant_id, p.engagement_id, v.args_sha256 AS live_args_sha256
           FROM social_post_client_reviews r
           JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id
           JOIN social_posts p         ON p.id = v.post_id    AND p.tenant_id = v.tenant_id
          WHERE r.id = $1 AND r.client_id = ANY($2::uuid[])`,
        [id, scope.clientIds],
      );
      if (!owner.rows[0]) return { kind: "not_found" };
      const { variant_id: variantId, engagement_id: engagementId, live_args_sha256: liveHash } = owner.rows[0];

      // The guarded UPDATE re-checks BOTH the ownership predicate and `status = 'pending'` — the
      // ownership check here is belt-and-suspenders on top of the SELECT above (0075's own two-place
      // idiom, `PortalController.decideGate`'s own precedent), not a second independent gate.
      const res = await c.query<{ status: string }>(
        `UPDATE social_post_client_reviews
            SET status = $2, comment = COALESCE($3, comment), reviewed_args_sha256 = $4,
                decided_by = $5, decided_at = now(), updated_at = now()
          WHERE id = $1 AND client_id = ANY($6::uuid[]) AND status = 'pending'
          RETURNING status`,
        [id, decision, comment ?? null, liveHash, req.principal.userId, scope.clientIds],
      );
      if (res.rowCount === 0) {
        // Ownership was already proven above, so distinguishing "already decided" here discloses
        // nothing an attacker without that ownership could reach — see this file's header.
        const cur = await c.query<{ status: string }>(`SELECT status FROM social_post_client_reviews WHERE id = $1`, [id]);
        return { kind: "already_decided", status: cur.rows[0]?.status ?? "unknown", variantId };
      }

      // Transactional outbox: the row and its event commit or roll back together. Rides the
      // already-drained "social_post_variant" stream — see event-handlers.ts's own header.
      await emitEvent(c, tenantId, "social_post_variant", variantId, "social.client_review.decided", {
        reviewId: id, decision, engagementId,
      });
      return { kind: "ok", variantId, engagementId };
    });

    if (decided.kind === "not_found") throw new NotFoundException("review not found");
    if (decided.kind === "already_decided") {
      // IDEMPOTENT: a retry that lands after the row already moved. Same decision on file -> report
      // the current state, no side effect re-run. A DIFFERENT decision is a genuine conflict — the
      // review is a one-shot decision, never silently flipped.
      if (decided.status === decision) return { id, status: decided.status, alreadyDecided: true };
      throw new ConflictException({ message: "client_review_already_decided" });
    }

    await writeActivity(tenantId, req.principal.userId, decision, "social_post_client_review", id, {
      variantId: decided.variantId, via: "portal",
    });
    return { id, status: decision };
  }
}

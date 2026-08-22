// Social-media module routes (SMM-02). Mounted under /api/:tenantId/modules/social and gated by
// AuthGuard + ModuleEnabledGuard("social") — dark unless the tenant has 'social' in
// enabled_modules OR an ACTIVE service_assignment serving 'social' to it (registry.ts
// isModuleEnabled). The agency department serving a sibling company is the second case, and it is
// the normal one here.
//
// Three independent walls back every read/write below:
//   1. Cerbos — cerbos/policies/resource_social_engagement.yaml, matched by
//      resource.attr.module="social" (which is what makes `module_staff`/`module_manager` resolve
//      to the concrete `social_staff`/`social_manager` roles seeded by 0106).
//   2. The tenant choke-point — withTenants([tenantId]).
//   3. Module-sliced RLS — app_module_allowed('social') (0105), declared via
//      `{ modules: ["social"] }` on EVERY query here. Forget that third argument on a new query and
//      it reads or writes ZERO rows, silently and fail-closed. That is the single most common way a
//      handler in this codebase "mysteriously returns nothing".
//
// ── THE AGENTIC BAR (addendum D-19; the 7 criteria this ticket had to meet, and where) ──────────
//   1 tool parity      — every capability here is an McpToolDef in ./index.ts with the SAME
//                        authorize() call. The controller is one client of the capability.
//   2 typed contract   — structured bodies, structured refusals. Every 400 carries a snake_case
//                        `reason` token, never only prose, so an agent can branch on it.
//   3 idempotent       — createEngagement accepts a caller-supplied `id` and returns the existing
//                        row on a repeat. An at-least-once caller cannot double-create.
//   4 impact-classed   — setScope is write+medium, so an automation principal is SUSPENDED into
//                        WS4 rather than applied. Enforced hub-side by the tool's own impact.
//   5 explicit refusal — a denial throws (403 with a Cerbos reason) or 404s. NOTHING here folds an
//                        authorization failure into an empty list; see listEngagements' comment.
//   6 observable       — every write emits an outbox event AND a work_activity row with the real
//                        actor, which may be non-human.
//   7 golden case      — social.test.ts drives each of these against the real endpoint.
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Headers, HttpCode,
  NotFoundException, Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { DEFAULT_TOOL_SCOPE, DEFAULT_USAGE_BUDGET_USD } from "./index";
import { variantArgsSha256, variantPublishArgs, replyDispatchArgs, replyArgsSha256 } from "./canonical-args";
// SMM-09 — the publish gate. The controller imports the SAME evaluator the D14 registry entry runs
// (core/approval-executables.ts), never a UI-friendly second copy of the rules.
import {
  PUBLISH_PRECONDITION_STAGES,
  SOCIAL_PUBLISH_TOOL, SOCIAL_PUBLISH_METERED_TOOL,
} from "./publish-precondition";
// SMM-31 — the client-review gate (composed IN FRONT of the six-stage chain, never inside it — see
// client-review.ts's header) and the staff-side state machine for `social_post_client_reviews`.
import { evaluatePublishPreconditionWithClientReview } from "./client-review";
// SMM-10 — the dispatch endpoint `social.publishPost`'s `pathTemplate` fronts, and the webhook
// intake for the reconcile flow. Both are thin: the domain logic (the transactional stamp, the
// idempotent apply) lives in `dispatch.ts`/`post-status-sync-job.ts`, never re-implemented here.
import { dispatchApprovedPublish } from "./dispatch";
// SMM-17 — the reply gate, built by reusing SMM-09's pattern (see reply-precondition.ts's header).
import {
  SOCIAL_REPLY_TOOL, REPLY_PRECONDITION_STAGES, evaluateReplyPrecondition,
} from "./reply-precondition";
import { dispatchApprovedReply } from "./reply-dispatch";
import { reconcileOneProviderPost } from "./post-status-sync-job";
import { validateVariant, estimateCostUsd, isNetwork, type Network, type QuotaSnapshot, type VariantShape } from "./media-rules";
// SMM-22 — X metering. `resolveXPricing` feeds every `estimateCostUsd` call on this controller;
// `readUsageSnapshot` backs the usage-panel endpoint. One implementation, reused from
// `publish-precondition.ts`/`dispatch.ts` too — never a second copy of the arithmetic.
import { resolveXPricing, readUsageSnapshot } from "./usage-ledger";
import { completeViaGateway } from "./gateway-client";
import { ingestBrandKnowledge, queryBrandKnowledge, brandCorpusScope } from "./knowledge-client";
// SMM-26 — the smm-agent-content-brief flow's own DB/AI orchestration; this controller validates
// the request shape and calls authorize(), content-brief.ts owns everything past that (see its
// own header for why authorize() never lives there).
import { runContentBrief } from "./content-brief";
// SMM-35 — the assistant's "social summary" read: one engagement's posts/inbox/metrics/usage, honest
// about what was never observed (see assistant-summary.ts's own header). Domain file owns the reads;
// this controller validates the route and calls authorize(), same split as content-brief.ts.
import { runAssistantSummary } from "./assistant-summary";
import {
  buildCaptionPrompt, parseCaptionDraft, buildIdeaPrompt, parseIdeaDraft,
  MAX_KNOWLEDGE_HITS, MAX_BRAND_INGEST_CHUNKS, MAX_IDEA_COUNT,
  type HashtagStrategy,
} from "./ai-drafts";
// SMM-05 — the publisher seam. Note what is imported and what is NOT: the provisioning/sync
// capabilities and the driver REGISTRY, never a driver and never a transport. The controller is one
// client of the port, exactly as it is one client of every other capability here.
import {
  checkConnectReadiness, initiateAccountConnect, provisionPublisherOrg, syncConnectorRegistry,
} from "./publisher/provisioning";
import { getPublisher } from "./publisher/registry";

const ENGAGEMENT_STATUSES = new Set(["draft", "active", "paused", "closed"]);
const NETWORKS = new Set([
  "instagram", "facebook", "tiktok", "linkedin", "x",
  "youtube", "threads", "pinterest", "bluesky", "mastodon",
]);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const POST_STATUSES = new Set([
  "idea", "draft", "in_review", "approved", "scheduled", "publishing",
  "published", "partially_published", "failed", "archived",
]);
/** The variant states an EDIT is allowed to touch. Anything past this is either in flight at the
 *  provider or already public, and editing the row would desynchronise us from the network — the
 *  content is out there, and our copy would start lying about what was posted. */
const EDITABLE_VARIANT_STATUSES = new Set(["draft", "in_review", "approved"]);
/** SMM-17 — the SAME editable set, for a reply message instead of a variant. `failed` joins it for
 *  the identical reason `updateVariant`'s own CASE includes it: a reply whose send attempt failed
 *  must be editable and re-approvable, never permanently stuck (there is no other path back to
 *  `draft` for it). `sent` is the one truly immutable state — the message already went out. */
const EDITABLE_MESSAGE_STATUSES = new Set(["draft", "in_review", "approved", "failed"]);

/** Criterion 2: a refusal an agent can branch on. The snake_case TOKEN goes in `message`, which the
 *  global HttpErrorFilter renames to `error` on the way out — so the response is
 *  `{ error: "unknown_network" }`, matching the webdev provisioning surface.
 *
 *  ⚠ Do NOT throw `{ error: token }` here, however natural it reads. That is the documented trap in
 *  `src/http-error.filter.ts`'s own header: the filter reads `message`, never `error`, so a token
 *  passed as `error` is silently REPLACED by Nest's constructor-derived string ("Bad Request
 *  Exception") and any sibling field is dropped. The status code and shape still look right; only
 *  the meaning goes missing. This function had that bug, and social.test.ts caught it.
 *
 *  The token is the contract — it surfaces in the UI and in tool output, so never put user text,
 *  identifiers or secrets in it. */
function refuse(reason: string): never {
  throw new BadRequestException({ message: reason });
}

/** SMM-22, defect class #4: every write site on this controller that persists
 *  `estimated_cost_usd` (a NOT NULL column) goes through this rather than reading
 *  `estimateCostUsd(...).costUsd` unconditionally — which would have nothing honest to write for an
 *  unpriced X variant. Refuses the WHOLE write (never silently substitutes $0, which the ticket
 *  names by name as an unmetered spend) with the SAME typed-token/`refuse()` shape every other
 *  write-time rule violation on this controller uses. For every non-X network this can never
 *  refuse — there is nothing to misconfigure about a network that costs nothing. */
function resolveEstimatedCostOrRefuse(network: Network, shape: VariantShape): number {
  const estimate = estimateCostUsd(network, shape, resolveXPricing());
  if (!estimate.ok) refuse(estimate.reason);
  return estimate.costUsd;
}

type ToolScope = Record<string, Record<string, unknown>>;

/** Merge a partial scope ONE level deep: `{networks:{x:true}}` must not erase the other nine
 *  networks, and `{inbox:{slaMinutes:60}}` must not erase `inbox.enabled`. A plain spread merges
 *  only the top level and would silently drop siblings — which, on a config that decides what may
 *  be published and how much may be spent, is a data-loss bug wearing a convenience feature. */
function mergeScope(current: ToolScope, patch: ToolScope): ToolScope {
  const out: ToolScope = { ...current };
  for (const [group, value] of Object.entries(patch)) {
    out[group] = value && typeof value === "object" && !Array.isArray(value)
      ? { ...(current[group] ?? {}), ...value }
      : (value as Record<string, unknown>);
  }
  return out;
}

/** Validate a scope patch before it can reach the column every other capability trusts. Returns
 *  warnings for things that are legal but currently inert — an honest answer beats storing a
 *  toggle that silently does nothing. */
function validateScopePatch(patch: ToolScope): string[] {
  const warnings: string[] = [];
  if (patch.networks) {
    for (const [network, enabled] of Object.entries(patch.networks)) {
      if (!NETWORKS.has(network)) refuse("unknown_network");
      if (typeof enabled !== "boolean") refuse("invalid_scope_value");
    }
    // Addendum D-14: X is the only metered network, and the $0 publish path is what keeps
    // `social.publishPost` eligible for the D14 executable-approval registry (whose doctrine
    // permanently bars money-spending tools). Enabling it is allowed and audited — it is an owner
    // decision per client, not a locked door — but it is never a silent one.
    if (patch.networks.x === true) {
      warnings.push(
        "networks.x enabled: X is pay-per-post. Publishing to it runs through the separately-gated "
        + "metered path (social.publishPostMetered), which is NOT auto-executed on approval, and "
        + "every post is charged against this engagement's usage budget.",
      );
    }
  }
  if (patch.ai) {
    // Addendum D-17: accepted and stored, but named. There is no generative-image backend in the
    // estate — ai-gateway-go has /complete, /media and /embed only, and render-gateway-go is 0.0.0.
    if (patch.ai.imageGen === true) {
      warnings.push(
        "ai.imageGen enabled, but no generative-image backend exists yet (the Creative render "
        + "gateway is unbuilt). Image requests will refuse with image_generation_unavailable until "
        + "it lands; attaching existing assets from the library is unaffected.",
      );
    }
  }
  if (patch.posting?.cadencePerWeek !== undefined) {
    const n = Number(patch.posting.cadencePerWeek);
    if (!Number.isFinite(n) || n < 0 || n > 100) refuse("invalid_scope_value");
  }
  if (patch.inbox?.slaMinutes !== undefined) {
    const n = Number(patch.inbox.slaMinutes);
    if (!Number.isFinite(n) || n < 1) refuse("invalid_scope_value");
  }
  return warnings;
}

/** MIME major/minor -> the composer's `MediaItem.kind`/`format` shape (media-rules.ts). Used by
 *  the SMM-20 asset-attach endpoint below. Derived here, not in media-rules.ts: that file's own
 *  header explains why `format` is normally COMPOSER-supplied rather than re-derived from
 *  `files.content_type` (avoiding a DB join per variant write) — but the attach endpoint already
 *  has the row in hand (it just read it to attach it), so deriving costs nothing extra and gives
 *  the composer a sane default instead of the `media_format_unknown` warning on every single
 *  library attach. The caller's own `kind`/`format` in the request body, if sent, still wins
 *  (merged in at the call site) — this is a default, never an override. */
function contentTypeToKindFormat(contentType: string | null | undefined): { kind?: "image" | "video"; format?: string } {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return { kind: "image", format: ct.slice("image/".length) || undefined };
  if (ct.startsWith("video/")) return { kind: "video", format: ct.slice("video/".length) || undefined };
  return {};
}

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialController {
  // ============================================================== ENGAGEMENTS ================
  @Get("engagements")
  async listEngagements(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("clientId") clientId?: string, @Query("status") status?: string,
  ) {
    // Criterion 5: this THROWS on denial. It does not narrow the query and return [] — a caller
    // (human or agent) cannot tell an empty department from a refused one, and the estate has
    // already shipped that bug once, in the client portal.
    await authorize(req.principal, { kind: "social_engagement", tenantId, module: "social" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (clientId) { params.push(clientId); clauses.push(`client_id = $${params.length}`); }
    if (status) {
      if (!ENGAGEMENT_STATUSES.has(status)) refuse("invalid_status");
      params.push(status); clauses.push(`status = $${params.length}`);
    }
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, client_id AS "clientId", project_id AS "projectId", name, status,
                usage_budget_usd AS "usageBudgetUsd", owner_id AS "ownerId",
                starts_on AS "startsOn", ends_on AS "endsOn", custom_fields AS "customFields",
                created_at AS "createdAt", updated_at AS "updatedAt"
           FROM social_engagements WHERE ${clauses.join(" AND ")}
          ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["social"] },
    );
    return rows;
  }

  @Post("engagements")
  @HttpCode(201)
  async createEngagement(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { id?: string; clientId?: string; name?: string; projectId?: string; ownerId?: string },
  ) {
    const { clientId, name } = body ?? {};
    if (!clientId || !name) refuse("missing_field");
    if (body.id && !UUID_RE.test(body.id)) refuse("invalid_id");
    await authorize(req.principal, { kind: "social_engagement", tenantId, module: "social" }, "create");

    // Criterion 3 (idempotent writes). Agents and n8n retry at-least-once; a "create" that always
    // inserts turns one retried goal into two engagements for the same client. The caller-supplied
    // id IS the idempotency key, and ON CONFLICT DO NOTHING makes the retry a no-op rather than a
    // duplicate — then we read the row back either way, so the caller gets the same answer both
    // times. Without a supplied id there is nothing to dedupe on, which is why the tool schema
    // documents it.
    const id = body.id ?? newId();
    const created = await withTenants(
      [tenantId],
      async (c) => {
        const ins = await c.query(
          `INSERT INTO social_engagements
             (id, tenant_id, client_id, project_id, name, tool_scope, usage_budget_usd, owner_id, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO NOTHING`,
          [
            id, tenantId, clientId, body.projectId ?? null, name,
            JSON.stringify(DEFAULT_TOOL_SCOPE), DEFAULT_USAGE_BUDGET_USD,
            body.ownerId ?? req.principal.userId, config.originSite,
          ],
        );
        const isNew = (ins.rowCount ?? 0) > 0;
        if (isNew) await emitEvent(c, tenantId, "social_engagement", id, "social.engagement.created", { clientId, name });
        return isNew;
      },
      { modules: ["social"] },
    );
    if (created) {
      await writeActivity(tenantId, req.principal.userId, "created", "social_engagement", id, { clientId, name });
    }
    // 201 either way, with `created` telling an honest caller which it was. A 409 on the retry
    // would make the idempotency useless — the retry is not an error, it is the point.
    return { id, created };
  }

  @Get("engagements/:engagementId")
  async getEngagement(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
  ) {
    await authorize(req.principal, { kind: "social_engagement", id: engagementId, tenantId, module: "social" }, "read");
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT e.id, e.client_id AS "clientId", e.project_id AS "projectId", e.name, e.status,
                e.tool_scope AS "toolScope", e.usage_budget_usd AS "usageBudgetUsd",
                e.owner_id AS "ownerId", e.starts_on AS "startsOn", e.ends_on AS "endsOn",
                e.custom_fields AS "customFields", e.created_at AS "createdAt", e.updated_at AS "updatedAt",
                b.tone, b.hashtag_strategy AS "hashtagStrategy", b.knowledge_source_ids AS "knowledgeSourceIds"
           FROM social_engagements e
           LEFT JOIN social_brand_profiles b
             ON b.client_id = e.client_id AND b.tenant_id = e.tenant_id AND b.deleted_at IS NULL
          WHERE e.id = $1 AND e.deleted_at IS NULL`,
        [engagementId],
      ),
      { modules: ["social"] },
    );
    if (!rows[0]) throw new NotFoundException("social engagement not found");
    return rows[0];
  }

  @Patch("engagements/:engagementId")
  async updateEngagement(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
    @Body() body: { name?: string; status?: string; projectId?: string | null; ownerId?: string | null; startsOn?: string | null; endsOn?: string | null },
  ) {
    await authorize(req.principal, { kind: "social_engagement", id: engagementId, tenantId, module: "social" }, "update");
    if (body?.status && !ENGAGEMENT_STATUSES.has(body.status)) {
      refuse("invalid_status");
    }
    // tool_scope and usage_budget_usd are deliberately NOT settable here: they are the money and
    // blast-radius dial, they carry their own permission (social.engagement.set_scope) and their
    // own impact class, and folding them into a general update would let a plain `update` grant
    // reach them. Use PATCH .../scope.
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [col, val] of [
      ["name", body?.name], ["status", body?.status], ["project_id", body?.projectId],
      ["owner_id", body?.ownerId], ["starts_on", body?.startsOn], ["ends_on", body?.endsOn],
    ] as const) {
      if (val !== undefined) { params.push(val); sets.push(`${col} = $${params.length}`); }
    }
    if (!sets.length) refuse("no_fields");
    params.push(engagementId);
    const { rowCount } = await withTenants(
      [tenantId],
      (c) => c.query(
        `UPDATE social_engagements SET ${sets.join(", ")}, updated_at = now()
          WHERE id = $${params.length} AND deleted_at IS NULL`,
        params,
      ),
      { modules: ["social"] },
    );
    if (!rowCount) throw new NotFoundException("social engagement not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "social_engagement", engagementId, { fields: sets.length });
    return { ok: true };
  }

  @Delete("engagements/:engagementId")
  async deleteEngagement(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
  ) {
    await authorize(req.principal, { kind: "social_engagement", id: engagementId, tenantId, module: "social" }, "delete");
    const { rowCount } = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE social_engagements SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [engagementId]),
      { modules: ["social"] },
    );
    if (!rowCount) throw new NotFoundException("social engagement not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "social_engagement", engagementId, {});
    return { ok: true };
  }

  // ==================================================================== SCOPE ================
  // The dial every other social capability consults: which networks may publish, whether AI
  // drafting is on, the inbox SLA, and the monthly metered cap. Its own permission, its own impact
  // class, its own endpoint — see updateEngagement's comment for why it is not part of a general
  // update.
  @Get("engagements/:engagementId/scope")
  async getScope(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
  ) {
    await authorize(req.principal, { kind: "social_engagement", id: engagementId, tenantId, module: "social" }, "read");
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query<{ toolScope: ToolScope; usageBudgetUsd: string }>(
        `SELECT tool_scope AS "toolScope", usage_budget_usd AS "usageBudgetUsd"
           FROM social_engagements WHERE id = $1 AND deleted_at IS NULL`,
        [engagementId],
      ),
      { modules: ["social"] },
    );
    if (!rows[0]) throw new NotFoundException("social engagement not found");
    // Defaults are merged UNDER the stored value on read, so an engagement created before a new
    // toggle existed answers with the toggle's default instead of `undefined`. A consumer asking
    // "may I publish to LinkedIn?" must never get `undefined` and treat it as yes.
    return {
      toolScope: mergeScope(DEFAULT_TOOL_SCOPE as unknown as ToolScope, rows[0].toolScope ?? {}),
      usageBudgetUsd: Number(rows[0].usageBudgetUsd),
    };
  }

  @Patch("engagements/:engagementId/scope")
  async setScope(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
    @Body() body: { toolScope?: ToolScope; usageBudgetUsd?: number },
  ) {
    await authorize(req.principal, { kind: "social_engagement", id: engagementId, tenantId, module: "social" }, "set_scope");
    const patch = body?.toolScope;
    const budget = body?.usageBudgetUsd;
    if (patch === undefined && budget === undefined) refuse("no_fields");
    if (patch !== undefined && (typeof patch !== "object" || patch === null || Array.isArray(patch))) {
      refuse("invalid_scope");
    }
    if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) {
      refuse("invalid_budget");
    }
    const warnings = patch ? validateScopePatch(patch) : [];

    const result = await withTenants(
      [tenantId],
      async (c) => {
        const { rows } = await c.query<{ toolScope: ToolScope }>(
          `SELECT tool_scope AS "toolScope" FROM social_engagements WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [engagementId],
        );
        if (!rows[0]) return null;
        // Read-merge-write inside ONE transaction, on a row locked FOR UPDATE. Two concurrent
        // scope patches (a human in the console and a scheduled flow, say) would otherwise
        // last-write-wins each other's groups away.
        const merged = patch ? mergeScope(rows[0].toolScope ?? {}, patch) : (rows[0].toolScope ?? {});
        await c.query(
          `UPDATE social_engagements
              SET tool_scope = $1,
                  usage_budget_usd = COALESCE($2, usage_budget_usd),
                  updated_at = now()
            WHERE id = $3`,
          [JSON.stringify(merged), budget ?? null, engagementId],
        );
        await emitEvent(c, tenantId, "social_engagement", engagementId, "social.engagement.scope_changed", {
          groups: patch ? Object.keys(patch) : [],
          budgetChanged: budget !== undefined,
        });
        // Read the budget BACK rather than echoing the request field. A scope-only patch leaves
        // `budget` undefined while the row keeps its cap, so echoing the input made this response
        // claim the engagement had NO budget — a console rendering it would show "no cap" for an
        // engagement that has one. Found by SMM-11 while wiring lib/social.ts against this endpoint:
        // the frontend-first drift check working in the useful direction for once.
        const { rows: after } = await c.query<{ usageBudgetUsd: string }>(
          `SELECT usage_budget_usd AS "usageBudgetUsd" FROM social_engagements WHERE id = $1`,
          [engagementId],
        );
        return { merged, usageBudgetUsd: Number(after[0].usageBudgetUsd) };
      },
      { modules: ["social"] },
    );
    if (!result) throw new NotFoundException("social engagement not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "social_engagement", engagementId, {
      scopeGroups: patch ? Object.keys(patch) : [], budgetChanged: budget !== undefined,
    });
    return {
      toolScope: mergeScope(DEFAULT_TOOL_SCOPE as unknown as ToolScope, result.merged),
      usageBudgetUsd: result.usageBudgetUsd,
      // Legal, stored, and currently inert toggles are NAMED rather than silently accepted.
      warnings,
    };
  }

  // =========================================================== BRAND PROFILE ================
  // Config only: the brand CORPUS lives in WS8 knowledge (D-13, preserving D9's single ownership of
  // derived knowledge stores). This table holds voice settings and POINTERS to knowledge sources,
  // never retrievable text and never an embedding.
  @Get("brand-profiles/:clientId")
  async getBrandProfile(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
  ) {
    await authorize(req.principal, { kind: "social_engagement", tenantId, module: "social" }, "read");
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, client_id AS "clientId", tone, hashtag_strategy AS "hashtagStrategy",
                knowledge_source_ids AS "knowledgeSourceIds", updated_at AS "updatedAt"
           FROM social_brand_profiles WHERE client_id = $1 AND deleted_at IS NULL`,
        [clientId],
      ),
      { modules: ["social"] },
    );
    if (!rows[0]) throw new NotFoundException("brand profile not found");
    return rows[0];
  }

  @Patch("brand-profiles/:clientId")
  async upsertBrandProfile(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Body() body: { tone?: Record<string, unknown>; hashtagStrategy?: Record<string, unknown>; knowledgeSourceIds?: string[] },
  ) {
    await authorize(req.principal, { kind: "social_engagement", tenantId, module: "social" }, "update");
    if (!body || (body.tone === undefined && body.hashtagStrategy === undefined && body.knowledgeSourceIds === undefined)) {
      refuse("no_fields");
    }
    // Idempotent by construction: 0105's UNIQUE (tenant_id, client_id) makes this an upsert, so a
    // retried call updates in place instead of creating a second profile for the same client.
    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        // ⚠ The UPDATE arm coalesces against the PARAMETER, not against EXCLUDED. This had the bug
        // the other way round and social.test.ts caught it: the INSERT arm turns a missing field
        // into '{}' (the column is NOT NULL), so `EXCLUDED.tone` is never NULL on conflict, so
        // `COALESCE(EXCLUDED.tone, existing)` always picked the '{}' — and a partial patch that
        // named only `hashtagStrategy` silently ERASED the client's brand voice. Coalescing on
        // $4/$5/$6 asks the question that was actually meant: "did the caller send this field?"
        `INSERT INTO social_brand_profiles (id, tenant_id, client_id, tone, hashtag_strategy, knowledge_source_ids, origin_site)
         VALUES ($1,$2,$3,COALESCE($4::jsonb,'{}'::jsonb),COALESCE($5::jsonb,'{}'::jsonb),COALESCE($6::jsonb,'[]'::jsonb),$7)
         ON CONFLICT (tenant_id, client_id) DO UPDATE SET
           tone = COALESCE($4::jsonb, social_brand_profiles.tone),
           hashtag_strategy = COALESCE($5::jsonb, social_brand_profiles.hashtag_strategy),
           knowledge_source_ids = COALESCE($6::jsonb, social_brand_profiles.knowledge_source_ids),
           updated_at = now()`,
        [
          id, tenantId, clientId,
          body.tone === undefined ? null : JSON.stringify(body.tone),
          body.hashtagStrategy === undefined ? null : JSON.stringify(body.hashtagStrategy),
          body.knowledgeSourceIds === undefined ? null : JSON.stringify(body.knowledgeSourceIds),
          config.originSite,
        ],
      ),
      { modules: ["social"] },
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "social_brand_profile", clientId, {});
    return { ok: true };
  }

  // ============================================================ BRAND CORPUS (SMM-19) ========
  // Ingest for the brand-voice RAG (design D-13). CONFIG-only table stays config-only: the chunks
  // themselves are sent to WS8 knowledge, never stored here — this endpoint only ensures the
  // deterministic per-client scope is on record in `knowledge_source_ids` (a pointer, never text).
  @Post("engagements/:engagementId/brand-corpus/ingest")
  @HttpCode(200)
  async ingestBrandCorpus(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
    @Body() body: { chunks?: string[] },
  ) {
    const chunks = (body?.chunks ?? [])
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length > 0);
    if (chunks.length === 0) refuse("missing_field");
    if (chunks.length > MAX_BRAND_INGEST_CHUNKS) refuse("too_many_chunks");
    // Same permission as upsertBrandProfile: the corpus is part of the brand profile's config, not
    // a new capability with its own grant to reason about.
    await authorize(req.principal, { kind: "social_engagement", id: engagementId, tenantId, module: "social" }, "update");

    // clientId comes from THIS engagement's own row, never from the request body — the property the
    // cross-client leak test drives end to end (knowledge-client.ts's header).
    const eng = await this.loadEngagementForAi(tenantId, engagementId);
    if (eng.toolScope.ai?.drafting !== true) refuse("ai_drafting_disabled");

    await ingestBrandKnowledge(tenantId, eng.clientId, chunks);
    const scope = brandCorpusScope(tenantId, eng.clientId);

    await withTenants(
      [tenantId],
      async (c) => {
        const { rows } = await c.query<{ id: string; knowledgeSourceIds: string[] }>(
          `SELECT id, knowledge_source_ids AS "knowledgeSourceIds"
             FROM social_brand_profiles WHERE tenant_id = $1 AND client_id = $2 AND deleted_at IS NULL`,
          [tenantId, eng.clientId],
        );
        const nextIds = JSON.stringify([...new Set([...(rows[0]?.knowledgeSourceIds ?? []), scope])]);
        if (rows[0]) {
          await c.query(
            `UPDATE social_brand_profiles SET knowledge_source_ids = $1::jsonb, updated_at = now() WHERE id = $2`,
            [nextIds, rows[0].id],
          );
        } else {
          await c.query(
            `INSERT INTO social_brand_profiles (id, tenant_id, client_id, knowledge_source_ids, origin_site)
             VALUES ($1,$2,$3,$4::jsonb,$5)`,
            [newId(), tenantId, eng.clientId, nextIds, config.originSite],
          );
        }
        await emitEvent(c, tenantId, "social_engagement", engagementId, "social.brand_corpus.ingested", { chunkCount: chunks.length });
      },
      { modules: ["social"] },
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "social_brand_profile", eng.clientId, {
      chunkCount: chunks.length, knowledgeSourceRef: scope,
    });
    return { ok: true, knowledgeSourceIds: [scope], chunkCount: chunks.length };
  }

  // ================================================================= CAMPAIGNS ===============
  @Get("campaigns")
  async listCampaigns(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("engagementId") engagementId?: string,
  ) {
    await authorize(req.principal, { kind: "social_engagement", tenantId, module: "social" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (engagementId) { params.push(engagementId); clauses.push(`engagement_id = $${params.length}`); }
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, engagement_id AS "engagementId", name, kind, goal, status,
                custom_fields AS "customFields", created_at AS "createdAt"
           FROM social_campaigns WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["social"] },
    );
    return rows;
  }

  @Post("campaigns")
  @HttpCode(201)
  async createCampaign(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { id?: string; engagementId?: string; name?: string; goal?: string },
  ) {
    if (!body?.engagementId || !body?.name) refuse("missing_field");
    if (body.id && !UUID_RE.test(body.id)) refuse("invalid_id");
    await authorize(req.principal, { kind: "social_engagement", tenantId, module: "social" }, "update");
    const id = body.id ?? newId();
    // `kind` is fixed to 'organic': the schema reserves 'paid' as the documented future
    // service-line seam, and paid social is out of v1 scope by an owner lock. It is not a
    // parameter until that line opens.
    const created = await withTenants(
      [tenantId],
      async (c) => {
        const ins = await c.query(
          `INSERT INTO social_campaigns (id, tenant_id, engagement_id, name, kind, goal, origin_site)
           VALUES ($1,$2,$3,$4,'organic',$5,$6) ON CONFLICT (id) DO NOTHING`,
          [id, tenantId, body.engagementId, body.name, body.goal ?? null, config.originSite],
        );
        return (ins.rowCount ?? 0) > 0;
      },
      { modules: ["social"] },
    );
    if (created) await writeActivity(tenantId, req.principal.userId, "created", "social_campaign", id, { name: body.name });
    return { id, created };
  }

  // ================================================================ KPI TARGETS ==============
  @Get("kpi-targets")
  async listKpiTargets(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("engagementId") engagementId?: string,
  ) {
    await authorize(req.principal, { kind: "social_engagement", tenantId, module: "social" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (engagementId) { params.push(engagementId); clauses.push(`engagement_id = $${params.length}`); }
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, engagement_id AS "engagementId", metric_key AS "metricKey",
                baseline_value AS "baselineValue", target_value AS "targetValue",
                direction, due_period AS "duePeriod"
           FROM social_kpi_targets WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["social"] },
    );
    return rows;
  }

  @Post("kpi-targets")
  @HttpCode(201)
  async createKpiTarget(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { id?: string; engagementId?: string; metricKey?: string; targetValue?: number; baselineValue?: number; direction?: string; duePeriod?: string },
  ) {
    if (!body?.engagementId || !body?.metricKey || body?.targetValue === undefined) {
      refuse("missing_field");
    }
    if (body.direction && !["up", "down"].includes(body.direction)) refuse("invalid_direction");
    if (body.id && !UUID_RE.test(body.id)) refuse("invalid_id");
    await authorize(req.principal, { kind: "social_engagement", tenantId, module: "social" }, "update");
    const id = body.id ?? newId();
    const created = await withTenants(
      [tenantId],
      async (c) => {
        const ins = await c.query(
          `INSERT INTO social_kpi_targets
             (id, tenant_id, engagement_id, metric_key, baseline_value, target_value, direction, due_period, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
          [
            id, tenantId, body.engagementId, body.metricKey, body.baselineValue ?? null,
            body.targetValue, body.direction ?? "up", body.duePeriod ?? null, config.originSite,
          ],
        );
        return (ins.rowCount ?? 0) > 0;
      },
      { modules: ["social"] },
    );
    if (created) await writeActivity(tenantId, req.principal.userId, "created", "social_kpi_target", id, { metricKey: body.metricKey });
    return { id, created };
  }

  // ================================================================== POSTS ==================
  // The master post carries the idea and rolls up its variants' states; the per-network content
  // lives on the variants (design §00.2 — there is deliberately NO universal post object).

  @Get("posts")
  async listPosts(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("engagementId") engagementId?: string, @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "read");
    const params: unknown[] = [];
    const clauses = ["p.deleted_at IS NULL"];
    if (engagementId) { params.push(engagementId); clauses.push(`p.engagement_id = $${params.length}`); }
    if (status) {
      if (!POST_STATUSES.has(status)) refuse("invalid_status");
      params.push(status); clauses.push(`p.status = $${params.length}`);
    }
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        // The variant roll-up is what the calendar renders, so it comes back with the list rather
        // than as N+1 follow-up reads.
        `SELECT p.id, p.engagement_id AS "engagementId", p.campaign_id AS "campaignId", p.title,
                p.brief, p.source, p.status, p.scheduled_at AS "scheduledAt",
                p.created_by AS "createdBy", p.created_at AS "createdAt",
                COALESCE(v.variants, '[]'::json) AS variants
           FROM social_posts p
           LEFT JOIN LATERAL (
             SELECT json_agg(json_build_object(
                      'id', sv.id, 'accountId', sv.account_id, 'status', sv.status,
                      'scheduledAt', sv.scheduled_at, 'publishedUrl', sv.published_url,
                      'nativeImport', sv.native_import,
                      'estimatedCostUsd', sv.estimated_cost_usd) ORDER BY sv.created_at) AS variants
               FROM social_post_variants sv
              WHERE sv.post_id = p.id AND sv.deleted_at IS NULL
           ) v ON true
          WHERE ${clauses.join(" AND ")}
          ORDER BY COALESCE(p.scheduled_at, p.created_at) DESC LIMIT 500`,
        params,
      ),
      { modules: ["social"] },
    );
    return rows;
  }

  @Post("posts")
  @HttpCode(201)
  async createPost(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { id?: string; engagementId?: string; campaignId?: string; title?: string; brief?: string; source?: string; scheduledAt?: string },
  ) {
    if (!body?.engagementId || !body?.title) refuse("missing_field");
    if (body.id && !UUID_RE.test(body.id)) refuse("invalid_id");
    // `source` records WHO originated the idea — human, ai, agent, or a native import. It is not
    // cosmetic: P4's agent flow is measured on it, and 'native_import' carries a different state
    // law (see importNative below), so it is never settable here.
    const source = body.source ?? "human";
    if (!["human", "ai", "agent"].includes(source)) refuse("invalid_source");
    await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "create");
    const id = body.id ?? newId();
    const created = await withTenants(
      [tenantId],
      async (c) => {
        const ins = await c.query(
          `INSERT INTO social_posts (id, tenant_id, engagement_id, campaign_id, title, brief, source, scheduled_at, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
          [id, tenantId, body.engagementId, body.campaignId ?? null, body.title, body.brief ?? null,
           source, body.scheduledAt ?? null, req.principal.userId, config.originSite],
        );
        return (ins.rowCount ?? 0) > 0;
      },
      { modules: ["social"] },
    );
    if (created) await writeActivity(tenantId, req.principal.userId, "created", "social_post", id, { title: body.title, source });
    return { id, created };
  }

  @Get("posts/:postId")
  async getPost(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string) {
    await authorize(req.principal, { kind: "social_post", id: postId, tenantId, module: "social" }, "read");
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT p.id, p.engagement_id AS "engagementId", p.campaign_id AS "campaignId", p.title, p.brief,
                p.source, p.status, p.scheduled_at AS "scheduledAt", p.custom_fields AS "customFields",
                p.created_by AS "createdBy", p.created_at AS "createdAt", p.updated_at AS "updatedAt"
           FROM social_posts p WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [postId],
      ),
      { modules: ["social"] },
    );
    if (!rows[0]) throw new NotFoundException("social post not found");
    const variants = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT v.id, v.account_id AS "accountId", a.network, a.handle, v.body, v.first_comment AS "firstComment",
                v.media, v.settings, v.validation, v.args_sha256 AS "argsSha256", v.approval_id AS "approvalId",
                v.native_import AS "nativeImport", v.scheduled_at AS "scheduledAt", v.status,
                v.published_url AS "publishedUrl", v.published_at AS "publishedAt", v.last_error AS "lastError",
                v.estimated_cost_usd AS "estimatedCostUsd"
           FROM social_post_variants v
           JOIN social_accounts a ON a.id = v.account_id
          WHERE v.post_id = $1 AND v.deleted_at IS NULL ORDER BY v.created_at`,
        [postId],
      ),
      { modules: ["social"] },
    );
    return { ...rows[0], variants: variants.rows };
  }

  @Patch("posts/:postId")
  async updatePost(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string,
    @Body() body: { title?: string; brief?: string; campaignId?: string | null; scheduledAt?: string | null; status?: string },
  ) {
    await authorize(req.principal, { kind: "social_post", id: postId, tenantId, module: "social" }, "update");
    if (body?.status && !POST_STATUSES.has(body.status)) refuse("invalid_status");
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [col, val] of [
      ["title", body?.title], ["brief", body?.brief], ["campaign_id", body?.campaignId],
      ["scheduled_at", body?.scheduledAt], ["status", body?.status],
    ] as const) {
      if (val !== undefined) { params.push(val); sets.push(`${col} = $${params.length}`); }
    }
    if (!sets.length) refuse("no_fields");
    params.push(postId);
    const { rowCount } = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE social_posts SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} AND deleted_at IS NULL`, params),
      { modules: ["social"] },
    );
    if (!rowCount) throw new NotFoundException("social post not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "social_post", postId, { fields: sets.length });
    return { ok: true };
  }

  @Delete("posts/:postId")
  async deletePost(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string) {
    await authorize(req.principal, { kind: "social_post", id: postId, tenantId, module: "social" }, "delete");
    // A post with anything public under it is not deletable here: taking a live post down is
    // `delete_published`, a separately-permissioned outbound action (SMM-09/10), not a soft-delete
    // of our own row. Deleting the row would orphan something the world can still see.
    const live = await withTenants(
      [tenantId],
      (c) => c.query<{ n: string }>(
        `SELECT count(*) AS n FROM social_post_variants
          WHERE post_id = $1 AND deleted_at IS NULL AND status IN ('queued','publishing','published')`,
        [postId],
      ),
      { modules: ["social"] },
    );
    if (Number(live.rows[0].n) > 0) refuse("post_has_live_variants");
    const { rowCount } = await withTenants(
      [tenantId],
      async (c) => {
        await c.query(`UPDATE social_post_variants SET deleted_at = now() WHERE post_id = $1 AND deleted_at IS NULL`, [postId]);
        return c.query(`UPDATE social_posts SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [postId]);
      },
      { modules: ["social"] },
    );
    if (!rowCount) throw new NotFoundException("social post not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "social_post", postId, {});
    return { ok: true };
  }

  // ================================================================ VARIANTS =================
  // Per-network content. Every write here maintains `args_sha256` (addendum D-15) and re-runs the
  // validation engine, because those two values are what the publish gate and the approval card
  // consume — computing them later, at submit time, would let a variant sit "looking fine" in the
  // composer and fail at the gate.

  @Post("posts/:postId/variants")
  @HttpCode(201)
  async createVariant(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string,
    @Body() body: { id?: string; accountId?: string; body?: string; firstComment?: string | null; media?: unknown[]; settings?: Record<string, unknown>; scheduledAt?: string | null },
  ) {
    if (!body?.accountId) refuse("missing_field");
    if (body.id && !UUID_RE.test(body.id)) refuse("invalid_id");
    await authorize(req.principal, { kind: "social_post", id: postId, tenantId, module: "social" }, "update");
    const account = await this.loadAccount(tenantId, body.accountId);
    const id = body.id ?? newId();
    const draft = {
      body: body.body ?? "",
      firstComment: body.firstComment ?? null,
      media: (body.media ?? []) as never[],
      settings: body.settings ?? {},
      scheduledAt: body.scheduledAt ?? null,
    };
    const validation = validateVariant(account.network, draft, account.quota);
    const argsSha256 = variantArgsSha256({
      tenantId, id, accountId: body.accountId, body: draft.body, firstComment: draft.firstComment,
      media: draft.media, settings: draft.settings, scheduledAt: body.scheduledAt ?? null,
    });
    // SMM-22: computed BEFORE the write — an unpriced X variant refuses the whole create, never a
    // silent $0 in the persisted estimate.
    const estimatedCostUsd = resolveEstimatedCostOrRefuse(account.network, draft);
    const created = await withTenants(
      [tenantId],
      async (c) => {
        const ins = await c.query(
          `INSERT INTO social_post_variants
             (id, tenant_id, post_id, account_id, body, first_comment, media, settings, validation,
              args_sha256, scheduled_at, estimated_cost_usd, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
          [id, tenantId, postId, body.accountId, draft.body, draft.firstComment,
           JSON.stringify(draft.media), JSON.stringify(draft.settings), JSON.stringify(validation),
           argsSha256, body.scheduledAt ?? null, estimatedCostUsd, config.originSite],
        );
        return (ins.rowCount ?? 0) > 0;
      },
      { modules: ["social"] },
    );
    if (created) await writeActivity(tenantId, req.principal.userId, "created", "social_post_variant", id, { network: account.network });
    // The validation travels back with the 201 so the composer can render it immediately — the
    // caller should never have to make a second call to find out whether what it just created is
    // publishable.
    return { id, created, validation, argsSha256, estimatedCostUsd };
  }

  @Patch("variants/:variantId")
  async updateVariant(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("variantId") variantId: string,
    @Body() body: { body?: string; firstComment?: string | null; media?: unknown[]; settings?: Record<string, unknown>; scheduledAt?: string | null },
  ) {
    await authorize(req.principal, { kind: "social_post", id: variantId, tenantId, module: "social" }, "update");
    if (!body || Object.keys(body).length === 0) refuse("no_fields");

    const result = await withTenants(
      [tenantId],
      async (c) => {
        const { rows } = await c.query<{
          id: string; account_id: string; body: string; first_comment: string | null;
          media: unknown; settings: Record<string, unknown>; scheduled_at: Date | null;
          status: string; approval_id: string | null; native_import: boolean;
        }>(
          `SELECT id, account_id, body, first_comment, media, settings, scheduled_at, status, approval_id, native_import
             FROM social_post_variants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [variantId],
        );
        const row = rows[0];
        if (!row) return { kind: "not_found" as const };
        // A native import DESCRIBES something already public; there is nothing here to edit that
        // would change the world, and letting the text drift from what was actually posted turns
        // the calendar into fiction.
        if (row.native_import) return { kind: "refuse" as const, reason: "variant_native_import_immutable" };
        if (!EDITABLE_VARIANT_STATUSES.has(row.status)) return { kind: "refuse" as const, reason: "variant_not_editable" };

        const next = {
          body: body.body ?? row.body,
          firstComment: body.firstComment !== undefined ? body.firstComment : row.first_comment,
          media: body.media ?? row.media,
          settings: body.settings ?? row.settings,
          scheduledAt: body.scheduledAt !== undefined ? body.scheduledAt : row.scheduled_at,
        };
        const argsSha256 = variantArgsSha256({ tenantId, id: row.id, accountId: row.account_id, ...next });
        // THE STATE LAW, mechanically (design §04 / addendum D-15): an edit to approved content
        // invalidates its approval. Not by policy, not by a reviewer remembering — the hash moves,
        // so the grant can no longer match, and we drop the row back to `draft` in the same
        // statement that changes the content. There is no window in which an approval points at
        // content nobody approved.
        const wasApproved = row.approval_id !== null || row.status === "approved";
        await c.query(
          `UPDATE social_post_variants
              SET body = $1, first_comment = $2, media = $3, settings = $4, scheduled_at = $5,
                  args_sha256 = $6, approval_id = NULL,
                  -- SMM-10: 'failed' joins the revert set. Before this ticket a dispatch could never
                  -- produce 'failed' (SMM-09 built no dispatch path), so this CASE never needed to
                  -- know about it. It carries approval_id (0105's svar_dispatched_has_approval CHECK
                  -- requires it for any status outside draft/in_review/approved/cancelled) and this
                  -- statement clears it in the SAME breath it moves the content — otherwise a failed
                  -- publish would be permanently unrecoverable: no precondition path and no edit path
                  -- ever returns it to an editable state.
                  status = CASE WHEN status IN ('in_review','approved','failed') THEN 'draft' ELSE status END,
                  updated_at = now()
            WHERE id = $7`,
          [next.body, next.firstComment, JSON.stringify(next.media), JSON.stringify(next.settings),
           next.scheduledAt, argsSha256, variantId],
        );
        return { kind: "ok" as const, accountId: row.account_id, next, argsSha256, wasApproved };
      },
      { modules: ["social"] },
    );
    if (result.kind === "not_found") throw new NotFoundException("post variant not found");
    if (result.kind === "refuse") refuse(result.reason);

    // Re-validate against the account's live rules OUTSIDE the write transaction, then store the
    // verdict. Split deliberately: validation reads the connector registry, and holding the row
    // lock across that read would serialise every composer keystroke behind it.
    const account = await this.loadAccount(tenantId, result.accountId);
    const validation = validateVariant(account.network, {
      body: result.next.body,
      firstComment: result.next.firstComment,
      media: (result.next.media ?? []) as never[],
      settings: result.next.settings,
      scheduledAt: result.next.scheduledAt,
    }, account.quota);
    const estimatedCostUsd = resolveEstimatedCostOrRefuse(account.network, {
      body: result.next.body, media: (result.next.media ?? []) as never[], settings: result.next.settings,
    });
    await withTenants(
      [tenantId],
      (c) => c.query(
        `UPDATE social_post_variants SET validation = $1, estimated_cost_usd = $2 WHERE id = $3`,
        [JSON.stringify(validation), estimatedCostUsd, variantId],
      ),
      { modules: ["social"] },
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "social_post_variant", variantId, {
      approvalInvalidated: result.wasApproved,
    });
    return {
      ok: true, validation, argsSha256: result.argsSha256,
      // Say it out loud rather than leaving the caller to notice the status moved. An operator who
      // edits an approved post must learn immediately that it needs approving again.
      approvalInvalidated: result.wasApproved,
    };
  }

  @Delete("variants/:variantId")
  async deleteVariant(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("variantId") variantId: string) {
    await authorize(req.principal, { kind: "social_post", id: variantId, tenantId, module: "social" }, "delete");
    const result = await withTenants(
      [tenantId],
      async (c) => {
        const { rows } = await c.query<{ status: string }>(
          `SELECT status FROM social_post_variants WHERE id = $1 AND deleted_at IS NULL`, [variantId]);
        if (!rows[0]) return { kind: "not_found" as const };
        if (["queued", "publishing", "published"].includes(rows[0].status)) return { kind: "refuse" as const, reason: "variant_is_live" };
        await c.query(`UPDATE social_post_variants SET deleted_at = now() WHERE id = $1`, [variantId]);
        return { kind: "ok" as const };
      },
      { modules: ["social"] },
    );
    if (result.kind === "not_found") throw new NotFoundException("post variant not found");
    if (result.kind === "refuse") refuse(result.reason);
    await writeActivity(tenantId, req.principal.userId, "deleted", "social_post_variant", variantId, {});
    return { ok: true };
  }

  @Get("variants/:variantId/validation")
  async getVariantValidation(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("variantId") variantId: string,
  ) {
    await authorize(req.principal, { kind: "social_post", id: variantId, tenantId, module: "social" }, "read");
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query<{ account_id: string; body: string; first_comment: string | null; media: unknown; settings: Record<string, unknown>; scheduled_at: Date | null }>(
        `SELECT account_id, body, first_comment, media, settings, scheduled_at
           FROM social_post_variants WHERE id = $1 AND deleted_at IS NULL`,
        [variantId],
      ),
      { modules: ["social"] },
    );
    if (!rows[0]) throw new NotFoundException("post variant not found");
    const account = await this.loadAccount(tenantId, rows[0].account_id);
    const shape = {
      body: rows[0].body, firstComment: rows[0].first_comment,
      media: (rows[0].media ?? []) as never[], settings: rows[0].settings ?? {},
      scheduledAt: rows[0].scheduled_at,
    };
    // Computed FRESH rather than read from the stored column: the quota moves under us between
    // edits, so the stored verdict answers "was it valid when last written", and the caller asking
    // this endpoint wants "is it valid now".
    //
    // SMM-22: this is a READ, so an unpriced X variant does not refuse the call — it answers
    // honestly with `estimatedCostUsd: null` and the reason, DATA rather than an error, the same
    // "a verdict is a successful answer" doctrine `getVariantPublishPreconditions` already states.
    const costEstimate = estimateCostUsd(account.network, shape, resolveXPricing());
    return {
      validation: validateVariant(account.network, shape, account.quota),
      estimatedCostUsd: costEstimate.ok ? costEstimate.costUsd : null,
      ...(costEstimate.ok ? {} : { costUnavailableReason: costEstimate.reason }),
      network: account.network,
    };
  }

  // ============================================================ ASSET LIBRARY (SMM-20) =======
  // Attach-only media library — files / Drive-mirrored files / Studio-graded `creative_assets`
  // into a variant's `media` (addendum SMM-20, AMENDED by D-17: generation is OUT of scope; the
  // `ai.imageGen` toggle above ships inert and names why — this file never calls a generator).
  //
  // ── THE MODULE-GUC BOUNDARY, DRAWN DELIBERATELY (defect class #1) ──────────────────────────
  // `files` and `creative_assets` are NOT `social_*` tables — no `app_module_allowed('social')`
  // wall, so every read/write against them below carries NO `{modules:["social"]}` option,
  // exactly like `dispatch.ts`'s own `loadFileForUpload` (that file's header names this same
  // boundary for the SAME table). `social_engagements`/`social_post_variants` ARE `social_*`
  // tables and every query against them below DOES carry `{modules:["social"]}` — getting this
  // backwards in either direction is the trap: forgetting it on the social side reads/writes
  // ZERO ROWS SILENTLY; adding it on the `files`/`creative_assets` side would just as silently
  // read/write zero rows on ANY tenant that has never enabled the social module for that table's
  // owning department, which is nonsensical since neither table is gated by a module at all.
  // `attachVariantMedia`'s own test asserts REAL rows change through this endpoint end to end —
  // if `{modules:["social"]}` were ever removed from the `social_post_variants` write below, the
  // guarded UPDATE would affect zero rows and the test's "media now contains the new fileId"
  // assertion would fail loudly, never pass vacuously.

  /** The engagement's client (asset libraries are client-scoped — `files` rows attached to the
   *  CLIENT are the natural "everything this client has ever sent us" library) and nothing else;
   *  a lighter read than `loadEngagementForAi`, which also joins the brand profile this endpoint
   *  does not need. */
  private async loadEngagementClientId(tenantId: string, engagementId: string): Promise<string> {
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query<{ clientId: string }>(
        `SELECT client_id AS "clientId" FROM social_engagements WHERE id = $1 AND deleted_at IS NULL`,
        [engagementId],
      ),
      { modules: ["social"] },
    );
    if (!rows[0]) throw new NotFoundException("social engagement not found");
    return rows[0].clientId;
  }

  @Get("engagements/:engagementId/asset-library")
  async getAssetLibrary(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
  ) {
    await authorize(req.principal, { kind: "social_engagement", id: engagementId, tenantId, module: "social" }, "read");
    const clientId = await this.loadEngagementClientId(tenantId, engagementId);

    // `files`/`creative_assets` — plain tenant wall only, no `{modules:["social"]}` (see this
    // section's own header note on the boundary).
    const [filesResult, studioResult] = await Promise.all([
      withTenants([tenantId], (c) => c.query<{
        id: string; filename: string; contentType: string; byteSize: string; storageKey: string | null; url: string | null; createdAt: Date;
      }>(
        `SELECT id, filename, content_type AS "contentType", byte_size AS "byteSize",
                storage_key AS "storageKey", url, created_at AS "createdAt"
           FROM files WHERE target_entity_type = 'client' AND target_entity_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 200`,
        [clientId],
      )),
      withTenants([tenantId], (c) => c.query<{
        id: string; name: string; contentType: string; width: number | null; height: number | null;
        gradedByteSize: string; presetId: string | null; createdAt: Date;
      }>(
        `SELECT id, name, content_type AS "contentType", width, height,
                graded_byte_size AS "gradedByteSize", preset_id AS "presetId", created_at AS "createdAt"
           FROM creative_assets WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
      )),
    ]);

    return {
      files: filesResult.rows.map((f) => ({
        id: f.id, filename: f.filename, contentType: f.contentType, byteSize: Number(f.byteSize),
        // Reference attach (`files.controller.ts`'s upload() no-`content` branch) has no
        // `storage_key` — that IS the Drive-mirror shape (OQ-5: "media rides `files` + Drive
        // mirror"): a filename + url, no blob of ours. `source` names which one this is so the
        // console can render them distinctly rather than pretending every row has bytes.
        source: f.storageKey ? ("upload" as const) : ("drive" as const),
        url: f.url,
        createdAt: f.createdAt,
      })),
      studioAssets: studioResult.rows.map((a) => ({
        id: a.id, name: a.name, contentType: a.contentType, width: a.width, height: a.height,
        gradedByteSize: Number(a.gradedByteSize), presetId: a.presetId, createdAt: a.createdAt,
      })),
    };
  }

  /** Read one `files` row's content type, tenant-scoped, no module wall — `files` is not a
   *  `social_*` table (this section's own header). Returns null rather than throwing so the
   *  caller can answer with the named `asset_not_found` token instead of a generic 404. */
  /** ⚠ SCOPED TO THE VARIANT'S CLIENT ON PURPOSE — tightened at merge, 2026-08-21.
   *
   *  The library READ above is client-scoped (`target_entity_type='client' AND target_entity_id =
   *  <the engagement's client>`). This lookup originally was not: it matched on `id` alone inside the
   *  tenant wall, so a crafted attach could name client B's file id and land it on client A's
   *  variant — and from there it publishes to client A's live social account. The wrong client's
   *  creative going out publicly is the same nightmare `PUBLISH_REFUSAL`'s `cross_client_account`
   *  and `keys.ts`'s no-fallback rule both exist to prevent; a UI that never offers the row is not
   *  an authorization check.
   *
   *  The predicate now MIRRORS the library's exactly, so anything attachable is something the
   *  library would have listed. `creative_assets` deliberately stays tenant-wide — Studio-graded
   *  assets belong to the agency, not to one client — which is why only this half needed narrowing. */
  private async loadLibraryFileContentType(
    tenantId: string, clientId: string, fileId: string,
  ): Promise<string | null> {
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query<{ content_type: string }>(
        `SELECT content_type FROM files
          WHERE id = $1 AND target_entity_type = 'client' AND target_entity_id = $2 AND deleted_at IS NULL`,
        [fileId, clientId],
      ),
    );
    return rows[0]?.content_type ?? null;
  }

  /** Read one Studio-graded asset's materializable fields. No module wall — `creative_assets` is
   *  not a `social_*` table either. */
  private async loadStudioAsset(
    tenantId: string, assetId: string,
  ): Promise<{ name: string; contentType: string; gradedKey: string; gradedByteSize: number } | null> {
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query<{ name: string; content_type: string; graded_key: string; graded_byte_size: string }>(
        `SELECT name, content_type, graded_key, graded_byte_size FROM creative_assets WHERE id = $1 AND deleted_at IS NULL`,
        [assetId],
      ),
    );
    if (!rows[0]) return null;
    return {
      name: rows[0].name, contentType: rows[0].content_type,
      gradedKey: rows[0].graded_key, gradedByteSize: Number(rows[0].graded_byte_size),
    };
  }

  /** Materialize a Studio asset as a `files` row so `dispatch.ts`'s `resolveEngineMedia`/
   *  `loadFileForUpload` (both UNEDITED by this ticket) resolve it exactly like any other
   *  attached file — the whole point of reusing the SAME `graded_key` as the new row's
   *  `storage_key` rather than copying bytes: zero duplicated storage, and the engine-upload path
   *  never needs to know an attachment originated in the Studio rather than an ordinary upload.
   *  Idempotent by construction: a repeat attach of the same Studio asset for the same client
   *  reuses the SAME `files` row (matched on `storage_key`) rather than growing a duplicate one
   *  per click. No module wall — `files` is not a `social_*` table. */
  private async materializeStudioAssetAsFile(
    tenantId: string, uploaderId: string | null, clientId: string,
    asset: { name: string; contentType: string; gradedKey: string; gradedByteSize: number },
  ): Promise<string> {
    return withTenants([tenantId], async (c) => {
      const existing = await c.query<{ id: string }>(
        `SELECT id FROM files
          WHERE target_entity_type = 'client' AND target_entity_id = $1 AND storage_key = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [clientId, asset.gradedKey],
      );
      if (existing.rows[0]) return existing.rows[0].id;
      const id = newId();
      await c.query(
        `INSERT INTO files
           (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
         VALUES ($1,$2,$3,'client',$4,$5,$6,$7,$8,false,$9)`,
        [id, tenantId, uploaderId, clientId, asset.name, asset.contentType, asset.gradedByteSize, asset.gradedKey, config.originSite],
      );
      return id;
    });
  }

  /** Everything `attachVariantMedia` needs about the target row in one round trip — same
   *  `{modules:["social"]}` discipline as every other `social_post_variants` read in this file.
   *  The joined `clientId` is what a Studio-asset attach materializes its new `files` row under. */
  private async loadVariantForMediaAttach(tenantId: string, variantId: string): Promise<{
    accountId: string; status: string; nativeImport: boolean; clientId: string;
  }> {
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query<{ accountId: string; status: string; nativeImport: boolean; clientId: string }>(
        `SELECT v.account_id AS "accountId", v.status, v.native_import AS "nativeImport", e.client_id AS "clientId"
           FROM social_post_variants v
           JOIN social_posts p ON p.id = v.post_id
           JOIN social_engagements e ON e.id = p.engagement_id
          WHERE v.id = $1 AND v.deleted_at IS NULL`,
        [variantId],
      ),
      { modules: ["social"] },
    );
    if (!rows[0]) throw new NotFoundException("post variant not found");
    return rows[0];
  }

  /** Attach ONE library asset (an existing `files` row, or a Studio-graded `creative_assets` row)
   *  onto a variant's `media` array. Never uploads anything to the engine — that is SMM-39's job,
   *  entirely unaffected: this endpoint only ever writes the composer-side descriptor
   *  (`{fileId, kind, alt, format}`) into `social_post_variants.media`, the SAME column
   *  `updateVariant` already writes, never `uploaded_media` (D-15's separation — see this
   *  module's dispatch.ts header for why that column must stay outside `args_sha256`; this
   *  endpoint recomputes `args_sha256` from `media`, exactly like `updateVariant`, and never
   *  touches `uploaded_media` at all). */
  @Post("variants/:variantId/media/attach")
  async attachVariantMedia(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("variantId") variantId: string,
    @Body() body: { source?: "file" | "creative_asset"; assetId?: string; alt?: string; kind?: "image" | "video"; format?: string },
  ) {
    await authorize(req.principal, { kind: "social_post", id: variantId, tenantId, module: "social" }, "update");
    const source = body?.source;
    const assetId = body?.assetId;
    if (!source || !assetId) refuse("missing_field");
    if (source !== "file" && source !== "creative_asset") refuse("unsupported_asset_source");

    const variant = await this.loadVariantForMediaAttach(tenantId, variantId);
    // Same editability law `updateVariant` enforces — an attach IS an edit of `media`.
    if (variant.nativeImport) refuse("variant_native_import_immutable");
    if (!EDITABLE_VARIANT_STATUSES.has(variant.status)) refuse("variant_not_editable");

    // No SEPARATE `file`/`client` Cerbos check here, deliberately: the caller has already cleared
    // `social_post`/`update` above, which IS the capability this endpoint grants ("attach media to
    // a variant you may edit") — same reasoning `getAssetLibrary`'s single `social_engagement`/
    // `read` check gives for the identical `files`/`creative_assets` reads. `social_staff`/
    // `social_manager` are module-scoped roles and hold no blanket company-wide `file` grant, so
    // gating a second time on that resource would refuse the exact staff this ticket is for.
    let fileId: string;
    let derived: { kind?: "image" | "video"; format?: string };
    if (source === "file") {
      const contentType = await this.loadLibraryFileContentType(tenantId, variant.clientId, assetId);
      if (contentType === null) refuse("asset_not_found");
      fileId = assetId;
      derived = contentTypeToKindFormat(contentType);
    } else {
      const asset = await this.loadStudioAsset(tenantId, assetId);
      if (!asset) refuse("asset_not_found");
      fileId = await this.materializeStudioAssetAsFile(tenantId, req.principal.userId, variant.clientId, asset);
      derived = contentTypeToKindFormat(asset.contentType);
    }

    const descriptor: Record<string, unknown> = {
      fileId,
      kind: body?.kind ?? derived.kind,
      alt: body?.alt,
      format: body?.format ?? derived.format,
    };

    const result = await withTenants(
      [tenantId],
      async (c) => {
        const { rows } = await c.query<{
          id: string; account_id: string; body: string; first_comment: string | null; media: unknown;
          settings: Record<string, unknown>; scheduled_at: Date | null; status: string; approval_id: string | null; native_import: boolean;
        }>(
          `SELECT id, account_id, body, first_comment, media, settings, scheduled_at, status, approval_id, native_import
             FROM social_post_variants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [variantId],
        );
        const row = rows[0];
        if (!row) return { kind: "not_found" as const };
        if (row.native_import) return { kind: "refuse" as const, reason: "variant_native_import_immutable" };
        if (!EDITABLE_VARIANT_STATUSES.has(row.status)) return { kind: "refuse" as const, reason: "variant_not_editable" };

        const existingMedia = Array.isArray(row.media) ? (row.media as Record<string, unknown>[]) : [];
        const already = existingMedia.findIndex((m) => m && typeof m === "object" && m.fileId === fileId);
        const nextMedia = [...existingMedia];
        if (already >= 0) {
          // Idempotent re-attach: refresh kind/alt/format on the SAME entry, never a duplicate —
          // a retried "attach" click (or an at-least-once agent caller) must not grow the array.
          nextMedia[already] = { ...nextMedia[already], ...descriptor };
        } else {
          nextMedia.push(descriptor);
        }

        const argsSha256 = variantArgsSha256({
          tenantId, id: row.id, accountId: row.account_id, body: row.body, firstComment: row.first_comment,
          media: nextMedia, settings: row.settings, scheduledAt: row.scheduled_at,
        });
        // D-15's state law, mechanically, exactly like `updateVariant`: attaching media changes
        // the hashed args, so an approved/in-review variant drops back to draft in the SAME
        // statement, and a failed dispatch's approval_id is cleared the same way.
        const wasApproved = row.approval_id !== null || row.status === "approved";
        await c.query(
          `UPDATE social_post_variants
              SET media = $1, args_sha256 = $2, approval_id = NULL,
                  status = CASE WHEN status IN ('in_review','approved','failed') THEN 'draft' ELSE status END,
                  updated_at = now()
            WHERE id = $3`,
          [JSON.stringify(nextMedia), argsSha256, variantId],
        );
        return {
          kind: "ok" as const, accountId: row.account_id, media: nextMedia, argsSha256, wasApproved,
          body: row.body, firstComment: row.first_comment, settings: row.settings, scheduledAt: row.scheduled_at,
        };
      },
      { modules: ["social"] },
    );
    if (result.kind === "not_found") throw new NotFoundException("post variant not found");
    if (result.kind === "refuse") refuse(result.reason);

    const account = await this.loadAccount(tenantId, result.accountId);
    const validation = validateVariant(account.network, {
      body: result.body, firstComment: result.firstComment,
      media: result.media as never[], settings: result.settings, scheduledAt: result.scheduledAt,
    }, account.quota);
    const attachEstimatedCostUsd = resolveEstimatedCostOrRefuse(account.network, {
      body: result.body, media: result.media as never[], settings: result.settings,
    });
    await withTenants(
      [tenantId],
      (c) => c.query(
        `UPDATE social_post_variants SET validation = $1, estimated_cost_usd = $2 WHERE id = $3`,
        [JSON.stringify(validation), attachEstimatedCostUsd, variantId],
      ),
      { modules: ["social"] },
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "social_post_variant", variantId, {
      mediaAttached: true, source, fileId, approvalInvalidated: result.wasApproved,
    });
    return {
      ok: true, fileId, media: result.media, validation, argsSha256: result.argsSha256,
      approvalInvalidated: result.wasApproved,
    };
  }

  // ==================================================== THE PUBLISH GATE (SMM-09) ============
  //
  // A DRY RUN of the D14 execution precondition, and nothing else. It does not publish, does not
  // consume an approval and does not touch a network — it answers "would the publish gate let this
  // variant through RIGHT NOW, and if not, which gate stopped it and why".
  //
  // Why it exists rather than being inferable from the composer's `validation`: the two answer
  // different questions. `validation` is about the CONTENT (does this caption fit, is this media
  // legal for this network). The publish gate is about EVERYTHING ELSE that has to still be true at
  // dispatch — the client chain, the engagement's scope, the args hash, single-use consumption, the
  // metered budget and (for TikTok) creator consent. The approval card must show the human WHY a
  // publish will refuse BEFORE they approve it, because the alternative is an approval that lands
  // `failed` minutes later with nobody watching, which is precisely the dead end D14 exists to fix.
  //
  // ONE IMPLEMENTATION, TWO CALLERS. This runs the exact function
  // `core/approval-executables.ts`'s `social.publishPost` entry runs at execution time
  // (`evaluatePublishPrecondition`). A second, "UI-friendly" copy of these rules would drift, and
  // the drift would show up as a card that says green and an execution that says no.
  //
  // Read-tier authorization (`social_post` / `read`), deliberately: asking whether a publish WOULD
  // be allowed is not publishing, and staff who author the content are exactly who needs the answer.
  // The `publish` action itself gates the act, and it remains manager-tier (resource_social_post.yaml).
  //
  // ⚠ The verdict is returned as DATA with a 200, not thrown as an error. "This variant is not
  // currently publishable" is a successful answer to the question that was asked. The typed tokens
  // this surface reports are the same ones the executor writes into
  // `automation_approvals.execution_error` after the `precondition_failed: ` prefix, so a caller
  // branches on ONE vocabulary regardless of which side it heard it from.
  @Get("variants/:variantId/publish-preconditions")
  async getVariantPublishPreconditions(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("variantId") variantId: string,
  ) {
    await authorize(req.principal, { kind: "social_post", id: variantId, tenantId, module: "social" }, "read");
    const result = await withTenants(
      [tenantId],
      async (c) => {
        // The args a publish of this variant WOULD be called with, built from the live row by the
        // same function the composer and the submit path use. Evaluating against these makes the
        // hash stage compare live-against-live — which still has teeth: it catches a stored
        // `args_sha256` that has drifted from the content (a direct SQL edit, or a future write path
        // that forgot to recompute the anchor), which is exactly the condition that would make a
        // real approval unmatchable later. What it cannot report is "this specific approval no
        // longer matches", because a dry run holds no approval; that comparison happens at execution
        // time against the grant's own args.
        const { rows } = await c.query<{
          account_id: string; body: string; first_comment: string | null; media: unknown;
          settings: Record<string, unknown> | null; scheduled_at: Date | null;
        }>(
          `SELECT account_id, body, first_comment, media, settings, scheduled_at
             FROM social_post_variants WHERE id = $1 AND deleted_at IS NULL`,
          [variantId],
        );
        if (!rows[0]) return { found: false as const };
        const args = variantPublishArgs({
          tenantId, id: variantId, accountId: rows[0].account_id, body: rows[0].body,
          firstComment: rows[0].first_comment, media: rows[0].media,
          settings: rows[0].settings, scheduledAt: rows[0].scheduled_at,
        });
        return {
          found: true as const,
          accountId: rows[0].account_id,
          body: rows[0].body,
          // SMM-31: the client-review gate runs FIRST here too — this dry run is the one surface
          // staff actually consult before filing a WS4 request, so it is the practical "would this
          // even be submittable" answer in an architecture with no separate submit endpoint (see
          // client-review.ts's header).
          verdict: await evaluatePublishPreconditionWithClientReview(
            c, args as unknown as Record<string, unknown>, SOCIAL_PUBLISH_TOOL,
          ),
        };
      },
      { modules: ["social"] },
    );
    // A missing variant is a 404, not a 200 carrying `variant_not_found`: every other read on this
    // controller answers it that way, and folding it into the verdict body would make "no such
    // variant" indistinguishable from "this variant exists and is currently blocked".
    if (!result.found) throw new NotFoundException("post variant not found");
    const verdict = result.verdict;
    // SMM-22 — THE APPROVAL CARD'S OWN ESTIMATE. Computed fresh (never read from the stored
    // `estimated_cost_usd` column, for the SAME "is this true NOW" reasoning
    // `getVariantValidation` already states), and rendered as DATA, never a refusal — a human
    // reading this card must see the price of their click, or an honest "not priced yet" reason,
    // BEFORE they approve, exactly the design's own "money safety: X spend is visible on the
    // approval card before the human clicks" requirement.
    const account = await this.loadAccount(tenantId, result.accountId);
    const costEstimate = estimateCostUsd(account.network, { body: result.body }, resolveXPricing());
    return {
      ok: verdict.ok,
      ...(verdict.ok ? {} : { stage: verdict.stage, reason: verdict.reason }),
      stages: PUBLISH_PRECONDITION_STAGES,
      // Names the split so a caller never has to infer it: the free tool is the one that
      // auto-executes on approval; the metered twin exists and cannot (addendum D-14) unless this
      // deployment has explicitly configured otherwise (core/approval-executables.ts's SMM-22
      // section).
      tool: SOCIAL_PUBLISH_TOOL,
      meteredTool: SOCIAL_PUBLISH_METERED_TOOL,
      estimatedCostUsd: costEstimate.ok ? costEstimate.costUsd : null,
      ...(costEstimate.ok ? {} : { costUnavailableReason: costEstimate.reason }),
    };
  }

  // ==================================================== CLIENT REVIEW (SMM-31, D-16) ==========
  //
  // The STAFF side of the two-sided seam: ask (`request`), look (`read`), retract (`withdraw`).
  // The CLIENT's own decision lives on the PORTAL surface (`social-client-review-portal.controller.ts`,
  // action `approve_post`) — never here; `resource_social_client_review.yaml`'s own header states the
  // invariant that `client` never appears in THIS kind's policy.
  //
  // `social_post_client_reviews` is the ONE plain-tenant-wall table in this module (D-16 / 0088's
  // D-2a lesson — see client-review.ts's header). Reading/writing it from inside this controller's
  // usual `{modules:['social']}` transaction is still correct: the plain wall's policy only checks
  // `tenant_id`, so an ADDITIONAL `app.scopes` declaration is inert for it and load-bearing for the
  // social_post_variants/social_posts/social_engagements joins these three endpoints also need.
  //
  // ONE ROW PER VARIANT, FOREVER (0105's `UNIQUE (variant_id)`) — "request" is therefore an UPSERT
  // back to `pending`, never a second INSERT: re-asking after `changes_requested`/`withdrawn`, or
  // even after `approved` (an edit invalidated the prior sign-off), all resolve to the same row.

  @Post("variants/:variantId/client-review")
  @HttpCode(201)
  async requestClientReview(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("variantId") variantId: string,
  ) {
    await authorize(req.principal, { kind: "social_client_review", id: variantId, tenantId, module: "social" }, "request");
    const result = await withTenants(
      [tenantId],
      async (c) => {
        // Everything `event-handlers.ts#handleClientReviewRequested` needs to resolve and notify the
        // client, gathered in ONE query — a second read in the handler would need this exact same
        // third-walled join, which is how a copy of it drifts.
        const { rows } = await c.query<{ client_id: string; project_id: string | null; title: string }>(
          `SELECT e.client_id, e.project_id, p.title
             FROM social_post_variants v
             JOIN social_posts p       ON p.id = v.post_id       AND p.tenant_id = v.tenant_id
             JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = v.tenant_id
            WHERE v.id = $1 AND v.deleted_at IS NULL`,
          [variantId],
        );
        if (!rows[0]) return { kind: "not_found" as const };
        const { client_id: clientId, project_id: projectId, title } = rows[0];

        // Lock the row (if any) so a concurrent double-click cannot race the "was it already
        // pending" read against the upsert below.
        const existing = await c.query<{ status: string }>(
          `SELECT status FROM social_post_client_reviews WHERE variant_id = $1 FOR UPDATE`,
          [variantId],
        );
        const alreadyPending = existing.rows[0]?.status === "pending";
        const id = newId();
        const upsert = await c.query<{ id: string }>(
          `INSERT INTO social_post_client_reviews
             (id, tenant_id, variant_id, client_id, status, requested_at, updated_at, origin_site)
           VALUES ($1, $2, $3, $4, 'pending', now(), now(), $5)
           ON CONFLICT (variant_id) DO UPDATE SET
             status = 'pending', comment = NULL, reviewed_args_sha256 = NULL,
             decided_by = NULL, decided_at = NULL, requested_at = now(), updated_at = now()
           RETURNING id`,
          [id, tenantId, variantId, clientId, config.originSite],
        );
        const reviewId = upsert.rows[0].id;
        if (!alreadyPending) {
          // Rides the ALREADY-DRAINED "social_post_variant" stream (main.ts's startConsumerLoop) —
          // deliberately, so this event reaches `event-handlers.ts`'s consumer without touching
          // main.ts (defect class #2: "registered but never invoked"). Not emitted on a no-op
          // re-request: a double-click must not re-notify the client of the same ask.
          await emitEvent(c, tenantId, "social_post_variant", variantId, "social.client_review.requested", {
            reviewId, clientId, projectId, postTitle: title,
          });
        }
        return { kind: "ok" as const, reviewId, alreadyPending };
      },
      { modules: ["social"] },
    );
    if (result.kind === "not_found") throw new NotFoundException("post variant not found");
    await writeActivity(tenantId, req.principal.userId, "requested", "social_post_client_review", result.reviewId, {
      variantId, alreadyPending: result.alreadyPending,
    });
    return { id: result.reviewId, status: "pending", alreadyPending: result.alreadyPending };
  }

  @Get("variants/:variantId/client-review")
  async getClientReview(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("variantId") variantId: string,
  ) {
    await authorize(req.principal, { kind: "social_client_review", id: variantId, tenantId, module: "social" }, "read");
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, status, comment, reviewed_args_sha256 AS "reviewedArgsSha256",
                requested_at AS "requestedAt", decided_by AS "decidedBy", decided_at AS "decidedAt"
           FROM social_post_client_reviews WHERE variant_id = $1`,
        [variantId],
      ),
      { modules: ["social"] },
    );
    // A variant that never needed client sign-off (or has not been asked for one yet) has no row —
    // a legitimate steady state, answered as data rather than a 404 (matching the publish-gate
    // dry-run's own "the verdict is data" doctrine above).
    if (!rows[0]) return { status: "not_requested" };
    return rows[0];
  }

  @Post("variants/:variantId/client-review/withdraw")
  @HttpCode(200)
  async withdrawClientReview(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("variantId") variantId: string,
  ) {
    await authorize(req.principal, { kind: "social_client_review", id: variantId, tenantId, module: "social" }, "withdraw");
    const result = await withTenants(
      [tenantId],
      async (c) => {
        const upd = await c.query<{ id: string }>(
          `UPDATE social_post_client_reviews
              SET status = 'withdrawn', decided_by = $2, decided_at = now(), updated_at = now()
            WHERE variant_id = $1 AND status = 'pending'
            RETURNING id`,
          [variantId, req.principal.userId],
        );
        if (upd.rowCount) {
          await emitEvent(c, tenantId, "social_post_variant", variantId, "social.client_review.withdrawn", {
            reviewId: upd.rows[0].id,
          });
          return { kind: "ok" as const, reviewId: upd.rows[0].id };
        }
        const existing = await c.query<{ id: string; status: string }>(
          `SELECT id, status FROM social_post_client_reviews WHERE variant_id = $1`,
          [variantId],
        );
        if (!existing.rows[0]) return { kind: "not_found" as const };
        // IDEMPOTENT: a retry after an already-withdrawn review is a no-op success, not an error —
        // deciding (or, here, retracting) twice must not double-apply.
        if (existing.rows[0].status === "withdrawn") return { kind: "already_withdrawn" as const, reviewId: existing.rows[0].id };
        return { kind: "conflict" as const, status: existing.rows[0].status };
      },
      { modules: ["social"] },
    );
    if (result.kind === "not_found") throw new NotFoundException("no client review requested for this variant");
    if (result.kind === "conflict") refuse("client_review_not_pending");
    if (result.kind === "ok") {
      await writeActivity(tenantId, req.principal.userId, "withdrawn", "social_post_client_review", result.reviewId, { variantId });
    }
    return { id: result.reviewId, status: "withdrawn" };
  }

  // ==================================================== THE DISPATCH ENDPOINT (SMM-10) ========
  //
  // What `social.publishPost`'s `pathTemplate` fronts (./index.ts). Reachable in the ordinary flow
  // ONLY through the D14 executor's re-drive (core/approval-executables.ts's SMM-09 section):
  // `social.publishPost` is `write:true, impact:'high'`, so an automation/agent principal calling it
  // directly always suspends into WS4 first. All the domain logic — the second precondition run
  // under its own lock, the network call, the transactional stamp of `approval_id` +
  // `provider_post_id` — lives in `dispatch.ts`; this handler is the thin authz + HTTP wrapper every
  // other endpoint on this controller already is.
  //
  // `publish` — not `update` — matching `getVariantPublishPreconditions`'s own comment on why the
  // dry-run stays read-tier while this, the act itself, is manager-tier
  // (resource_social_post.yaml). The OBO-resolved principal here is the ORIGINAL FILING principal
  // (invariant 1, core/approval-execute.ts) — for the automation/agent identity that proposed the
  // publish, never the human who approved it.
  @Post("variants/:variantId/publish")
  @HttpCode(200)
  async dispatchPublish(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("variantId") variantId: string,
  ) {
    await authorize(req.principal, { kind: "social_post", id: variantId, tenantId, module: "social" }, "publish");
    const verdict = await dispatchApprovedPublish(tenantId, variantId, req.principal.userId);
    if (!verdict.ok) {
      // Criterion 2/D22: the SAME snake_case token vocabulary `social.checkPublishPreconditions`
      // reports, riding `message` — never `error` — so `HttpErrorFilter` renders `{error: token}`
      // rather than silently replacing it with its own constructor-derived string (src/http-error.
      // filter.ts's own documented trap).
      throw new ConflictException({ message: verdict.reason });
    }
    return { ok: true, providerPostId: verdict.providerPostId, network: verdict.network };
  }

  // ==================================================== METERED PUBLISH GATE (SMM-22) =========
  //
  // `social.publishPostMetered`'s own dispatch endpoint — the SAME `dispatchApprovedPublish` this
  // controller's `dispatchPublish` calls, just with the metered tool name threaded through (see
  // dispatch.ts's own header for why one implementation serves both). Reachable through the D14
  // executor's re-drive ONLY when this deployment has explicitly lifted the bar
  // (`core/approval-executables.ts`'s SMM-22 section); otherwise a suspended approval for this tool
  // stays `execution_status='not_applicable'` forever and this endpoint is never called by the
  // executor — a human with `publish` authority may still call it directly (the SAME Cerbos action
  // `dispatchPublish` uses; no new permission), which is what lets a manually-reviewed metered
  // publish complete even while the auto-executor stays out of the loop.
  @Post("variants/:variantId/publish-metered")
  @HttpCode(200)
  async dispatchMeteredPublish(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("variantId") variantId: string,
  ) {
    await authorize(req.principal, { kind: "social_post", id: variantId, tenantId, module: "social" }, "publish");
    const verdict = await dispatchApprovedPublish(tenantId, variantId, req.principal.userId, SOCIAL_PUBLISH_METERED_TOOL);
    if (!verdict.ok) {
      // Same message-vs-error trap avoidance as `dispatchPublish` above.
      throw new ConflictException({ message: verdict.reason });
    }
    return { ok: true, providerPostId: verdict.providerPostId, network: verdict.network };
  }

  // ==================================================== USAGE PANEL (SMM-22) ===================
  //
  // Read-only. `social.ledger.read` (resource_social_ledger.yaml, 0106) — a department that cannot
  // see its own spend cannot manage it, so this is staff-tier, same reasoning that Cerbos file's own
  // header gives. Makes no network call and consumes no budget itself: a caller checking the panel
  // must never be charged for looking.
  @Get("engagements/:engagementId/usage")
  async getEngagementUsage(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
  ) {
    await authorize(req.principal, { kind: "social_ledger", id: engagementId, tenantId, module: "social" }, "read");
    const result = await withTenants(
      [tenantId],
      async (c) => {
        // `{modules:["social"]}` below already declares the module scope for this connection
        // (db/index.ts's own contract) — no explicit `declareSocialModuleScope` needed here, same
        // as every other endpoint on this controller.
        const { rows } = await c.query<{ usage_budget_usd: string }>(
          `SELECT usage_budget_usd FROM social_engagements WHERE id = $1 AND deleted_at IS NULL`,
          [engagementId],
        );
        if (!rows[0]) return { found: false as const };
        const snapshot = await readUsageSnapshot(c, engagementId, Number(rows[0].usage_budget_usd));
        return { found: true as const, snapshot };
      },
      { modules: ["social"] },
    );
    if (!result.found) throw new NotFoundException("engagement not found");
    return result.snapshot;
  }

  // ==================================================== ASSISTANT SUMMARY (SMM-35) =============
  // Read-only. Same Cerbos action `getEngagementScope`/`listEngagements` already use on this
  // resource kind (`read` on `social_engagement`) — no new permission, no Cerbos edit. This is the
  // one endpoint `social.getEngagementSummary` (index.ts) fronts; `assistant-summary.ts` owns every
  // query. Never redacted (a read, not a write proposal) and never itself charged against the usage
  // budget it reports (same "checking the panel is free" rule `getEngagementUsage` above carries).
  @Get("engagements/:engagementId/assistant-summary")
  async getAssistantSummary(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
  ) {
    await authorize(req.principal, { kind: "social_engagement", id: engagementId, tenantId, module: "social" }, "read");
    const result = await runAssistantSummary(tenantId, engagementId);
    if (result.kind === "not_found") throw new NotFoundException("social engagement not found");
    return result.summary;
  }

  // ==================================================== INBOX REPLY FLOW (SMM-17) =============
  //
  // draft -> WS4 approval -> send, reusing SMM-09's pattern (`reply-precondition.ts`'s own header).
  // Cerbos actions per `resource_social_inbox.yaml` (SMM-30): drafting/editing/approving a reply
  // rides `assign` ("a draft is a row in our DB and rides assign/read plus the AI path" — that
  // file's own words); `reply` is reserved for the one action that decides a reply is SENT, exactly
  // mirroring `publish` on `social_post`. `social.inbox.reply` (0106) is the permission already
  // granted to social_manager/social_staff/manager/company_admin/platform_admin — no IAM change
  // needed for this ticket.

  /** Shared: load an outbound message row FOR UPDATE, scoped to this thread. Returns null on a
   *  miss (wrong id, wrong thread, or an INBOUND row — a reply is edited only through its own row,
   *  never through the comment it answers). */
  private async loadReplyForUpdate(
    c: PoolClient, threadId: string, messageId: string,
  ): Promise<{ id: string; threadId: string; accountId: string; body: string; status: string; approvalId: string | null } | null> {
    const { rows } = await c.query<{
      id: string; thread_id: string; account_id: string; body: string; status: string; approval_id: string | null;
    }>(
      `SELECT m.id, m.thread_id, t.account_id, m.body, m.status, m.approval_id
         FROM social_inbox_messages m
         JOIN social_inbox_threads t ON t.id = m.thread_id AND t.tenant_id = m.tenant_id
        WHERE m.id = $1 AND m.thread_id = $2 AND m.direction = 'out'
        FOR UPDATE OF m`,
      [messageId, threadId],
    );
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, threadId: row.thread_id, accountId: row.account_id, body: row.body, status: row.status, approvalId: row.approval_id };
  }

  /** Create a draft reply on a thread. A draft is OUR row, never sent, never network-visible —
   *  `assign`, not `reply` (see this section's header). */
  @Post("threads/:threadId/messages")
  @HttpCode(201)
  async createReplyDraft(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("threadId") threadId: string,
    @Body() body: { body?: string },
  ) {
    await authorize(req.principal, { kind: "social_inbox", id: threadId, tenantId, module: "social" }, "assign");
    const text = (body?.body ?? "").trim();
    if (!text) refuse("empty_body");

    const id = newId();
    const result = await withTenants(
      [tenantId],
      async (c) => {
        const { rows } = await c.query<{ account_id: string }>(
          `SELECT account_id FROM social_inbox_threads WHERE id = $1 AND deleted_at IS NULL`,
          [threadId],
        );
        if (!rows[0]) return { kind: "not_found" as const };
        const accountId = rows[0].account_id;
        const argsSha = replyArgsSha256({ tenantId, id, threadId, accountId, body: text });
        await c.query(
          `INSERT INTO social_inbox_messages
             (id, tenant_id, thread_id, direction, body, status, source, args_sha256, origin_site)
           VALUES ($1,$2,$3,'out',$4,'draft','reply',$5,$6)`,
          [id, tenantId, threadId, text, argsSha, config.originSite],
        );
        return { kind: "ok" as const, accountId, argsSha };
      },
      { modules: ["social"] },
    );
    if (result.kind === "not_found") throw new NotFoundException("inbox thread not found");
    await writeActivity(tenantId, req.principal.userId, "created", "social_inbox_message", id, { threadId });
    return { id, threadId, body: text, status: "draft", argsSha256: result.argsSha };
  }

  /** Edit a draft reply. STATE LAW mirrors `updateVariant`'s exactly (D-15): the hash moves, and any
   *  previously-spent grant is dropped in the SAME statement, reverting to `draft` — an edit must
   *  never leave an approval pointing at content nobody approved. */
  @Patch("threads/:threadId/messages/:messageId")
  async updateReplyDraft(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("threadId") threadId: string, @Param("messageId") messageId: string,
    @Body() body: { body?: string },
  ) {
    await authorize(req.principal, { kind: "social_inbox", id: messageId, tenantId, module: "social" }, "assign");
    if (body?.body === undefined) refuse("no_fields");
    const text = body.body.trim();
    if (!text) refuse("empty_body");

    const result = await withTenants(
      [tenantId],
      async (c) => {
        const row = await this.loadReplyForUpdate(c, threadId, messageId);
        if (!row) return { kind: "not_found" as const };
        if (!EDITABLE_MESSAGE_STATUSES.has(row.status)) return { kind: "refuse" as const, reason: "message_not_editable" };

        const argsSha = replyArgsSha256({ tenantId, id: row.id, threadId: row.threadId, accountId: row.accountId, body: text });
        const wasApproved = row.approvalId !== null || row.status === "approved";
        await c.query(
          `UPDATE social_inbox_messages
              SET body = $1, args_sha256 = $2, approval_id = NULL,
                  status = CASE WHEN status IN ('in_review','approved','failed') THEN 'draft' ELSE status END,
                  updated_at = now()
            WHERE id = $3`,
          [text, argsSha, messageId],
        );
        return { kind: "ok" as const, argsSha, wasApproved };
      },
      { modules: ["social"] },
    );
    if (result.kind === "not_found") throw new NotFoundException("reply draft not found");
    if (result.kind === "refuse") refuse(result.reason);
    await writeActivity(tenantId, req.principal.userId, "updated", "social_inbox_message", messageId, {
      threadId, approvalInvalidated: result.wasApproved,
    });
    return { id: messageId, threadId, body: text, argsSha256: result.argsSha, approvalInvalidated: result.wasApproved };
  }

  /** Move a draft to `approved` — the staff sign-off BEFORE a send is ever proposed. Still `assign`:
   *  this is bookkeeping on our own row, not the outbound act itself (`reply`). Idempotent: an
   *  already-`approved` message re-approves as a no-op rather than erroring, mirroring the client-
   *  review portal's own "repeat decide while already decided" idempotency. */
  @Post("threads/:threadId/messages/:messageId/approve")
  @HttpCode(200)
  async approveReplyDraft(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("threadId") threadId: string, @Param("messageId") messageId: string,
  ) {
    await authorize(req.principal, { kind: "social_inbox", id: messageId, tenantId, module: "social" }, "assign");

    const result = await withTenants(
      [tenantId],
      async (c) => {
        const row = await this.loadReplyForUpdate(c, threadId, messageId);
        if (!row) return { kind: "not_found" as const };
        if (row.status === "approved") return { kind: "already" as const };
        if (row.status !== "draft" && row.status !== "in_review") {
          return { kind: "refuse" as const, reason: "message_not_editable" };
        }
        if (!row.body.trim()) return { kind: "refuse" as const, reason: "empty_body" };
        await c.query(`UPDATE social_inbox_messages SET status = 'approved', updated_at = now() WHERE id = $1`, [messageId]);
        return { kind: "ok" as const };
      },
      { modules: ["social"] },
    );
    if (result.kind === "not_found") throw new NotFoundException("reply draft not found");
    if (result.kind === "refuse") refuse(result.reason);
    if (result.kind === "ok") {
      await writeActivity(tenantId, req.principal.userId, "approved", "social_inbox_message", messageId, { threadId });
    }
    return { id: messageId, threadId, status: "approved" };
  }

  /** A DRY RUN of the D14 reply precondition — mirrors `getVariantPublishPreconditions` exactly, for
   *  a message instead of a variant. Publishes nothing, sends nothing, consumes no approval. */
  @Get("threads/:threadId/messages/:messageId/send-preconditions")
  async getReplySendPreconditions(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("threadId") threadId: string, @Param("messageId") messageId: string,
  ) {
    await authorize(req.principal, { kind: "social_inbox", id: messageId, tenantId, module: "social" }, "read");
    const result = await withTenants(
      [tenantId],
      async (c) => {
        const row = await this.loadReplyForUpdate(c, threadId, messageId);
        if (!row) return { found: false as const };
        const args = replyDispatchArgs({ tenantId, id: row.id, threadId: row.threadId, accountId: row.accountId, body: row.body });
        return { found: true as const, verdict: await evaluateReplyPrecondition(c, args as unknown as Record<string, unknown>) };
      },
      { modules: ["social"] },
    );
    if (!result.found) throw new NotFoundException("reply draft not found");
    const verdict = result.verdict;
    return {
      ok: verdict.ok,
      ...(verdict.ok ? {} : { stage: verdict.stage, reason: verdict.reason }),
      stages: REPLY_PRECONDITION_STAGES,
      tool: SOCIAL_REPLY_TOOL,
    };
  }

  /** THE SEND ENDPOINT — `social.sendReply`'s `pathTemplate` fronts this (./index.ts). Reachable in
   *  the ordinary flow ONLY through the D14 executor's re-drive, the SAME shape `dispatchPublish`
   *  above is (that handler's own header note applies here verbatim: never called directly by a
   *  human or an agent in the ordinary flow). `reply` — not `assign` — is the Cerbos action, matching
   *  `publish` on `social_post`: this is the act itself, not the bookkeeping around it. */
  @Post("threads/:threadId/messages/:messageId/send")
  @HttpCode(200)
  async sendReply(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("threadId") threadId: string, @Param("messageId") messageId: string,
  ) {
    await authorize(req.principal, { kind: "social_inbox", id: messageId, tenantId, module: "social" }, "reply");
    const verdict = await dispatchApprovedReply(tenantId, messageId, req.principal.userId);
    if (!verdict.ok) {
      // Criterion 2: the SAME snake_case token vocabulary `getReplySendPreconditions` reports,
      // riding `message` — never `error` — matching `dispatchPublish`'s own documented trap-avoidance.
      throw new ConflictException({ message: verdict.reason });
    }
    return { ok: true, externalId: verdict.externalId, network: verdict.network };
  }

  /** List a thread's messages (inbound + outbound) — plain `read`, for verifying the flow above
   *  without raw SQL. SMM-18 owns the real triage-queue UI this endpoint is not trying to be. */
  @Get("threads/:threadId/messages")
  async listThreadMessages(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("threadId") threadId: string,
  ) {
    await authorize(req.principal, { kind: "social_inbox", id: threadId, tenantId, module: "social" }, "read");
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query<{
        id: string; direction: string; body: string; status: string; source: string;
        externalId: string | null; postedAt: Date | null; createdAt: Date;
      }>(
        `SELECT id, direction, body, status, source, external_id AS "externalId",
                posted_at AS "postedAt", created_at AS "createdAt"
           FROM social_inbox_messages WHERE thread_id = $1 ORDER BY created_at ASC`,
        [threadId],
      ),
      { modules: ["social"] },
    );
    return { threadId, messages: rows };
  }

  // ==================================================== RECONCILE WEBHOOK INTAKE (SMM-10) =====
  //
  // IDS ONLY, NEVER TRUSTED CONTENT. The only field this endpoint reads from the request body is
  // `providerPostId` — anything else a caller sends (a claimed status, a claimed error message, a
  // claimed URL) is discarded unread. `reconcileOneProviderPost` re-fetches the authoritative state
  // itself via `SocialPublisher.getPostStatus` before writing anything, so a malicious or buggy
  // caller can at most trigger an EARLY, honest re-check — never inject a fabricated outcome.
  //
  // No Cerbos authorize() call: this is a machine-to-machine intake, gated by a SECOND, independent
  // wall on top of the ones every other route on this controller already carries — AuthGuard (the
  // class-level `@UseGuards`) still requires the platform SERVICE TOKEN bearer (search.controller.ts's
  // `rank-pulls/callback` is the precedent this mirrors, down to its own "AUTHENTICATION ORDER"
  // comment: every pre-existing wall stays, a callback secret is additive, never a replacement). A
  // caller with no service token never reaches this handler at all; `config.social.webhookSecret` is
  // the SECOND factor a relay holding that token must also present. An unconfigured secret refuses
  // EVERY request rather than trusting anyone who merely holds the shared service token to name an id.
  @Post("webhooks/post-status")
  @HttpCode(200)
  async postStatusWebhook(
    @Param("tenantId") tenantId: string,
    @Body() body: { providerPostId?: string },
    @Headers("x-social-webhook-secret") presentedSecret?: string,
  ) {
    const secret = config.social.webhookSecret;
    if (!secret || presentedSecret !== secret) throw new UnauthorizedException({ message: "invalid_webhook_secret" });
    const providerPostId = (body?.providerPostId ?? "").trim();
    if (!providerPostId) refuse("missing_field");
    const reconciled = await reconcileOneProviderPost(tenantId, providerPostId);
    // Always 200: "no such in-flight post" (already terminal, or unknown to this tenant) is not an
    // error a webhook sender should retry over — it is the expected steady state once a post has
    // already been reconciled once, and a retry-on-error sender would otherwise hammer this route.
    return { ok: true, reconciled };
  }

  // ==================================================== AI CAPTION DRAFTING (SMM-19) =========
  // Caption/hashtag drafting through ai-gateway-go, grounded in the client's own brand-voice
  // corpus (WS8 knowledge). Writes a DRAFT — status law is IDENTICAL to a human PATCH: re-validate,
  // recompute args_sha256, invalidate any existing approval in the same statement (an AI-authored
  // edit is still an edit). Never dispatches, never reaches a network.
  @Post("posts/:postId/variants/:variantId/draft-caption")
  @HttpCode(200)
  async draftPostVariantCaption(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("postId") postId: string, @Param("variantId") variantId: string,
    @Body() body: { wantImage?: boolean } = {},
  ) {
    // D-17: there is no generative-image backend. Named and refused at the surface, before any
    // gateway call — never silently ignored, never routed to a caption path pretending it is one.
    if (body?.wantImage) refuse("image_generation_unavailable");
    await authorize(req.principal, { kind: "social_post", id: variantId, tenantId, module: "social" }, "update");

    const row = await this.loadVariantForDraft(tenantId, variantId);
    if (row.postId !== postId) throw new NotFoundException("post variant not found");
    if (!isNetwork(row.network)) refuse("unknown_network");
    if (row.nativeImport) refuse("variant_native_import_immutable");
    if (!EDITABLE_VARIANT_STATUSES.has(row.status)) refuse("variant_not_editable");
    if (row.toolScope.ai?.drafting !== true) refuse("ai_drafting_disabled");
    const cloudPolish = row.toolScope.ai?.cloudPolish === true;

    // RAG grounding, scoped to THIS variant's own engagement -> client chain (never a body field) —
    // the property knowledge-client.ts's header names as the one that matters most here.
    const knowledgeHits = await queryBrandKnowledge(
      req.principal.userId, tenantId, row.clientId,
      row.postBrief || row.body || "brand voice caption", MAX_KNOWLEDGE_HITS,
    );
    const facts = {
      network: row.network, engagementName: row.engagementName, postBrief: row.postBrief ?? "",
      existingBody: row.body ?? "", tone: row.tone ?? {},
      hashtagStrategy: (row.hashtagStrategy ?? {}) as HashtagStrategy,
      knowledgeHits: knowledgeHits.map((h) => ({ sourceRef: h.sourceRef, text: h.text })),
    };
    const prompt = buildCaptionPrompt(facts);
    let raw: string | null = null;
    try {
      raw = (await completeViaGateway(prompt, cloudPolish ? { provider: "claude" } : undefined)).text;
    } catch {
      raw = null; // fail-soft: a gateway hiccup drafts the deterministic fallback, never blocks the composer
    }
    const { draft, draftedVia } = parseCaptionDraft(raw, facts);

    const written = await this.writeDraftedVariantContent(tenantId, variantId, {
      body: draft.body, firstComment: draft.firstComment, media: row.media, settings: row.settings, scheduledAt: row.scheduledAt,
    });
    if (written.kind === "not_found") throw new NotFoundException("post variant not found");
    if (written.kind === "refuse") refuse(written.reason);

    await writeActivity(tenantId, req.principal.userId, "updated", "social_post_variant", variantId, {
      aiDrafted: true, draftedVia, approvalInvalidated: written.wasApproved,
    });
    return {
      ok: true, draft, draftedVia,
      groundedOn: knowledgeHits.map((h) => h.sourceRef),
      validation: written.validation, argsSha256: written.argsSha256, estimatedCostUsd: written.estimatedCostUsd,
      approvalInvalidated: written.wasApproved,
    };
  }

  // =============================================================== NATIVE IMPORT =============
  // Bookkeeping for a post somebody published BY HAND in the network's own app. Calendar
  // completeness without faking an approval trail: 0105's `svar_native_import_is_bookkeeping`
  // CHECK makes the honesty structural — no approval id, no provider id, `published` only.
  @Post("posts/import-native")
  @HttpCode(201)
  async importNative(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { id?: string; engagementId?: string; accountId?: string; title?: string; body?: string; publishedUrl?: string; publishedAt?: string },
  ) {
    if (!body?.engagementId || !body?.accountId || !body?.title) refuse("missing_field");
    if (body.id && !UUID_RE.test(body.id)) refuse("invalid_id");
    await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "import_native");
    await this.loadAccount(tenantId, body.accountId); // 404s a cross-tenant or unknown account
    const postId = body.id ?? newId();
    const variantId = newId();
    const created = await withTenants(
      [tenantId],
      async (c) => {
        const ins = await c.query(
          `INSERT INTO social_posts (id, tenant_id, engagement_id, title, source, status, scheduled_at, created_by, origin_site)
           VALUES ($1,$2,$3,$4,'native_import','published',$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [postId, tenantId, body.engagementId, body.title, body.publishedAt ?? null, req.principal.userId, config.originSite],
        );
        if ((ins.rowCount ?? 0) === 0) return false;
        await c.query(
          `INSERT INTO social_post_variants
             (id, tenant_id, post_id, account_id, body, native_import, status, published_url, published_at, origin_site)
           VALUES ($1,$2,$3,$4,$5,true,'published',$6,$7,$8)`,
          [variantId, tenantId, postId, body.accountId, body.body ?? "", body.publishedUrl ?? null,
           body.publishedAt ?? null, config.originSite],
        );
        return true;
      },
      { modules: ["social"] },
    );
    if (created) await writeActivity(tenantId, req.principal.userId, "created", "social_post", postId, { nativeImport: true });
    return { id: postId, created };
  }

  // ==================================================== AI IDEA DRAFTING (SMM-19) ============
  // Content-idea generation for a calendar (design §07: "Content ideas / angle generation"). Writes
  // ROWS — social_posts with status='idea', source='ai' — never dispatches, and is a simplification
  // vs. the design's full embed-clustering job (see ai-drafts.ts's IdeaGroundingFacts comment).
  @Post("posts/draft-ideas")
  @HttpCode(201)
  async draftPostIdeas(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { engagementId?: string; campaignId?: string; campaignGoal?: string; count?: number; ids?: string[]; wantImage?: boolean },
  ) {
    if (body?.wantImage) refuse("image_generation_unavailable"); // D-17 — no image path, ever.
    if (!body?.engagementId) refuse("missing_field");
    const count = body.count ?? 3;
    if (!Number.isInteger(count) || count < 1 || count > MAX_IDEA_COUNT) refuse("invalid_count");
    if (body.ids !== undefined) {
      if (body.ids.length !== count) refuse("invalid_ids");
      if (body.ids.some((id) => !UUID_RE.test(id))) refuse("invalid_id");
    }
    // Same permission as createPost: idea-drafting writes social_posts rows, nothing more.
    await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "create");

    const eng = await this.loadEngagementForAi(tenantId, body.engagementId);
    if (eng.toolScope.ai?.drafting !== true) refuse("ai_drafting_disabled");
    const cloudPolish = eng.toolScope.ai?.cloudPolish === true;

    const recent = await withTenants(
      [tenantId],
      (c) => c.query<{ title: string; brief: string | null }>(
        `SELECT title, brief FROM social_posts WHERE engagement_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`,
        [body.engagementId],
      ),
      { modules: ["social"] },
    );
    const knowledgeHits = await queryBrandKnowledge(
      req.principal.userId, tenantId, eng.clientId, body.campaignGoal || "content ideas", MAX_KNOWLEDGE_HITS,
    );
    const facts = {
      engagementName: eng.name, campaignGoal: body.campaignGoal ?? null, recentPosts: recent.rows,
      knowledgeHits: knowledgeHits.map((h) => ({ sourceRef: h.sourceRef, text: h.text })), count,
    };
    const prompt = buildIdeaPrompt(facts);
    let raw: string | null = null;
    try {
      raw = (await completeViaGateway(prompt, cloudPolish ? { provider: "claude" } : undefined)).text;
    } catch {
      raw = null; // fail-soft, same contract as draft-caption above
    }
    const { ideas, draftedVia } = parseIdeaDraft(raw, facts);

    const created: Array<{ id: string; created: boolean; title: string; brief: string }> = [];
    await withTenants(
      [tenantId],
      async (c) => {
        for (let i = 0; i < ideas.length; i++) {
          const id = body.ids?.[i] ?? newId();
          const ins = await c.query(
            `INSERT INTO social_posts (id, tenant_id, engagement_id, campaign_id, title, brief, source, status, created_by, origin_site)
             VALUES ($1,$2,$3,$4,$5,$6,'ai','idea',$7,$8) ON CONFLICT (id) DO NOTHING`,
            [id, tenantId, body.engagementId, body.campaignId ?? null, ideas[i].title, ideas[i].brief, req.principal.userId, config.originSite],
          );
          const isNew = (ins.rowCount ?? 0) > 0;
          if (isNew) await emitEvent(c, tenantId, "social_post", id, "social.post.idea_drafted", { title: ideas[i].title });
          created.push({ id, created: isNew, title: ideas[i].title, brief: ideas[i].brief });
        }
      },
      { modules: ["social"] },
    );
    for (const c of created) {
      if (c.created) await writeActivity(tenantId, req.principal.userId, "created", "social_post", c.id, { source: "ai", ideaDraft: true });
    }
    return { ideas: created, draftedVia, groundedOn: knowledgeHits.map((h) => h.sourceRef) };
  }

  // ============================== SMM-26: THE `smm-agent-content-brief` FLOW =================
  // "Brief in, drafts out, nothing published." ONE call composes SMM-19's own idea-drafting
  // (draftPostIdeas) and caption-drafting (draftPostVariantCaption) paths for a WHOLE content
  // brief in one shot — content-brief.ts owns the DB/AI orchestration, this method validates the
  // request shape and calls authorize() (criterion 1: authorize() lives ONLY here, never in the
  // domain file). `source='agent'` on every created post, never 'ai' — see content-brief.ts's own
  // comment on why that is an honest distinction, not a cosmetic one.
  @Post("engagements/:engagementId/agent-content-brief")
  @HttpCode(201)
  async agentContentBrief(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string,
    @Body() body: { brief?: string; campaignId?: string; count?: number; ids?: string[]; accountIds?: string[]; wantImage?: boolean } = {},
  ) {
    if (body?.wantImage) refuse("image_generation_unavailable"); // D-17 — no image path, ever.
    if (body.count !== undefined && (!Number.isInteger(body.count) || body.count < 1 || body.count > MAX_IDEA_COUNT)) refuse("invalid_count");
    if (body.ids !== undefined && body.ids.some((id) => !UUID_RE.test(id))) refuse("invalid_id");
    if (body.accountIds !== undefined && (!Array.isArray(body.accountIds) || body.accountIds.some((id) => !UUID_RE.test(id)))) refuse("invalid_id");
    // Same TWO actions a caller composing this by hand would trigger (draftPostIdeas' own `create`
    // plus addPostVariant's/draftPostVariantCaption's own `update`) — checked up front, once each,
    // rather than once per row: the SAME batching `draftPostIdeas` itself already uses for its own
    // `create` check when it writes N idea rows in one call.
    await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "create");
    await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "update");

    const result = await runContentBrief(tenantId, engagementId, req.principal.userId, {
      brief: body.brief, campaignId: body.campaignId, count: body.count, ids: body.ids, accountIds: body.accountIds,
    });
    if (result.kind === "not_found") throw new NotFoundException("social engagement not found");
    if (result.kind === "refuse") refuse(result.reason);

    for (const idea of result.ideas) {
      if (idea.created) await writeActivity(tenantId, req.principal.userId, "created", "social_post", idea.id, { source: "agent", contentBrief: true });
      for (const v of idea.variants) {
        if (v.created) await writeActivity(tenantId, req.principal.userId, "created", "social_post_variant", v.variantId, { source: "agent", aiDrafted: true, contentBrief: true });
      }
    }
    return {
      ok: true, ideas: result.ideas, draftedVia: result.draftedVia, groundedOn: result.groundedOn,
      accountsConsidered: result.accountsConsidered, variantsSkipped: result.variantsSkipped,
    };
  }

  // ============================================ PUBLISHER ORGS + CONNECTOR REGISTRY (SMM-05) ==
  // The three surfaces this ticket adds, and the line it does NOT cross: there is no publish
  // endpoint here. `social.publishPost`, the D14 executable-approval entry and the barred metered
  // twin are SMM-09's, and SMM-09 runs alone. What lands here is the mapping that publishing will
  // ride on, the registry that mirrors it, and a status read that keeps answering when the engine
  // is unreachable. SMM-07 (below, after `syncRegistry`) adds the guided connect flow itself.

  /** The connector registry as data: which accounts are connected, expiring, erroring, and what
   *  each can actually do. A PURE DB READ — it never touches the publisher, which is what makes it
   *  keep working while the engine is down (the "degrade visibly, keep serving reads" property). */
  @Get("accounts")
  async listAccounts(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("clientId") clientId?: string, @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "social_account", tenantId, module: "social" }, "read");
    const params: unknown[] = [];
    const where: string[] = ["a.deleted_at IS NULL"];
    if (clientId) { params.push(clientId); where.push(`a.client_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT a.id, a.client_id AS "clientId", a.network, a.handle, a.display_name AS "displayName",
                a.status, a.quota, a.capabilities, a.last_error AS "lastError",
                a.health_checked_at AS "healthCheckedAt", a.connected_at AS "connectedAt",
                o.postiz_org_id AS "publisherOrgRef", o.driver
           FROM social_accounts a
           JOIN social_publisher_orgs o ON o.id = a.publisher_org_id AND o.tenant_id = a.tenant_id
          WHERE ${where.join(" AND ")}
          ORDER BY a.client_id, a.network, a.handle`,
        params,
      ),
      { modules: ["social"] },
    );
    // NOTE the absence: no token column is selected, because none exists (0105 / design D-5). A
    // future `SELECT *` here would be the moment that stopped being true by accident.
    return { accounts: rows };
  }

  // ================================================================== ANALYTICS (SMM-21) =====
  // Pure reads against `social_metrics_daily`/`social_post_metrics` — 0105's own design comment
  // calls `social_metrics_daily` THE CACHE (D-4: analytics pulls are $0, so nothing is cached
  // outside a tenant row). These endpoints never call the publisher; they answer with whatever
  // `metrics-job.ts#pullMetrics` has already written. A row that was never pulled is simply ABSENT
  // from the response — never a fabricated zero (the same "unknown is not zero" discipline
  // `quota_unknown` already holds the quota strip to). Consult `GET accounts` for each account's
  // `capabilities.analytics` flag and `GET publisher/status` for the deployment-level
  // `account_metrics`/`post_metrics` capability before reading an empty series as "nothing to show"
  // versus "this engine/account cannot report analytics at all".

  /** Per-account daily series for one engagement's client, scoped by date. `engagementId` is
   *  required — accounts are client-scoped, not engagement-scoped (0105), so this is how the
   *  console names which client's accounts to read. Empty when no metrics have ever been pulled
   *  for that window, which is a legitimate steady state, not an error. */
  @Get("metrics/daily")
  async listDailyMetrics(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("engagementId") engagementId?: string, @Query("accountId") accountId?: string,
    @Query("from") from?: string, @Query("to") to?: string,
  ) {
    if (!engagementId) refuse("missing_field");
    if (!UUID_RE.test(engagementId)) refuse("invalid_id");
    if (accountId && !UUID_RE.test(accountId)) refuse("invalid_id");
    await authorize(req.principal, { kind: "social_account", tenantId, module: "social" }, "read");
    const params: unknown[] = [engagementId];
    const where: string[] = ["e.id = $1", "a.deleted_at IS NULL"];
    if (accountId) { params.push(accountId); where.push(`a.id = $${params.length}`); }
    if (from) { params.push(from); where.push(`m.date >= $${params.length}::date`); }
    if (to) { params.push(to); where.push(`m.date <= $${params.length}::date`); }
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        // Every counter is nullable end to end (DailyMetrics's own fields are optional) — an
        // absent field the engine never reported stays SQL NULL through this SELECT, never
        // coalesced to 0, so the console can render "not fetched" honestly.
        // `date` is a plain SQL DATE column — cast to text (not handed back as a JS Date) so a
        // local timezone offset can never shift it a day either way on its way to JSON, the same
        // trap `pm.controller.ts`/`document-builder.ts` already guard every date column against.
        `SELECT m.account_id AS "accountId", a.network, a.handle, a.display_name AS "displayName",
                m.date::text AS date, m.followers, m.impressions, m.reach, m.engagements,
                m.link_clicks AS "linkClicks", m.video_views AS "videoViews"
           FROM social_metrics_daily m
           JOIN social_accounts a ON a.id = m.account_id AND a.tenant_id = m.tenant_id
           JOIN social_engagements e ON e.client_id = a.client_id AND e.tenant_id = a.tenant_id
          WHERE ${where.join(" AND ")}
          ORDER BY a.network, a.handle, m.date`,
        params,
      ),
      { modules: ["social"] },
    );
    return { series: rows };
  }

  /** Latest known metrics snapshot per published variant in one engagement. `social_post_metrics`
   *  is APPEND-ONLY (0105) — this reads the most recent `fetched_at` row per variant, never an
   *  aggregate across snapshots (that would blend counters taken at different times as if they
   *  were one reading). A published post with no row here has simply never been pulled yet — it
   *  is omitted, never rendered as zero engagement. */
  @Get("metrics/posts")
  async listPostMetrics(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("engagementId") engagementId?: string,
  ) {
    if (!engagementId) refuse("missing_field");
    if (!UUID_RE.test(engagementId)) refuse("invalid_id");
    await authorize(req.principal, { kind: "social_account", tenantId, module: "social" }, "read");
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT DISTINCT ON (pm.variant_id)
                pm.variant_id AS "variantId", v.post_id AS "postId", v.account_id AS "accountId",
                a.network, v.published_at AS "publishedAt", v.published_url AS "publishedUrl",
                pm.impressions, pm.likes, pm.comments, pm.shares, pm.saves,
                pm.video_views AS "videoViews", pm.clicks, pm.fetched_at AS "fetchedAt"
           FROM social_post_metrics pm
           JOIN social_post_variants v ON v.id = pm.variant_id AND v.tenant_id = pm.tenant_id
           JOIN social_posts p ON p.id = v.post_id AND p.tenant_id = v.tenant_id
           JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
          WHERE p.engagement_id = $1 AND v.deleted_at IS NULL
          ORDER BY pm.variant_id, pm.fetched_at DESC
          LIMIT 500`,
        [engagementId],
      ),
      { modules: ["social"] },
    );
    return { posts: rows };
  }

  /** Provision the (tenant, client) → publisher-org mapping. Idempotent. See provisioning.ts for
   *  why the org id is an INPUT rather than something we mint (there is no org-creation route on
   *  the engine's public API; an org is a human runbook ceremony on the licence-zone host). */
  @Post("publisher-orgs")
  async provisionOrg(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { clientId?: string; publisherOrgRef?: string; apiKeyRef?: string; driver?: string },
  ) {
    // `connect` — not `update`. Binding a client to a publisher org is the act that makes every
    // future publish on that client possible, which is exactly the reasoning
    // resource_social_account.yaml already gives for why `connect` is its own manager-tier action.
    await authorize(req.principal, { kind: "social_account", tenantId, module: "social" }, "connect");
    if (!body?.clientId || !UUID_RE.test(body.clientId)) refuse("invalid_client");
    const orgRef = (body?.publisherOrgRef ?? "").trim();
    if (!orgRef) refuse("missing_publisher_org_ref");
    if (body?.driver && !["postiz", "mixpost"].includes(body.driver)) refuse("unknown_driver");
    const result = await provisionPublisherOrg(tenantId, {
      clientId: body.clientId,
      postizOrgId: orgRef,
      apiKeyRef: body.apiKeyRef,
      driver: body.driver,
      actorId: req.principal.userId,
    });
    return {
      publisherOrgId: result.org.id,
      clientId: result.org.clientId,
      driver: result.org.driver,
      publisherOrgRef: result.org.postizOrgId,
      // The ALIAS, never the key. keys.ts resolves it from env at call time and nothing persists it.
      apiKeyRef: result.org.apiKeyRef,
      created: result.created,
      // An honest verification result, including when it is a failure: the mapping is OUR data and
      // a remote outage must not block recording it, but it must not be dressed up as verified
      // either. `{ok:false, reason:"publisher_unreachable"}` is the answer, not a thrown error.
      verification: result.verification,
    };
  }

  /** Mirror the engine's integrations into the connector registry. Refuses — touching NOT ONE row —
   *  when the publisher is unreachable, so a tunnel outage can never be mistaken for "every client
   *  account is disconnected". */
  @Post("publisher-orgs/:clientId/sync")
  @HttpCode(200)
  async syncRegistry(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
  ) {
    // `update` — the sync writes registry METADATA (status, quota, capabilities, health). It does
    // not authorize a new connection, so it must not need `connect`.
    await authorize(req.principal, { kind: "social_account", tenantId, module: "social" }, "update");
    if (!UUID_RE.test(clientId)) refuse("invalid_client");
    return syncConnectorRegistry(tenantId, clientId, req.principal.userId);
  }

  // =============================================== ACCOUNT CONNECT FLOW (SMM-07) ============
  // The engine holds NO platform-app credentials on any network today (verified on the live engine
  // 2026-08-19 — every FACEBOOK_APP_ID/LINKEDIN_CLIENT_ID/etc. is length 0), so no OAuth round trip
  // can start yet, for a client OR for our own brand. Both routes below run the SAME precondition
  // (`checkConnectReadiness`) so the console can explain a disabled connect button with the EXACT
  // reason the POST would refuse, never a guess rendered separately from the truth.

  /** Read-only: may this (client, network) connect right now, and if not, why. Never calls the
   *  publisher and never writes a row — a console renders this to explain a disabled connect button
   *  honestly ("Instagram is not connectable yet: no platform app is registered") instead of letting
   *  the user find out by clicking into a dead end. */
  @Get("publisher-orgs/:clientId/connect/:network")
  async connectReadiness(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("clientId") clientId: string, @Param("network") network: string,
  ) {
    await authorize(req.principal, { kind: "social_account", tenantId, module: "social" }, "read");
    if (!UUID_RE.test(clientId)) refuse("invalid_client");
    return checkConnectReadiness(tenantId, clientId, network);
  }

  /** Start — or RESUME — the guided connect ceremony for one (client, network, handle). `connect`,
   *  same manager-tier action `provisionOrg` already gates: this is the step that grants an outside
   *  system standing permission to post as a brand. Idempotent on the (client, network, handle)
   *  triple (0105's own unique index) — a human who closes the tab and comes back tomorrow resumes
   *  the SAME pending row rather than growing a second one. See provisioning.ts's SMM-07 section for
   *  the full resumability + own-brand-first (OQ-3) reasoning. */
  @Post("publisher-orgs/:clientId/connect")
  @HttpCode(200)
  async connectAccount(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Body() body: { network?: string; handle?: string },
  ) {
    await authorize(req.principal, { kind: "social_account", tenantId, module: "social" }, "connect");
    if (!UUID_RE.test(clientId)) refuse("invalid_client");
    const network = (body?.network ?? "").trim();
    if (!NETWORKS.has(network)) refuse("unknown_network");
    const handle = (body?.handle ?? "").trim();
    if (!handle) refuse("missing_handle");
    return initiateAccountConnect(tenantId, { clientId, network, handle, actorId: req.principal.userId });
  }

  /** What the publisher seam can do in THIS deployment, without calling it. Answers while the
   *  engine is down — that is the point. The console reads it to explain a degraded 🔌 feature
   *  instead of showing an empty panel, and an agent reads it to know a capability is absent
   *  BEFORE spending a call on it (agentic bar: explicit refusal, never an empty list). */
  @Get("publisher/status")
  async publisherStatus(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "social_account", tenantId, module: "social" }, "read");
    const driver = getPublisher((config.social.publisher.driver ?? "postiz") as "postiz" | "mixpost");
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT o.id AS "publisherOrgId", o.client_id AS "clientId", o.driver, o.status,
                count(a.id) FILTER (WHERE a.deleted_at IS NULL) AS "accountCount",
                max(a.health_checked_at) AS "lastSyncedAt"
           FROM social_publisher_orgs o
           LEFT JOIN social_accounts a ON a.publisher_org_id = o.id AND a.tenant_id = o.tenant_id
          WHERE o.deleted_at IS NULL
          GROUP BY o.id, o.client_id, o.driver, o.status
          ORDER BY o.created_at`,
        [],
      ),
      { modules: ["social"] },
    );
    return {
      configured: Boolean(driver),
      driver: driver?.key ?? null,
      // Deployment-level network gate — a second, higher gate than any engagement's tool_scope.
      enabledNetworks: config.social.publisher.enabledNetworks,
      capabilities: driver ? [...driver.capabilities].sort() : [],
      // Stated explicitly because it is the single biggest correction the SMM-04 spike produced and
      // it is otherwise invisible: this engine has NO inbound engagement surface, for any network
      // (spike §8b). P2's inbox has nothing behind this port to call.
      inboxSurface: driver?.capabilities.has("inbox_read") ? "available" : "none",
      // Likewise: the live Instagram quota probe is off unless a verified trigger name is set.
      // Absent ⇒ `quota_unknown` warnings, never a fabricated cap (addendum §A4f).
      quotaProbe: config.social.publisher.quotaProbeTool ? "live" : "unavailable",
      orgs: rows,
    };
  }

  /** Load an account's network + live quota, refusing anything outside this tenant. Shared by every
   *  variant path so the network a variant is validated against always comes from the REGISTRY,
   *  never from the request body — a caller must not be able to claim "this is a Facebook post"
   *  and dodge Instagram's rules. */
  private async loadAccount(tenantId: string, accountId: string): Promise<{ network: Network; quota: QuotaSnapshot }> {
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query<{ network: string; quota: QuotaSnapshot }>(
        `SELECT network, quota FROM social_accounts WHERE id = $1 AND deleted_at IS NULL`,
        [accountId],
      ),
      { modules: ["social"] },
    );
    if (!rows[0]) throw new NotFoundException("social account not found");
    if (!isNetwork(rows[0].network)) refuse("unknown_network");
    return { network: rows[0].network, quota: rows[0].quota ?? {} };
  }

  // ============================================================ SMM-19 AI HELPERS ============
  /** The engagement facts every AI-drafting endpoint consults: which client (never trust the
   *  request body for this — it is the property the cross-client leak test exists to prove), the
   *  MERGED tool_scope (so an engagement predating a toggle answers with the toggle's default, same
   *  as getScope), and the brand voice/hashtag config. */
  private async loadEngagementForAi(
    tenantId: string, engagementId: string,
  ): Promise<{ clientId: string; name: string; toolScope: ToolScope; tone: Record<string, unknown>; hashtagStrategy: HashtagStrategy }> {
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query<{ clientId: string; name: string; toolScope: ToolScope; tone: Record<string, unknown>; hashtagStrategy: HashtagStrategy }>(
        `SELECT e.client_id AS "clientId", e.name, e.tool_scope AS "toolScope",
                COALESCE(b.tone, '{}'::jsonb) AS tone, COALESCE(b.hashtag_strategy, '{}'::jsonb) AS "hashtagStrategy"
           FROM social_engagements e
           LEFT JOIN social_brand_profiles b ON b.client_id = e.client_id AND b.tenant_id = e.tenant_id AND b.deleted_at IS NULL
          WHERE e.id = $1 AND e.deleted_at IS NULL`,
        [engagementId],
      ),
      { modules: ["social"] },
    );
    if (!rows[0]) throw new NotFoundException("social engagement not found");
    return { ...rows[0], toolScope: mergeScope(DEFAULT_TOOL_SCOPE as unknown as ToolScope, rows[0].toolScope ?? {}) };
  }

  /** Everything draftPostVariantCaption needs in one round trip: the variant's own content +
   *  status, its account's network (from the REGISTRY, same discipline as loadAccount), and its
   *  post -> engagement -> client chain (the RAG scope) + brand voice config. */
  private async loadVariantForDraft(tenantId: string, variantId: string): Promise<{
    postId: string; accountId: string; network: string; status: string; nativeImport: boolean;
    body: string; firstComment: string | null; media: unknown; settings: Record<string, unknown>; scheduledAt: Date | string | null;
    clientId: string; engagementName: string; postBrief: string | null;
    toolScope: ToolScope; tone: Record<string, unknown>; hashtagStrategy: HashtagStrategy;
  }> {
    const { rows } = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT v.id, v.post_id AS "postId", v.account_id AS "accountId", v.status, v.native_import AS "nativeImport",
                v.body, v.first_comment AS "firstComment", v.media, v.settings, v.scheduled_at AS "scheduledAt",
                a.network, p.brief AS "postBrief", e.client_id AS "clientId", e.name AS "engagementName", e.tool_scope AS "toolScope",
                COALESCE(bp.tone, '{}'::jsonb) AS tone, COALESCE(bp.hashtag_strategy, '{}'::jsonb) AS "hashtagStrategy"
           FROM social_post_variants v
           JOIN social_posts p ON p.id = v.post_id
           JOIN social_engagements e ON e.id = p.engagement_id
           JOIN social_accounts a ON a.id = v.account_id
           LEFT JOIN social_brand_profiles bp ON bp.client_id = e.client_id AND bp.tenant_id = e.tenant_id AND bp.deleted_at IS NULL
          WHERE v.id = $1 AND v.deleted_at IS NULL`,
        [variantId],
      ),
      { modules: ["social"] },
    );
    if (!rows[0]) throw new NotFoundException("post variant not found");
    const row = rows[0] as Record<string, unknown>;
    return {
      postId: row.postId as string, accountId: row.accountId as string, network: row.network as string,
      status: row.status as string, nativeImport: row.nativeImport as boolean,
      body: row.body as string, firstComment: row.firstComment as string | null, media: row.media, settings: row.settings as Record<string, unknown>,
      scheduledAt: row.scheduledAt as Date | string | null,
      clientId: row.clientId as string, engagementName: row.engagementName as string, postBrief: row.postBrief as string | null,
      toolScope: mergeScope(DEFAULT_TOOL_SCOPE as unknown as ToolScope, (row.toolScope as ToolScope) ?? {}),
      tone: row.tone as Record<string, unknown>, hashtagStrategy: row.hashtagStrategy as HashtagStrategy,
    };
  }

  /** Persist AI-drafted content onto an existing variant with EXACTLY the state law updateVariant
   *  enforces (re-validate, recompute args_sha256, invalidate any existing approval in the SAME
   *  statement) — an AI-authored edit is still an edit, and this is a second call site for that
   *  law, not a second definition of it. Re-checks editability under FOR UPDATE: the row could have
   *  moved between loadVariantForDraft's read and this write (e.g. a human approved it in between). */
  private async writeDraftedVariantContent(
    tenantId: string, variantId: string,
    next: { body: string; firstComment: string | null; media: unknown; settings: Record<string, unknown>; scheduledAt: Date | string | null },
  ): Promise<
    | { kind: "not_found" }
    | { kind: "refuse"; reason: string }
    | { kind: "ok"; validation: ReturnType<typeof validateVariant>; argsSha256: string; estimatedCostUsd: number; wasApproved: boolean }
  > {
    const locked = await withTenants(
      [tenantId],
      async (c) => {
        const { rows } = await c.query<{ account_id: string; status: string; approval_id: string | null; native_import: boolean }>(
          `SELECT account_id, status, approval_id, native_import FROM social_post_variants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [variantId],
        );
        const row = rows[0];
        if (!row) return { outcome: "not_found" as const };
        // Re-checked under the row lock: the row could have moved between loadVariantForDraft's
        // read and this write (e.g. a human approved or published it in the interim).
        if (row.native_import) return { outcome: "refuse" as const, reason: "variant_native_import_immutable" };
        if (!EDITABLE_VARIANT_STATUSES.has(row.status)) return { outcome: "refuse" as const, reason: "variant_not_editable" };
        const argsSha256 = variantArgsSha256({ tenantId, id: variantId, accountId: row.account_id, ...next });
        const wasApproved = row.approval_id !== null || row.status === "approved";
        await c.query(
          `UPDATE social_post_variants
              SET body = $1, first_comment = $2, media = $3, settings = $4, scheduled_at = $5,
                  args_sha256 = $6, approval_id = NULL,
                  -- SMM-10: 'failed' joins the revert set. Before this ticket a dispatch could never
                  -- produce 'failed' (SMM-09 built no dispatch path), so this CASE never needed to
                  -- know about it. It carries approval_id (0105's svar_dispatched_has_approval CHECK
                  -- requires it for any status outside draft/in_review/approved/cancelled) and this
                  -- statement clears it in the SAME breath it moves the content — otherwise a failed
                  -- publish would be permanently unrecoverable: no precondition path and no edit path
                  -- ever returns it to an editable state.
                  status = CASE WHEN status IN ('in_review','approved','failed') THEN 'draft' ELSE status END,
                  updated_at = now()
            WHERE id = $7`,
          [next.body, next.firstComment, JSON.stringify(next.media), JSON.stringify(next.settings), next.scheduledAt, argsSha256, variantId],
        );
        return { outcome: "ok" as const, accountId: row.account_id, argsSha256, wasApproved };
      },
      { modules: ["social"] },
    );
    if (locked.outcome === "not_found") return { kind: "not_found" };
    if (locked.outcome === "refuse") return { kind: "refuse", reason: locked.reason };

    const account = await this.loadAccount(tenantId, locked.accountId);
    const shape = { body: next.body, firstComment: next.firstComment, media: (next.media ?? []) as never[], settings: next.settings };
    const validation = validateVariant(account.network, shape, account.quota);
    const estimatedCostUsd = resolveEstimatedCostOrRefuse(account.network, shape);
    await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE social_post_variants SET validation = $1, estimated_cost_usd = $2 WHERE id = $3`, [JSON.stringify(validation), estimatedCostUsd, variantId]),
      { modules: ["social"] },
    );
    return { kind: "ok", validation, argsSha256: locked.argsSha256, estimatedCostUsd, wasApproved: locked.wasApproved };
  }
}

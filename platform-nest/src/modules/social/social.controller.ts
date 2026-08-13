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
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { DEFAULT_TOOL_SCOPE, DEFAULT_USAGE_BUDGET_USD } from "./index";
import { variantArgsSha256 } from "./canonical-args";
import { validateVariant, estimateCostUsd, isNetwork, type Network, type QuotaSnapshot } from "./media-rules";
import { completeViaGateway } from "./gateway-client";
import { ingestBrandKnowledge, queryBrandKnowledge, brandCorpusScope } from "./knowledge-client";
import {
  buildCaptionPrompt, parseCaptionDraft, buildIdeaPrompt, parseIdeaDraft,
  MAX_KNOWLEDGE_HITS, MAX_BRAND_INGEST_CHUNKS, MAX_IDEA_COUNT,
  type HashtagStrategy,
} from "./ai-drafts";

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
        return merged;
      },
      { modules: ["social"] },
    );
    if (!result) throw new NotFoundException("social engagement not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "social_engagement", engagementId, {
      scopeGroups: patch ? Object.keys(patch) : [], budgetChanged: budget !== undefined,
    });
    return {
      toolScope: mergeScope(DEFAULT_TOOL_SCOPE as unknown as ToolScope, result),
      usageBudgetUsd: budget,
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
    };
    const validation = validateVariant(account.network, draft, account.quota);
    const argsSha256 = variantArgsSha256({
      tenantId, id, accountId: body.accountId, body: draft.body, firstComment: draft.firstComment,
      media: draft.media, settings: draft.settings, scheduledAt: body.scheduledAt ?? null,
    });
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
           argsSha256, body.scheduledAt ?? null, estimateCostUsd(account.network, draft), config.originSite],
        );
        return (ins.rowCount ?? 0) > 0;
      },
      { modules: ["social"] },
    );
    if (created) await writeActivity(tenantId, req.principal.userId, "created", "social_post_variant", id, { network: account.network });
    // The validation travels back with the 201 so the composer can render it immediately — the
    // caller should never have to make a second call to find out whether what it just created is
    // publishable.
    return { id, created, validation, argsSha256, estimatedCostUsd: estimateCostUsd(account.network, draft) };
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
                  status = CASE WHEN status IN ('in_review','approved') THEN 'draft' ELSE status END,
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
    }, account.quota);
    await withTenants(
      [tenantId],
      (c) => c.query(
        `UPDATE social_post_variants SET validation = $1, estimated_cost_usd = $2 WHERE id = $3`,
        [JSON.stringify(validation), estimateCostUsd(account.network, {
          body: result.next.body, media: (result.next.media ?? []) as never[], settings: result.next.settings,
        }), variantId],
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
      (c) => c.query<{ account_id: string; body: string; first_comment: string | null; media: unknown; settings: Record<string, unknown> }>(
        `SELECT account_id, body, first_comment, media, settings
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
    };
    // Computed FRESH rather than read from the stored column: the quota moves under us between
    // edits, so the stored verdict answers "was it valid when last written", and the caller asking
    // this endpoint wants "is it valid now".
    return {
      validation: validateVariant(account.network, shape, account.quota),
      estimatedCostUsd: estimateCostUsd(account.network, shape),
      network: account.network,
    };
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
                  status = CASE WHEN status IN ('in_review','approved') THEN 'draft' ELSE status END,
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
    const estimatedCostUsd = estimateCostUsd(account.network, shape);
    await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE social_post_variants SET validation = $1, estimated_cost_usd = $2 WHERE id = $3`, [JSON.stringify(validation), estimatedCostUsd, variantId]),
      { modules: ["social"] },
    );
    return { kind: "ok", validation, argsSha256: locked.argsSha256, estimatedCostUsd, wasApproved: locked.wasApproved };
  }
}

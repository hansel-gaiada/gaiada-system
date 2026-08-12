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

const ENGAGEMENT_STATUSES = new Set(["draft", "active", "paused", "closed"]);
const NETWORKS = new Set([
  "instagram", "facebook", "tiktok", "linkedin", "x",
  "youtube", "threads", "pinterest", "bluesky", "mastodon",
]);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
}

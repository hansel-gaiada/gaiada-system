// SCP-1b — the stage machine's reads (FRONTEND-BFF-CONTRACT §63.1, §63.3, §63.6). Every function takes the caller's
// client: the caller owns the transaction, its tenant scope and (for the action route) the post's row lock. Social tables
// carry the module wall, so each caller runs inside `withTenants([tenantId], …, { modules: ["social"] })`; the core tables
// read here (clients, users, files, creative_assets, work_requests, user_roles) need no module scope.
//
// The machine (`machine.ts`) is pure; this file is where the rows become its inputs: the post state, the principal facts
// and the per-action `StageFacts`. Nothing here decides anything.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { withGlobal } from "../../../db";
import { config } from "../../../config";
import { validateVariant, isNetwork, type QuotaSnapshot } from "../media-rules";
import { departmentUnits, workspaceSlugFor } from "../../reports/dept-kpis";
import { loadOrgStructure } from "../../reports/person-scope";
import { getPublisher } from "../publisher/registry";
import type { PublisherKey } from "../publisher/types";
import { scpAction } from "./fixture";
import { holderOf, postStateFromRow, type PipelinePostState, type SocialPostRow, type StageFacts } from "./machine";

// ── The post ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A `social_posts` row as the routes read it: the machine's columns plus what the routes show and write. */
export interface PostRow extends SocialPostRow {
  tenant_id: string;
  engagement_id: string;
  cycle_id: string | null;
  status: string;
  status_since: Date | null;
  creative_request_id: string | null;
  skipped_checks: Array<{ codes: string[]; reason: string; by: string; at: string }>;
  is_extra: boolean;
  live_url: string | null;
  went_live_at: Date | null;
  simulated: boolean;
  archived_at: Date | null;
}

const POST_COLUMNS = `p.id, p.tenant_id, p.engagement_id, p.cycle_id, p.title, p.status, p.pipeline_status, p.status_since,
  p.deleted_at, p.archived_at, p.author_id::text AS author_id, p.change_by, p.change_kind, p.return_to, p.change_note,
  p.changed_only, p.copy_before, p.blocked_from, p.block_reason, p.block_waiting_on, p.blocked_at, p.creative_source,
  p.creative_state, p.creative_request_id::text AS creative_request_id, p.schedule_via, p.client_first_sent_at,
  p.last_action_id::text AS last_action_id, p.format, p.pillar, p.angle, p.objective, p.key_message, p.visual_direction,
  p.raw_assets, p.placement, p.scheduled_at, p.must_haves, p.caption, p.on_asset_text, p.cta, p.hashtags, p.suggestions,
  p.skipped_checks, p.is_extra, p.live_url, p.went_live_at, p.simulated`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuidText = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** The post row, deleted or not (the machine answers a deleted post 404 itself), or null. `lock` takes the row lock the
 *  action route holds for the whole decision (BFF §63.3.2 step 12). */
export async function loadPostRow(c: PoolClient, tenantId: string, postId: string, lock = false): Promise<PostRow | null> {
  if (!isUuidText(postId)) return null;
  const { rows } = await c.query<PostRow>(
    `SELECT ${POST_COLUMNS} FROM social_posts p WHERE p.tenant_id = $1 AND p.id = $2 ${lock ? "FOR UPDATE" : ""}`,
    [tenantId, postId],
  );
  return rows[0] ?? null;
}

export function stateOf(row: PostRow | null): PipelinePostState | null {
  return row ? postStateFromRow(row) : null;
}

// ── The engagement, the brand book and the cycle ─────────────────────────────────────────────────────────────────

export interface EngagementRow {
  id: string;
  client_id: string;
  client_name: string;
  owner_id: string | null;
  creative_source: string;
  platforms: string[];
  project_id: string | null;
  hashtag_strategy: { placement?: string; sets?: Array<{ name: string; tags: string[] }> } & Record<string, unknown>;
}

export async function loadEngagement(c: PoolClient, tenantId: string, engagementId: string): Promise<EngagementRow | null> {
  const { rows } = await c.query<EngagementRow>(
    `SELECT e.id, e.client_id, cl.name AS client_name, e.owner_id::text AS owner_id, e.creative_source, e.platforms,
            e.project_id, COALESCE(b.hashtag_strategy, '{}'::jsonb) AS hashtag_strategy
       FROM social_engagements e
       JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
       LEFT JOIN social_brand_profiles b ON b.tenant_id = e.tenant_id AND b.client_id = e.client_id AND b.deleted_at IS NULL
      WHERE e.tenant_id = $1 AND e.id = $2 AND e.deleted_at IS NULL`,
    [tenantId, engagementId],
  );
  return rows[0] ?? null;
}

export interface CycleRow {
  id: string;
  engagement_id: string;
  month: string; // YYYY-MM
  month_start: string; // YYYY-MM-DD
  ready_by: string; // YYYY-MM-DD
  creative_request_id: string | null;
}

export async function loadCycle(c: PoolClient, tenantId: string, cycleId: string, lock = false): Promise<CycleRow | null> {
  if (!isUuidText(cycleId)) return null;
  const { rows } = await c.query<CycleRow>(
    `SELECT id, engagement_id, to_char(month, 'YYYY-MM') AS month, month::text AS month_start, ready_by::text AS ready_by,
            creative_request_id::text AS creative_request_id
       FROM social_cycles WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
    [tenantId, cycleId],
  );
  return rows[0] ?? null;
}

// ── Variants, reviews and designs ────────────────────────────────────────────────────────────────────────────────

export interface VariantRow {
  id: string;
  account_id: string;
  network: string;
  handle: string;
  quota: QuotaSnapshot;
  body: string;
  first_comment: string | null;
  media: unknown[];
  settings: Record<string, unknown>;
  validation: Record<string, unknown>;
  args_sha256: string | null;
  status: string;
  approval_id: string | null;
  scheduled_at: Date | null;
  native_import: boolean;
  provider_post_id: string | null;
  review_id: string | null;
  review_status: string | null;
  reviewed_args_sha256: string | null;
}

/** The post's live variants with their review, by network. */
export async function loadVariants(c: PoolClient, tenantId: string, postId: string, lock = false): Promise<VariantRow[]> {
  const { rows } = await c.query<VariantRow>(
    `SELECT v.id, v.account_id, a.network, a.handle, a.quota, v.body, v.first_comment, v.media, v.settings, v.validation,
            v.args_sha256, v.status, v.approval_id, v.scheduled_at, v.native_import, v.provider_post_id,
            r.id AS review_id, r.status AS review_status, r.reviewed_args_sha256
       FROM social_post_variants v
       JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
       LEFT JOIN social_post_client_reviews r ON r.variant_id = v.id AND r.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1 AND v.post_id = $2 AND v.deleted_at IS NULL
      ORDER BY a.network, v.id ${lock ? "FOR UPDATE OF v" : ""}`,
    [tenantId, postId],
  );
  return rows;
}

/** BFF §63.6.2: "the sha256 of the sorted `variantId:args_sha256` lines, null before final_approve". */
export function reviewHashOf(variants: Pick<VariantRow, "id" | "args_sha256">[]): string | null {
  if (variants.length === 0) return null;
  const lines = variants.map((v) => `${v.id}:${v.args_sha256 ?? ""}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** BFF §63.6.2 `approvedSchedule`: the date, time and placement the client approved, null before the client's approval.
 *  The client approved when every live variant's review is approved against the variant's current args hash (that hash
 *  includes the variant's `scheduledAt`, so a moved date un-approves by construction: SCP-Q13). */
export function approvedScheduleOf(
  post: Pick<PipelinePostState, "scheduledAt" | "placement">,
  variants: Pick<VariantRow, "review_status" | "reviewed_args_sha256" | "args_sha256" | "network" | "scheduled_at">[],
): { scheduledAt: string | null; placement: string[] } | null {
  if (variants.length === 0) return null;
  const approved = variants.every((v) => v.review_status === "approved" && v.reviewed_args_sha256 !== null && v.reviewed_args_sha256 === v.args_sha256);
  if (!approved) return null;
  const at = variants[0].scheduled_at;
  return { scheduledAt: at ? new Date(at).toISOString() : post.scheduledAt, placement: [...new Set(variants.map((v) => v.network))].sort() };
}

export interface DesignRow {
  id: string;
  position: number;
  asset_group_id: string | null;
  link_url: string | null;
  link_source: string | null;
  link_ai_note: string | null;
  file_id: string | null;
  file_version_no: number | null;
  // the group's latest live version (null for a link)
  asset_version_id: string | null;
  asset_version_no: number | null;
  asset_name: string | null;
  asset_content_type: string | null;
  asset_graded_key: string | null;
  asset_graded_byte_size: string | null;
  // the latest live version's own source and AI note (`creative_assets`, SCP-1h file 4); null for a link
  asset_source: string | null;
  asset_ai_note: string | null;
}

export async function loadDesigns(c: PoolClient, tenantId: string, postId: string): Promise<DesignRow[]> {
  const { rows } = await c.query<DesignRow>(
    `SELECT d.id, d.position, d.asset_group_id::text AS asset_group_id, d.link_url, d.link_source, d.link_ai_note,
            d.file_id::text AS file_id, d.file_version_no,
            a.id::text AS asset_version_id, a.version_no AS asset_version_no, a.name AS asset_name,
            a.content_type AS asset_content_type, a.graded_key AS asset_graded_key, a.graded_byte_size AS asset_graded_byte_size,
            a.source AS asset_source, a.ai_note AS asset_ai_note
       FROM social_post_designs d
       LEFT JOIN LATERAL (
         SELECT ca.id, ca.version_no, ca.name, ca.content_type, ca.graded_key, ca.graded_byte_size, ca.source, ca.ai_note
           FROM creative_assets ca
          WHERE ca.tenant_id = d.tenant_id AND COALESCE(ca.version_group_id, ca.id) = d.asset_group_id AND ca.deleted_at IS NULL
          ORDER BY ca.version_no DESC LIMIT 1
       ) a ON d.asset_group_id IS NOT NULL
      WHERE d.tenant_id = $1 AND d.post_id = $2 AND d.removed_at IS NULL
      ORDER BY d.position, d.added_at`,
    [tenantId, postId],
  );
  return rows;
}

/** The version group an asset id belongs to, in THIS tenant (the FK to creative_assets is plain, so the tenant is checked
 *  here as well as by RLS): an asset of another company is unknown. */
export async function resolveAssetGroup(c: PoolClient, tenantId: string, assetId: string): Promise<string | null> {
  if (!isUuidText(assetId)) return null;
  const { rows } = await c.query<{ group_id: string }>(
    `SELECT COALESCE(version_group_id, id)::text AS group_id FROM creative_assets
      WHERE tenant_id = $1 AND (id = $2 OR version_group_id = $2) AND deleted_at IS NULL
      ORDER BY version_no DESC LIMIT 1`,
    [tenantId, assetId],
  );
  return rows[0]?.group_id ?? null;
}

// ── Accounts, units, people ──────────────────────────────────────────────────────────────────────────────────────

/** The client's usable accounts, per network (BFF §63.3.5: "the client's account on that network"). */
export async function loadClientAccounts(c: PoolClient, tenantId: string, clientId: string): Promise<Map<string, Array<{ id: string; quota: QuotaSnapshot }>>> {
  const { rows } = await c.query<{ id: string; network: string; quota: QuotaSnapshot }>(
    `SELECT id, network, quota FROM social_accounts
      WHERE tenant_id = $1 AND client_id = $2 AND deleted_at IS NULL AND status <> 'disconnected'
      ORDER BY network, id`,
    [tenantId, clientId],
  );
  const out = new Map<string, Array<{ id: string; quota: QuotaSnapshot }>>();
  for (const r of rows) {
    const list = out.get(r.network) ?? [];
    list.push({ id: r.id, quota: r.quota ?? {} });
    out.set(r.network, list);
  }
  return out;
}

/** The company's department whose workspace slug is `slug` (`social-media`, `creatives`), by name as every GM surface
 *  finds its units (PV-D13): never a hard-coded node id. */
export async function findDepartmentBySlug(c: PoolClient, tenantId: string, slug: string): Promise<{ id: string; name: string } | null> {
  const vertical = (await c.query<{ vertical: string | null }>(`SELECT vertical FROM companies WHERE id = $1`, [tenantId])).rows[0]?.vertical ?? null;
  const units = departmentUnits(await loadOrgStructure(c, tenantId));
  const hit = units.find((u) => workspaceSlugFor(vertical, u.name) === slug);
  return hit ? { id: hit.id, name: hit.name } : null;
}

/** Holders of a role at company scope on `tenantId` (or global), excluding expired grants. For notifications only: who is
 *  TOLD, never who may act (Cerbos decides that). */
export async function roleHolders(tenantId: string, roleName: string): Promise<string[]> {
  const { rows } = await withGlobal((c) =>
    c.query<{ user_id: string }>(
      `SELECT DISTINCT ur.user_id::text AS user_id
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE r.name = $1
          AND ((ur.scope_type = 'company' AND ur.scope_id = $2) OR ur.scope_type = 'global')
          AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
      [roleName, tenantId],
    ),
  );
  return rows.map((r) => r.user_id);
}

export async function userNames(c: PoolClient, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)))];
  if (!list.length) return new Map();
  const { rows } = await c.query<{ id: string; name: string | null }>(`SELECT id::text AS id, name FROM users WHERE id = ANY($1::uuid[])`, [list]);
  return new Map(rows.map((r) => [r.id, r.name ?? "Someone"]));
}

/** Who holds the post now, as user ids (BFF §63.6.2 `holder.userIds`), for `follow_up` and the read. The officer is the
 *  engagement owner; the approvers are the two seats (the owner and the superadmin are never notified, §63.14); the
 *  designers are the month request's assignees (`creatives`) or every `social_designer` (`in_team`); the client's
 *  contacts are not user ids here (the portal reminder is the client's channel). */
export async function holderUserIds(
  tenantId: string,
  state: PipelinePostState,
  who: { ownerId: string; approverIds: string[]; assigneeIds: string[] },
): Promise<{ role: string | null; userIds: string[] }> {
  const role = state.pipelineStatus ? holderOf(state) : null;
  switch (role) {
    case "officer": return { role, userIds: who.ownerId ? [who.ownerId] : [] };
    case "approver": return { role, userIds: who.approverIds };
    case "copywriter": return { role, userIds: await roleHolders(tenantId, "social_copywriter") };
    case "designer":
      return { role, userIds: state.creativeSource === "in_team" ? await roleHolders(tenantId, "social_designer") : who.assigneeIds };
    default: return { role, userIds: [] };
  }
}

// ── The facts each action's guards and effects read ──────────────────────────────────────────────────────────────

export interface FactsInput {
  tenantId: string;
  action: string;
  state: PipelinePostState | null;
  params: Record<string, unknown>;
  engagement: EngagementRow;
  cycle: CycleRow | null;
  callerId: string | null;
  who: { ownerId: string; approverIds: string[]; assigneeIds: string[] };
}

/** The `StageFacts` one action needs, read on the caller's client (inside the post's lock on the action route). Only the
 *  facts the action's guards and effects name are read. */
export async function loadFacts(c: PoolClient, f: FactsInput): Promise<StageFacts> {
  const a = scpAction(f.action);
  const guards = new Set((a?.guards ?? []).map((g) => g.guard));
  const facts: StageFacts = { now: new Date() };
  const postId = f.state?.id ?? null;

  if (guards.has("cycle_exists")) {
    facts.cycleExists = f.cycle !== null && f.cycle.engagement_id === f.engagement.id;
    if (f.cycle) {
      facts.cycleId = f.cycle.id;
      facts.engagementId = f.engagement.id;
    }
  }
  if (guards.has("creatives_unit_exists_when_source_creatives") || f.action === "approve_for_design") {
    facts.engagementCreativeSource = f.engagement.creative_source;
    facts.creativesUnitExists = f.engagement.creative_source === "creatives" ? (await findDepartmentBySlug(c, f.tenantId, "creatives")) !== null : true;
  }
  if (guards.has("asset_exists") && typeof f.params.assetGroupId === "string") {
    facts.assetExists = (await resolveAssetGroup(c, f.tenantId, f.params.assetGroupId)) !== null;
  }
  if (guards.has("design_exists") && postId && isUuidText(f.params.designId)) {
    const r = await c.query(`SELECT 1 FROM social_post_designs WHERE tenant_id = $1 AND post_id = $2 AND id = $3 AND removed_at IS NULL`, [f.tenantId, postId, f.params.designId]);
    facts.designExists = (r.rowCount ?? 0) > 0;
  } else if (guards.has("design_exists")) {
    facts.designExists = false;
  }
  if ((guards.has("design_present") || guards.has("designs_stored")) && postId) {
    const designs = await loadDesigns(c, f.tenantId, postId);
    facts.designCount = designs.length;
    // A link-only design has nothing stored to show the client (BFF §63.3.5); an asset whose group has no live version
    // has nothing either.
    facts.unstoredDesignIds = designs.filter((d) => d.asset_group_id === null || d.asset_version_id === null).map((d) => d.id);
  }

  const variants = postId ? await loadVariants(c, f.tenantId, postId) : [];
  if (guards.has("one_account_per_placement_network") || guards.has("account_not_ambiguous")) {
    const accounts = await loadClientAccounts(c, f.tenantId, f.engagement.client_id);
    facts.accountsByNetwork = Object.fromEntries([...accounts.entries()].map(([n, l]) => [n, l.length]));
  }
  if (guards.has("seen_hash_matches")) facts.reviewHash = reviewHashOf(variants);
  if (guards.has("every_variant_review_pending")) facts.everyReviewPending = variants.length > 0 && variants.every((v) => v.review_status === "pending");
  facts.variantStatuses = variants.map((v) => v.status);
  if (guards.has("no_variant_publishing")) facts.anyVariantPublishing = variants.some((v) => v.status === "publishing");
  if (guards.has("media_rules_pass")) {
    facts.mediaFailures = variants
      .map((v) => {
        if (!isNetwork(v.network)) return { variantId: v.id, errors: [{ rule: "unknown_network", message: v.network }] };
        const res = validateVariant(v.network, {
          body: v.body, firstComment: v.first_comment, media: (v.media ?? []) as never[], settings: v.settings ?? {}, scheduledAt: v.scheduled_at,
        }, v.quota);
        return { variantId: v.id, errors: res.errors };
      })
      .filter((x) => x.errors.length > 0);
  }
  if (guards.has("publisher_available")) {
    const org = await c.query<{ driver: string }>(
      `SELECT driver FROM social_publisher_orgs WHERE tenant_id = $1 AND client_id = $2 AND deleted_at IS NULL AND status = 'active'`,
      [f.tenantId, f.engagement.client_id],
    );
    facts.publisherAvailable = org.rows[0] !== undefined && getPublisher(org.rows[0].driver as PublisherKey) !== undefined;
  }
  if (guards.has("approved_time_not_passed") || guards.has("something_changes") || f.action === "reschedule") {
    facts.approvedSchedule = f.state ? approvedScheduleOf(f.state, variants) : null;
  }
  if (guards.has("holder_is_someone_else") && f.state) {
    const h = await holderUserIds(f.tenantId, f.state, f.who);
    facts.callerHoldsPost = f.callerId !== null && h.userIds.includes(f.callerId);
  }
  if (guards.has("once_per_holder_per_24h") && f.state && postId) {
    const holder = f.state.pipelineStatus ? holderOf(f.state) : null;
    const last = await c.query<{ at: Date }>(
      `SELECT max(occurred_at) AS at FROM activities
        WHERE tenant_id = $1 AND target_entity_type = 'social_post' AND target_entity_id = $2 AND verb = 'follow_up'
          AND metadata->>'holder' IS NOT DISTINCT FROM $3`,
      [f.tenantId, postId, holder],
    );
    facts.lastFollowUpAt = last.rows[0]?.at ? new Date(last.rows[0].at).toISOString() : null;
  }
  if (guards.has("required_to_send") || guards.has("handoff_checks_pass_or_send_anyway")) {
    facts.handoff = {
      platforms: f.engagement.platforms ?? [],
      hashtagSets: Array.isArray(f.engagement.hashtag_strategy?.sets) ? f.engagement.hashtag_strategy.sets : [],
      readyBy: f.cycle?.ready_by ?? null,
      timeZone: config.reportsTz || undefined,
    };
  }
  return facts;
}

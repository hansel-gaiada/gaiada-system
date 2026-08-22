// SMM-26 — the `smm-agent-content-brief` flow (design addendum's own SMM-26 row; smm-design.md
// §10's automation-flows table named it "WS8 agent goal: draft next week's posts + imagery within
// credits", amended by the addendum to drop image gen entirely — D-17, no generative backend
// exists). "Brief in, drafts out, nothing published": one call, one engagement, one client's own
// brand corpus, N idea posts each with a caption-drafted variant per connected+enabled network —
// EVERY write is a draft row, exactly like SMM-19's `draftPostIdeas`/`draftPostVariant` already are.
//
// ── WHY THIS IS A NEW FILE, NOT A THIRD CONTROLLER METHOD STRUNG TOGETHER FROM THE OTHER TWO ──────
// `dispatch.ts`/`reply-dispatch.ts` already establish the idiom this module uses for a capability
// with real orchestration: the controller validates the request shape and calls authorize(), the
// domain file does the DB/AI orchestration and returns a discriminated result, and the controller
// translates that result into an HTTP response. Cerbos `authorize()` is called ONLY from the
// controller (criterion 1: "every capability is an McpToolDef with the SAME authorize() call" — the
// controller is the one place that call lives in this whole module); this file calls it nowhere.
//
// ── REUSES SMM-19's OWN PATH, OPENS NO SECOND ROUTE ────────────────────────────────────────────────
// `ai-drafts.ts` (buildIdeaPrompt/parseIdeaDraft, buildCaptionPrompt/parseCaptionDraft,
// applyHashtagStrategy), `gateway-client.ts` (completeViaGateway — the ONLY egress to ai-gateway-go),
// `knowledge-client.ts` (queryBrandKnowledge — the ONLY egress to WS8 knowledge). Nothing here calls
// a vendor SDK or a second gateway/knowledge endpoint.
//
// ── THE MODULE GUC (recurring defect class #1) ─────────────────────────────────────────────────────
// Every transaction below self-declares via `declareSocialModuleScope`, the SAME convention every
// other standalone (non-controller) file in this module uses (dispatch.ts, reply-dispatch.ts,
// inbox-sync-job.ts, inbox-triage-job.ts, usage-ledger.ts) rather than relying on a caller-supplied
// `{modules:['social']}` option it cannot guarantee.
//
// ── NO INVENTED NUMBER: the idea count is the ENGAGEMENT'S OWN `tool_scope.posting.cadencePerWeek`,
// never a hardcoded default — the same "no invented number" discipline `inbox-sync-job.ts`'s lookback
// window and `inbox-triage-job.ts`'s spike knobs are held to, applied here to "how many ideas is one
// content brief worth" instead of a rate limit.
//
// ── VARIANT IDEMPOTENCY: existence, not a caller-supplied id ───────────────────────────────────────
// Idea posts are idempotent via the SAME caller-supplied `ids` array `draftPostIdeas` already
// supports. Variants have no equivalent caller-supplied id (an N-ideas x M-accounts request would
// need to expose one id per pairing, which is more surface than this flow needs) — idempotency
// instead rests on checking whether a variant ALREADY EXISTS for (postId, accountId) before ever
// calling the gateway or writing a row: a retried call skips both the AI call and the write for a
// pairing already drafted, the same "repeat call touches nothing" idempotency contract this module's
// other create-tools already give.
//
// ── A SELF-IMPOSED CALL-VOLUME CAP, NOT A VENDOR LIMIT ─────────────────────────────────────────────
// `config.social.contentBrief.maxVariantsPerCall` bounds how many (idea, account) pairings ONE call
// will actually draft — an N-ideas x M-enabled-networks request has no natural ceiling otherwise, and
// this is OUR OWN gateway-call/latency budget for one synchronous request, never a claimed
// LinkedIn/YouTube/ai-gateway-go rate limit (the same "self-imposed safety valve" idiom
// `inboxPull.maxPostsPerAccountPerRun`/`triage.maxThreadsPerTenantPerRun` already use).
//
// ── NEVER A SILENT $0 (defect class #4) ────────────────────────────────────────────────────────────
// `estimateCostUsd` is computed BEFORE a variant is written, exactly like `createVariant`'s own
// discipline — an unpriced X pairing is skipped and counted (`unpriced_network`), never written as a
// free variant.
//
// ── THE CROSS-CLIENT LEAK TEST'S OWN PROPERTY, RESTATED FOR THIS FILE ──────────────────────────────
// This function is scoped to ONE engagement (and so, by construction, one client) per call — it never
// receives a second engagement's rows as a parameter and holds no shared, cross-call state (no
// module-level cache, no memo). `content-brief.test.ts`'s leak test drives TWO engagements under
// DIFFERENT clients through this SAME function, back to back, against one shared fake gateway/
// knowledge transcript, and asserts neither call's prompts ever contain the other client's marker —
// proving a future refactor that adds batching/caching across calls has not silently started sharing
// prompt context between two clients.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";
import { declareSocialModuleScope } from "./module-scope";
import { validateVariant, estimateCostUsd, isNetwork, type Network, type QuotaSnapshot } from "./media-rules";
import { resolveXPricing } from "./usage-ledger";
import { variantArgsSha256 } from "./canonical-args";
import { completeViaGateway } from "./gateway-client";
import { queryBrandKnowledge } from "./knowledge-client";
import {
  buildIdeaPrompt, parseIdeaDraft, buildCaptionPrompt, parseCaptionDraft,
  MAX_KNOWLEDGE_HITS, MAX_IDEA_COUNT, type HashtagStrategy,
} from "./ai-drafts";
import { DEFAULT_TOOL_SCOPE } from "./index";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface ContentBriefOptions {
  /** The campaign goal/topic — mirrors `draftPostIdeas`'s own `campaignGoal`. */
  brief?: string;
  campaignId?: string;
  /** Explicit override; defaults to the engagement's OWN `tool_scope.posting.cadencePerWeek`. */
  count?: number;
  /** Idempotency keys for the created idea posts, matching the RESOLVED count — same contract as
   *  `draftPostIdeas`'s `ids`. */
  ids?: string[];
  /** Explicit subset of accounts to draft variants for. Defaults to every CONNECTED account whose
   *  network the engagement has enabled (`tool_scope.networks`). */
  accountIds?: string[];
}

export interface ContentBriefVariantResult {
  postId: string;
  variantId: string;
  accountId: string;
  network: string;
  created: boolean;
  draftedVia: "ai" | "fallback" | "existing";
}
export interface ContentBriefIdeaResult {
  id: string;
  created: boolean;
  title: string;
  brief: string;
  variants: ContentBriefVariantResult[];
}
export type ContentBriefResult =
  | { kind: "not_found" }
  | { kind: "refuse"; reason: string }
  | {
      kind: "ok";
      ideas: ContentBriefIdeaResult[];
      draftedVia: "ai" | "fallback";
      groundedOn: string[];
      accountsConsidered: number;
      variantsSkipped: { unpriced_network: number; call_volume_cap: number };
    };

interface EngagementBriefRow {
  clientId: string;
  name: string;
  toolScope: Record<string, Record<string, unknown>>;
  tone: Record<string, unknown>;
  hashtagStrategy: HashtagStrategy;
}

async function loadEngagementBrief(c: PoolClient, engagementId: string): Promise<EngagementBriefRow | null> {
  const { rows } = await c.query<EngagementBriefRow>(
    `SELECT e.client_id AS "clientId", e.name, e.tool_scope AS "toolScope",
            COALESCE(b.tone, '{}'::jsonb) AS tone, COALESCE(b.hashtag_strategy, '{}'::jsonb) AS "hashtagStrategy"
       FROM social_engagements e
       LEFT JOIN social_brand_profiles b ON b.client_id = e.client_id AND b.tenant_id = e.tenant_id AND b.deleted_at IS NULL
      WHERE e.id = $1 AND e.deleted_at IS NULL`,
    [engagementId],
  );
  return rows[0] ?? null;
}

interface ConnectedAccountRow {
  id: string;
  network: string;
  quota: QuotaSnapshot;
}

async function loadConnectedAccounts(c: PoolClient, tenantId: string, clientId: string): Promise<ConnectedAccountRow[]> {
  const { rows } = await c.query<ConnectedAccountRow>(
    `SELECT id, network, quota FROM social_accounts
      WHERE tenant_id = $1 AND client_id = $2 AND status = 'connected' AND deleted_at IS NULL`,
    [tenantId, clientId],
  );
  return rows;
}

async function loadAccountsByIds(c: PoolClient, tenantId: string, clientId: string, accountIds: string[]): Promise<ConnectedAccountRow[] | null> {
  const { rows } = await c.query<ConnectedAccountRow>(
    `SELECT id, network, quota FROM social_accounts
      WHERE tenant_id = $1 AND client_id = $2 AND status = 'connected' AND deleted_at IS NULL
        AND id = ANY($3::uuid[])`,
    [tenantId, clientId, accountIds],
  );
  if (rows.length !== accountIds.length) return null; // at least one id was unknown/cross-client/not connected
  return rows;
}

/** The recent-posts grounding facts `draftPostIdeas` already gathers — same query, same limit. */
async function loadRecentPosts(c: PoolClient, engagementId: string): Promise<Array<{ title: string; brief: string | null }>> {
  const { rows } = await c.query<{ title: string; brief: string | null }>(
    `SELECT title, brief FROM social_posts WHERE engagement_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`,
    [engagementId],
  );
  return rows;
}

async function existingVariantId(c: PoolClient, postId: string, accountId: string): Promise<string | null> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM social_post_variants WHERE post_id = $1 AND account_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [postId, accountId],
  );
  return rows[0]?.id ?? null;
}

/** Draft one (idea, account) pairing's variant. NEVER throws for a gateway hiccup — same fail-soft
 *  contract `draftPostVariantCaption` gives (falls back to a deterministic caption). Returns `null`
 *  (never writes) when the network's cost cannot be honestly computed (defect class #4) — the
 *  caller counts that as `unpriced_network`, never a silent $0. */
async function draftAndInsertVariant(
  c: PoolClient,
  args: {
    tenantId: string; postId: string; accountId: string; network: Network; quota: QuotaSnapshot;
    engagementName: string; ideaBrief: string; tone: Record<string, unknown>; hashtagStrategy: HashtagStrategy;
    knowledgeHits: Array<{ sourceRef: string; text: string }>; cloudPolish: boolean;
  },
): Promise<{ variantId: string; draftedVia: "ai" | "fallback" } | null> {
  const facts = {
    network: args.network, engagementName: args.engagementName, postBrief: args.ideaBrief,
    existingBody: "", tone: args.tone, hashtagStrategy: args.hashtagStrategy, knowledgeHits: args.knowledgeHits,
  };
  const prompt = buildCaptionPrompt(facts);
  let raw: string | null = null;
  try {
    raw = (await completeViaGateway(prompt, args.cloudPolish ? { provider: "claude" } : undefined)).text;
  } catch {
    raw = null; // fail-soft — same contract as draftPostVariantCaption
  }
  const { draft, draftedVia } = parseCaptionDraft(raw, facts);
  const shape = { body: draft.body, firstComment: draft.firstComment, media: [] as never[], settings: {} as Record<string, unknown>, scheduledAt: null };

  const estimate = estimateCostUsd(args.network, shape, resolveXPricing());
  if (!estimate.ok) return null; // unpriced_network — see file header, never a silent $0

  const validation = validateVariant(args.network, shape, args.quota);
  const variantId = newId();
  const argsSha256 = variantArgsSha256({
    tenantId: args.tenantId, id: variantId, accountId: args.accountId, body: shape.body,
    firstComment: shape.firstComment, media: shape.media, settings: shape.settings, scheduledAt: null,
  });
  await c.query(
    `INSERT INTO social_post_variants
       (id, tenant_id, post_id, account_id, body, first_comment, media, settings, validation,
        args_sha256, scheduled_at, estimated_cost_usd, origin_site)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12)`,
    [
      variantId, args.tenantId, args.postId, args.accountId, shape.body, shape.firstComment,
      JSON.stringify(shape.media), JSON.stringify(shape.settings), JSON.stringify(validation),
      argsSha256, estimate.costUsd, config.originSite,
    ],
  );
  return { variantId, draftedVia };
}

/** The whole flow: ONE engagement, ONE client's own brand corpus, N idea posts + their per-network
 *  draft variants. Every write is `status='idea'`/a fresh draft variant — nothing here can dispatch,
 *  publish or send (see file header). `principalUserId` grounds the WS8 RAG call in the CALLER's own
 *  authorized-tenant-set (knowledge-client.ts's own contract) — `null` degrades to ungrounded
 *  drafting (queryBrandKnowledge's own existing fail-soft contract), never a crash. */
export async function runContentBrief(
  tenantId: string, engagementId: string, principalUserId: string | null, opts: ContentBriefOptions,
): Promise<ContentBriefResult> {
  const eng = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadEngagementBrief(c, engagementId);
  });
  if (!eng) return { kind: "not_found" };

  // Absence means the DEFAULT (true) — same semantic `mergeScope`'s DEFAULT_TOOL_SCOPE merge gives;
  // only an EXPLICIT false disables.
  const draftingOn = (eng.toolScope.ai as { drafting?: unknown } | undefined)?.drafting !== false;
  if (!draftingOn) return { kind: "refuse", reason: "ai_drafting_disabled" };
  const cloudPolish = (eng.toolScope.ai as { cloudPolish?: unknown } | undefined)?.cloudPolish === true;

  const cadence = (eng.toolScope.posting as { cadencePerWeek?: unknown } | undefined)?.cadencePerWeek;
  const defaultCount = typeof cadence === "number" && Number.isFinite(cadence) ? Math.floor(cadence) : DEFAULT_TOOL_SCOPE.posting.cadencePerWeek;
  const count = opts.count ?? defaultCount;
  if (!Number.isInteger(count) || count < 1 || count > MAX_IDEA_COUNT) return { kind: "refuse", reason: "invalid_count" };
  if (opts.ids !== undefined) {
    if (opts.ids.length !== count) return { kind: "refuse", reason: "invalid_ids" };
    if (opts.ids.some((id) => !UUID_RE.test(id))) return { kind: "refuse", reason: "invalid_id" };
  }

  // Target accounts — explicit subset (validated: every id must resolve, be connected, and belong to
  // THIS engagement's own client — never trust a cross-client id) or every connected account whose
  // network this engagement has enabled. Resolved BEFORE any gateway call, same "know the shape of
  // the work before spending a call on it" discipline `getPublisherStatus`'s header describes.
  const accounts = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    if (opts.accountIds !== undefined) return loadAccountsByIds(c, tenantId, eng.clientId, opts.accountIds);
    const connected = await loadConnectedAccounts(c, tenantId, eng.clientId);
    const networks = (eng.toolScope.networks ?? {}) as Record<string, unknown>;
    return connected.filter((a) => networks[a.network] === true);
  });
  if (accounts === null) return { kind: "refuse", reason: "unknown_account" };
  // Narrowed by hand (not `.filter(isNetwork-on-a-field)`, which does not narrow the ARRAY's own
  // element type through a field access) — `network` is a free-text column at rest; every write past
  // this point needs the literal `Network` union, not a re-widened string.
  const targetAccounts: Array<{ id: string; network: Network; quota: QuotaSnapshot }> = [];
  for (const a of accounts) {
    if (isNetwork(a.network)) targetAccounts.push({ id: a.id, network: a.network, quota: a.quota });
  }

  const recentPosts = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadRecentPosts(c, engagementId);
  });

  const ideaKnowledgeHits = await queryBrandKnowledge(
    principalUserId, tenantId, eng.clientId, opts.brief || "content ideas", MAX_KNOWLEDGE_HITS,
  );
  const ideaFacts = {
    engagementName: eng.name, campaignGoal: opts.brief ?? null, recentPosts,
    knowledgeHits: ideaKnowledgeHits.map((h) => ({ sourceRef: h.sourceRef, text: h.text })), count,
  };
  let rawIdeas: string | null = null;
  try {
    rawIdeas = (await completeViaGateway(buildIdeaPrompt(ideaFacts), cloudPolish ? { provider: "claude" } : undefined)).text;
  } catch {
    rawIdeas = null;
  }
  const { ideas, draftedVia } = parseIdeaDraft(rawIdeas, ideaFacts);

  // Ideas, source='agent' — an HONEST attribution distinct from `draftPostIdeas`'s own source='ai'
  // (a human asked the AI to draft): nobody prompted THIS particular idea directly, an automation/
  // agent principal's own content-brief call did. 0105's own `social_posts.source` CHECK admits
  // 'agent' precisely for this (createPost's own tool description names it), and it has sat unused
  // until this ticket.
  const created = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const out: Array<{ id: string; created: boolean; title: string; brief: string }> = [];
    for (let i = 0; i < ideas.length; i++) {
      const id = opts.ids?.[i] ?? newId();
      const ins = await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, campaign_id, title, brief, source, status, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,'agent','idea',$7) ON CONFLICT (id) DO NOTHING`,
        [id, tenantId, engagementId, opts.campaignId ?? null, ideas[i].title, ideas[i].brief, config.originSite],
      );
      const isNew = (ins.rowCount ?? 0) > 0;
      if (isNew) await emitEvent(c, tenantId, "social_post", id, "social.post.idea_drafted", { title: ideas[i].title, source: "agent" });
      out.push({ id, created: isNew, title: ideas[i].title, brief: ideas[i].brief });
    }
    return out;
  });

  // ── variants: idempotent per (idea, account), capped at the self-imposed call-volume valve ──────
  const maxVariants = config.social.contentBrief.maxVariantsPerCall;
  let variantBudget = maxVariants;
  let unpriced = 0;
  let capped = 0;
  const ideaResults: ContentBriefIdeaResult[] = [];

  for (const idea of created) {
    const variants: ContentBriefVariantResult[] = [];
    for (const account of targetAccounts) {
      const existing = await withTenants([tenantId], async (c) => {
        await declareSocialModuleScope(c);
        return existingVariantId(c, idea.id, account.id);
      });
      if (existing) {
        variants.push({ postId: idea.id, variantId: existing, accountId: account.id, network: account.network, created: false, draftedVia: "existing" });
        continue;
      }
      if (variantBudget <= 0) {
        capped += 1;
        continue;
      }
      variantBudget -= 1;

      // Fresh, per-pairing RAG grounding — never the idea-generation batch's own hits reused here,
      // matching draftPostVariantCaption's own per-item lookup (this is the property that stops a
      // future edit turning this loop into one prompt spanning multiple ideas/accounts).
      const variantKnowledgeHits = await queryBrandKnowledge(
        principalUserId, tenantId, eng.clientId, idea.brief || eng.name, MAX_KNOWLEDGE_HITS,
      );
      const result = await withTenants([tenantId], async (c) => {
        await declareSocialModuleScope(c);
        return draftAndInsertVariant(c, {
          tenantId, postId: idea.id, accountId: account.id, network: account.network, quota: account.quota,
          engagementName: eng.name, ideaBrief: idea.brief, tone: eng.tone, hashtagStrategy: eng.hashtagStrategy,
          knowledgeHits: variantKnowledgeHits.map((h) => ({ sourceRef: h.sourceRef, text: h.text })),
          cloudPolish,
        });
      });
      if (result === null) {
        unpriced += 1;
        continue;
      }
      // No emitEvent here, deliberately: `createVariant` (the endpoint this mirrors for the variant
      // half) emits nothing either — a variant's own creation carries no event type in this module
      // today, only `writeActivity` (the controller's job, once this function returns). Inventing one
      // here would be a schema addition this ticket was not asked for.
      variants.push({ postId: idea.id, variantId: result.variantId, accountId: account.id, network: account.network, created: true, draftedVia: result.draftedVia });
    }
    ideaResults.push({ ...idea, variants });
  }

  return {
    kind: "ok",
    ideas: ideaResults,
    draftedVia,
    groundedOn: ideaKnowledgeHits.map((h) => h.sourceRef),
    accountsConsidered: targetAccounts.length,
    variantsSkipped: { unpriced_network: unpriced, call_volume_cap: capped },
  };
}

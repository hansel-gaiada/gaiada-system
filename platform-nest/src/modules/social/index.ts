// Social-media ('social') module contract — SMM-02.
//
// Design: docs/blueprints/smm-design.md §04/§07/§09, BINDING amendments in
// docs/blueprints/smm-design-addendum-2026-08-12.md (§A2 D-14/D-15/D-17/D-18/D-19).
// Schema: migrations/0105_module_social.sql. IAM registration: 0106 + cerbos/policies/resource_social_*.yaml.
//
// The ROUTES live in SocialController; this object carries the registry/rollup metadata the engine,
// the registry and the hub's tool-def aggregation consume — the same split hrModule/searchModule use.
//
// ── WHAT THIS TICKET DELIBERATELY DOES NOT DECLARE ──────────────────────────────────────────────
// Only the surfaces SMM-02 actually builds are named here. The publish/inbox/report/ledger tools
// arrive with the tickets that implement them (SMM-09/17/22/23), because a declared MCP tool whose
// endpoint does not exist is a lie the hub will happily publish to every agent in the estate — the
// "frontend-first drift" failure class, pointed at automation instead of a console.
//
// Every rollupProvider.compute() below runs under
// `withTenants([tenantId], fn, {modules:['social']})` (rollups/engine.ts's per-module invocation),
// so the third wall (app_module_allowed('social'), 0105) is open for its duration — plain SELECTs
// against social_* tables just work. These are REAL queries against tables 0105 created; they read
// zero rows until the write paths land, exactly as searchModule's did.
import { config } from "../../config";
import type { ModuleContract, RollupProvider } from "../contract";
// SMM-10 — the publish gate's dispatch endpoint. `SOCIAL_PUBLISH_TOOL_CLASSIFICATION` is the pinned
// `{write:true, impact:'high'}` constant `core/approval-executables.ts`'s SMM-09 section already
// documents as THE D14 gate; declaring the tool from it (never retyping the two literals) is what
// this ticket's own AC requires. `social.publishPostMetered` stays undeclared and barred — see the
// module contract's own header for why a declared tool needs a real endpoint before it exists here.
import { SOCIAL_PUBLISH_TOOL, SOCIAL_PUBLISH_TOOL_CLASSIFICATION } from "./publish-precondition";
// SMM-13 — event handlers for social post notifications and mail routing
// SMM-31 — the client-review stage's own two events, same routing table
import {
  handlePostDispatched, handlePostPublished, handlePostFailed,
  handleClientReviewRequested, handleClientReviewDecided,
} from "./event-handlers";

const socialRollups: RollupProvider = {
  metrics: [
    { metricKey: "social.engagements.active", description: "Active social-media engagements", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "social.accounts.connected", description: "Client social accounts currently connected", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "social.posts.published.month", description: "Post variants published this month", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "social.approvals.pending", description: "Post variants awaiting publish approval", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "social.inbox.open", description: "Open engagement-inbox threads", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "social.usage_cost.month", description: "Metered social spend this month (USD, minor units)", unit: "money_minor", isMonetary: true, aggregationRule: "sum" },
  ],
  compute: async (client, _tenantId, period) => {
    const active = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM social_engagements WHERE deleted_at IS NULL AND status = 'active'`,
    );
    const connected = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM social_accounts WHERE deleted_at IS NULL AND status = 'connected'`,
    );
    const published = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM social_post_variants
        WHERE deleted_at IS NULL AND status = 'published'
          AND date_trunc('month', published_at) = date_trunc('month', $1::date)`,
      [period],
    );
    // "Awaiting a human" — the number the department head actually needs. `in_review` only: a
    // 'draft' is nobody's queue yet, and an 'approved' one has already had its decision.
    const pending = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM social_post_variants WHERE deleted_at IS NULL AND status = 'in_review'`,
    );
    const inboxOpen = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM social_inbox_threads WHERE deleted_at IS NULL AND status = 'open'`,
    );
    // STATUS-BLIND ON PURPOSE, stated so no future reader "fixes" it: this includes `failed` rows.
    // A metered call that bought nothing is still a cost, and this figure feeds the exec money
    // rollup — the one surface least able to sanity-check an under-reported number. The same
    // standing note search_provider_calls' own rollup carries.
    const spend = await client.query<{ n: string }>(
      `SELECT COALESCE(sum(cost_usd), 0) AS n FROM social_usage_ledger
        WHERE date_trunc('month', created_at) = date_trunc('month', $1::date)`,
      [period],
    );
    return [
      { metricKey: "social.engagements.active", numerator: Number(active.rows[0].n) },
      { metricKey: "social.accounts.connected", numerator: Number(connected.rows[0].n) },
      { metricKey: "social.posts.published.month", numerator: Number(published.rows[0].n) },
      { metricKey: "social.approvals.pending", numerator: Number(pending.rows[0].n) },
      { metricKey: "social.inbox.open", numerator: Number(inboxOpen.rows[0].n) },
      // the ledger is numeric(12,6) USD; rollups carry money in MINOR units (cents).
      { metricKey: "social.usage_cost.month", numerator: Math.round(Number(spend.rows[0].n) * 100), currency: "USD" },
    ];
  },
};

export const socialModule: ModuleContract = {
  key: "social",
  // Registered AT WRITE TIME. searchModule's own header records this as its repeated bug (0047 was
  // omitted from that array and had to be fixed after the fact); it is cheap to not repeat.
  migrations: [
    "0105_module_social.sql", "0106_iam_social_permissions.sql",
    // SMM-36 — inbox retention purge markers + state-law CHECKs; registered at write time.
    "0113_social_inbox_retention.sql",
    // SMM-10 — D-22's creator-info snapshot columns on social_post_variants; registered at write time.
    "0114_social_creator_info_snapshot.sql",
    // SMM-39 — `uploaded_media` column (already-uploaded engine media refs, kept out of args_sha256).
    "0118_social_variant_uploaded_media.sql",
  ],
  // Dotted keys, matching class='grantable' catalog rows (0106). `validateModulePermissions()`
  // refuses boot if any of these is uncatalogued — which is why 0106 lands before this module is
  // registered, not after. Only the keys THIS ticket's surfaces use are declared; the rest of the
  // 35 social.* catalog keys arrive with the tickets that build their endpoints.
  permissions: [
    { key: "social.engagement.read", description: "View social-media engagements and their brand-voice profile" },
    { key: "social.engagement.create", description: "Create a social-media engagement for a client" },
    { key: "social.engagement.update", description: "Edit a social-media engagement and its brand-voice profile" },
    { key: "social.engagement.delete", description: "Delete a social-media engagement" },
    { key: "social.engagement.set_scope", description: "Set an engagement's tool scope and metered budget" },
    // SMM-08 — the composer surface. `social.post.submit` and `.publish` are deliberately still
    // ABSENT: submit arrives with the WS4 wiring and publish with the D14 gate (SMM-09). Declaring
    // a permission before the endpoint that honours it exists is how a role gets granted reach
    // nothing enforces.
    { key: "social.post.read", description: "View the content calendar, posts and per-network variants" },
    { key: "social.post.create", description: "Create a social post and its per-network variants" },
    { key: "social.post.update", description: "Edit a social post, its variants, media and schedule" },
    { key: "social.post.delete", description: "Delete an unpublished social post or variant" },
    { key: "social.post.import_native", description: "Record a post published by hand in the network's own app" },
    // SMM-05 — the publisher seam. Three keys for three endpoints, and no more: `social.post.publish`
    // is still ABSENT because SMM-09 owns the publish gate and this ticket builds no publish path.
    // `connect` gates the org mapping (the act that makes every future publish on that client
    // possible — the same reasoning resource_social_account.yaml gives for it being manager-tier),
    // `update` gates the registry sync (it writes metadata, it does not authorize a connection),
    // and `read` gates the registry + publisher-status reads.
    { key: "social.account.read", description: "View the social connector registry: connection status, quota and health" },
    { key: "social.account.connect", description: "Bind a client to a publisher organization so its accounts can be connected" },
    { key: "social.account.update", description: "Refresh connector-registry state from the publisher" },
    // SMM-10 — the dispatch endpoint's own gate. Already a catalog row + Cerbos action (0106 /
    // resource_social_post.yaml, manager-tier) from SMM-30's forward-looking seed; this is the
    // first ticket to actually declare it on the module contract, because it is the first ticket
    // whose endpoint honours it.
    { key: "social.post.publish", description: "Decide that approved content is published to a client's live social account." },
    // SMM-31 (D-16) — the STAFF side of the client-review stage. Already catalog rows + Cerbos
    // actions (0106 / resource_social_client_review.yaml) from SMM-30's forward-looking seed; this
    // is the first ticket whose endpoints (`social.controller.ts`'s client-review trio) honour them.
    // The CLIENT's own decision rides `portal.approve_post` — a `portal.*` key, not `social.*`, so it
    // is never declared here (portal is core, not a registered module).
    { key: "social.client_review.read", description: "View client sign-off state on social posts" },
    { key: "social.client_review.request", description: "Send a social post to the client for sign-off" },
    { key: "social.client_review.withdraw", description: "Withdraw a pending client sign-off request" },
  ],
  customFieldTargets: ["social_engagement", "social_campaign", "social_post"],
  // Agentic-bar criterion 1 (tool parity): everything this ticket's UI can do is reachable as a
  // tool with the SAME authorization — the controller is one client of the capability, not its
  // definition. Reads are minAssurance 'low'; `setScope` is the money-and-blast-radius dial, so it
  // is write + impact 'medium' and therefore SUSPENDS into WS4 for an automation principal (the
  // D14 gate). Creating an engagement is impact 'low': it is an empty container until a scope and
  // an account are attached, and both of those are separately gated.
  mcpTools: [
    {
      name: "social.listEngagements",
      description: "List social-media engagements for a company, with their status and metered budget.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/social/engagements",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          clientId: { type: "string", description: "Optional: only this client's engagements." },
          status: { type: "string", enum: ["draft", "active", "paused", "closed"], description: "Optional status filter." },
        },
        required: ["tenantId"],
      },
    },
    {
      name: "social.getEngagementScope",
      description:
        "Read one engagement's tool scope: which networks may publish, the posting cadence, inbox "
        + "SLA, AI toggles, and the monthly metered budget. This is what every other social "
        + "capability consults before it does anything.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/social/engagements/:engagementId/scope",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          engagementId: { type: "string", description: "The engagement." },
        },
        required: ["tenantId", "engagementId"],
      },
    },
    {
      name: "social.createEngagement",
      description:
        "Create a social-media engagement for a client. Idempotent: pass a stable `id` and a repeat "
        + "call returns the existing engagement instead of creating a second one.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/social/engagements",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          clientId: { type: "string", description: "The client this engagement serves." },
          name: { type: "string", description: "Engagement name." },
          id: { type: "string", description: "Optional caller-supplied uuid — the idempotency key for a retry." },
          projectId: { type: "string", description: "Optional PM project to tie time and deliverables to." },
        },
        required: ["tenantId", "clientId", "name"],
      },
    },
    {
      name: "social.setEngagementScope",
      description:
        "Set an engagement's tool scope and monthly metered budget. This decides which networks may "
        + "publish and how much may be spent, so it is impact-gated: an automation principal calling "
        + "it is suspended for human approval rather than applied.",
      minAssurance: "low",
      write: true,
      // 'medium', not 'high': it changes what is POSSIBLE, it does not itself put anything in
      // public. Publishing is the 'high' surface, and it arrives with SMM-09.
      impact: "medium",
      method: "PATCH",
      pathTemplate: "/api/:tenantId/modules/social/engagements/:engagementId/scope",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          engagementId: { type: "string", description: "The engagement." },
          toolScope: {
            type: "object",
            description:
              "Partial scope to merge, e.g. {\"networks\":{\"instagram\":true},\"inbox\":{\"slaMinutes\":240}}. "
              + "Merged one level deep, so a partial group does not erase its siblings.",
          },
          usageBudgetUsd: { type: "number", description: "Monthly metered cap in USD." },
        },
        required: ["tenantId", "engagementId"],
      },
    },
    {
      name: "social.listPosts",
      description:
        "List social posts for a company with their per-network variant roll-up: status, schedule, "
        + "published URL and metered cost. This is the content calendar as data.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/social/posts",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          engagementId: { type: "string", description: "Optional: only this engagement's posts." },
          status: { type: "string", description: "Optional status filter (idea|draft|in_review|approved|scheduled|publishing|published|partially_published|failed|archived)." },
        },
        required: ["tenantId"],
      },
    },
    {
      name: "social.createPost",
      description:
        "Create a social post (the master idea; per-network content goes on its variants). "
        + "Idempotent: pass a stable `id` and a repeat call returns the existing post. Creating a "
        + "post publishes NOTHING — it cannot reach a live account without a variant, a validation "
        + "pass and a human approval.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/social/posts",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          engagementId: { type: "string", description: "The engagement this post belongs to." },
          title: { type: "string", description: "Internal working title." },
          brief: { type: "string", description: "The idea or angle the variants execute." },
          source: { type: "string", enum: ["human", "ai", "agent"], description: "Who originated it. An agent drafting posts should pass 'agent'." },
          campaignId: { type: "string", description: "Optional campaign to group under." },
          scheduledAt: { type: "string", description: "Plan-level slot, ISO 8601." },
          id: { type: "string", description: "Optional caller-supplied uuid — the idempotency key for a retry." },
        },
        required: ["tenantId", "engagementId", "title"],
      },
    },
    {
      name: "social.addPostVariant",
      description:
        "Add or replace the per-network content for one account on a post. Returns the validation "
        + "verdict (media rules, quota, per-network settings) and the estimated metered cost, so a "
        + "caller learns immediately whether what it wrote is publishable.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/social/posts/:postId/variants",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          postId: { type: "string", description: "The master post." },
          accountId: { type: "string", description: "The connected account this variant targets. The network is taken from the registry, never from the caller." },
          body: { type: "string", description: "Caption/copy for this network." },
          firstComment: { type: "string", description: "First comment (Instagram-style hashtag placement); refused on networks without one." },
          media: { type: "array", description: "Ordered [{fileId, kind:'image'|'video', alt}].", items: { type: "object" } },
          settings: { type: "object", description: "Network-specific, e.g. {\"igType\":\"reel\"}, {\"tiktokMode\":\"inbox\"}." },
          scheduledAt: { type: "string", description: "Per-network offset from the master slot, ISO 8601." },
          id: { type: "string", description: "Optional caller-supplied uuid — the idempotency key." },
        },
        required: ["tenantId", "postId", "accountId"],
      },
    },
    {
      name: "social.validateVariant",
      description:
        "Re-check one variant against its network's media rules, hashtag limits, per-network "
        + "settings and the account's live posting quota, and return the metered cost estimate. "
        + "Computed fresh, so it answers 'is this publishable NOW', not 'was it when last saved'.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/social/variants/:variantId/validation",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          variantId: { type: "string", description: "The variant to validate." },
        },
        required: ["tenantId", "variantId"],
      },
    },
    {
      name: "social.importNativePost",
      description:
        "Record a post that was published BY HAND in the network's own app, for calendar "
        + "completeness. Bookkeeping only: it describes something already public and can never "
        + "carry an approval or dispatch anything.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/social/posts/import-native",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          engagementId: { type: "string", description: "The engagement." },
          accountId: { type: "string", description: "The account it was posted from." },
          title: { type: "string", description: "Internal working title." },
          body: { type: "string", description: "What was actually posted." },
          publishedUrl: { type: "string", description: "Link to the live post." },
          publishedAt: { type: "string", description: "When it went out, ISO 8601." },
          id: { type: "string", description: "Optional caller-supplied uuid — the idempotency key." },
        },
        required: ["tenantId", "engagementId", "accountId", "title"],
      },
    },
    // ── SMM-19: brand-voice RAG + AI drafting ──────────────────────────────────────────────────
    // Tool parity with the same three HTTP endpoints, the SAME authorize() calls (update/update/
    // create — no new permission was declared for these: every one of them writes exactly the kind
    // of thing its existing permission already governs, and a NEW key with no OTHER endpoint behind
    // it is the reach-nobody-reviewed trap this file's own header warns about). All three are
    // write+impact:'low': every one persists a DRAFT row (or a knowledge pointer) and none of them
    // can reach a live network — the D19 "impact-classed" criterion here is "this is not the
    // publish surface", not "an automation principal is suspended".
    {
      name: "social.ingestBrandCorpus",
      description:
        "Ingest approved past posts and brand guidelines into this engagement's brand-voice "
        + "knowledge corpus (WS8-owned, tenant+client ACL'd — design D-13). Re-ingesting REPLACES "
        + "the prior chunks for this client. Every drafting call below grounds itself in this corpus.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/social/engagements/:engagementId/brand-corpus/ingest",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          engagementId: { type: "string", description: "The engagement whose client's corpus this feeds." },
          chunks: {
            type: "array", items: { type: "string" },
            description: "Approved past captions / brand guideline text, one chunk per entry.",
          },
        },
        required: ["tenantId", "engagementId", "chunks"],
      },
    },
    {
      name: "social.draftPostVariant",
      description:
        "Draft (or re-draft) one network variant's caption and hashtags via the brand-voice RAG. "
        + "Honours the brand's hashtag_strategy and the network's own caps (media-rules.ts) — never "
        + "a second set of limits. Hermes by default, Claude when the engagement's "
        + "tool_scope.ai.cloudPolish is on. Writes a DRAFT row and re-runs the same validation/hash "
        + "state law a human edit would trigger — it never dispatches. Refuses "
        + "'image_generation_unavailable' if asked to generate an image: no such backend exists.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/social/posts/:postId/variants/:variantId/draft-caption",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          postId: { type: "string", description: "The master post." },
          variantId: { type: "string", description: "The per-network variant to draft into. Must be in an editable state (draft/in_review/approved), never a native import." },
        },
        required: ["tenantId", "postId", "variantId"],
      },
    },
    {
      name: "social.draftPostIdeas",
      description:
        "Draft N content-idea posts (title + brief) for an engagement, grounded in the brand corpus "
        + "and the engagement's own recent posts. Writes rows with status='idea', source='ai' — "
        + "never dispatches. Idempotent: pass an `ids` array matching `count` and a retry updates "
        + "nothing rather than creating a second set.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/social/posts/draft-ideas",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          engagementId: { type: "string", description: "The engagement to draft ideas for." },
          campaignId: { type: "string", description: "Optional campaign to group the ideas under." },
          campaignGoal: { type: "string", description: "Optional goal/angle to steer the ideas." },
          count: { type: "number", description: "How many ideas to draft (default 3, max 10)." },
          ids: { type: "array", items: { type: "string" }, description: "Optional caller-supplied uuids, one per idea, matching `count` — the idempotency key for a retry." },
        },
        required: ["tenantId", "engagementId"],
      },
    },
    // ── SMM-05: the publisher seam ─────────────────────────────────────────────────────────────
    // Tool parity for all three endpoints, same authorize() calls. Note there is no publish tool
    // here and there must not be one until SMM-09 — a declared MCP tool whose endpoint does not
    // exist is a lie the hub publishes to every agent in the estate, and a publish tool is the
    // worst possible instance of it.
    // SMM-09 — the publish GATE's read surface (agentic criterion 1: tool parity, same authorize()
    // call as the endpoint).
    //
    // ⚠ CORRECTED 2026-08-20 (SMM-24). This comment used to say `social.publishPost` was NOT
    // declared here, which was true when SMM-09 wrote it and stopped being true ~40 lines below when
    // SMM-10 built the dispatch endpoint and declared the tool. The stale text cost real time: a
    // later seat grepped for the literal `"social.publishPost"`, found nothing (the declaration uses
    // the `SOCIAL_PUBLISH_TOOL` constant, deliberately, so the name is never retyped), read this
    // comment, and reported the tool as undeclared. A comment that contradicts the code 40 lines
    // away is worse than no comment.
    //
    // `social.publishPostMetered` genuinely IS barred outright and must never appear here — that
    // half was and remains correct.
    {
      name: "social.checkPublishPreconditions",
      description:
        "Dry-run the publish gate for one post variant: would an approved publish of it actually "
        + "execute right now, and if not, which gate stopped it and why. Runs the EXACT server-side "
        + "precondition the D14 approval executor runs (scope → quota → hash → unconsumed → budget → "
        + "creator-info), so the answer cannot drift from the one execution will give. Publishes "
        + "nothing, consumes no approval and makes no network call. `reason` is a snake_case token "
        + "(e.g. 'network_not_in_scope', 'quota_exhausted', 'args_hash_mismatch', "
        + "'already_dispatched', 'budget_exceeded', 'creator_info_unverified') — the SAME vocabulary "
        + "that lands in an approval's execution_error after the 'precondition_failed: ' prefix.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/social/variants/:variantId/publish-preconditions",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          variantId: { type: "string", description: "The per-network post variant to check." },
        },
        required: ["tenantId", "variantId"],
      },
    },
    // ── SMM-10: THE PUBLISH GATE'S DISPATCH ENDPOINT ───────────────────────────────────────────
    // The tool `core/approval-executables.ts`'s SMM-09 section left undeclared, naming exactly this
    // ticket as the one that builds the endpoint. Declared from the pinned classification constant
    // — never `write: true, impact: "high"` retyped — because those two literals ARE the D14 gate
    // (`write && impact !== 'low'` is what suspends an automation/agent call into WS4,
    // mcp-hub/src/policy.ts) and a typo here is a silent authz downgrade.
    //
    // Reachable in practice only through the D14 executor's re-drive: `social.publishPost` is
    // `write:true, impact:'high'`, so an automation/agent principal calling it directly always
    // suspends (mints no grant), and the dispatch handler (`social.controller.ts#dispatchPublish`,
    // wired to `modules/social/dispatch.ts`) re-runs the FULL precondition — hash, scope, budget,
    // creator-info — a second time under its own lock before ever calling the publisher, so a call
    // that somehow reached this path stale still refuses rather than posting.
    {
      name: SOCIAL_PUBLISH_TOOL,
      description:
        "Publish an APPROVED post variant to its live social account. Never called directly by a "
        + "human or an agent in the ordinary flow — it is registered in the D14 executable-approval "
        + "registry and executes automatically the moment a human approves the suspended write. "
        + "Re-verifies scope, quota, the args hash, single-use consumption, the metered budget and "
        + "(for TikTok) creator consent immediately before dispatching, and refuses with the SAME "
        + "typed token vocabulary `social.checkPublishPreconditions` reports.",
      minAssurance: "low",
      // Spread, never retyped — see this block's own comment above for why.
      ...SOCIAL_PUBLISH_TOOL_CLASSIFICATION,
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/social/variants/:variantId/publish",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          variantId: { type: "string", description: "The approved post variant to publish." },
          accountId: { type: "string", description: "The target account (attribution only — the account actually dispatched to comes from the live row, never the caller)." },
          body: { type: "string" },
          firstComment: { type: "string" },
          media: { type: "array", items: { type: "object" } },
          settings: { type: "object" },
          scheduledAt: { type: "string" },
        },
        required: ["tenantId", "variantId"],
      },
    },
    {
      name: "social.listAccounts",
      description:
        "List a company's social connector registry: each connected account's network, handle, connection "
        + "status, live posting quota, resolved capabilities and health. Reads only our own registry — "
        + "it never calls the publisher, so it keeps answering while the publisher is unreachable. "
        + "`capabilities.unsupported` says WHY a capability is false: 'network' (the platform has no "
        + "such API and never will), 'driver' (our publishing engine cannot reach it yet), or "
        + "'unverified' (nobody has researched it — treated as unavailable).",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/social/accounts",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          clientId: { type: "string", description: "Optional: only this client's accounts." },
          status: { type: "string", enum: ["pending", "connected", "expiring", "expired", "error", "disconnected"], description: "Optional status filter." },
        },
        required: ["tenantId"],
      },
    },
    {
      name: "social.getPublisherStatus",
      description:
        "What the publishing engine can do in THIS deployment: whether a driver is configured, which "
        + "networks are enabled at the deployment level, the driver's capability set, whether an "
        + "engagement inbox surface exists at all, whether live quota probing is available, and each "
        + "publisher org with its account count and last sync time. Makes no network call, so it is "
        + "the surface to consult BEFORE spending a call on a capability that may be absent.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/social/publisher/status",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string", description: "Company id (route scope)." } },
        required: ["tenantId"],
      },
    },
    {
      name: "social.provisionPublisherOrg",
      description:
        "Map a client to a publisher organization — the mapping every future publish for that client "
        + "rides on. IDEMPOTENT: repeating it with the same org reference returns the existing "
        + "mapping. The organization itself is created by an operator on the publisher host (there is "
        + "no API for it); this records the mapping and verifies the pair answers. Re-pointing a "
        + "client at a DIFFERENT org is refused ('org_conflict'), as is an org already mapped to "
        + "another client — one organization can never serve two clients.",
      minAssurance: "low",
      write: true,
      // 'medium', not 'low': this is the tenant-mapping row whose corruption is the wrong-account-
      // publish nightmare, so an automation principal is SUSPENDED into WS4 rather than applied. It
      // is not 'high' — it puts nothing in public by itself; publishing is the 'high' surface and it
      // arrives with SMM-09.
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/social/publisher-orgs",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          clientId: { type: "string", description: "The client this organization serves." },
          publisherOrgRef: { type: "string", description: "The opaque organization id from the publishing engine." },
          apiKeyRef: { type: "string", description: "Alias naming which server-side API key serves this org (default: 'default'). Never a key — aliases only." },
          driver: { type: "string", enum: ["postiz", "mixpost"], description: "Publishing engine driver. Defaults to the deployment's configured driver." },
        },
        required: ["tenantId", "clientId", "publisherOrgRef"],
      },
    },
    {
      name: "social.syncConnectorRegistry",
      description:
        "Refresh one client's connector registry from the publishing engine: connection status, live "
        + "posting quota, resolved capabilities and health. Mirrors STATE ABOUT each connection and "
        + "never a token. If the publisher is unreachable this refuses and changes NOTHING — an "
        + "outage is never recorded as 'every account disconnected'.",
      minAssurance: "low",
      write: true,
      // 'low': it writes only mirrored state about connections that already exist, and can put
      // nothing in public. Its blast radius is a stale row, not a post.
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/social/publisher-orgs/:clientId/sync",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          clientId: { type: "string", description: "The client whose registry to refresh." },
        },
        required: ["tenantId", "clientId"],
      },
    },
  ],
  rollupProviders: [socialRollups],
  // D-18: the console is the department template's reserved "Publish" craft group, under the
  // `social-media` dept slug. The pages themselves are SMM-11; this entry is what makes the module
  // visible in the module catalog meanwhile.
  uiManifest: [{ label: "Social Media", path: "/departments/social-media" }],
  // SMM-13 — event handlers for social post notifications and mail routing
  eventHandlers: {
    "social.post.dispatched": handlePostDispatched,
    "social.post.published": handlePostPublished,
    "social.post.failed": handlePostFailed,
    // SMM-31 — both ride the already-drained "social_post_variant" stream (see event-handlers.ts's
    // own header for why that is deliberate, not an oversight).
    "social.client_review.requested": handleClientReviewRequested,
    "social.client_review.decided": handleClientReviewDecided,
  },
};

/** The scope shape every social capability reads. Exported so the controller, the tests and every
 *  later ticket agree on ONE definition rather than three hand-copied ones.
 *
 *  Two defaults are owner decisions, not preferences:
 *   - `networks.x` is FALSE. X is the only metered network, and keeping it off is what makes the
 *     publish path $0 and therefore eligible for the D14 executable-approval registry, whose
 *     doctrine permanently bars money-spending tools (addendum D-14).
 *   - `ai.imageGen` is FALSE and currently INERT. There is no generative-image backend in the
 *     estate yet — ai-gateway-go exposes /complete, /media and /embed only, and render-gateway-go
 *     is 0.0.0 (addendum D-17). Enabling it is accepted and stored, but the write answers with a
 *     named warning rather than pretending a capability exists. */
export const DEFAULT_TOOL_SCOPE = {
  networks: {
    instagram: false, facebook: false, tiktok: false, linkedin: false, x: false,
    youtube: false, threads: false, pinterest: false, bluesky: false, mastodon: false,
  },
  posting: { cadencePerWeek: 3, requiresClientOk: false },
  inbox: { enabled: false, slaMinutes: 240, dm: false },
  ai: { drafting: true, cloudPolish: false, imageGen: false },
  reporting: { cadence: "monthly" },
} as const;

/** The default monthly metered cap, in USD. Deliberately small: the stop-loss is meant to be hit by
 *  a runaway loop long before it is hit by real work, and raising it is a deliberate, audited act
 *  (`social.ledger.admin`, which sits with company_admin — one tier above the department head who
 *  wants to spend it). */
export const DEFAULT_USAGE_BUDGET_USD = Number(config.social?.defaultUsageBudgetUsd ?? 10);

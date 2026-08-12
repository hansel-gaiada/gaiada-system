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
  migrations: ["0105_module_social.sql", "0106_iam_social_permissions.sql"],
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
  ],
  rollupProviders: [socialRollups],
  // D-18: the console is the department template's reserved "Publish" craft group, under the
  // `social-media` dept slug. The pages themselves are SMM-11; this entry is what makes the module
  // visible in the module catalog meanwhile.
  uiManifest: [{ label: "Social Media", path: "/departments/social-media" }],
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

// PRV-02 — the `webdev` ModuleContract shell.
//
// Design: docs/blueprints/provision-erp-seam-design.md §06 ("NEW `webdev` ModuleContract shell …
// this program creates the shell, WSK-19 extends it").
//
// ── WHY A MODULE SHELL EXISTS NOW WHEN IT DID NOT BEFORE ────────────────────────────────────────
// Every webdev surface shipped so far (pipeline runs/stages/gates, scope sign-offs, the portal, and
// `webdev_change_requests` from 0088) lives in `src/core/` and takes the PLAIN tenant wall, because
// the CLIENT PORTAL writes several of them and portal controllers declare no module scope — a third
// wall there reads zero rows, silently (the WD-23A-1 lesson, spelled out in 0088's header).
//
// `webdev_provisioned_sites` (0090) is the first webdev table where that exception does not apply:
// nothing portal- or core-scoped touches it, its writer is the staff/automation path, and so it took
// the THIRD WALL (`app_module_allowed('webdev')`). A third-walled table needs a module to be a member
// of — that is what this file is. It is a SHELL: routes live in `WebdevController`, exactly the split
// `modules/hr/index.ts` and `modules/assistant/index.ts` already use.
//
// ── COORDINATION NOTE (in the design, repeated here on purpose) ─────────────────────────────────
// WSK-19 (webdesk contract snapshots) also extends this shell. Whoever merges second rebases; the
// shape to preserve is "one `webdevModule` object, additive arrays", never two competing modules
// with the same key (`registerModule` throws on a duplicate key, which is the good failure).
//
// ── LEFT DELIBERATELY EMPTY ─────────────────────────────────────────────────────────────────────
//  - `rollupProviders`: no governed metric is specified for provisioning in the design. A count of
//    live sites is plausible later; an empty-metric provider now is dead weight in
//    syncMetricDefinitions().
//  - `customFieldTargets`: a mirror row has no custom-field surface — its columns mirror a far side
//    we do not control, and a custom field on it would be an ERP fact masquerading as a provider fact.
//  - `eventHandlers`: this module PRODUCES `webdev.site.*` events (bell notifications + the hourly
//    reconcile flow's wake-ups); it reacts to none. The `prd_sign` -> propose beat is an n8n flow
//    calling the hub tool (PRV-03), not an in-process handler — that indirection is what puts the WS4
//    approval between the event and the write.
import type { McpToolDef, ModuleContract } from "../contract";

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// M5-W2d — the writers' room review flow's MCP tools (docs/plans/2026-10-11-m5-writers-room-design.md §4.3, §8). Same BFF routes
// as the UI (`webdesk-content.controller.ts` → `webdesk-editorial.service.ts`, FRONTEND-BFF-CONTRACT §27), so a review action
// behaves identically under a human, n8n and an agent. The authority is the caller's Cerbos decision (the two-phase gate), not
// the tool.
//
// IMPACT CLASSES (§4.3, exact): submit, withdraw, requestChanges, assign, comment, resolveComment are `low`; seoSignoff, approve and
// setPolicy are `medium`; board and history are reads. None is `high`: none changes what a production key sees (publishing is
// still `webdesk.content.requestPublish` -> a WS4 approval).
//
// Cerbos REFUSES automation and bot principals for approve and SEO sign-off (kind in [automation, bot]; approve also contributors),
// and refuses an approver who created the version being approved, for every principal. These are human judgements: an agent
// can ASK for one but never record one. `medium` write tools SUSPEND an unattended caller for a human approval; like
// `webdesk.content.preview` they are NOT D14 executables (a recorded sign-off must be made by the human at the screen, not
// re-driven), pending the owner's call, so approving the suspension re-drives nothing.
//
// `setPolicy` is a PATCH here because the hub's method union has no PUT; the BFF accepts both on the same path. The board
// is a GET: the hub sends only PATH args for a GET, so it returns WebDesk's default first page with no filters (the hub
// limitation recorded on the content tools above).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const EDITORIAL_SITE_PROPS = { tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" } } as const;
const EDITORIAL_ITEM_PROPS = { ...EDITORIAL_SITE_PROPS, itemId: { type: "string" } } as const;
const EDITORIAL_ITEM_REQUIRED = ["tenantId", "tenantSlug", "siteId", "itemId"] as const;
const CONTENT_BASE = "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId";
const VERSION_PROP = { type: "integer", minimum: 1, description: "The version the action is about: it must equal the version submitted for review (else a typed 409 review-version-mismatch)." } as const;

export const WEBDESK_EDITORIAL_REVIEW_TOOLS: McpToolDef[] = [
  {
    name: "webdesk.editorial.submit",
    description:
      "Submit an item's `version` (its head) for editorial review. The collection must have review turned on (typed 409 review-not-enabled otherwise). "
      + "Tells the editors in scope and the publishers. LOW write: only the review state changes; nothing goes live.",
    minAssurance: "low", write: true, impact: "low", method: "POST",
    pathTemplate: `${CONTENT_BASE}/items/:itemId/editorial/submit`,
    inputSchema: { type: "object", properties: { ...EDITORIAL_ITEM_PROPS, version: VERSION_PROP }, required: [...EDITORIAL_ITEM_REQUIRED, "version"] },
  },
  {
    name: "webdesk.editorial.withdraw",
    description: "Withdraw an item from review, back to a draft. LOW write.",
    minAssurance: "low", write: true, impact: "low", method: "POST",
    pathTemplate: `${CONTENT_BASE}/items/:itemId/editorial/withdraw`,
    inputSchema: { type: "object", properties: { ...EDITORIAL_ITEM_PROPS }, required: [...EDITORIAL_ITEM_REQUIRED] },
  },
  {
    name: "webdesk.editorial.requestChanges",
    description:
      "Send an item under review back to its author with a `note` (what to change). Tells the author. LOW write. Needs the editor or publisher role on the item's collection.",
    minAssurance: "low", write: true, impact: "low", method: "POST",
    pathTemplate: `${CONTENT_BASE}/items/:itemId/editorial/request-changes`,
    inputSchema: {
      type: "object",
      properties: { ...EDITORIAL_ITEM_PROPS, version: VERSION_PROP, note: { type: "string", minLength: 1, maxLength: 2000 } },
      required: [...EDITORIAL_ITEM_REQUIRED, "version", "note"],
    },
  },
  {
    name: "webdesk.editorial.assign",
    description:
      "Assign an item: its author (`authorSub`, a user id), `dueAt`, `plannedPublishAt` (ISO-8601, null clears) and `briefRef`. At least one. LOW write.",
    minAssurance: "low", write: true, impact: "low", method: "POST",
    pathTemplate: `${CONTENT_BASE}/items/:itemId/editorial/assign`,
    inputSchema: {
      type: "object",
      properties: {
        ...EDITORIAL_ITEM_PROPS,
        authorSub: { type: "string" },
        dueAt: { type: ["string", "null"] }, plannedPublishAt: { type: ["string", "null"] }, briefRef: { type: ["string", "null"] },
      },
      required: [...EDITORIAL_ITEM_REQUIRED],
    },
  },
  {
    name: "webdesk.editorial.comment",
    description:
      "Comment on an item under review. `anchor` (optional) is a JSON pointer into the version's fields (\"\" = the whole item). LOW write.",
    minAssurance: "low", write: true, impact: "low", method: "POST",
    pathTemplate: `${CONTENT_BASE}/items/:itemId/editorial/comments`,
    inputSchema: {
      type: "object",
      properties: { ...EDITORIAL_ITEM_PROPS, version: VERSION_PROP, body: { type: "string", minLength: 1, maxLength: 4000 }, anchor: { type: "string", maxLength: 512 } },
      required: [...EDITORIAL_ITEM_REQUIRED, "version", "body"],
    },
  },
  {
    name: "webdesk.editorial.resolveComment",
    description: "Mark a review comment resolved. LOW write.",
    minAssurance: "low", write: true, impact: "low", method: "POST",
    pathTemplate: `${CONTENT_BASE}/items/:itemId/editorial/comments/:commentId/resolve`,
    inputSchema: { type: "object", properties: { ...EDITORIAL_ITEM_PROPS, commentId: { type: "string" } }, required: [...EDITORIAL_ITEM_REQUIRED, "commentId"] },
  },
  {
    name: "webdesk.editorial.seoSignoff",
    description:
      "Record the SEO/AEO sign-off of the submitted version (a recorded check; the approval after it is four-eyed). MEDIUM write. "
      + "Cerbos refuses automation and bot principals: an agent cannot record a sign-off, only a human can; an unattended caller is suspended for human approval.",
    minAssurance: "low", write: true, impact: "medium", method: "POST",
    pathTemplate: `${CONTENT_BASE}/items/:itemId/editorial/seo-signoff`,
    inputSchema: { type: "object", properties: { ...EDITORIAL_ITEM_PROPS, version: VERSION_PROP }, required: [...EDITORIAL_ITEM_REQUIRED, "version"] },
  },
  {
    name: "webdesk.editorial.approve",
    description:
      "Approve the version submitted for review. MEDIUM write; tells the author. Maker != checker: Cerbos refuses an approver who created the version "
      + "being approved (platform_admin included). Cerbos also refuses automation, bot and contributor principals: an agent cannot approve, only a human can; "
      + "an unattended caller is suspended for human approval. Approving does not publish: that is `webdesk.content.requestPublish`.",
    minAssurance: "low", write: true, impact: "medium", method: "POST",
    pathTemplate: `${CONTENT_BASE}/items/:itemId/editorial/approve`,
    inputSchema: { type: "object", properties: { ...EDITORIAL_ITEM_PROPS, version: VERSION_PROP }, required: [...EDITORIAL_ITEM_REQUIRED, "version"] },
  },
  {
    name: "webdesk.editorial.setPolicy",
    description:
      "Turn editorial review on or off for one collection (`reviewRequired`), and whether an SEO sign-off is also required (`seoSignoffRequired`, only with review on). "
      + "MEDIUM write; needs `webdesk_collection:manage_editorial` (the publisher tier, company admins). With review off, content flows as before.",
    minAssurance: "low", write: true, impact: "medium", method: "PATCH",
    pathTemplate: `${CONTENT_BASE}/collections/:collectionKey/editorial-policy`,
    inputSchema: {
      type: "object",
      properties: { ...EDITORIAL_SITE_PROPS, collectionKey: { type: "string" }, reviewRequired: { type: "boolean" }, seoSignoffRequired: { type: "boolean" } },
      required: ["tenantId", "tenantSlug", "siteId", "collectionKey", "reviewRequired"],
    },
  },
  {
    name: "webdesk.editorial.board",
    description:
      "The site's review board: items in the editorial flow with their review state, per-state counts (staff only) and each collection's policy. "
      + "A caller with a scoped writers' room grant sees only the collections and locales its grant reaches.",
    minAssurance: "low", method: "GET",
    pathTemplate: `${CONTENT_BASE}/editorial/board`,
    inputSchema: { type: "object", properties: { ...EDITORIAL_SITE_PROPS }, required: ["tenantId", "tenantSlug", "siteId"] },
  },
  {
    name: "webdesk.editorial.history",
    description: "One item's review record: its state, who submitted, signed off and approved which version, the event history and the comments.",
    minAssurance: "low", method: "GET",
    pathTemplate: `${CONTENT_BASE}/items/:itemId/editorial`,
    inputSchema: { type: "object", properties: { ...EDITORIAL_ITEM_PROPS }, required: [...EDITORIAL_ITEM_REQUIRED] },
  },
];

export const webdevModule: ModuleContract = {
  key: "webdev",
  migrations: [
    // WSK-12 (coordinator, additive)
    "0090_webdev_provisioned_sites.sql",
    "202608261440_webdev_zoneb_event_log.sql",
    // WSK-19 (additive): the rail's Zone A end — the contract-snapshot mirror table + its IAM.
    "202608271500_webdev_contract_snapshots.sql",
    "202608271510_iam_webdev_contract_snapshot_permissions.sql",
    // WSK-D28 / §08 (additive): widens the framework CHECK to admit the canonical kind vocabulary
    // (astro/node/wp) alongside the original vite/nextjs — one quarter of the four-point refusal lift.
    "202609011230_webdev_provisioned_sites_framework_widen.sql",
    // WSK-47 (additive): IAM seed for the two WebDesk editorial kinds (no DDL).
    "202610101420_iam_webdesk_content_permissions.sql",
    // WSK-43b (additive): IAM seed for the WebDesk media library kind (no DDL).
    "202610111030_iam_webdesk_media_permissions.sql",
    // M5-W1a (additive): the writers' room roles + review permissions (IAM seed, no DDL).
    "202610111443_iam_writers_room_roles.sql",
    // WSK-60 (additive): the staging rebuild ledger + the stale-staging marker (third wall).
    "202610101730_webdev_site_builds.sql",
  ],
  // IAM-01d migration: all 3 CLEAN (renamed) — the catalog's kind is `webdev_provisioned_site`
  // (singular resource, per N1), so the dotted key is `webdev.provisioned_site.*`.
  permissions: [
    { key: "webdev.provisioned_site.read", description: "Read provisioned sites (repo + hosting) for this company" },
    { key: "webdev.provisioned_site.provision", description: "Provision a site and repo for a delivery run" },
    { key: "webdev.provisioned_site.reconcile", description: "Re-poll a provisioned site's status from its provider" },
    // WSK-19 (additive): the one-rail contract-snapshot mirror (design §06).
    { key: "webdev.contract_snapshot.read", description: "View pinned WebDesk contract snapshots (the Contract card)" },
    { key: "webdev.contract_snapshot.refresh", description: "Fetch, hash-verify and record a new WebDesk contract snapshot" },
    // WSK-47 (additive): the WebDesk editorial kinds (write-plane design §7). publish/schedule are
    // reachable only at decide() of an approved WS4 row (approvalId + maker != checker in Cerbos).
    { key: "webdev.webdesk_content_item.read", description: "View WebDesk editorial items" },
    { key: "webdev.webdesk_content_item.create", description: "Create a WebDesk editorial item (a draft)" },
    { key: "webdev.webdesk_content_item.update", description: "Edit a WebDesk editorial item's draft" },
    { key: "webdev.webdesk_content_item.request_publish", description: "Request publication of WebDesk items (files a WS4 approval)" },
    { key: "webdev.webdesk_content_item.publish", description: "Publish WebDesk items at decide() of an approved WS4 row" },
    { key: "webdev.webdesk_content_item.schedule", description: "Schedule a WebDesk publish at decide() of an approved WS4 row" },
    { key: "webdev.webdesk_content_item.unpublish", description: "Take a published WebDesk item down" },
    { key: "webdev.webdesk_content_item.delete", description: "Delete a WebDesk editorial item" },
    { key: "webdev.webdesk_collection.read", description: "View a WebDesk site's collections and compositions" },
    { key: "webdev.webdesk_collection.apply_schema", description: "Apply a composition change to a WebDesk collection" },
    // WSK-43b (additive): the WebDesk media library (m3 plan "WSK-43 · The media library"). No approval gate: all MEDIUM or lower.
    { key: "webdev.webdesk_media_asset.read", description: "View a WebDesk site's media library and where each asset is used" },
    { key: "webdev.webdesk_media_asset.upload", description: "Start a WebDesk media upload (mints a single-use upload token)" },
    { key: "webdev.webdesk_media_asset.update", description: "Edit a WebDesk media asset's title, alt text and tags" },
    { key: "webdev.webdesk_media_asset.delete", description: "Delete a WebDesk media asset that no content uses" },
    // M5-W1a (additive): the writers' room review flow (docs/plans/2026-10-11-m5-writers-room-design.md §2). The
    // four scoped roles that also reach these are attribute-gated grants with no bundle; approve is maker != checker.
    { key: "webdev.webdesk_content_item.submit", description: "Submit a WebDesk item for editorial review, or withdraw it" },
    { key: "webdev.webdesk_content_item.comment", description: "Comment on a WebDesk item under review" },
    { key: "webdev.webdesk_content_item.request_changes", description: "Send a WebDesk item under review back to its author" },
    { key: "webdev.webdesk_content_item.seo_signoff", description: "Record the SEO/AEO sign-off of a WebDesk item's submitted version" },
    { key: "webdev.webdesk_content_item.approve", description: "Approve a WebDesk item's submitted version (maker != checker)" },
    { key: "webdev.webdesk_content_item.assign", description: "Assign a WebDesk item to an author with dates and a brief" },
    { key: "webdev.webdesk_collection.manage_editorial", description: "Grant writers' room roles on a WebDesk site and set a collection's review policy" },
  ],
  customFieldTargets: [],
  mcpTools: [
    // WSK-12 (coordinator, additive): the wd-zoneb-intake bridge consumer. n8n may not
    // touch a database directly (automation backbone rule), so the dedup insert is
    // reachable only as an MCP tool.
    {
      name: "webdev.recordZoneBEvent",
      description: "Idempotent record of a Zone B (WebDesk) signed fact - the wd-zoneb-intake bridge consumer.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/zoneb-events",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, eventId: { type: "string" }, kind: { type: "string" },
          originSite: { type: "string" }, occurredAt: { type: "string" }, data: { type: "object" },
        },
        required: ["tenantId", "eventId", "kind", "originSite", "occurredAt", "data"],
      },
    },
    {
      name: "webdev.provisionSite",
      description:
        "Provision a website + GitHub repo for a delivery run (template-only, one per run). Creates "
        + "PUBLIC infrastructure: a private repo under the agency org, a server directory, an nginx "
        + "vhost and a TLS certificate. Idempotent per run — a repeat call returns the existing site.",
      // `low`, not `verified`: the D14 IMPACT gate is what protects this call, not an assurance
      // floor. An automation principal calling a `write` + `impact: "medium"` tool is SUSPENDED into
      // WS4 and a human decides; raising minAssurance instead would only change WHO can propose,
      // not whether a human approves. (Standing D14 lesson: a registry entry is not a gate, and
      // `low` never suspends on its own — the impact value is what does.)
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/provision",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          runId: { type: "string", description: "Pipeline run this site belongs to." },
          framework: {
            type: "string",
            enum: ["vite", "nextjs", "astro", "node", "wp"],
            description:
              "Site framework. `vite`/`astro` deliver the `static` kind, `nextjs`/`node` deliver "
              + "`fullstack` (astro/node are the canonical §08 aliases for the same templates vite/"
              + "nextjs already build). `wp` is the canonical WordPress kind — accepted here, but the "
              + "`provision` driver cannot build it yet (static-export-only tool) and rejects it "
              + "loudly as `provider_rejected`; a future webdesk provider (D-P2) is what actually "
              + "delivers it. Default vite.",
          },
          slug: {
            type: "string",
            description:
              "Optional override for the derived project name (^[a-z0-9-]{1,40}$). Defaults to the "
              + "run-title derivation the delivery workflow already uses, which is what makes the "
              + "existing github.repoStatus gate pass unchanged.",
          },
          stack: {
            type: "string",
            description:
              "Optional PRD stack hint, mapped to the §08 kind vocabulary (static/wp/fullstack) and "
              + "the canonical aliases (a/static/vite/astro, b/wp/wordpress, c/fullstack/node/next/"
              + "nextjs). SELECTS `framework` when `framework` was not given explicitly (WSK-D28: "
              + "'stops being a refusal and becomes the selector'). A genuinely UNRECOGNIZED token is "
              + "still refused loudly with `unsupported_stack` — never silently defaulted to static.",
          },
        },
        required: ["tenantId", "runId"],
      },
    },
    // WSK-19 (additive): the rail's Zone A end — MCP entry, WS4-gated for automation principals
    // (impact: "medium" — same reasoning `webdev.provisionSite` states above: `low` assurance never
    // suspends on its own, the `impact` value is what does; a human calling the HTTP endpoint
    // directly is an ordinary console action per design §08's button matrix, not suspended).
    {
      name: "webdev.refreshContract",
      description:
        "Fetch, hash-verify and record a new WebDesk contract snapshot for a site (the one-rail "
        + "mirror, design §06). Refuses loudly on a hash mismatch against Zone B's claim or a "
        + "codegen determinism breach against an already-recorded version.",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/contracts/refresh",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          slug: { type: "string", description: "Zone B (WebDesk) tenant slug to fetch the contract for." },
        },
        required: ["tenantId", "slug"],
      },
    },
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // WSK-31 — the §07 WebDesk control-plane MCP tool set (design docs/blueprints/webdesk-design.md
    // §07/§09), aggregated here per §09's own instruction ("§07 tool table, aggregated via
    // GET /mcp/tool-defs; nothing hub-side hardcoded"). Names, impact classes and gating below are
    // taken VERBATIM from §07's table.
    //
    // EVERY ROUTE BELOW IS AN HONEST STUB — see `webdesk-control.controller.ts`'s own header for
    // the full reasoning. Short version: WSK-23 (the ERP module egress client + BFF into Zone B) is
    // NOT built yet (PROGRESS.md Part D, 2026-08-27: still ⬜), so there is no live channel for any
    // of these commands to actually reach Zone B. The endpoints exist, run the REAL Cerbos + WS4
    // gate, and answer `501 webdesk_control_plane_not_wired` — the same "documented 501" shape
    // WSK-21 already shipped for `site.archive`/`contract.read`. This is deliberately NOT the same
    // as declaring a tool with no `pathTemplate` at all ("informational-only", module-tools.ts's own
    // term): an uncallable tool could never be driven through a real `authorize()`/`authorizeCall()`
    // request, and the whole point of this ticket is to PROVE the WS4 suspend matrix against a real
    // call path, not a mock.
    //
    // IMPACT CLASSES (§07, restated): reads are free. `schema.apply`/`site.provision`/
    // `deploy.staging` are `impact:"medium"` — WS4 for AUTOMATION principals only (mcp-hub's
    // existing `isUnattended` gate, unchanged). `site.promote`/`rollback`/`setDomain`/
    // `key.mint`/`key.rotate`/`key.revoke`/`archive` are `impact:"high"` AND, per §07's explicit
    // "always WS4, every principal class" rule (the blueprint's C-05 rule), are ALSO listed in
    // mcp-hub's new `ALWAYS_WS4_TOOLS` set (`mcp-hub/src/policy.ts`) — the estate's existing
    // `isUnattended`-only impact gate structurally exempts an ATTENDED human caller (deliberately,
    // and for good reason elsewhere: "a human does not need their own approval to do what they just
    // asked for" — see `mcp-hub/src/policy.ts`'s own D14 header). §07 asks for a NARROWER,
    // tool-specific override of exactly that exemption for these seven irreversible commands, not a
    // change to the estate-wide rule — see this ticket's report for the full reasoning and the
    // Cerbos-side mirror in `resource_mcp_tool.yaml`.
    //
    // D14 REGISTRY PAIRING (the standing lesson, restated because it bit WSK-12 on this exact
    // module): every medium/high tool below that a WS4 approval could ever re-drive is registered
    // in BOTH `core/approval-executables.ts` (`registerWebdeskExecutableApprovals`) AND
    // `cerbos/policies/resource_mcp_tool.yaml`'s executable-tool bracket list, in the SAME change.
    // `webdesk.schema.propose` is deliberately in NEITHER — it is `impact:"low"` (draft-only by
    // construction, §07), and a low-impact write never suspends, so it can never reach the registry
    // at all (same reasoning `pm.createTask`/`pm.createDoc`'s own D14-15 section already states).
    {
      name: "webdesk.listSites",
      description:
        "List WebDesk (Zone B) tenants and sites for this company — kind, envs, domains, status. "
        + "LIVE since WSK-59 (Zone B `tenant.list`, filtered to this company). Same answer as webdesk.content.listSites.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/control/sites",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
    {
      name: "webdesk.siteStatus",
      description: "Read one WebDesk site's env/release status. STUB: 501 webdesk_control_plane_not_wired.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/control/sites/:siteId/status",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, siteId: { type: "string" } },
        required: ["tenantId", "siteId"],
      },
    },
    {
      name: "webdesk.listSubmissions",
      description: "List recent form submissions for a WebDesk site (PII-aware). STUB: 501 webdesk_control_plane_not_wired.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/control/sites/:siteId/submissions",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, siteId: { type: "string" } },
        required: ["tenantId", "siteId"],
      },
    },
    {
      name: "webdesk.schema.propose",
      description:
        "AI-drafted composition proposal for a WebDesk tenant's schema — a PROPOSAL object only, "
        + "never applied (§07). LOW write, draft-only by construction; never suspends. STUB: 501 "
        + "webdesk_control_plane_not_wired (the real drafting flow is WSK-32).",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/schema/propose",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, siteId: { type: "string" }, prd: { type: "string" } },
        required: ["tenantId", "siteId"],
      },
    },
    {
      name: "webdesk.schema.apply",
      description:
        "Apply a composition (field definitions) to one collection of a WebDesk site. MEDIUM write — WS4 for "
        + "automation principals (§07). LIVE since WSK-59: Zone B validates the composition (typed 422) and "
        + "refuses a MAJOR vocabulary change (typed 409 contract-major-change).",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/schema/apply",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          tenantSlug: { type: "string" }, siteId: { type: "string" }, collectionKey: { type: "string" },
          schema: { type: "object", description: "The collection's composition." },
        },
        required: ["tenantId", "tenantSlug", "siteId", "collectionKey", "schema"],
      },
    },
    {
      name: "webdesk.site.provision",
      description:
        "Provision a new WebDesk (Zone B) site — Payload tenant + environments. DISTINCT from "
        + "webdev.provisionSite (that tool provisions a Web Dev delivery-pipeline repo+hosting; this "
        + "one provisions a WebDesk content-platform tenant). MEDIUM write — WS4 for automation "
        + "principals (§07). LIVE since WSK-59: adds a site to one of THIS company's WebDesk tenants.",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/sites",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" },
          kind: { type: "string", enum: ["astro", "node", "wp"] }, name: { type: "string" },
        },
        required: ["tenantId", "tenantSlug", "kind", "name"],
      },
    },
    {
      name: "webdesk.deploy.staging",
      description: "Deploy a WebDesk site to staging. MEDIUM write — WS4 for automation principals (§07). STUB: 501 webdesk_control_plane_not_wired.",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/sites/:siteId/deploy/staging",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, siteId: { type: "string" } },
        required: ["tenantId", "siteId"],
      },
    },
    {
      name: "webdesk.site.promote",
      description:
        "Promote a WebDesk site's staging release to production — irreversible-adjacent, public. "
        + "HIGH write — ALWAYS WS4, every principal class incl. an attended human (§07 C-05 rule) + "
        + "§03 Layer-4 assertion. STUB: 501 webdesk_control_plane_not_wired.",
      minAssurance: "low",
      write: true,
      impact: "high",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/sites/:siteId/promote",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, siteId: { type: "string" } },
        required: ["tenantId", "siteId"],
      },
    },
    {
      name: "webdesk.site.rollback",
      description:
        "Roll a WebDesk site's production release back to its previous version. HIGH write — ALWAYS "
        + "WS4, every principal class (§07). STUB: 501 webdesk_control_plane_not_wired.",
      minAssurance: "low",
      write: true,
      impact: "high",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/sites/:siteId/rollback",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, siteId: { type: "string" } },
        required: ["tenantId", "siteId"],
      },
    },
    {
      name: "webdesk.site.setDomain",
      description:
        "Set a WebDesk site's custom domain (DNS/TLS-adjacent, irreversible-adjacent). HIGH write — "
        + "ALWAYS WS4, every principal class (§07). STUB: 501 webdesk_control_plane_not_wired.",
      minAssurance: "low",
      write: true,
      impact: "high",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/sites/:siteId/domain",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, siteId: { type: "string" }, domain: { type: "string" } },
        required: ["tenantId", "siteId", "domain"],
      },
    },
    {
      name: "webdesk.key.mint",
      description:
        "Request a new WebDesk environment API key: files ONE key.mint approval (HIGH, WS4) for one of the site's "
        + "environments and returns {approvalId} (a pending request for the same site, environment and scope is returned, with alreadyPending:true, "
        + "instead of a second one). Nothing is minted until a DIFFERENT authorised user approves it; the plaintext key "
        + "is shown ONCE, in that decide response, and only its hash is kept. HIGH write — ALWAYS WS4, every principal class (§07).",
      minAssurance: "low",
      write: true,
      impact: "high",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/sites/:siteId/keys",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, siteId: { type: "string" }, tenantSlug: { type: "string" },
          envId: { type: "string" }, scope: { type: "string", enum: ["read", "write"] },
        },
        required: ["tenantId", "siteId", "tenantSlug", "envId", "scope"],
      },
    },
    {
      name: "webdesk.key.rotate",
      description: "Rotate a WebDesk environment API key. HIGH write — ALWAYS WS4, every principal class (§07). STUB: 501 webdesk_control_plane_not_wired.",
      minAssurance: "low",
      write: true,
      impact: "high",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/keys/:keyId/rotate",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, keyId: { type: "string" } },
        required: ["tenantId", "keyId"],
      },
    },
    {
      name: "webdesk.key.revoke",
      description: "Revoke a WebDesk environment API key. HIGH write — ALWAYS WS4, every principal class (§07). STUB: 501 webdesk_control_plane_not_wired.",
      minAssurance: "low",
      write: true,
      impact: "high",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/keys/:keyId/revoke",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, keyId: { type: "string" } },
        required: ["tenantId", "keyId"],
      },
    },
    {
      name: "webdesk.site.archive",
      description: "Archive a WebDesk site. HIGH write — ALWAYS WS4, every principal class (§07). STUB: 501 webdesk_control_plane_not_wired.",
      minAssurance: "low",
      write: true,
      impact: "high",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/sites/:siteId/archive",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, siteId: { type: "string" } },
        required: ["tenantId", "siteId"],
      },
    },
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // WSK-59 — the content editor's MCP tools (write-plane design §12 WSK-59). EVERY editor action is a
    // tool, so a capability works identically under a human (the Website workspace), n8n and an agent;
    // the BFF routes behind them are `webdesk-content.controller.ts` (`/api/:tenantId/modules/webdev/content/…`).
    //
    // IMPACT CLASSES. Reads are free. create / update / restoreVersion / requestPublish are `low` writes:
    // each only creates a DRAFT or files an approval, and changes nothing a production key can see (design
    // §3.1). unpublish / delete are `medium`: an unattended caller (n8n or an agent) SUSPENDS into a WS4
    // approval and is re-driven as the ORIGINAL principal on approval (D14); an attended human is not
    // suspended (a takedown must not wait for a second person, WSK-D46). There is deliberately NO publish
    // tool: publish is HIGH for every principal and executes only at decide() of the approval that
    // `webdesk.content.requestPublish` files (WSK-66).
    //
    // D14 PAIRING (the standing lesson): unpublish and delete are registered in BOTH
    // `core/approval-executables.ts` AND `resource_mcp_tool.yaml`'s executable list, in this same change.
    //
    // WSK-46 `webdesk.content.preview` is `medium` (it mints a capability link that exposes a DRAFT) and is NOT on that
    // list, on purpose and pending the owner's call: an attended human runs it (the editor's Preview button is the
    // same BFF route); an unattended caller SUSPENDS, and approving that suspension re-drives nothing (`not_applicable`)
    // because the link is a one-time secret that must not be parked in an approval row. So an agent cannot hold a
    // preview link unattended. Registering it would need `core/approval-executables.ts` + the Cerbos list (not WSK-46's paths).
    //
    // ASSURANCE. `low`, like every other WebDesk tool: the hub mints only `low` for an n8n workflow or a chat-surface
    // agent (principal.ts), and `verified` would lock exactly the unattended callers this program exists for out of
    // the capability. The real authority is the platform's Cerbos decision on the resolved human, not this floor.
    //
    // HUB LIMITATION, reported not worked around: `mcp-hub/src/module-tools.ts` sends only PATH args for a
    // GET (a GET's other args are dropped), so the list tools return Zone B's DEFAULT first page (50) with no
    // filters or cursor, and `getItem` reads the head. `getVersion` reads any one version. A hub change
    // (opt-in `queryParams` on the def) would lift it; it is not in this ticket's paths. `update` is a PATCH
    // here because the hub's method union has no PUT; the BFF accepts both on the same path.
    {
      name: "webdesk.content.listSites",
      description: "List the WebDesk tenants and sites this company can edit (tenant slug, site id, kind, environments).",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites",
      inputSchema: { type: "object", properties: { tenantId: { type: "string", description: "Company id (route scope)." } }, required: ["tenantId"] },
    },
    {
      name: "webdesk.content.listCollections",
      description: "List a site's collections with their compositions (field definitions) and counts (items, live, pending changes).",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/collections",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" } },
        required: ["tenantId", "tenantSlug", "siteId"],
      },
    },
    {
      name: "webdesk.content.listItems",
      description:
        "List items of one collection (id, slug, locale, title, head/published version, state, pending changes), editor order. "
        + "Returns the first page only (hub limitation: no filters or cursor over MCP yet).",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/collections/:collectionKey/items",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, collectionKey: { type: "string" } },
        required: ["tenantId", "tenantSlug", "siteId", "collectionKey"],
      },
    },
    {
      name: "webdesk.content.getItem",
      description: "Read one item at its HEAD (draft) version: fields/blocks/seo, the live version if any, its locale group and lint.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, itemId: { type: "string" } },
        required: ["tenantId", "tenantSlug", "siteId", "itemId"],
      },
    },
    {
      name: "webdesk.content.listVersions",
      description: "List an item's version history, newest first (version, content hash, author id, note).",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/versions",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, itemId: { type: "string" } },
        required: ["tenantId", "tenantSlug", "siteId", "itemId"],
      },
    },
    {
      name: "webdesk.content.getVersion",
      description: "Read one historical version of an item in full (blocks, seo, hash, author, note).",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/versions/:n",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, itemId: { type: "string" },
          n: { type: "integer", minimum: 1, description: "Version number." },
        },
        required: ["tenantId", "tenantSlug", "siteId", "itemId", "n"],
      },
    },
    {
      name: "webdesk.content.listMedia",
      description: "List a site's media library assets (id, key, mime, size, scan status). Same route as `webdesk.media.list`, which supersedes it; now authorised as `webdesk_media_asset:read`.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" } },
        required: ["tenantId", "tenantSlug", "siteId"],
      },
    },
    {
      name: "webdesk.content.create",
      description:
        "Create a DRAFT item in a collection (version 1). Nothing a production key sees changes. `fields` is required when the "
        + "collection's composition declares fields. Typed 409 (slug-taken, twin-locale-taken, singleton-exists) / 422 "
        + "(composition-violation with issues) come back unchanged.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/collections/:collectionKey/items",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, collectionKey: { type: "string" },
          locale: { type: "string" }, slug: { type: "string" },
          twinOf: { type: ["string", "null"], description: "Item id in the same collection and another locale, to join its localization group." },
          fields: { type: "object" }, blocks: { type: "array" }, seo: { type: "object" }, note: { type: "string", maxLength: 500 },
        },
        required: ["tenantId", "tenantSlug", "siteId", "collectionKey", "locale", "slug"],
      },
    },
    {
      name: "webdesk.content.update",
      description:
        "Save a new DRAFT version of an item (full replacement of fields/blocks/seo). `baseVersion` must equal the item's head "
        + "version, else a typed 409 version-conflict. Live content is untouched until a publish is approved.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "PATCH",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, itemId: { type: "string" },
          baseVersion: { type: "integer", minimum: 0 },
          fields: { type: "object" }, blocks: { type: "array" }, seo: { type: "object" }, note: { type: "string", maxLength: 500 },
        },
        required: ["tenantId", "tenantSlug", "siteId", "itemId", "baseVersion"],
      },
    },
    {
      name: "webdesk.content.restoreVersion",
      description: "Create a new DRAFT version from an old version of an item (history is kept). `baseVersion` must equal the head version.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/restore",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, itemId: { type: "string" },
          version: { type: "integer", minimum: 1 }, baseVersion: { type: "integer", minimum: 0 }, note: { type: "string", maxLength: 500 },
        },
        required: ["tenantId", "tenantSlug", "siteId", "itemId", "version", "baseVersion"],
      },
    },
    {
      name: "webdesk.content.requestPublish",
      description:
        "Request publication of 1..1000 item versions: files ONE approval (HIGH, WS4) that a human decides in the Approvals inbox. "
        + "Never publishes anything itself; returns {approvalId}. `publishAt`/`unpublishAt` (ISO) request a scheduled publish/takedown instead.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/publish-requests",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" },
          items: {
            type: "array", minItems: 1, maxItems: 1000,
            items: { type: "object", properties: { itemId: { type: "string" }, version: { type: "integer", minimum: 1 } }, required: ["itemId", "version"] },
          },
          publishAt: { type: ["string", "null"] }, unpublishAt: { type: ["string", "null"] }, note: { type: "string", maxLength: 500 },
        },
        required: ["tenantId", "tenantSlug", "siteId", "items"],
      },
    },
    {
      name: "webdesk.content.unpublish",
      description:
        "Take a published item down from production. MEDIUM write: an unattended caller (agent / n8n) is suspended for human "
        + "approval and re-driven as the original requester. `expectedPublishedVersion` must be the live version (typed 409 otherwise).",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/unpublish",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, itemId: { type: "string" },
          expectedPublishedVersion: { type: "integer", minimum: 1 },
        },
        required: ["tenantId", "tenantSlug", "siteId", "itemId", "expectedPublishedVersion"],
      },
    },
    {
      name: "webdesk.content.delete",
      description:
        "Soft-delete a NON-live item (history is kept; a live item is a typed 409 item-is-live: unpublish it first). MEDIUM write: "
        + "an unattended caller is suspended for human approval and re-driven as the original requester.",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/delete",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, itemId: { type: "string" },
          baseVersion: { type: "integer", minimum: 0 },
        },
        required: ["tenantId", "tenantSlug", "siteId", "itemId", "baseVersion"],
      },
    },
    {
      name: "webdesk.content.preview",
      description:
        "Make a one-time PREVIEW link to an item's DRAFT (its head version, or `version`), opening on the site's own /preview/ page. "
        + "MEDIUM write: the link shows unpublished content to whoever holds it, so an unattended caller (agent / n8n) is suspended for "
        + "human approval, and the link is a secret: share it only with the person who asked. Returns {previewUrl, expiresAt, version}; "
        + "the link expires (about an hour) and is shown once. Typed 409 `preview_not_configured` (the site has no staging address) / "
        + "`preview_page_missing` (the site has no /preview/ page yet) mint nothing.",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/preview",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, itemId: { type: "string" },
          version: { type: "integer", minimum: 1, description: "The version to preview; omit for the head (latest draft)." },
        },
        required: ["tenantId", "tenantSlug", "siteId", "itemId"],
      },
    },
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // WSK-43b — the media library's MCP tools (m3 plan "WSK-43 · The media library"; owner rulings WSK-D53/D54).
    // One tool per action, routed through the SAME BFF handlers as the HTTP routes
    // (`webdesk-content.controller.ts` → `webdesk-media.service.ts`), authorised as the Cerbos kind
    // `webdesk_media_asset`. Names follow the `webdesk.content.*` convention above (dotted, camelCase action).
    //
    // IMPACT CLASSES. `list` and `usage` are reads. `uploadToken`, `update` and `delete` are `medium`, like WebDesk's
    // own impact class for the three commands: an unattended caller (n8n or an agent) SUSPENDS into a WS4 approval
    // (D14), an attended human is not suspended.
    //
    // D14 PAIRING, AND WHY `uploadToken` IS THE ONE MEDIUM TOOL THAT IS NOT PAIRED. `update` and `delete` are
    // registered in BOTH `core/approval-executables.ts` (registerWebdeskMediaExecutableApprovals) AND
    // `resource_mcp_tool.yaml`'s executable list, in this same change, so an approved suspension re-drives as the
    // ORIGINAL principal. `uploadToken` is deliberately in neither: its result is a ONE-TIME SECRET (a bearer upload
    // URL), and a D14 re-drive stores the tool's result text in `automation_approvals.execution_result`, i.e. it
    // would write the plaintext token into a durable table. So an unattended agent/n8n `uploadToken` call suspends
    // and, on approval, does nothing (`not_applicable`): an unattended caller can never obtain a token. The tool
    // exists for an ATTENDED human (whose call is not suspended): returning the upload URL is its whole purpose, the
    // token is single-use, ten minutes, bound to one site, bucket, size cap and set of types, and this tool's
    // result is never ledgered or stored by the ERP (see webdesk-media.service.ts).
    //
    // HUB LIMITATION (same as the content tools): `mcp-hub/src/module-tools.ts` sends only PATH args for a GET, so
    // `list` returns Zone B's default first page with no filters or cursor, and a Zone B problem reaches the agent as
    // the hub's generic "platform … <status>" error: the structured `media-in-use` item list is visible over HTTP
    // (and through `webdesk.media.usage`, which an agent should call before a delete), not in a hub error.
    {
      name: "webdesk.media.list",
      description:
        "List a site's media library assets (id, title, alt, tags, mime, size, dimensions, scan status, URL), newest first. "
        + "Returns the first page only (hub limitation: no filters or cursor over MCP yet). Deleted assets are hidden.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" } },
        required: ["tenantId", "tenantSlug", "siteId"],
      },
    },
    {
      name: "webdesk.media.usage",
      description:
        "Where one media asset is used: the items (live or draft, at most 50) whose content references it, with collection, "
        + "locale, slug and where in the item. An asset with items cannot be deleted (409 media-in-use): call this first.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media/:assetId/usage",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, assetId: { type: "string" } },
        required: ["tenantId", "tenantSlug", "siteId", "assetId"],
      },
    },
    {
      name: "webdesk.media.uploadToken",
      description:
        "Start a media upload: mints a SINGLE-USE upload URL (valid about ten minutes, bound to this site, bucket, size cap and "
        + "allowed types) and returns {uploadUrl, expiresAt, maxBytes, allowedMimes}. POST the raw file bytes to uploadUrl with "
        + "its Content-Type; the bytes go straight to WebDesk, never through the ERP. The URL is a secret: do not log or share it. "
        + "MEDIUM write: an unattended caller (agent / n8n) is suspended and never receives a token.",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media/upload-token",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" },
          bucket: { type: "string", enum: ["media", "video"], description: "The library's public bucket the file goes into." },
          maxBytes: { type: "integer", minimum: 1, description: "Size cap; defaults to and cannot exceed the platform maximum." },
          mime: { description: "Allowed media type(s), a subset of the bucket's allowlist; defaults to the whole list.", oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        },
        required: ["tenantId", "tenantSlug", "siteId", "bucket"],
      },
    },
    {
      name: "webdesk.media.update",
      description:
        "Edit a media asset's metadata. Provide at least one of: `title` (string, or null to clear), `alt` (the COMPLETE locale -> text map; {} clears it), "
        + "`tags` (the COMPLETE list; [] clears it). MEDIUM write: an unattended caller is suspended for human approval and re-driven as the original requester.",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "PATCH",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media/:assetId",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, assetId: { type: "string" },
          title: { type: ["string", "null"], maxLength: 200 },
          alt: { type: "object", additionalProperties: { type: "string", maxLength: 500 } },
          tags: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
        },
        required: ["tenantId", "tenantSlug", "siteId", "assetId"],
      },
    },
    {
      name: "webdesk.media.delete",
      description:
        "Soft-delete a media asset (it leaves the library; the stored file is purged after its retention). REFUSED with 409 media-in-use while any live or "
        + "draft item still uses the asset: call webdesk.media.usage first. MEDIUM write: an unattended caller is suspended for human approval and re-driven as the original requester.",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "DELETE",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media/:assetId",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, assetId: { type: "string" } },
        required: ["tenantId", "tenantSlug", "siteId", "assetId"],
      },
    },
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // M5-W1b — the writers' room grant path (docs/plans/2026-10-11-m5-writers-room-design.md §2.6). Same BFF routes as
    // the UI (`webdesk-editorial-grants.controller.ts`), authorised as Cerbos `webdesk_collection:manage_editorial`.
    //
    // IMPACT CLASSES (design §2.6). `grantRole` is HIGH, like `iam.grantRole`: it WIDENS somebody's authority. `revokeRole`
    // is MEDIUM: a de-escalation cannot escalate anyone, but it can break somebody's day. Both are `write:true`, so an
    // unattended caller (an agent or n8n) SUSPENDS for a human decision; an attended human is not suspended. Both are D14
    // executables (`core/approval-executables.ts` registerWebdeskEditorialExecutableApprovals AND `resource_mcp_tool.yaml`'s
    // executable list, in this same change), so an approved suspension re-drives as the ORIGINAL requester, whose CURRENT
    // standing Cerbos decides again. `listGrants` is a read.
    //
    // ASSURANCE `verified`, like the iam.* grant tools and unlike the content tools: granting authority is not something
    // an unverified chat identity should even be able to file, and nothing here is meant for an n8n workflow.
    {
      name: "webdesk.editorial.listGrants",
      description:
        "List who holds a writers' room role (writer, translator, SEO reviewer, editor) on one WebDesk site, with each grant's collections, locales and expiry.",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/grants",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" } },
        required: ["tenantId", "tenantSlug", "siteId"],
      },
    },
    {
      name: "webdesk.editorial.grantRole",
      description:
        "Grant a writers' room role on ONE WebDesk site to an active employee of this company: webdesk_writer, webdesk_translator, "
        + "webdesk_seo_reviewer or webdesk_editor, scoped to named collections (or allCollections: true) and named locales (or "
        + "allLocales: true). Granting the same role on the same site again REPLACES that site's scope. HIGH write: an unattended "
        + "caller is suspended for human approval. No self-grant; expiresAt (ISO-8601, optional) belongs to the person's grant across sites.",
      minAssurance: "verified",
      write: true,
      impact: "high",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/grants",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" },
          userId: { type: "string" },
          role: { type: "string", enum: ["webdesk_writer", "webdesk_translator", "webdesk_seo_reviewer", "webdesk_editor"] },
          allCollections: { type: "boolean" },
          collections: { type: "array", items: { type: "string" }, description: "Collection keys; omit when allCollections is true." },
          allLocales: { type: "boolean" },
          locales: { type: "array", items: { type: "string" }, description: "Locales; omit when allLocales is true." },
          expiresAt: { type: "string", description: "ISO-8601 instant in the future; omit for a permanent grant." },
        },
        required: ["tenantId", "tenantSlug", "siteId", "userId", "role"],
      },
    },
    {
      name: "webdesk.editorial.revokeRole",
      description:
        "Revoke a writers' room role from a person on ONE WebDesk site (the grant itself goes when it covered no other site). "
        + "MEDIUM write: an unattended caller is suspended for human approval. Revoking what is not held is a no-op (changed: false).",
      minAssurance: "verified",
      write: true,
      impact: "medium",
      method: "DELETE",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/grants/:userId/:role",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" }, userId: { type: "string" },
          role: { type: "string", enum: ["webdesk_writer", "webdesk_translator", "webdesk_seo_reviewer", "webdesk_editor"] },
        },
        required: ["tenantId", "tenantSlug", "siteId", "userId", "role"],
      },
    },
    ...WEBDESK_EDITORIAL_REVIEW_TOOLS,
  ],
  rollupProviders: [],
  uiManifest: [
    { label: "Web Dev", path: "/pipeline" },
  ],
};

/** WSK-31 — the §07 HIGH-impact tool names that always suspend for WS4, regardless of caller
 *  attendance (mirrored verbatim in `mcp-hub/src/policy.ts`'s `ALWAYS_WS4_TOOLS` and in
 *  `resource_mcp_tool.yaml`'s always-WS4 conjunct — drift between the three fails CLOSED, same
 *  discipline the D14-13 grant-lift bracket list already established). Exported so a test can pin
 *  that the module's OWN declared impact classes agree with what the gate actually enforces,
 *  instead of the two lists silently drifting apart. */
export const WEBDESK_ALWAYS_WS4_TOOLS: readonly string[] = [
  "webdesk.site.promote",
  "webdesk.site.rollback",
  "webdesk.site.setDomain",
  "webdesk.key.mint",
  "webdesk.key.rotate",
  "webdesk.key.revoke",
  "webdesk.site.archive",
];

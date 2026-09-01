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
import type { ModuleContract } from "../contract";

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
        "List WebDesk (Zone B) sites for this tenant — kind, envs, domains, status. STUB: WSK-23's "
        + "Zone B egress client has not landed; answers 501 webdesk_control_plane_not_wired.",
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
        "Apply an approved composition change to a WebDesk tenant's schema. MEDIUM write — WS4 for "
        + "automation principals (§07). STUB: 501 webdesk_control_plane_not_wired.",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/schema/apply",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, siteId: { type: "string" }, proposalId: { type: "string" } },
        required: ["tenantId", "siteId"],
      },
    },
    {
      name: "webdesk.site.provision",
      description:
        "Provision a new WebDesk (Zone B) site — Payload tenant + environments. DISTINCT from "
        + "webdev.provisionSite (that tool provisions a Web Dev delivery-pipeline repo+hosting; this "
        + "one provisions a WebDesk content-platform tenant). MEDIUM write — WS4 for automation "
        + "principals (§07). STUB: 501 webdesk_control_plane_not_wired.",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/sites",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, slug: { type: "string" }, kind: { type: "string", enum: ["astro", "node", "wp"] } },
        required: ["tenantId", "slug", "kind"],
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
        "Mint a new WebDesk environment API key (shown once, hash-only at rest). HIGH write — ALWAYS "
        + "WS4, every principal class (§07). STUB: 501 webdesk_control_plane_not_wired.",
      minAssurance: "low",
      write: true,
      impact: "high",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/webdev/control/sites/:siteId/keys",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, siteId: { type: "string" }, scope: { type: "string", enum: ["read", "write"] } },
        required: ["tenantId", "siteId", "scope"],
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

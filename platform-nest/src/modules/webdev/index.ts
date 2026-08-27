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
          framework: { type: "string", enum: ["vite", "nextjs"], description: "Static site framework. Default vite." },
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
              "Optional PRD stack hint. Anything beyond a static export (e.g. WordPress, full-stack) "
              + "is REFUSED with unsupported_stack — never silently downgraded to a static site.",
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
  ],
  rollupProviders: [],
  uiManifest: [
    { label: "Web Dev", path: "/pipeline" },
  ],
};

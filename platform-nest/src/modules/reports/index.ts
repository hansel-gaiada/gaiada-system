// Reports module contract (TR-08). ROUTES (facts recompute) live in ReportsController and are
// registered directly on AppModule (§6.2: `/api/:t/reports/*`, not `/api/:t/modules/reports/*` —
// see reports.controller.ts's header); this object carries the registry/rollup metadata the
// engine + registry + (future) hub tool-def aggregation consume, same split as hrModule/index.ts.
//
// `rollupProviders: [reportRollups]` is what makes `rollups/engine.ts`'s per-module invocation loop
// (`recomputeRollups`) find and run TR-08's provider under the tenant's `reports` module scope —
// registering it here, rather than building a parallel recompute path, is the ticket's explicit
// instruction ("Register through this; do not build a parallel path").
//
// TR-11 — §9.2 names SIX tools for this module; only the two check-in tools below are this
// ticket's scope (`checkin.getToday` / `checkin.submit` — the WA-reply round trip). The other four
// (`reports.getDocument` / `listPeriods` / `getMetrics` / `getCompliance`) are NOT registered here —
// they belong to whichever ticket wires the read surface over MCP, and are not yet registered
// anywhere in the codebase (verified: no other module/file declares them). Do not assume they
// exist. Deliberately NOT exposed at all, per §9.2's own text and the standing ruling: `seal`/
// `amend`/`periods/pin` (exec ceremony) and every appraisal-side tool.
//
// ⚠ minAssurance DEVIATION (documented, not silent): §9.2's literal text gives `checkin.submit`
// `minAssurance: "verified"`. That value is UNREACHABLE at the mcp-hub layer for this exact flow.
// The hub's own `Assurance` enum is `"anonymous" | "low" | "verified"` (mcp-hub/src/principal.ts) —
// a DIFFERENT vocabulary than this file's own `"low" | "verified"` McpToolDef type — and
// `mintPrincipal()` can NEVER mint "verified" from a chat-surface OBO envelope; its own comment
// says so verbatim ("'verified' principals will come from the platform IdP — never from an
// envelope"). Both the in-code policy (mcp-hub/src/policy.ts's RANK gate) and the Cerbos-
// authoritative `mcp_tool` policy (platform-nest/cerbos/policies/resource_mcp_tool.yaml) enforce
// the identical rank check, so setting "verified" here would make checkin.submit statically
// unreachable by ANY WhatsApp/Telegram OBO caller — silently breaking the exact WA loop §9.2
// describes three lines below its own tool table ("wa-chat-bot reminder → user replies... → bot
// calls checkin.submit through the MCP hub with the D4-linked OBO principal"). Every OTHER
// module-registered write/read tool in this codebase (pm.runTracker aside, which is genuinely
// unreachable-by-design like rollup.metrics) already ships `minAssurance: "low"` for exactly this
// reason — see mcp-hub/src/platform-tools.ts / platform-write-tools.ts / work-activity-tools.ts's
// own comments: "real authorization happens IN the platform per the OBO principal". checkin.submit
// follows that same, load-bearing convention: the HUB gate only checks "is this tool visible to a
// chat-surface caller at all" (yes); the REAL security bar — self-only, D4-verified-link-required —
// is enforced by AuthGuard (auth/guards.ts: an unverified/unknown OBO envelope resolves to
// ANONYMOUS, userId=null, and checkins.controller.ts's submit/today handlers 400 rather than act)
// plus Cerbos's `checkin` resource policy (submit: `member`-self only, `subjectUserId ==
// request.principal.id` — and the controller NEVER reads a subject id off the request body, so
// there is no field an OBO/MCP caller could set to submit "as" someone else). Flagged here for the
// architect to fold into §9.2/§15 as a formal amendment; TR-11's own test suite
// (checkins-mcp-obo.db.test.ts) pins the forgery-denial behavior this relies on.
import type { ModuleContract } from "../contract";
import { reportRollups } from "./report-rollups";

export const reportsModule: ModuleContract = {
  key: "reports",
  migrations: [
    "0056_module_reports_core.sql",
    "0057_report_metric_seeds.sql",
    "0067_report_periods_documents.sql",
  ],
  permissions: [
    { key: "reports:metrics:read", description: "View the tenant's report/appraisal rollup metrics" },
  ],
  customFieldTargets: [],
  mcpTools: [
    {
      name: "checkin.getToday",
      description: "Get today's end-of-day check-in draft for the acting user (prefilled from their derived activity)",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/checkins/today",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" } },
        required: ["tenantId"],
      },
    },
    {
      name: "checkin.submit",
      description:
        "Submit the acting user's end-of-day check-in (summary + optional blockers). Acts ONLY as the OBO user — there is no field to submit on behalf of anyone else; the platform resolves the subject from the caller's own D4-verified identity, never from the request body.",
      minAssurance: "low", // see the file header — a documented deviation from §9.2's literal "verified"
      method: "POST",
      pathTemplate: "/api/:tenantId/checkins",
      write: true,
      impact: "low",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          summary: { type: "string", description: "Non-empty day summary; the caller's edit of the prefill, or a fresh one." },
          blockers: { type: "string", description: "Optional blockers text." },
          date: { type: "string", description: "ISO date (today or yesterday); defaults to today." },
          source: {
            type: "string",
            enum: ["ui", "wa", "mcp", "system"],
            description: "Provenance of this submission — checkins.controller.ts's own TR-09 test already pins this field's contract. The WA reminder-reply flow passes 'wa'.",
          },
        },
        required: ["tenantId", "summary"],
      },
    },
  ],
  rollupProviders: [reportRollups],
  uiManifest: [{ label: "Reports", path: "/reports" }],
  // routes: ReportsController (registered on AppModule directly — see its own header comment).
};

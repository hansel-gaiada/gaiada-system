// Reports module contract (TR-08). ROUTES (facts recompute) live in ReportsController and are
// registered directly on AppModule (§6.2: `/api/:t/reports/*`, not `/api/:t/modules/reports/*` —
// see reports.controller.ts's header); this object carries the registry/rollup metadata the
// engine + registry + hub tool-def aggregation consume, same split as hrModule/index.ts.
//
// `rollupProviders: [reportRollups]` is what makes `rollups/engine.ts`'s per-module invocation loop
// (`recomputeRollups`) find and run TR-08's provider under the tenant's `reports` module scope —
// registering it here, rather than building a parallel recompute path, is the ticket's explicit
// instruction ("Register through this; do not build a parallel path").
//
// TR-28 — §9.2 names SIX tools for this module; TR-11 registered the two check-in tools
// (`checkin.getToday` / `checkin.submit`, the WA-reply round trip). This ticket registers the
// remaining four read tools (`reports.getDocument` / `reports.listPeriods` / `reports.getMetrics` /
// `reports.getCompliance`), so the hub now aggregates all six and no more. Deliberately NOT exposed
// at all, per §9.2's own text and the standing ruling: `seal`/`amend`/`periods/pin` (exec ceremony,
// human-only) and every appraisal read/write/ack/seal tool (human-only performance surface) —
// index.test.ts asserts this absence directly rather than leaving it as an unenforced comment.
//
// ⚠ minAssurance DEVIATION on checkin.submit (documented, not silent — UNCHANGED by this ticket):
// §9.2's literal text gives `checkin.submit` `minAssurance: "verified"`. That value is UNREACHABLE
// at the mcp-hub layer for this exact flow. The hub's own `Assurance` enum is
// `"anonymous" | "low" | "verified"` (mcp-hub/src/principal.ts) — a DIFFERENT vocabulary than this
// file's own `"low" | "verified"` McpToolDef type, and ALSO different from the PLATFORM's own
// `Assurance` type (`"low" | "linked" | "high"`, src/rbac/principal.ts) that the Cerbos policies
// below actually gate on — three vocabularies sharing overlapping words is exactly the kind of
// thing that reads as a contradiction until you trace each one to its source. mcp-hub's own
// `mintPrincipal()` can NEVER mint "verified" from a chat-surface OBO envelope; its own comment
// says so verbatim ("'verified' principals will come from the platform IdP — never from an
// envelope"). Both the in-code policy (mcp-hub/src/policy.ts's RANK gate) and the Cerbos-
// authoritative `mcp_tool` policy (platform-nest/cerbos/policies/resource_mcp_tool.yaml) enforce
// the identical hub-level rank check, so setting "verified" here would make checkin.submit
// statically unreachable by ANY WhatsApp/Telegram OBO caller — silently breaking the exact WA loop
// §9.2 describes three lines below its own tool table ("wa-chat-bot reminder → user replies... →
// bot calls checkin.submit through the MCP hub with the D4-linked OBO principal"). Every OTHER
// module-registered write/read tool in this codebase (pm.runTracker aside, which is genuinely
// unreachable-by-design like rollup.metrics) already ships `minAssurance: "low"` for exactly this
// reason. checkin.submit follows that same, load-bearing convention: the HUB gate only checks "is
// this tool visible to a chat-surface caller at all" (yes); the REAL security bar — self-only, D4-
// verified-link-required — is enforced by AuthGuard (auth/guards.ts: an unverified/unknown OBO
// envelope resolves to ANONYMOUS, userId=null, and checkins.controller.ts's submit/today handlers
// 400 rather than act) plus Cerbos's `checkin` resource policy (submit: `member`-self only,
// `subjectUserId == request.principal.id`, PLUS the platform's own `notLow` — which a D4-verified
// link satisfies because it resolves to platform-assurance `"linked"`, never the platform's literal
// `"low"`; an unverified/unknown identity is `ANONYMOUS` with `userId: null` and never reaches the
// Cerbos check at all). checkins-mcp-obo.db.test.ts pins the forgery-denial behavior this relies on.
//
// reports.getCompliance keeps §9.2's literal `minAssurance: "verified"` UNCHANGED — this is NOT the
// same bug class as checkin.submit above. §9.2 never states a chat/WA requirement for this tool (the
// WA loop it names three lines later is checkin.getToday/submit only), so there is no explicit
// design promise this "verified" breaks. It is instead the SAME deliberate, accepted, currently-
// dormant tier this file's own comment already carries for `pm.runTracker` ("genuinely unreachable-
// by-design like rollup.metrics") — a compliance grid is HR/lead/exec-tier data, and gating it
// behind a hub-assurance tier that today only the platform IdP (not yet wired into mcp-hub's
// principal minting) can satisfy is the conservative, correct default until that lands. Not a
// contradiction to fix; a placeholder to leave alone, same as pm.runTracker.
//
// AMENDED 2026-08-06 — assurance minting landed (`mcp-hub/src/principal.ts`'s `elevateAssurance`;
// design docs/superpowers/plans/2026-08-06-assurance-minting-design.md) and the paragraphs above stay
// CORRECT, deliberately: the new path requires the CALLER to hold HUB_ASSURANCE_TOKEN, which only
// platform-nest and ai-agents do. A chat-surface envelope from wa-chat-bot still mints `"low"` no
// matter how verified the underlying D4 link is, so `checkin.submit` still needs its `minAssurance:
// "low"` for the WA loop to work, and `reports.getCompliance` is still chat-unreachable. What changed:
// "only the platform IdP can satisfy it" is now a live path rather than a pending one, so this tool IS
// reachable by the agent runner acting for a human. That is fine on its own terms — the real bar was
// always Cerbos' `report_admin`/compliance policies plus the platform's own `notLow`, both untouched.
//
// ⚠ HUB GENERIC-FRONTING CONSTRAINT (load-bearing, discovered while wiring these four — read before
// adding another GET tool with filter args to ANY module). mcp-hub/src/module-tools.ts's
// `callPlatform()` builds the outgoing request from a def's `pathTemplate` + the tool's args in
// exactly two ways: `fillPath()` substitutes `:token` placeholders found ANYWHERE in the template
// string (path segment or, as used below, query string — the substitution is a plain regex replace
// over the whole string, no path/query distinction exists in the code), and — ONLY for a non-GET
// method — every arg NOT consumed by a `:token` becomes the JSON request body. For a GET request,
// any arg not consumed by a `:token` is silently DROPPED — never appended as a query string. Every
// other GET tool registered anywhere in this codebase today sidesteps this by needing nothing
// beyond `:tenantId` (or another literal path segment like `:propertyId`/`:engagementId`); no prior
// module has needed a real HTTP query-string filter on a GET tool. These four do (`grain`/
// `scopeRef`/`periodKind`/`start`/`end` on `document`; `kind`/`from`/`to` on `periods`; `metricKey`/
// `grain`/`from`/`to` on `metrics`; `unit`/`periodKind`/`start`/`end` on `compliance`) — §6.2's real
// routes take these as query params, not path segments, because the underlying HTTP routes are
// fixed (`/reports/document`, `/reports/periods`, `/reports/metrics`, `/checkins/compliance`).
//
// Fix applied here, WITHOUT touching mcp-hub (out of this ticket's file scope): every filter is
// embedded as a `?key=:key&...` query string directly inside `pathTemplate`, which `fillPath`'s
// whole-string substitution honors correctly (and correctly percent-encodes each value). The one
// cost: `fillPath` throws "missing path parameter" for ANY `:token` in the template left unfilled,
// with no concept of "optional" — so every filter embedded this way is `required` in `inputSchema`
// too, even where the underlying HTTP endpoint itself treats it as optional (`end` outside
// `periodKind=custom`; `kind` on `/periods`; `metricKey`/`grain` on `/metrics`; `unit` on
// `/compliance`). This is a real, working technique — proven by module-tools.test.ts's own
// mechanics, extended below — not a stand-in that 400s/403s in practice: the HTTP request the hub
// actually sends is identical to what a direct API caller would send with the same values, so
// Cerbos's decision is identical too. The narrowing is real but small (an agent must always name a
// value for an HTTP-optional filter — e.g. pass `end` equal to `start` outside a custom range, or a
// concrete `metricKey`/`grain` rather than "all of them") and is spelled out in each tool's own
// description below rather than left for a caller to discover via a 500. **Recorded here as a
// follow-up worth the architect's attention:** a proper fix — teaching `callPlatform()` to append
// unused GET args as a real query string — would remove this narrowing outright and is the more
// durable answer once someone owns a change to mcp-hub/src/module-tools.ts.
import type { ModuleContract } from "../contract";
import { reportRollups } from "./report-rollups";

export const reportsModule: ModuleContract = {
  key: "reports",
  migrations: [
    "0056_module_reports_core.sql",
    "0057_report_metric_seeds.sql",
    "0067_report_periods_documents.sql",
    "0068_report_appraisals.sql",
    "0069_report_module_roles.sql",
  ],
  // IAM-01d migration: `reports:metrics:read` was ALIAS (§7) — it maps onto
  // reports.document.read_* + reports.period.view, none of which this key names directly, and the
  // catalog recommendation is to drop it: the fine-grained reads already cover the surface, and
  // "view rollup metrics" becomes a UI-only grouping (IAM-01b-3) rather than a distinct module
  // declaration.
  permissions: [],
  customFieldTargets: [],
  mcpTools: [
    {
      name: "reports.getDocument",
      description:
        "Fetch a person/project/department/company work report (ReportDocument JSON) for a day, week, month, or an arbitrary custom date range. For periodKind='custom', 'end' is the actual boundary and the range is computed live (unsealed, not appraisal-admissible); max span 400 days. HUB-FRONTING NOTE: all five fields are required on every call (see this file's header) — for periodKind day/week/month, pass end equal to start; the server derives the real range from start alone and ignores end in that case.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/reports/document?grain=:grain&scopeRef=:scopeRef&periodKind=:periodKind&start=:start&end=:end",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          grain: { type: "string", enum: ["person", "project", "department", "company"] },
          scopeRef: { type: "string", description: "The person/project/department id, or the tenantId itself for grain=company." },
          periodKind: { type: "string", enum: ["day", "week", "month", "custom"] },
          start: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive." },
          end: {
            type: "string",
            description:
              "ISO date (YYYY-MM-DD), inclusive. The real boundary when periodKind='custom' (max 400-day span; over that: 422 range_too_large). For day/week/month, pass the same value as start — the server ignores it for those kinds.",
          },
        },
        required: ["tenantId", "grain", "scopeRef", "periodKind", "start", "end"],
      },
    },
    {
      name: "reports.listPeriods",
      description:
        "List report periods and their seal status/revisions in an inclusive [from, to] window (kind: day|week|month|custom — 'custom' rows are pinned ad-hoc ranges and are never appraisal-admissible). HUB-FRONTING NOTE: kind/from/to are all required on every call (see this file's header) — the underlying endpoint treats 'kind' as an optional cross-kind filter, but this tool always filters to exactly one kind.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/reports/periods?kind=:kind&from=:from&to=:to",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          kind: { type: "string", enum: ["day", "week", "month", "custom"] },
          from: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive." },
          to: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive." },
        },
        required: ["tenantId", "kind", "from", "to"],
      },
    },
    {
      name: "reports.getMetrics",
      description:
        "Query a governed metric series (numerator/denominator) by metric key and grain over an arbitrary from/to window (max 400-day span). Ratios MUST be read as numerator/denominator — NEVER average the returned ratios across points; that is the exact average-of-averages defect this program's own range-additivity audit found in two of its own metrics (a point-in-time metric summed across a period, and a distinct-count treated as additive). HUB-FRONTING NOTE: metricKey/grain/from/to are all required on every call (see this file's header) — the underlying endpoint treats metricKey and grain as optional filters that widen the result set when omitted; over MCP you must name one metric and one grain per call. LIMITATION (TR-43): `evidence.source_diversity` (#22) is a read-time-derived distinct-count that is never written to the governed metric registry, so `metricKey: \"evidence.source_diversity\"` returns an EMPTY array here — not an error, just nothing. Call `reports.getDocument` instead and read that metric off the returned document's `kpis` (it carries `distinctOver: true`); every other metric key is fully queryable through this tool.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/reports/metrics?metricKey=:metricKey&grain=:grain&from=:from&to=:to",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          metricKey: { type: "string" },
          grain: { type: "string", enum: ["person", "project", "department", "company"] },
          from: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive." },
          to: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive." },
        },
        required: ["tenantId", "metricKey", "grain", "from", "to"],
      },
    },
    {
      name: "reports.getCompliance",
      description:
        "Check-in compliance grid for a unit over a day/week/month period or a custom date range (expected/submitted/missed/excused). Self ⊆ scope (TR-39): a caller with no broader lead/exec/HR grant sees only their OWN row, regardless of the 'unit' value passed — 'unit' is never trusted from the caller for that path. minAssurance is deliberately 'verified' and therefore DORMANT today (see this file's header) — no current mcp-hub principal-minting path can reach it; this registers the tool ready for when one does, same as pm.runTracker. HUB-FRONTING NOTE: unit/periodKind/start/end are all required on every call (see this file's header) — the underlying endpoint treats 'unit' and 'periodKind' as optional (a broad-tier caller passing no unit sees the whole tenant); pass end equal to start outside a custom range.",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/checkins/compliance?unit=:unit&periodKind=:periodKind&start=:start&end=:end",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          unit: { type: "string", description: "Org unit node id to filter to. Ignored for a self-only caller (own-row only, TR-39)." },
          periodKind: { type: "string", enum: ["day", "week", "month", "custom"] },
          start: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive." },
          end: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive. The real boundary when periodKind='custom'; otherwise pass the same value as start." },
        },
        required: ["tenantId", "unit", "periodKind", "start", "end"],
      },
    },
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

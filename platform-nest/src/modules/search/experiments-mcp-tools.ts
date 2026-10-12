// M5-V5-c — the MCP tools for A/B experiments (experiments.controller.ts). Cerbos resource_search_property · read / update.
// Reads carry no `impact`; every write is LOW: nothing here writes to WebDesk or Umami, and every public change (publishing the
// block, removing it, merging the winner) still goes through WebDesk's content grants and the WS4 publish approval (design §5.5).
// Writes are `verified` like every search write. The reads need only path params (the hub drops a GET's query).
import type { McpToolDef } from "../contract";

const ids = { tenantId: { type: "string" }, propertyId: { type: "string" } };
const withExp = { ...ids, experimentId: { type: "string" } };
const BASE = "/api/:tenantId/modules/search/properties/:propertyId/experiments";

const armsSchema = {
  type: "array",
  description: "2 to 4 arms with keys a (the control), b, c, d in order; whole-number weights of at least 10 adding up to 100. The arms' content lives in WebDesk (the experiment block).",
  items: { type: "object", properties: { key: { type: "string" }, weight: { type: "integer" } }, required: ["key", "weight"] },
};
const goalSchema = {
  type: "object",
  description: "{event: generate_lead | lead_form_start | cta_click | click_whatsapp | click_phone | click_email | section_view, match?: one of {form_id}, {link_location}, {section_id}}",
  properties: { event: { type: "string" }, match: { type: "object" } },
  required: ["event"],
};

export const EXPERIMENT_MCP_TOOLS: McpToolDef[] = [
  {
    name: "search.experiments.list",
    description:
      "List a property's A/B tests (draft, running, stopped, aborted, decided) with their pre-registration: goal, arms and weights, the sample size per arm and " +
      "the projected days (M5-V5-c). The pre-registration is fixed once a test starts. No result is in this list.",
    minAssurance: "low",
    method: "GET",
    pathTemplate: BASE,
    inputSchema: { type: "object", properties: { ...ids }, required: ["tenantId", "propertyId"] },
  },
  {
    name: "search.experiments.create",
    description:
      "Pre-register an A/B test on one WebDesk item (M5-V5-c): key, hypothesis, the item (tenantSlug, siteId, itemId), the Umami section_id of the tested section, " +
      "target (\"fields\" or {block: index}), goal, arms/weights and the relative minimum detectable effect; baselineRate is optional (suggested from the last 28 days of " +
      "Umami). Computes the sample size per arm (alpha 0.05, power 0.8) and refuses a test that would need more than 56 days (422 underpowered, with the projection) " +
      "and an 11th live test on the property (409 too_many_running). It only records the plan: the human drafts the item with the experiment block and publishes it " +
      "through the normal content flow, then search.experiments.sync detects the start.",
    minAssurance: "verified",
    write: true,
    impact: "low",
    method: "POST",
    pathTemplate: BASE,
    inputSchema: {
      type: "object",
      properties: {
        ...ids,
        key: { type: "string", description: "3 to 48 characters, a-z 0-9 and dashes; unique per property" },
        hypothesis: { type: "string" },
        webdesk: { type: "object", description: "{tenantSlug, siteId, itemId}", properties: { tenantSlug: { type: "string" }, siteId: { type: "string" }, itemId: { type: "string" } }, required: ["tenantSlug", "siteId", "itemId"] },
        sectionId: { type: "string", description: "the Umami section_id whose section_view is the exposure trigger" },
        target: { description: "\"fields\" (default) or {block: <index of a generic block>}" },
        enrolment: { type: "string", enum: ["consented", "all"], description: "\"all\" waits for counsel on F9 and is refused unless enabled" },
        goal: goalSchema,
        arms: armsSchema,
        baselineRate: { type: "number", description: "the control's expected conversion rate, 0 to 1; omit to suggest it from Umami" },
        relativeMde: { type: "number", description: "relative minimum detectable effect, e.g. 0.5 means 3.0 % -> 4.5 %" },
      },
      required: ["tenantId", "propertyId", "key", "hypothesis", "webdesk", "sectionId", "goal", "arms", "relativeMde"],
    },
  },
  {
    name: "search.experiments.get",
    description: "One A/B test with its pre-registration and lifecycle (status, started_at, stopped_at). Not its results (M5-V5-c).",
    minAssurance: "low",
    method: "GET",
    pathTemplate: `${BASE}/:experimentId`,
    inputSchema: { type: "object", properties: { ...withExp }, required: ["tenantId", "propertyId", "experimentId"] },
  },
  {
    name: "search.experiments.update",
    description:
      "Edit a DRAFT test's pre-registration (hypothesis, sectionId, target, enrolment, goal, arms, baselineRate, relativeMde); the plan is recomputed and re-checked " +
      "against the 56-day limit. Once the test has started the pre-registration is locked: 409 pre_registration_locked (M5-V5-c).",
    minAssurance: "verified",
    write: true,
    impact: "low",
    method: "PATCH",
    pathTemplate: `${BASE}/:experimentId`,
    inputSchema: {
      type: "object",
      properties: {
        ...withExp, hypothesis: { type: "string" }, sectionId: { type: "string" }, target: {}, enrolment: { type: "string" }, goal: goalSchema, arms: armsSchema,
        baselineRate: { type: ["number", "null"], description: "null asks for a fresh suggestion from the last 28 days of Umami" }, relativeMde: { type: "number" },
      },
      required: ["tenantId", "propertyId", "experimentId"],
    },
  },
  {
    name: "search.experiments.sync",
    description:
      "Check WebDesk: when the item's LIVE version carries the registered experiment block the test is running and started_at is that publish. A live block whose " +
      "weights, goal, enrolment or target differ from the registration is NOT started (state plan_mismatch, with the differing members). state is started | " +
      "already_running | not_live | plan_mismatch (M5-V5-c).",
    minAssurance: "verified",
    write: true,
    impact: "low",
    method: "POST",
    pathTemplate: `${BASE}/:experimentId/sync`,
    inputSchema: { type: "object", properties: { ...withExp }, required: ["tenantId", "propertyId", "experimentId"] },
  },
  {
    name: "search.experiments.results",
    description:
      "Where a running or finished test stands, from Umami. BEFORE the pre-registered horizon (every arm has its n exposures AND at least 14 whole days) this returns " +
      "only exposures per arm, progress and the sample-ratio-mismatch verdict: no rate, difference, interval or p-value, for any caller. At the horizon it returns " +
      "per-arm units, conversions and rate, the difference against arm a with a 95 % Newcombe interval, the Holm-adjusted p and the decision (ship an arm or keep a). " +
      "state is ok | not_started | aborted | unavailable (with a reason; never zeros). Counts under 5 are \"<5\" (M5-V5-c).",
    minAssurance: "low",
    method: "GET",
    pathTemplate: `${BASE}/:experimentId/results`,
    inputSchema: { type: "object", properties: { ...withExp }, required: ["tenantId", "propertyId", "experimentId"] },
  },
  {
    name: "search.experiments.stop",
    description:
      "Stop a running test. Allowed only at the horizon (or the 56-day inconclusive end); before it: 409 horizon_not_reached, use search.experiments.abort. After a stop the " +
      "human removes the experiment block (or merges the winner's override into the fields) through the normal content flow, then search.experiments.decide records the outcome (M5-V5-c).",
    minAssurance: "verified",
    write: true,
    impact: "low",
    method: "POST",
    pathTemplate: `${BASE}/:experimentId/stop`,
    inputSchema: { type: "object", properties: { ...withExp }, required: ["tenantId", "propertyId", "experimentId"] },
  },
  {
    name: "search.experiments.abort",
    description:
      "Abort a draft, running or stopped test at any time. No outcome is computed or shown for an aborted test. The block, if live, is removed through the normal content flow (M5-V5-c).",
    minAssurance: "verified",
    write: true,
    impact: "low",
    method: "POST",
    pathTemplate: `${BASE}/:experimentId/abort`,
    inputSchema: { type: "object", properties: { ...withExp }, required: ["tenantId", "propertyId", "experimentId"] },
  },
  {
    name: "search.experiments.decide",
    description:
      "Record the decision of a STOPPED test once its experiment block is no longer live (409 experiment_still_live otherwise): an append-only snapshot of the counts, " +
      "the analysis and the decision (ship an arm / keep the control), with an optional note. Idempotent (M5-V5-c).",
    minAssurance: "verified",
    write: true,
    impact: "low",
    method: "POST",
    pathTemplate: `${BASE}/:experimentId/decide`,
    inputSchema: { type: "object", properties: { ...withExp, note: { type: "string", description: "at most 500 characters" } }, required: ["tenantId", "propertyId", "experimentId"] },
  },
];

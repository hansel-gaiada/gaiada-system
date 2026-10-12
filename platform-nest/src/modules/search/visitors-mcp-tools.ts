// M5-V3-g — the MCP tools for consented visitor profiles (visitors.controller.ts). Cerbos resource_search_property:
// read_visitors for the four reads, update for the rules write (LOW: it changes how interests are derived; nothing is sent to a person).
// The hub forwards only path params on a GET, so the list tool binds the path-filter twin (minScore + order, first page); the full
// filter set and the cursor are on the BFF route. The hub has no PUT, so the rules write is the POST twin of the PUT route.
// A score orders a list; no tool acts on it (R-V1: no decision about a person, manual review before any outreach).
import type { McpToolDef } from "../contract";

const ids = { tenantId: { type: "string" }, propertyId: { type: "string" } };
const BASE = "/api/:tenantId/modules/search/properties/:propertyId/visitors";

export const VISITOR_MCP_TOOLS: McpToolDef[] = [
  {
    name: "search.visitors.list",
    description:
      "List a property's consented visitors (only people who accepted analytics): last seen, visits, country and city, network or company, top interests, score 0-100 " +
      "and whether a lead is linked (the lead id only if you may open leads, otherwise \"a lead you cannot open\"). minScore 0 means everyone; order is score or recent. " +
      "First page of 25, server order. A score is a guide for follow-up, never a decision about a person (M5-V3-g).",
    minAssurance: "low",
    method: "GET",
    pathTemplate: `${BASE}/filter/:minScore/:order`,
    inputSchema: {
      type: "object",
      properties: {
        ...ids,
        minScore: { type: "string", description: "0 to 100; 0 = no minimum" },
        order: { type: "string", enum: ["score", "recent"] },
      },
      required: ["tenantId", "propertyId", "minScore", "order"],
    },
  },
  {
    name: "search.visitors.get",
    description:
      "One consented visitor: summary, the latest 200 events (path, event name, allow-listed data), interests, the score parts (recency, frequency, depth, intent) and the linked lead " +
      "(id only if you may open it) (M5-V3-g).",
    minAssurance: "low",
    method: "GET",
    pathTemplate: `${BASE}/:visitorId`,
    inputSchema: { type: "object", properties: { ...ids, visitorId: { type: "string" } }, required: ["tenantId", "propertyId", "visitorId"] },
  },
  {
    name: "search.visitors.rules.list",
    description: "List a property's interest rules: path or section prefix -> facet (industry or service), tag and weight 1-10. No rules means no interests, never a guess (M5-V3-g).",
    minAssurance: "low",
    method: "GET",
    pathTemplate: `${BASE}/interest-rules`,
    inputSchema: { type: "object", properties: { ...ids }, required: ["tenantId", "propertyId"] },
  },
  {
    name: "search.visitors.rules.set",
    description:
      "Replace a property's interest rules with the COMPLETE list given (a rule left out is removed). LOW impact: it changes how interests and scores are derived at the next daily refresh " +
      "and sends nothing to anyone. At most 100 rules, each {match: path_prefix|section_prefix, pattern (1-200), facet: industry|service, tag [a-z0-9-]{1,40}, weight 1-10} (M5-V3-g).",
    minAssurance: "verified",
    write: true,
    impact: "low",
    method: "POST",
    pathTemplate: `${BASE}/interest-rules`,
    inputSchema: {
      type: "object",
      properties: {
        ...ids,
        rules: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              match: { type: "string", enum: ["path_prefix", "section_prefix"] },
              pattern: { type: "string" },
              facet: { type: "string", enum: ["industry", "service"] },
              tag: { type: "string" },
              weight: { type: "integer", minimum: 1, maximum: 10 },
            },
            required: ["match", "pattern", "facet", "tag", "weight"],
          },
        },
      },
      required: ["tenantId", "propertyId", "rules"],
    },
  },
  {
    name: "search.visitors.status",
    description:
      "Whether visitor profiles work for a property: state ok | not_configured | disabled | no_website | unreachable | rejected (each with words), the last successful ingest, " +
      "the last run's outcome and the collector's bot counts for the last 30 days (M5-V3-g).",
    minAssurance: "low",
    method: "GET",
    pathTemplate: `${BASE}/status`,
    inputSchema: { type: "object", properties: { ...ids }, required: ["tenantId", "propertyId"] },
  },
];

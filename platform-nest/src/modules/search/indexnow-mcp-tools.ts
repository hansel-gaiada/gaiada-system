// M5-P5a — the MCP tools for IndexNow and the Bing Webmaster connector (indexnow.controller.ts). Cerbos:
// resource_search_property · read for the reads, update for every write. Every write is `verified` assurance;
// impact is LOW except search.connectBing (MEDIUM: it stores a credential in the vault).
import type { McpToolDef } from "../contract";

const ids = { tenantId: { type: "string" }, propertyId: { type: "string" } };
const need = ["tenantId", "propertyId"];
const base = "/api/:tenantId/modules/search/properties/:propertyId";

export const INDEXNOW_MCP_TOOLS: McpToolDef[] = [
  {
    name: "search.getIndexNowStatus",
    description:
      "A property's IndexNow state: whether the server flag and the property switch are on, whether the key file was proven on the site, " +
      "the last 7 days of submissions by status, and the 20 most recent (M5-P5a).",
    minAssurance: "low", method: "GET", pathTemplate: `${base}/indexnow`,
    inputSchema: { type: "object", properties: { ...ids }, required: need },
  },
  {
    name: "search.getIndexNowKey",
    description:
      "The IndexNow key file the site build must serve: file name, the exact body and the URL it must answer at. The key is public by protocol " +
      "design (it is served in clear), so it is not a secret. 404 `indexnow_key_missing` until a key is generated (M5-P5a).",
    minAssurance: "low", method: "GET", pathTemplate: `${base}/indexnow/key`,
    inputSchema: { type: "object", properties: { ...ids }, required: need },
  },
  {
    name: "search.generateIndexNowKey",
    description:
      "Generate the property's IndexNow key (idempotent: an existing key is returned unchanged). With rotate=true the key is replaced and IndexNow is switched " +
      "off again until the new key file is proven on the site (M5-P5a).",
    minAssurance: "verified", write: true, impact: "low", method: "POST", pathTemplate: `${base}/indexnow/key`,
    inputSchema: { type: "object", properties: { ...ids, rotate: { type: "boolean" } }, required: need },
  },
  {
    name: "search.setIndexNow",
    description:
      "Switch IndexNow on or off for a property. Enabling first fetches https://<host>/<key>.txt and refuses (409 `indexnow_key_file_unreachable`) unless " +
      "the site serves the key; it also needs a verified property and the server flag (M5-P5a).",
    minAssurance: "verified", write: true, impact: "low", method: "PATCH", pathTemplate: `${base}/indexnow`,
    inputSchema: { type: "object", properties: { ...ids, enabled: { type: "boolean" } }, required: [...need, "enabled"] },
  },
  {
    name: "search.submitUrls",
    description:
      "Submit URLs of the property's own site to IndexNow (or Bing's submission API when only Bing is connected) now. Paths or absolute URLs on the " +
      "property's host, at most 100 per call and 300 per property per hour. Idempotent within the hour (M5-P5a).",
    minAssurance: "verified", write: true, impact: "low", method: "POST", pathTemplate: `${base}/indexnow/submit`,
    inputSchema: { type: "object", properties: { ...ids, urls: { type: "array", items: { type: "string" } } }, required: [...need, "urls"] },
  },
  {
    name: "search.notifyContentChange",
    description:
      "Report that pages were published or unpublished: each item's page URL is built from its collection's route pattern (an item with none is " +
      "skipped with a reason) and submitted once per (url, version, ref). Replaying the same ref sends nothing twice (M5-P5a).",
    minAssurance: "verified", write: true, impact: "low", method: "POST", pathTemplate: `${base}/indexnow/notify`,
    inputSchema: {
      type: "object",
      properties: {
        ...ids, transition: { type: "string", enum: ["publish", "unpublish"] }, ref: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { slug: { type: "string" }, locale: { type: "string" }, defaultLocale: { type: "string" }, routePattern: { type: "string" }, localized: { type: "boolean" }, version: { type: "integer" } },
            required: ["slug", "locale", "defaultLocale"],
          },
        },
      },
      required: [...need, "transition", "items"],
    },
  },
  {
    name: "search.getBingStatus",
    description: "A property's Bing Webmaster connection: connected or not, live or simulate mode, last pull, and row counts (real vs simulated) (M5-P5a).",
    minAssurance: "low", method: "GET", pathTemplate: `${base}/bing`,
    inputSchema: { type: "object", properties: { ...ids }, required: need },
  },
  {
    name: "search.connectBing",
    description:
      "Connect a property to Bing Webmaster with an API key. The key is sealed in the credentials vault and never returned. In live mode the key is " +
      "proven against the account (the site must be listed and verified there); in simulate mode (the default) nothing is sent to Bing (M5-P5a).",
    minAssurance: "verified", write: true, impact: "medium", method: "POST", pathTemplate: `${base}/bing`,
    inputSchema: { type: "object", properties: { ...ids, apiKey: { type: "string" } }, required: [...need, "apiKey"] },
  },
  {
    name: "search.disconnectBing",
    description: "Disconnect a property from Bing Webmaster. The vault row is revoked when no other property of the client still uses it (M5-P5a).",
    minAssurance: "verified", write: true, impact: "low", method: "DELETE", pathTemplate: `${base}/bing`,
    inputSchema: { type: "object", properties: { ...ids }, required: need },
  },
  {
    name: "search.pullBing",
    description:
      "Pull Bing query and page stats for a property (default 28 days, at most 180) into the module's tables. Idempotent per row. Simulate mode " +
      "(the default) synthesises rows stamped simulated and makes no Bing call (M5-P5a).",
    minAssurance: "verified", write: true, impact: "low", method: "POST", pathTemplate: `${base}/bing/pull`,
    inputSchema: { type: "object", properties: { ...ids, days: { type: "integer" } }, required: need },
  },
  {
    name: "search.listBingPerformance",
    description:
      "Stored Bing stats for a property between two dates (YYYY-MM-DD): query or page rows by day with clicks, impressions and average positions, plus " +
      "totals. kind is query, page or all. Rows carry a simulated flag (M5-P5a).",
    minAssurance: "low", method: "GET", pathTemplate: `${base}/bing/performance/:kind/:from/:to`,
    inputSchema: {
      type: "object",
      properties: { ...ids, kind: { type: "string", enum: ["query", "page", "all"] }, from: { type: "string" }, to: { type: "string" } },
      required: [...need, "kind", "from", "to"],
    },
  },
];

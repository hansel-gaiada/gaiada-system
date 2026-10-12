// M5-P2 — the MCP tools for ad-platform conversion uploads (conversions.controller.ts). Three reads and one LOW write.
// Cerbos resource_search_property · read / update. The upload itself is NOT a tool: it is planned from a lead's stage change and
// executed in-band when a human approves the WS4 approval (origin search, workflow search.conversions.upload, impact high).
// Nothing here returns an identifier; the ledger holds ids, stages, values, statuses and typed reasons.
import type { McpToolDef } from "../contract";

const ids = { tenantId: { type: "string" }, propertyId: { type: "string" } };

export const CONVERSION_MCP_TOOLS: McpToolDef[] = [
  {
    name: "search.listConversionTargets",
    description:
      "List a property's ad-platform conversion targets: which pipeline stage of which website maps to which Google Ads conversion action, Meta event or LinkedIn conversion rule, " +
      "whether the deal value is sent, and whether the platform is in simulate or live mode (M5-P2).",
    minAssurance: "low",
    method: "GET",
    pathTemplate: "/api/:tenantId/modules/search/properties/:propertyId/conversion-targets",
    inputSchema: { type: "object", properties: { ...ids }, required: ["tenantId", "propertyId"] },
  },
  {
    name: "search.setConversionTarget",
    description:
      "Create or update (idempotent) the conversion target for a website slug, platform and pipeline stage on a property. LOW impact: it sends " +
      "nothing by itself. Each upload that follows still needs its own human approval, and only goes out for a lead with marketing consent. " +
      "conversionAction is a Google conversion action, a Meta event name (meta_capi) or a LinkedIn conversion rule (linkedin_capi). Meta and LinkedIn are simulate-only (M5-P2, P3, P4).",
    minAssurance: "verified",
    write: true,
    impact: "low",
    method: "POST",
    pathTemplate: "/api/:tenantId/modules/search/properties/:propertyId/conversion-targets",
    inputSchema: {
      type: "object",
      properties: {
        ...ids,
        webSiteSlug: { type: "string" },
        platform: { type: "string", enum: ["google_ads", "meta_capi", "linkedin_capi"] },
        stage: { type: "string" },
        conversionKey: { type: "string" },
        conversionAction: { type: "string" },
        sendValue: { type: "boolean" },
        enabled: { type: "boolean" },
      },
      required: ["tenantId", "propertyId", "webSiteSlug", "platform", "stage", "conversionKey", "conversionAction"],
    },
  },
  {
    name: "search.listConversionUploads",
    description:
      "List a property's conversion-upload ledger, newest first: status (pending_approval, executing, simulated, uploaded, failed, rejected, skipped), " +
      "the typed reason, mode and the kinds of identifier that went (never a value). Ids only: no email, phone or click id is ever stored (M5-P2).",
    minAssurance: "low",
    method: "GET",
    pathTemplate: "/api/:tenantId/modules/search/properties/:propertyId/conversion-uploads",
    inputSchema: { type: "object", properties: { ...ids }, required: ["tenantId", "propertyId"] },
  },
  {
    name: "search.listLeadConversionUploads",
    description: "List the conversion uploads recorded for one lead (the pipeline card's \"Ad platform uploads\"): status, reason, mode, stage (M5-P2).",
    minAssurance: "low",
    method: "GET",
    pathTemplate: "/api/:tenantId/modules/search/leads/:leadId/conversion-uploads",
    inputSchema: { type: "object", properties: { tenantId: { type: "string" }, leadId: { type: "string" } }, required: ["tenantId", "leadId"] },
  },
];

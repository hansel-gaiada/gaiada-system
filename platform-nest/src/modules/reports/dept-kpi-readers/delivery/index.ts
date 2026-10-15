// DW-6n (docs/FRONTEND-BFF-CONTRACT.md §40.5): the delivery departments' module KPI readers. Each reader registers here under
// the `readerId` its catalogue entry (dept-kpis.ts) names; dept-kpi-readers.ts merges this record into MODULE_KPI_READERS.
//
// A reader over a module's tables is GATED on `isModuleEnabled` (§40.5.1): a company without the module reads `null`
// (`no_data`) and the reader never runs. The module wall alone is not enough, because `app_module_allowed()` checks only the
// scopes a query declares, not whether the company has the module, so a company that turned a module off would still read
// its old rows. Readers over core tables (work requests, creative assets and reviews, clients) are not gated.
import { gated } from "../gated";
import type { ModuleKpiReader } from "../types";
import { assetsDelivered, revisionRounds } from "./creative-reviews";
import { clientRetention } from "./client-retention";
import { clientSiteUptime } from "./monitoring-uptime";
import { adBudgetsOnPace, clientReportsOnTime, clientsRankingGrowth } from "./search";
import { clientApprovalTurnaround, engagementGrowth, postsOnSchedule } from "./social";
import { assetRequestsOnTime, webdevRequestsDeliveredByNeeded } from "./work-requests-on-time";

// `gated` lives in ../gated (shared with the functional readers, DW-7j j0); re-exported so this import path keeps working.
export { gated };

export const DELIVERY_READERS: Record<string, ModuleKpiReader> = {
  // Web Dev
  "webdev.requests_delivered_by_needed": webdevRequestsDeliveredByNeeded,
  "monitoring.client_uptime": gated("monitoring", clientSiteUptime),
  // SEO
  "search.clients_ranking_growth": gated("search", clientsRankingGrowth),
  "search.client_reports_on_time": gated("search", clientReportsOnTime),
  "search.ad_budgets_on_pace": gated("search", adBudgetsOnPace),
  "clients.retention": clientRetention,
  // Social Media
  "social.posts_on_schedule": gated("social", postsOnSchedule),
  "social.client_approval_turnaround": gated("social", clientApprovalTurnaround),
  "social.engagement_growth": gated("social", engagementGrowth),
  // Creatives
  "creatives.asset_requests_on_time": assetRequestsOnTime,
  "creatives.revision_rounds": revisionRounds,
  "creatives.assets_delivered": assetsDelivered,
};

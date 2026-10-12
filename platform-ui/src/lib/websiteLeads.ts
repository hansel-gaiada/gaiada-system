import "server-only";
// M5-L6 - Website -> Leads: the server read. One call through platform-nest's BFF
// (`GET /api/:company/agency/web-leads/:siteSlug`, `agency_lead:read`). The body is validated before it is returned;
// a failure is a WdResult refusal (same vocabulary as the rest of the Website workspace, rendered by WdRefusal), never
// an empty list. `company` is the ERP tenant; `siteSlug` is the WebDesk tenant slug from the route.
import { platformFetch } from "./platform";
import { resultFromError } from "./webdeskContent";
import type { WdResult } from "./webdeskContentModel";
import { parseWebLeads, WebLeadsShapeError, type WebLeadsBody } from "./websiteLeadsModel";

export async function listWebLeads(userId: string, company: string, siteSlug: string): Promise<WdResult<WebLeadsBody>> {
  try {
    const raw = await platformFetch<unknown>(`/api/${encodeURIComponent(company)}/agency/web-leads/${encodeURIComponent(siteSlug)}`, userId);
    return { kind: "ok", data: parseWebLeads(raw) };
  } catch (e) {
    if (e instanceof WebLeadsShapeError) return { kind: "unavailable", code: "contract_drift", reason: e.message };
    return resultFromError(e);
  }
}

import "server-only";
// M5-A4 — Website → Analytics: the server reads. One property lookup (the search property whose domain is the
// site's), then the seven analytics reads through platform-nest's BFF. Every body is validated before it is
// returned; a failure is a WdResult refusal (same vocabulary as the rest of the Website workspace, rendered by
// WdRefusal), never an empty table. platform-nest holds the Umami key; this file never sees it.
import { platformFetch } from "./platform";
import { resultFromError } from "./webdeskContent";
import type { WdResult } from "./webdeskContentModel";
import {
  ANALYTICS_KINDS, AnalyticsShapeError, matchProperty, parseAnalyticsRead,
  type AnalyticsData, type AnalyticsKind, type AnalyticsRead, type PropertyRef,
} from "./websiteAnalyticsModel";

export type AnalyticsReads = { [K in AnalyticsKind]: AnalyticsRead<K> };

export type SiteAnalytics =
  | { kind: "no_property" }
  | { kind: "ok"; property: PropertyRef; reads: AnalyticsReads }
  | Exclude<WdResult<never>, { kind: "ok" }>;

const drift = (e: AnalyticsShapeError): Exclude<WdResult<never>, { kind: "ok" }> => ({ kind: "unavailable", code: "contract_drift", reason: e.message });

export async function listProperties(userId: string, company: string): Promise<PropertyRef[]> {
  const rows = await platformFetch<unknown>(`/api/${encodeURIComponent(company)}/modules/search/properties`, userId);
  if (!Array.isArray(rows)) throw new AnalyticsShapeError("properties: expected an array");
  return rows
    .filter((r): r is { id: string; domain: string; umamiSiteId?: string | null } => !!r && typeof r.id === "string" && typeof r.domain === "string")
    .map((r) => ({ id: r.id, domain: r.domain, umamiSiteId: typeof r.umamiSiteId === "string" ? r.umamiSiteId : null }));
}

async function readOne<K extends AnalyticsKind>(userId: string, company: string, propertyId: string, kind: K, from: string, to: string): Promise<AnalyticsRead<K>> {
  const body = await platformFetch<unknown>(
    `/api/${encodeURIComponent(company)}/modules/search/properties/${encodeURIComponent(propertyId)}/analytics/${kind}?from=${from}&to=${to}`,
    userId,
  );
  return parseAnalyticsRead(kind, body);
}

/** `domains`: the site's environment domains. `company` is the ERP tenant (not the WebDesk slug). */
export async function readSiteAnalytics(
  userId: string, company: string, domains: Array<string | null>, from: string, to: string,
): Promise<SiteAnalytics> {
  try {
    const property = matchProperty(await listProperties(userId, company), domains);
    if (!property) return { kind: "no_property" };
    // Summary first: when Umami is not configured / not bound / down, the other six would say the same, so don't ask.
    const summary = await readOne(userId, company, property.id, "summary", from, to);
    if (summary.state !== "ok") {
      const same = { state: summary.state, message: summary.message } as const;
      return { kind: "ok", property, reads: { summary, pages: same, sources: same, sections: same, ctas: same, forms: same, vitals: same } };
    }
    const rest = ANALYTICS_KINDS.filter((k) => k !== "summary");
    const got = await Promise.all(rest.map((k) => readOne(userId, company, property.id, k, from, to)));
    const reads = { summary } as Record<string, unknown>;
    rest.forEach((k, i) => { reads[k] = got[i]; });
    return { kind: "ok", property, reads: reads as AnalyticsReads };
  } catch (e) {
    if (e instanceof AnalyticsShapeError) return drift(e);
    return resultFromError(e) as Exclude<WdResult<never>, { kind: "ok" }>;
  }
}

export type { AnalyticsData };

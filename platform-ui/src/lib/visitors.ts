import "server-only";
// M5-V3-i — Website -> Visitors: the server reads. The search property whose domain is the site's (same resolution as
// Analytics), then the visitors API of platform-nest (§28f). Reads are independent: the status never blanks the list and a
// failed list never becomes an empty one. A failure is a state with words.
import { platformFetch, PlatformError } from "./platform";
import { listProperties } from "./websiteAnalytics";
import { matchProperty, AnalyticsShapeError, type PropertyRef } from "./websiteAnalyticsModel";
import { listSites, resultFromError } from "./webdeskContent";
import type { WdResult } from "./webdeskContentModel";
import {
  VisitorsShapeError, parseInterestRules, parseVisitorDetail, parseVisitorList, parseVisitorStatus,
  type InterestRules, type VisitorDetail, type VisitorList, type VisitorStatus,
} from "./visitorsModel";

export type Read<T> = { state: "ok"; data: T } | { state: "unavailable"; message: string };
type Refusal = Exclude<WdResult<never>, { kind: "ok" }>;

const root = (company: string, propertyId: string) =>
  `/api/${encodeURIComponent(company)}/modules/search/properties/${encodeURIComponent(propertyId)}`;

async function one<T>(path: string, userId: string, parse: (b: unknown) => T, what: string): Promise<Read<T>> {
  try {
    return { state: "ok", data: parse(await platformFetch<unknown>(path, userId)) };
  } catch (e) {
    if (e instanceof VisitorsShapeError) return { state: "unavailable", message: `The ${what} answer did not match the contract (${e.message}). This is a defect, not an empty result.` };
    if (e instanceof PlatformError && e.status === 403) return { state: "unavailable", message: `You do not have access to the ${what}.` };
    return { state: "unavailable", message: `The ${what} could not be read. Try again in a moment.` };
  }
}

/** The property for a site. `domains`: the site's environment domains. `company` is the ERP tenant (not the WebDesk slug). */
export async function resolveProperty(
  userId: string, company: string, domains: Array<string | null>,
): Promise<{ kind: "ok"; property: PropertyRef } | { kind: "no_property" } | Refusal> {
  try {
    const property = matchProperty(await listProperties(userId, company), domains);
    return property ? { kind: "ok", property } : { kind: "no_property" };
  } catch (e) {
    if (e instanceof AnalyticsShapeError) return { kind: "unavailable", code: "contract_drift", reason: e.message };
    return resultFromError(e) as Refusal;
  }
}

export const readStatus = (userId: string, company: string, propertyId: string): Promise<Read<VisitorStatus>> =>
  one(`${root(company, propertyId)}/visitors/status`, userId, parseVisitorStatus, "visitor status");

export function readList(userId: string, company: string, propertyId: string, query: Record<string, string>): Promise<Read<VisitorList>> {
  const qs = new URLSearchParams(query).toString();
  return one(`${root(company, propertyId)}/visitors${qs ? `?${qs}` : ""}`, userId, parseVisitorList, "visitor list");
}

export const readRules = (userId: string, company: string, propertyId: string): Promise<Read<InterestRules>> =>
  one(`${root(company, propertyId)}/visitors/interest-rules`, userId, parseInterestRules, "interest rules");

export type Overview = { status: Read<VisitorStatus>; list: Read<VisitorList> };

/** Status and list are both always read (stored profiles stay readable while the pipeline is down); the page shows the status first. */
export async function readOverview(userId: string, company: string, propertyId: string, query: Record<string, string>): Promise<Overview> {
  const [status, list] = await Promise.all([readStatus(userId, company, propertyId), readList(userId, company, propertyId, query)]);
  return { status, list };
}

export type DetailRead = { kind: "ok"; visitor: VisitorDetail } | { kind: "visitor_not_found" } | Refusal;

export async function readDetail(userId: string, company: string, propertyId: string, visitorId: string): Promise<DetailRead> {
  try {
    const body = await platformFetch<unknown>(`${root(company, propertyId)}/visitors/${encodeURIComponent(visitorId)}`, userId);
    return { kind: "ok", visitor: parseVisitorDetail(body) };
  } catch (e) {
    if (e instanceof VisitorsShapeError) return { kind: "unavailable", code: "contract_drift", reason: e.message };
    if (e instanceof PlatformError) {
      const reason = e.reason ?? (e.body && typeof e.body === "object" ? (e.body as { reason?: unknown }).reason : undefined);
      // 404 visitor_not_found, and 400 visitor_id_invalid for a hand-typed id: both are "no such visitor", said in words.
      if ((e.status === 404 && reason === "visitor_not_found") || (e.status === 400 && reason === "visitor_id_invalid")) return { kind: "visitor_not_found" };
    }
    return resultFromError(e) as Refusal;
  }
}

export type SiteProperty =
  | { kind: "ok"; siteName: string; property: PropertyRef }
  | { kind: "no_property"; siteName: string }
  | { kind: "no_site" }
  | Refusal;

/** The site (it must be one of this company's: `listSites` is the company wall), then its search property. */
export async function resolveSiteProperty(userId: string, company: string, tenant: string, site: string): Promise<SiteProperty> {
  const sites = await listSites(userId, company);
  if (sites.kind !== "ok") return sites as Refusal;
  const s = sites.data.tenants.find((x) => x.slug === tenant)?.sites.find((x) => x.siteId === site);
  if (!s) return { kind: "no_site" };
  const r = await resolveProperty(userId, company, s.environments.map((e) => e.domain));
  if (r.kind === "ok") return { kind: "ok", siteName: s.name, property: r.property };
  if (r.kind === "no_property") return { kind: "no_property", siteName: s.name };
  return r;
}

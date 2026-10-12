import "server-only";
// M5-P5b — Website → Analytics → AI visibility: the server reads. The search property whose domain is the site's,
// then the AI-crawler summary and the SM-16 AI-visibility summary through platform-nest's BFF. The two reads are
// independent: one failing never blanks the other, and a failure is a state with words, never an empty panel.
import { platformFetch, PlatformError } from "./platform";
import { listProperties } from "./websiteAnalytics";
import { matchProperty, AnalyticsShapeError, type PropertyRef } from "./websiteAnalyticsModel";
import { resultFromError } from "./webdeskContent";
import type { WdResult } from "./webdeskContentModel";
import {
  AiVisibilityShapeError, parseCrawlerSummary, parseVisibilitySummary,
  type CrawlerSummary, type VisibilitySummary,
} from "./aiVisibilityModel";

export type Read<T> = { state: "ok"; data: T } | { state: "unavailable"; message: string };

export type SiteAiVisibility =
  | { kind: "no_property" }
  | { kind: "ok"; property: PropertyRef; crawlers: Read<CrawlerSummary>; visibility: Read<VisibilitySummary> }
  | Exclude<WdResult<never>, { kind: "ok" }>;

async function one<T>(path: string, userId: string, parse: (b: unknown) => T, what: string): Promise<Read<T>> {
  try {
    return { state: "ok", data: parse(await platformFetch<unknown>(path, userId)) };
  } catch (e) {
    if (e instanceof AiVisibilityShapeError) return { state: "unavailable", message: `The ${what} answer did not match the contract (${e.message}). This is a defect, not an empty result.` };
    if (e instanceof PlatformError && e.status === 403) return { state: "unavailable", message: `You do not have access to the ${what}.` };
    return { state: "unavailable", message: `The ${what} could not be read. Try again in a moment.` };
  }
}

/** `domains`: the site's environment domains. `company` is the ERP tenant (not the WebDesk slug). */
export async function readSiteAiVisibility(
  userId: string, company: string, domains: Array<string | null>, from: string, to: string,
): Promise<SiteAiVisibility> {
  try {
    const property = matchProperty(await listProperties(userId, company), domains);
    if (!property) return { kind: "no_property" };
    const root = `/api/${encodeURIComponent(company)}/modules/search/properties/${encodeURIComponent(property.id)}`;
    const [crawlers, visibility] = await Promise.all([
      one(`${root}/ai-crawlers/summary?from=${from}&to=${to}`, userId, parseCrawlerSummary, "AI-crawler log"),
      one(`${root}/ai-visibility-summary`, userId, parseVisibilitySummary, "AI-visibility results"),
    ]);
    return { kind: "ok", property, crawlers, visibility };
  } catch (e) {
    if (e instanceof AnalyticsShapeError) return { kind: "unavailable", code: "contract_drift", reason: e.message };
    return resultFromError(e) as Exclude<WdResult<never>, { kind: "ok" }>;
  }
}

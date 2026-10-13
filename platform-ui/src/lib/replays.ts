import "server-only";
// M5-V6-c — the server reads for session recordings: the recordings of one visitor (metadata only) and the site's domains for the
// player page's policy. The CONTENT is read by `replaysActions.ts` (a server action, page by page). Everything goes through
// platformFetch (§28g): the browser never talks to the collector and there is no link to it.
//
// The capability gate is the CALLER'S job and is checked before this module is reached (`can(me, "search.replay.view", company)`):
// a viewer without it makes no read at all. The server is the authority and answers 403 anyway.
import { platformFetch, PlatformError } from "./platform";
import { listSites, resultFromError } from "./webdeskContent";
import type { WdResult } from "./webdeskContentModel";
import { resolveProperty } from "./visitors";
import type { PropertyRef } from "./websiteAnalyticsModel";
import { ReplaysShapeError, classifyReplayFailure, parseRecordingList, type RecordingList, type ReplayFailure } from "./replaysModel";

type Refusal = Exclude<WdResult<never>, { kind: "ok" }>;

const root = (company: string, propertyId: string) =>
  `/api/${encodeURIComponent(company)}/modules/search/properties/${encodeURIComponent(propertyId)}`;

/** The machine `reason` of a refused platform call: the typed field, else the body's. */
export function reasonOf(e: PlatformError): string | null {
  if (typeof e.reason === "string") return e.reason;
  if (e.body && typeof e.body === "object" && typeof (e.body as { reason?: unknown }).reason === "string") return (e.body as { reason: string }).reason;
  return null;
}

export type RecordingsRead =
  | { kind: "ok"; list: RecordingList }
  | { kind: "visitor_not_found" }
  | { kind: "failed"; failure: Exclude<ReplayFailure, { kind: "not_found" } | { kind: "not_opened" }>; message: string }
  | { kind: "drift"; message: string };

const WORDS: Record<"forbidden" | "signed_out" | "bad_request", string> = {
  forbidden: "You do not have access to this visitor's recordings.",
  signed_out: "Your session has ended. Sign in again to see the recordings.",
  bad_request: "The recordings could not be requested for this visitor.",
};

/** The recordings of one visitor. `unavailable` and every other failure is words; an empty `recordings` means the store answered and has none. */
export async function readRecordings(userId: string, company: string, propertyId: string, visitorId: string): Promise<RecordingsRead> {
  try {
    const body = await platformFetch<unknown>(`${root(company, propertyId)}/visitors/${encodeURIComponent(visitorId)}/recordings`, userId);
    return { kind: "ok", list: parseRecordingList(body) };
  } catch (e) {
    if (e instanceof ReplaysShapeError) return { kind: "drift", message: e.message };
    if (e instanceof PlatformError) {
      const f = classifyReplayFailure(e.status, reasonOf(e));
      if (f.kind === "not_found") return { kind: "visitor_not_found" };
      if (f.kind === "not_opened") return { kind: "failed", failure: { kind: "bad_request" }, message: WORDS.bad_request };
      return { kind: "failed", failure: f, message: f.kind === "unavailable" ? f.message : WORDS[f.kind] };
    }
    const f = classifyReplayFailure(0, null) as Extract<ReplayFailure, { kind: "unavailable" }>;
    return { kind: "failed", failure: f, message: f.message };
  }
}

export type SiteForReplay =
  | { kind: "ok"; siteName: string; property: PropertyRef; domains: string[] }
  | { kind: "no_property"; siteName: string }
  | { kind: "no_site" }
  | Refusal;

/**
 * The site (it must be one of this company's: `listSites` is the company wall), its search property, and the site's environment
 * domains (the same ones the Visitors tab matches the property by), which become the player page's `img-src`.
 */
export async function resolveSiteForReplay(userId: string, company: string, tenant: string, site: string): Promise<SiteForReplay> {
  let sites;
  try { sites = await listSites(userId, company); } catch (e) { return resultFromError(e) as Refusal; }
  if (sites.kind !== "ok") return sites as Refusal;
  const s = sites.data.tenants.find((x) => x.slug === tenant)?.sites.find((x) => x.siteId === site);
  if (!s) return { kind: "no_site" };
  const domains = s.environments.map((e) => e.domain);
  const r = await resolveProperty(userId, company, domains);
  if (r.kind === "ok") return { kind: "ok", siteName: s.name, property: r.property, domains: domains.filter((d): d is string => typeof d === "string") };
  if (r.kind === "no_property") return { kind: "no_property", siteName: s.name };
  return r;
}

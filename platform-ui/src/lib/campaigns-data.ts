import "server-only";
// DW-5b: readers behind the Campaigns row, the Social campaigns screen and the campaign page
// (docs/FRONTEND-BFF-CONTRACT.md §31). Every reader returns a `ReadResult`: a refusal or a failed read is DATA the page
// renders with <ReadRefusal>, never an empty list that reads as "no campaigns" (readiness-bar criterion 5, plan trap 4:
// a failed read says "unavailable", never 0 and never empty). 403 is `forbidden`; 5xx, timeouts and a module that
// is off are `unavailable`, with words the page can show.
import { platformFetch, PlatformError, type Me } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { getOrgStructure, type OrgNode } from "./org";
import { activeCompany } from "./companyContext";
import {
  normalizeCampaignDetail, normalizeDeptCampaignRow,
  type CampaignDetail, type DeptCampaignRow,
} from "./campaigns";
import type { SocialCampaign, SocialEngagement } from "./socialShared";

const agency = (t: string) => `/api/${t}/modules/agency`;
const social = (t: string) => `/api/${t}/modules/social`;

/** A 404 on a module route is `ModuleEnabledGuard`: the module is off for this company. Say that, in words. */
async function whenModuleOn<T>(p: Promise<T>, moduleName: string): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) {
      throw new PlatformError(404, `The ${moduleName} module is not turned on for this company.`);
    }
    throw e;
  }
}

// ── shared campaigns (§31.4 reads) ───────────────────────────────────────────────────────────────

/** `GET campaigns?unitId=<dept>`: the campaigns where the department has a live part or leads it. Throws on a refusal. */
export async function listSharedCampaigns(u: string, t: string, unitId: string): Promise<DeptCampaignRow[]> {
  const raw = await whenModuleOn(
    platformFetch<unknown>(`${agency(t)}/campaigns?unitId=${encodeURIComponent(unitId)}`, u),
    "Agency",
  );
  return (Array.isArray(raw) ? raw : []).flatMap((r) => {
    const row = normalizeDeptCampaignRow(r);
    return row ? [row] : [];
  });
}

export const readSharedCampaigns = (u: string, t: string, unitId: string): Promise<ReadResult<DeptCampaignRow[]>> =>
  readResult(listSharedCampaigns(u, t, unitId));

/** DW-3i: `GET campaigns` with no `unitId`: every campaign of the company, each with its lead unit, dates and `partCount` (§31.4).
 *  The company Overview's "Campaigns across departments". `part` is null on every row (no department is asked about). */
export const readAllCampaigns = (u: string, t: string): Promise<ReadResult<DeptCampaignRow[]>> =>
  readResult(
    whenModuleOn(platformFetch<unknown>(`${agency(t)}/campaigns`, u), "Agency").then((raw) => {
      // A 200 that is not a list is a broken read, never "no campaigns".
      if (!Array.isArray(raw)) throw new Error("The campaigns read returned an unexpected answer.");
      return raw.flatMap((r) => {
        const row = normalizeDeptCampaignRow(r);
        return row ? [row] : [];
      });
    }),
  );

/** `GET campaigns/:id`. `ok` with `null` is a real 404 (`campaign_not_found`): the page calls `notFound()`. */
export const readCampaignDetail = (u: string, t: string, campaignId: string): Promise<ReadResult<CampaignDetail | null>> =>
  readResult(
    platformFetch<unknown>(`${agency(t)}/campaigns/${encodeURIComponent(campaignId)}`, u).then((raw): CampaignDetail | null => {
      const detail = normalizeCampaignDetail(raw);
      // A 200 that is not a campaign is a broken read, not "no such campaign".
      if (!detail) throw new Error("The campaign read returned an unexpected answer.");
      return detail;
    }),
    { absentAsEmpty: null },
  );

export interface SharedDetails {
  /** The details that were read. */
  details: CampaignDetail[];
  /** How many could not be read (refused or failed): a caller must not treat the missing ones as "nothing linked". */
  unreadable: number;
}

/** The detail of each given shared campaign, read in parallel. Failures are counted, not hidden. */
export async function readDetailsOf(u: string, t: string, campaignIds: readonly string[]): Promise<SharedDetails> {
  const results = await Promise.all(campaignIds.map((id) => readCampaignDetail(u, t, id)));
  const details: CampaignDetail[] = [];
  let unreadable = 0;
  for (const r of results) {
    if (r.kind === "ok" && r.data) details.push(r.data);
    else unreadable += 1;
  }
  return { details, unreadable };
}

// ── names the pages show beside ids ──────────────────────────────────────────────────────────────

/** client id -> name. A failed read leaves the page saying "unavailable" for the client, not a blank. */
export const readClientNames = (u: string, t: string): Promise<ReadResult<Record<string, string>>> =>
  readResult(
    platformFetch<Array<{ id: string; name: string }>>(`/api/${t}/clients`, u).then((rows) => {
      const out: Record<string, string> = {};
      for (const c of Array.isArray(rows) ? rows : []) if (c?.id) out[c.id] = c.name;
      return out;
    }),
  );

export interface PersonChoice { id: string; name: string }

/** The company's people, for owner pickers (`GET members`, the directory the other forms use). */
export const readPersonChoices = (u: string, t: string): Promise<ReadResult<PersonChoice[]>> =>
  readResult(
    platformFetch<Array<{ user_id: string; name: string }>>(`/api/${t}/members`, u).then((rows) =>
      (Array.isArray(rows) ? rows : []).flatMap((m) => (m?.user_id ? [{ id: m.user_id, name: m.name || m.user_id }] : [])),
    ),
  );

/** The org tree root, for "is this person the head of that department". Null when it cannot be read: the page then
 *  offers owner and manager controls only, and the server still decides. */
export async function readOrgRoot(me: Me, tenantId: string): Promise<OrgNode | null> {
  const company = activeCompany(me, tenantId);
  if (!company) return null;
  try {
    return (await getOrgStructure(me.userId, tenantId, company)).structure.root;
  } catch {
    return null;
  }
}

// ── Social Media's own campaigns (§19; the existing `lib/social.ts` degrades a 404 to [] on its list readers, so this
// screen has its own ReadResult-returning variants and the other callers stay as they are) ────────────────────────────

export const readSocialCampaigns = (u: string, t: string): Promise<ReadResult<SocialCampaign[]>> =>
  readResult(
    whenModuleOn(platformFetch<unknown>(`${social(t)}/campaigns`, u), "Social Media").then((r) =>
      Array.isArray(r) ? (r as SocialCampaign[]) : [],
    ),
  );

export const readSocialEngagements = (u: string, t: string): Promise<ReadResult<SocialEngagement[]>> =>
  readResult(
    whenModuleOn(platformFetch<unknown>(`${social(t)}/engagements`, u), "Social Media").then((r) =>
      Array.isArray(r) ? (r as SocialEngagement[]) : [],
    ),
  );

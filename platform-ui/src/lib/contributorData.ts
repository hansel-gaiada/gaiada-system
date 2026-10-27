import "server-only";
import { listSites } from "./webdeskContent";
import { getEditorialBoard } from "./webdeskEditorial";
import { isSiteArchived, type WdResult } from "./webdeskContentModel";
import { buildAssignmentsView, type AssignmentsView, type SiteBoardRead } from "./contributorModel";

// M5-W1f: the contributor's "My assignments" read. Only the two routes the W1d fence opens for this: `GET .../content/sites`, then
// `GET .../editorial/board` per site (the first 100 rows each; `more` says when a site has more). The boards are read in parallel and each
// keeps its own result, so one refused or broken site is a section in words, not a missing page. See `contributorModel.ts`.
export async function loadAssignments(userId: string, company: string, meId: string): Promise<AssignmentsView> {
  const sites = await listSites(userId, company);
  if (sites.kind !== "ok") return buildAssignmentsView(sites, [], meId);
  const flat = sites.data.tenants.flatMap((t) =>
    t.sites.filter((s) => !isSiteArchived(s)).map((s) => ({ tenantSlug: t.slug, siteId: s.siteId, siteName: s.name })));
  const boards: SiteBoardRead[] = await Promise.all(
    flat.map(async (s) => ({ ...s, board: await getEditorialBoard(userId, company, s.tenantSlug, s.siteId, { limit: 100 }) })),
  );
  const asResult: WdResult<typeof flat> = { kind: "ok", data: flat };
  return buildAssignmentsView(asResult, boards, meId);
}

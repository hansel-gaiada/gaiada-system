"use server";
// GH-10 — writes for the org-wide GitHub registry's per-row link/unlink controls
// (`GithubRepoRegistry.tsx`). §25: `POST /api/:t/github/repos/:id/link` (body `{ webdevSiteId?,
// projectId? }`, at least one required) and `POST /api/:t/github/repos/:id/unlink` (body
// `{ target?: 'webdev_site'|'project'|'both' }`, default `both`) — both gated Cerbos-side by
// `github_repo:link`/`unlink` (GH-03, live), mirrored client-side by the `github.link` capability
// (rbac.ts; see that capability's own comment for the exact role citation).
//
// Same shape as every other actions file in this domain (webdevProvisionedSitesActions.ts): a
// `ctx()` resolving session -> me -> active tenant, a capability gate, then a `{ ok, error? }`
// result. `basePath` travels in the FormData (not a closure/import) because this component is
// mounted on more than one route today and must stay that way — see GithubRepoRegistry.tsx's own
// comment on why `basePath` is a required prop, not a hardcoded route.
//
// ── WHY THE CLICK NEVER APPLIES A SUGGESTION BY ITSELF ──────────────────────────────────────────
// `suggestLinkTargets` (githubRepos.ts) is pure and returns proposals only; nothing in that
// function — or in this file — links anything on its own. The only path that calls `link()` is a
// human clicking either "Confirm" on a rendered suggestion or "Link" in the manual picker, both of
// which route through `linkGithubRepoAction` with an explicit `webdevSiteId`/`projectId` the human
// picked. There is no server-side auto-apply of a suggestion anywhere in this stack.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";

export type GithubLinkActionResult =
  | { ok: true; webdevSiteId: string | null; projectId: string | null }
  | { ok: false; error: string };

interface LinkResponse {
  id: string;
  webdevSiteId: string | null;
  projectId: string | null;
}

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

/** §25's own binding ruling: "a bad link target (wrong tenant, or simply not existing) is a 400,
 *  not a 500 or a silent accept" — mapped to `{error: "webdevSiteId/projectId must belong to this
 *  tenant"}`. Surfaced close to verbatim; everything else falls back to the raw message rather than
 *  guessing at a friendlier phrasing this file has no evidence for. */
function describeLinkError(status: number, message: string): string {
  if (status === 400) return message || "That site or project doesn't belong to this company.";
  if (status === 403) return "You don't have permission to link GitHub repositories.";
  if (status === 404) return "That repository is no longer on file — reload the registry.";
  return message || `The request failed (${status}).`;
}

function revalidate(basePath: string | undefined) {
  if (basePath) revalidatePath(basePath);
}

/** The confirm-a-suggestion AND the manual-picker path — both end up here with an explicit
 *  `webdevSiteId`/`projectId` a human chose; this action has no idea (and does not need to know)
 *  whether the value came from a one-click suggestion or a `<select>`. */
export async function linkGithubRepoAction(formData: FormData): Promise<GithubLinkActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "github.link", c.tenant)) {
    return { ok: false, error: "You don't have permission to link GitHub repositories." };
  }
  const repoId = String(formData.get("repoId") ?? "").trim();
  const webdevSiteId = String(formData.get("webdevSiteId") ?? "").trim() || undefined;
  const projectId = String(formData.get("projectId") ?? "").trim() || undefined;
  const basePath = String(formData.get("basePath") ?? "").trim() || undefined;
  if (!repoId) return { ok: false, error: "repoId required." };
  // Mirrors the controller's own precondition (§25: "at least one required") — checked here too so
  // a caller gets an immediate, specific message instead of waiting on a 400 round trip.
  if (!webdevSiteId && !projectId) return { ok: false, error: "Pick a site or a project to link." };
  try {
    const repo = await platformFetch<LinkResponse>(`/api/${c.tenant}/github/repos/${repoId}/link`, c.userId, {
      method: "POST",
      body: JSON.stringify({ webdevSiteId, projectId }),
    });
    revalidate(basePath);
    return { ok: true, webdevSiteId: repo.webdevSiteId, projectId: repo.projectId };
  } catch (e) {
    revalidate(basePath);
    if (e instanceof PlatformError) return { ok: false, error: describeLinkError(e.status, e.message) };
    throw e;
  }
}

export async function unlinkGithubRepoAction(formData: FormData): Promise<GithubLinkActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "github.link", c.tenant)) {
    return { ok: false, error: "You don't have permission to unlink GitHub repositories." };
  }
  const repoId = String(formData.get("repoId") ?? "").trim();
  const target = String(formData.get("target") ?? "both").trim();
  const basePath = String(formData.get("basePath") ?? "").trim() || undefined;
  if (!repoId) return { ok: false, error: "repoId required." };
  try {
    const repo = await platformFetch<LinkResponse>(`/api/${c.tenant}/github/repos/${repoId}/unlink`, c.userId, {
      method: "POST",
      body: JSON.stringify({ target }),
    });
    revalidate(basePath);
    return { ok: true, webdevSiteId: repo.webdevSiteId, projectId: repo.projectId };
  } catch (e) {
    revalidate(basePath);
    if (e instanceof PlatformError) return { ok: false, error: describeLinkError(e.status, e.message) };
    throw e;
  }
}

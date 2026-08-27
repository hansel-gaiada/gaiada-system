"use server";
// PRV-04 — writes for the "Site & repo" card (run workspace, `/pipeline/[runId]`).
//
// Same shape as pipelineActions.ts: a `ctx()` resolving session -> me -> active tenant, gated on
// `webdev.provision` — a purpose-built capability (IAM-02a-FIX-2), NOT `approvals.decide`. This file
// originally gated on `approvals.decide` "the same elevated-dept capability already gating every
// other manual action on this page"; DR-1 (2026-08-10) then removed `approvals.decide` from
// `manager` because Cerbos denies `manager` on the three genuine approval-DECIDE surfaces, which
// also silently removed manager's access here even though Cerbos's `webdev_provisioned_site`
// policy (resource_webdev_provisioned_site.yaml, PRV-03, landed) grants `manager` `provision`/
// `reconcile` directly. `webdev.provision` mirrors that policy's in-tenant tier exactly
// (company_admin/manager; see rbac.ts's `webdev.provision` comment on `CAPABILITIES`) and is kept
// permanently separate from `approvals.decide` so this cannot regress the same way twice.
//
// Both actions revalidate the run path unconditionally, including on a THROWN error: the mirror row
// is committed to `failed/<reason>` server-side BEFORE several of the exceptions are thrown (see
// provisioning.service.ts's own comments), so a fresh GET after the throw shows the true state
// regardless of what the error body itself could carry — which matters given the documented
// `describeActionError` bug (webdevProvisionedSites.ts): the error body cannot be trusted for detail,
// only the row re-read can.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import { describeActionError, isValidSlugInput, type ProvisionedSite, type SiteFramework } from "./webdevProvisionedSites";

export type SiteActionResult =
  | { ok: true; site: ProvisionedSite }
  | { ok: false; error: string };

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

/** "Provision a new site" — the staff/manual trigger path (design §04's secondary trigger: a human
 *  click on this form IS the approval, no WS4 beat). `slug` is optional — omitting it lets the
 *  backend derive one from the run's title (`deriveRunSlug`, byte-parity with the delivery workflow's
 *  own slug expression); an explicit slug is how a `slug_conflict_foreign`/`slug_taken` retry recovers. */
export async function provisionSiteAction(formData: FormData): Promise<SiteActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "webdev.provision", c.tenant)) {
    return { ok: false, error: "You don't have permission to provision a site for this run." };
  }
  const runId = String(formData.get("runId") ?? "").trim();
  const framework = String(formData.get("framework") ?? "vite").trim() as SiteFramework;
  const slug = String(formData.get("slug") ?? "").trim();
  // Two shapes the endpoint accepts: for a run (slug optional, derived from the run title) or
  // STANDALONE — no run, explicit slug required (off-pipeline, `pipeline_run_id: null`).
  if (!runId && !slug) return { ok: false, error: "Give the repository a name, or pick a PRD run." };
  if (slug && !isValidSlugInput(slug)) {
    return { ok: false, error: "That slug isn't valid — use lowercase letters, digits and hyphens only (1-40 characters)." };
  }
  try {
    const site = await platformFetch<ProvisionedSite>(`/api/${c.tenant}/modules/webdev/provision`, c.userId, {
      method: "POST",
      body: JSON.stringify({ runId: runId || undefined, framework, slug: slug || undefined }),
    });
    if (runId) revalidatePath(`/pipeline/${runId}`);
    return { ok: true, site };
  } catch (e) {
    if (runId) revalidatePath(`/pipeline/${runId}`);
    if (e instanceof PlatformError) return { ok: false, error: describeActionError(e.status, e.message) };
    throw e;
  }
}

/** Re-poll now — also the resume path for a row that never egressed. Cerbos-gates this separately
 *  from `read` on the backend (a reconcile can cause a real egress), so it stays behind the same
 *  `webdev.provision` capability as the create form rather than being folded into a plain "refresh". */
export async function reconcileSiteAction(formData: FormData): Promise<SiteActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "webdev.provision", c.tenant)) {
    return { ok: false, error: "You don't have permission to reconcile this site." };
  }
  const runId = String(formData.get("runId") ?? "").trim();
  const siteId = String(formData.get("siteId") ?? "").trim();
  if (!siteId) return { ok: false, error: "siteId required." };
  try {
    const site = await platformFetch<ProvisionedSite>(
      `/api/${c.tenant}/modules/webdev/provisioned-sites/${siteId}/reconcile`,
      c.userId,
      { method: "POST" },
    );
    if (runId) revalidatePath(`/pipeline/${runId}`);
    return { ok: true, site };
  } catch (e) {
    if (runId) revalidatePath(`/pipeline/${runId}`);
    if (e instanceof PlatformError) return { ok: false, error: describeActionError(e.status, e.message) };
    throw e;
  }
}

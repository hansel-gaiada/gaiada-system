"use server";
// M6-P6p — "Check DNS now" as a server action: POST sites/:id/dns/recheck (FRONTEND-BFF-CONTRACT). No body. The server decides who may run it
// (`webdev_site` `update`: it can close the task); the `can()` check here is only a cosmetic early exit, and a 403 or 404 from the server comes
// back as a sentence. Nothing is claimed beyond what the server said.
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import { SiteDnsShapeError, parseRecheck, recheckRefusalSentence, type Recheck } from "./siteDnsModel";

export type RecheckResult =
  | { ok: true; task: Recheck["task"]; check: Recheck["check"] }
  | { ok: false; message: string };

/** `webdev.provision` is the closest capability the UI has: Cerbos `webdev_site` `update` is company_admin, manager and the webdev module manager,
 *  and `webdev.provision` is company_admin and manager. The module-manager tier is not mirrored (rbac.ts), so that person sees no button. */
export const RECHECK_CAPABILITY = "webdev.provision" as const;

export async function recheckSiteDnsAction(siteId: string): Promise<RecheckResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, message: recheckRefusalSentence(401) };
  const me = await getMe(userId);
  const company = await getActiveTenant(me);
  if (!company) return { ok: false, message: "No company is selected, so nothing was checked." };
  if (!can(me, RECHECK_CAPABILITY, company)) return { ok: false, message: recheckRefusalSentence(403) };
  if (typeof siteId !== "string" || siteId === "") return { ok: false, message: recheckRefusalSentence(404) };
  try {
    const body = await platformFetch<unknown>(
      `/api/${encodeURIComponent(company)}/modules/webdev/sites/${encodeURIComponent(siteId)}/dns/recheck`,
      userId,
      { method: "POST" },
    );
    const out = parseRecheck(body);
    return { ok: true, task: out.task, check: out.check };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, message: recheckRefusalSentence(e.status) };
    if (e instanceof SiteDnsShapeError) {
      return { ok: false, message: `The check was sent, but the answer did not match the contract (${e.message}). Reload the page to see the task as it is now.` };
    }
    return { ok: false, message: recheckRefusalSentence(0) };
  }
}

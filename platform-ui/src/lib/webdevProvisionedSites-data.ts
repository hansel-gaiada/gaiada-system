import "server-only";
// PRV-04 — thin reader over the webdev module's provisioned-sites GET (webdev.controller.ts).
//
// Deliberately does NOT use the lib/pipeline.ts `safe()` convention of folding 403 and 404 into the
// same []. On this exact page (`/pipeline/[runId]`) that distinction already matters — see the
// `project`/`projectRefused` handling in page.tsx, kept apart for the same reason documented there:
// coalescing a refusal into an empty result is "a confident wrong answer" (agentic-native bar
// criterion 5 — never let an empty result read as no-data). Concretely, two very different reasons a
// GET here can come back non-200:
//   404 — `ModuleEnabledGuard("webdev")`: the webdev module simply isn't turned on for this company.
//         Not a refusal, not a state to alarm over — the feature doesn't exist here yet.
//   403 — Cerbos denied `webdev_provisioned_site.read` for this principal. A REAL refusal, and while
//         PRV-03 (the Cerbos policy) hasn't merged, this is what EVERY call returns today (see this
//         ticket's own brief: "everything currently 403s"). Rendering that as "no site provisioned"
//         would be actively misleading once a site really has been provisioned by someone else.
import { platformFetch, PlatformError } from "./platform";
import type { ProvisionedSite } from "./webdevProvisionedSites";

export type ListSitesResult =
  | { ok: true; sites: ProvisionedSite[] }
  | { ok: false; reason: "not_enabled" | "refused" };

export async function listProvisionedSitesForRun(
  userId: string,
  tenant: string,
  runId: string,
): Promise<ListSitesResult> {
  try {
    const sites = await platformFetch<ProvisionedSite[]>(
      `/api/${tenant}/modules/webdev/provisioned-sites?runId=${encodeURIComponent(runId)}`,
      userId,
    );
    return { ok: true, sites };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) return { ok: false, reason: "not_enabled" };
    if (e instanceof PlatformError && e.status === 403) return { ok: false, reason: "refused" };
    throw e;
  }
}

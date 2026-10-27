"use server";
// M5-W1f: the one server action the contributor's editor needs beyond the staff ones it shares (`saveItemAction`, `previewItemAction`,
// `getItemHeadAction`, and the review panel's actions: all of them are on routes the W1d fence opens). The editor's "refresh" re-reads the
// whole bundle, and the staff one also asks for pending publish requests and the build status, which the fence refuses (and no publish bar
// is drawn for a contributor), so this one leaves those two reads out.
import { getSessionUserId } from "./session-server";
import { getMe } from "./platform";
import { getActiveTenant } from "./tenant";
import { loadEditorBundle, type EditorBundle } from "./webdeskContent";
import type { WdResult } from "./webdeskContentModel";

export async function refreshContributorEditorAction(
  scope: { tenantSlug: string; siteId: string }, collectionKey: string, slug: string, locale: string,
): Promise<WdResult<EditorBundle>> {
  const userId = await getSessionUserId();
  if (!userId) return { kind: "unavailable", code: "upstream_error", reason: "session_expired" };
  const me = await getMe(userId);
  const company = await getActiveTenant(me);
  if (!company) return { kind: "unavailable", code: "upstream_error", reason: "no_active_company" };
  const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");
  if (!clean(scope?.tenantSlug) || !clean(scope?.siteId) || !clean(collectionKey) || !clean(slug) || !clean(locale)) return { kind: "invalid", issues: [], message: "Missing site." };
  return loadEditorBundle(userId, company, scope.tenantSlug, scope.siteId, collectionKey, slug, locale, { skipPublishReads: true });
}

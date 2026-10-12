"use server";
// M5-W6 — the editor's AI assist call. Same shape as `webdeskEditorialActions.ts`: a `ctx()` resolving session -> me -> active company,
// then a typed result. There is NO `can(me, …)` gate: whether to OFFER the drawer comes from the item read's `allowed.update`, and the BFF
// checks `update` on the item again before it looks at the body (a denial is a 403 for any body, and neither the budget nor the gateway is
// touched). A refusal comes back as DATA (`AssistResult`), never thrown, so the drawer can say it in words.
//
// This action SUGGESTS. It sends no write to WebDesk and returns text to the caller; a person applies a suggestion to the editor's draft
// and saves it through `saveItemAction`. Nothing here logs: no prompt, suggestion or error body.
//
//   POST …/sites/:t/:s/items/:itemId/assist   {kind, version?}   -> 200 {kind, itemId, version, headVersion, locale, advisory: true, suggestions[], …}
import { getSessionUserId } from "./session-server";
import { getMe } from "./platform";
import { getActiveTenant } from "./tenant";
import { runAssist } from "./webdeskAssist";
import { isAssistKind, type AssistResult } from "./webdeskAssistModel";

export interface AssistScope { tenantSlug: string; siteId: string }

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");
const no = (message: string): AssistResult => ({ ok: false, failure: { kind: "bad_request", message } });

export async function assistAction(scope: AssistScope, itemId: string, kind: string, version?: number): Promise<AssistResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, failure: { kind: "session" } };
  const me = await getMe(userId);
  const company = await getActiveTenant(me);
  if (!company) return { ok: false, failure: { kind: "unavailable", reason: "no_active_company" } };
  if (!clean(scope?.tenantSlug) || !clean(scope?.siteId) || !clean(itemId)) return no("Missing site or item.");
  if (!isAssistKind(kind)) return no("Choose one of the assist actions.");
  if (version !== undefined && !(Number.isInteger(version) && version >= 1)) return no("That version isn't valid.");
  return runAssist(userId, company, clean(scope.tenantSlug), clean(scope.siteId), clean(itemId), kind, version);
}

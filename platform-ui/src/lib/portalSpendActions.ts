"use server";
// SCP-4b (BFF §63.11 "The portal's approvals"): the client's WRITES on `/portal/approvals`' Boost budgets section: agree or decline a month's boost budget, approve or decline a boost
// that is over the budget.
//
//   decideBoostBudget   `POST portal/social/spend/budgets/:proposalId/decide`   `{decision: 'agree'|'decline', note?}`
//   decideBoost         `POST portal/social/spend/boosts/:boostId/decide`       `{decision: 'approve'|'decline', note?}`
//
// RESULT SHAPE: `{ok, code?, error?, field?, alreadyDecided?}`, like `portalSocialActions.ts`. A replay of the same decision is 200 `{alreadyDecided: true}`, which the section shows as already
// done; a different one is 409 `budget_already_decided` or `boost_already_decided`. The server checks the contact (Cerbos `portal` · `approve_spend`), the target's client, the signing
// capability (403 `view_only` for a viewer) and, for a lower budget, what is already committed. NOTHING HERE DECIDES ANYTHING; the client never sees our fees (the server sends none).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActivePortalCompany } from "./portal-company";
import { boostRefusalText } from "./socialBoosts";
import { refusalFromBody } from "./socialPipeline";

export interface PortalSpendResult { ok: boolean; code?: string; error?: string; field?: string; alreadyDecided?: boolean }

async function decide(path: (tenant: string) => string, body: Record<string, unknown>): Promise<PortalSpendResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, code: "session_expired", error: "Your session has expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return { ok: false, error: "No client account is linked to your sign-in." };
  try {
    const raw = await platformFetch<unknown>(path(tenant), userId, { method: "POST", body: JSON.stringify(body) });
    revalidatePath("/portal/approvals");
    revalidatePath("/portal");
    const already = raw !== null && typeof raw === "object" && (raw as { alreadyDecided?: unknown }).alreadyDecided === true;
    return { ok: true, ...(already ? { alreadyDecided: true } : {}) };
  } catch (e) {
    if (e instanceof PlatformError) {
      const r = refusalFromBody(e.status, e.message, e.body, e.field, e.reason);
      return { ok: false, code: e.message, error: boostRefusalText(r), field: e.field };
    }
    throw e;
  }
}

const withNote = (decision: string, note: string | undefined): Record<string, unknown> => {
  const n = note?.trim();
  return n ? { decision, note: n } : { decision };
};

/** Agree to or decline a month's boost budget proposal. */
export async function decideBoostBudget(proposalId: string, decision: "agree" | "decline", note?: string): Promise<PortalSpendResult> {
  if (!proposalId) return { ok: false, error: "Missing proposal." };
  return decide((t) => `/api/${encodeURIComponent(t)}/portal/social/spend/budgets/${encodeURIComponent(proposalId)}/decide`, withNote(decision, note));
}

/** Approve or decline a boost that is over the agreed monthly budget. */
export async function decideBoost(boostId: string, decision: "approve" | "decline", note?: string): Promise<PortalSpendResult> {
  if (!boostId) return { ok: false, error: "Missing boost." };
  return decide((t) => `/api/${encodeURIComponent(t)}/portal/social/spend/boosts/${encodeURIComponent(boostId)}/decide`, withNote(decision, note));
}

"use server";
// UI-01c / UI-02b — the finance write path: the cap table and accounting settings.
//
// Mirrors the `ctx()`/`send()` convention every other actions file in this codebase uses
// (session -> tenant -> platformFetch, PlatformError message surfaced verbatim).
//
// ── WHY NOTHING IS RE-VALIDATED HERE ────────────────────────────────────────────────────────────
// The rules these forms can break all live in the database: PKP cannot be turned off with PPN
// posted, an NPWP must be 15 or 16 digits, the fiscal year start cannot move once a calendar
// exists, an ownership edge needs exactly one holder. Every one raises a `FINANCE_*` exception that
// `FinanceErrorFilter` maps to a 409 or 400 carrying the database's own message.
//
// So this file surfaces that message rather than pre-empting it. A second copy of a rule in a form
// is a second thing to drift, and the copy that drifts is always the one the user sees — they get
// "looks fine to me" from the form and a refusal from the server, or worse, the reverse.
//
// ── RBAC HERE IS DEFENCE IN DEPTH, NOT THE BOUNDARY ─────────────────────────────────────────────
// `finance_ownership` is a distinct Cerbos kind precisely because writing an ownership edge confers
// authorization scope. Cerbos is the boundary; `lib/rbac.ts` has no capability for it and this file
// deliberately does not invent one — a UI mirror that guessed at this grant would either hide the
// surface from someone who holds it or show it to someone who does not, and both are worse than
// letting the server answer.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";

export type FinanceActionResult<T = undefined> = { ok: boolean; error?: string; result?: T };

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

async function send<T>(path: string, body: unknown): Promise<FinanceActionResult<T>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const result = await platformFetch<T>(`/api/${c.tenant}${path}`, c.userId, {
      method: "POST",
      body: JSON.stringify(body),
    });
    revalidatePath("/finance/ownership");
    revalidatePath("/finance/settings");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) {
      // Verbatim. The database wrote a message worth reading — "this company has PPN posted
      // (balance 11000000). Turning PKP off would orphan tax already charged" — and replacing it
      // with "Could not save" would throw away the only part that tells the user what to do.
      return { ok: false, error: e.message };
    }
    throw e;
  }
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────
export async function updateFinanceSettings(input: {
  isPkp?: boolean;
  npwp?: string | null;
  functionalCurrency?: string;
  presentationCurrency?: string;
}): Promise<FinanceActionResult> {
  return send("/finance/settings", input);
}

// ── Cap table ───────────────────────────────────────────────────────────────────────────────────
export async function createOwnershipEdge(input: {
  holderUserId?: string | null;
  holderCompanyId?: string | null;
  kind: "holding" | "shareholder";
  stakePct?: string | null;
  effectiveFrom: string;
  notes?: string;
}): Promise<FinanceActionResult<{ id: string }>> {
  return send("/finance/ownership", input);
}

/**
 * END-DATE an edge. There is no delete, here or anywhere in this family.
 *
 * Named `endOwnershipEdge` rather than `removeOwnershipEdge` on purpose: the button says "End", the
 * action says "end", and the row does not disappear from history. A "remove" name would invite the
 * next author to add the DELETE the policy declines to offer.
 */
export async function endOwnershipEdge(edgeId: string, effectiveTo: string): Promise<FinanceActionResult> {
  return send(`/finance/ownership/${edgeId}/end`, { effectiveTo });
}

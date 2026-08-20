"use server";
// P2-14 — the four account actions. Thin wrappers over P2-13's endpoints; Cerbos is the real boundary
// and `canManageIT` here is defence in depth, the same posture as `it/devices/actions.ts`.
//
// ⚠ THE INITIAL PASSWORD IS RETURNED TO THE CALLER AND NOWHERE ELSE. The backend generates it, never
// stores it, and never writes it to the audit trail. These actions therefore return it in the result
// object for the page to render ONCE, and deliberately do not `revalidatePath` before the caller has
// shown it — a redirect-and-refresh would drop the only copy that exists.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { canManageIT } from "@/components/shell/nav";

export type ActionResult =
  | { ok: true; message: string; password?: string; email?: string }
  | { ok: false; error: string };

/** The typed tokens P2-13 leads its `error` string with, mapped to something an operator can act on.
 *  Matching on a PREFIX rather than equality because the backend appends context after the token —
 *  and the token is the contract, the sentence after it is not. */
function humanize(err: unknown): string {
  const raw = err instanceof PlatformError ? err.message : (err as Error)?.message ?? "unknown error";
  if (raw.startsWith("keycloak_admin_not_configured")) {
    return "Account management is not available in this environment — the identity provider's admin client is not configured.";
  }
  if (raw.startsWith("keycloak_admin_failed")) {
    return "The identity provider rejected the request. This is an upstream failure, not a permission problem — try again.";
  }
  if (raw.startsWith("not_a_member")) {
    return "That person is not an active staff member of this company.";
  }
  if (raw.startsWith("no_keycloak_account")) {
    return "There is no account for this person yet. Provision one first.";
  }
  return raw;
}

async function guard(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "You are not signed in." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  if (!canManageIT(me, tenant)) return { error: "You don't have permission to manage accounts in this company." };
  return { userId, tenant };
}

export async function provisionAccount(formData: FormData): Promise<ActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };
  const targetUserId = String(formData.get("userId") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  if (!targetUserId) return { ok: false, error: "Missing user." };

  try {
    const res = await platformFetch<{ keycloakId: string; initialPassword: string | null; adopted: boolean }>(
      `/api/${g.tenant}/it/accounts/${targetUserId}/provision`,
      g.userId,
      { method: "POST", body: "{}" },
    );
    revalidatePath("/it/accounts");
    if (res.adopted) {
      // Not a failure and not a no-op: an account already existed and has now been linked. Saying so
      // matters, because the operator asked for a new login and did not get a password.
      return {
        ok: true,
        message: `An account for ${email} already existed and has been linked. No password was set — use "Reset password" if they need one.`,
        email,
      };
    }
    return { ok: true, message: `Account created for ${email}.`, password: res.initialPassword ?? undefined, email };
  } catch (err) {
    return { ok: false, error: humanize(err) };
  }
}

export async function disableAccount(formData: FormData): Promise<ActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };
  const targetUserId = String(formData.get("userId") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  try {
    const res = await platformFetch<{ ok: true; alreadyDisabled: boolean }>(
      `/api/${g.tenant}/it/accounts/${targetUserId}/disable`,
      g.userId,
      { method: "POST", body: "{}" },
    );
    revalidatePath("/it/accounts");
    return {
      ok: true,
      message: res.alreadyDisabled ? `${email} was already disabled — nothing changed.` : `${email} disabled.`,
    };
  } catch (err) {
    return { ok: false, error: humanize(err) };
  }
}

export async function enableAccount(formData: FormData): Promise<ActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };
  const targetUserId = String(formData.get("userId") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  try {
    const res = await platformFetch<{ ok: true; alreadyEnabled: boolean }>(
      `/api/${g.tenant}/it/accounts/${targetUserId}/enable`,
      g.userId,
      { method: "POST", body: "{}" },
    );
    revalidatePath("/it/accounts");
    return {
      ok: true,
      message: res.alreadyEnabled ? `${email} was already enabled — nothing changed.` : `${email} enabled.`,
    };
  } catch (err) {
    return { ok: false, error: humanize(err) };
  }
}

export async function resetAccountPassword(formData: FormData): Promise<ActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };
  const targetUserId = String(formData.get("userId") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  // The backend accepts a null reason, but this surface requires one: resetting somebody else's
  // password is the action most likely to be questioned later, and the reason is what answers it.
  if (!reason) return { ok: false, error: "A reason is required — it is recorded in the audit trail." };

  try {
    const res = await platformFetch<{ ok: true; initialPassword: string }>(
      `/api/${g.tenant}/it/accounts/${targetUserId}/reset-password`,
      g.userId,
      { method: "POST", body: JSON.stringify({ reason }) },
    );
    revalidatePath("/it/accounts");
    return { ok: true, message: `Password reset for ${email}.`, password: res.initialPassword, email };
  } catch (err) {
    return { ok: false, error: humanize(err) };
  }
}

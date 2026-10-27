"use server";
// SCP-Sb (BFF §63.1 file 8): the client page's "Seed simulated accounts" action.
//
//   seedSimulatedAccounts   `POST engagements/:engagementId/simulated-accounts`   (social_engagement · plan: the four approvers; 409 simulation_disabled while the
//                           server's SOCIAL_SIMULATION_ENABLED is off)
//
// The gate in the screen is a hint; the server's 403 is the boundary. A refusal comes back as the contract's own code in `error` and the words for it in `message`.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { asSeedAnswer, seedRefusalText, type SeededAccountView } from "./socialSimulatedAccounts";

export type SeedActionResult = { ok: true; accounts: SeededAccountView[] } | { ok: false; error: string; message: string };

/** The refusal's machine code: the typed `code` the simulator's own refusals carry (409 `simulation_disabled` is `{error: <sentence>, code}`), else `error`. */
function codeOf(e: PlatformError): string {
  const code = e.body !== null && typeof e.body === "object" ? (e.body as { code?: unknown }).code : undefined;
  return typeof code === "string" && code ? code : e.message;
}

export async function seedSimulatedAccounts(engagementId: string): Promise<SeedActionResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "session_expired", message: seedRefusalText("session_expired") };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "no_company", message: "No active company selected." };
  try {
    const raw = await platformFetch<unknown>(
      `/api/${encodeURIComponent(tenant)}/modules/social/engagements/${encodeURIComponent(engagementId)}/simulated-accounts`, userId,
      { method: "POST", body: JSON.stringify({}) },
    );
    revalidatePath("/departments", "layout");
    return { ok: true, accounts: asSeedAnswer(raw) };
  } catch (e) {
    if (e instanceof PlatformError) {
      const code = codeOf(e);
      return { ok: false, error: code, message: seedRefusalText(code) };
    }
    throw e;
  }
}

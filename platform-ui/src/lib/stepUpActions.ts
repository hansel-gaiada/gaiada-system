"use server";
// PV5-14 / PV-D40 — the two server actions behind the "Simulate second factor (dev stage)" button (BFF §1). Both
// run as the signed-in user's own session (`platformFetch` presents the OIDC access token, whose IdP session the
// platform binds the step-up to). The platform decides everything: who may, for how long, what it unlocks.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { platformFetch, PlatformError } from "./platform";
import type { StepUpSimulated, StepUpStatus } from "./stepUp";

/** The caller's step-up status, or null when simulation is off (the route 404s), signed out, or unreachable. */
export async function getStepUpStatusAction(): Promise<StepUpStatus | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  try {
    return await platformFetch<StepUpStatus>("/api/auth/step-up", userId);
  } catch {
    return null;
  }
}

export type SimulateResult = { ok: true; expiresAt: string } | { ok: false; error: string; reason?: string };

export async function simulateSecondFactorAction(): Promise<SimulateResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Your session has expired. Sign in again." };
  try {
    const r = await platformFetch<StepUpSimulated>("/api/auth/step-up/simulate", userId, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    // Every page renders `/api/me` afresh, which now carries the simulated assurance for the header badge.
    revalidatePath("/", "layout");
    return { ok: true, expiresAt: r.expiresAt };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 404) return { ok: false, error: "Simulating a second factor is switched off on this server." };
      return { ok: false, error: e.message, ...(e.reason ? { reason: e.reason } : {}) };
    }
    throw e;
  }
}

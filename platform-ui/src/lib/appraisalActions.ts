"use server";
// TR-26 — the appraisal write path. Mirrors pmActions.ts's `ctx()`/`send()` convention exactly
// (session -> tenant -> platformFetch, PlatformError message surfaced verbatim). RBAC gating here
// is defence-in-depth only, per every other action file in this codebase — the real boundary is
// Cerbos + appraisals.controller.ts's exact-manager-match narrowing (see that file's header).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can, type Capability } from "./rbac";
import type { AppraisalAxis, AppraisalCycleRow, AppraisalPack, GenerateResult, GenerateRoster } from "./appraisals";

export type AppraisalActionResult<T = undefined> = { ok: boolean; error?: string; field?: string; result?: T };

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

async function send<T>(path: string, method: string, bodyObj: unknown, cap?: Capability, me?: Me, tenant?: string): Promise<AppraisalActionResult<T>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (cap && !can(me ?? c.me, cap, tenant ?? c.tenant)) return { ok: false, error: "You don't have permission for this action." };
  try {
    const result = await platformFetch<T>(`/api/${c.tenant}${path}`, c.userId, {
      method, ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
    });
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message, field: e.field };
    throw e;
  }
}

// ---------------- cycle CRUD (appraisal.cycle.admin) ----------------

export interface CreateCycleInput {
  name: string; periodStart: string; periodEnd: string;
  defaultWeights?: Record<AppraisalAxis, number>;
  roleWeights?: Record<string, Record<AppraisalAxis, number>>;
}

export async function createAppraisalCycle(input: CreateCycleInput): Promise<AppraisalActionResult<AppraisalCycleRow>> {
  const r = await send<AppraisalCycleRow>("/appraisals/cycles", "POST", input, "appraisal.cycle.admin");
  if (r.ok) revalidatePath("/appraisals/cycles");
  return r;
}

export interface PatchCycleInput {
  name?: string; periodStart?: string; periodEnd?: string;
  status?: "draft" | "open" | "in_review" | "closed";
  defaultWeights?: Record<AppraisalAxis, number>;
  roleWeights?: Record<string, Record<AppraisalAxis, number>>;
}

export async function patchAppraisalCycle(id: string, input: PatchCycleInput): Promise<AppraisalActionResult<AppraisalCycleRow>> {
  const r = await send<AppraisalCycleRow>(`/appraisals/cycles/${id}`, "PATCH", input, "appraisal.cycle.admin");
  if (r.ok) { revalidatePath("/appraisals/cycles"); revalidatePath(`/appraisals/cycles/${id}`); }
  return r;
}

export async function generateAppraisals(cycleId: string, subjects: GenerateRoster[]): Promise<AppraisalActionResult<GenerateResult>> {
  const r = await send<GenerateResult>(`/appraisals/cycles/${cycleId}/generate`, "POST", { subjects }, "appraisal.cycle.admin");
  if (r.ok) { revalidatePath(`/appraisals/cycles/${cycleId}`); revalidatePath("/appraisals"); }
  return r;
}

// ---------------- manager scoring (draft-only; appraisal.score, exact-manager-narrowed server-side) ----------------

export interface PatchScoresInput {
  scores?: Partial<Record<AppraisalAxis, { manager?: number | null; note?: string }>>;
  commentary?: string;
  confirmEvidence?: boolean;
}

export async function patchAppraisalScores(id: string, input: PatchScoresInput): Promise<AppraisalActionResult<AppraisalPack>> {
  const r = await send<AppraisalPack>(`/appraisals/${id}`, "PATCH", input, "appraisal.score");
  if (r.ok) { revalidatePath(`/appraisals/${id}`); revalidatePath("/appraisals"); }
  return r;
}

export async function submitAppraisal(id: string, commentary?: string): Promise<AppraisalActionResult<AppraisalPack>> {
  const r = await send<AppraisalPack>(`/appraisals/${id}/submit`, "POST", { commentary }, "appraisal.score");
  if (r.ok) { revalidatePath(`/appraisals/${id}`); revalidatePath("/appraisals"); revalidatePath("/appraisals/mine"); }
  return r;
}

/** HR/manager re-confirms evidence after an `evidence_stale` flag (§15) — no capability gate beyond
 *  "appraisal.read" tier since either the assigned manager OR HR may confirm; the server is the
 *  real narrowing boundary (patchAppraisal's `actorIsManager || actorIsHr`). */
export async function confirmAppraisalEvidence(id: string): Promise<AppraisalActionResult<AppraisalPack>> {
  const r = await send<AppraisalPack>(`/appraisals/${id}`, "PATCH", { confirmEvidence: true }, "appraisal.read");
  if (r.ok) { revalidatePath(`/appraisals/${id}`); }
  return r;
}

// ---------------- ack / dispute (subject only; no capability — self-service like check-ins) --------

export async function ackAppraisal(id: string, action: "acknowledged" | "disputed", comment?: string): Promise<AppraisalActionResult<AppraisalPack>> {
  const r = await send<AppraisalPack>(`/appraisals/${id}/ack`, "POST", { action, comment });
  if (r.ok) { revalidatePath(`/appraisals/${id}`); revalidatePath("/appraisals/mine"); }
  return r;
}

// ---------------- finalize (HR only; blocked while evidence_stale) ----------------

export async function finalizeAppraisal(id: string): Promise<AppraisalActionResult<AppraisalPack>> {
  const r = await send<AppraisalPack>(`/appraisals/${id}/finalize`, "POST", undefined, "appraisal.cycle.admin");
  if (r.ok) { revalidatePath(`/appraisals/${id}`); revalidatePath("/appraisals"); revalidatePath("/appraisals/mine"); }
  return r;
}

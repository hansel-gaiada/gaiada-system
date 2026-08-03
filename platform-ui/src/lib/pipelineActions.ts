"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";

export type PipelineResult = { ok: boolean; error?: string };

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

/** Decide an INTERNAL pipeline gate (PM review / approval). Gated on approvals.decide; the backend
 *  Cerbos policy is the real boundary. Client-side gates (PRD sign / scope / feedback) are decided
 *  in the client portal, not here.
 *
 *  WD-02: callers from the run workspace (`/pipeline/[runId]`) additionally pass a hidden `runId`
 *  field so that page also revalidates (the list page's own decide form omits it, which is fine —
 *  revalidatePath is a no-op for a path that wasn't rendered). */
export async function decideGateAction(formData: FormData): Promise<PipelineResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "approvals.decide", c.tenant)) return { ok: false, error: "You don't have permission to decide gates." };
  const gateId = String(formData.get("gateId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const note = String(formData.get("note") ?? "");
  const runId = String(formData.get("runId") ?? "");
  if (!gateId || !decision) return { ok: false, error: "gateId and decision required." };
  try {
    await platformFetch(`/api/${c.tenant}/pipeline/gates/${gateId}/decide`, c.userId, {
      method: "POST",
      body: JSON.stringify({ decision, note: note || undefined }),
    });
    revalidatePath("/pipeline");
    if (runId) revalidatePath(`/pipeline/${runId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

/** WD-03 (D-3) — edit a stage's drafted artifact from the run workspace. Gated on approvals.decide
 *  in the UI (same elevated set the backend's Cerbos policy allows for `pipeline_stage.update` —
 *  company_admin/manager/group_executive, non-elevated members denied); the BACKEND remains the
 *  real authority, including the signature lock: once the stage's client sign gate is decided, the
 *  PATCH 409s and this surfaces that as a plain "locked" message rather than a raw error. */
export async function editStageArtifactAction(formData: FormData): Promise<PipelineResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "approvals.decide", c.tenant)) return { ok: false, error: "You don't have permission to edit this artifact." };
  const stageId = String(formData.get("stageId") ?? "");
  const artifactRef = String(formData.get("artifactRef") ?? "");
  const runId = String(formData.get("runId") ?? "");
  if (!stageId) return { ok: false, error: "stageId required." };
  try {
    await platformFetch(`/api/${c.tenant}/pipeline/stages/${stageId}`, c.userId, {
      method: "PATCH",
      body: JSON.stringify({ artifactRef }),
    });
    revalidatePath("/pipeline");
    if (runId) revalidatePath(`/pipeline/${runId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 409) return { ok: false, error: "Locked — the client has already signed this stage. What they signed can't be edited." };
      return { ok: false, error: e.message };
    }
    throw e;
  }
}

// B1 (gap-assessment §B) — the agency's half of the scope dual-sign. Before this the app had no way
// to record it at all (only a curl against the backend could); "party" is always "provider" here —
// the client's own countersignature arrives through the separate portal BFF, never this action.
// Gated the same as every other elevated pipeline write (`approvals.decide` == company_admin/manager/
// group_executive), which now matches the backend's `scope_signoff.create` Cerbos rule exactly
// (widened 2026-08-03 to include `manager` — see resource_scope_signoff.yaml).
export async function recordScopeSignoffAction(formData: FormData): Promise<PipelineResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "approvals.decide", c.tenant)) return { ok: false, error: "You don't have permission to record the agency's scope sign-off." };
  const runId = String(formData.get("runId") ?? "");
  const signerName = String(formData.get("signerName") ?? "").trim();
  if (!runId) return { ok: false, error: "runId required." };
  try {
    await platformFetch(`/api/${c.tenant}/pipeline/runs/${runId}/scope-signoffs`, c.userId, {
      method: "POST",
      body: JSON.stringify({ party: "provider", signerName: signerName || undefined }),
    });
    revalidatePath("/pipeline");
    revalidatePath(`/pipeline/${runId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// B3 — a run-lifecycle recovery tool: park/unblock/re-status a stuck run by hand. Same elevated
// gate as the rest of this file; the backend's own status enum is the real validation (a bad value
// 400s and surfaces as a plain message rather than a raw platform error).
export async function updateRunStatusAction(formData: FormData): Promise<PipelineResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "approvals.decide", c.tenant)) return { ok: false, error: "You don't have permission to change a run's status." };
  const runId = String(formData.get("runId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!runId || !status) return { ok: false, error: "runId and status required." };
  try {
    await platformFetch(`/api/${c.tenant}/pipeline/runs/${runId}`, c.userId, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    revalidatePath("/pipeline");
    revalidatePath(`/pipeline/${runId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// B4 — add a beat by hand when automation didn't create one. Recovery tool, same elevated gate.
export async function createStageAction(formData: FormData): Promise<PipelineResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "approvals.decide", c.tenant)) return { ok: false, error: "You don't have permission to add a stage." };
  const runId = String(formData.get("runId") ?? "");
  const track = String(formData.get("track") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!runId || !track || !name) return { ok: false, error: "runId, track and name required." };
  try {
    await platformFetch(`/api/${c.tenant}/pipeline/runs/${runId}/stages`, c.userId, {
      method: "POST",
      body: JSON.stringify({ track, name }),
    });
    revalidatePath("/pipeline");
    revalidatePath(`/pipeline/${runId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// B5 — open a review gate manually, the only recovery when a workflow missed one. Recovery tool,
// same elevated gate.
export async function openGateAction(formData: FormData): Promise<PipelineResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "approvals.decide", c.tenant)) return { ok: false, error: "You don't have permission to open a gate." };
  const runId = String(formData.get("runId") ?? "");
  const kind = String(formData.get("kind") ?? "");
  const actorSide = String(formData.get("actorSide") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!runId || !kind || !actorSide) return { ok: false, error: "runId, kind and actorSide required." };
  try {
    await platformFetch(`/api/${c.tenant}/pipeline/gates`, c.userId, {
      method: "POST",
      body: JSON.stringify({ runId, kind, actorSide, note: note || undefined }),
    });
    revalidatePath("/pipeline");
    revalidatePath(`/pipeline/${runId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

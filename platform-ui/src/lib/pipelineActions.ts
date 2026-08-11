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

/** WD-03 (D-3) — edit a stage's drafted artifact from the run workspace. Gated on `pipeline.manage`
 *  (IAM-02a-FIX-2 — was `approvals.decide` until that capability was split; see rbac.ts's
 *  `pipeline.manage` comment), which mirrors the backend's Cerbos policy for `pipeline_stage.update`
 *  exactly — company_admin/manager/group_executive, non-elevated members denied. The BACKEND remains
 *  the real authority, including the signature lock: once the stage's client sign gate is decided,
 *  the PATCH 409s and this surfaces that as a plain "locked" message rather than a raw error. */
export async function editStageArtifactAction(formData: FormData): Promise<PipelineResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "pipeline.manage", c.tenant)) return { ok: false, error: "You don't have permission to edit this artifact." };
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
// Gated on `pipeline.manage` (IAM-02a-FIX-2 — was `approvals.decide` until that capability was split),
// which matches the backend's `scope_signoff.create` Cerbos rule exactly: company_admin/manager/
// group_executive (widened 2026-08-03 to include `manager` — see resource_scope_signoff.yaml),
// member and team_lead both still excluded.
export async function recordScopeSignoffAction(formData: FormData): Promise<PipelineResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "pipeline.manage", c.tenant)) return { ok: false, error: "You don't have permission to record the agency's scope sign-off." };
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

// B3 — a run-lifecycle recovery tool: park/unblock/re-status a stuck run by hand. Gated on
// `pipeline.write` (IAM-02a-FIX-2 — was `approvals.decide`), matching `pipeline_run.update`'s Cerbos
// rule exactly (company_admin/manager/member); the backend's own status enum is the real validation
// (a bad value 400s and surfaces as a plain message rather than a raw platform error).
export async function updateRunStatusAction(formData: FormData): Promise<PipelineResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "pipeline.write", c.tenant)) return { ok: false, error: "You don't have permission to change a run's status." };
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

// B4 — add a beat by hand when automation didn't create one. Recovery tool, gated on `pipeline.write`
// (IAM-02a-FIX-2 — was `approvals.decide`), matching `pipeline_stage.create`'s Cerbos rule exactly
// (company_admin/manager/member).
export async function createStageAction(formData: FormData): Promise<PipelineResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "pipeline.write", c.tenant)) return { ok: false, error: "You don't have permission to add a stage." };
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
// gated on `pipeline.write` (IAM-02a-FIX-2 — was `approvals.decide`), matching `pipeline_gate.create`'s
// Cerbos rule exactly (company_admin/manager/member).
export async function openGateAction(formData: FormData): Promise<PipelineResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "pipeline.write", c.tenant)) return { ok: false, error: "You don't have permission to open a gate." };
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

// B2 — start a delivery run for an existing client/project WITHOUT a meeting recording.
//
// Until now every run had to originate from a captured meeting, because that is the only path the
// dispatcher creates. Real work does not always start with a recorded call: an email brief, a
// walk-in, a continuation of last quarter's project. Without this the only way to track such work
// was to fabricate a meeting, which corrupts the capture registry to satisfy a UI limitation.
//
// `sourceMeetingId` is deliberately NOT sent: leaving it null is what marks the run as
// human-originated, and it is also the dispatcher's dedupe key — inventing one would risk colliding
// with a real ingest later. clientId is REQUIRED here even though the API allows null, because a run
// with no client cannot appear in any client portal, and creating one from this form would silently
// produce work the client can never see.
//
// Gated on `pipeline.write` (IAM-02a-FIX-2 — was `approvals.decide`), matching `pipeline_run.create`'s
// Cerbos rule exactly (company_admin/manager/member).
export async function createRunAction(formData: FormData): Promise<PipelineResult & { id?: string }> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "pipeline.write", c.tenant)) return { ok: false, error: "You don't have permission to start a run." };
  const title = String(formData.get("title") ?? "").trim();
  const clientId = String(formData.get("clientId") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();
  if (!title) return { ok: false, error: "Give the run a title." };
  if (!clientId) return { ok: false, error: "Pick a client — a run with no client never reaches the portal." };
  try {
    const r = await platformFetch<{ id: string }>(`/api/${c.tenant}/pipeline/runs`, c.userId, {
      method: "POST",
      body: JSON.stringify({
        title,
        clientId,
        projectId: projectId || undefined,
        // The three extraction beats the dispatcher would have created, so the run opens in a state
        // the rest of the workspace understands rather than an empty shell with no tracks.
        stages: [
          { track: "delivery", name: "prd_extract", status: "pending" },
          { track: "report", name: "report_extract", status: "pending" },
          { track: "scope", name: "scope_extract", status: "pending" },
        ],
      }),
    });
    revalidatePath("/pipeline");
    return { ok: true, id: r.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

// B6 — repair recordings orphaned from their run.
//
// The endpoint has existed since the WD-26 sweep and was API-only, so recovering from it meant a
// curl against production. It is idempotent (only recordings still missing `pipeline_run_id` are
// selected), which is what makes it safe to expose as a button rather than a runbook step.
export async function relinkOrphanRecordingsAction(): Promise<PipelineResult & { relinked?: number }> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "approvals.decide", c.tenant)) return { ok: false, error: "You don't have permission to run the repair." };
  try {
    const r = await platformFetch<{ relinked: number }>(
      `/api/${c.tenant}/meetings/recordings/relink-orphans`,
      c.userId,
      { method: "POST" },
    );
    revalidatePath("/meetings");
    revalidatePath("/pipeline");
    return { ok: true, relinked: r.relinked };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

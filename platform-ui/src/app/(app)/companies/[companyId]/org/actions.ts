"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { can } from "@/lib/rbac";
import { persistOrgStructure, sanitizeStructure } from "@/lib/org";
import {
  dryRunConnectService, proposeConnectService, listAssignmentsForUnit, acceptAssignment,
  suspendAssignment, resumeAssignment, revokeAssignment, relinkAssignment, reconcileAssignment,
  type AssignmentSummary, type DryRunResult, type ProposeResult,
} from "@/lib/serviceAssignments";

export interface SaveOrgState {
  ok: boolean;
  error?: string;
  source?: "backend" | "local";
  savedAt?: string;
}

// Persist a company's org structure. Elevated-only (superadmin/owner) — the UI
// hides the editor for everyone else, and this re-checks server-side.
export async function saveOrg(companyId: string, treeJson: string): Promise<SaveOrgState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Not signed in." };
  const me = await getMe(userId);
  if (!me.companies.some((c) => c.id === companyId)) return { ok: false, error: "Unknown company." };
  if (!can(me, "org.edit", companyId)) return { ok: false, error: "Only owners and administrators can edit the org structure." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(treeJson);
  } catch {
    return { ok: false, error: "Invalid structure." };
  }

  const savedAt = new Date().toISOString();
  const structure = { ...sanitizeStructure(parsed, "Company"), updatedAt: savedAt };
  try {
    const source = await persistOrgStructure(userId, companyId, structure);
    revalidatePath(`/companies/${companyId}/org`);
    return { ok: true, source, savedAt };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    return { ok: false, error: "Couldn't save the org structure." };
  }
}

// ---------------- ORG-13: Connect-service actions ----------------
// Every action re-checks org.edit server-side (the UI only hides the button;
// the backend's own Cerbos propose/accept/revoke gate is the real boundary).

async function requireOrgEdit(companyId: string): Promise<{ userId: string } | { ok: false; error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Not signed in." };
  const me = await getMe(userId);
  if (!me.companies.some((c) => c.id === companyId)) return { ok: false, error: "Unknown company." };
  if (!can(me, "org.edit", companyId)) return { ok: false, error: "Only owners and administrators can connect a service." };
  return { userId };
}

export async function dryRunConnectServiceAction(
  companyId: string,
  nodeId: string,
  body: { targets: string[]; module: string; leadUserId?: string },
): Promise<{ ok: boolean; error?: string; result?: DryRunResult }> {
  const ctx = await requireOrgEdit(companyId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    const result = await dryRunConnectService(ctx.userId, companyId, nodeId, body);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't preview this connection." };
  }
}

export async function proposeConnectServiceAction(
  companyId: string,
  nodeId: string,
  body: { targets: string[]; module: string; leadUserId?: string },
): Promise<{ ok: boolean; error?: string; result?: ProposeResult }> {
  const ctx = await requireOrgEdit(companyId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    const result = await proposeConnectService(ctx.userId, companyId, nodeId, body);
    revalidatePath(`/companies/${companyId}/org`);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't create the service assignment." };
  }
}

export async function listNodeAssignmentsAction(companyId: string, nodeId: string): Promise<AssignmentSummary[]> {
  const userId = await getSessionUserId();
  if (!userId) return [];
  try {
    return await listAssignmentsForUnit(userId, companyId, nodeId, "provided");
  } catch {
    return [];
  }
}

export type AssignmentDecision = "suspend" | "resume" | "revoke" | "reconcile";

// Shared body; NOT exported (a "use server" file only turns its exported
// top-level functions into server actions, so this internal helper is plain
// code — the four thin wrappers below are the actual actions, each one
// individually `.bind(null, companyId)`-able for a Client Component prop
// (Next.js server actions preserve their "use server" identity through
// `.bind`, but NOT through an ad hoc wrapping arrow function — see
// ModuleToggle/RoleManager for the same bind-with-partial-args idiom).
async function decide(
  companyId: string,
  assignmentId: string,
  decision: AssignmentDecision,
): Promise<{ ok: boolean; error?: string; status?: string }> {
  const ctx = await requireOrgEdit(companyId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    let status: string | undefined;
    if (decision === "suspend") status = (await suspendAssignment(ctx.userId, companyId, assignmentId)).status;
    else if (decision === "resume") status = (await resumeAssignment(ctx.userId, companyId, assignmentId)).status;
    else if (decision === "revoke") status = (await revokeAssignment(ctx.userId, companyId, assignmentId)).status;
    else status = (await reconcileAssignment(ctx.userId, companyId, assignmentId)).status;
    revalidatePath(`/companies/${companyId}/org`);
    revalidatePath("/admin/services");
    return { ok: true, status };
  } catch (e) {
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't update the assignment." };
  }
}

export async function suspendAssignmentAction(companyId: string, assignmentId: string) {
  return decide(companyId, assignmentId, "suspend");
}
export async function resumeAssignmentAction(companyId: string, assignmentId: string) {
  return decide(companyId, assignmentId, "resume");
}
export async function revokeAssignmentAction(companyId: string, assignmentId: string) {
  return decide(companyId, assignmentId, "revoke");
}
export async function reconcileAssignmentAction(companyId: string, assignmentId: string) {
  return decide(companyId, assignmentId, "reconcile");
}

// Target-side accept (proposed -> active). Gated the same way as the
// provider-side actions (org.edit on the ACTING tenant, i.e. the target here)
// — the real boundary is Cerbos's target-only `service_assignment:accept`.
export async function acceptAssignmentAction(
  companyId: string,
  assignmentId: string,
): Promise<{ ok: boolean; error?: string; status?: string }> {
  const ctx = await requireOrgEdit(companyId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    const res = await acceptAssignment(ctx.userId, companyId, assignmentId);
    revalidatePath(`/companies/${companyId}/org`);
    revalidatePath("/admin/services");
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't accept the assignment." };
  }
}

export async function relinkAssignmentAction(
  companyId: string,
  assignmentId: string,
  nodeId: string,
): Promise<{ ok: boolean; error?: string; reconsentRequired?: boolean }> {
  const ctx = await requireOrgEdit(companyId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    const res = await relinkAssignment(ctx.userId, companyId, assignmentId, nodeId);
    revalidatePath(`/companies/${companyId}/org`);
    return { ok: true, reconsentRequired: res.reconsentRequired };
  } catch (e) {
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't re-link the assignment." };
  }
}

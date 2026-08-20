"use server";
// P2-10 / P2-11 / P2-12-FE — every IAM Phase 2 write, in one place.
//
// ── WHY THESE ARE SHARED RATHER THAN ONE actions.ts PER PAGE ─────────────────────────────────────
// Three surfaces write the same endpoints: the HR console hires and terminates, the positions admin
// assigns, the dept-head page assigns and requests. A per-page copy of "POST assign, then humanize the
// refusal" is three chances for one of them to interpret a typed token differently — and the token
// vocabulary IS the contract (`ceiling_exceeded`, `assignment_request_required`, …). One translation
// layer, three callers.
//
// ── THE REFUSALS ARE THE FEATURE ────────────────────────────────────────────────────────────────
// Most of what this file does is turn a server refusal into a sentence an operator can act on. Two of
// them are not errors at all and must never be rendered as one:
//   * `assignment_request_required` — a department head tried to place someone directly. The server is
//     telling them to PROPOSE instead. The UI's job is to offer that, not to apologise.
//   * `override_required` / `ceiling_exceeded` — the grant exceeds what this granter may give. The
//     answer is "ask someone who can", again a next step rather than a dead end.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";

/** A follow-up the UI should OFFER, never render as an error. See the file header. */
export type IamNextStep = "propose_assignment" | "request_override";

export type IamResult =
  | { ok: true; message: string; nextStep?: IamNextStep; id?: string }
  | { ok: false; error: string; nextStep?: IamNextStep };

/**
 * Typed tokens the platform leads its `error` string with (http-error.filter.ts renames `message` to
 * `error`, so the token is a PREFIX — see [[thrower-sets-message-not-error]]). Matching on prefix, not
 * equality, because the backend appends context after the token and the context is not the contract.
 */
function humanize(err: unknown): { error: string; nextStep?: IamNextStep } {
  const raw = err instanceof PlatformError ? err.message : (err as Error)?.message ?? "unknown error";
  const has = (t: string) => raw.startsWith(t) || raw.includes(t);

  if (has("assignment_request_required")) {
    return {
      error:
        "As a department head you propose a placement rather than making it directly — file a request " +
        "and HR or a company administrator decides it.",
      nextStep: "propose_assignment",
    };
  }
  if (has("ceiling_exceeded") || has("override_required")) {
    return {
      error:
        "This grant is above what you may give directly. Request an override and it will be routed to " +
        "someone who can approve it.",
      nextStep: "request_override",
    };
  }
  if (has("not_ui_grantable")) {
    return { error: "That role carries a permission that cannot be granted through the interface. It needs an owner decision, not a retry." };
  }
  if (has("elevated_role_forbidden")) {
    return { error: "Platform-tier roles cannot be granted from this surface." };
  }
  if (has("managed_grant_not_revocable")) {
    return { error: "This grant comes from a position or a service assignment, so it cannot be revoked here — change the position instead." };
  }
  if (has("self_grant_forbidden")) {
    return { error: "You cannot grant to, or place, yourself." };
  }
  if (has("denied_role_registry")) {
    return { error: "That role is on the denied-role registry and can never be attached to a position." };
  }
  if (has("employee_already_exists")) {
    return { error: "An employee with that work email already exists in this company." };
  }
  if (has("position_not_active")) {
    return { error: "That position is retired or orphaned, so nobody can be placed into it." };
  }
  if (has("not authorized")) {
    return { error: "You don't have permission to do that in this company." };
  }
  return { error: raw };
}

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "You are not signed in." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant };
}

const str = (fd: FormData, k: string): string => String(fd.get(k) ?? "").trim();

/** Every write revalidates the three surfaces that show this data, because a placement changes the HR
 *  console, the positions admin AND the dept-head roster at once. Cheap, and the alternative is a page
 *  that shows a seat as empty seconds after somebody filled it. */
function revalidateIam(): void {
  revalidatePath("/hr/people");
  revalidatePath("/organization/positions");
  revalidatePath("/organization/access");
}

// ── employees (P2-10) ────────────────────────────────────────────────────────────────────────────

export async function hireEmployee(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const displayName = str(formData, "displayName");
  const workEmail = str(formData, "workEmail");
  const positionId = str(formData, "positionId");
  if (!displayName) return { ok: false, error: "A name is required." };
  if (!workEmail) return { ok: false, error: "A work email is required — it is the joiner's natural key." };

  try {
    const res = await platformFetch<{ id: string; userId: string | null; reconciled: { granted: number } | null }>(
      `/api/${c.tenant}/hr/employees`,
      c.userId,
      {
        method: "POST",
        body: JSON.stringify({
          displayName,
          workEmail,
          ...(positionId ? { positionId } : {}),
          ...(str(formData, "legalName") ? { legalName: str(formData, "legalName") } : {}),
          ...(str(formData, "phone") ? { phone: str(formData, "phone") } : {}),
          ...(str(formData, "startDate") ? { startDate: str(formData, "startDate") } : {}),
        }),
      },
    );
    revalidateIam();
    // The distinction matters to the operator: a record without a seat confers nothing, and saying so
    // stops them assuming access was set up.
    const message = positionId
      ? `${displayName} hired and placed. ${res.reconciled?.granted ?? 0} role grant(s) applied.`
      : `${displayName} recorded. No position yet, so they have no access and no login — place them to change that.`;
    return { ok: true, message, id: res.id };
  } catch (err) {
    const h = humanize(err);
    return { ok: false, error: h.error, nextStep: h.nextStep };
  }
}

export async function transferEmployee(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const employeeId = str(formData, "employeeId");
  const toPositionId = str(formData, "toPositionId");
  if (!employeeId || !toPositionId) return { ok: false, error: "Pick a destination position." };

  try {
    const res = await platformFetch<{
      ok: true; closedAssignmentIds: string[]; reconciled: { granted: number; revoked: number } | null;
    }>(`/api/${c.tenant}/hr/employees/${employeeId}/transfer`, c.userId, {
      method: "POST",
      body: JSON.stringify({
        toPositionId,
        ...(str(formData, "effectiveDate") ? { effectiveDate: str(formData, "effectiveDate") } : {}),
        ...(str(formData, "reason") ? { reason: str(formData, "reason") } : {}),
      }),
    });
    revalidateIam();
    // Both numbers, always: "granted 2" alone reads as a promotion, and the revoked count is what tells
    // an operator the old department's access is actually gone.
    return {
      ok: true,
      message:
        `Transferred. ${res.reconciled?.granted ?? 0} grant(s) added, ${res.reconciled?.revoked ?? 0} removed, ` +
        `${res.closedAssignmentIds.length} previous seat(s) closed.`,
    };
  } catch (err) {
    const h = humanize(err);
    return { ok: false, error: h.error, nextStep: h.nextStep };
  }
}

export async function terminateEmployee(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const employeeId = str(formData, "employeeId");
  if (!employeeId) return { ok: false, error: "Missing employee." };
  const reason = str(formData, "reason");
  if (!reason) return { ok: false, error: "A reason is required — termination is the least reversible action here." };

  try {
    const res = await platformFetch<{
      ok: true; userDisabled: boolean; itFollowUp: string | null;
      closedAssignmentIds: string[]; revokedManualGrants: string[];
    }>(`/api/${c.tenant}/hr/employees/${employeeId}/terminate`, c.userId, {
      method: "POST",
      body: JSON.stringify({ reason, ...(str(formData, "lastDay") ? { lastDay: str(formData, "lastDay") } : {}) }),
    });
    revalidateIam();
    revalidatePath("/it/accounts");
    // `userDisabled: false` is NOT a failure — it means the person still has a membership in another
    // company, so their login must survive. Saying which happened prevents an operator "fixing" it.
    const login = res.userDisabled
      ? "Their login is disabled."
      : "Their login stays ACTIVE because they are still a member of another company — that is correct, not a miss.";
    const it = res.itFollowUp ? " IT's accounts worklist will show the login change." : "";
    return {
      ok: true,
      message:
        `Terminated. ${res.closedAssignmentIds.length} seat(s) closed, ` +
        `${res.revokedManualGrants.length} manual grant(s) revoked. ${login}${it}`,
    };
  } catch (err) {
    const h = humanize(err);
    return { ok: false, error: h.error, nextStep: h.nextStep };
  }
}

export async function updateEmployee(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const employeeId = str(formData, "employeeId");
  if (!employeeId) return { ok: false, error: "Missing employee." };
  const body: Record<string, unknown> = {};
  for (const k of ["displayName", "legalName", "personalEmail", "phone", "notes"]) {
    const v = str(formData, k);
    if (v) body[k] = v;
  }
  if (Object.keys(body).length === 0) return { ok: false, error: "Nothing to change." };
  try {
    await platformFetch(`/api/${c.tenant}/hr/employees/${employeeId}`, c.userId, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    revalidateIam();
    return { ok: true, message: "Employee record updated." };
  } catch (err) {
    return { ok: false, error: humanize(err).error };
  }
}

// ── positions (P2-12-FE) ─────────────────────────────────────────────────────────────────────────

export async function createPosition(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const unitNodeId = str(formData, "unitNodeId");
  const title = str(formData, "title");
  if (!unitNodeId) return { ok: false, error: "Pick the org unit this seat belongs to." };
  if (!title) return { ok: false, error: "A title is required." };
  try {
    const res = await platformFetch<{ id: string }>(`/api/${c.tenant}/positions`, c.userId, {
      method: "POST",
      body: JSON.stringify({ unitNodeId, title, isLead: formData.get("isLead") === "on" }),
    });
    revalidateIam();
    // Deliberately says the seat confers nothing yet: a position with no role-set is the most common
    // half-finished state here, and it looks identical to a finished one in a list.
    return { ok: true, message: `"${title}" created. It confers no access until you attach roles.`, id: res.id };
  } catch (err) {
    return { ok: false, error: humanize(err).error };
  }
}

export async function updatePosition(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const positionId = str(formData, "positionId");
  if (!positionId) return { ok: false, error: "Missing position." };
  const body: Record<string, unknown> = {};
  if (str(formData, "title")) body.title = str(formData, "title");
  if (str(formData, "unitNodeId")) body.unitNodeId = str(formData, "unitNodeId");
  if (formData.has("isLead")) body.isLead = formData.get("isLead") === "on";
  try {
    await platformFetch(`/api/${c.tenant}/positions/${positionId}`, c.userId, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    revalidateIam();
    // Moving the unit re-reconciles every holder, which is a bigger effect than "renamed a row".
    return { ok: true, message: body.unitNodeId ? "Position updated — every holder was re-reconciled." : "Position updated." };
  } catch (err) {
    return { ok: false, error: humanize(err).error };
  }
}

export async function retirePosition(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const positionId = str(formData, "positionId");
  if (!positionId) return { ok: false, error: "Missing position." };
  try {
    await platformFetch(`/api/${c.tenant}/positions/${positionId}/retire`, c.userId, { method: "POST", body: "{}" });
    revalidateIam();
    return { ok: true, message: "Position retired. Every open placement was closed and the holders re-reconciled." };
  } catch (err) {
    return { ok: false, error: humanize(err).error };
  }
}

export async function attachRole(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const positionId = str(formData, "positionId");
  const roleId = str(formData, "roleId");
  const scopeKind = str(formData, "scopeKind") || "own_unit";
  if (!positionId || !roleId) return { ok: false, error: "Pick a role." };
  try {
    await platformFetch(`/api/${c.tenant}/positions/${positionId}/roles`, c.userId, {
      method: "POST",
      body: JSON.stringify({ roleId, scopeKind }),
    });
    revalidateIam();
    return { ok: true, message: "Role attached. Every current holder was granted it." };
  } catch (err) {
    return { ok: false, error: humanize(err).error };
  }
}

export async function detachRole(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const positionId = str(formData, "positionId");
  const roleId = str(formData, "roleId");
  if (!positionId || !roleId) return { ok: false, error: "Missing role." };
  try {
    await platformFetch(`/api/${c.tenant}/positions/${positionId}/roles/${roleId}`, c.userId, { method: "DELETE" });
    revalidateIam();
    // Immediately, not at the next sweep — the operator should know the access is already gone.
    return { ok: true, message: "Role detached and revoked from every current holder." };
  } catch (err) {
    return { ok: false, error: humanize(err).error };
  }
}

// ── placement (P2-11 + P2-12-FE) ─────────────────────────────────────────────────────────────────

export async function assignPosition(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const positionId = str(formData, "positionId");
  const targetUserId = str(formData, "userId");
  if (!positionId || !targetUserId) return { ok: false, error: "Pick a person." };
  try {
    await platformFetch(`/api/${c.tenant}/positions/${positionId}/assign`, c.userId, {
      method: "POST",
      body: JSON.stringify({ userId: targetUserId, ...(str(formData, "reason") ? { reason: str(formData, "reason") } : {}) }),
    });
    revalidateIam();
    return { ok: true, message: "Placed. Their access now follows the seat." };
  } catch (err) {
    const h = humanize(err);
    // The dept-head case: not a failure, a redirection to the proposal flow.
    return { ok: false, error: h.error, nextStep: h.nextStep };
  }
}

export async function unassignPosition(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const positionId = str(formData, "positionId");
  const targetUserId = str(formData, "userId");
  if (!positionId || !targetUserId) return { ok: false, error: "Missing person." };
  try {
    await platformFetch(`/api/${c.tenant}/positions/${positionId}/unassign`, c.userId, {
      method: "POST",
      body: JSON.stringify({ userId: targetUserId }),
    });
    revalidateIam();
    return { ok: true, message: "Removed from the seat. Grants that only this seat justified were revoked." };
  } catch (err) {
    return { ok: false, error: humanize(err).error };
  }
}

export async function requestAssignment(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const positionId = str(formData, "positionId");
  const targetUserId = str(formData, "userId");
  const justification = str(formData, "justification");
  if (!positionId || !targetUserId) return { ok: false, error: "Pick a person." };
  if (!justification) return { ok: false, error: "A justification is required — it is what the approver reads." };
  try {
    await platformFetch(`/api/${c.tenant}/positions/${positionId}/assignment-requests`, c.userId, {
      method: "POST",
      body: JSON.stringify({ userId: targetUserId, justification }),
    });
    revalidateIam();
    revalidatePath("/approvals");
    return { ok: true, message: "Request filed. It appears in the approvals inbox for HR or a company administrator." };
  } catch (err) {
    return { ok: false, error: humanize(err).error };
  }
}

// ── grants (P2-11) ───────────────────────────────────────────────────────────────────────────────

export async function grantRole(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const targetUserId = str(formData, "userId");
  const roleId = str(formData, "roleId");
  if (!targetUserId || !roleId) return { ok: false, error: "Pick a person and a role." };
  const scopeType = str(formData, "scopeType") || "company";
  const scopeId = str(formData, "scopeId");
  const days = str(formData, "expiresInDays");
  try {
    await platformFetch(`/api/${c.tenant}/role-grants`, c.userId, {
      method: "POST",
      body: JSON.stringify({
        userId: targetUserId,
        roleId,
        scopeType,
        ...(scopeType === "org_unit" && scopeId ? { scopeId } : {}),
        ...(days ? { temporary: true, expiresInDays: Number(days) } : {}),
        ...(str(formData, "reason") ? { reason: str(formData, "reason") } : {}),
      }),
    });
    revalidateIam();
    return { ok: true, message: days ? `Granted, expiring in ${days} day(s).` : "Granted." };
  } catch (err) {
    const h = humanize(err);
    return { ok: false, error: h.error, nextStep: h.nextStep };
  }
}

export async function revokeGrant(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const grantId = str(formData, "grantId");
  if (!grantId) return { ok: false, error: "Missing grant." };
  try {
    await platformFetch(`/api/${c.tenant}/role-grants/${grantId}`, c.userId, { method: "DELETE" });
    revalidateIam();
    return { ok: true, message: "Revoked. Their session was invalidated, so it takes effect on their next request." };
  } catch (err) {
    return { ok: false, error: humanize(err).error };
  }
}

export async function requestOverride(formData: FormData): Promise<IamResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const targetUserId = str(formData, "userId");
  const roleId = str(formData, "roleId");
  const justification = str(formData, "justification");
  if (!targetUserId || !roleId) return { ok: false, error: "Pick a person and a role." };
  if (!justification) {
    return { ok: false, error: "A justification is required — an override is an exception, and the reason is its audit trail." };
  }
  const scopeType = str(formData, "scopeType") || "company";
  const scopeId = str(formData, "scopeId");
  try {
    await platformFetch(`/api/${c.tenant}/role-grants/overrides`, c.userId, {
      method: "POST",
      body: JSON.stringify({
        userId: targetUserId,
        roleId,
        scopeType,
        ...(scopeType === "org_unit" && scopeId ? { scopeId } : {}),
        justification,
        ...(str(formData, "expiresInDays") ? { expiresInDays: Number(str(formData, "expiresInDays")) } : {}),
      }),
    });
    revalidateIam();
    revalidatePath("/approvals");
    return {
      ok: true,
      message: "Override requested. It is routed to an approver who holds the right to decide it, and it grants nothing until they do.",
    };
  } catch (err) {
    return { ok: false, error: humanize(err).error };
  }
}

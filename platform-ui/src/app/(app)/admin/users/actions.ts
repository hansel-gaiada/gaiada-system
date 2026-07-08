"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { assignRole, revokeRole, revokeSession, type AdminActionState } from "@/lib/adminData";

// Resolves userId + active tenant the same way the page does. Every action
// here already flows through adminData's gracefulWrite, so no try/catch is
// needed beyond the session guard — {ok,error} is passed straight through
// for the client component to toast.
async function resolveContext(): Promise<{ userId: string; tenant: string } | AdminActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "No active company." };
  return { userId, tenant };
}

export async function assignRoleAction(
  userId: string,
  _prev: AdminActionState | null,
  formData: FormData
): Promise<AdminActionState> {
  const ctx = await resolveContext();
  if ("ok" in ctx) return ctx;

  const roleId = String(formData.get("roleId") ?? "");
  const scopeType = String(formData.get("scopeType") ?? "");
  const scopeIdRaw = formData.get("scopeId");
  const scopeId = scopeIdRaw ? String(scopeIdRaw) : undefined;
  if (!roleId || !scopeType) return { ok: false, error: "Role and scope are required." };

  const result = await assignRole(ctx.userId, ctx.tenant, userId, { roleId, scopeType, scopeId });
  if (result.ok) revalidatePath("/admin/users");
  return result;
}

// Bound by the page to a specific user, then bound again by RoleManager (per
// grant chip) to a specific grantId — see RoleGrantChip in RoleManager.tsx.
export async function revokeRoleAction(
  userId: string,
  grantId: string,
  _prev: AdminActionState | null,
  _formData?: FormData
): Promise<AdminActionState> {
  const ctx = await resolveContext();
  if ("ok" in ctx) return ctx;

  const result = await revokeRole(ctx.userId, ctx.tenant, userId, grantId);
  if (result.ok) revalidatePath("/admin/users");
  return result;
}

export async function revokeSessionAction(
  userId: string,
  _prev: AdminActionState | null,
  _formData?: FormData
): Promise<AdminActionState> {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return { ok: false, error: "Session expired — sign in again." };

  const result = await revokeSession(sessionUserId, userId);
  if (result.ok) revalidatePath("/admin/users");
  return result;
}

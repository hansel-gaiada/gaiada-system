"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { verifyIdentityLink, unlinkIdentity, type AdminActionState } from "@/lib/adminData";

// Resolves userId + active tenant the same way the page does — mirrors
// admin/users/actions.ts. Every action here already flows through
// adminData's gracefulWrite, so no try/catch is needed beyond the session
// guard — {ok,error} is passed straight through for the client component to
// toast.
async function resolveContext(): Promise<{ userId: string; tenant: string } | AdminActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "No active company." };
  return { userId, tenant };
}

export async function verifyLinkAction(
  id: string,
  _prev: AdminActionState | null,
  _formData?: FormData
): Promise<AdminActionState> {
  const ctx = await resolveContext();
  if ("ok" in ctx) return ctx;

  const result = await verifyIdentityLink(ctx.userId, ctx.tenant, id);
  if (result.ok) revalidatePath("/admin/identity");
  return result;
}

export async function unlinkAction(
  id: string,
  _prev: AdminActionState | null,
  _formData?: FormData
): Promise<AdminActionState> {
  const ctx = await resolveContext();
  if ("ok" in ctx) return ctx;

  const result = await unlinkIdentity(ctx.userId, ctx.tenant, id);
  if (result.ok) revalidatePath("/admin/identity");
  return result;
}

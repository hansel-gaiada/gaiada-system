"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { setModuleEnabled, createFieldDef, updateFieldDef, deleteFieldDef, type AdminActionState } from "@/lib/adminData";

// Resolves userId + active tenant the same way the page does — mirrors
// admin/users/actions.ts and admin/identity/actions.ts. Every action here
// already flows through adminData's gracefulWrite (module toggle) or the
// real createFieldDef call, so no try/catch is needed beyond the session
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

// Bound by ModuleToggle to (module, nextEnabled). Degrades gracefully until
// PATCH /api/:t/company/modules lands.
export async function toggleModuleAction(
  module: string,
  enabled: boolean,
  _prev: AdminActionState | null,
  _formData?: FormData
): Promise<AdminActionState> {
  const ctx = await resolveContext();
  if ("ok" in ctx) return ctx;

  const result = await setModuleEnabled(ctx.userId, ctx.tenant, module, enabled);
  if (result.ok) revalidatePath("/admin/modules");
  return result;
}

// Bound by FieldDefManager to a specific entityType. Real — POST
// /api/:t/custom-fields exists.
export async function createFieldAction(
  entityType: string,
  _prev: AdminActionState | null,
  formData: FormData
): Promise<AdminActionState> {
  const ctx = await resolveContext();
  if ("ok" in ctx) return ctx;

  const key = String(formData.get("key") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const dataType = String(formData.get("dataType") ?? "text");
  const optionsRaw = String(formData.get("options") ?? "").trim();
  const options = optionsRaw ? optionsRaw.split(",").map((o) => o.trim()).filter(Boolean) : undefined;
  const required = formData.get("required") === "on";
  if (!key || !label) return { ok: false, error: "Key and label are required." };

  const result = await createFieldDef(ctx.userId, ctx.tenant, {
    entityType,
    key,
    label,
    data_type: dataType,
    options,
    required,
  });
  if (result.ok) revalidatePath("/admin/modules");
  return result;
}

// Bound by FieldDefManager to a specific field def id. Degrades gracefully
// until PATCH /api/:t/custom-fields/:id lands.
export async function updateFieldAction(
  id: string,
  _prev: AdminActionState | null,
  formData: FormData
): Promise<AdminActionState> {
  const ctx = await resolveContext();
  if ("ok" in ctx) return ctx;

  const body: Record<string, unknown> = {};
  const label = formData.get("label");
  if (label) body.label = String(label);
  const required = formData.get("required");
  if (required !== null) body.required = required === "on";

  const result = await updateFieldDef(ctx.userId, ctx.tenant, id, body);
  if (result.ok) revalidatePath("/admin/modules");
  return result;
}

// Bound by FieldDefManager to a specific field def id. Degrades gracefully
// until DELETE /api/:t/custom-fields/:id lands.
export async function deleteFieldAction(
  id: string,
  _prev: AdminActionState | null,
  _formData?: FormData
): Promise<AdminActionState> {
  const ctx = await resolveContext();
  if ("ok" in ctx) return ctx;

  const result = await deleteFieldDef(ctx.userId, ctx.tenant, id);
  if (result.ok) revalidatePath("/admin/modules");
  return result;
}

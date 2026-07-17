"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { inviteUser, updateUser } from "@/lib/adminData";
import type { EmployeeFormState } from "@/components/forms/EmployeeForm";

async function ctx() {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." } as const;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." } as const;
  if (!can(me, "admin.access", tenant)) return { error: "You don't have permission to manage people in this company." } as const;
  return { userId, tenant } as const;
}

export async function inviteEmployeeAction(_prev: EmployeeFormState | null, formData: FormData): Promise<EmployeeFormState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  if (!name || !email) return { error: "Name and email are required." };

  const res = await inviteUser(c.userId, c.tenant, { name, email, title: String(formData.get("title") ?? "") || undefined, roleId: String(formData.get("roleId") ?? "") || undefined });
  if (!res.ok) return { error: res.error };
  revalidatePath("/people");
  redirect(res.id ? `/people/${res.id}` : "/people");
}

export async function updateEmployeeAction(userId: string, _prev: EmployeeFormState | null, formData: FormData): Promise<EmployeeFormState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Name is required." };

  const res = await updateUser(c.userId, c.tenant, userId, {
    name,
    title: String(formData.get("title") ?? "") || undefined,
    status: String(formData.get("status") ?? "") || undefined,
  });
  if (!res.ok) return { error: res.error };
  revalidatePath("/people");
  revalidatePath(`/people/${userId}`);
  redirect(`/people/${userId}`);
}

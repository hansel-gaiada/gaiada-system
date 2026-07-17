"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { isElevated, can } from "@/lib/rbac";
import { createCompany, updateCompany } from "@/lib/entities";
import type { CompanyFormState } from "@/components/forms/CompanyForm";

function readModules(formData: FormData): string[] {
  const known = String(formData.get("knownModules") ?? "").split(",").filter(Boolean);
  return known.filter((m) => formData.get(`module_${m}`) === "on");
}

export async function createCompanyAction(_prev: CompanyFormState | null, formData: FormData): Promise<CompanyFormState> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  if (!isElevated(me)) return { error: "Only owners and administrators can create companies." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Company name is required." };

  let id: string;
  try {
    const res = await createCompany(userId, {
      name,
      type: String(formData.get("type") ?? "") || null,
      parentCompanyId: String(formData.get("parentCompanyId") ?? "") || null,
      modules: readModules(formData),
    });
    id = res.id;
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 404 || e.status === 405) return { error: "Creating companies isn't available yet — the backend endpoint is pending." };
      return { error: e.message };
    }
    throw e;
  }
  revalidatePath("/companies");
  revalidatePath("/organization");
  redirect(`/companies/${id}`);
}

export async function updateCompanyAction(companyId: string, _prev: CompanyFormState | null, formData: FormData): Promise<CompanyFormState> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  if (!can(me, "company.manage", companyId) && !isElevated(me)) return { error: "You don't have permission to edit this company." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Company name is required." };

  try {
    await updateCompany(userId, companyId, {
      name,
      type: String(formData.get("type") ?? "") || null,
      parentCompanyId: String(formData.get("parentCompanyId") ?? "") || null,
      status: String(formData.get("status") ?? "") || undefined,
      modules: readModules(formData),
    });
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 404 || e.status === 405) return { error: "Editing companies isn't available yet — the backend endpoint is pending." };
      return { error: e.message };
    }
    throw e;
  }
  revalidatePath("/companies");
  revalidatePath(`/companies/${companyId}`);
  redirect(`/companies/${companyId}`);
}

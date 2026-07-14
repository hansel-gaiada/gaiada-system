"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { isElevated } from "@/components/shell/nav";
import { persistOrgStructure, sanitizeStructure } from "@/lib/org";

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
  if (!isElevated(me)) return { ok: false, error: "Only owners and administrators can edit the org structure." };
  if (!me.companies.some((c) => c.id === companyId)) return { ok: false, error: "Unknown company." };

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

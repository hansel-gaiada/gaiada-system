"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { attachFile, deleteFile, postComment } from "./entities";

export type CollabResult = { ok: boolean; error?: string; id?: string };

async function ctx() {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." } as const;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." } as const;
  return { userId, tenant } as const;
}

function fail(e: unknown): CollabResult {
  if (e instanceof PlatformError) {
    if (e.status === 404 || e.status === 405) return { ok: false, error: "Not available yet — the backend endpoint is pending." };
    return { ok: false, error: e.message };
  }
  throw e;
}

// Comments — bound to (entityType, entityId) at the call site.
export async function postEntityComment(entityType: string, entityId: string, body: string): Promise<CollabResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!body.trim()) return { ok: false, error: "Write something first." };
  try { const r = await postComment(c.userId, c.tenant, entityType, entityId, body.trim()); revalidatePath(`/${entityType}s/${entityId}`); return { ok: true, id: r.id }; }
  catch (e) { return fail(e); }
}

// Attachments (metadata / reference).
export async function attachFileAction(entityType: string, entityId: string, formData: FormData): Promise<CollabResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const filename = String(formData.get("filename") ?? "").trim();
  if (!filename) return { ok: false, error: "File name is required." };
  try {
    const r = await attachFile(c.userId, c.tenant, { entityType, entityId, filename, url: String(formData.get("url") ?? "") || undefined });
    revalidatePath(`/${entityType}s/${entityId}`);
    return { ok: true, id: r.id };
  } catch (e) { return fail(e); }
}

export async function deleteFileAction(entityType: string, entityId: string, fileId: string): Promise<CollabResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try { await deleteFile(c.userId, c.tenant, fileId); revalidatePath(`/${entityType}s/${entityId}`); return { ok: true }; }
  catch (e) { return fail(e); }
}

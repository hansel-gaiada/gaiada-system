"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { attachFile, deleteFile, postComment, uploadFile } from "./entities";
import { FILE_TOO_BIG, MAX_UPLOAD_BYTES, addRefusalText } from "./fileUpload";

export type CollabResult = { ok: boolean; error?: string; id?: string; /** An upload only: personal data was removed from the stored copy. */ scrubbed?: boolean };

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

// Attachments (metadata / reference). `revalidate` (DW-8h, §45.2) is the page path to refresh; without it the action keeps its
// old guess, `/${entityType}s/${entityId}`, which is right for tasks and projects only.
export async function attachFileAction(entityType: string, entityId: string, formData: FormData, revalidate?: string): Promise<CollabResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const filename = String(formData.get("filename") ?? "").trim();
  if (!filename) return { ok: false, error: "File name is required." };
  try {
    const r = await attachFile(c.userId, c.tenant, { entityType, entityId, filename, url: String(formData.get("url") ?? "") || undefined });
    revalidatePath(revalidate ?? `/${entityType}s/${entityId}`);
    return { ok: true, id: r.id };
  } catch (e) { return failFile(e, entityType); }
}

export async function deleteFileAction(entityType: string, entityId: string, fileId: string, revalidate?: string): Promise<CollabResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try { await deleteFile(c.userId, c.tenant, fileId); revalidatePath(revalidate ?? `/${entityType}s/${entityId}`); return { ok: true }; }
  catch (e) { return fail(e); }
}

/** A file's refusal in a sentence (403, 404, 409 `target_closed`); anything else as `fail` words it. */
function failFile(e: unknown, entityType: string): CollabResult {
  if (e instanceof PlatformError) {
    const text = addRefusalText(e.status, entityType, e.message);
    if (text) return { ok: false, error: text };
  }
  return fail(e);
}

// DW-8h (§45.2): a real upload. The form carries a `file`; it is refused over 25 MB BEFORE anything is sent, then
// base64-encoded and posted. A server action body is not the limit here (520 MB, next.config.ts); the platform's 25 MB is.
export async function uploadFileAction(entityType: string, entityId: string, revalidate: string, formData: FormData): Promise<CollabResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a file to upload." };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: FILE_TOO_BIG };
  try {
    const content = Buffer.from(await file.arrayBuffer()).toString("base64");
    const r = await uploadFile(c.userId, c.tenant, {
      targetType: entityType, targetId: entityId, filename: file.name || "file",
      contentType: file.type || "application/octet-stream", content,
    });
    revalidatePath(revalidate);
    return { ok: true, id: r.id, scrubbed: r.scrubbed === true };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 400 && /too large/i.test(e.message)) return { ok: false, error: FILE_TOO_BIG };
    return failFile(e, entityType);
  }
}

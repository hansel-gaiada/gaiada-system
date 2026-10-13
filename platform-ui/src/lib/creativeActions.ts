"use server";
// Server action for the Image Studio "Save to ERP" path. The grading happens entirely
// in the browser; this action forwards the finished asset — graded bytes, the original
// bytes, and the exact grade params — to the platform persist endpoint (creative.controller),
// which keeps them for reproducibility. Tokens never reach the browser (platformFetch is
// server-only). base64 in a JSON body matches the endpoint's contract (no multipart).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { creativeErrorSentence, errorToken } from "./creativeReviews";

export interface SaveAssetInput {
  name: string;
  presetId: string;
  width?: number;
  height?: number;
  grade: Record<string, number>;
  /** base64 (no data-URI prefix) of the exported graded WebP. */
  graded: string;
  /** base64 of the original, pre-grade image (optional). */
  original?: string;
  originalContentType?: string;
  departmentId?: string;
  /** DW-6h §35.2: save this as the NEXT VERSION of the named asset's group. */
  versionOf?: string;
  /** Defaults to image/webp (the Studio's export); a plain upload from the asset detail sends its own. */
  contentType?: string;
}

export interface SaveAssetResult { ok: boolean; id?: string; versionNo?: number; error?: string }

export interface ToggleResult { ok: boolean; error?: string }

/** Curate: mark whether a saved asset is a good training exemplar for the phase-2 AI. */
export async function setAssetTraining(id: string, trainingReady: boolean): Promise<ToggleResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "Select a company first." };
  try {
    await platformFetch(`/api/${tenant}/creative/assets/${id}`, userId, { method: "PATCH", body: JSON.stringify({ trainingReady }) });
    revalidatePath("/departments/[deptId]/studio", "page");
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 405)) return { ok: false, error: "Persist endpoint not deployed yet." };
    return { ok: false, error: e instanceof Error ? e.message : "Update failed." };
  }
}

export async function saveCreativeAsset(input: SaveAssetInput): Promise<SaveAssetResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "Select a company first." };
  if (!input.name || !input.graded) return { ok: false, error: "Nothing to save." };

  try {
    const res = await platformFetch<{ id: string; versionNo?: number }>(`/api/${tenant}/creative/assets`, userId, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        contentType: input.contentType ?? "image/webp",
        width: input.width,
        height: input.height,
        presetId: input.presetId,
        departmentId: input.departmentId,
        grade: input.grade,
        graded: input.graded,
        original: input.original,
        originalContentType: input.originalContentType,
        versionOf: input.versionOf,
      }),
    });
    if (input.versionOf) revalidatePath("/departments/[deptId]/assets", "layout");
    return { ok: true, id: res.id, versionNo: res.versionNo };
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 405) && !errorToken(e.reason) && !errorToken(e.message)) {
      return { ok: false, error: "Saved locally — the ERP persist endpoint isn't deployed yet." };
    }
    if (e instanceof PlatformError) return { ok: false, error: creativeErrorSentence(e) };
    return { ok: false, error: e instanceof Error ? e.message : "Save failed." };
  }
}

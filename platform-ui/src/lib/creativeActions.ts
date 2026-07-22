"use server";
// Server action for the Image Studio "Save to ERP" path. The grading happens entirely
// in the browser; this action forwards the finished asset — graded bytes, the original
// bytes, and the exact grade params — to the platform persist endpoint (creative.controller),
// which keeps them for reproducibility. Tokens never reach the browser (platformFetch is
// server-only). base64 in a JSON body matches the endpoint's contract (no multipart).
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";

export interface SaveAssetInput {
  name: string;
  presetId: string;
  width: number;
  height: number;
  grade: Record<string, number>;
  /** base64 (no data-URI prefix) of the exported graded WebP. */
  graded: string;
  /** base64 of the original, pre-grade image (optional). */
  original?: string;
  originalContentType?: string;
  departmentId?: string;
}

export interface SaveAssetResult { ok: boolean; id?: string; error?: string }

export async function saveCreativeAsset(input: SaveAssetInput): Promise<SaveAssetResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "Select a company first." };
  if (!input.name || !input.graded) return { ok: false, error: "Nothing to save." };

  try {
    const res = await platformFetch<{ id: string }>(`/api/${tenant}/creative/assets`, userId, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        contentType: "image/webp",
        width: input.width,
        height: input.height,
        presetId: input.presetId,
        departmentId: input.departmentId,
        grade: input.grade,
        graded: input.graded,
        original: input.original,
        originalContentType: input.originalContentType,
      }),
    });
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 405)) {
      return { ok: false, error: "Saved locally — the ERP persist endpoint isn't deployed yet." };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Save failed." };
  }
}

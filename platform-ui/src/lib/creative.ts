import "server-only";
// Read model for the creative Image Studio's asset library. Lists what's been persisted
// (originals + graded + grade params) so the team can review captures and curate which are
// good training exemplars for the phase-2 AI. Degrades to [] when the endpoint isn't
// deployed (or in DEMO_MODE), so the surface renders cleanly regardless.
import { platformFetch, PlatformError } from "./platform";

export interface CreativeAsset {
  id: string;
  name: string;
  content_type: string;
  width: number | null;
  height: number | null;
  preset_id: string | null;
  grade: Record<string, number> | null;
  department_id: string | null;
  has_original: boolean;
  original_byte_size: number;
  graded_byte_size: number;
  training_ready: boolean;
  created_at: string;
}

export async function listCreativeAssets(
  userId: string,
  tenant: string,
  opts: { trainingReady?: boolean } = {},
): Promise<CreativeAsset[]> {
  const q = opts.trainingReady === undefined ? "" : `?trainingReady=${opts.trainingReady}`;
  try {
    return await platformFetch<CreativeAsset[]>(`/api/${tenant}/creative/assets${q}`, userId);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 405)) return [];
    throw e;
  }
}

/** Count of assets currently marked as training exemplars — shown as the trainer's data size. */
export function trainingReadyCount(assets: CreativeAsset[]): number {
  return assets.filter((a) => a.training_ready && a.has_original).length;
}

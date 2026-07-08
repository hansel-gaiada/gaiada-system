"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { platformFetch, PlatformError } from "@/lib/platform";

export interface ConfigActionState {
  ok: boolean;
  error?: string;
}

// Coerces the raw form value by the field's `kind` (passed through as a
// hidden input alongside `value`) so booleans/numbers reach the backend as
// their real type rather than always as strings.
function coerceValue(raw: FormDataEntryValue | null, kind: FormDataEntryValue | null): unknown {
  const str = raw == null ? "" : String(raw);
  switch (kind) {
    case "boolean":
      return str === "on" || str === "true";
    case "number":
      return str === "" ? null : Number(str);
    default:
      return str;
  }
}

// NOTE: PUT /api/admin/bot/config does not exist on the backend yet. This
// action is wired up so the UI degrades gracefully — on a 404/405 it
// surfaces a friendly message instead of crashing. Remove this fallback once
// the bot admin API ships config writes.
export async function updateBotConfig(
  key: string,
  _prev: ConfigActionState | null,
  formData: FormData
): Promise<ConfigActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };

  const value = coerceValue(formData.get("value"), formData.get("kind"));

  try {
    await platformFetch("/api/admin/bot/config", userId, {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    });
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 404 || e.status === 405) {
        return { ok: false, error: "Saving isn't available yet — the bot admin API is pending." };
      }
      return { ok: false, error: e.message };
    }
    throw e;
  }

  revalidatePath("/systems/bot");
  return { ok: true };
}

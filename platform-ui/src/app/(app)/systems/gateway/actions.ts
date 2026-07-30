"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { setDrMode, setGatewayConfig, revertGatewayConfig } from "@/lib/admin";
import type { DrModeActionState } from "@/components/systems/DrModeCard";

export interface ConfigActionState {
  ok: boolean;
  error?: string;
}

// Coerces the raw form value by the field's `kind` (passed through as a hidden input alongside
// `value`) so booleans/numbers reach the backend as their real type rather than always as strings.
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

// Writes one gateway config key. Validation, bounds and persistence all live in the GATEWAY — this
// action forwards the value and surfaces the gateway's own rejection message, so the form never
// duplicates (and drifts from) the service's rules.
export async function updateGatewayConfig(
  key: string,
  _prev: ConfigActionState | null,
  formData: FormData,
): Promise<ConfigActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };

  const value = coerceValue(formData.get("value"), formData.get("kind"));
  const me = await getMe(userId);
  const res = await setGatewayConfig(userId, me, key, value);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/systems/gateway");
  return { ok: true };
}

// Drops the override for one key so it reverts to the env value. Offered only for keys the gateway
// reports as currently overridden — reverting a key that was never overridden is a no-op that would
// just look like a broken button.
export async function revertGatewayConfigField(
  key: string,
  _prev: ConfigActionState | null,
  _formData: FormData,
): Promise<ConfigActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };

  const me = await getMe(userId);
  const res = await revertGatewayConfig(userId, me, key);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/systems/gateway");
  return { ok: true };
}

// WS9 D15: declare/resolve a failover, (un)locking the bounded DR-burst AI budget. The gateway
// token stays server-side — nest proxies the call — and the elevated check is enforced there too;
// the `me` lookup here only lets the UI refuse early with a readable message.
export async function toggleDrMode(
  _prev: DrModeActionState | null,
  formData: FormData,
): Promise<DrModeActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };

  const enable = formData.get("enable") === "true";
  const me = await getMe(userId);
  const res = await setDrMode(userId, me, { enable });
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/systems/gateway");
  // Echo the resulting state so the card doesn't have to wait for the revalidated render.
  return { ok: true, drMode: res.drMode ?? enable };
}

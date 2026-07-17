"use server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { canManageIT } from "@/components/shell/nav";

export type RegisterResult = { ok: boolean; error?: string; id?: string };

// Register a device. Writes are gated to elevated / IT-role (canManageIT); the
// backend RLS/Cerbos is the real boundary, this is defence-in-depth. Posts to
// the BFF contract POST /api/:t/it/devices -> { id }.
export async function registerDevice(formData: FormData): Promise<RegisterResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "You are not signed in." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "Select a company first." };
  if (!canManageIT(me, tenant)) return { ok: false, error: "You don't have permission to register devices in this company." };

  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v || undefined;
  };
  const name = str("name");
  if (!name) return { ok: false, error: "Name is required." };

  const body = JSON.stringify({
    name,
    kind: str("kind") ?? "other",
    site: str("site") ?? null,
    network: str("network") ?? null,
    ip: str("ip") ?? null,
    vendor: str("vendor") ?? null,
    model: str("model") ?? null,
    mac: str("mac") ?? null,
  });

  try {
    const res = await platformFetch<{ id: string }>(`/api/${tenant}/it/devices`, userId, { method: "POST", body });
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

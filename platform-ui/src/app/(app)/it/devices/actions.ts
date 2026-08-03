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

// Fields the edit form submits. `ip`/`mac` are only accepted by the backend for MANUALLY registered
// devices — on a discovered row they are network facts owned by the collector and the API rejects
// them with a 400 whose message explains why. The form hides them in that case; this list stays
// permissive so the backend remains the single authority on what is editable.
const EDITABLE = ["name", "kind", "site", "network", "ip", "mac", "vendor", "model", "firmware"] as const;

/** Edit a device (IT-02). Sends only the keys present in the form, so an untouched field is never
 *  overwritten with a blank. */
export async function updateDevice(deviceId: string, formData: FormData): Promise<RegisterResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "You are not signed in." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "Select a company first." };
  if (!canManageIT(me, tenant)) return { ok: false, error: "You don't have permission to edit devices in this company." };

  const patch: Record<string, unknown> = {};
  for (const k of EDITABLE) {
    if (!formData.has(k)) continue;
    const v = String(formData.get(k) ?? "").trim();
    patch[k] = v === "" ? null : v;
  }
  if (typeof patch.name === "string" && !patch.name.trim()) return { ok: false, error: "Name is required." };
  if (patch.name === null) return { ok: false, error: "Name is required." };
  const labels = String(formData.get("labels") ?? "").trim();
  if (formData.has("labels")) {
    patch.labels = labels ? labels.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }
  if (!Object.keys(patch).length) return { ok: false, error: "Nothing to save." };

  try {
    await platformFetch(`/api/${tenant}/it/devices/${deviceId}`, userId, {
      method: "PATCH", body: JSON.stringify(patch),
    });
    return { ok: true, id: deviceId };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Soft-delete a device (IT-02). */
export async function deleteDevice(deviceId: string): Promise<RegisterResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "You are not signed in." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "Select a company first." };
  if (!canManageIT(me, tenant)) return { ok: false, error: "You don't have permission to remove devices in this company." };

  try {
    await platformFetch(`/api/${tenant}/it/devices/${deviceId}`, userId, { method: "DELETE" });
    return { ok: true, id: deviceId };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { can } from "@/lib/rbac";
import {
  createConnection, patchConnection, revokeConnection,
  type ConnectionProvider, type ConnectionRow,
} from "@/lib/connections";
import { mapClaudeSeat, patchClaudeSeat, unmapClaudeSeat, type SeatRow } from "@/lib/claudeSeats";

type Result<T = undefined> = { ok: boolean; error?: string; row?: T };

async function requireSession(): Promise<{ userId: string; me: Awaited<ReturnType<typeof getMe>> } | { ok: false; error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Not signed in." };
  const me = await getMe(userId);
  return { userId, me };
}

function refresh(tenant: string, deptId: string) {
  revalidatePath(`/departments/${deptId}/connections`);
  // The Home tab's LauncherRow reflects seat-mapping state too (WSUX-17).
  revalidatePath(`/departments/${deptId}`);
  void tenant; // kept for signature symmetry / future tenant-scoped cache tags
}

// ---------------- Self-service: GitHub / Google Drive connections ----------

export async function connectAction(
  tenant: string,
  deptId: string,
  provider: ConnectionProvider,
  externalAccount: string,
): Promise<Result<ConnectionRow>> {
  const ctx = await requireSession();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    const row = await createConnection(ctx.userId, tenant, { provider, externalAccount: externalAccount || undefined });
    refresh(tenant, deptId);
    return { ok: true, row };
  } catch (e) {
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't create the connection." };
  }
}

export async function updateConnectionAction(
  tenant: string,
  deptId: string,
  id: string,
  externalAccount: string,
): Promise<Result<ConnectionRow>> {
  const ctx = await requireSession();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    const row = await patchConnection(ctx.userId, tenant, id, { externalAccount });
    refresh(tenant, deptId);
    return { ok: true, row };
  } catch (e) {
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't update the connection." };
  }
}

export async function revokeConnectionAction(tenant: string, deptId: string, id: string): Promise<Result> {
  const ctx = await requireSession();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    await revokeConnection(ctx.userId, tenant, id);
    refresh(tenant, deptId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't revoke the connection." };
  }
}

// ---------------- Self-service: Claude seat ----------

export async function mapSeatAction(
  tenant: string,
  deptId: string,
  codeSeatEmail: string,
  designLogin?: string,
): Promise<Result<SeatRow>> {
  const ctx = await requireSession();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    const row = await mapClaudeSeat(ctx.userId, tenant, { codeSeatEmail, designLogin: designLogin || undefined });
    refresh(tenant, deptId);
    return { ok: true, row };
  } catch (e) {
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't map your Claude seat." };
  }
}

export async function updateSeatAction(
  tenant: string,
  deptId: string,
  id: string,
  codeSeatEmail: string,
  designLogin?: string,
): Promise<Result<SeatRow>> {
  const ctx = await requireSession();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    const row = await patchClaudeSeat(ctx.userId, tenant, id, { codeSeatEmail, designLogin });
    refresh(tenant, deptId);
    return { ok: true, row };
  } catch (e) {
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't update your Claude seat." };
  }
}

export async function unmapSeatAction(tenant: string, deptId: string, id: string): Promise<Result> {
  const ctx = await requireSession();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  try {
    await unmapClaudeSeat(ctx.userId, tenant, id);
    refresh(tenant, deptId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't unmap your Claude seat." };
  }
}

// ---------------- Admin: map a teammate's Claude seat on their behalf ------
// Re-checked server-side (the UI only hides the button) — real boundary is
// Cerbos's `resource_integration_connection.yaml` company.manage gate on the
// backend, which 403s a non-manager caller regardless of this check.

export async function adminMapSeatAction(
  tenant: string,
  deptId: string,
  userId: string,
  codeSeatEmail: string,
  designLogin?: string,
): Promise<Result<SeatRow>> {
  const ctx = await requireSession();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!can(ctx.me, "company.manage", tenant)) return { ok: false, error: "Only managers/admins can map another person's seat." };
  try {
    const row = await mapClaudeSeat(ctx.userId, tenant, { userId, codeSeatEmail, designLogin: designLogin || undefined });
    refresh(tenant, deptId);
    return { ok: true, row };
  } catch (e) {
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't map that seat." };
  }
}

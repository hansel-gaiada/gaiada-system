"use server";
// SCP-1c (BFF §63.4, §63.5): the Settings page's writes. `PUT settings` and `PUT cycles` are `social_engagement` · `plan`, the four Social
// approvers' alone; the gate here is a hint, and the server's 403 `not_a_social_approver` is the boundary. Every refusal comes back as
// the contract's own code in `error` (and its `field`), plus the words for it in `message`; the page shows the words.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { asCycleTable, asSocialSettings, writeRefusalText, type CycleTable, type SocialSettings } from "./socialCycles";

export type CyclesActionResult<T> = ({ ok: true } & T) | { ok: false; error: string; field?: string; message: string };

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

async function run<T>(fn: (c: { userId: string; tenant: string }) => Promise<T>): Promise<CyclesActionResult<T>> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "session_expired", message: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "no_company", message: "No active company selected." };
  try {
    return { ok: true, ...(await fn({ userId, tenant })) };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message, field: e.field, message: writeRefusalText(e.message, e.field) };
    throw e;
  }
}

/** `PUT settings`: only the fields given are changed; the server recomputes every open cycle's ready-by in the same call. */
export async function saveSocialSettings(
  body: { bufferWorkingDays?: number; boostCandidateFactor?: number },
): Promise<CyclesActionResult<{ settings: SocialSettings; cyclesRecomputed: number }>> {
  return run(async (c) => {
    const raw = await platformFetch<unknown>(`${base(c.tenant)}/settings`, c.userId, { method: "PUT", body: JSON.stringify(body) });
    revalidatePath("/departments", "layout");
    const cyclesRecomputed = typeof (raw as { cyclesRecomputed?: unknown })?.cyclesRecomputed === "number" ? (raw as { cyclesRecomputed: number }).cyclesRecomputed : 0;
    return { settings: asSocialSettings(raw), cyclesRecomputed };
  });
}

/** `PUT cycles`: upserts each (engagement, month) deadline in one transaction; one bad row refuses all. Answers the month's table. */
export async function saveCycleDeadlines(
  month: string, rows: Array<{ engagementId: string; deadline: string }>,
): Promise<CyclesActionResult<{ table: CycleTable }>> {
  return run(async (c) => {
    const raw = await platformFetch<unknown>(`${base(c.tenant)}/cycles`, c.userId, { method: "PUT", body: JSON.stringify({ month, rows }) });
    revalidatePath("/departments", "layout");
    return { table: asCycleTable(raw) };
  });
}

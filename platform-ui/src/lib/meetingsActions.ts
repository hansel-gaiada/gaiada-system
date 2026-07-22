"use server";
// WS11 capture edge — server actions for the recordings registry. The backend Cerbos policy
// (resource_meeting_recording) is the real boundary; recording is member-level ("whoever did the
// meeting"), so these require only an authenticated session + active company. Ingest PROXIES the
// frozen contract server-side (the platform holds N8N_BRIDGE_SECRET) — the browser never sees it.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";

export type MeetingResult = { ok: boolean; error?: string; id?: string; runId?: string | null; reason?: string };

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

function fail(e: unknown): MeetingResult {
  if (e instanceof PlatformError) return { ok: false, error: e.message };
  throw e;
}

/** Register a recording (the "2 buttons": kind = audio | video). Mints a stable meetingId server-side.
 *  In the helper-installed flow the helper calls this; here it also backs a manual "register" form. */
export async function startRecordingAction(_prev: MeetingResult | null, formData: FormData): Promise<MeetingResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const title = String(formData.get("title") ?? "").trim();
  const kind = String(formData.get("kind") ?? "audio");
  const clientId = String(formData.get("clientId") ?? "") || undefined;
  const projectId = String(formData.get("projectId") ?? "") || undefined;
  if (!["audio", "video"].includes(kind)) return { ok: false, error: "kind must be audio or video." };
  try {
    const r = await platformFetch<{ id: string }>(`/api/${c.tenant}/meetings/recordings/start`, c.userId, {
      method: "POST",
      body: JSON.stringify({ title: title || undefined, kind, clientId, projectId }),
    });
    revalidatePath("/meetings");
    return { ok: true, id: r.id };
  } catch (e) {
    return fail(e);
  }
}

/** Store the transcript (local whisper output, or a paste in the degrade path) → status transcribed. */
export async function setTranscriptAction(_prev: MeetingResult | null, formData: FormData): Promise<MeetingResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const id = String(formData.get("id") ?? "");
  const text = String(formData.get("text") ?? "").trim();
  if (!id || !text) return { ok: false, error: "A recording and transcript text are required." };
  try {
    await platformFetch(`/api/${c.tenant}/meetings/recordings/${id}/transcript`, c.userId, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    revalidatePath("/meetings");
    revalidatePath(`/meetings/${id}`);
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

/** Kick the delivery pipeline: proxy the frozen contract to the dispatcher (secret stays server-side). */
export async function ingestAction(_prev: MeetingResult | null, formData: FormData): Promise<MeetingResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, error: "recording id required." };
  try {
    const r = await platformFetch<{ ok: boolean; runId?: string | null; reason?: string }>(
      `/api/${c.tenant}/meetings/recordings/${id}/ingest`,
      c.userId,
      // platformFetch always sets content-type: application/json, and Fastify rejects that with an
      // empty body — so send an explicit empty object even though the endpoint takes no fields.
      { method: "POST", body: JSON.stringify({}) },
    );
    revalidatePath("/meetings");
    revalidatePath(`/meetings/${id}`);
    if (!r.ok) {
      const msg = r.reason === "bridge_not_configured"
        ? "Pipeline bridge not configured — set N8N_WEBHOOK_BASE_URL + N8N_BRIDGE_SECRET on the platform."
        : `Dispatcher error: ${r.reason ?? "unknown"}.`;
      return { ok: false, error: msg, reason: r.reason };
    }
    return { ok: true, id, runId: r.runId ?? null };
  } catch (e) {
    return fail(e);
  }
}

/** Record the Drive sync state (the "local first, remind them" nudge / the sync result). */
export async function markDriveAction(_prev: MeetingResult | null, formData: FormData): Promise<MeetingResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("driveStatus") ?? "pending");
  const driveLink = String(formData.get("driveLink") ?? "") || undefined;
  if (!id) return { ok: false, error: "recording id required." };
  try {
    await platformFetch(`/api/${c.tenant}/meetings/recordings/${id}/drive`, c.userId, {
      method: "POST",
      body: JSON.stringify({ status, driveLink }),
    });
    revalidatePath("/meetings");
    revalidatePath(`/meetings/${id}`);
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

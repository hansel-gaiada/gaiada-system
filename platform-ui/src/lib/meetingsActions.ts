"use server";
// WS11 capture edge — server actions for the recordings registry. The backend Cerbos policy
// (resource_meeting_recording) is the real boundary; recording is member-level ("whoever did the
// meeting"), so these require only an authenticated session + active company. Ingest PROXIES the
// frozen contract server-side (the platform holds N8N_BRIDGE_SECRET) — the browser never sees it.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, platformUpload, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { isDemoMode } from "./demoMode";

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

// ---- WD-04/WD-07 (Web Dev Phase 1 §12) — in-ERP audio upload, no capture-helper required ----
// The whole point of this path: someone without the desktop capture-helper installed can still
// get a browser recording/file transcribed, by uploading the audio file directly. The backend
// (`MeetingRecordingsController.uploadAudio`) validates size/type synchronously and answers 202
// `{status:"transcribing"}` immediately; transcription runs as a detached job against the whisper
// container and flips the row to `transcribed` or `failed` — the UI polls (see
// `AudioUploadForm.tsx`) rather than blocking this action on the transcription itself.
export type AudioUploadResult = MeetingResult & { audioRef?: string | null };

export async function uploadAudioAction(_prev: AudioUploadResult | null, formData: FormData): Promise<AudioUploadResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const id = String(formData.get("id") ?? "");
  const file = formData.get("file");
  if (!id) return { ok: false, error: "recording id required." };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an audio file first." };
  try {
    if (isDemoMode()) {
      const { demoUploadAudio } = await import("./demoMeetings");
      const r = demoUploadAudio(id, file.name, file.size);
      if (r.status >= 300) {
        const j = r.json as { error?: string };
        return { ok: false, error: j.error ?? `demo ${r.status}` };
      }
      revalidatePath("/meetings");
      revalidatePath(`/meetings/${id}`);
      const j = r.json as { status: string; audioRef: string };
      return { ok: true, id, audioRef: j.audioRef };
    }
    const form = new FormData();
    form.append("file", file, file.name);
    const r = await platformUpload<{ id: string; status: string; audioRef: string }>(
      `/api/${c.tenant}/meetings/recordings/${id}/audio`,
      c.userId,
      form,
    );
    revalidatePath("/meetings");
    revalidatePath(`/meetings/${id}`);
    return { ok: true, id, audioRef: r.audioRef };
  } catch (e) {
    return fail(e);
  }
}

/** Retry a failed upload-path transcription — reuses the already-uploaded audio, no re-upload. */
export async function retryAudioAction(_prev: AudioUploadResult | null, formData: FormData): Promise<AudioUploadResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, error: "recording id required." };
  try {
    if (isDemoMode()) {
      const { demoRetryAudio } = await import("./demoMeetings");
      const r = demoRetryAudio(id);
      if (r.status >= 300) {
        const j = r.json as { error?: string };
        return { ok: false, error: j.error ?? `demo ${r.status}` };
      }
      revalidatePath("/meetings");
      revalidatePath(`/meetings/${id}`);
      return { ok: true, id };
    }
    await platformFetch(`/api/${c.tenant}/meetings/recordings/${id}/audio/retry`, c.userId, {
      method: "POST",
      body: JSON.stringify({}),
    });
    revalidatePath("/meetings");
    revalidatePath(`/meetings/${id}`);
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

/** WD-07: the `RecordControls` combined path — no recording row exists yet, so "upload an audio
 *  file" here means register-then-upload in one step, then land on the detail page (where
 *  `AudioUploadForm` takes over the transcribing→transcribed/failed poll). Kept separate from
 *  `uploadAudioAction` (which assumes an existing row from the detail page) because the two forms
 *  have genuinely different inputs (title/client/project vs an existing id). */
export async function registerAndUploadAudioAction(_prev: MeetingResult | null, formData: FormData): Promise<MeetingResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an audio file first." };
  const title = String(formData.get("title") ?? "").trim();
  const clientId = String(formData.get("clientId") ?? "") || undefined;
  const projectId = String(formData.get("projectId") ?? "") || undefined;

  let id: string;
  try {
    const started = await platformFetch<{ id: string }>(`/api/${c.tenant}/meetings/recordings/start`, c.userId, {
      method: "POST",
      body: JSON.stringify({ title: title || undefined, kind: "audio", clientId, projectId }),
    });
    id = started.id;
  } catch (e) {
    return fail(e);
  }

  try {
    if (isDemoMode()) {
      const { demoUploadAudio } = await import("./demoMeetings");
      demoUploadAudio(id, file.name, file.size);
    } else {
      const form = new FormData();
      form.append("file", file, file.name);
      await platformUpload(`/api/${c.tenant}/meetings/recordings/${id}/audio`, c.userId, form);
    }
  } catch {
    // Even if the upload itself failed validation, the recording row now exists — land on its
    // detail page where AudioUploadForm surfaces the error and lets them try again directly.
  }
  revalidatePath("/meetings");
  redirect(`/meetings/${id}`);
}

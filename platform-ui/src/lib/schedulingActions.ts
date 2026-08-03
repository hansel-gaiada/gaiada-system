"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";

// W1 — schedule a meeting and set its participants (owner decision D-3).
//
// This is the step that makes "the client is already there" true: the meeting row exists, scoped to a
// client, a project and BOTH sides' attendees, before anyone presses record. The recorder later
// attaches to that row rather than creating one.
//
// A "use server" module may export ONLY async functions — types and labels live in ./schedulingView.

export type ScheduleResult = { ok: boolean; error?: string; id?: string; meetingId?: string };
export type ParticipantResult = { ok: boolean; error?: string; side?: string };

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

function fail(e: unknown): { ok: false; error: string } {
  // Surface the API's own message: it names WHICH field was rejected (an unparsable time, a bad kind,
  // a project from another tenant), and re-inventing those strings here would drift from the server.
  if (e instanceof PlatformError) return { ok: false, error: e.message };
  return { ok: false, error: "Could not save that. Please try again." };
}

export async function scheduleMeetingAction(
  _prev: ScheduleResult | null,
  formData: FormData,
): Promise<ScheduleResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };

  const local = String(formData.get("scheduledAt") ?? "").trim();
  if (!local) return { ok: false, error: "Pick a date and time." };
  // `datetime-local` yields a zone-less string; `new Date(local)` interprets it in the BROWSER's zone
  // on the client and in the SERVER's zone here. This runs server-side, so send the local string
  // through and let the API parse it — but state the assumption rather than leave it implicit: the
  // platform and the PM are expected to share a timezone. A multi-timezone agency needs an explicit
  // offset in this payload, which is a contract change, not a UI tweak.
  const iso = new Date(local).toISOString();
  if (Number.isNaN(Date.parse(iso))) return { ok: false, error: "That date and time could not be read." };

  const clientId = String(formData.get("clientId") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const kind = String(formData.get("kind") ?? "audio");

  try {
    const r = await platformFetch<{ id: string; meetingId: string }>(
      `/api/${c.tenant}/meetings/recordings/schedule`,
      c.userId,
      {
        method: "POST",
        body: JSON.stringify({
          scheduledAt: iso,
          title: title || undefined,
          kind,
          clientId: clientId || undefined,
          projectId: projectId || undefined,
        }),
      },
    );
    revalidatePath("/meetings");
    if (clientId) revalidatePath(`/clients/${clientId}`);
    if (projectId) revalidatePath(`/projects/${projectId}`);
    return { ok: true, id: r.id, meetingId: r.meetingId };
  } catch (e) {
    return fail(e);
  }
}

export async function addParticipantAction(
  _prev: ParticipantResult | null,
  formData: FormData,
): Promise<ParticipantResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const recordingId = String(formData.get("recordingId") ?? "");
  const userId = String(formData.get("userId") ?? "");
  const clientId = String(formData.get("clientId") ?? "");
  if (!recordingId || !userId) return { ok: false, error: "Missing meeting or person." };
  try {
    // `side` is NOT sent: the API derives it from client_contacts and ignores any claim in the body.
    // Sending one would imply the UI has a say, and it does not.
    const r = await platformFetch<{ side: string }>(
      `/api/${c.tenant}/meetings/recordings/${recordingId}/participants`,
      c.userId,
      { method: "POST", body: JSON.stringify({ userId }) },
    );
    revalidatePath(`/meetings/${recordingId}`);
    if (clientId) revalidatePath(`/clients/${clientId}`);
    return { ok: true, side: r.side };
  } catch (e) {
    return fail(e);
  }
}

export async function removeParticipantAction(
  _prev: ParticipantResult | null,
  formData: FormData,
): Promise<ParticipantResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const recordingId = String(formData.get("recordingId") ?? "");
  const userId = String(formData.get("userId") ?? "");
  const clientId = String(formData.get("clientId") ?? "");
  if (!recordingId || !userId) return { ok: false, error: "Missing meeting or person." };
  try {
    await platformFetch(
      `/api/${c.tenant}/meetings/recordings/${recordingId}/participants/${userId}`,
      c.userId,
      { method: "DELETE" },
    );
    revalidatePath(`/meetings/${recordingId}`);
    if (clientId) revalidatePath(`/clients/${clientId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

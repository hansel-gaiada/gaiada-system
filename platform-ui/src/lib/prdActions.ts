"use server";
// PRD Studio writes. One action: create a briefing AND the project it lives under.
//
// Why both in one action: a briefing (meeting recording) knows its client and its project — nothing
// else — and PRD Studio is a Web Dev tab, so the project is what makes the briefing Web Dev's. In
// Reva's flow the project does not exist yet when the call happens; it is born WITH the briefing.
// Default = create a project named after the briefing (client + this department), then register the
// briefing under it. Optional = file it under an existing project of this client instead.
// Both writes are existing endpoints: `POST /projects` (core.controller) and
// `POST /meetings/recordings/start` (meetings.controller). Cerbos on the backend is the authority for
// both (`project.create`, `meeting_recording`).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";

export type BriefingResult = {
  ok: boolean;
  error?: string;
  /** The recording id, on success. */
  id?: string;
  /** The project the briefing is filed under (created or linked). Present even on a failed
   *  second step, so a created project is never silently orphaned. */
  projectId?: string;
  projectCreated?: boolean;
};

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

function messageOf(e: unknown): string {
  if (e instanceof PlatformError) return e.message;
  throw e;
}

export async function createBriefingAction(_prev: BriefingResult | null, formData: FormData): Promise<BriefingResult> {
  const title = String(formData.get("title") ?? "").trim();
  const clientId = String(formData.get("clientId") ?? "").trim();
  const kind = String(formData.get("kind") ?? "audio");
  const departmentId = String(formData.get("departmentId") ?? "").trim() || undefined;
  const projectMode = String(formData.get("projectMode") ?? "new");
  const linkedProjectId = String(formData.get("projectId") ?? "").trim();

  if (!title) return { ok: false, error: "Give the briefing a title." };
  if (!clientId) return { ok: false, error: "Choose the client." };
  if (!["audio", "video"].includes(kind)) return { ok: false, error: "Medium must be audio or video." };
  if (projectMode === "existing" && !linkedProjectId) return { ok: false, error: "Choose a project to file this under, or switch to “New project”." };

  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };

  let projectId = linkedProjectId;
  let projectCreated = false;
  if (projectMode !== "existing") {
    try {
      const created = await platformFetch<{ id: string }>(`/api/${c.tenant}/projects`, c.userId, {
        method: "POST",
        body: JSON.stringify({ name: title, clientId, departmentId }),
      });
      projectId = created.id;
      projectCreated = true;
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  }

  try {
    const r = await platformFetch<{ id: string; meetingId?: string; deduped?: boolean }>(
      `/api/${c.tenant}/meetings/recordings/start`,
      c.userId,
      { method: "POST", body: JSON.stringify({ title, kind, clientId, projectId }) },
    );
    revalidatePath("/meetings");
    revalidatePath("/projects");
    return { ok: true, id: r.id, projectId, projectCreated };
  } catch (e) {
    const reason = messageOf(e);
    return {
      ok: false,
      projectId,
      projectCreated,
      error: projectCreated
        ? `The project “${title}” was created, but the briefing could not be registered: ${reason}. Try again with “Link an existing project” and pick it.`
        : reason,
    };
  }
}

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
import { getRecording } from "./meetings";

export type BriefingResult = {
  ok: boolean;
  error?: string;
  /** The recording id, on success. */
  id?: string;
  /** The project the briefing is filed under (created or linked). Present even on a failed
   *  second step, so a created project is never silently orphaned. */
  projectId?: string;
  projectCreated?: boolean;
  /** The pipeline run, when the action produced one (startRunManuallyAction). */
  runId?: string;
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
      { method: "POST", body: JSON.stringify({ title, kind, clientId, projectId, departmentId }) },
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

/** The PRD run WITHOUT the AI draft.
 *
 *  "Convert to PRD run" normally asks the platform to `ingest`: the transcript goes to the n8n
 *  dispatcher, an LLM drafts PRD/report/scope, and the run comes back with its stages filled. When
 *  that bridge is not configured (no n8n, or no LLM key behind the gateway) the platform answers
 *  `bridge_not_configured` and nothing happens. This is the same run, started by hand: created
 *  directly from the briefing with its three stages PENDING, so a person writes or pastes the PRD in
 *  the run workspace and opens GM review there. Same client, same project, same approvals after
 *  that — the capability works under a human exactly as it does under the automation.
 *
 *  Writes, all existing endpoints: `POST /pipeline/runs` (dedupes on the meeting id, so a second
 *  click returns the same run), `PATCH /meetings/recordings/:id {status:"ingested"}` (the card
 *  leaves the capture list), and best-effort `POST /meetings/recordings/relink-orphans` (sets
 *  `pipeline_run_id`; company_admin only — a refusal is not a failure, the run still links back
 *  through `source_meeting_id`). */
export async function startRunManuallyAction(_prev: BriefingResult | null, formData: FormData): Promise<BriefingResult> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, error: "recording id required." };
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };

  const read = await getRecording(c.userId, c.tenant, id);
  if (read.kind === "forbidden") return { ok: false, error: "You don't have permission to convert this briefing." };
  if (read.kind === "unavailable") return { ok: false, error: "The platform is not answering right now — try again in a moment." };
  const rec = read.data;
  if (!rec) return { ok: false, error: "This briefing no longer exists." };
  if (!rec.transcript || !rec.transcript.trim()) return { ok: false, error: "This briefing has no transcript yet — add the recording or upload a transcript first." };

  let runId: string;
  try {
    const run = await platformFetch<{ id: string; deduped?: boolean }>(`/api/${c.tenant}/pipeline/runs`, c.userId, {
      method: "POST",
      body: JSON.stringify({
        sourceMeetingId: rec.meeting_id,
        title: rec.title ?? "Untitled briefing",
        clientId: rec.client_id ?? undefined,
        projectId: rec.project_id ?? undefined,
        stages: [
          { track: "delivery", name: "prd_extract", status: "pending" },
          { track: "report", name: "report_extract", status: "pending" },
          { track: "scope", name: "scope_extract", status: "pending" },
        ],
      }),
    });
    runId = run.id;
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  }

  try {
    await platformFetch(`/api/${c.tenant}/meetings/recordings/${id}`, c.userId, { method: "PATCH", body: JSON.stringify({ status: "ingested" }) });
  } catch (e) {
    return { ok: false, runId, error: `The run was created (open it under PRD runs), but the briefing could not be marked as converted: ${messageOf(e)}` };
  }
  try {
    await platformFetch(`/api/${c.tenant}/meetings/recordings/relink-orphans`, c.userId, { method: "POST", body: JSON.stringify({}) });
  } catch (e) {
    if (!(e instanceof PlatformError)) throw e; // a refusal here is expected for non-admins; the run still links via source_meeting_id
  }

  revalidatePath("/meetings");
  revalidatePath(`/meetings/${id}`);
  revalidatePath("/pipeline");
  return { ok: true, id, runId };
}

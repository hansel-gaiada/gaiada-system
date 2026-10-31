"use server";
// SCP-5 W5-A6 (BFF §63.24.9): report automation's writes and the one run read.
//
//   saveSchedule     `POST report-schedules`            a new schedule; `id` is the dialog's own uuid, so a retry of the click is the same schedule
//   editSchedule     `PATCH report-schedules/:id`       only what changed (scope, clients, timing); the caller becomes the owner
//   setScheduleOn    `PATCH report-schedules/:id`       `{enabled}`: pause (reason `manual`) or resume (clears the pause, computes the next run; the caller becomes the owner)
//   deleteSchedule   `DELETE report-schedules/:id`      a soft delete; a run already started finishes
//   runScheduleNow   `POST report-schedules/:id/run`    drafts the period that has just ended, as the caller; 202 a started run, 200 `alreadyApplied`
//   getRunProgress   `GET reports/generate/:runId`      one run's progress and its usage (63.24.5), for "this run's cost"
//
// The gates here are hints; the server's refusal is the boundary (the four only). Every refusal comes back as the contract's own code in `error` with the words for it in `message`.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { refusalFromBody, type Refusal } from "./socialPipeline";
import { asRunNow, asRunProgress, asSaved, scheduleRefusalText, type ReportSchedule, type RunNowAnswer, type RunProgress, type ScheduleWrite } from "./socialReportSchedules";

export type ScheduleActionResult<T = object> = ({ ok: true } & T) | { ok: false; refusal: Refusal; message: string };

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;
const fail = (refusal: Refusal, kind: ScheduleWrite): { ok: false; refusal: Refusal; message: string } => ({ ok: false, refusal, message: scheduleRefusalText(refusal, kind) });

async function run<T extends object>(kind: ScheduleWrite, fn: (c: { userId: string; tenant: string }) => Promise<T>, refresh = true): Promise<ScheduleActionResult<T>> {
  const userId = await getSessionUserId();
  if (!userId) return fail({ status: 401, error: "session_expired" }, kind);
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return fail({ status: 400, error: "no_company" }, kind);
  try {
    const out = await fn({ userId, tenant });
    if (refresh) revalidatePath("/departments", "layout");
    return { ok: true, ...out };
  } catch (e) {
    if (e instanceof PlatformError) return fail(refusalFromBody(e.status, e.message, e.body, e.field, e.reason), kind);
    throw e;
  }
}

/** `POST report-schedules` with the dialog's body (built by `buildBody`, with a fresh `id`). */
export async function saveSchedule(body: Record<string, unknown>): Promise<ScheduleActionResult<{ schedule: ReportSchedule; created: boolean }>> {
  return run("save", async (c) => asSaved(await platformFetch<unknown>(`${base(c.tenant)}/report-schedules`, c.userId, { method: "POST", body: JSON.stringify(body) })));
}

/** `PATCH report-schedules/:id` with only the fields that changed. */
export async function editSchedule(id: string, body: Record<string, unknown>): Promise<ScheduleActionResult> {
  return run("save", async (c) => {
    await platformFetch<unknown>(`${base(c.tenant)}/report-schedules/${encodeURIComponent(id)}`, c.userId, { method: "PATCH", body: JSON.stringify(body) });
    return {};
  });
}

/** Pause (`enabled: false`) or resume (`enabled: true`). */
export async function setScheduleOn(id: string, enabled: boolean): Promise<ScheduleActionResult> {
  return run(enabled ? "resume" : "pause", async (c) => {
    await platformFetch<unknown>(`${base(c.tenant)}/report-schedules/${encodeURIComponent(id)}`, c.userId, { method: "PATCH", body: JSON.stringify({ enabled }) });
    return {};
  });
}

/** `DELETE report-schedules/:id`. */
export async function deleteSchedule(id: string): Promise<ScheduleActionResult> {
  return run("delete", async (c) => {
    await platformFetch<unknown>(`${base(c.tenant)}/report-schedules/${encodeURIComponent(id)}`, c.userId, { method: "DELETE" });
    return {};
  });
}

/** "Run now": starts a generation run for the schedule's kind and the period that has just ended, as the caller. */
export async function runScheduleNow(id: string): Promise<ScheduleActionResult<{ answer: RunNowAnswer }>> {
  return run("run", async (c) => ({ answer: asRunNow(await platformFetch<unknown>(`${base(c.tenant)}/report-schedules/${encodeURIComponent(id)}/run`, c.userId, { method: "POST" })) }));
}

/** `GET reports/generate/:runId`: one run's progress and usage (the run's person or one of the four; else 404 `run_not_found`). */
export async function getRunProgress(runId: string): Promise<ScheduleActionResult<{ run: RunProgress }>> {
  return run("run", async (c) => ({ run: asRunProgress(await platformFetch<unknown>(`${base(c.tenant)}/reports/generate/${encodeURIComponent(runId)}`, c.userId)) }), false);
}

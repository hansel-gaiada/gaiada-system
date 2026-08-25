"use server";
// LMS learner write path — submitting an attempt at an activity. Mirrors lmsActions.ts's
// ctx()+send() convention, but this is the OTHER side of the module: lmsActions.ts is authoring
// (L3, `lms.authoring`/`lms.publish`), this is the learner acting on their OWN assignment
// (`activities/:id/attempts`, which authorizes as `lms_enrollment` server-side — no subjectUserId
// is ever sent from here, so the backend grades the CALLER, never a name this layer supplies).
//
// ⚠ NEVER SEND `subjectUserId`. A learner's own attempt has no business naming who it is for — the
//   backend derives it from the session, and adding the field here would be this layer inventing an
//   attack surface the endpoint does not otherwise have.
//
// ⚠ A LAB WITH NO RUNNER CONFIGURED 503s with a message meant to be read verbatim ("your work has
//   NOT been recorded — nothing was lost"). That message is returned here as `error`, exactly like
//   any other PlatformError, and the caller (LabPlayer) renders it rather than a generic failure —
//   see lms-learn.controller.ts's `submitLabAttempt` for why the wording matters.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";

export type QuizResult = {
  ok: boolean;
  error?: string;
  attemptId?: string;
  attemptNo?: number;
  score?: number | null;
  passed?: boolean | null;
  /** Per-question right/wrong, when the backend's quiz grader returns it. */
  perQuestion?: { id: string; correct: boolean }[];
  certification?: { hrRecordId: string; expiresOn: string | null } | null;
};

export type LabResult = {
  ok: boolean;
  error?: string;
  attemptId?: string;
  attemptNo?: number;
  score?: number | null;
  passed?: boolean | null;
  checks?: { describe: string; passed: boolean; detail?: string }[];
  stdout?: string;
  stderr?: string;
  note?: string;
  certification?: { hrRecordId: string; expiresOn: string | null } | null;
};

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

function reval(tenant: string, courseId: string) {
  void tenant;
  if (courseId) revalidatePath(`/learning/courses/${courseId}`);
  revalidatePath("/me/learning");
}

/** Submit a quiz attempt: `{ questionId: optionIndex }`. Auto-graded immediately by the backend. */
export async function submitQuiz(formData: FormData): Promise<QuizResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };

  const activityId = String(formData.get("activityId") ?? "");
  const courseId = String(formData.get("courseId") ?? "");
  if (!activityId) return { ok: false, error: "No activity selected." };

  let submission: Record<string, unknown>;
  try {
    submission = JSON.parse(String(formData.get("submission") ?? "{}"));
  } catch {
    return { ok: false, error: "Could not read your answers — try again." };
  }

  try {
    const res = await platformFetch<{
      attemptId: string; attemptNo: number; score: number | null; passed: boolean | null;
      result?: { perQuestion?: { id: string; correct: boolean }[] };
      certification?: { hrRecordId: string; expiresOn: string | null } | null;
    }>(`/api/${c.tenant}/modules/lms/activities/${activityId}/attempts`, c.userId, {
      method: "POST",
      body: JSON.stringify({ submission }),
    });
    reval(c.tenant, courseId);
    return {
      ok: true,
      attemptId: res.attemptId, attemptNo: res.attemptNo, score: res.score, passed: res.passed,
      perQuestion: res.result?.perQuestion,
      certification: res.certification ?? null,
    };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Submit a lab attempt: files the learner wrote. 503s with a clear message if no runner exists. */
export async function submitLab(formData: FormData): Promise<LabResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };

  const activityId = String(formData.get("activityId") ?? "");
  const courseId = String(formData.get("courseId") ?? "");
  if (!activityId) return { ok: false, error: "No activity selected." };

  let files: { path: string; content: string }[];
  try {
    files = JSON.parse(String(formData.get("files") ?? "[]"));
  } catch {
    return { ok: false, error: "Could not read your files — try again." };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: "At least one file is required." };
  }

  try {
    const res = await platformFetch<{
      attemptId: string; attemptNo: number; score: number | null; passed: boolean | null;
      checks?: { describe: string; passed: boolean; detail?: string }[];
      stdout?: string; stderr?: string; note?: string;
      certification?: { hrRecordId: string; expiresOn: string | null } | null;
    }>(`/api/${c.tenant}/modules/lms/activities/${activityId}/attempts`, c.userId, {
      method: "POST",
      body: JSON.stringify({ submission: { files } }),
    });
    reval(c.tenant, courseId);
    return {
      ok: true,
      attemptId: res.attemptId, attemptNo: res.attemptNo, score: res.score, passed: res.passed,
      checks: res.checks, stdout: res.stdout, stderr: res.stderr, note: res.note,
      certification: res.certification ?? null,
    };
  } catch (e) {
    // A 503 ("lab runner not configured") arrives here exactly like any other failure — the
    // message IS the useful part, so it is returned rather than swallowed behind a generic string.
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

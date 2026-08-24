"use server";
// LMS authoring write paths (L3) — the surface a department head uses to build their own
// curriculum. Mirrors the lib/hrActions.ts `ctx()` + `send()` convention.
//
// RBAC here is DEFENCE IN DEPTH ONLY. Cerbos decides, and it decides on something this layer
// cannot see: `resource_lms_course.yaml`'s `org_unit_lead` arm matches on the course's own
// `unitAncestors`, resolved server-side from its `unit_node_id`. A department head may author for
// their own unit and no other, and no client-side check can express that bound — `can(me,
// "lms.authoring")` answers "may ask", never "may touch this course".
//
// ⚠ THE ONE RULE THAT SURPRISES AUTHORS: editing a PUBLISHED course does not edit it. The backend
//   forks a NEW DRAFT VERSION carrying the modules and activities across, and answers
//   `{ versioned: true, version }`. Every mutating action here surfaces that rather than swallowing
//   it — an author who thinks they corrected a typo in the live course, and did not, will not find
//   out until a learner asks why the fix is missing.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import type { ActivityKind, Grading, Level, Track } from "./lms";

export type LmsResult = {
  ok: boolean;
  error?: string;
  field?: string;
  id?: string;
  /** TRUE when the backend forked a new version instead of editing in place. */
  versioned?: boolean;
  version?: number;
  note?: string;
};

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

async function send(
  tenant: string, userId: string, path: string, method: string, bodyObj?: unknown,
): Promise<LmsResult> {
  try {
    const res = await platformFetch<{ id?: string; versioned?: boolean; version?: number; note?: string }>(
      `/api/${tenant}/modules/lms${path}`, userId,
      { method, ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}) },
    );
    return { ok: true, id: res?.id, versioned: res?.versioned, version: res?.version, note: res?.note };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message, field: e.field };
    throw e;
  }
}

function reval(courseId?: string) {
  revalidatePath("/learning/authoring");
  revalidatePath("/learning/catalogue");
  if (courseId) revalidatePath(`/learning/courses/${courseId}`);
}

/** Shared gate. Cheap, and it keeps a 403 from looking like a broken form. */
function guard(me: Me, tenant: string, cap: "lms.authoring" | "lms.publish"): string | null {
  if (!can(me, cap, tenant)) {
    return cap === "lms.publish"
      ? "You can edit training but not publish it. A department head or company administrator publishes."
      : "You do not have authoring rights for training in this company.";
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────── courses ────────────────
export async function createCourse(formData: FormData): Promise<LmsResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const denied = guard(c.me, c.tenant, "lms.authoring");
  if (denied) return { ok: false, error: denied };

  const courseKey = String(formData.get("courseKey") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  if (!courseKey) return { ok: false, error: "A course key is required.", field: "courseKey" };
  if (!title) return { ok: false, error: "A title is required.", field: "title" };
  // The key is the STABLE identity across versions, so it has to survive a title change and be
  // safe in a URL. Validated here rather than silently slugified: an author who typed
  // "FE Basics!" should be told what the key will be, not have one chosen for them.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(courseKey)) {
    return {
      ok: false, field: "courseKey",
      error: "The course key must be lowercase letters, numbers and hyphens — it is the permanent identity across versions.",
    };
  }

  const track = (String(formData.get("track") ?? "department") || "department") as Track;
  const unitNodeId = String(formData.get("unitNodeId") ?? "").trim();
  // The database enforces this too (ck_lms_courses_track_unit). Caught here so the author gets a
  // sentence instead of a constraint name.
  if (track === "department" && !unitNodeId) {
    return { ok: false, field: "unitNodeId", error: "A department course must name the department it belongs to." };
  }
  if (track === "general" && unitNodeId) {
    return {
      ok: false, field: "track",
      error: "A general-track course belongs to no department — it is the material every employee takes.",
    };
  }

  const r = await send(c.tenant, c.userId, "/courses", "POST", {
    courseKey, title,
    summary: String(formData.get("summary") ?? "").trim() || undefined,
    track,
    unitNodeId: unitNodeId || undefined,
    discipline: String(formData.get("discipline") ?? "").trim() || undefined,
    level: (String(formData.get("level") ?? "foundation") || "foundation") as Level,
    estimatedMinutes: Number(formData.get("estimatedMinutes")) || undefined,
  });
  if (r.ok) reval();
  return r;
}

export async function updateCourse(formData: FormData): Promise<LmsResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const denied = guard(c.me, c.tenant, "lms.authoring");
  if (denied) return { ok: false, error: denied };

  const courseId = String(formData.get("courseId") ?? "");
  if (!courseId) return { ok: false, error: "No course selected." };
  const body: Record<string, unknown> = {};
  for (const key of ["title", "summary", "discipline", "level"]) {
    const v = formData.get(key);
    if (v !== null) body[key] = String(v).trim();
  }
  const minutes = Number(formData.get("estimatedMinutes"));
  if (minutes) body.estimatedMinutes = minutes;

  const r = await send(c.tenant, c.userId, `/courses/${courseId}`, "PATCH", body);
  if (r.ok) {
    reval(courseId);
    if (r.versioned) {
      // SAID, not swallowed. The author is now looking at a different row than the one they edited,
      // and the live course still says what it said before.
      reval(r.id);
      r.note = r.note ??
        `That course was published, so your edit opened version ${r.version} as a new DRAFT. ` +
        `The published version is unchanged until you publish this one.`;
    }
  }
  return r;
}

export async function publishCourse(formData: FormData): Promise<LmsResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const denied = guard(c.me, c.tenant, "lms.publish");
  if (denied) return { ok: false, error: denied };
  const courseId = String(formData.get("courseId") ?? "");
  if (!courseId) return { ok: false, error: "No course selected." };
  const r = await send(c.tenant, c.userId, `/courses/${courseId}/publish`, "POST");
  if (r.ok) reval(courseId);
  return r;
}

export async function retireCourse(formData: FormData): Promise<LmsResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  // Retiring is a PUBLISH-tier act, not an editing one: it withdraws material people may be
  // mid-way through. Existing enrolments keep working; no new ones can start.
  const denied = guard(c.me, c.tenant, "lms.publish");
  if (denied) return { ok: false, error: denied };
  const courseId = String(formData.get("courseId") ?? "");
  if (!courseId) return { ok: false, error: "No course selected." };
  const r = await send(c.tenant, c.userId, `/courses/${courseId}/retire`, "POST");
  if (r.ok) reval(courseId);
  return r;
}

// ─────────────────────────────────────────────────────────── modules + activities ─────────────
export async function addModule(formData: FormData): Promise<LmsResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const denied = guard(c.me, c.tenant, "lms.authoring");
  if (denied) return { ok: false, error: denied };
  const courseId = String(formData.get("courseId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!courseId) return { ok: false, error: "No course selected." };
  if (!title) return { ok: false, error: "A module title is required.", field: "title" };
  const r = await send(c.tenant, c.userId, `/courses/${courseId}/modules`, "POST", {
    title,
    summary: String(formData.get("summary") ?? "").trim() || undefined,
    sortOrder: Number(formData.get("sortOrder")) || undefined,
  });
  if (r.ok) reval(courseId);
  return r;
}

export async function addActivity(formData: FormData): Promise<LmsResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const denied = guard(c.me, c.tenant, "lms.authoring");
  if (denied) return { ok: false, error: denied };

  const moduleId = String(formData.get("moduleId") ?? "");
  const courseId = String(formData.get("courseId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const kind = (String(formData.get("kind") ?? "read") || "read") as ActivityKind;
  const grading = (String(formData.get("grading") ?? "none") || "none") as Grading;
  if (!moduleId) return { ok: false, error: "No module selected." };
  if (!title) return { ok: false, error: "An activity title is required.", field: "title" };

  // `spec` is free-form jsonb whose shape depends on the kind, so it arrives as JSON text. Parsed
  // HERE so a typo is a sentence rather than a 400 from Fastify with no field attached.
  const rawSpec = String(formData.get("spec") ?? "").trim();
  let spec: unknown = {};
  if (rawSpec) {
    try { spec = JSON.parse(rawSpec); }
    catch { return { ok: false, field: "spec", error: "The activity body is not valid JSON." }; }
  }

  const passThreshold = Number(formData.get("passThreshold"));
  // The database refuses this too (ck_lms_activities_threshold). Explained here, because
  // "violates check constraint" tells an author nothing about what to do next.
  if (grading === "auto" && kind !== "read" && kind !== "watch" && !passThreshold) {
    return {
      ok: false, field: "passThreshold",
      error: "An automatically graded activity needs a pass mark — without one, nothing could ever pass it.",
    };
  }
  if (kind === "lab" && grading !== "auto") {
    return {
      ok: false, field: "grading",
      error: "A lab is graded by the runner, so it must be automatic. A reviewed lab is a contradiction.",
    };
  }
  // A quiz with no questions grades every submission as wrong and the course becomes impossible to
  // pass — which presents to a learner as "the training is too hard", never as a data defect.
  if (kind === "quiz" && grading === "auto") {
    const qs = (spec as { questions?: unknown[] })?.questions;
    if (!Array.isArray(qs) || qs.length === 0) {
      return { ok: false, field: "spec", error: "An automatically graded quiz needs a `questions` array in its body." };
    }
    const missing = qs.findIndex((q) => (q as { answer?: unknown })?.answer === undefined);
    if (missing >= 0) {
      return {
        ok: false, field: "spec",
        error: `Question ${missing + 1} has no \`answer\`. Every question needs one, or nobody can answer it correctly.`,
      };
    }
  }

  const r = await send(c.tenant, c.userId, `/modules/${moduleId}/activities`, "POST", {
    kind, title, spec, grading,
    sortOrder: Number(formData.get("sortOrder")) || undefined,
    isRequired: formData.get("isRequired") !== null,
    passThreshold: passThreshold || undefined,
    maxAttempts: Number(formData.get("maxAttempts")) || undefined,
    estimatedMinutes: Number(formData.get("estimatedMinutes")) || undefined,
  });
  if (r.ok) reval(courseId);
  return r;
}

export async function deleteActivity(formData: FormData): Promise<LmsResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const denied = guard(c.me, c.tenant, "lms.authoring");
  if (denied) return { ok: false, error: denied };
  const activityId = String(formData.get("activityId") ?? "");
  const courseId = String(formData.get("courseId") ?? "");
  if (!activityId) return { ok: false, error: "No activity selected." };
  const r = await send(c.tenant, c.userId, `/activities/${activityId}`, "DELETE");
  if (r.ok) reval(courseId);
  return r;
}

// ─────────────────────────────────────────────────────────────────────── paths ────────────────
export async function createPath(formData: FormData): Promise<LmsResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const denied = guard(c.me, c.tenant, "lms.authoring");
  if (denied) return { ok: false, error: denied };

  const pathKey = String(formData.get("pathKey") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  if (!pathKey) return { ok: false, error: "A path key is required.", field: "pathKey" };
  if (!title) return { ok: false, error: "A title is required.", field: "title" };
  const isMandatory = formData.get("isMandatory") !== null;
  const track = (String(formData.get("track") ?? "department") || "department") as Track;
  // ck_lms_paths_mandatory_scope, in a sentence. Only the general track may be required of
  // everybody — a department head must not be able to make their own material company-mandatory.
  if (isMandatory && track !== "general") {
    return {
      ok: false, field: "isMandatory",
      error: "Only a general-track path can be required of every employee. A department path is assigned, not mandatory for all.",
    };
  }

  const r = await send(c.tenant, c.userId, "/paths", "POST", {
    pathKey, title,
    summary: String(formData.get("summary") ?? "").trim() || undefined,
    track,
    unitNodeId: String(formData.get("unitNodeId") ?? "").trim() || undefined,
    discipline: String(formData.get("discipline") ?? "").trim() || undefined,
    level: (String(formData.get("level") ?? "foundation") || "foundation") as Level,
    isMandatory,
    dueDays: Number(formData.get("dueDays")) || undefined,
    certificationValidMonths: Number(formData.get("certificationValidMonths")) || undefined,
    certificationLabel: String(formData.get("certificationLabel") ?? "").trim() || undefined,
  });
  if (r.ok) reval();
  return r;
}

export async function addCourseToPath(formData: FormData): Promise<LmsResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const denied = guard(c.me, c.tenant, "lms.authoring");
  if (denied) return { ok: false, error: denied };
  const pathId = String(formData.get("pathId") ?? "");
  const courseKey = String(formData.get("courseKey") ?? "").trim();
  if (!pathId) return { ok: false, error: "No path selected." };
  if (!courseKey) return { ok: false, error: "Pick a course.", field: "courseKey" };
  const r = await send(c.tenant, c.userId, `/paths/${pathId}/courses`, "POST", {
    courseKey,
    position: Number(formData.get("position")) || undefined,
    requiresPrevious: formData.get("requiresPrevious") !== null,
    isOptional: formData.get("isOptional") !== null,
  });
  if (r.ok) reval();
  return r;
}

export async function publishPath(formData: FormData): Promise<LmsResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const denied = guard(c.me, c.tenant, "lms.publish");
  if (denied) return { ok: false, error: denied };
  const pathId = String(formData.get("pathId") ?? "");
  if (!pathId) return { ok: false, error: "No path selected." };
  const r = await send(c.tenant, c.userId, `/paths/${pathId}/publish`, "POST");
  if (r.ok) reval();
  return r;
}

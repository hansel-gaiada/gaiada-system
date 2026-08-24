import "server-only";
// LMS L1c — DEMO_MODE fixtures for `/api/:t/modules/lms/*`.
//
// STATEFUL for authoring (L3), refusing for everything else — and the split is the point.
//
// L1c shipped only reads, so this store began read-only: a fixture that accepts a write it cannot
// model lets a page look like it worked. L3 adds the authoring surface, and the ONE rule that
// surface exists to teach — editing a PUBLISHED course forks a new version rather than changing it
// — cannot be exercised at all unless the fixture remembers what it was told. So courses, modules
// and activities are a real in-memory store with the versioning rule implemented.
//
// ATTEMPT SUBMISSION IS STILL REFUSED. Grading a lab is L5's runner and this fixture cannot mark
// one; a demo that returned a cheerful pass would be exactly the confident wrong answer about
// somebody's training that this file exists to prevent.
//
// Why it exists at all: `next build` runs with DEMO_MODE=1 and the smoke Playwright project drives
// the built app, so an LMS route with no fixture is a route nobody can open in CI. Without this the
// four new pages would render their empty states forever and the "nothing published" copy — which
// is a CLAIM about the company — would be the only thing anyone ever saw.
//
// The numbers below are deliberately NOT all-green: one required path is overdue for the demo user
// and mandatory coverage sits under 100%. A demo estate where every compliance figure is perfect
// cannot exercise the warning banner, which is the part of this surface most worth seeing.
import type { Activity, Course, CourseDetail, LearningPath, MyLearning, ComplianceRow } from "./lms";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });

// Monotonic, NOT Date.now(): an id that changes between two renders of the same page makes a
// Playwright assertion flaky for a reason nobody would guess from the failure text.
let idSeq = 100;
const nextId = () => String(idSeq++);

const COURSES: Course[] = [
  {
    id: "demo-lms-c1", courseKey: "general-erp-basics", version: 2, title: "Using the ERP",
    summary: "The surfaces every employee touches: My Work, leave, approvals and the company switcher.",
    track: "general", unitNodeId: null, discipline: null, level: "foundation",
    status: "published", estimatedMinutes: 75, publishedAt: "2026-08-01", createdAt: "2026-07-20",
  },
  {
    id: "demo-lms-c2", courseKey: "general-claude-usage", version: 1, title: "Working with Claude",
    summary: "What to delegate, what to check, and what never to paste into a prompt.",
    track: "general", unitNodeId: null, discipline: null, level: "foundation",
    status: "published", estimatedMinutes: 90, publishedAt: "2026-08-04", createdAt: "2026-07-28",
  },
  {
    id: "demo-lms-c3", courseKey: "webdev-fe-foundations", version: 1, title: "Frontend foundations",
    summary: "Components, state and the render boundary — with a build you actually run.",
    track: "department", unitNodeId: "dept-webdev", discipline: "FE", level: "practitioner",
    status: "published", estimatedMinutes: 320, publishedAt: "2026-08-10", createdAt: "2026-08-02",
  },
  {
    id: "demo-lms-c4", courseKey: "webdev-devops-pipelines", version: 1, title: "Pipelines and rollout",
    summary: "Build, sign, ship and roll back — graded on the artefacts your pipeline produces.",
    track: "department", unitNodeId: "dept-webdev", discipline: "DevOps", level: "advanced",
    status: "published", estimatedMinutes: 480, publishedAt: "2026-08-12", createdAt: "2026-08-05",
  },
  {
    id: "demo-lms-c5", courseKey: "webdev-security-basics", version: 1, title: "Web security fundamentals",
    summary: "The vulnerability classes that reach production, against a target you are allowed to break.",
    track: "department", unitNodeId: "dept-webdev", discipline: "Cyber Security", level: "practitioner",
    status: "published", estimatedMinutes: 400, publishedAt: "2026-08-14", createdAt: "2026-08-06",
  },
  {
    id: "demo-lms-c6", courseKey: "mgmt-running-a-department", version: 1, title: "Running a department",
    summary: "Capacity, the ball, appraisals and the numbers a head is answerable for.",
    track: "department", unitNodeId: "dept-gm", discipline: "Management", level: "lead",
    status: "published", estimatedMinutes: 240, publishedAt: "2026-08-15", createdAt: "2026-08-08",
  },
];

const DETAIL: Record<string, CourseDetail> = {
  "demo-lms-c1": {
    ...COURSES[0], knowledgeSourceId: "demo-know-1", authoredBy: "demo-hansel",
    modules: [
      {
        id: "demo-lms-m1", sortOrder: 1, title: "Finding your way around",
        summary: "The shell, the company switcher and where your own things live.",
        activities: [
          { id: "demo-lms-a1", moduleId: "demo-lms-m1", sortOrder: 1, kind: "read", title: "The shell and the sidebar", spec: {}, isRequired: true, passThreshold: null, grading: "none", maxAttempts: null, estimatedMinutes: 15 },
          { id: "demo-lms-a2", moduleId: "demo-lms-m1", sortOrder: 2, kind: "watch", title: "Switching companies without losing context", spec: {}, isRequired: true, passThreshold: null, grading: "none", maxAttempts: null, estimatedMinutes: 10 },
        ],
      },
      {
        id: "demo-lms-m2", sortOrder: 2, title: "Doing your own admin",
        summary: "Leave, loans, payslips and approvals — the four you will use every month.",
        activities: [
          { id: "demo-lms-a3", moduleId: "demo-lms-m2", sortOrder: 1, kind: "read", title: "Filing leave and reading your balance", spec: {}, isRequired: true, passThreshold: null, grading: "none", maxAttempts: null, estimatedMinutes: 20 },
          { id: "demo-lms-a4", moduleId: "demo-lms-m2", sortOrder: 2, kind: "scenario", title: "Approve, reject, or send back?", spec: {}, isRequired: false, passThreshold: null, grading: "review", maxAttempts: null, estimatedMinutes: 15 },
          { id: "demo-lms-a5", moduleId: "demo-lms-m2", sortOrder: 3, kind: "quiz", title: "ERP basics check", spec: {}, isRequired: true, passThreshold: "0.80", grading: "auto", maxAttempts: 3, estimatedMinutes: 15 },
        ],
      },
    ],
  },
};

const PATHS: LearningPath[] = [
  {
    id: "demo-lms-p1", pathKey: "general-induction", title: "Everyone: the fundamentals",
    summary: "ERP usage, Claude usage and how we work. Required of every employee.",
    track: "general", unitNodeId: null, discipline: null, level: "foundation", status: "published",
    isMandatory: true, appliesTo: "all_employees", dueDays: 30,
    certificationValidMonths: 24, certificationLabel: "Gaiada Fundamentals", courseCount: 2,
  },
  {
    id: "demo-lms-p2", pathKey: "webdev-fe-track", title: "Web Dev — Frontend",
    summary: "Foundations through production work, in order.",
    track: "department", unitNodeId: "dept-webdev", discipline: "FE", level: "practitioner",
    status: "published", isMandatory: false, appliesTo: "unit", dueDays: null,
    certificationValidMonths: null, certificationLabel: "FE Practitioner", courseCount: 1,
  },
  {
    id: "demo-lms-p3", pathKey: "security-awareness", title: "Security awareness",
    summary: "The annual refresher. Required, and it expires.",
    track: "general", unitNodeId: null, discipline: null, level: "foundation", status: "published",
    isMandatory: true, appliesTo: "all_employees", dueDays: 14,
    certificationValidMonths: 12, certificationLabel: "Security Awareness", courseCount: 1,
  },
  {
    id: "demo-lms-p4", pathKey: "dept-head-track", title: "Department heads",
    summary: "For anyone holding a lead position.",
    track: "department", unitNodeId: "dept-gm", discipline: "Management", level: "lead",
    status: "published", isMandatory: false, appliesTo: "unit", dueDays: null,
    certificationValidMonths: null, certificationLabel: null, courseCount: 1,
  },
];

// One overdue, one in progress, one done — so the warning banner, the due-soon badge and the
// certificate card are all reachable in a browser.
const MINE: MyLearning = {
  enrolments: [
    {
      id: "demo-lms-e1", pathId: "demo-lms-p3", pathKey: "security-awareness",
      title: "Security awareness", isMandatory: true, status: "assigned", source: "auto_mandatory",
      dueOn: "2026-08-18", completedAt: null, overdue: true, startedAt: null,
      coursesRequired: 1, coursesCompleted: 0,
    },
    {
      id: "demo-lms-e2", pathId: "demo-lms-p2", pathKey: "webdev-fe-track",
      title: "Web Dev — Frontend", isMandatory: false, status: "in_progress", source: "self_enrol",
      dueOn: null, completedAt: null, overdue: false, startedAt: "2026-08-11",
      coursesRequired: 1, coursesCompleted: 0,
    },
    {
      id: "demo-lms-e3", pathId: "demo-lms-p1", pathKey: "general-induction",
      title: "Everyone: the fundamentals", isMandatory: true, status: "completed", source: "auto_mandatory",
      dueOn: "2026-08-05", completedAt: "2026-08-03", overdue: false, startedAt: "2026-07-30",
      coursesRequired: 2, coursesCompleted: 2,
    },
  ],
  certifications: [
    { pathKey: "general-induction", completedAt: "2026-08-03", expiresOn: "2028-08-03", finalScore: "0.91" },
  ],
};

const COMPLIANCE: ComplianceRow[] = [
  { pathKey: "general-induction", title: "Everyone: the fundamentals", isMandatory: true, assigned: 23, completed: 19, outstanding: 4, overdue: 1, waived: 0 },
  { pathKey: "security-awareness", title: "Security awareness", isMandatory: true, assigned: 23, completed: 11, outstanding: 12, overdue: 6, waived: 0 },
  { pathKey: "webdev-fe-track", title: "Web Dev — Frontend", isMandatory: false, assigned: 6, completed: 2, outstanding: 4, overdue: 0, waived: 0 },
  { pathKey: "dept-head-track", title: "Department heads", isMandatory: false, assigned: 8, completed: 3, outstanding: 4, overdue: 0, waived: 1 },
];

/** Returns null when the path is not an LMS route, so the caller falls through. */
export function lmsDemo(
  method: string, p: string, qs: URLSearchParams, body?: string,
): DemoResult | null {
  const base = p.match(/^\/api\/[^/]+\/modules\/lms\/(.*)$/);
  if (!base) return null;
  const rest = base[1];
  const m = method.toUpperCase();

  if (m === "GET" && rest === "courses") {
    let out = COURSES;
    const track = qs.get("track");
    const level = qs.get("level");
    const discipline = qs.get("discipline");
    const unit = qs.get("unitNodeId");
    if (track) out = out.filter((c) => c.track === track);
    if (level) out = out.filter((c) => c.level === level);
    if (discipline) out = out.filter((c) => c.discipline === discipline);
    if (unit) out = out.filter((c) => c.unitNodeId === unit);
    return ok(out);
  }

  const courseDetail = rest.match(/^courses\/([^/]+)$/);
  if (m === "GET" && courseDetail) {
    const id = courseDetail[1];
    const known = DETAIL[id];
    if (known) return ok(known);
    const shallow = COURSES.find((c) => c.id === id);
    // A 404 rather than an empty course: `getCourse` rethrows precisely so an unknown id never
    // renders as "this course has no content".
    if (!shallow) return { status: 404, json: { error: "course not found" } };
    return ok({ ...shallow, knowledgeSourceId: null, authoredBy: "demo-hansel", modules: [] } satisfies CourseDetail);
  }

  if (m === "GET" && rest === "paths") {
    const mandatoryOnly = qs.get("mandatory") === "true";
    const track = qs.get("track");
    let out = PATHS;
    if (mandatoryOnly) out = out.filter((x) => x.isMandatory);
    if (track) out = out.filter((x) => x.track === track);
    return ok(out);
  }

  if (m === "GET" && rest === "me") return ok(MINE);
  if (m === "GET" && rest === "compliance") return ok(COMPLIANCE);
  if (m === "GET" && rest === "enrollments") return ok([]);

  // ───────────────────────────────────────────────────────────── authoring (L3) ───────────────
  const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};

  if (m === "POST" && rest === "courses") {
    const id = `demo-lms-c${nextId()}`;
    const course: Course = {
      id, courseKey: String(parsed.courseKey ?? id), version: 1,
      title: String(parsed.title ?? "Untitled"), summary: (parsed.summary as string) ?? null,
      track: (parsed.track as Course["track"]) ?? "department",
      unitNodeId: (parsed.unitNodeId as string) ?? null,
      discipline: (parsed.discipline as string) ?? null,
      level: (parsed.level as Course["level"]) ?? "foundation",
      // A new course is a DRAFT. The catalogue hides it, and that invisibility is exactly what
      // makes a draft safe to work in — a fixture that created it published would hide the
      // single most important property of the authoring surface.
      status: "draft", estimatedMinutes: (parsed.estimatedMinutes as number) ?? null,
      publishedAt: null, createdAt: "2026-08-25",
    };
    COURSES.push(course);
    DETAIL[id] = { ...course, knowledgeSourceId: null, authoredBy: "demo-hansel", modules: [] };
    return { status: 201, json: { id } };
  }

  const patchCourse = rest.match(/^courses\/([^/]+)$/);
  if (m === "PATCH" && patchCourse) {
    const id = patchCourse[1];
    const idx = COURSES.findIndex((c) => c.id === id);
    if (idx < 0) return { status: 404, json: { error: "course not found" } };
    const current = COURSES[idx];
    if (current.status !== "published") {
      COURSES[idx] = {
        ...current,
        ...(parsed.title ? { title: String(parsed.title) } : {}),
        ...(parsed.summary !== undefined ? { summary: (parsed.summary as string) || null } : {}),
      };
      DETAIL[id] = { ...DETAIL[id], ...COURSES[idx] };
      return ok({ id, versioned: false });
    }
    // THE VERSIONING RULE, modelled rather than faked. A published edit forks a new draft
    // carrying the structure across; the published row goes on saying what it said.
    const forkId = `demo-lms-c${nextId()}`;
    const version = current.version + 1;
    const fork: Course = {
      ...current, id: forkId, version, status: "draft", publishedAt: null,
      ...(parsed.title ? { title: String(parsed.title) } : {}),
    };
    COURSES.push(fork);
    DETAIL[forkId] = {
      ...fork, knowledgeSourceId: null, authoredBy: "demo-hansel",
      modules: (DETAIL[id]?.modules ?? []).map((mod) => ({
        ...mod, id: `${mod.id}-v${version}`,
        activities: mod.activities.map((a) => ({ ...a, id: `${a.id}-v${version}` })),
      })),
    };
    return ok({
      id: forkId, versioned: true, version, status: "draft",
      note: `That course was published, so your edit opened version ${version} as a new DRAFT.`,
    });
  }

  const lifecycle = rest.match(/^courses\/([^/]+)\/(publish|retire)$/);
  if (m === "POST" && lifecycle) {
    const [, id, verb] = lifecycle;
    const idx = COURSES.findIndex((c) => c.id === id);
    if (idx < 0) return { status: 404, json: { error: "course not found" } };
    COURSES[idx] = {
      ...COURSES[idx],
      status: verb === "publish" ? "published" : "retired",
      publishedAt: verb === "publish" ? "2026-08-25" : COURSES[idx].publishedAt,
    };
    DETAIL[id] = { ...DETAIL[id], ...COURSES[idx] };
    const n = (DETAIL[id]?.modules ?? []).flatMap((x) => x.activities).length;
    return ok({ ok: true, activities: n });
  }

  const newModule = rest.match(/^courses\/([^/]+)\/modules$/);
  if (m === "POST" && newModule) {
    const detail = DETAIL[newModule[1]];
    if (!detail) return { status: 404, json: { error: "course not found" } };
    const id = `demo-lms-m${nextId()}`;
    detail.modules.push({
      id, sortOrder: (parsed.sortOrder as number) ?? (detail.modules.length + 1) * 10,
      title: String(parsed.title ?? "Untitled module"),
      summary: (parsed.summary as string) ?? null, activities: [],
    });
    detail.modules.sort((x, y) => x.sortOrder - y.sortOrder);
    return { status: 201, json: { id } };
  }

  const newActivity = rest.match(/^modules\/([^/]+)\/activities$/);
  if (m === "POST" && newActivity) {
    const moduleId = newActivity[1];
    const detail = Object.values(DETAIL).find((d) => d.modules.some((x) => x.id === moduleId));
    const mod = detail?.modules.find((x) => x.id === moduleId);
    if (!mod) return { status: 404, json: { error: "module not found" } };
    const id = `demo-lms-a${nextId()}`;
    mod.activities.push({
      id, moduleId, sortOrder: (parsed.sortOrder as number) ?? (mod.activities.length + 1) * 10,
      kind: (parsed.kind as Activity["kind"]) ?? "read", title: String(parsed.title ?? "Untitled"),
      spec: (parsed.spec as Record<string, unknown>) ?? {},
      isRequired: parsed.isRequired !== false,
      passThreshold: parsed.passThreshold ? String(parsed.passThreshold) : null,
      grading: (parsed.grading as Activity["grading"]) ?? "none",
      maxAttempts: (parsed.maxAttempts as number) ?? null,
      estimatedMinutes: (parsed.estimatedMinutes as number) ?? null,
    });
    mod.activities.sort((x, y) => x.sortOrder - y.sortOrder);
    return { status: 201, json: { id } };
  }

  const dropActivity = rest.match(/^activities\/([^/]+)$/);
  if (m === "DELETE" && dropActivity) {
    for (const detail of Object.values(DETAIL)) {
      for (const mod of detail.modules) {
        const i = mod.activities.findIndex((a) => a.id === dropActivity[1]);
        if (i >= 0) { mod.activities.splice(i, 1); return ok({ ok: true }); }
      }
    }
    return { status: 404, json: { error: "activity not found" } };
  }

  // Anything else is a write this fixture cannot model, or an unbuilt read. 404 rather than a
  // cheerful {ok:true}: a page that "succeeded" against a fixture which stored nothing is the
  // frontend-first drift this repo keeps getting bitten by.
  return { status: 404, json: { error: `no LMS demo fixture for ${m} ${p}` } };
}

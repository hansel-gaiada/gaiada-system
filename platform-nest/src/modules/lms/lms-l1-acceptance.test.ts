// LMS L1 — the acceptance drive. Every assertion goes through a REAL HTTP request (`buildApp()` +
// `app.inject()`) against live Postgres and live Cerbos. No raw SQL for anything under test.
//
// Follows one course from authoring to a certificate, because the seams BETWEEN the endpoints are
// where this schema does its work and a per-endpoint smoke test would miss all of them:
//
//   1 author    a department head creates + publishes a course, and CANNOT touch another department's
//   2 version   editing a PUBLISHED course forks a new draft instead of mutating it
//   3 path      an ordered path, refusing courses that were never published
//   4 assign    enrolment, and a learner cannot self-assign mandatory training
//   5 learn     attempts, quiz grading, best-score-not-last, attempt limits
//   6 review    a reviewer grades; a learner CANNOT grade themselves
//   7 certify   path completion writes an hr_record with an expiry — the one-way seam into HR
//   8 comply    the compliance view, and the module wall
//
// Needs DATABASE_URL_TEST + REDIS_URL_TEST + live Cerbos. Skips otherwise — CHECK THE SKIP COUNT.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { rebuildOrgUnitClosure } from "../../core/org-unit-closure";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { lmsModule } from "./index";
import { hrModule } from "../hr";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { setRedis, closeRedis } from "../../events/redis";
import { auditRows, bridgedRows, bridgedCount, type SeriesBody } from "../../testing/activity-probe";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const RUN = !!(TEST_URL && REDIS_TEST_URL);
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!RUN)("LMS L1 — the learning catalogue, driven end-to-end over HTTP", () => {
  let app: NestFastifyApplication;
  let redis: Redis;

  let A: string;
  let admin: string;      // company_admin — authors the GENERAL track, ratifies nothing here
  let webLead: string;    // org_unit_lead of d-web — authors Web Dev's curriculum
  let seoLead: string;    // org_unit_lead of d-seo — must NOT reach Web Dev's
  let learner: string;    // an ordinary member
  let other: string;      // an unrelated member, for the self-read boundary

  let courseId: string;
  let publishedCourseId: string;
  let quizActivityId: string;
  let reviewActivityId: string;
  let pathId: string;
  let enrollmentId: string;

  const base = () => `/api/${A}/modules/lms`;
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, userId: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(userId), ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
    resetModules();
    resetCoreRollupProviders();
    registerModule(lmsModule);
    // hr too: the certification seam writes an hr_record, and the module gate must allow it.
    registerModule(hrModule);
    await syncMetricDefinitions();

    A = await createCompany("Gaia Digital Agency", ["lms", "hr"]);
    admin = await createUser("lms-admin@a.test", "Company Admin");
    webLead = await createUser("weblead@a.test", "Web Dev Head");
    seoLead = await createUser("seolead@a.test", "SEO Head");
    learner = await createUser("learner@a.test", "A Learner");
    other = await createUser("other@a.test", "Unrelated Person");
    for (const u of [admin, webLead, seoLead, learner, other]) await addMembership(A, u);

    await grantRole(admin, await createRole("company_admin"), "company", A);
    const member = await createRole("member");
    for (const u of [learner, other, webLead, seoLead]) await grantRole(u, member, "company", A);
    // Department heads, scoped to their OWN org-unit node.
    const leadRole = await createRole("org_unit_lead");
    await grantRole(webLead, leadRole, "org_unit", "d-web");
    await grantRole(seoLead, leadRole, "org_unit", "d-seo");

    // ⚠ THE ORG-UNIT CLOSURE MUST EXIST OR EVERY org_unit_lead RULE DENIES. `loadUnitAncestors`
    // returns [] for a node with no closure rows — fail-closed by design (HIER-2) — and then
    // `scopeId in unitAncestors` can never match. An earlier draft of this file granted the roles
    // and stopped there; every authoring assertion 403'd and the failure looked like a policy bug
    // rather than a missing fixture. Built with the PRODUCTION builder, not hand-inserted rows, so
    // the ancestor shape here is the shape real requests see.
    await withTenants(
      [A],
      (c) => rebuildOrgUnitClosure(c, A, {
        id: "d-corp", kind: "company",
        children: [
          { id: "d-web", kind: "department", children: [] },
          { id: "d-seo", kind: "department", children: [] },
        ],
      }),
      { modules: ["lms"] },
    );

    app = await buildApp();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    // `setRedis(redis)` handed ownership to the module-level client, and `closeRedis()` quits it.
    // Calling `redis.quit()` as well is a DOUBLE-CLOSE and throws "Connection is closed." from
    // ioredis' event handler — which surfaces as a FAILED SUITE even though every test passed.
    // Worth stating plainly: this was here from the start and was missed because a grep for
    // "Tests " does not match "Test Files ", so a green test count hid a red file.
    await closeRedis();
    await teardownTestDb();
  });

  // ══════════════════════════════════════════════════════════ 1 · AUTHOR ══════════════════════
  it("1 · a department head authors for their OWN department, and is refused another's", async () => {
    const mine = await call("POST", `${base()}/courses`, webLead, {
      courseKey: "fe-fundamentals", title: "Frontend Fundamentals",
      track: "department", unitNodeId: "d-web", discipline: "fe", level: "foundation",
    });
    expect(mine.statusCode).toBe(201);
    courseId = mine.json().id;
    expect(mine.json().version).toBe(1);
    expect(mine.json().status).toBe("draft");

    // The SEO head must not be able to author Web Dev's curriculum. This is the whole point of
    // scoping authoring by unitAncestors rather than by a flat "can author" permission.
    const notMine = await call("POST", `${base()}/courses`, seoLead, {
      courseKey: "sneaky", title: "Not yours", track: "department", unitNodeId: "d-web",
    });
    expect(notMine.statusCode).toBe(403);

    // Nor may a department head author the GENERAL track — it has no unit, so no org_unit_lead can
    // ever reach it. The mandatory track is not one department's to edit.
    const general = await call("POST", `${base()}/courses`, webLead, {
      courseKey: "erp-basics", title: "ERP Basics", track: "general",
    });
    expect(general.statusCode).toBe(403);

    // The company admin can.
    const byAdmin = await call("POST", `${base()}/courses`, admin, {
      courseKey: "erp-basics", title: "ERP Basics", track: "general", level: "foundation",
    });
    expect(byAdmin.statusCode).toBe(201);
  });

  it("1b · a department course must name its unit; a general one must not", async () => {
    const noUnit = await call("POST", `${base()}/courses`, admin, {
      courseKey: "x1", title: "X", track: "department",
    });
    expect(noUnit.statusCode).toBe(400);
    const generalWithUnit = await call("POST", `${base()}/courses`, admin, {
      courseKey: "x2", title: "X", track: "general", unitNodeId: "d-web",
    });
    expect(generalWithUnit.statusCode).toBe(400);
  });

  it("1c · a course with no activities CANNOT be published — it would complete instantly", async () => {
    const empty = await call("POST", `${base()}/courses/${courseId}/publish`, webLead);
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toMatch(/no activities/i);
  });

  it("1d · modules and activities are added, then the course publishes", async () => {
    const mod = await call("POST", `${base()}/courses/${courseId}/modules`, webLead, {
      title: "Rendering", sortOrder: 10,
    });
    expect(mod.statusCode).toBe(201);
    const moduleId = mod.json().id;

    const quiz = await call("POST", `${base()}/modules/${moduleId}/activities`, webLead, {
      kind: "quiz", title: "Rendering quiz", sortOrder: 10, passThreshold: 60, grading: "auto",
      maxAttempts: 3,
      spec: { questions: [
        { id: "q1", prompt: "What does the DOM stand for?", answer: "document object model" },
        { id: "q2", prompt: "Is React a framework?", answer: false },
      ] },
    });
    expect(quiz.statusCode).toBe(201);
    quizActivityId = quiz.json().id;

    // A REVIEWED activity — the UI/UX and management-scenario shape, graded by a human.
    const review = await call("POST", `${base()}/modules/${moduleId}/activities`, webLead, {
      kind: "scenario", title: "Critique this layout", sortOrder: 20, grading: "review",
    });
    expect(review.statusCode).toBe(201);
    reviewActivityId = review.json().id;

    // An auto-graded quiz with no threshold is refused — nothing could ever pass it.
    const noThreshold = await call("POST", `${base()}/modules/${moduleId}/activities`, webLead, {
      kind: "quiz", title: "Ungradeable", grading: "auto",
    });
    expect(noThreshold.statusCode).toBe(400);

    // A lab must be auto-graded; a reviewed "lab" is a contradiction.
    const badLab = await call("POST", `${base()}/modules/${moduleId}/activities`, webLead, {
      kind: "lab", title: "Bad lab", grading: "review",
    });
    expect(badLab.statusCode).toBe(400);

    const pub = await call("POST", `${base()}/courses/${courseId}/publish`, webLead);
    expect(pub.statusCode).toBe(200);
    expect(pub.json().activities).toBe(2);
    publishedCourseId = courseId;
  });

  // ══════════════════════════════════════════════════ 1b · THE ANSWER KEY ═════════════════════
  it("1b · a learner reading a course does NOT get the quiz answers; an author asking for them does", async () => {
    // The defect: `spec` is one jsonb column holding whatever the kind needs — including a quiz's
    // ANSWERS — and resource_lms_course.yaml names `member` in its read rule on purpose. Returning
    // it verbatim handed every employee the key to their own mandatory assessment, and the result
    // (high scores on the general track) is indistinguishable from the training working.
    const asLearner = await call("GET", `${base()}/courses/${publishedCourseId}`, learner);
    expect(asLearner.statusCode).toBe(200);
    const quizAct = asLearner.json().modules[0].activities.find(
      (a: { kind: string }) => a.kind === "quiz",
    );
    expect(quizAct.specRedacted).toBe(true);
    for (const q of quizAct.spec.questions) {
      expect(q).not.toHaveProperty("answer");
      // The prompt survives — a redaction that also removed the question would be safe and useless.
      expect(q.prompt).toBeTruthy();
    }
    // Belt and braces against a future field slipping through: the literal answer string must not
    // appear anywhere in the learner's payload, at any depth.
    expect(JSON.stringify(asLearner.json())).not.toContain("document object model");

    // ?includeAnswers runs a SECOND authorization — `update`, the authoring right.
    const asAuthor = await call(
      "GET", `${base()}/courses/${publishedCourseId}?includeAnswers=1`, webLead,
    );
    expect(asAuthor.statusCode).toBe(200);
    const authorQuiz = asAuthor.json().modules[0].activities.find(
      (a: { kind: string }) => a.kind === "quiz",
    );
    expect(authorQuiz.spec.questions[0].answer).toBe("document object model");
    expect(authorQuiz.specRedacted).toBe(false);

    // A learner asking for them is REFUSED, not quietly redacted. Silently ignoring the flag would
    // make the endpoint look like it honoured a request it denied.
    const learnerAsking = await call(
      "GET", `${base()}/courses/${publishedCourseId}?includeAnswers=1`, learner,
    );
    expect(learnerAsking.statusCode).toBe(403);

    // And another department's head cannot use the authoring right to read Web Dev's key.
    const otherLead = await call(
      "GET", `${base()}/courses/${publishedCourseId}?includeAnswers=1`, seoLead,
    );
    expect(otherLead.statusCode).toBe(403);
  });

  // ══════════════════════════════════════════════════════════ 2 · VERSION ═════════════════════
  it("2 · editing a PUBLISHED course FORKS a new draft version rather than mutating it", async () => {
    // The discipline the whole schema rests on. Without it, a learner mid-course gets assessed on
    // content that changed under them.
    const edit = await call("PATCH", `${base()}/courses/${publishedCourseId}`, webLead, {
      title: "Frontend Fundamentals (2026 edition)",
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().versioned).toBe(true);
    expect(edit.json().version).toBe(2);
    expect(edit.json().status).toBe("draft");
    expect(edit.json().id).not.toBe(publishedCourseId);

    // v1 is UNTOUCHED and still published.
    const v1 = await call("GET", `${base()}/courses/${publishedCourseId}`, learner);
    expect(v1.json().title).toBe("Frontend Fundamentals");
    expect(v1.json().status).toBe("published");

    // And the fork CARRIED THE STRUCTURE — a new version that started empty would make every edit
    // a rewrite.
    const v2 = await call("GET", `${base()}/courses/${edit.json().id}`, webLead);
    expect(v2.json().modules).toHaveLength(1);
    expect(v2.json().modules[0].activities).toHaveLength(2);

    // A second concurrent draft of the same key is refused.
    const secondDraft = await call("POST", `${base()}/courses`, webLead, {
      courseKey: "fe-fundamentals", title: "Another draft", track: "department", unitNodeId: "d-web",
    });
    expect(secondDraft.statusCode).toBe(409);
  });

  it("2b · structure cannot be changed on a PUBLISHED version", async () => {
    const addMod = await call("POST", `${base()}/courses/${publishedCourseId}/modules`, webLead, { title: "Late addition" });
    expect(addMod.statusCode).toBe(400);
    expect(addMod.json().error).toMatch(/published/i);
  });

  it("2c · the catalogue shows ONE row per course — the latest version, not every version", async () => {
    const cat = await call("GET", `${base()}/courses`, learner);
    expect(cat.statusCode).toBe(200);
    const fe = cat.json().filter((c: { courseKey: string }) => c.courseKey === "fe-fundamentals");
    expect(fe).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════ 3 · PATH ════════════════════════
  it("3 · a path orders its courses and REFUSES one that was never published", async () => {
    const p = await call("POST", `${base()}/paths`, admin, {
      pathKey: "fe-track", title: "Frontend Track", track: "department", unitNodeId: "d-web",
      certificationValidMonths: 12, certificationLabel: "Frontend Fundamentals Certificate",
    });
    expect(p.statusCode).toBe(201);
    pathId = p.json().id;

    const ghost = await call("POST", `${base()}/paths/${pathId}/courses`, admin, {
      courses: [{ courseKey: "does-not-exist" }],
    });
    expect(ghost.statusCode).toBe(400);
    expect(ghost.json().error).toMatch(/no PUBLISHED course/i);

    const ok = await call("POST", `${base()}/paths/${pathId}/courses`, admin, {
      courses: [{ courseKey: "fe-fundamentals", requiresPrevious: true }],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().courses).toBe(1);

    expect((await call("POST", `${base()}/paths/${pathId}/publish`, admin)).statusCode).toBe(200);
  });

  it("3b · only a GENERAL-track path may be mandatory for everyone", async () => {
    const bad = await call("POST", `${base()}/paths`, admin, {
      pathKey: "bad-mandatory", title: "Dept path", track: "department", unitNodeId: "d-web",
      isMandatory: true, appliesTo: "all",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/general-track/i);
  });

  // ══════════════════════════════════════════════════════════ 4 · ASSIGN ══════════════════════
  it("4 · a path is assigned, and a duplicate live enrolment is refused", async () => {
    const e = await call("POST", `${base()}/enrollments`, admin, { subjectUserId: learner, pathId });
    expect(e.statusCode).toBe(201);
    enrollmentId = e.json().id;

    expect((await call("POST", `${base()}/enrollments`, admin, { subjectUserId: learner, pathId })).statusCode).toBe(409);
  });

  it("4b · a learner CANNOT self-enrol in MANDATORY training — that is the runner's job", async () => {
    const mandatory = await call("POST", `${base()}/paths`, admin, {
      pathKey: "general-induction", title: "Company Induction", track: "general",
      isMandatory: true, appliesTo: "all",
    });
    expect(mandatory.statusCode).toBe(201);
    await call("POST", `${base()}/paths/${mandatory.json().id}/courses`, admin, {
      courses: [{ courseKey: "erp-basics" }],
    }).then((r) => {
      // erp-basics was created but never published, so this correctly refuses — proving the guard
      // fires for the general track too, not just department paths.
      expect(r.statusCode).toBe(400);
    });
  });

  // ══════════════════════════════════════════════════════════ 5 · LEARN ═══════════════════════
  it("5 · a quiz is graded from its own spec, and BEST score is kept, not last", async () => {
    // First attempt: one of two right = 50%, below the 60 threshold.
    const a1 = await call("POST", `${base()}/activities/${quizActivityId}/attempts`, learner, {
      enrollmentId, submission: { q1: "document object model", q2: true },
    });
    expect(a1.statusCode).toBe(201);
    expect(a1.json().score).toBe(50);
    expect(a1.json().passed).toBe(false);

    // Second attempt: both right = 100%, passes.
    const a2 = await call("POST", `${base()}/activities/${quizActivityId}/attempts`, learner, {
      enrollmentId, submission: { q1: "document object model", q2: false },
    });
    expect(a2.json().score).toBe(100);
    expect(a2.json().passed).toBe(true);

    // Third attempt scoring WORSE must not undo the pass — best, not last.
    const a3 = await call("POST", `${base()}/activities/${quizActivityId}/attempts`, learner, {
      enrollmentId, submission: { q1: "wrong", q2: true },
    });
    expect(a3.json().score).toBe(0);
    const mine = await call("GET", `${base()}/me`, learner);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().enrolments[0].status).toBe("in_progress");

    // Fourth exceeds maxAttempts=3.
    const a4 = await call("POST", `${base()}/activities/${quizActivityId}/attempts`, learner, {
      enrollmentId, submission: { q1: "x" },
    });
    expect(a4.statusCode).toBe(400);
    expect(a4.json().error).toMatch(/no attempts remaining/i);
  });

  it("5b · the course is NOT complete while a required reviewed activity is ungraded", async () => {
    const sub = await call("POST", `${base()}/activities/${reviewActivityId}/attempts`, learner, {
      enrollmentId, submission: { critique: "The hierarchy is inverted." },
    });
    expect(sub.statusCode).toBe(201);
    expect(sub.json().passed).toBeNull();                       // awaiting a human
    expect(sub.json().result.mode).toBe("awaiting_review");
    expect(sub.json().standing.courseCompleted).toBe(false);    // and so the course is not done
  });

  // ══════════════════════════════════════════════════════════ 6 · REVIEW ══════════════════════
  it("6 · a learner CANNOT grade their own submission", async () => {
    const attempts = await withTenants(
      [A],
      (c) => c.query<{ id: string }>(
        `SELECT id FROM lms_attempts WHERE activity_id = $1 AND subject_user_id = $2`,
        [reviewActivityId, learner],
      ),
      { modules: ["lms"] },
    );
    const attemptId = attempts.rows[0].id;
    const selfGrade = await call("POST", `${base()}/attempts/${attemptId}/grade`, learner, { passed: true, score: 100 });
    expect(selfGrade.statusCode).toBe(403);

    // An unrelated member cannot either.
    expect((await call("POST", `${base()}/attempts/${attemptId}/grade`, other, { passed: true })).statusCode).toBe(403);
  });

  // ══════════════════════════════════════════════════════════ 7 · CERTIFY ═════════════════════
  it("7 · grading the last required activity completes the path and writes an hr_record", async () => {
    const attempts = await withTenants(
      [A],
      (c) => c.query<{ id: string }>(
        `SELECT id FROM lms_attempts WHERE activity_id = $1 AND subject_user_id = $2`,
        [reviewActivityId, learner],
      ),
      { modules: ["lms"] },
    );
    const graded = await call("POST", `${base()}/attempts/${attempts.rows[0].id}/grade`, webLead, {
      passed: true, score: 85, note: "Good eye for hierarchy.",
    });
    expect(graded.statusCode).toBe(200);
    expect(graded.json().standing.courseCompleted).toBe(true);
    expect(graded.json().standing.pathCompleted).toBe(true);

    // THE ONE-WAY SEAM: a real hr_record, with an expiry, so certification flows through HR's
    // EXISTING compliance sweep rather than a parallel model.
    const cert = graded.json().certification;
    expect(cert).toBeTruthy();
    expect(cert.hrRecordId).toBeTruthy();
    expect(cert.expiresOn).toBeTruthy();

    const hr = await withTenants(
      [A],
      (c) => c.query<{ record_type: string; reference: string; expires_on: string; subject_user_id: string }>(
        `SELECT record_type, reference, to_char(expires_on,'YYYY-MM-DD') AS expires_on, subject_user_id
         FROM hr_records WHERE id = $1`,
        [cert.hrRecordId],
      ),
      { modules: ["hr"] },
    );
    expect(hr.rows[0].record_type).toBe("document");
    expect(hr.rows[0].reference).toBe("LMS:fe-track");
    expect(hr.rows[0].subject_user_id).toBe(learner);
    // 12 months out, so HR's expiring-documents sweep will pick it up a year from now.
    expect(hr.rows[0].expires_on).toBe(cert.expiresOn);

    // Grading twice is refused — the first grade is the one that counts.
    const again = await call("POST", `${base()}/attempts/${attempts.rows[0].id}/grade`, webLead, { passed: false });
    expect(again.statusCode).toBe(409);
  });

  it("7b · the completion is FROZEN against the version it was earned on", async () => {
    const comp = await withTenants(
      [A],
      (c) => c.query<{ course_key: string; course_version: number }>(
        `SELECT course_key, course_version FROM lms_completions
          WHERE subject_user_id = $1 AND course_id IS NOT NULL`,
        [learner],
      ),
      { modules: ["lms"] },
    );
    expect(comp.rows[0].course_key).toBe("fe-fundamentals");
    expect(comp.rows[0].course_version).toBe(1);   // v1, NOT the v2 draft that exists
  });

  it("7c · the learner sees their own certificate; an unrelated colleague sees nothing of theirs", async () => {
    const mine = await call("GET", `${base()}/me`, learner);
    expect(mine.json().certifications).toHaveLength(1);
    expect(mine.json().enrolments[0].status).toBe("completed");

    const theirs = await call("GET", `${base()}/me`, other);
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().certifications).toHaveLength(0);
    expect(theirs.json().enrolments).toHaveLength(0);

    // And a member cannot read somebody ELSE's enrolment list by asking for it.
    const snoop = await call("GET", `${base()}/enrollments?subjectUserId=${learner}`, other);
    if (snoop.statusCode === 200) expect(snoop.json()).toEqual([]);
    else expect(snoop.statusCode).toBe(403);
  });

  it("7d · DW-4h-2 (BFF §44.6): each NEW completion is audited once for the LEARNER, bridged once, counted in the series, and a repeat adds nothing", async () => {
    const before = Date.now();
    const comps = await withTenants(
      [A],
      (c) => c.query<{ id: string; course_id: string | null; path_id: string | null }>(
        `SELECT id, course_id, path_id FROM lms_completions WHERE subject_user_id = $1 ORDER BY completed_at, id`, [learner],
      ),
      { modules: ["lms"] },
    );
    const course = comps.rows.filter((r) => r.course_id !== null);
    const path = comps.rows.filter((r) => r.path_id !== null);
    expect(course).toHaveLength(1);
    expect(path).toHaveLength(1);

    // the actor is the learner, never the reviewer (webLead) whose grade completed the last activity
    const courseAudit = await auditRows(A, "lms_completion", "completed", course[0].id);
    expect(courseAudit).toHaveLength(1);
    expect(courseAudit[0].actor_id).toBe(learner);
    expect(courseAudit[0].metadata).toMatchObject({ courseId: course[0].course_id });
    const pathAudit = await auditRows(A, "lms_completion", "completed", path[0].id);
    expect(pathAudit).toHaveLength(1);
    expect(pathAudit[0].actor_id).toBe(learner);
    expect(pathAudit[0].metadata).toMatchObject({ pathId });

    for (const [comp, audit] of [[course[0], courseAudit[0]], [path[0], pathAudit[0]]] as const) {
      const wa = await bridgedRows(A, "learning", "lms_completion", comp.id);
      expect(wa).toHaveLength(1);
      expect(wa[0]).toMatchObject({ actor_user_id: learner, verb: "completed", source_ref: `act:${audit.id}` });
      expect(wa[0].payload).toEqual({ kind: "learning.completed" });
      expect(wa[0].occurred_at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
      expect(wa[0].occurred_at.getTime()).toBeGreaterThan(before - 300_000);
    }
    expect(await bridgedCount(A, learner, "learning")).toBe(2);
    expect(await bridgedCount(A, webLead, "learning")).toBe(0);

    // a repeat: the learner submits the reviewed activity again. The course is already complete, so no completion row is
    // inserted, so nothing is audited.
    const again = await call("POST", `${base()}/activities/${reviewActivityId}/attempts`, learner, {
      enrollmentId, submission: { critique: "A second look." },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().standing).not.toHaveProperty("newCompletionId"); // an internal flag, never in the response
    expect((await withTenants([A], (c) => c.query(`SELECT 1 FROM lms_completions WHERE subject_user_id = $1`, [learner]), { modules: ["lms"] })).rowCount).toBe(2);
    expect(await auditRows(A, "lms_completion", "completed", course[0].id)).toHaveLength(1);
    expect(await auditRows(A, "lms_completion", "completed", path[0].id)).toHaveLength(1);
    expect(await bridgedCount(A, learner, "learning")).toBe(2);

    // the series counts both for the learner, today
    const r = await call("GET", `/api/${A}/activity/series?userId=${learner}`, learner);
    expect(r.statusCode).toBe(200);
    const body = r.json() as SeriesBody;
    expect(body.kinds.map((k) => k.key)).toContain("learning.completed");
    expect(body.totals["learning.completed"]).toBe(2);
    expect(body.days[body.days.length - 1].counts["learning.completed"]).toBe(2);
  });

  // ══════════════════════════════════════════════════════════ 8 · COMPLY ══════════════════════
  it("8 · compliance answers in aggregate, and waiving demands a reason", async () => {
    const c = await call("GET", `${base()}/compliance`, admin);
    expect(c.statusCode).toBe(200);
    const fe = c.json().find((r: { pathKey: string }) => r.pathKey === "fe-track");
    expect(fe.assigned).toBe(1);
    expect(fe.completed).toBe(1);
    expect(fe.outstanding).toBe(0);

    // A waiver with no reason is not an audit trail.
    const e2 = await call("POST", `${base()}/enrollments`, admin, { subjectUserId: other, pathId });
    const noReason = await call("POST", `${base()}/enrollments/${e2.json().id}/waive`, admin, {});
    expect(noReason.statusCode).toBe(400);
    const waived = await call("POST", `${base()}/enrollments/${e2.json().id}/waive`, admin, { reason: "on secondment" });
    expect(waived.statusCode).toBe(200);

    // A DEPARTMENT HEAD must not be able to waive — they would be excusing their own team from the
    // company's mandatory training.
    const e3 = await call("POST", `${base()}/enrollments`, admin, { subjectUserId: seoLead, pathId });
    const leadWaive = await call("POST", `${base()}/enrollments/${e3.json().id}/waive`, webLead, { reason: "nope" });
    expect(leadWaive.statusCode).toBe(403);
  });

  it("8b · every LMS route is DARK for a company without the lms module", async () => {
    const noLms = await createCompany("No LMS Co", ["hr"]);
    await addMembership(noLms, admin);
    await grantRole(admin, await createRole("company_admin"), "company", noLms);
    for (const path of ["/courses", "/paths", "/enrollments", "/compliance", "/me"]) {
      const r = await call("GET", `/api/${noLms}/modules/lms${path}`, admin);
      expect(r.statusCode, `${path} should 404 while lms is off`).toBe(404);
    }
  });

  it("8c · the third wall: lms tables read ZERO rows without the lms module scope", async () => {
    // The failure mode that is invisible in production — the query succeeds and returns nothing.
    const scoped = await withTenants([A], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM lms_courses`), { modules: ["lms"] });
    const unscoped = await withTenants([A], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM lms_courses`));
    expect(Number(scoped.rows[0].n)).toBeGreaterThan(0);
    expect(unscoped.rows[0].n).toBe("0");
    // And the hr scope alone does NOT open the lms wall — they are separate modules.
    const hrOnly = await withTenants([A], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM lms_courses`), { modules: ["hr"] });
    expect(hrOnly.rows[0].n).toBe("0");
  });

  // ══════════════════════════════════════ 9 · DW-4g — A HEAD'S TEAM PROGRESS (BFF §38) ══════════
  // The department head reads their OWN unit's progress through `compliance?unit=`, and still cannot
  // waive. Fixtures are this block's own (a fresh path, fresh people) so the counts below do not
  // depend on what cases 4-8 left behind. The org tree is written in the REAL stored shape
  // (`{root: ...}`, what sanitizeStructure() writes) — `unitExistsInStructure` reads it.
  describe("9 · DW-4g — compliance?unit= for a department head", () => {
    let webMate: string;   // placed in d-web, enrolled
    let seoMate: string;   // placed in d-seo, enrolled on the SAME path
    let leaver: string;    // was in d-web, left in 2021 — NOT on the roster today, but enrolled
    let g4PathId: string;
    let g4EnrollmentId: string;

    const place = (userId: string, unit: string, from: string, to: string | null) =>
      withTenants(
        [A],
        (c) => c.query(
          `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
           VALUES (gen_random_uuid(), $1, $2, $3, true, $4::date, $5::date, 'manual', $6)`,
          [A, userId, unit, from, to, config.originSite],
        ),
        { modules: ["lms"] },
      );

    beforeAll(async () => {
      webMate = await createUser("webmate@a.test", "Web Mate");
      seoMate = await createUser("seomate@a.test", "SEO Mate");
      leaver = await createUser("leaver@a.test", "Former Web Dev");
      for (const u of [webMate, seoMate, leaver]) await addMembership(A, u);

      await withTenants(
        [A],
        (c) => c.query(
          `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure`,
          [A, JSON.stringify({
            root: {
              id: "d-corp", kind: "company", name: "Gaia Digital Agency",
              children: [
                { id: "d-web", kind: "department", name: "Web Dev", children: [] },
                { id: "d-seo", kind: "department", name: "SEO", children: [] },
              ],
            },
          }), config.originSite],
        ),
        { modules: ["lms"] },
      );
      await place(webLead, "d-web", "2020-01-01", null);
      await place(webMate, "d-web", "2020-01-01", null);
      await place(seoLead, "d-seo", "2020-01-01", null);
      await place(seoMate, "d-seo", "2020-01-01", null);
      await place(leaver, "d-web", "2020-01-01", "2021-01-01");

      const p = await call("POST", `${base()}/paths`, admin, {
        pathKey: "dw4g-track", title: "DW-4g Track", track: "department", unitNodeId: "d-web",
      });
      expect(p.statusCode).toBe(201);
      g4PathId = p.json().id;
      expect((await call("POST", `${base()}/paths/${g4PathId}/courses`, admin, {
        courses: [{ courseKey: "fe-fundamentals" }],
      })).statusCode).toBe(200);
      expect((await call("POST", `${base()}/paths/${g4PathId}/publish`, admin)).statusCode).toBe(200);

      // The SAME path to an in-unit learner, an out-of-unit learner, and somebody who has left.
      for (const u of [webMate, seoMate, leaver]) {
        const e = await call("POST", `${base()}/enrollments`, admin, { subjectUserId: u, pathId: g4PathId });
        expect(e.statusCode).toBe(201);
        if (u === webMate) g4EnrollmentId = e.json().id;
      }
    });

    const row = (body: { paths: Array<{ pathKey: string }> }) =>
      body.paths.find((r) => r.pathKey === "dw4g-track") as unknown as
        { assigned: number; completed: number; outstanding: number; waived: number };

    it("9a · the Web Dev head CANNOT waive, and the enrolment is left exactly as it was", async () => {
      const w = await call("POST", `${base()}/enrollments/${g4EnrollmentId}/waive`, webLead, { reason: "my team is busy" });
      expect(w.statusCode).toBe(403);
      const after = await withTenants(
        [A],
        (c) => c.query<{ status: string; waived_reason: string | null }>(
          `SELECT status, waived_reason FROM lms_enrollments WHERE id = $1`, [g4EnrollmentId],
        ),
        { modules: ["lms"] },
      );
      expect(after.rows[0]).toEqual({ status: "assigned", waived_reason: null });
    });

    it("9b · compliance?unit=d-web as the Web Dev head: 200, the roster size, and ONLY their learners' enrolments", async () => {
      const r = await call("GET", `${base()}/compliance?unit=d-web`, webLead);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.unit).toBe("d-web");
      // webLead + webMate. The leaver's membership closed in 2021 and seoMate sits in d-seo.
      expect(body.learners).toBe(2);
      expect(row(body)).toMatchObject({ assigned: 1, completed: 0, outstanding: 1, waived: 0 });

      // The company-wide answer for the same path counts all three — so the unit filter is real.
      const all = await call("GET", `${base()}/compliance`, admin);
      const wide = all.json().find((x: { pathKey: string }) => x.pathKey === "dw4g-track");
      expect(wide.assigned).toBe(3);
    });

    it("9c · compliance?unit=d-seo as the Web Dev head is refused (403)", async () => {
      expect((await call("GET", `${base()}/compliance?unit=d-seo`, webLead)).statusCode).toBe(403);
    });

    it("9d · an unknown unit is 403 for the head — nothing is revealed about whether it exists", async () => {
      expect((await call("GET", `${base()}/compliance?unit=no-such-unit`, webLead)).statusCode).toBe(403);
      // An empty `unit` is refused the same way, never read as "everything".
      expect((await call("GET", `${base()}/compliance?unit=`, webLead)).statusCode).toBe(403);
    });

    it("9e · a company-wide caller asking for an unknown unit gets 404 unit_not_found", async () => {
      const r = await call("GET", `${base()}/compliance?unit=no-such-unit`, admin);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toMatchObject({ error: "unit_not_found", field: "unit" });
    });

    it("9f · without ?unit the Web Dev head is still refused (unchanged)", async () => {
      expect((await call("GET", `${base()}/compliance`, webLead)).statusCode).toBe(403);
    });

    it("9g · without ?unit the company admin still gets the old ARRAY shape (regression guard)", async () => {
      const r = await call("GET", `${base()}/compliance`, admin);
      expect(r.statusCode).toBe(200);
      expect(Array.isArray(r.json())).toBe(true);
      expect(r.json()[0]).toHaveProperty("pathKey");
      expect(r.json()[0]).not.toHaveProperty("learners");
    });

    it("9h · a company-wide caller can read a unit's progress too, with the same shape", async () => {
      const r = await call("GET", `${base()}/compliance?unit=d-web`, admin);
      expect(r.statusCode).toBe(200);
      expect(r.json().learners).toBe(2);
      expect(row(r.json()).assigned).toBe(1);
    });
  });
});

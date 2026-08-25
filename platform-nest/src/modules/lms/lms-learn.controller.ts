// LMS L1 — the LEARNER side: enrolment, progress, attempts, grading, completion, certification.
//
// Authorizes as the `lms_enrollment` Cerbos kind — the OPPOSITE read posture to the catalogue. A
// learner's progress, scores and failed attempts are personal data about a named person, so: the
// learner reads their own, a department head their unit's, HR/admin company-wide for compliance.
//
// ⚠ THE THIRD WALL is `lms` on every query — EXCEPT the one certification write, which touches an
//   `hr_records` row and therefore opens BOTH scopes. That is the single place in this module where
//   two module scopes are declared, and it is called out at the call site so nobody widens the rest
//   by copy-paste.
import {
  BadRequestException, Body, Controller, ConflictException, Get, HttpCode, HttpException,
  NotFoundException, Param, Post, Query, Req, ServiceUnavailableException, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { notifyBestEffort } from "../../core/client-notify";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import {
  buildLabRequest, droppedLearnerFiles, labRunnerConfigured, recentLabRunCount, runLab, clampOutput,
} from "./lab-dispatch";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { loadUnitAncestors } from "../../core/org-unit-closure";
import type { Principal } from "../../rbac/principal";

/**
 * Staff-or-self on the enrolment kind. Mirrors `staffOrSelfRead` in hr.controller.ts: try the staff
 * rule first (it ignores subjectUserId), fall back to the member-self rule, and report which won so
 * the caller narrows its WHERE clause to match. Throws if NEITHER is authorized — never silently
 * returns an empty list to somebody genuinely unauthorized.
 */
async function enrolmentStaffOrSelf(
  principal: Principal, tenantId: string, action = "read",
): Promise<{ selfOnly: boolean }> {
  try {
    await authorize(principal, { kind: "lms_enrollment", tenantId, module: "lms" }, action);
    return { selfOnly: false };
  } catch {
    await authorize(
      principal,
      { kind: "lms_enrollment", tenantId, module: "lms", subjectUserId: principal.userId ?? undefined },
      action,
    );
    return { selfOnly: true };
  }
}

/**
 * Recompute a learner's standing on one course from the ledger, and on their path from its courses.
 *
 * Derived, never incremented — the same discipline the HR accrual runner uses. An incremented
 * counter drifts the first time a write fails after the increment, and for a completion that
 * certifies somebody, drift is not recoverable by inspection.
 *
 * Returns whether the PATH just completed, so the caller can decide about certification.
 */
async function recomputeStanding(
  c: PoolClient, tenantId: string, subjectUserId: string, courseId: string, enrollmentId: string | null,
): Promise<{ courseCompleted: boolean; pathCompleted: boolean; pathId: string | null; finalScore: number | null }> {
  // A course is complete when every REQUIRED activity is passed (or waived).
  const req = await c.query<{ total: string; done: string; avg: string | null }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE p.status IN ('passed','waived'))::text AS done,
            avg(p.best_score) FILTER (WHERE p.best_score IS NOT NULL)::numeric(5,2)::text AS avg
     FROM lms_activities a
     JOIN lms_modules m ON m.id = a.module_id
     LEFT JOIN lms_progress p ON p.activity_id = a.id AND p.subject_user_id = $2
     WHERE m.course_id = $1 AND a.is_required`,
    [courseId, subjectUserId],
  );
  const total = Number(req.rows[0].total);
  const done = Number(req.rows[0].done);
  const avg = req.rows[0].avg === null ? null : Number(req.rows[0].avg);
  // A course with no required activities is NOT complete — it is misconfigured. Treating it as
  // complete would certify somebody for nothing, which is why publish refuses an empty course.
  const courseCompleted = total > 0 && done === total;

  if (!courseCompleted) return { courseCompleted: false, pathCompleted: false, pathId: null, finalScore: avg };

  const already = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM lms_completions WHERE subject_user_id = $1 AND course_id = $2`,
    [subjectUserId, courseId],
  );
  if (Number(already.rows[0].n) === 0) {
    const meta = await c.query<{ course_key: string; version: number }>(
      `SELECT course_key, version FROM lms_courses WHERE id = $1`, [courseId],
    );
    await c.query(
      `INSERT INTO lms_completions (id, tenant_id, subject_user_id, course_id, enrollment_id,
                                    course_key, course_version, final_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId(), tenantId, subjectUserId, courseId, enrollmentId,
       meta.rows[0]?.course_key ?? null, meta.rows[0]?.version ?? null, avg],
    );
  }

  if (!enrollmentId) return { courseCompleted: true, pathCompleted: false, pathId: null, finalScore: avg };

  // Is the whole PATH done? Every non-optional course in it must have a completion for this person.
  const pathRow = await c.query<{ path_id: string }>(
    `SELECT path_id FROM lms_enrollments WHERE id = $1`, [enrollmentId],
  );
  const pathId = pathRow.rows[0]?.path_id ?? null;
  if (!pathId) return { courseCompleted: true, pathCompleted: false, pathId: null, finalScore: avg };

  const pc = await c.query<{ required: string; completed: string; avg: string | null }>(
    `SELECT count(*)::text AS required,
            count(*) FILTER (WHERE done.n > 0)::text AS completed,
            avg(done.score)::numeric(5,2)::text AS avg
     FROM lms_path_courses pc
     LEFT JOIN LATERAL (
       SELECT count(*) AS n, avg(final_score) AS score
       FROM lms_completions comp
       WHERE comp.subject_user_id = $2 AND comp.course_key = pc.course_key
     ) done ON true
     WHERE pc.path_id = $1 AND NOT pc.is_optional`,
    [pathId, subjectUserId],
  );
  const pathCompleted = Number(pc.rows[0].required) > 0 && Number(pc.rows[0].completed) === Number(pc.rows[0].required);
  return {
    courseCompleted: true, pathCompleted, pathId,
    finalScore: pc.rows[0].avg === null ? avg : Number(pc.rows[0].avg),
  };
}

@Controller("api/:tenantId/modules/lms")
@UseGuards(AuthGuard, ModuleEnabledGuard("lms"))
export class LmsLearnController {
  // ══════════════════════════════════════════════════════════ MY LEARNING ═════════════════════
  /** The caller's own assigned learning. Passes NO subject — the backend decides what "mine" means. */
  @Get("me")
  async myLearning(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(
      req.principal,
      { kind: "lms_enrollment", tenantId, module: "lms", subjectUserId: req.principal.userId ?? undefined },
      "read",
    );
    const me = req.principal.userId;
    const out = await withTenants(
      [tenantId],
      async (c) => {
        const enrolments = await c.query(
          `SELECT e.id, e.path_id AS "pathId", p.path_key AS "pathKey", p.title, p.is_mandatory AS "isMandatory",
                  e.status, e.source, e.due_on AS "dueOn", e.started_at AS "startedAt",
                  e.completed_at AS "completedAt",
                  (e.due_on IS NOT NULL AND e.due_on < CURRENT_DATE AND e.status IN ('assigned','in_progress')) AS overdue,
                  (SELECT count(*) FROM lms_path_courses pc WHERE pc.path_id = e.path_id AND NOT pc.is_optional)::int AS "coursesRequired",
                  (SELECT count(*) FROM lms_path_courses pc
                    JOIN lms_completions comp ON comp.course_key = pc.course_key AND comp.subject_user_id = $1
                    WHERE pc.path_id = e.path_id AND NOT pc.is_optional)::int AS "coursesCompleted"
           FROM lms_enrollments e JOIN lms_paths p ON p.id = e.path_id
           WHERE e.subject_user_id = $1 ORDER BY p.is_mandatory DESC, e.due_on NULLS LAST`,
          [me],
        );
        const certs = await c.query(
          `SELECT path_key AS "pathKey", completed_at AS "completedAt",
                  certificate_expires_on AS "expiresOn", final_score AS "finalScore"
           FROM lms_completions WHERE subject_user_id = $1 AND path_id IS NOT NULL
           ORDER BY completed_at DESC`,
          [me],
        );
        return { enrolments: enrolments.rows, certifications: certs.rows };
      },
      { modules: ["lms"] },
    );
    return out;
  }

  @Get("enrollments")
  async listEnrolments(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("subjectUserId") subjectUserIdQ?: string, @Query("status") status?: string,
  ) {
    const { selfOnly } = await enrolmentStaffOrSelf(req.principal, tenantId);
    const params: unknown[] = [];
    const clauses = ["1=1"];
    if (selfOnly) { params.push(req.principal.userId); clauses.push(`e.subject_user_id = $${params.length}`); }
    else if (subjectUserIdQ) { params.push(subjectUserIdQ); clauses.push(`e.subject_user_id = $${params.length}`); }
    if (status) { params.push(status); clauses.push(`e.status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT e.id, e.subject_user_id AS "subjectUserId", u.name AS "subjectName",
                e.path_id AS "pathId", p.path_key AS "pathKey", p.title, p.is_mandatory AS "isMandatory",
                e.status, e.source, e.due_on AS "dueOn", e.completed_at AS "completedAt"
         FROM lms_enrollments e
         JOIN lms_paths p ON p.id = e.path_id
         LEFT JOIN users u ON u.id = e.subject_user_id
         WHERE ${clauses.join(" AND ")} ORDER BY e.created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["lms"] },
    );
    return rows.rows;
  }

  /** Assign a path. A learner may enrol THEMSELVES only in a path the author marked optional. */
  @Post("enrollments")
  @HttpCode(201)
  async enrol(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { subjectUserId?: string; pathId?: string; dueOn?: string; source?: string },
  ) {
    if (!body?.pathId) throw new BadRequestException("pathId required");
    const subjectUserId = body?.subjectUserId ?? req.principal.userId;
    if (!subjectUserId) throw new BadRequestException("subjectUserId required");
    const isSelf = subjectUserId === req.principal.userId;

    await authorize(
      req.principal,
      { kind: "lms_enrollment", tenantId, module: "lms", ...(isSelf ? { subjectUserId } : {}) },
      "create",
    );

    const id = newId();
    const out = await withTenants(
      [tenantId],
      async (c) => {
        const p = await c.query<{ status: string; is_mandatory: boolean; due_days: number | null; title: string }>(
          `SELECT status, is_mandatory, due_days, title FROM lms_paths WHERE id = $1 AND deleted_at IS NULL`,
          [body.pathId],
        );
        const path = p.rows[0];
        if (!path) throw new NotFoundException("path not found");
        if (path.status !== "published") throw new BadRequestException(`path is '${path.status}' — only a published path can be assigned`);
        // SELF-ENROLMENT IS FOR OPTIONAL PATHS ONLY. A member cannot self-enrol in a mandatory
        // path — not because it would be harmful, but because mandatory enrolment is the L2
        // runner's job and a self-enrolment carries source='self'. The compliance report reads
        // that column to answer "who was REQUIRED to do this", and a mixed-provenance mandatory
        // path makes that question unanswerable. Assignment, not browsing (blueprint §3).
        //
        // `isSelf` alone is the test: a staff member assigning it to themselves is still an
        // assignment and passes the staff authorize above, so this only catches the member arm.
        if (isSelf && path.is_mandatory) {
          throw new BadRequestException(
            `'${path.title}' is mandatory training — it is assigned automatically, not self-selected. ` +
            `If it has not appeared on your learning yet, it is because the assignment runner has not run.`,
          );
        }
        await c.query(
          `INSERT INTO lms_enrollments (id, tenant_id, subject_user_id, path_id, source, assigned_by, due_on)
           VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::date, CASE WHEN $8::int IS NOT NULL THEN (CURRENT_DATE + $8::int) ELSE NULL END))`,
          [id, tenantId, subjectUserId, body.pathId,
           body?.source ?? (isSelf ? "self" : "manual"), req.principal.userId, body?.dueOn ?? null, path.due_days],
        );
        await emitEvent(c, tenantId, "lms_enrollment", id, "lms.enrollment.created", {
          subjectUserId, pathId: body.pathId, mandatory: path.is_mandatory,
        });
        return { title: path.title, mandatory: path.is_mandatory };
      },
      { modules: ["lms"] },
    ).catch((e) => {
      if (String((e as { message?: string })?.message ?? "").includes("ux_lms_enrollments_live")) {
        throw new ConflictException("this person already has a live enrolment on that path");
      }
      throw e;
    });

    if (!isSelf) {
      await notifyBestEffort(tenantId, req.principal.userId, [subjectUserId], "lms.assigned", {
        title: `Training assigned: ${out.title}`,
        href: "/me/learning",
        entityType: "lms_enrollment",
        entityId: id,
      });
    }
    await writeActivity(tenantId, req.principal.userId, "created", "lms_enrollment", id, { subjectUserId, pathId: body.pathId });
    return { id, status: "assigned", ...out };
  }

  // ════════════════════════════════════════════════════════════ PROGRESS ══════════════════════
  /**
   * Submit an attempt at an activity, and let it cascade.
   *
   * One endpoint rather than separate "start / submit / complete" calls: the learner's act IS the
   * submission, and splitting it invites a progress row that says in_progress forever because the
   * client never sent the third call.
   */
  /**
   * A lab attempt: dispatch to the runner, wait, record the verdict.
   *
   * ⚠ THE GRADE IS THE RUNNER'S, AND THE SPEC IT GRADES AGAINST IS THE CHALLENGE'S. The learner
   *   supplies files and nothing else. A learner who could supply a `gradingSpec` would pass every
   *   lab; one who could supply an `image` would be naming a container to run on a host that
   *   carries other people's production. Both are assembled server-side in lab-dispatch.ts, and
   *   the runner independently refuses an unknown image key — two locks on the same door.
   */
  private async submitLabAttempt(
    tenantId: string, activityId: string, subjectUserId: string,
    submission: Record<string, unknown> | undefined,
  ) {
    // REFUSE rather than accept-and-await. An attempt left pending against a runner that does not
    // exist is somebody waiting forever on a path they cannot complete, and it presents as our bug
    // only much later.
    if (!labRunnerConfigured()) {
      throw new ServiceUnavailableException(
        "the lab runner is not configured for this deployment, so this exercise cannot be graded " +
        "yet. Your work has NOT been recorded as an attempt — nothing was lost.",
      );
    }

    const files = Array.isArray(submission?.files)
      ? (submission.files as { path: string; content: string }[])
      : [];
    if (!files.length || files.some((f) => typeof f?.path !== "string" || typeof f?.content !== "string")) {
      throw new BadRequestException("submission.files[] is required, as [{ path, content }]");
    }

    // ── Transaction 1: check, then RESERVE. Short. ──
    const prep = await withTenants(
      [tenantId],
      async (c) => {
        const a = await c.query<{
          spec: Record<string, unknown>; max_attempts: number | null; course_id: string;
        }>(
          `SELECT a.spec, a.max_attempts, m.course_id
             FROM lms_activities a JOIN lms_modules m ON m.id = a.module_id WHERE a.id = $1`,
          [activityId],
        );
        const act = a.rows[0];
        if (!act) throw new NotFoundException("activity not found");

        const prev = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM lms_attempts WHERE subject_user_id = $1 AND activity_id = $2`,
          [subjectUserId, activityId],
        );
        const attemptNo = Number(prev.rows[0].n) + 1;
        if (act.max_attempts !== null && attemptNo > act.max_attempts) {
          throw new BadRequestException(`no attempts remaining (limit ${act.max_attempts})`);
        }

        // The rate limit counts ERRORED runs too: a run that failed still consumed compute on a
        // shared host, and a limit that counted only successes is one an attacker drives by failing.
        const recent = await recentLabRunCount(c, subjectUserId, 60);
        if (recent >= config.labRunner.maxRunsPerHour) {
          throw new HttpException(
            `you have run ${recent} labs in the last hour, which is the limit. This exists because ` +
            `every run executes on a shared machine — wait a little and try again.`,
            429,
          );
        }

        const runId = newId();
        await c.query(
          `INSERT INTO lms_lab_runs (id, tenant_id, subject_user_id, activity_id, status)
           VALUES ($1,$2,$3,$4,'queued')`,
          [runId, tenantId, subjectUserId, activityId],
        );
        return { runId, act, attemptNo };
      },
      { modules: ["lms"] },
    );

    // ── The long call, OUTSIDE any transaction. ──
    const dropped = droppedLearnerFiles(prep.act.spec, files);
    const request = buildLabRequest(prep.act.spec, files, activityId);
    const outcome = await runLab(request);

    // ── Transaction 2: record. Short. ──
    return withTenants(
      [tenantId],
      async (c) => {
        // An `error` outcome is OURS, not the learner's: the runner was unreachable, its queue was
        // full, its result expired. NO attempt row is written, so it neither consumes one of a
        // limited number of attempts nor appears as a failure on their record.
        if (outcome.status === "error") {
          await c.query(
            `UPDATE lms_lab_runs SET status='error', error=$2, finished_at=now(),
                                     runner_run_id=$3, duration_ms=$4 WHERE id = $1`,
            [prep.runId, outcome.error ?? "the lab could not be run", outcome.runnerRunId, outcome.durationMs],
          );
          throw new ServiceUnavailableException(
            `${outcome.error ?? "the lab could not be run"}. This is not a mark against your ` +
            `submission — no attempt was recorded.`,
          );
        }

        const passed = outcome.status === "succeeded";
        const attemptId = newId();
        // The submission column records file NAMES, not contents: the contents are a learner's work
        // and can be large, and the platform does not need a second copy of every attempt anybody
        // has ever made.
        await c.query(
          `INSERT INTO lms_attempts (id, tenant_id, subject_user_id, activity_id, attempt_no, score,
                                     passed, submission, result, submitted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
          [attemptId, tenantId, subjectUserId, activityId, prep.attemptNo, outcome.score, passed,
           JSON.stringify({ files: files.map((f) => f.path) }),
           JSON.stringify({
             mode: "lab", exitCode: outcome.exitCode, timedOut: outcome.timedOut,
             checks: outcome.checks, artefacts: outcome.artefacts,
             stdout: clampOutput(outcome.stdout), stderr: clampOutput(outcome.stderr),
           })],
        );

        await c.query(
          `UPDATE lms_lab_runs SET status=$2, score=$3, exit_code=$4, timed_out=$5, stdout=$6,
                                   stderr=$7, checks=$8, artefacts=$9, attempt_id=$10,
                                   runner_run_id=$11, duration_ms=$12, finished_at=now()
            WHERE id = $1`,
          [prep.runId, outcome.status, outcome.score, outcome.exitCode, outcome.timedOut,
           outcome.stdout, outcome.stderr, JSON.stringify(outcome.checks),
           JSON.stringify(outcome.artefacts), attemptId, outcome.runnerRunId, outcome.durationMs],
        );

        const status = passed ? "passed" : "failed";
        await c.query(
          `INSERT INTO lms_progress (id, tenant_id, subject_user_id, course_id, activity_id,
                                     status, best_score, attempt_count, first_started_at, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1,now(), CASE WHEN $6 = 'passed' THEN now() ELSE NULL END)
           ON CONFLICT (tenant_id, subject_user_id, activity_id) DO UPDATE SET
             status = CASE WHEN lms_progress.status = 'passed' THEN 'passed' ELSE EXCLUDED.status END,
             best_score = GREATEST(COALESCE(lms_progress.best_score, 0), COALESCE(EXCLUDED.best_score, 0)),
             attempt_count = lms_progress.attempt_count + 1,
             completed_at = COALESCE(lms_progress.completed_at, EXCLUDED.completed_at),
             updated_at = now()`,
          [newId(), tenantId, subjectUserId, prep.act.course_id, activityId, status, outcome.score],
        );

        return {
          attemptId, attemptNo: prep.attemptNo, passed, score: outcome.score,
          exitCode: outcome.exitCode, timedOut: outcome.timedOut,
          // Per-check verdicts, so a learner is told WHICH assertion failed and what was seen. A
          // grade with no explanation teaches nothing, which defeats the point of a lab.
          checks: outcome.checks, artefacts: outcome.artefacts,
          stdout: outcome.stdout, stderr: outcome.stderr,
          ...(dropped.length
            ? { note: `These files are provided by the exercise and were not replaced: ${dropped.join(", ")}` }
            : {}),
        };
      },
      { modules: ["lms"] },
    );
  }
  @Post("activities/:id/attempts")
  @HttpCode(201)
  async submitAttempt(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") activityId: string,
    @Body() body: { submission?: Record<string, unknown>; enrollmentId?: string; subjectUserId?: string },
  ) {
    const subjectUserId = body?.subjectUserId ?? req.principal.userId;
    if (!subjectUserId) throw new BadRequestException("subjectUserId required");
    const isSelf = subjectUserId === req.principal.userId;
    await authorize(
      req.principal,
      { kind: "lms_enrollment", tenantId, module: "lms", ...(isSelf ? { subjectUserId } : {}) },
      "update",
    );

    // ── THE LAB PATH (L5) ────────────────────────────────────────────────────────────────────
    // Split out BEFORE the transaction below, and that split is the point: dispatching to the
    // runner is a network call that waits on a queue on another host, and holding a database
    // transaction open for its duration would tie up a pooled connection for minutes at a time.
    // Short transactions with the long call BETWEEN them, never one long transaction.
    const kindRow = await withTenants(
      [tenantId],
      (c) => c.query<{ kind: string }>(`SELECT kind FROM lms_activities WHERE id = $1`, [activityId]),
      { modules: ["lms"] },
    );
    if (!kindRow.rows[0]) throw new NotFoundException("activity not found");
    if (kindRow.rows[0].kind === "lab") {
      return this.submitLabAttempt(tenantId, activityId, subjectUserId, body?.submission);
    }

    const out = await withTenants(
      [tenantId],
      async (c) => {
        const a = await c.query<{
          kind: string; grading: string; pass_threshold: string | null; max_attempts: number | null;
          spec: Record<string, unknown>; course_id: string; is_required: boolean;
        }>(
          `SELECT a.kind, a.grading, a.pass_threshold, a.max_attempts, a.spec, a.is_required, m.course_id
           FROM lms_activities a JOIN lms_modules m ON m.id = a.module_id WHERE a.id = $1`,
          [activityId],
        );
        const act = a.rows[0];
        if (!act) throw new NotFoundException("activity not found");

        const prev = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM lms_attempts WHERE subject_user_id = $1 AND activity_id = $2`,
          [subjectUserId, activityId],
        );
        const attemptNo = Number(prev.rows[0].n) + 1;
        if (act.max_attempts !== null && attemptNo > act.max_attempts) {
          throw new BadRequestException(`no attempts remaining (limit ${act.max_attempts})`);
        }

        // GRADE. `read`/`watch` are participation. `quiz` is scored here from its own spec. `lab`
        // is scored by the runner (L5) — until that exists an attempt is recorded UNGRADED and
        // awaits review rather than silently passing, which would let a lab certify somebody with
        // no runner in existence.
        let score: number | null = null;
        let passed: boolean | null = null;
        let result: Record<string, unknown> = {};
        if (act.kind === "read" || act.kind === "watch") {
          passed = true;
          result = { mode: "participation" };
        } else if (act.kind === "quiz" && act.grading === "auto") {
          const questions = Array.isArray((act.spec as { questions?: unknown[] })?.questions)
            ? ((act.spec as { questions: { id?: string; answer?: unknown }[] }).questions)
            : [];
          const answers = (body?.submission ?? {}) as Record<string, unknown>;
          if (!questions.length) throw new BadRequestException("this quiz has no questions in its spec — it cannot be graded");
          let correct = 0;
          const perQuestion: { id: string; correct: boolean }[] = [];
          for (const [i, q] of questions.entries()) {
            const qid = q.id ?? String(i);
            const ok = JSON.stringify(answers[qid]) === JSON.stringify(q.answer);
            if (ok) correct += 1;
            perQuestion.push({ id: String(qid), correct: ok });
          }
          score = Number(((correct / questions.length) * 100).toFixed(2));
          passed = act.pass_threshold === null ? true : score >= Number(act.pass_threshold);
          result = { mode: "quiz", correct, of: questions.length, perQuestion };
        } else {
          // `scenario`, `lab`, or anything grading='review' — submitted, awaiting a human or a runner.
          result = { mode: act.kind === "lab" ? "awaiting_lab_runner" : "awaiting_review" };
        }

        const attemptId = newId();
        await c.query(
          `INSERT INTO lms_attempts (id, tenant_id, subject_user_id, activity_id, attempt_no, score, passed,
                                     submission, result, submitted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
          [attemptId, tenantId, subjectUserId, activityId, attemptNo, score, passed,
           JSON.stringify(body?.submission ?? {}), JSON.stringify(result)],
        );

        // Progress: best score across attempts, never last.
        const status = passed === true ? "passed" : passed === false ? "failed" : "submitted";
        await c.query(
          `INSERT INTO lms_progress (id, tenant_id, subject_user_id, enrollment_id, course_id, activity_id,
                                     status, best_score, attempt_count, first_started_at, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,now(), CASE WHEN $7 = 'passed' THEN now() ELSE NULL END)
           ON CONFLICT (tenant_id, subject_user_id, activity_id) DO UPDATE SET
             status = CASE WHEN lms_progress.status = 'passed' THEN 'passed' ELSE EXCLUDED.status END,
             best_score = GREATEST(COALESCE(lms_progress.best_score, -1), COALESCE(EXCLUDED.best_score, -1)),
             attempt_count = lms_progress.attempt_count + 1,
             completed_at = COALESCE(lms_progress.completed_at, EXCLUDED.completed_at),
             enrollment_id = COALESCE(EXCLUDED.enrollment_id, lms_progress.enrollment_id),
             updated_at = now()`,
          [newId(), tenantId, subjectUserId, body?.enrollmentId ?? null, act.course_id, activityId, status, score],
        );
        // A GREATEST over -1 leaves -1 when both sides are NULL; normalise it back so an ungraded
        // activity reads as "not graded" rather than as a nonsense score.
        await c.query(
          `UPDATE lms_progress SET best_score = NULL
            WHERE subject_user_id = $1 AND activity_id = $2 AND best_score < 0`,
          [subjectUserId, activityId],
        );

        if (body?.enrollmentId) {
          await c.query(
            `UPDATE lms_enrollments SET status = 'in_progress', started_at = COALESCE(started_at, now()), updated_at = now()
              WHERE id = $1 AND status = 'assigned'`,
            [body.enrollmentId],
          );
        }

        const standing = await recomputeStanding(c, tenantId, subjectUserId, act.course_id, body?.enrollmentId ?? null);
        return { attemptId, attemptNo, score, passed, result, standing };
      },
      { modules: ["lms"] },
    );

    // Path completion writes the certification — the ONE cross-module write. Kept OUT of the
    // transaction above deliberately: an hr_records failure must not roll back a legitimately
    // earned completion, and the certificate can be reconciled, whereas lost progress cannot.
    let certification: { hrRecordId: string; expiresOn: string | null } | null = null;
    if (out.standing.pathCompleted && out.standing.pathId) {
      certification = await this.certifyPath(tenantId, subjectUserId, out.standing.pathId, body?.enrollmentId ?? null, out.standing.finalScore, req.principal.userId);
    }
    return { ...out, certification };
  }

  /**
   * Write the path completion and its certification into HR.
   *
   * ⚠ THE ONE PLACE THIS MODULE OPENS TWO MODULE SCOPES. `hr_records` is behind the `hr` wall, so
   *   the transaction declares `{ modules: ["lms", "hr"] }`. Every other query in this module
   *   declares `["lms"]` alone — widening by copy-paste would give LMS handlers general reach into
   *   HR's tables, which is exactly what the third wall exists to prevent.
   *
   * Expiry is written onto the hr_record so certification flows through HR's EXISTING compliance
   * sweep rather than a parallel model that would eventually disagree with it.
   */
  private async certifyPath(
    tenantId: string, subjectUserId: string, pathId: string, enrollmentId: string | null,
    finalScore: number | null, actorUserId: string | null,
  ): Promise<{ hrRecordId: string; expiresOn: string | null } | null> {
    return withTenants(
      [tenantId],
      async (c) => {
        const p = await c.query<{ path_key: string; title: string; months: number | null; label: string | null }>(
          `SELECT path_key, title, certification_valid_months AS months, certification_label AS label
           FROM lms_paths WHERE id = $1`,
          [pathId],
        );
        const path = p.rows[0];
        if (!path) return null;

        const dupe = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM lms_completions
            WHERE subject_user_id = $1 AND path_id = $2 AND completed_at > now() - INTERVAL '1 minute'`,
          [subjectUserId, pathId],
        );
        if (Number(dupe.rows[0].n) > 0) return null;   // a concurrent submit already certified

        const completionId = newId();
        const hrRecordId = newId();
        const expires = path.months
          ? await c.query<{ d: string }>(`SELECT (CURRENT_DATE + ($1 || ' months')::interval)::date::text AS d`, [path.months])
          : null;
        const expiresOn = expires?.rows[0]?.d ?? null;

        // The hr_record — record_type 'document', carrying expires_on so HR's sweep picks it up.
        await c.query(
          `INSERT INTO hr_records (id, tenant_id, subject_user_id, record_type, data, reference,
                                   issued_on, expires_on, created_by, origin_site)
           VALUES ($1,$2,$3,'document',$4,$5,CURRENT_DATE,$6::date,$7,$8)`,
          [hrRecordId, tenantId, subjectUserId,
           JSON.stringify({ source: "lms", pathKey: path.path_key, title: path.label ?? path.title, finalScore }),
           `LMS:${path.path_key}`, expiresOn, actorUserId, config.originSite],
        );
        await c.query(
          `INSERT INTO lms_completions (id, tenant_id, subject_user_id, path_id, enrollment_id, path_key,
                                        final_score, hr_record_id, certificate_expires_on)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date)`,
          [completionId, tenantId, subjectUserId, pathId, enrollmentId, path.path_key, finalScore, hrRecordId, expiresOn],
        );
        if (enrollmentId) {
          await c.query(
            `UPDATE lms_enrollments SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`,
            [enrollmentId],
          );
        }
        await emitEvent(c, tenantId, "lms_completion", completionId, "lms.path.completed", {
          subjectUserId, pathKey: path.path_key, hrRecordId, expiresOn,
        });
        return { hrRecordId, expiresOn };
      },
      // ⚠ BOTH scopes — see the doc comment. This is the only call in the module that does this.
      { modules: ["lms", "hr"] },
    );
  }

  /** Grade a submitted attempt for a REVIEWED activity. Never reachable by the learner. */
  @Post("attempts/:id/grade")
  @HttpCode(200)
  async gradeAttempt(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") attemptId: string,
    @Body() body: { score?: number; passed?: boolean; note?: string },
  ) {
    if (typeof body?.passed !== "boolean") throw new BadRequestException("passed (boolean) required");

    // The unit this attempt's COURSE belongs to — resolved BEFORE authorizing, because
    // `org_unit_lead` matches on `scopeId in unitAncestors` and an authorize() without it can never
    // match that rule. An earlier draft omitted this and every department head got 403 on grading,
    // which is a core requirement ("each HOD runs their department's training") failing silently as
    // a permissions error. Scoped to the COURSE's unit, matching how authoring is scoped.
    const unitAncestors = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ unit_node_id: string | null }>(
          `SELECT co.unit_node_id
           FROM lms_attempts t
           JOIN lms_activities a ON a.id = t.activity_id
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
           WHERE t.id = $1`,
          [attemptId],
        );
        const unit = r.rows[0]?.unit_node_id;
        return unit ? loadUnitAncestors(c, tenantId, unit) : undefined;
      },
      { modules: ["lms"] },
    );

    // `grade` is its own action precisely so the member-self rule cannot reach it — a learner must
    // never be able to grade themselves, and no subjectUserId is passed here at all.
    await authorize(
      req.principal,
      { kind: "lms_enrollment", id: attemptId, tenantId, module: "lms", unitAncestors },
      "grade",
    );

    const out = await withTenants(
      [tenantId],
      async (c) => {
        const a = await c.query<{ subject_user_id: string; activity_id: string; course_id: string; reviewed_at: string | null }>(
          `SELECT t.subject_user_id, t.activity_id, m.course_id, t.reviewed_at
           FROM lms_attempts t JOIN lms_activities act ON act.id = t.activity_id
           JOIN lms_modules m ON m.id = act.module_id WHERE t.id = $1`,
          [attemptId],
        );
        const at = a.rows[0];
        if (!at) throw new NotFoundException("attempt not found");
        if (at.reviewed_at) throw new ConflictException("this attempt has already been graded");

        await c.query(
          `UPDATE lms_attempts SET score = $2, passed = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5
            WHERE id = $1`,
          [attemptId, body?.score ?? null, body.passed, req.principal.userId, body?.note ?? null],
        );
        await c.query(
          `UPDATE lms_progress SET status = $3,
                  best_score = GREATEST(COALESCE(best_score, -1), COALESCE($4::numeric, -1)),
                  completed_at = CASE WHEN $3 = 'passed' THEN COALESCE(completed_at, now()) ELSE completed_at END,
                  updated_at = now()
            WHERE subject_user_id = $1 AND activity_id = $2`,
          [at.subject_user_id, at.activity_id, body.passed ? "passed" : "failed", body?.score ?? null],
        );
        await c.query(
          `UPDATE lms_progress SET best_score = NULL WHERE subject_user_id = $1 AND activity_id = $2 AND best_score < 0`,
          [at.subject_user_id, at.activity_id],
        );
        const prog = await c.query<{ enrollment_id: string | null }>(
          `SELECT enrollment_id FROM lms_progress WHERE subject_user_id = $1 AND activity_id = $2`,
          [at.subject_user_id, at.activity_id],
        );
        const standing = await recomputeStanding(
          c, tenantId, at.subject_user_id, at.course_id, prog.rows[0]?.enrollment_id ?? null,
        );
        return { subjectUserId: at.subject_user_id, standing, enrollmentId: prog.rows[0]?.enrollment_id ?? null };
      },
      { modules: ["lms"] },
    );

    let certification = null;
    if (out.standing.pathCompleted && out.standing.pathId) {
      certification = await this.certifyPath(
        tenantId, out.subjectUserId, out.standing.pathId, out.enrollmentId, out.standing.finalScore, req.principal.userId,
      );
    }
    await writeActivity(tenantId, req.principal.userId, "updated", "lms_attempt", attemptId, { passed: body.passed });
    return { ok: true, passed: body.passed, standing: out.standing, certification };
  }

  /** Excuse somebody from mandatory training. Admin tier only — never a department head. */
  @Post("enrollments/:id/waive")
  @HttpCode(200)
  async waive(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { reason?: string },
  ) {
    if (!body?.reason) throw new BadRequestException("reason required — a waiver with no recorded reason is not an audit trail");
    await authorize(req.principal, { kind: "lms_enrollment", id, tenantId, module: "lms" }, "waive");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(
        `UPDATE lms_enrollments SET status = 'waived', waived_reason = $2, updated_at = now()
          WHERE id = $1 AND status IN ('assigned','in_progress')`,
        [id, body.reason],
      ),
      { modules: ["lms"] },
    );
    if (!res.rowCount) throw new BadRequestException("enrolment not found, or not in an assignable state");
    await writeActivity(tenantId, req.principal.userId, "updated", "lms_enrollment", id, { waived: true, reason: body.reason });
    return { ok: true, status: "waived" };
  }

  // ═══════════════════════════════════════════════════════════ COMPLIANCE ═════════════════════
  /**
   * The compliance answer: who has and has not completed mandatory training.
   *
   * Aggregate by path, not a per-person score dump — that is what the export is for, and it sits at
   * the high-assurance tier. A compliance view should answer "are we covered" without spreading
   * everybody's scores across a dashboard.
   */
  @Get("compliance")
  async compliance(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "lms_enrollment", tenantId, module: "lms" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT p.path_key AS "pathKey", p.title, p.is_mandatory AS "isMandatory",
                count(e.id)::int AS "assigned",
                count(e.id) FILTER (WHERE e.status = 'completed')::int AS "completed",
                count(e.id) FILTER (WHERE e.status IN ('assigned','in_progress'))::int AS "outstanding",
                count(e.id) FILTER (WHERE e.status IN ('assigned','in_progress')
                                      AND e.due_on IS NOT NULL AND e.due_on < CURRENT_DATE)::int AS "overdue",
                count(e.id) FILTER (WHERE e.status = 'waived')::int AS "waived"
         FROM lms_paths p LEFT JOIN lms_enrollments e ON e.path_id = p.id
         WHERE p.deleted_at IS NULL AND p.status = 'published'
         GROUP BY p.id, p.path_key, p.title, p.is_mandatory
         ORDER BY p.is_mandatory DESC, p.title`,
      ),
      { modules: ["lms"] },
    );
    return rows.rows;
  }
}

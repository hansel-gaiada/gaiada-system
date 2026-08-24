// LMS L1 — the CATALOGUE: courses, modules, activities and learning paths.
//
// Authorizes as the `lms_course` Cerbos kind. Read is deliberately wide (every member browses the
// catalogue); authoring is scoped to the DEPARTMENT HEAD via `org_unit_lead`'s existing
// unitAncestors containment, which is why the owner's "each HOD makes more" needed no new role.
//
// ⚠ THE THIRD WALL: every query passes `{ modules: ["lms"] }`. Omit it and it reads/writes ZERO
//   rows with no error. Note the scope is `lms`, NOT `hr` — this is a different module.
//
// ⚠ THE VERSIONING DISCIPLINE IS ENFORCED HERE, and it is the point of the whole schema. Editing a
//   PUBLISHED course does not mutate it; it opens a new draft version. See `updateCourse`.
import {
  BadRequestException, Body, Controller, ConflictException, Delete, Get, HttpCode, NotFoundException,
  Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { loadUnitAncestors } from "../../core/org-unit-closure";
import { redactSpec, kindCanCarryAnswers } from "./spec-redaction";
import type { Principal } from "../../rbac/principal";

const TRACKS = new Set(["general", "department"]);
const LEVELS = new Set(["foundation", "practitioner", "advanced", "lead"]);
const ACTIVITY_KINDS = new Set(["read", "watch", "quiz", "scenario", "lab"]);
const GRADING = new Set(["auto", "review", "none"]);

/**
 * Authorize an action on a course, supplying the org-unit ancestry `org_unit_lead` matches on.
 *
 * The ancestry is resolved SERVER-SIDE from the course's own `unit_node_id`; a client-supplied unit
 * would let anybody claim to lead the department they are editing. A GENERAL-track course has no
 * unit at all, so no `org_unit_lead` can ever reach it — which is deliberate: the mandatory track
 * every employee must pass is not one department's to edit.
 */
async function authorizeCourse(
  principal: Principal, tenantId: string, action: string,
  opts: { id?: string; unitNodeId?: string | null } = {},
): Promise<void> {
  const unitAncestors = opts.unitNodeId
    ? await withTenants([tenantId], (c) => loadUnitAncestors(c, tenantId, opts.unitNodeId!), { modules: ["lms"] })
    : undefined;
  await authorize(
    principal,
    { kind: "lms_course", tenantId, module: "lms", ...(opts.id ? { id: opts.id } : {}), unitAncestors },
    action,
  );
}

/** The course row an authorize() needs before it can decide. */
async function loadCourseScope(
  c: PoolClient, id: string,
): Promise<{ unit_node_id: string | null; status: string; course_key: string; version: number } | undefined> {
  const r = await c.query<{ unit_node_id: string | null; status: string; course_key: string; version: number }>(
    `SELECT unit_node_id, status, course_key, version FROM lms_courses WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return r.rows[0];
}

@Controller("api/:tenantId/modules/lms")
@UseGuards(AuthGuard, ModuleEnabledGuard("lms"))
export class LmsCatalogueController {
  // ═════════════════════════════════════════════════════════════ COURSES ══════════════════════
  @Get("courses")
  async listCourses(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("track") track?: string, @Query("unitNodeId") unitNodeId?: string,
    @Query("discipline") discipline?: string, @Query("level") level?: string,
    @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "lms_course", tenantId, module: "lms" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    // Default to the PUBLISHED catalogue. A learner browsing must not see half-written drafts, and
    // an author asking for drafts is doing so deliberately.
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    else clauses.push("status = 'published'");
    if (track) { params.push(track); clauses.push(`track = $${params.length}`); }
    if (unitNodeId) { params.push(unitNodeId); clauses.push(`unit_node_id = $${params.length}`); }
    if (discipline) { params.push(discipline); clauses.push(`discipline = $${params.length}`); }
    if (level) { params.push(level); clauses.push(`level = $${params.length}`); }

    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        // DISTINCT ON gives the LATEST version per course_key — the catalogue shows one row per
        // course, not one per version, while a learner mid-way through an older version keeps it.
        `SELECT DISTINCT ON (course_key)
                id, course_key AS "courseKey", version, title, summary, track,
                unit_node_id AS "unitNodeId", discipline, level, status,
                estimated_minutes AS "estimatedMinutes", published_at AS "publishedAt", created_at
         FROM lms_courses WHERE ${clauses.join(" AND ")}
         ORDER BY course_key, version DESC LIMIT 500`,
        params,
      ),
      { modules: ["lms"] },
    );
    return rows.rows;
  }

  /**
   * A course with its modules and activities.
   *
   * ⚠ THE GRADING KEY IS REDACTED unless the caller asks for it AND is authorized to author the
   *   course. `spec` is one jsonb column holding whatever the kind needs — including a quiz's
   *   ANSWERS — and resource_lms_course.yaml names `member` in its read rule on purpose. Returning
   *   the column verbatim handed every employee the answer key to their own mandatory assessment,
   *   and nothing about the result would have looked wrong: high scores on a general track is
   *   what success looks like. See spec-redaction.ts.
   *
   *   `?includeAnswers=1` runs a SECOND authorization — `update` on this course, i.e. the
   *   authoring right — because an author editing a quiz must see what it grades against. The
   *   privileged read is explicit and separately audited rather than implied by the read right.
   */
  @Get("courses/:id")
  async getCourse(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Query("includeAnswers") includeAnswers?: string,
  ) {
    await authorize(req.principal, { kind: "lms_course", id, tenantId, module: "lms" }, "read");
    const wantsAnswers = includeAnswers === "1" || includeAnswers === "true";
    if (wantsAnswers) {
      const scope = await withTenants([tenantId], (c) => loadCourseScope(c, id), { modules: ["lms"] });
      if (!scope) throw new NotFoundException("course not found");
      await authorizeCourse(req.principal, tenantId, "update", { id, unitNodeId: scope.unit_node_id });
    }
    const out = await withTenants(
      [tenantId],
      async (c) => {
        const course = await c.query(
          `SELECT id, course_key AS "courseKey", version, title, summary, track,
                  unit_node_id AS "unitNodeId", discipline, level, status,
                  estimated_minutes AS "estimatedMinutes", published_at AS "publishedAt",
                  knowledge_source_id AS "knowledgeSourceId", authored_by AS "authoredBy"
           FROM lms_courses WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        );
        if (!course.rows[0]) throw new NotFoundException("course not found");
        const modules = await c.query(
          `SELECT id, sort_order AS "sortOrder", title, summary
           FROM lms_modules WHERE course_id = $1 ORDER BY sort_order, title`,
          [id],
        );
        const activities = await c.query(
          `SELECT a.id, a.module_id AS "moduleId", a.sort_order AS "sortOrder", a.kind, a.title,
                  a.spec, a.is_required AS "isRequired", a.pass_threshold AS "passThreshold",
                  a.grading, a.max_attempts AS "maxAttempts", a.estimated_minutes AS "estimatedMinutes"
           FROM lms_activities a JOIN lms_modules m ON m.id = a.module_id
           WHERE m.course_id = $1 ORDER BY m.sort_order, a.sort_order`,
          [id],
        );
        // Redact HERE rather than in the SELECT: the answer key has to be strippable at any depth
        // (a quiz nests it inside `questions[]`, a lab will nest it inside test cases), and a
        // shape-aware SQL projection silently passes anything it was not taught about.
        const shaped = activities.rows.map((a: { kind: string; spec: unknown; moduleId: string }) => {
          if (wantsAnswers) return { ...a, specRedacted: false };
          const { spec, redacted } = redactSpec(a.spec);
          return { ...a, spec, specRedacted: redacted || kindCanCarryAnswers(a.kind) };
        });
        return {
          ...course.rows[0],
          modules: modules.rows.map((m: { id: string }) => ({
            ...m,
            activities: shaped.filter((a: { moduleId: string }) => a.moduleId === m.id),
          })),
        };
      },
      { modules: ["lms"] },
    );
    return out;
  }

  @Post("courses")
  @HttpCode(201)
  async createCourse(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const courseKey = typeof body?.courseKey === "string" ? body.courseKey : undefined;
    const title = typeof body?.title === "string" ? body.title : undefined;
    if (!courseKey || !title) throw new BadRequestException("courseKey and title required");
    const track = typeof body?.track === "string" && TRACKS.has(body.track) ? body.track : "department";
    const unitNodeId = typeof body?.unitNodeId === "string" ? body.unitNodeId : null;
    const level = typeof body?.level === "string" && LEVELS.has(body.level) ? body.level : "foundation";
    // The schema's ck_lms_courses_track_unit enforces this too; raising here names the field.
    if (track === "department" && !unitNodeId) throw new BadRequestException("a department-track course needs unitNodeId");
    if (track === "general" && unitNodeId) throw new BadRequestException("a general-track course must not carry unitNodeId");

    await authorizeCourse(req.principal, tenantId, "create", { unitNodeId });

    const id = newId();
    try {
      await withTenants(
        [tenantId],
        async (c) => {
          await c.query(
            `INSERT INTO lms_courses (id, tenant_id, course_key, version, title, summary, track,
                                      unit_node_id, discipline, level, estimated_minutes, authored_by, origin_site)
             VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [id, tenantId, courseKey, title, body?.summary ?? null, track, unitNodeId,
             body?.discipline ?? null, level, body?.estimatedMinutes ?? null, req.principal.userId, config.originSite],
          );
          await emitEvent(c, tenantId, "lms_course", id, "lms.course.created", { courseKey, track, level });
        },
        { modules: ["lms"] },
      );
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? "");
      if (msg.includes("ux_lms_courses_one_draft")) {
        throw new ConflictException(`course '${courseKey}' already has an open draft — edit that instead of starting a second`);
      }
      if (msg.includes("ux_lms_courses_key_version")) throw new ConflictException(`course '${courseKey}' version 1 already exists`);
      throw e;
    }
    await writeActivity(tenantId, req.principal.userId, "created", "lms_course", id, { courseKey, track });
    return { id, courseKey, version: 1, status: "draft" };
  }

  /**
   * Edit a course.
   *
   * ⚠ THE VERSIONING RULE. A DRAFT is edited in place. A PUBLISHED course is NOT — editing one
   *   opens a NEW draft version and returns its id. That is the discipline the whole schema rests
   *   on: without it, somebody completes Module 3, the author edits it, and the completion attests
   *   to something that was never taken.
   *
   * The response always states which happened (`versioned: true|false`) so a caller never has to
   * guess whether the id they hold is still the one they were editing.
   */
  @Patch("courses/:id")
  async updateCourse(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const scope = await withTenants([tenantId], (c) => loadCourseScope(c, id), { modules: ["lms"] });
    if (!scope) throw new NotFoundException("course not found");
    await authorizeCourse(req.principal, tenantId, "update", { id, unitNodeId: scope.unit_node_id });

    const FIELDS: Record<string, string> = {
      title: "title", summary: "summary", discipline: "discipline", level: "level",
      estimatedMinutes: "estimated_minutes",
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(FIELDS)) {
      if (body?.[k] === undefined) continue;
      if (k === "level" && !LEVELS.has(String(body[k]))) throw new BadRequestException("unknown level");
      vals.push(body[k]);
      sets.push(`${col} = $${vals.length + 1}`);   // +1: $1 is the id
    }
    if (!sets.length) throw new BadRequestException("no updatable fields supplied");

    if (scope.status === "draft" || scope.status === "in_review") {
      await withTenants(
        [tenantId],
        (c) => c.query(`UPDATE lms_courses SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, [id, ...vals]),
        { modules: ["lms"] },
      );
      return { id, versioned: false, version: scope.version, status: scope.status };
    }

    if (scope.status === "retired") {
      throw new BadRequestException("this course is retired — publish a new version from a fresh draft instead of editing it");
    }

    // PUBLISHED: fork a new draft version, carrying the structure across so the author edits a copy
    // rather than starting from nothing.
    const newCourseId = newId();
    const nextVersion = await withTenants(
      [tenantId],
      async (c) => {
        const maxV = await c.query<{ v: number }>(
          `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM lms_courses WHERE course_key = $1`, [scope.course_key],
        );
        const v = maxV.rows[0].v;
        await c.query(
          `INSERT INTO lms_courses (id, tenant_id, course_key, version, title, summary, track, unit_node_id,
                                    discipline, level, estimated_minutes, authored_by, origin_site)
           SELECT $1, tenant_id, course_key, $2, title, summary, track, unit_node_id,
                  discipline, level, estimated_minutes, $3, $4
           FROM lms_courses WHERE id = $5`,
          [newCourseId, v, req.principal.userId, config.originSite, id],
        );
        // Copy the structure. A new version that starts empty would make every edit a rewrite.
        const mods = await c.query<{ id: string; sort_order: number; title: string; summary: string | null }>(
          `SELECT id, sort_order, title, summary FROM lms_modules WHERE course_id = $1 ORDER BY sort_order`, [id],
        );
        for (const m of mods.rows) {
          const newModuleId = newId();
          await c.query(
            `INSERT INTO lms_modules (id, tenant_id, course_id, sort_order, title, summary)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [newModuleId, tenantId, newCourseId, m.sort_order, m.title, m.summary],
          );
          await c.query(
            `INSERT INTO lms_activities (id, tenant_id, module_id, sort_order, kind, title, spec,
                                         is_required, pass_threshold, grading, max_attempts, estimated_minutes)
             SELECT gen_random_uuid(), tenant_id, $1, sort_order, kind, title, spec,
                    is_required, pass_threshold, grading, max_attempts, estimated_minutes
             FROM lms_activities WHERE module_id = $2`,
            [newModuleId, m.id],
          );
        }
        // Apply the requested edit to the NEW version.
        await c.query(`UPDATE lms_courses SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, [newCourseId, ...vals]);
        await emitEvent(c, tenantId, "lms_course", newCourseId, "lms.course.versioned", {
          courseKey: scope.course_key, fromVersion: scope.version, toVersion: v,
        });
        return v;
      },
      { modules: ["lms"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "lms_course", newCourseId, {
      courseKey: scope.course_key, versionedFrom: scope.version,
    });
    return {
      id: newCourseId, versioned: true, version: nextVersion, status: "draft",
      note: `'${scope.course_key}' v${scope.version} is published and was not modified; v${nextVersion} is a new draft carrying your edit.`,
    };
  }

  @Post("courses/:id/publish")
  @HttpCode(200)
  async publishCourse(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const scope = await withTenants([tenantId], (c) => loadCourseScope(c, id), { modules: ["lms"] });
    if (!scope) throw new NotFoundException("course not found");
    await authorizeCourse(req.principal, tenantId, "publish", { id, unitNodeId: scope.unit_node_id });
    if (scope.status === "published") throw new ConflictException("course version is already published");
    if (scope.status === "retired") throw new BadRequestException("a retired version cannot be republished");

    const out = await withTenants(
      [tenantId],
      async (c) => {
        // A course with no activities is publishable in principle and useless in practice — and
        // worse, it completes instantly, so a learner "passes" mandatory training by being assigned
        // it. Refuse rather than certify somebody for nothing.
        const n = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM lms_activities a JOIN lms_modules m ON m.id = a.module_id WHERE m.course_id = $1`,
          [id],
        );
        if (Number(n.rows[0].n) === 0) {
          throw new BadRequestException("cannot publish a course with no activities — it would complete instantly on assignment");
        }
        // Retire the previously published version of the same key. Two published versions of one
        // course means the catalogue has two answers to "what is the current course".
        await c.query(
          `UPDATE lms_courses SET status = 'retired', updated_at = now()
            WHERE course_key = $1 AND status = 'published' AND id <> $2 AND deleted_at IS NULL`,
          [scope.course_key, id],
        );
        await c.query(
          `UPDATE lms_courses SET status = 'published', published_at = now(), published_by = $2, updated_at = now()
            WHERE id = $1`,
          [id, req.principal.userId],
        );
        await emitEvent(c, tenantId, "lms_course", id, "lms.course.published", {
          courseKey: scope.course_key, version: scope.version,
        });
        return { courseKey: scope.course_key, version: scope.version, activities: Number(n.rows[0].n) };
      },
      { modules: ["lms"] },
    );
    await writeActivity(tenantId, req.principal.userId, "published", "lms_course", id, out);
    return { ok: true, status: "published", ...out };
  }

  @Post("courses/:id/retire")
  @HttpCode(200)
  async retireCourse(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const scope = await withTenants([tenantId], (c) => loadCourseScope(c, id), { modules: ["lms"] });
    if (!scope) throw new NotFoundException("course not found");
    await authorizeCourse(req.principal, tenantId, "retire", { id, unitNodeId: scope.unit_node_id });
    await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE lms_courses SET status = 'retired', updated_at = now() WHERE id = $1`, [id]),
      { modules: ["lms"] },
    );
    // Retire, never delete: lms_completions freezes course_key/version, and a hard delete would
    // orphan a certificate somebody holds.
    return { ok: true, status: "retired", note: "existing completions and in-flight enrolments are unaffected" };
  }

  // ══════════════════════════════════════════════════ MODULES + ACTIVITIES ════════════════════
  @Post("courses/:id/modules")
  @HttpCode(201)
  async addModule(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") courseId: string,
    @Body() body: { title?: string; summary?: string; sortOrder?: number },
  ) {
    if (!body?.title) throw new BadRequestException("title required");
    const scope = await withTenants([tenantId], (c) => loadCourseScope(c, courseId), { modules: ["lms"] });
    if (!scope) throw new NotFoundException("course not found");
    await authorizeCourse(req.principal, tenantId, "update", { id: courseId, unitNodeId: scope.unit_node_id });
    // Structure changes to a PUBLISHED version are refused outright — the version is what learners
    // are being assessed against, and PATCH's fork-a-new-version path exists for exactly this.
    if (scope.status === "published") {
      throw new BadRequestException("this version is published — PATCH the course to open a new draft version, then add modules there");
    }
    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO lms_modules (id, tenant_id, course_id, sort_order, title, summary) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, tenantId, courseId, body?.sortOrder ?? 0, body.title, body?.summary ?? null],
      ),
      { modules: ["lms"] },
    );
    return { id };
  }

  @Post("modules/:id/activities")
  @HttpCode(201)
  async addActivity(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") moduleId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const kind = typeof body?.kind === "string" && ACTIVITY_KINDS.has(body.kind) ? body.kind : undefined;
    const title = typeof body?.title === "string" ? body.title : undefined;
    if (!kind || !title) throw new BadRequestException(`kind (${[...ACTIVITY_KINDS].join("|")}) and title required`);
    const grading = typeof body?.grading === "string" && GRADING.has(body.grading) ? body.grading : "auto";
    // Mirrors the schema CHECKs, but names the field rather than surfacing a constraint violation.
    if (kind === "lab" && grading !== "auto") throw new BadRequestException("a lab activity must be auto-graded");
    const threshold = typeof body?.passThreshold === "number" ? body.passThreshold : null;
    if (grading === "auto" && !["read", "watch"].includes(kind) && threshold === null) {
      throw new BadRequestException(`an auto-graded ${kind} needs a passThreshold`);
    }

    const scope = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ course_id: string; unit_node_id: string | null; status: string }>(
          `SELECT m.course_id, c.unit_node_id, c.status
           FROM lms_modules m JOIN lms_courses c ON c.id = m.course_id
           WHERE m.id = $1 AND c.deleted_at IS NULL`,
          [moduleId],
        );
        return r.rows[0];
      },
      { modules: ["lms"] },
    );
    if (!scope) throw new NotFoundException("module not found");
    await authorizeCourse(req.principal, tenantId, "update", { id: scope.course_id, unitNodeId: scope.unit_node_id });
    if (scope.status === "published") {
      throw new BadRequestException("this version is published — PATCH the course to open a new draft version first");
    }

    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO lms_activities (id, tenant_id, module_id, sort_order, kind, title, spec,
                                     is_required, pass_threshold, grading, max_attempts, estimated_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, tenantId, moduleId, body?.sortOrder ?? 0, kind, title, JSON.stringify(body?.spec ?? {}),
         body?.isRequired !== false, threshold, grading,
         body?.maxAttempts ?? null, body?.estimatedMinutes ?? null],
      ),
      { modules: ["lms"] },
    );
    return { id, kind, grading };
  }

  @Delete("activities/:id")
  @HttpCode(200)
  async deleteActivity(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const scope = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ course_id: string; unit_node_id: string | null; status: string }>(
          `SELECT m.course_id, c.unit_node_id, c.status
           FROM lms_activities a JOIN lms_modules m ON m.id = a.module_id JOIN lms_courses c ON c.id = m.course_id
           WHERE a.id = $1`,
          [id],
        );
        return r.rows[0];
      },
      { modules: ["lms"] },
    );
    if (!scope) throw new NotFoundException("activity not found");
    await authorizeCourse(req.principal, tenantId, "update", { id: scope.course_id, unitNodeId: scope.unit_node_id });
    if (scope.status === "published") throw new BadRequestException("this version is published — open a new draft version first");
    await withTenants([tenantId], (c) => c.query(`DELETE FROM lms_activities WHERE id = $1`, [id]), { modules: ["lms"] });
    return { ok: true };
  }

  // ═════════════════════════════════════════════════════════════ PATHS ════════════════════════
  @Get("paths")
  async listPaths(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("track") track?: string, @Query("mandatory") mandatory?: string,
  ) {
    await authorize(req.principal, { kind: "lms_course", tenantId, module: "lms" }, "read");
    const params: unknown[] = [];
    const clauses = ["p.deleted_at IS NULL"];
    if (track) { params.push(track); clauses.push(`p.track = $${params.length}`); }
    if (mandatory === "true") clauses.push("p.is_mandatory");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT p.id, p.path_key AS "pathKey", p.title, p.summary, p.track, p.unit_node_id AS "unitNodeId",
                p.discipline, p.level, p.status, p.is_mandatory AS "isMandatory", p.applies_to AS "appliesTo",
                p.due_days AS "dueDays", p.certification_valid_months AS "certificationValidMonths",
                p.certification_label AS "certificationLabel",
                (SELECT count(*) FROM lms_path_courses pc WHERE pc.path_id = p.id)::int AS "courseCount"
         FROM lms_paths p WHERE ${clauses.join(" AND ")} ORDER BY p.is_mandatory DESC, p.title`,
        params,
      ),
      { modules: ["lms"] },
    );
    return rows.rows;
  }

  @Post("paths")
  @HttpCode(201)
  async createPath(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const pathKey = typeof body?.pathKey === "string" ? body.pathKey : undefined;
    const title = typeof body?.title === "string" ? body.title : undefined;
    if (!pathKey || !title) throw new BadRequestException("pathKey and title required");
    const track = typeof body?.track === "string" && TRACKS.has(body.track) ? body.track : "department";
    const unitNodeId = typeof body?.unitNodeId === "string" ? body.unitNodeId : null;
    if (track === "department" && !unitNodeId) throw new BadRequestException("a department-track path needs unitNodeId");
    if (track === "general" && unitNodeId) throw new BadRequestException("a general-track path must not carry unitNodeId");
    const isMandatory = body?.isMandatory === true;
    const appliesTo = typeof body?.appliesTo === "string" ? body.appliesTo : "all";
    // Only the general track may be mandatory for EVERYONE — the schema enforces it, this names it.
    if (isMandatory && appliesTo === "all" && track !== "general") {
      throw new BadRequestException("only a general-track path may be mandatory for everyone; narrow appliesTo, or use track=general");
    }
    await authorizeCourse(req.principal, tenantId, "create", { unitNodeId });

    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO lms_paths (id, tenant_id, path_key, title, summary, track, unit_node_id, discipline,
                                level, is_mandatory, applies_to, due_days, certification_valid_months,
                                certification_label, authored_by, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [id, tenantId, pathKey, title, body?.summary ?? null, track, unitNodeId, body?.discipline ?? null,
         typeof body?.level === "string" && LEVELS.has(body.level) ? body.level : "foundation",
         isMandatory, appliesTo, body?.dueDays ?? null, body?.certificationValidMonths ?? null,
         body?.certificationLabel ?? null, req.principal.userId, config.originSite],
      ),
      { modules: ["lms"] },
    );
    return { id, pathKey, status: "draft" };
  }

  /**
   * Set a path's ordered course list. Replace-in-full rather than append, because "steps in order"
   * is a property of the WHOLE sequence — appending one course at a time makes position conflicts
   * the caller's problem and leaves gaps when one is removed.
   */
  @Post("paths/:id/courses")
  @HttpCode(200)
  async setPathCourses(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") pathId: string,
    @Body() body: { courses?: { courseKey?: string; requiresPrevious?: boolean; isOptional?: boolean }[] },
  ) {
    const input = Array.isArray(body?.courses) ? body.courses : [];
    if (!input.length) throw new BadRequestException("courses[] required");

    const scope = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ unit_node_id: string | null; status: string }>(
          `SELECT unit_node_id, status FROM lms_paths WHERE id = $1 AND deleted_at IS NULL`, [pathId],
        );
        return r.rows[0];
      },
      { modules: ["lms"] },
    );
    if (!scope) throw new NotFoundException("path not found");
    await authorizeCourse(req.principal, tenantId, "update", { id: pathId, unitNodeId: scope.unit_node_id });

    const n = await withTenants(
      [tenantId],
      async (c) => {
        // Every named course must EXIST and be published — a path pointing at a course_key nobody
        // ever wrote is a learner stuck at step 3 forever, and it fails silently at assignment time
        // rather than here where somebody can fix it.
        for (const [i, x] of input.entries()) {
          if (!x.courseKey) throw new BadRequestException(`courses[${i}].courseKey required`);
          const exists = await c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM lms_courses
              WHERE course_key = $1 AND status = 'published' AND deleted_at IS NULL`,
            [x.courseKey],
          );
          if (Number(exists.rows[0].n) === 0) {
            throw new BadRequestException(`no PUBLISHED course with key '${x.courseKey}' — publish it before adding it to a path`);
          }
        }
        await c.query(`DELETE FROM lms_path_courses WHERE path_id = $1`, [pathId]);
        for (const [i, x] of input.entries()) {
          await c.query(
            `INSERT INTO lms_path_courses (id, tenant_id, path_id, course_key, position, requires_previous, is_optional)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [newId(), tenantId, pathId, x.courseKey, i + 1, x.requiresPrevious !== false, x.isOptional === true],
          );
        }
        return input.length;
      },
      { modules: ["lms"] },
    );
    return { pathId, courses: n };
  }

  @Post("paths/:id/publish")
  @HttpCode(200)
  async publishPath(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const scope = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ unit_node_id: string | null; status: string; is_mandatory: boolean }>(
          `SELECT unit_node_id, status, is_mandatory FROM lms_paths WHERE id = $1 AND deleted_at IS NULL`, [id],
        );
        return r.rows[0];
      },
      { modules: ["lms"] },
    );
    if (!scope) throw new NotFoundException("path not found");
    await authorizeCourse(req.principal, tenantId, "publish", { id, unitNodeId: scope.unit_node_id });

    const out = await withTenants(
      [tenantId],
      async (c) => {
        const n = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM lms_path_courses WHERE path_id = $1`, [id],
        );
        if (Number(n.rows[0].n) === 0) throw new BadRequestException("cannot publish a path with no courses");
        await c.query(
          `UPDATE lms_paths SET status = 'published', published_at = now(), updated_at = now() WHERE id = $1`, [id],
        );
        await emitEvent(c, tenantId, "lms_path", id, "lms.path.published", { isMandatory: scope.is_mandatory });
        return { courses: Number(n.rows[0].n) };
      },
      { modules: ["lms"] },
    );
    await writeActivity(tenantId, req.principal.userId, "published", "lms_path", id, out);
    return {
      ok: true, status: "published", ...out,
      // A mandatory path does nothing until the L2 assignment runner picks it up. Saying so here
      // stops somebody publishing it and assuming 23 people were just enrolled.
      note: scope.is_mandatory
        ? "This path is MANDATORY. Nobody is enrolled yet — the auto-assignment runner (L2) is what enrols them."
        : undefined,
    };
  }
}

// HR wave B — RECRUITMENT (ATS): requisitions, candidates, applications, interviews, scorecards,
// offers, and the one conversion that turns an accepted offer into an employee.
//
// Authorizes as the `hr_recruitment` Cerbos kind (resource_hr_recruitment.yaml), which is the only
// HR kind with an attribute-gated arm: an ordinary staff member reaches an application because they
// are its hiring manager, its recruiter, or on its interview panel. Those attributes are resolved
// HERE, from the database, and passed to Cerbos — the policy never sees a client-supplied panel
// list, because the whole point is that the handler is what knows who is on the panel.
//
// THE THIRD WALL: every query passes `{ modules: ["hr"] }`. Omitting it reads and writes ZERO rows
// with no error.
import {
  BadRequestException, Body, Controller, ConflictException, Get, HttpCode, NotFoundException,
  Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { notifyBestEffort } from "../../core/client-notify";
import { resolveAutomationApprovalDeciders } from "../../core/approval-deciders";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import type { Principal } from "../../rbac/principal";

const EMPLOYMENT_TYPES = new Set(["permanent", "contract", "probation", "intern", "part_time", "freelance"]);
const REQ_STATUSES = new Set(["draft", "pending_approval", "open", "on_hold", "filled", "cancelled", "closed"]);
const CANDIDATE_SOURCES = new Set(["direct", "referral", "agency", "job_board", "linkedin", "career_site", "event", "other"]);
const INTERVIEW_KINDS = new Set(["screen", "interview", "technical", "panel", "culture", "final", "other"]);
const RECOMMENDATIONS = new Set(["strong_yes", "yes", "neutral", "no", "strong_no"]);

/** The attribute bundle resource_hr_recruitment.yaml's panel arm evaluates. */
interface RecruitmentScope {
  hiringManagerUserId?: string | null;
  recruiterUserId?: string | null;
  panelistUserIds?: string[];
}

/**
 * Authorize against a recruitment object, having first resolved WHO is attached to it.
 *
 * The two-attempt shape mirrors `staffOrSelfRead` in hr.controller.ts and exists for the same
 * reason: the staff rule ignores the panel attributes entirely, so trying it first keeps an HR
 * manager's decision cheap, and only a non-HR caller pays for the panel resolution. `selfScoped`
 * tells the caller which arm won, so a LIST endpoint can narrow its WHERE clause to "things you are
 * on" rather than returning the tenant's whole pipeline.
 */
async function authorizeRecruitment(
  principal: Principal, tenantId: string, action: string, scope: RecruitmentScope = {}, id?: string,
): Promise<{ selfScoped: boolean }> {
  const base = { kind: "hr_recruitment" as const, tenantId, module: "hr", ...(id ? { id } : {}) };
  try {
    await authorize(principal, base, action);
    return { selfScoped: false };
  } catch {
    await authorize(principal, { ...base, ...scope }, action);
    return { selfScoped: true };
  }
}

/** Resolve the people attached to one application: its requisition's owners plus every panelist. */
async function scopeForApplication(tenantId: string, applicationId: string): Promise<RecruitmentScope> {
  return withTenants(
    [tenantId],
    async (c) => {
      const req = await c.query<{ hiring_manager_user_id: string | null; recruiter_user_id: string | null }>(
        `SELECT r.hiring_manager_user_id, r.recruiter_user_id
         FROM hr_applications a JOIN hr_requisitions r ON r.id = a.requisition_id
         WHERE a.id = $1`,
        [applicationId],
      );
      const panel = await c.query<{ user_id: string }>(
        `SELECT DISTINCT p.user_id
         FROM hr_interview_panelists p JOIN hr_interviews i ON i.id = p.interview_id
         WHERE i.application_id = $1`,
        [applicationId],
      );
      return {
        hiringManagerUserId: req.rows[0]?.hiring_manager_user_id ?? null,
        recruiterUserId: req.rows[0]?.recruiter_user_id ?? null,
        panelistUserIds: panel.rows.map((r) => r.user_id),
      };
    },
    { modules: ["hr"] },
  );
}

@Controller("api/:tenantId/modules/hr")
@UseGuards(AuthGuard, ModuleEnabledGuard("hr"))
export class RecruitmentController {
  // ══════════════════════════════════════════════════════════ REQUISITIONS ════════════════════
  @Get("requisitions")
  async listRequisitions(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("status") status?: string,
  ) {
    const { selfScoped } = await authorizeRecruitment(req.principal, tenantId, "read", {
      // For a LIST there is no single object to resolve, so the fallback attempt is made with the
      // caller as both owners: it succeeds exactly when the policy's own-requisition arm would, and
      // the query is then narrowed to the ones they actually own.
      hiringManagerUserId: req.principal.userId ?? undefined,
      recruiterUserId: req.principal.userId ?? undefined,
    });
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (selfScoped) {
      params.push(req.principal.userId);
      clauses.push(`(hiring_manager_user_id = $${params.length} OR recruiter_user_id = $${params.length})`);
    }
    if (status) {
      if (!REQ_STATUSES.has(status)) throw new BadRequestException("unknown status");
      params.push(status); clauses.push(`status = $${params.length}`);
    }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT r.id, r.reference, r.title, r.position_id AS "positionId", r.unit_node_id AS "unitNodeId",
                r.openings, r.filled, r.employment_type AS "employmentType", r.location, r.work_mode AS "workMode",
                r.salary_min AS "salaryMin", r.salary_max AS "salaryMax", r.currency, r.status,
                r.hiring_manager_user_id AS "hiringManagerUserId", r.recruiter_user_id AS "recruiterUserId",
                r.target_start_on AS "targetStartOn", r.created_at,
                (SELECT count(*) FROM hr_applications a
                  WHERE a.requisition_id = r.id AND a.status = 'active' AND a.deleted_at IS NULL)::int AS "activeApplications"
         FROM hr_requisitions r WHERE ${clauses.join(" AND ")} ORDER BY r.created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("requisitions")
  @HttpCode(201)
  async createRequisition(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const reference = typeof body?.reference === "string" ? body.reference : undefined;
    const title = typeof body?.title === "string" ? body.title : undefined;
    if (!reference || !title) throw new BadRequestException("reference and title required");
    const employmentType = typeof body?.employmentType === "string" && EMPLOYMENT_TYPES.has(body.employmentType)
      ? body.employmentType : "permanent";
    const salaryMin = typeof body?.salaryMin === "number" ? body.salaryMin : null;
    const salaryMax = typeof body?.salaryMax === "number" ? body.salaryMax : null;
    if (salaryMin !== null && salaryMax !== null && salaryMax < salaryMin) {
      throw new BadRequestException("salaryMax must be >= salaryMin");
    }
    await authorize(req.principal, { kind: "hr_recruitment", tenantId, module: "hr" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO hr_requisitions
             (id, tenant_id, reference, title, position_id, unit_node_id, openings, employment_type,
              contract_months, location, work_mode, salary_min, salary_max, currency, description,
              requirements, hiring_manager_user_id, recruiter_user_id, target_start_on, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [
            id, tenantId, reference, title, body?.positionId ?? null, body?.unitNodeId ?? null,
            typeof body?.openings === "number" ? Math.max(1, Math.round(body.openings)) : 1,
            employmentType, body?.contractMonths ?? null, body?.location ?? null, body?.workMode ?? null,
            salaryMin, salaryMax, body?.currency ?? "IDR", body?.description ?? null,
            JSON.stringify(body?.requirements ?? []), body?.hiringManagerUserId ?? null,
            body?.recruiterUserId ?? null, body?.targetStartOn ?? null, req.principal.userId, config.originSite,
          ],
        );
        await emitEvent(c, tenantId, "hr_requisition", id, "hr.requisition.created", { reference, title });
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "hr_requisition", id, { reference, title });
    return { id, status: "draft" };
  }

  /**
   * Submit a requisition for approval: writes the `automation_approvals` row (origin='hr') in the
   * SAME transaction that moves the status, exactly as leave (0028) and loans (0081) do. No fork —
   * deciding rides the existing `/automation-approvals/:id/decide` endpoint.
   */
  @Post("requisitions/:id/submit")
  @HttpCode(200)
  async submitRequisition(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "hr_recruitment", id, tenantId, module: "hr" }, "update");
    const { approvalId, title, reference } = await withTenants(
      [tenantId],
      async (c) => {
        const row = await c.query<{ status: string; title: string; reference: string; openings: number }>(
          `SELECT status, title, reference, openings FROM hr_requisitions WHERE id = $1 AND deleted_at IS NULL`, [id],
        );
        const found = row.rows[0];
        if (!found) throw new NotFoundException("requisition not found");
        if (found.status !== "draft") throw new BadRequestException(`requisition is '${found.status}', not draft`);
        const approval = newId();
        await c.query(
          `INSERT INTO automation_approvals
             (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, requested_by, origin, origin_site)
           VALUES ($1,$2,'hr:requisition','hr.submitRequisition',$3,'high',$4,$5,'hr',$6)`,
          [
            approval, tenantId,
            JSON.stringify({ requisitionId: id, reference: found.reference, title: found.title, openings: found.openings, href: `/hr/recruitment/${id}` }),
            `Requisition ${found.reference}: ${found.title} (${found.openings} opening(s))`,
            req.principal.userId, config.originSite,
          ],
        );
        await c.query(`UPDATE hr_requisitions SET status = 'pending_approval', approval_id = $2, updated_at = now() WHERE id = $1`, [id, approval]);
        await emitEvent(c, tenantId, "hr_requisition", id, "hr.requisition.submitted", { approvalId: approval });
        return { approvalId: approval, title: found.title, reference: found.reference };
      },
      { modules: ["hr"] },
    );
    const deciders = await resolveAutomationApprovalDeciders(tenantId, "hr");
    await notifyBestEffort(tenantId, req.principal.userId, deciders, "approval.requested", {
      title: `Requisition ${reference}: ${title}`,
      href: `/approvals/${approvalId}`,
      entityType: "automation_approval",
      entityId: approvalId,
      origin: "hr",
      impact: "high",
    });
    return { id, approvalId, status: "pending_approval" };
  }

  @Patch("requisitions/:id")
  async updateRequisition(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const scope = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ hiring_manager_user_id: string | null; recruiter_user_id: string | null }>(
          `SELECT hiring_manager_user_id, recruiter_user_id FROM hr_requisitions WHERE id = $1 AND deleted_at IS NULL`, [id],
        );
        if (!r.rows[0]) throw new NotFoundException("requisition not found");
        return { hiringManagerUserId: r.rows[0].hiring_manager_user_id, recruiterUserId: r.rows[0].recruiter_user_id };
      },
      { modules: ["hr"] },
    );
    await authorizeRecruitment(req.principal, tenantId, "update", scope, id);

    const FIELDS: Record<string, string> = {
      title: "title", positionId: "position_id", unitNodeId: "unit_node_id", openings: "openings",
      employmentType: "employment_type", contractMonths: "contract_months", location: "location",
      workMode: "work_mode", salaryMin: "salary_min", salaryMax: "salary_max", description: "description",
      hiringManagerUserId: "hiring_manager_user_id", recruiterUserId: "recruiter_user_id",
      targetStartOn: "target_start_on", status: "status",
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(FIELDS)) {
      if (body?.[key] === undefined) continue;
      if (key === "status") {
        const next = String(body[key]);
        if (!REQ_STATUSES.has(next)) throw new BadRequestException("unknown status");
        // The approval path owns these two transitions. Letting a PATCH set them would route around
        // the approvals surface entirely, which is the whole reason submit/decide exist.
        if (next === "pending_approval" || next === "open") {
          throw new BadRequestException(`status '${next}' is set by the approval flow, not by PATCH — use POST /requisitions/:id/submit`);
        }
      }
      if (key === "requirements") continue;
      params.push(body[key]);
      sets.push(`${column} = $${params.length}`);
    }
    if (body?.requirements !== undefined) {
      params.push(JSON.stringify(body.requirements));
      sets.push(`requirements = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException("no updatable fields supplied");
    await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE hr_requisitions SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, params),
      { modules: ["hr"] },
    );
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════ CANDIDATES ═════════════════════
  @Get("candidates")
  async listCandidates(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("q") q?: string,
  ) {
    await authorize(req.principal, { kind: "hr_recruitment", tenantId, module: "hr" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (q) { params.push(`%${q}%`); clauses.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length} OR headline ILIKE $${params.length})`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, full_name AS "fullName", email, phone, headline, location, source,
                source_detail AS "sourceDetail", tags, resume_file_id AS "resumeFileId", links,
                consent_given_at AS "consentGivenAt", retention_until AS "retentionUntil",
                erasure_requested_at AS "erasureRequestedAt", created_at,
                (SELECT count(*) FROM hr_applications a WHERE a.candidate_id = hr_candidates.id AND a.deleted_at IS NULL)::int AS "applicationCount"
         FROM hr_candidates WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("candidates")
  @HttpCode(201)
  async createCandidate(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const fullName = typeof body?.fullName === "string" ? body.fullName : undefined;
    if (!fullName) throw new BadRequestException("fullName required");
    const source = typeof body?.source === "string" && CANDIDATE_SOURCES.has(body.source) ? body.source : "direct";
    await authorize(req.principal, { kind: "hr_recruitment", tenantId, module: "hr" }, "create");
    const id = newId();
    try {
      await withTenants(
        [tenantId],
        (c) => c.query(
          `INSERT INTO hr_candidates
             (id, tenant_id, full_name, email, phone, headline, location, source, source_detail,
              referred_by_user_id, resume_file_id, links, tags, notes, consent_given_at, retention_until, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            id, tenantId, fullName, body?.email ?? null, body?.phone ?? null, body?.headline ?? null,
            body?.location ?? null, source, body?.sourceDetail ?? null, body?.referredByUserId ?? null,
            body?.resumeFileId ?? null, JSON.stringify(body?.links ?? {}),
            Array.isArray(body?.tags) ? body.tags : [], body?.notes ?? null,
            body?.consentGivenAt ?? null, body?.retentionUntil ?? null, req.principal.userId, config.originSite,
          ],
        ),
        { modules: ["hr"] },
      );
    } catch (err) {
      // ux_hr_candidates_email is the dedupe guard. Surfacing it as a 409 rather than a 500 is what
      // lets the console say "this person is already in the pool" instead of "something failed".
      if (String((err as { message?: string })?.message ?? "").includes("ux_hr_candidates_email")) {
        throw new ConflictException("a candidate with this email already exists in the pool");
      }
      throw err;
    }
    await writeActivity(tenantId, req.principal.userId, "created", "hr_candidate", id, { source });
    return { id };
  }

  /**
   * Record an erasure request. Deliberately NOT an immediate delete: an application in flight has a
   * hiring manager mid-decision, and there are retention obligations that outlive the request. This
   * stamps the row and lets the purge sweep act on it — the same "mark, then a job acts" shape the
   * document-expiry reminders use.
   */
  @Post("candidates/:id/erasure-request")
  @HttpCode(200)
  async requestErasure(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "hr_recruitment", id, tenantId, module: "hr" }, "update");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(
        `UPDATE hr_candidates SET erasure_requested_at = COALESCE(erasure_requested_at, now()), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["hr"] },
    );
    if (!res.rowCount) throw new NotFoundException("candidate not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "hr_candidate", id, { erasureRequested: true });
    return { ok: true };
  }

  // ═════════════════════════════════════════════════════════ APPLICATIONS ═════════════════════
  @Get("applications")
  async listApplications(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("requisitionId") requisitionId?: string, @Query("stageKey") stageKey?: string, @Query("status") status?: string,
  ) {
    const { selfScoped } = await authorizeRecruitment(req.principal, tenantId, "read", {
      hiringManagerUserId: req.principal.userId ?? undefined,
      recruiterUserId: req.principal.userId ?? undefined,
      panelistUserIds: req.principal.userId ? [req.principal.userId] : [],
    });
    const params: unknown[] = [];
    const clauses = ["a.deleted_at IS NULL"];
    if (selfScoped) {
      params.push(req.principal.userId);
      // Narrowed to the things this caller is actually attached to. Without this a panelist who
      // passed the fallback authorize would see the whole tenant's pipeline — the exact
      // over-reach the attribute gate exists to prevent.
      clauses.push(
        `(r.hiring_manager_user_id = $${params.length} OR r.recruiter_user_id = $${params.length}
          OR EXISTS (SELECT 1 FROM hr_interviews i JOIN hr_interview_panelists pl ON pl.interview_id = i.id
                      WHERE i.application_id = a.id AND pl.user_id = $${params.length}))`,
      );
    }
    if (requisitionId) { params.push(requisitionId); clauses.push(`a.requisition_id = $${params.length}`); }
    if (stageKey) { params.push(stageKey); clauses.push(`a.stage_key = $${params.length}`); }
    if (status) { params.push(status); clauses.push(`a.status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT a.id, a.requisition_id AS "requisitionId", r.reference AS "requisitionReference", r.title AS "requisitionTitle",
                a.candidate_id AS "candidateId", cd.full_name AS "candidateName", cd.headline AS "candidateHeadline",
                a.stage_key AS "stageKey", a.status, a.rating, a.applied_on AS "appliedOn",
                a.stage_entered_at AS "stageEnteredAt",
                EXTRACT(DAY FROM now() - a.stage_entered_at)::int AS "daysInStage"
         FROM hr_applications a
         JOIN hr_requisitions r ON r.id = a.requisition_id
         JOIN hr_candidates cd ON cd.id = a.candidate_id
         WHERE ${clauses.join(" AND ")} ORDER BY a.stage_entered_at LIMIT 500`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("applications")
  @HttpCode(201)
  async createApplication(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { requisitionId?: string; candidateId?: string; stageKey?: string; appliedOn?: string },
  ) {
    if (!body?.requisitionId || !body?.candidateId) throw new BadRequestException("requisitionId and candidateId required");
    await authorize(req.principal, { kind: "hr_recruitment", tenantId, module: "hr" }, "create");
    const id = newId();
    const stageKey = body?.stageKey ?? "applied";
    try {
      await withTenants(
        [tenantId],
        async (c) => {
          await c.query(
            `INSERT INTO hr_applications (id, tenant_id, requisition_id, candidate_id, stage_key, applied_on, created_by, origin_site)
             VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),$7,$8)`,
            [id, tenantId, body.requisitionId, body.candidateId, stageKey, body?.appliedOn ?? null, req.principal.userId, config.originSite],
          );
          await c.query(
            `INSERT INTO hr_application_events (id, tenant_id, application_id, event_type, to_stage_key, created_by)
             VALUES ($1,$2,$3,'applied',$4,$5)`,
            [newId(), tenantId, id, stageKey, req.principal.userId],
          );
          await emitEvent(c, tenantId, "hr_application", id, "hr.application.created", { requisitionId: body.requisitionId, stageKey });
        },
        { modules: ["hr"] },
      );
    } catch (err) {
      if (String((err as { message?: string })?.message ?? "").includes("ux_hr_applications_live")) {
        throw new ConflictException("this candidate already has a live application for that requisition");
      }
      throw err;
    }
    return { id, stageKey, status: "active" };
  }

  /**
   * Move an application to a stage. One endpoint for the whole funnel, because "advance", "reject"
   * and "withdraw" are the same operation with a different destination — and modelling them as
   * three endpoints is how a rejection ends up not writing a timeline event.
   *
   * `stage_entered_at` is reset here and nowhere else: it is what "days in stage" is measured from,
   * and it is the metric the whole pipeline view is built on.
   */
  @Post("applications/:id/stage")
  @HttpCode(200)
  async moveStage(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { stageKey?: string; note?: string; rejectionReason?: string },
  ) {
    if (!body?.stageKey) throw new BadRequestException("stageKey required");
    const scope = await scopeForApplication(tenantId, id);
    await authorizeRecruitment(req.principal, tenantId, "update", scope, id);

    const result = await withTenants(
      [tenantId],
      async (c) => {
        const app = await c.query<{ stage_key: string; status: string }>(
          `SELECT stage_key, status FROM hr_applications WHERE id = $1 AND deleted_at IS NULL`, [id],
        );
        const found = app.rows[0];
        if (!found) throw new NotFoundException("application not found");
        if (found.status !== "active" && found.status !== "on_hold") {
          throw new BadRequestException(`application is '${found.status}' and cannot be moved`);
        }
        const stage = await c.query<{ is_terminal: boolean; terminal_kind: string | null }>(
          `SELECT is_terminal, terminal_kind FROM hr_pipeline_stages WHERE key = $1 AND is_active`, [body.stageKey],
        );
        // An unknown stage key is refused rather than accepted: a typo would otherwise strand the
        // application in a stage that renders nowhere and matches no filter.
        if (!stage.rows[0]) throw new BadRequestException(`unknown pipeline stage '${body.stageKey}'`);
        const terminal = stage.rows[0];
        // The stage set is what decides whether this move ENDS the application. Deriving the status
        // from the stage's own `terminal_kind` keeps the two from disagreeing, which is what a
        // separate status parameter would allow.
        const nextStatus = terminal.is_terminal
          ? (terminal.terminal_kind === "hired" ? "hired" : terminal.terminal_kind === "rejected" ? "rejected" : "withdrawn")
          : "active";

        await c.query(
          `UPDATE hr_applications
              SET stage_key = $2, status = $3, stage_entered_at = now(),
                  rejection_reason = COALESCE($4, rejection_reason),
                  closed_at = CASE WHEN $3 <> 'active' THEN now() ELSE closed_at END,
                  updated_at = now()
            WHERE id = $1`,
          [id, body.stageKey, nextStatus, body?.rejectionReason ?? null],
        );
        await c.query(
          `INSERT INTO hr_application_events (id, tenant_id, application_id, event_type, from_stage_key, to_stage_key, body, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            newId(), tenantId, id,
            nextStatus === "rejected" ? "rejected" : nextStatus === "withdrawn" ? "withdrawn" : "stage_change",
            found.stage_key, body.stageKey, body?.note ?? body?.rejectionReason ?? null, req.principal.userId,
          ],
        );
        await emitEvent(c, tenantId, "hr_application", id, "hr.application.stage_changed", {
          from: found.stage_key, to: body.stageKey, status: nextStatus,
        });
        return { from: found.stage_key, to: body.stageKey, status: nextStatus };
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "hr_application", id, result);
    return result;
  }

  @Get("applications/:id")
  async getApplication(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const scope = await scopeForApplication(tenantId, id);
    await authorizeRecruitment(req.principal, tenantId, "read", scope, id);
    const payload = await withTenants(
      [tenantId],
      async (c) => {
        const app = await c.query(
          `SELECT a.id, a.requisition_id AS "requisitionId", r.reference AS "requisitionReference", r.title AS "requisitionTitle",
                  a.candidate_id AS "candidateId", cd.full_name AS "candidateName", cd.email AS "candidateEmail",
                  cd.phone AS "candidatePhone", cd.headline, cd.links, cd.resume_file_id AS "resumeFileId",
                  a.stage_key AS "stageKey", a.status, a.rating, a.applied_on AS "appliedOn", a.stage_entered_at AS "stageEnteredAt"
           FROM hr_applications a
           JOIN hr_requisitions r ON r.id = a.requisition_id
           JOIN hr_candidates cd ON cd.id = a.candidate_id
           WHERE a.id = $1 AND a.deleted_at IS NULL`,
          [id],
        );
        if (!app.rows[0]) throw new NotFoundException("application not found");
        const events = await c.query(
          `SELECT event_type AS "eventType", from_stage_key AS "fromStageKey", to_stage_key AS "toStageKey",
                  body, occurred_at AS "occurredAt", created_by AS "createdBy"
           FROM hr_application_events WHERE application_id = $1 ORDER BY occurred_at`,
          [id],
        );
        const interviews = await c.query(
          `SELECT i.id, i.kind, i.scheduled_start AS "scheduledStart", i.scheduled_end AS "scheduledEnd",
                  i.timezone, i.location, i.meeting_url AS "meetingUrl", i.status, i.outcome,
                  COALESCE(json_agg(json_build_object('userId', p.user_id, 'role', p.role, 'response', p.response))
                           FILTER (WHERE p.id IS NOT NULL), '[]') AS panelists
           FROM hr_interviews i LEFT JOIN hr_interview_panelists p ON p.interview_id = i.id
           WHERE i.application_id = $1 GROUP BY i.id ORDER BY i.scheduled_start`,
          [id],
        );
        const scorecards = await c.query(
          `SELECT id, interview_id AS "interviewId", reviewer_user_id AS "reviewerUserId", scores, overall,
                  recommendation, notes, submitted_at AS "submittedAt"
           FROM hr_scorecards WHERE application_id = $1 ORDER BY created_at`,
          [id],
        );
        const offer = await c.query(
          `SELECT id, base_amount AS "baseAmount", currency, rate_basis AS "rateBasis", employment_type AS "employmentType",
                  start_on AS "startOn", expires_on AS "expiresOn", status, employee_id AS "employeeId"
           FROM hr_offers WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [id],
        );
        return { ...app.rows[0], events: events.rows, interviews: interviews.rows, scorecards: scorecards.rows, offer: offer.rows[0] ?? null };
      },
      { modules: ["hr"] },
    );
    return payload;
  }

  // ═══════════════════════════════════════════════════════════ INTERVIEWS ═════════════════════
  @Post("applications/:id/interviews")
  @HttpCode(201)
  async scheduleInterview(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") applicationId: string,
    @Body() body: { kind?: string; scheduledStart?: string; scheduledEnd?: string; timezone?: string; location?: string; meetingUrl?: string; panelists?: { userId?: string; role?: string }[] },
  ) {
    if (!body?.scheduledStart || !body?.scheduledEnd) throw new BadRequestException("scheduledStart and scheduledEnd required");
    if (new Date(body.scheduledEnd) <= new Date(body.scheduledStart)) {
      throw new BadRequestException("scheduledEnd must be after scheduledStart");
    }
    const scope = await scopeForApplication(tenantId, applicationId);
    await authorizeRecruitment(req.principal, tenantId, "update", scope, applicationId);
    const kind = body?.kind && INTERVIEW_KINDS.has(body.kind) ? body.kind : "interview";
    const id = newId();
    const panelistIds = (body?.panelists ?? []).map((p) => p.userId).filter((u): u is string => !!u);
    await withTenants(
      [tenantId],
      async (c) => {
        const app = await c.query(`SELECT 1 FROM hr_applications WHERE id = $1 AND deleted_at IS NULL`, [applicationId]);
        if (!app.rows[0]) throw new NotFoundException("application not found");
        await c.query(
          `INSERT INTO hr_interviews (id, tenant_id, application_id, kind, scheduled_start, scheduled_end, timezone, location, meeting_url, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, tenantId, applicationId, kind, body.scheduledStart, body.scheduledEnd,
           body?.timezone ?? "Asia/Makassar", body?.location ?? null, body?.meetingUrl ?? null, req.principal.userId, config.originSite],
        );
        for (const p of body?.panelists ?? []) {
          if (!p.userId) continue;
          await c.query(
            `INSERT INTO hr_interview_panelists (id, tenant_id, interview_id, user_id, role)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, interview_id, user_id) DO NOTHING`,
            [newId(), tenantId, id, p.userId, p.role ?? "interviewer"],
          );
        }
        await c.query(
          `INSERT INTO hr_application_events (id, tenant_id, application_id, event_type, data, created_by)
           VALUES ($1,$2,$3,'interview_scheduled',$4,$5)`,
          [newId(), tenantId, applicationId, JSON.stringify({ interviewId: id, kind, scheduledStart: body.scheduledStart }), req.principal.userId],
        );
        await emitEvent(c, tenantId, "hr_interview", id, "hr.interview.scheduled", { applicationId, kind, panelists: panelistIds });
      },
      { modules: ["hr"] },
    );
    // Panelists are told, because an interview nobody was told about is the single most common way a
    // pipeline stalls. Best-effort: a notification failure must not roll back a scheduled interview.
    if (panelistIds.length) {
      await notifyBestEffort(tenantId, req.principal.userId, panelistIds, "hr.interview.scheduled", {
        title: `You are on an interview panel (${kind})`,
        href: `/hr/recruitment/applications/${applicationId}`,
        entityType: "hr_interview",
        entityId: id,
      });
    }
    return { id };
  }

  @Patch("interviews/:id")
  async updateInterview(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { status?: string; outcome?: string; scheduledStart?: string; scheduledEnd?: string },
  ) {
    const applicationId = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ application_id: string }>(`SELECT application_id FROM hr_interviews WHERE id = $1`, [id]);
        if (!r.rows[0]) throw new NotFoundException("interview not found");
        return r.rows[0].application_id;
      },
      { modules: ["hr"] },
    );
    const scope = await scopeForApplication(tenantId, applicationId);
    await authorizeRecruitment(req.principal, tenantId, "update", scope, id);
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries({ status: "status", outcome: "outcome", scheduledStart: "scheduled_start", scheduledEnd: "scheduled_end" })) {
      if (body?.[key as keyof typeof body] === undefined) continue;
      params.push(body[key as keyof typeof body]);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException("no updatable fields supplied");
    await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE hr_interviews SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params),
      { modules: ["hr"] },
    );
    return { ok: true };
  }

  /**
   * File a scorecard. `reviewer_user_id` is pinned to the PRINCIPAL and never read from the body —
   * a panelist has `create` on this kind, and without the pin "create a scorecard" would silently
   * become "create one in somebody else's name".
   *
   * The application's rolling `rating` is recomputed in the same transaction so the pipeline list
   * can sort by it without joining every scorecard on every page load.
   */
  @Post("applications/:id/scorecards")
  @HttpCode(201)
  async fileScorecard(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") applicationId: string,
    @Body() body: { interviewId?: string; scores?: unknown[]; overall?: number; recommendation?: string; notes?: string },
  ) {
    const scope = await scopeForApplication(tenantId, applicationId);
    await authorizeRecruitment(req.principal, tenantId, "create", scope, applicationId);
    if (body?.recommendation && !RECOMMENDATIONS.has(body.recommendation)) {
      throw new BadRequestException("recommendation must be strong_yes|yes|neutral|no|strong_no");
    }
    if (body?.overall !== undefined && (typeof body.overall !== "number" || body.overall < 0 || body.overall > 5)) {
      throw new BadRequestException("overall must be a number between 0 and 5");
    }
    const id = newId();
    const rating = await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO hr_scorecards (id, tenant_id, application_id, interview_id, reviewer_user_id, scores, overall, recommendation, notes, submitted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
           ON CONFLICT (tenant_id, application_id, reviewer_user_id, interview_id)
           DO UPDATE SET scores = EXCLUDED.scores, overall = EXCLUDED.overall,
                         recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes,
                         submitted_at = now(), updated_at = now()`,
          [id, tenantId, applicationId, body?.interviewId ?? null, req.principal.userId,
           JSON.stringify(body?.scores ?? []), body?.overall ?? null, body?.recommendation ?? null, body?.notes ?? null],
        );
        const avg = await c.query<{ avg: string | null }>(
          `SELECT avg(overall)::numeric(3,2) AS avg FROM hr_scorecards WHERE application_id = $1 AND overall IS NOT NULL`,
          [applicationId],
        );
        await c.query(`UPDATE hr_applications SET rating = $2, updated_at = now() WHERE id = $1`, [applicationId, avg.rows[0]?.avg ?? null]);
        await c.query(
          `INSERT INTO hr_application_events (id, tenant_id, application_id, event_type, data, created_by)
           VALUES ($1,$2,$3,'scorecard',$4,$5)`,
          [newId(), tenantId, applicationId, JSON.stringify({ overall: body?.overall, recommendation: body?.recommendation }), req.principal.userId],
        );
        return avg.rows[0]?.avg ?? null;
      },
      { modules: ["hr"] },
    );
    return { id, applicationRating: rating };
  }

  // ══════════════════════════════════════════════════════════════ OFFERS ══════════════════════
  @Post("applications/:id/offers")
  @HttpCode(201)
  async createOffer(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") applicationId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const baseAmount = typeof body?.baseAmount === "number" ? body.baseAmount : undefined;
    if (!baseAmount || baseAmount <= 0) throw new BadRequestException("baseAmount > 0 required");
    await authorize(req.principal, { kind: "hr_recruitment", tenantId, module: "hr" }, "create");
    const employmentType = typeof body?.employmentType === "string" && EMPLOYMENT_TYPES.has(body.employmentType)
      ? body.employmentType : "permanent";
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        const app = await c.query<{ requisition_id: string }>(
          `SELECT requisition_id FROM hr_applications WHERE id = $1 AND deleted_at IS NULL`, [applicationId],
        );
        if (!app.rows[0]) throw new NotFoundException("application not found");
        // Band check against the requisition's approved envelope. A warning rather than a refusal
        // would be useless — the envelope IS the approval, and exceeding it is a new approval.
        const band = await c.query<{ salary_min: string | null; salary_max: string | null }>(
          `SELECT salary_min, salary_max FROM hr_requisitions WHERE id = $1`, [app.rows[0].requisition_id],
        );
        const max = band.rows[0]?.salary_max === null || band.rows[0]?.salary_max === undefined ? null : Number(band.rows[0].salary_max);
        if (max !== null && baseAmount > max) {
          throw new BadRequestException(
            `offer of ${baseAmount} exceeds the requisition's approved maximum of ${max} — raise the requisition band first`,
          );
        }
        await c.query(
          `INSERT INTO hr_offers
             (id, tenant_id, application_id, base_amount, currency, rate_basis, allowances, employment_type,
              probation_months, contract_months, start_on, expires_on, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [id, tenantId, applicationId, baseAmount, body?.currency ?? "IDR", body?.rateBasis ?? "monthly",
           JSON.stringify(body?.allowances ?? []), employmentType, body?.probationMonths ?? null,
           body?.contractMonths ?? null, body?.startOn ?? null, body?.expiresOn ?? null, req.principal.userId, config.originSite],
        );
        await emitEvent(c, tenantId, "hr_offer", id, "hr.offer.created", { applicationId, baseAmount });
      },
      { modules: ["hr"] },
    );
    return { id, status: "draft" };
  }

  @Post("offers/:id/status")
  @HttpCode(200)
  async setOfferStatus(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { status?: string; declineReason?: string },
  ) {
    const ALLOWED = new Set(["sent", "accepted", "declined", "expired", "withdrawn"]);
    if (!body?.status || !ALLOWED.has(body.status)) {
      throw new BadRequestException("status must be sent|accepted|declined|expired|withdrawn");
    }
    // `converted` is unreachable here by construction — it is set only by the convert endpoint,
    // which is the only path that also creates the employee row that ck_hr_offer_conversion requires.
    await authorize(req.principal, { kind: "hr_recruitment", id, tenantId, module: "hr" }, "update");
    const res = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query(
          `UPDATE hr_offers
              SET status = $2,
                  decline_reason = COALESCE($3, decline_reason),
                  sent_at = CASE WHEN $2 = 'sent' THEN COALESCE(sent_at, now()) ELSE sent_at END,
                  responded_at = CASE WHEN $2 IN ('accepted','declined') THEN now() ELSE responded_at END,
                  updated_at = now()
            WHERE id = $1 AND status <> 'converted'
            RETURNING application_id AS "applicationId"`,
          [id, body.status, body?.declineReason ?? null],
        );
        if (!r.rows[0]) throw new NotFoundException("offer not found (or already converted)");
        await c.query(
          `INSERT INTO hr_application_events (id, tenant_id, application_id, event_type, data, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [newId(), tenantId, r.rows[0].applicationId,
           body.status === "accepted" ? "offer_accepted" : body.status === "declined" ? "offer_declined" : "offer_made",
           JSON.stringify({ offerId: id, status: body.status }), req.principal.userId],
        );
        return r.rows[0];
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "hr_offer", id, { status: body.status });
    return { ok: true, status: body.status, applicationId: res.applicationId };
  }

  /**
   * CONVERT an accepted offer into an employee record.
   *
   * The one bridge from recruitment into HR proper, and the reason it is its own high-assurance
   * action rather than a status edit: this is the moment an outsider becomes staff and becomes
   * reachable by IAM Phase 2's position reconciler. The database backs the boundary too —
   * `ck_hr_offer_conversion` makes "status = converted" and "has an employee_id" the same fact, so
   * a candidate cannot drift into staff through a status update alone.
   *
   * Everything below happens in ONE transaction: the employee row, the opening `hire` job event,
   * the initial compensation record, and the offer's conversion stamp. A partial conversion would
   * leave an employee with no pay record or a pay record with no employee.
   */
  @Post("offers/:id/convert")
  @HttpCode(201)
  async convertOffer(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { positionId?: string; hireDate?: string; workEmail?: string },
  ) {
    await authorize(req.principal, { kind: "hr_recruitment", id, tenantId, module: "hr" }, "convert");
    const out = await withTenants(
      [tenantId],
      async (c) => {
        const offer = await c.query<{
          status: string; application_id: string; base_amount: string; currency: string;
          rate_basis: string; employment_type: string; start_on: string | null; probation_months: number | null;
        }>(
          `SELECT status, application_id, base_amount, currency, rate_basis, employment_type, start_on, probation_months
           FROM hr_offers WHERE id = $1`,
          [id],
        );
        const found = offer.rows[0];
        if (!found) throw new NotFoundException("offer not found");
        if (found.status === "converted") throw new ConflictException("offer is already converted");
        if (found.status !== "accepted") throw new BadRequestException(`offer is '${found.status}' — only an accepted offer can be converted`);

        const cand = await c.query<{ candidate_id: string; full_name: string; email: string | null; phone: string | null }>(
          `SELECT a.candidate_id, cd.full_name, cd.email, cd.phone
           FROM hr_applications a JOIN hr_candidates cd ON cd.id = a.candidate_id
           WHERE a.id = $1`,
          [found.application_id],
        );
        const candidate = cand.rows[0];
        if (!candidate) throw new NotFoundException("candidate not found for this offer");

        const hireDate = body?.hireDate ?? found.start_on;
        if (!hireDate) throw new BadRequestException("hireDate required (the offer carries no startOn)");

        const employeeId = newId();
        await c.query(
          `INSERT INTO employees (id, tenant_id, display_name, legal_name, work_email, personal_email, phone, hire_date, employment_status, created_by, origin_site)
           VALUES ($1,$2,$3,$3,$4,$5,$6,$7,'pending_start',$8,$9)`,
          [employeeId, tenantId, candidate.full_name, body?.workEmail ?? null, candidate.email, candidate.phone,
           hireDate, req.principal.userId, config.originSite],
        );

        const jobEventId = newId();
        await c.query(
          `INSERT INTO hr_job_events (id, tenant_id, employee_id, effective_on, event_type, previous, current, reason, source_kind, source_id, position_id, created_by, origin_site)
           VALUES ($1,$2,$3,$4,'hire','{}',$5,$6,'manual',$7,$8,$9,$10)`,
          [
            jobEventId, tenantId, employeeId, hireDate,
            JSON.stringify({
              employmentType: found.employment_type, positionId: body?.positionId ?? null,
              probationMonths: found.probation_months, baseAmount: Number(found.base_amount), currency: found.currency,
            }),
            `converted from offer ${id}`, id, body?.positionId ?? null, req.principal.userId, config.originSite,
          ],
        );

        // The opening compensation row. Effective from the hire date, open-ended — the
        // ex_hr_compensation_no_overlap constraint makes a second open row impossible, so a later
        // raise MUST close this one, which is exactly the discipline wave C is built on.
        //
        // `pay_frequency` is deliberately NOT set here and takes the column default (monthly). An
        // offer agrees a RATE, not a payslip cadence — the cadence is Finance's operational
        // decision and is set on the compensation record afterwards. Writing a frequency from the
        // offer would put a Finance field under the recruiter's control at exactly the moment
        // nobody is looking at it.
        await c.query(
          `INSERT INTO hr_compensation (id, tenant_id, employee_id, base_amount, currency, rate_basis, effective_from, change_reason, job_event_id, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'hire',$8,$9,$10)`,
          [newId(), tenantId, employeeId, found.base_amount, found.currency, found.rate_basis, hireDate, jobEventId, req.principal.userId, config.originSite],
        );

        await c.query(
          `UPDATE hr_offers SET status = 'converted', employee_id = $2, converted_at = now(), updated_at = now() WHERE id = $1`,
          [id, employeeId],
        );
        await c.query(
          `UPDATE hr_applications SET status = 'hired', closed_at = now(), updated_at = now() WHERE id = $1`,
          [found.application_id],
        );
        await c.query(
          `UPDATE hr_requisitions SET filled = LEAST(openings, filled + 1),
                  status = CASE WHEN filled + 1 >= openings THEN 'filled' ELSE status END,
                  updated_at = now()
            WHERE id = (SELECT requisition_id FROM hr_applications WHERE id = $1)`,
          [found.application_id],
        );
        await emitEvent(c, tenantId, "employee", employeeId, "hr.employee.hired", {
          offerId: id, applicationId: found.application_id, hireDate, source: "recruitment",
        });
        return { employeeId, applicationId: found.application_id, hireDate };
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "converted", "hr_offer", id, out);
    return { ok: true, ...out, employmentStatus: "pending_start" };
  }

  // ═══════════════════════════════════════════════════════ PIPELINE STAGES ════════════════════
  @Get("pipeline-stages")
  async listStages(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "hr_recruitment", tenantId, module: "hr" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, key, label, sort_order AS "sortOrder", is_terminal AS "isTerminal",
                terminal_kind AS "terminalKind", requires_interview AS "requiresInterview", is_active AS "isActive"
         FROM hr_pipeline_stages ORDER BY sort_order, label`,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("pipeline-stages")
  @HttpCode(201)
  async upsertStages(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { stages?: { key?: string; label?: string; sortOrder?: number; isTerminal?: boolean; terminalKind?: string; requiresInterview?: boolean }[] },
  ) {
    const input = Array.isArray(body?.stages) ? body.stages : [];
    if (!input.length) throw new BadRequestException("stages[] required");
    await authorize(req.principal, { kind: "hr_recruitment", tenantId, module: "hr" }, "create");
    const n = await withTenants(
      [tenantId],
      async (c) => {
        let count = 0;
        for (const s of input) {
          if (!s.key || !s.label) throw new BadRequestException("stages[].key and stages[].label required");
          const isTerminal = !!s.isTerminal;
          // The ck_hr_stage_terminal CHECK enforces the pairing; validating here names the stage.
          if (isTerminal && !s.terminalKind) throw new BadRequestException(`stage '${s.key}' is terminal and needs terminalKind (hired|rejected|withdrawn)`);
          await c.query(
            `INSERT INTO hr_pipeline_stages (id, tenant_id, key, label, sort_order, is_terminal, terminal_kind, requires_interview)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (tenant_id, key) DO UPDATE SET
               label = EXCLUDED.label, sort_order = EXCLUDED.sort_order, is_terminal = EXCLUDED.is_terminal,
               terminal_kind = EXCLUDED.terminal_kind, requires_interview = EXCLUDED.requires_interview`,
            [newId(), tenantId, s.key, s.label, s.sortOrder ?? 0, isTerminal, isTerminal ? s.terminalKind : null, !!s.requiresInterview],
          );
          count += 1;
        }
        return count;
      },
      { modules: ["hr"] },
    );
    return { upserted: n };
  }

  // ══════════════════════════════════════════════════════════ FUNNEL VIEW ═════════════════════
  /**
   * Pipeline funnel for one requisition (or the whole tenant): count and median days-in-stage per
   * stage. This is the recruitment half of HR analytics, and it lives here rather than in the
   * analytics controller because it reads the same authorization scope as everything else on this
   * kind — a hiring manager should see their own funnel.
   */
  @Get("recruitment/funnel")
  async funnel(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("requisitionId") requisitionId?: string,
  ) {
    await authorize(req.principal, { kind: "hr_recruitment", tenantId, module: "hr" }, "read");
    const params: unknown[] = [];
    let filter = "";
    if (requisitionId) { params.push(requisitionId); filter = ` AND a.requisition_id = $${params.length}`; }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT s.key AS "stageKey", s.label, s.sort_order AS "sortOrder",
                count(a.id)::int AS "count",
                COALESCE(percentile_cont(0.5) WITHIN GROUP (
                  ORDER BY EXTRACT(EPOCH FROM now() - a.stage_entered_at) / 86400
                ), 0)::numeric(8,2) AS "medianDaysInStage"
         FROM hr_pipeline_stages s
         LEFT JOIN hr_applications a
           ON a.stage_key = s.key AND a.deleted_at IS NULL AND a.status IN ('active','on_hold')${filter}
         WHERE s.is_active
         GROUP BY s.key, s.label, s.sort_order
         ORDER BY s.sort_order`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }
}

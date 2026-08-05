// HR module routes (WSD-4). Mounted under /api/:tenantId/modules/hr and gated by AuthGuard +
// ModuleEnabledGuard("hr") — which is dark unless the tenant has 'hr' in enabled_modules OR an
// ACTIVE service_assignment serving 'hr' to this tenant (registry.ts isModuleEnabled, §4).
//
// Three independent walls back every read/write here (design §2.4):
//   1. Cerbos (resource_hr_case.yaml / resource_hr_record.yaml, WSD-2) — module_staff/module_manager
//      derived roles matched by resource.attr.module="hr" + tenantId=<SERVED company>.
//   2. The ORG-3 tenant choke-point (withTenants([tenantId])) — the caller's authorized-tenant-set.
//   3. Module-sliced RLS (app_module_allowed('hr'), WSD-3) — declared via withTenants(...,{modules:['hr']})
//      on every query below. Forgetting the third param on any new query here reads/writes ZERO
//      rows (fail-closed), never a leak.
//
// Cerbos resource-kind reuse (matches the policy repo, which builds ONLY resource_hr_case.yaml +
// resource_hr_record.yaml, WSD-2 §2.2): cases/leave/attendance/checklist-templates all authorize as
// kind "hr_case" (leave requests "inherit these via their own controller path" per that policy's own
// header comment); only hr_records authorizes as kind "hr_record" (no subject self-read in v1).
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { notifyBestEffort } from "../../core/client-notify";
import { resolveAutomationApprovalDeciders } from "../../core/approval-deciders";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import type { Principal } from "../../rbac/principal";
import { instantiateChecklistCase, type ChecklistItem } from "./checklists";

const CASE_KINDS = new Set(["onboarding", "offboarding", "review", "grievance", "other"]);
const CASE_STATUSES = new Set(["open", "in_progress", "done", "cancelled"]);
const RECORD_TYPES = new Set(["contract", "document", "note"]);
const LEAVE_TYPES = new Set(["vacation", "sick", "unpaid", "other"]);
const ATTENDANCE_STATUSES = new Set(["present", "remote", "absent", "leave"]);
const TEMPLATE_KINDS = new Set(["onboarding", "offboarding"]);

/** WSD-4's list-endpoint pattern: try the staff-level Cerbos check (module_staff/module_manager/
 *  company_admin/group_executive — no subjectUserId in play); on denial, fall back to the
 *  member-self rule (subjectUserId = the caller's own id) and report which path won so the caller
 *  applies the matching WHERE-clause narrowing. Throws (403) if NEITHER path is authorized —
 *  never silently returns an empty list for a genuinely unauthorized caller. */
export async function staffOrSelfRead(principal: Principal, tenantId: string, kind: "hr_case"): Promise<{ selfOnly: boolean }> {
  try {
    await authorize(principal, { kind, tenantId, module: "hr" }, "read");
    return { selfOnly: false };
  } catch {
    await authorize(principal, { kind, tenantId, module: "hr", subjectUserId: principal.userId ?? undefined }, "read");
    return { selfOnly: true };
  }
}

@Controller("api/:tenantId/modules/hr")
@UseGuards(AuthGuard, ModuleEnabledGuard("hr"))
export class HrController {
  // ================================================================== CASES ==================
  @Get("cases")
  async listCases(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("kind") kind?: string, @Query("status") status?: string, @Query("subjectUserId") subjectUserId?: string,
  ) {
    const { selfOnly } = await staffOrSelfRead(req.principal, tenantId, "hr_case");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (selfOnly) { params.push(req.principal.userId); clauses.push(`subject_user_id = $${params.length}`); }
    else if (subjectUserId) { params.push(subjectUserId); clauses.push(`subject_user_id = $${params.length}`); }
    if (kind) { params.push(kind); clauses.push(`kind = $${params.length}`); }
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, subject_user_id AS "subjectUserId", kind, status, title, details, custom, created_by AS "createdBy", created_at, updated_at
         FROM hr_cases WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("cases")
  @HttpCode(201)
  async createCase(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { subjectUserId?: string; kind?: string; title?: string; details?: Record<string, unknown> },
  ) {
    const { subjectUserId, title } = body ?? {};
    const kind = body?.kind && CASE_KINDS.has(body.kind) ? body.kind : undefined;
    if (!subjectUserId || !kind || !title) throw new BadRequestException("subjectUserId, kind (onboarding|offboarding|review|grievance|other) and title required");
    await authorize(req.principal, { kind: "hr_case", tenantId, module: "hr", subjectUserId }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO hr_cases (id, tenant_id, subject_user_id, kind, title, details, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, tenantId, subjectUserId, kind, title, JSON.stringify(body?.details ?? {}), req.principal.userId, config.originSite],
        );
        await emitEvent(c, tenantId, "hr_case", id, "hr.case.created", { kind, subjectUserId });
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "hr_case", id, { kind, subjectUserId });
    return { id };
  }

  @Get("cases/:id")
  async getCase(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const row = await withTenants(
      [tenantId],
      (c) => c.query<{ subject_user_id: string }>(`SELECT subject_user_id FROM hr_cases WHERE id = $1 AND deleted_at IS NULL`, [id]),
      { modules: ["hr"] },
    );
    if (!row.rows[0]) throw new NotFoundException("hr case not found");
    // A single fetched row carries its OWN subjectUserId, so one authorize() call covers both the
    // staff rule (ignores subjectUserId) and the member-self rule (subjectUserId==principal.id) —
    // no dual-path needed here, unlike the list endpoint above.
    await authorize(req.principal, { kind: "hr_case", id, tenantId, module: "hr", subjectUserId: row.rows[0].subject_user_id }, "read");
    const full = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, subject_user_id AS "subjectUserId", kind, status, title, details, custom, created_by AS "createdBy", created_at, updated_at
         FROM hr_cases WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      { modules: ["hr"] },
    );
    return full.rows[0];
  }

  @Patch("cases/:id")
  @HttpCode(200)
  async updateCase(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { status?: string; title?: string; details?: Record<string, unknown> },
  ) {
    if (body?.status && !CASE_STATUSES.has(body.status)) throw new BadRequestException("invalid status");
    // update has NO member-self rule (resource_hr_case.yaml) — staff/manager/company_admin only,
    // regardless of subjectUserId, so this is a plain staff-level authorize (no fallback).
    await authorize(req.principal, { kind: "hr_case", id, tenantId, module: "hr" }, "update");
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    if (body?.status) { params.push(body.status); sets.push(`status = $${params.length}`); }
    if (body?.title) { params.push(body.title); sets.push(`title = $${params.length}`); }
    if (body?.details) { params.push(JSON.stringify(body.details)); sets.push(`details = $${params.length}`); }
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE hr_cases SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`, params),
      { modules: ["hr"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("hr case not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "hr_case", id, body ?? {});
    return { id };
  }

  @Delete("cases/:id")
  @HttpCode(200)
  async deleteCase(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "hr_case", id, tenantId, module: "hr" }, "delete");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE hr_cases SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]),
      { modules: ["hr"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("hr case not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "hr_case", id, {});
    return { ok: true };
  }

  // Self-service cancel of one's OWN open/in_progress case (design §1: "cancellation of own
  // pending requests"). Only the `member` derived role has the "cancel" action in the policy —
  // staff achieve the equivalent via PATCH .../cases/:id {status:'cancelled'} (the "update" action).
  @Post("cases/:id/cancel")
  @HttpCode(200)
  async cancelCase(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const row = await withTenants(
      [tenantId],
      (c) => c.query<{ subject_user_id: string; status: string }>(`SELECT subject_user_id, status FROM hr_cases WHERE id = $1 AND deleted_at IS NULL`, [id]),
      { modules: ["hr"] },
    );
    if (!row.rows[0]) throw new NotFoundException("hr case not found");
    await authorize(req.principal, { kind: "hr_case", id, tenantId, module: "hr", subjectUserId: row.rows[0].subject_user_id }, "cancel");
    if (row.rows[0].status !== "open" && row.rows[0].status !== "in_progress") {
      throw new BadRequestException(`case is '${row.rows[0].status}', not cancellable`);
    }
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(`UPDATE hr_cases SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
        await emitEvent(c, tenantId, "hr_case", id, "hr.case.cancelled", {});
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "cancelled", "hr_case", id, {});
    return { ok: true, status: "cancelled" };
  }

  // Toggle one checklist item (onboarding/offboarding cases). Staff/manager/admin only (update).
  @Patch("cases/:id/checklist")
  @HttpCode(200)
  async toggleChecklistItem(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { index?: number; done?: boolean },
  ) {
    const index = body?.index;
    if (typeof index !== "number" || index < 0) throw new BadRequestException("index required");
    await authorize(req.principal, { kind: "hr_case", id, tenantId, module: "hr" }, "update");
    const updated = await withTenants(
      [tenantId],
      async (c) => {
        const row = await c.query<{ details: { items?: ChecklistItem[] } }>(`SELECT details FROM hr_cases WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (!row.rows[0]) return null;
        const items = row.rows[0].details.items ?? [];
        if (index >= items.length) throw new BadRequestException("index out of range");
        items[index] = {
          ...items[index],
          done: body?.done !== false,
          doneBy: body?.done !== false ? req.principal.userId : null,
          doneAt: body?.done !== false ? new Date().toISOString() : null,
        };
        await c.query(`UPDATE hr_cases SET details = jsonb_set(details, '{items}', $2::jsonb), updated_at = now() WHERE id = $1`, [id, JSON.stringify(items)]);
        return items;
      },
      { modules: ["hr"] },
    );
    if (!updated) throw new NotFoundException("hr case not found");
    return { id, items: updated };
  }

  // Manual onboarding/offboarding instantiation (the automatic path is the user.invited
  // eventHandler, checklists.ts). Reuses the SAME helper so neither path can drift.
  @Post("onboarding/instantiate")
  @HttpCode(201)
  async instantiate(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { subjectUserId?: string; kind?: string; templateId?: string },
  ) {
    const { subjectUserId, templateId } = body ?? {};
    const kind = body?.kind && TEMPLATE_KINDS.has(body.kind) ? (body.kind as "onboarding" | "offboarding") : undefined;
    if (!subjectUserId || !kind) throw new BadRequestException("subjectUserId and kind (onboarding|offboarding) required");
    await authorize(req.principal, { kind: "hr_case", tenantId, module: "hr", subjectUserId }, "create");
    const id = await instantiateChecklistCase(tenantId, subjectUserId, kind, req.principal.userId ?? subjectUserId, templateId);
    if (!id) throw new NotFoundException("no matching checklist template");
    await writeActivity(tenantId, req.principal.userId, "instantiated", "hr_case", id, { kind, subjectUserId });
    return { id };
  }

  // ================================================================ RECORDS ==================
  // No subject self-read in v1 (design §1/§2.2) — resource_hr_record.yaml has NO member rule, so
  // every record endpoint is a plain staff-level authorize (no dual-path fallback).
  @Get("records")
  async listRecords(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("subjectUserId") subjectUserId?: string, @Query("recordType") recordType?: string,
  ) {
    await authorize(req.principal, { kind: "hr_record", tenantId, module: "hr" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (subjectUserId) { params.push(subjectUserId); clauses.push(`subject_user_id = $${params.length}`); }
    if (recordType) { params.push(recordType); clauses.push(`record_type = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, subject_user_id AS "subjectUserId", record_type AS "recordType", data, file_id AS "fileId", created_by AS "createdBy", created_at
         FROM hr_records WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("records")
  @HttpCode(201)
  async createRecord(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { subjectUserId?: string; recordType?: string; data?: Record<string, unknown>; fileId?: string },
  ) {
    const { subjectUserId, fileId } = body ?? {};
    const recordType = body?.recordType && RECORD_TYPES.has(body.recordType) ? body.recordType : undefined;
    if (!subjectUserId || !recordType) throw new BadRequestException("subjectUserId and recordType (contract|document|note) required");
    await authorize(req.principal, { kind: "hr_record", tenantId, module: "hr" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO hr_records (id, tenant_id, subject_user_id, record_type, data, file_id, created_by, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, tenantId, subjectUserId, recordType, JSON.stringify(body?.data ?? {}), fileId ?? null, req.principal.userId, config.originSite],
      ),
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "hr_record", id, { recordType, subjectUserId });
    return { id };
  }

  @Patch("records/:id")
  @HttpCode(200)
  async updateRecord(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string,
    @Body() body: { data?: Record<string, unknown> },
  ) {
    await authorize(req.principal, { kind: "hr_record", id, tenantId, module: "hr" }, "update");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE hr_records SET data = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id, JSON.stringify(body?.data ?? {})]),
      { modules: ["hr"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("hr record not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "hr_record", id, {});
    return { id };
  }

  @Delete("records/:id")
  @HttpCode(200)
  async deleteRecord(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "hr_record", id, tenantId, module: "hr" }, "delete");
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE hr_records SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]),
      { modules: ["hr"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("hr record not found");
    await writeActivity(tenantId, req.principal.userId, "deleted", "hr_record", id, {});
    return { ok: true };
  }

  // Bulk export — the first real use of the D4 high-assurance tier (design §2.2).
  @Get("records/export")
  async exportRecords(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("subjectUserId") subjectUserId?: string, @Query("recordType") recordType?: string,
  ) {
    await authorize(req.principal, { kind: "hr_record", tenantId, module: "hr" }, "export");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (subjectUserId) { params.push(subjectUserId); clauses.push(`subject_user_id = $${params.length}`); }
    if (recordType) { params.push(recordType); clauses.push(`record_type = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, subject_user_id AS "subjectUserId", record_type AS "recordType", data, file_id AS "fileId", created_at
         FROM hr_records WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`,
        params,
      ),
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "exported", "hr_record", tenantId, { count: rows.rows.length });
    return rows.rows;
  }

  // ================================================================== LEAVE ==================
  @Get("leave")
  async listLeave(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("subjectUserId") subjectUserId?: string, @Query("status") status?: string,
  ) {
    const { selfOnly } = await staffOrSelfRead(req.principal, tenantId, "hr_case");
    const params: unknown[] = [];
    const clauses: string[] = ["deleted_at IS NULL"];
    if (selfOnly) { params.push(req.principal.userId); clauses.push(`subject_user_id = $${params.length}`); }
    else if (subjectUserId) { params.push(subjectUserId); clauses.push(`subject_user_id = $${params.length}`); }
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, subject_user_id AS "subjectUserId", leave_type AS "leaveType", starts_on AS "startsOn", ends_on AS "endsOn",
                minutes, note, status, approval_id AS "approvalId", decided_by AS "decidedBy", decided_at AS "decidedAt", created_at
         FROM hr_leave_requests WHERE ${clauses.join(" AND ")} ORDER BY starts_on DESC LIMIT 500`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Get("leave/balances")
  async leaveBalances(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("subjectUserId") subjectUserIdQ?: string, @Query("year") yearQ?: string,
  ) {
    const { selfOnly } = await staffOrSelfRead(req.principal, tenantId, "hr_case");
    const subjectUserId = selfOnly ? (req.principal.userId ?? undefined) : subjectUserIdQ;
    const params: unknown[] = [];
    const clauses = ["1=1"];
    if (subjectUserId) { params.push(subjectUserId); clauses.push(`subject_user_id = $${params.length}`); }
    if (yearQ) { params.push(Number(yearQ)); clauses.push(`year = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT subject_user_id AS "subjectUserId", year, leave_type AS "leaveType", allocated_minutes AS "allocatedMinutes", used_minutes AS "usedMinutes"
         FROM hr_leave_balances WHERE ${clauses.join(" AND ")} ORDER BY year DESC, leave_type`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  // File a leave request: writes hr_leave_requests (pending) AND the automation_approvals row
  // (origin='hr') in the SAME transaction (design §4 "Approvals integration") + an outbox event.
  // Deciding rides the EXISTING /automation-approvals/:id/decide endpoint (no fork) — the hr
  // eventHandler (leave-decision.ts) applies the outcome asynchronously off that event.
  @Post("leave")
  @HttpCode(201)
  async fileLeave(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { subjectUserId?: string; leaveType?: string; startsOn?: string; endsOn?: string; minutes?: number; note?: string },
  ) {
    const { subjectUserId, startsOn, endsOn, note } = body ?? {};
    const leaveType = body?.leaveType && LEAVE_TYPES.has(body.leaveType) ? body.leaveType : undefined;
    const minutes = typeof body?.minutes === "number" && body.minutes > 0 ? Math.round(body.minutes) : undefined;
    if (!subjectUserId || !leaveType || !startsOn || !endsOn || !minutes) {
      throw new BadRequestException("subjectUserId, leaveType (vacation|sick|unpaid|other), startsOn, endsOn and minutes>0 required");
    }
    if (endsOn < startsOn) throw new BadRequestException("endsOn must be >= startsOn");
    await authorize(req.principal, { kind: "hr_case", tenantId, module: "hr", subjectUserId }, "create");

    const subject = await withGlobal((c) => c.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [subjectUserId]));
    const subjectName = subject.rows[0]?.name ?? subjectUserId;
    const year = new Date(startsOn).getUTCFullYear();

    const { leaveRequestId, approvalId } = await withTenants(
      [tenantId],
      async (c) => {
        const balance = await c.query<{ allocated_minutes: number; used_minutes: number }>(
          `SELECT allocated_minutes, used_minutes FROM hr_leave_balances WHERE tenant_id = $1 AND subject_user_id = $2 AND year = $3 AND leave_type = $4`,
          [tenantId, subjectUserId, year, leaveType],
        );
        const allocated = balance.rows[0]?.allocated_minutes ?? 0;
        const usedAfter = (balance.rows[0]?.used_minutes ?? 0) + minutes;
        const balanceAfter = { allocatedMinutes: allocated, usedMinutesAfter: usedAfter, overAllocated: usedAfter > allocated };

        const leaveId = newId();
        await c.query(
          `INSERT INTO hr_leave_requests (id, tenant_id, subject_user_id, leave_type, starts_on, ends_on, minutes, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [leaveId, tenantId, subjectUserId, leaveType, startsOn, endsOn, minutes, note ?? null],
        );
        const href = `/hr/leave/${leaveId}`;
        const approvalIdRow = newId();
        await c.query(
          `INSERT INTO automation_approvals
             (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, requested_by, origin, origin_site)
           VALUES ($1,$2,'hr:leave','hr.fileLeave',$3,'medium',$4,$5,'hr',$6)`,
          [
            approvalIdRow, tenantId,
            JSON.stringify({ leaveRequestId: leaveId, subjectUserId, subjectName, leaveType, range: { startsOn, endsOn }, minutes, balanceAfter, href }),
            `${subjectName} requested ${leaveType} leave ${startsOn} to ${endsOn}`,
            req.principal.userId, config.originSite,
          ],
        );
        await c.query(`UPDATE hr_leave_requests SET approval_id = $2 WHERE id = $1`, [leaveId, approvalIdRow]);
        await emitEvent(c, tenantId, "hr_leave_request", leaveId, "hr.leave.filed", { subjectUserId, leaveType, minutes, approvalId: approvalIdRow });
        return { leaveRequestId: leaveId, approvalId: approvalIdRow };
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "filed", "hr_leave_request", leaveRequestId, { subjectUserId, leaveType, minutes });
    // MAIL-06 (F1 fix): origin='hr' automation_approvals rows are created in exactly TWO places —
    // here (leave) and LoansController.requestLoan (employee-portal wave E); the generic
    // automation-approvals.controller.ts create() endpoint restricts ORIGINS to automation|agent.
    // Both call sites must therefore resolve the module='hr' decider set — company_admin +
    // group_executive PLUS the providing unit's hr_manager (module_manager scoped module='hr',
    // mirroring resource_automation_approval.yaml's WSD-2 rule; see approval-deciders.ts's header).
    const deciders = await resolveAutomationApprovalDeciders(tenantId, "hr");
    await notifyBestEffort(tenantId, req.principal.userId, deciders, "approval.requested", {
      title: `${subjectName} requested ${leaveType} leave`,
      // APPR-01: was the bare list — see automation-approvals.controller.ts's create() for the
      // full rationale; this is the ONLY other automation_approvals insert site (origin='hr').
      href: `/approvals/${approvalId}`,
      entityType: "automation_approval",
      entityId: approvalId,
      origin: "hr",
      impact: "medium",
    });
    return { id: leaveRequestId, approvalId, status: "pending" };
  }

  // Self-service cancel of one's OWN PENDING leave request (design §1). Only `member` has the
  // "cancel" action on the shared hr_case gate (used here too) — staff never cancel someone
  // else's leave through this endpoint (they decide it via the approvals inbox instead).
  @Post("leave/:id/cancel")
  @HttpCode(200)
  async cancelLeave(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const row = await withTenants(
      [tenantId],
      (c) => c.query<{ subject_user_id: string; status: string }>(`SELECT subject_user_id, status FROM hr_leave_requests WHERE id = $1 AND deleted_at IS NULL`, [id]),
      { modules: ["hr"] },
    );
    if (!row.rows[0]) throw new NotFoundException("leave request not found");
    await authorize(req.principal, { kind: "hr_case", id, tenantId, module: "hr", subjectUserId: row.rows[0].subject_user_id }, "cancel");
    if (row.rows[0].status !== "pending") throw new BadRequestException(`leave request is '${row.rows[0].status}', not pending`);
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(`UPDATE hr_leave_requests SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
        await emitEvent(c, tenantId, "hr_leave_request", id, "hr.leave.cancelled", {});
      },
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "cancelled", "hr_leave_request", id, {});
    return { ok: true, status: "cancelled" };
  }

  // ============================================================= ATTENDANCE ===================
  // "staff-editable" (design §1): writes NEVER pass subjectUserId to Cerbos, so the member-self
  // rule (which requires subjectUserId==principal.id) can never match — only module_staff/
  // module_manager/company_admin can record attendance, even for their own subject id. Reads use
  // the normal staff-or-self dual-path (an employee may see their own attendance history).
  @Get("attendance")
  async listAttendance(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("subjectUserId") subjectUserId?: string, @Query("from") from?: string, @Query("to") to?: string,
  ) {
    const { selfOnly } = await staffOrSelfRead(req.principal, tenantId, "hr_case");
    const params: unknown[] = [];
    const clauses = ["1=1"];
    if (selfOnly) { params.push(req.principal.userId); clauses.push(`subject_user_id = $${params.length}`); }
    else if (subjectUserId) { params.push(subjectUserId); clauses.push(`subject_user_id = $${params.length}`); }
    if (from) { params.push(from); clauses.push(`day >= $${params.length}`); }
    if (to) { params.push(to); clauses.push(`day <= $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, subject_user_id AS "subjectUserId", day, status, note, recorded_by AS "recordedBy"
         FROM hr_attendance WHERE ${clauses.join(" AND ")} ORDER BY day DESC LIMIT 500`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("attendance")
  @HttpCode(200)
  async upsertAttendance(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { subjectUserId?: string; day?: string; status?: string; note?: string },
  ) {
    const { subjectUserId, day, note } = body ?? {};
    const status = body?.status && ATTENDANCE_STATUSES.has(body.status) ? body.status : undefined;
    if (!subjectUserId || !day || !status) throw new BadRequestException("subjectUserId, day and status (present|remote|absent|leave) required");
    // Deliberately NO subjectUserId on this authorize() call — see the class-level comment above.
    await authorize(req.principal, { kind: "hr_case", tenantId, module: "hr" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO hr_attendance (id, tenant_id, subject_user_id, day, status, note, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, subject_user_id, day)
         DO UPDATE SET status = $5, note = $6, recorded_by = $7, updated_at = now()`,
        [id, tenantId, subjectUserId, day, status, note ?? null, req.principal.userId],
      ),
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "recorded", "hr_attendance", subjectUserId, { day, status });
    return { ok: true };
  }

  // ===================================================== CHECKLIST TEMPLATES ==================
  @Get("checklist-templates")
  async listTemplates(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("kind") kind?: string) {
    await authorize(req.principal, { kind: "hr_case", tenantId, module: "hr" }, "read");
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (kind) { params.push(kind); clauses.push(`kind = $${params.length}`); }
    const rows = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT id, kind, name, items, is_default AS "isDefault" FROM hr_checklist_templates WHERE ${clauses.join(" AND ")} ORDER BY kind, name`,
        params,
      ),
      { modules: ["hr"] },
    );
    return rows.rows;
  }

  @Post("checklist-templates")
  @HttpCode(201)
  async createTemplate(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Body() body: { kind?: string; name?: string; items?: Array<{ label?: string }>; isDefault?: boolean },
  ) {
    const kind = body?.kind && TEMPLATE_KINDS.has(body.kind) ? body.kind : undefined;
    const name = body?.name?.trim();
    if (!kind || !name) throw new BadRequestException("kind (onboarding|offboarding) and name required");
    const items = (Array.isArray(body?.items) ? body.items : [])
      .filter((i): i is { label: string } => typeof i?.label === "string" && i.label.length > 0)
      .map((i) => ({ label: i.label }));
    await authorize(req.principal, { kind: "hr_case", tenantId, module: "hr" }, "create");
    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO hr_checklist_templates (id, tenant_id, kind, name, items, is_default) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, tenantId, kind, name, JSON.stringify(items), body?.isDefault === true],
      ),
      { modules: ["hr"] },
    );
    await writeActivity(tenantId, req.principal.userId, "created", "hr_checklist_template", id, { kind, name });
    return { id };
  }
}

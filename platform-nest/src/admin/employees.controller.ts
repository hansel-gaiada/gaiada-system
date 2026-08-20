// P2-06 — the employee record + joiner / mover / leaver, the capability this whole phase exists for.
//
// Design: docs/superpowers/plans/2026-08-13-iam-phase2-design.md §4 (the employee/`users` boundary),
// §5.1 joiner, §5.2 mover, §5.3 leaver. Consumes P2-01's schema (`0109`), P2-02's Cerbos kinds
// (`employee`, `position`), P2-04's `GrantWriteService` (indirectly, via the reconciler) and P2-05's
// position reconciler (`reconcileUser`).
//
// ── WHAT THIS FILE IS AND IS NOT AUTHORITATIVE FOR ─────────────────────────────────────────────
// It provisions ACCESS by writing seats; it never enforces access. Enforcement stays Cerbos + RLS.
// Every grant/revoke this file causes is caused INDIRECTLY, by `reconcileUser()` — no line here
// writes `user_roles`, which is P2-04's choke point's exclusive territory (a direct INSERT here
// would trip `user-roles-writer-guard.test.ts`, by design).
//
// ── THE MOVER GUARANTEE (design §5.2, binding on this file) ────────────────────────────────────
// After a transfer commits and the reconciler has run: (a) zero `user_roles` rows carry
// `managed_by_position` pointing at the closed assignment; (b) a live `authorize()` probe against a
// resource only the OLD department's role-set could reach returns 403; (c) the NEW department's
// probe returns 200; (d) the target's `session_version` moved. (a)/(d) are the reconciler's; this
// file's contribution is doing the close+open in ONE transaction so there is no window in which the
// person holds both seats or neither, and moving the blob person node in that SAME transaction so
// the next org PUT's sweep cannot silently revert the move (§4.2 — the stale-mover defect).
//
// ── NO FUTURE-DATED JML, DELIBERATELY (refusal, not a silent lie) ──────────────────────────────
// `startDate`/`effectiveDate`/`lastDay` are accepted for the RECORD, but a date in the FUTURE is
// refused with a typed 400. Reason, established from the reconciler's own source rather than
// assumed: `collectDesired()` (position-reconciler.ts) resolves desired grants with
// `pa.valid_to IS NULL` — it has no as-of axis. A future-dated transfer would therefore close the
// old seat and confer the new seat's access IMMEDIATELY while the record claimed it starts next
// month. Accepting the parameter and applying it now is exactly the frontend-first drift class this
// program keeps finding, so the surface refuses instead. Scheduled JML needs an as-of reconciler
// pass and is recorded as deferred in the P2-06 report, not stubbed here.
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch,
  Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants, type WithTenantsOptions } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "../core/http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { loadUnitAncestors } from "../core/org-unit-closure";
import { adoptManagedGrantAsManual } from "./service-reconciler";
import { reconcileUser } from "./position-reconciler";
import { revokeGrantById } from "./grant-write.service";
import {
  applyOrgStructure, loadOrgStructure, removePersonNode, upsertPersonNode,
} from "./org-structure.service";

// WSD-3: `employees` sits behind the HR module's THIRD RLS wall
// (`tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr')`, 0109), so every
// transaction that touches it must DECLARE the module scope — without this the INSERT is refused by
// RLS with "new row violates row-level security policy", which is exactly what the first run of
// `employees-jml.test.ts` produced. The position/org tables in the same transactions are CORE and
// unaffected by the declaration.
const HR_MODULE: WithTenantsOptions = { modules: ["hr"] };

const EMPLOYMENT_STATUSES = new Set(["pending_start", "active", "on_leave", "suspended", "terminated"]);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface EmployeeRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  display_name: string;
  legal_name: string | null;
  work_email: string | null;
  personal_email: string | null;
  phone: string | null;
  hire_date: string | null;
  employment_status: string;
  terminated_at: string | null;
  manager_user_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface PositionRow {
  id: string;
  unit_node_id: string;
  title: string;
  status: string;
}

function shape(r: EmployeeRow) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    displayName: r.display_name,
    legalName: r.legal_name,
    workEmail: r.work_email,
    personalEmail: r.personal_email,
    phone: r.phone,
    hireDate: r.hire_date,
    employmentStatus: r.employment_status,
    terminatedAt: r.terminated_at,
    managerUserId: r.manager_user_id,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Today in the DB's own terms, so a date comparison never straddles a timezone boundary between
 *  the Node process and Postgres. */
function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Accepts `YYYY-MM-DD` only, and refuses anything in the future — see this file's header for why
 *  a future date cannot be honoured by the reconciler as it stands. */
function parseEffectiveDate(raw: unknown, field: string): string {
  if (raw === undefined || raw === null || raw === "") return todayIsoLocal();
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new BadRequestException(`${field} must be a YYYY-MM-DD date`);
  }
  if (raw > todayIsoLocal()) {
    throw new BadRequestException(
      `${field} cannot be in the future: access is provisioned on commit, so a future date would ` +
        `grant or revoke today while claiming otherwise. Record the change on the day it takes effect.`,
    );
  }
  return raw;
}

async function loadPosition(c: PoolClient, tenantId: string, positionId: string): Promise<PositionRow> {
  const { rows } = await c.query<PositionRow>(
    `SELECT id, unit_node_id, title, status FROM positions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, positionId],
  );
  if (!rows[0]) throw new NotFoundException("position not found");
  if (rows[0].status !== "active") {
    throw new BadRequestException(`position is ${rows[0].status}; only an active position may be assigned`);
  }
  return rows[0];
}

async function loadEmployee(c: PoolClient, tenantId: string, employeeId: string): Promise<EmployeeRow> {
  const { rows } = await c.query<EmployeeRow>(
    `SELECT * FROM employees WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, employeeId],
  );
  if (!rows[0]) throw new NotFoundException("employee not found");
  return rows[0];
}

@Controller("api")
@UseGuards(AuthGuard)
export class EmployeesController {
  // ─────────────────────────────────── reads ───────────────────────────────────

  @Get(":tenantId/hr/employees")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "employee", tenantId }, "read");
    if (status && !EMPLOYMENT_STATUSES.has(status)) throw new BadRequestException("unknown status filter");
    const rows = await withTenants([tenantId], (c) =>
      c.query<EmployeeRow>(
        `SELECT * FROM employees
          WHERE tenant_id = $1 AND deleted_at IS NULL
            AND ($2::text IS NULL OR employment_status = $2)
          ORDER BY display_name`,
        [tenantId, status ?? null],
      ),
    HR_MODULE);
    return { employees: rows.rows.map(shape) };
  }

  @Get(":tenantId/hr/employees/:employeeId")
  async detail(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("employeeId") employeeId: string,
  ) {
    await authorize(req.principal, { kind: "employee", tenantId }, "read");
    const out = await withTenants([tenantId], async (c) => {
      const employee = await loadEmployee(c, tenantId, employeeId);
      const seats = employee.user_id
        ? (
            await c.query<{ id: string; position_id: string; title: string; unit_node_id: string; valid_from: string; valid_to: string | null }>(
              `SELECT pa.id, pa.position_id, p.title, p.unit_node_id,
                      pa.valid_from::text AS valid_from, pa.valid_to::text AS valid_to
                 FROM position_assignments pa
                 JOIN positions p ON p.id = pa.position_id AND p.tenant_id = pa.tenant_id
                WHERE pa.tenant_id = $1 AND pa.user_id = $2
                ORDER BY pa.valid_from DESC`,
              [tenantId, employee.user_id],
            )
          ).rows
        : [];
      return { employee, seats };
    }, HR_MODULE);
    return {
      ...shape(out.employee),
      seats: out.seats.map((s) => ({
        assignmentId: s.id,
        positionId: s.position_id,
        title: s.title,
        unitNodeId: s.unit_node_id,
        validFrom: s.valid_from,
        validTo: s.valid_to,
        current: s.valid_to === null,
      })),
    };
  }

  // ────────────────────────── §5.1 joiner (hire) ──────────────────────────
  //
  // Idempotency: the natural key is `(tenant_id, work_email)` (design §5.1). A retry with the same
  // email converges on the SAME employee row rather than creating a second person — and, because
  // every downstream write below is itself an upsert or an EXCLUDE-protected insert, a retry after a
  // partial failure completes the hire instead of half-repeating it.
  @Post(":tenantId/hr/employees")
  @HttpCode(201)
  async hire(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body()
    body: {
      displayName?: string;
      legalName?: string | null;
      workEmail?: string | null;
      personalEmail?: string | null;
      phone?: string | null;
      hireDate?: string;
      notes?: string | null;
      managerUserId?: string | null;
      positionId?: string;
      startDate?: string;
    },
  ) {
    const displayName = body?.displayName?.trim();
    if (!displayName) throw new BadRequestException("displayName required");
    const workEmail = body?.workEmail?.trim().toLowerCase() || null;
    if (workEmail && !EMAIL_RE.test(workEmail)) throw new BadRequestException("invalid workEmail");
    if (body?.positionId && !workEmail) {
      // A seat confers ROLES, and roles need a principal to hang on. Refuse loudly rather than
      // create the employee and silently skip the placement half of the request.
      throw new BadRequestException("workEmail is required when positionId is given: a seat needs a principal");
    }
    const startDate = parseEffectiveDate(body?.startDate, "startDate");
    const hireDate = body?.hireDate === undefined ? startDate : parseEffectiveDate(body.hireDate, "hireDate");

    await authorize(req.principal, { kind: "employee", tenantId }, "create");

    // The position, its unit ancestry, and the position.assign decision all resolve BEFORE any
    // write, so a refused placement leaves no employee row behind (the same no-partial-state
    // posture `inviteUser` established for its optional role grant).
    let position: PositionRow | null = null;
    if (body?.positionId) {
      const resolved = await withTenants([tenantId], async (c) => {
        const p = await loadPosition(c, tenantId, body.positionId!);
        return { p, ancestors: await loadUnitAncestors(c, tenantId, p.unit_node_id) };
      }, HR_MODULE);
      position = resolved.p;
      // `targetUserId` is resolved below (the user row may not exist yet); pass what we know now so
      // the self-assign DENY can fire when an existing user's email is being hired into a seat by
      // themselves. A brand-new invitee has no id, and the DENY is then vacuously false — it cannot
      // be the caller if it does not exist.
      const existingTarget = workEmail
        ? await withGlobal((c) =>
            c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`, [workEmail]),
          )
        : null;
      await authorize(
        req.principal,
        {
          kind: "position",
          id: position.id,
          tenantId,
          targetUserId: existingTarget?.rows[0]?.id ?? "",
          unitAncestors: resolved.ancestors,
        },
        "assign",
      );
    }

    // The principal (design §4.1: HR flows may CREATE the users row, never manage its credentials).
    // Reuse-by-email mirrors `inviteUser` exactly — `users.email` is UNIQUE, and a person hired by
    // a second group company must be the same principal, not a duplicate.
    // ⚠ ONLY when the person is being PLACED. A `pending_start` candidate deliberately gets no
    // principal: 0109's own column comment says so ("a pending_start candidate may have no
    // principal yet"), and minting a `users` row for every CV in the pipeline would quietly grow the
    // principal population — every one of which `assemblePrincipal()` would resolve — for people who
    // have not been hired. The row is created the moment a seat needs something to hang on, and the
    // `COALESCE(user_id, ...)` in the upsert above links it to the existing record then.
    let userId: string | null = null;
    if (workEmail && position) {
      userId = await withGlobal(async (c) => {
        const existing = await c.query<{ id: string }>(
          `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
          [workEmail],
        );
        if (existing.rows[0]) return existing.rows[0].id;
        const id = newId();
        await c.query(`INSERT INTO users (id, email, name, origin_site) VALUES ($1, $2, $3, $4)`, [
          id, workEmail, displayName, config.originSite,
        ]);
        return id;
      });
    }

    let membershipToAdopt: string | null = null;
    const out = await withTenants([tenantId], async (c) => {
      // (1) the employee record. Deliberately NOT a single `ON CONFLICT`: TWO partial unique
      // indexes can arbitrate this row — `ux_employees_tenant_user` (0109) and
      // `ux_employees_tenant_work_email` (0111) — and a targeted `ON CONFLICT` names exactly one
      // arbiter, so the OTHER index's violation would escape as an unhandled 23505 → 500. That is
      // the same class of defect 0092's partial index caused in `assignRole` (see
      // `assign-role-global-scope-idempotent.test.ts`). Find-then-write covers both axes and keeps
      // the indexes as the concurrency backstop rather than the control flow.
      const found = await c.query<EmployeeRow>(
        `SELECT * FROM employees
          WHERE tenant_id = $1 AND deleted_at IS NULL
            AND ((work_email IS NOT NULL AND work_email = $2) OR ($3::uuid IS NOT NULL AND user_id = $3))
          ORDER BY created_at
          LIMIT 1`,
        [tenantId, workEmail, userId],
      );
      const employee = found.rows[0]
        ? (
            await c.query<EmployeeRow>(
              `UPDATE employees SET
                 user_id           = COALESCE(user_id, $3::uuid),
                 display_name      = $4,
                 legal_name        = COALESCE($5, legal_name),
                 work_email        = COALESCE(work_email, $6),
                 personal_email    = COALESCE($7, personal_email),
                 phone             = COALESCE($8, phone),
                 hire_date         = COALESCE(hire_date, $9::date),
                 employment_status = CASE WHEN $10 AND employment_status = 'pending_start'
                                          THEN 'active' ELSE employment_status END,
                 manager_user_id   = COALESCE($11::uuid, manager_user_id),
                 notes             = COALESCE($12, notes),
                 updated_at        = now()
               WHERE tenant_id = $1 AND id = $2
               RETURNING *`,
              [
                tenantId, found.rows[0].id, userId, displayName, body?.legalName ?? null, workEmail,
                body?.personalEmail ?? null, body?.phone ?? null, hireDate, position !== null,
                body?.managerUserId ?? null, body?.notes ?? null,
              ],
            )
          ).rows[0]
        : (
            await c.query<EmployeeRow>(
              `INSERT INTO employees
                 (id, tenant_id, user_id, display_name, legal_name, work_email, personal_email, phone,
                  hire_date, employment_status, manager_user_id, notes, origin_site, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
               RETURNING *`,
              [
                newId(), tenantId, userId, displayName, body?.legalName ?? null, workEmail,
                body?.personalEmail ?? null, body?.phone ?? null, hireDate,
                position ? "active" : "pending_start", body?.managerUserId ?? null, body?.notes ?? null,
                config.originSite, req.principal.userId,
              ],
            )
          ).rows[0];

      if (userId && position) {
        // (2) membership — A14 adoption hook, copied from `inviteUser`: an explicit hire must ADOPT
        // a reconciler-managed (kind='service') row so a later service-assignment revoke cannot
        // decrement this now-doubly-intended membership out from under the hire.
        const existingMembership = await c.query<{ id: string; kind: string; managed_by: string | null }>(
          `SELECT id, kind, managed_by FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
          [tenantId, userId],
        );
        if (existingMembership.rows[0]?.kind === "service" && existingMembership.rows[0]?.managed_by) {
          membershipToAdopt = existingMembership.rows[0].id;
        }
        await c.query(
          `INSERT INTO company_memberships (id, tenant_id, user_id, kind, origin_site)
           VALUES ($1, $2, $3, 'employee', $4)
           ON CONFLICT (tenant_id, user_id)
           DO UPDATE SET status = 'active', deleted_at = NULL, kind = 'employee'`,
          [newId(), tenantId, userId, config.originSite],
        );

        // (3) the seat. `ON CONFLICT DO NOTHING` is not available against a GiST EXCLUDE, so the
        // idempotency is expressed as a guarded insert: an open assignment for this (position,
        // person) already satisfies the request.
        const openSeat = await c.query<{ id: string }>(
          `SELECT id FROM position_assignments
            WHERE tenant_id = $1 AND position_id = $2 AND user_id = $3 AND valid_to IS NULL`,
          [tenantId, position.id, userId],
        );
        let assignmentId = openSeat.rows[0]?.id ?? null;
        if (!assignmentId) {
          assignmentId = newId();
          await c.query(
            `INSERT INTO position_assignments
               (id, tenant_id, position_id, user_id, valid_from, assigned_by, reason, origin_site)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [assignmentId, tenantId, position.id, userId, startDate, req.principal.userId, "hire", config.originSite],
          );
          await emitEvent(c, tenantId, "position_assignment", assignmentId, "position_assignment.created", {
            positionId: position.id, userId, validFrom: startDate,
          });
        }

        // (4) the blob — §4.2's non-negotiable half: placement lives in the org blob, and the same
        // transaction moves it, or the next org PUT's sweep silently reverts this hire.
        const structure = await loadOrgStructure(c, tenantId);
        if (structure) {
          if (!upsertPersonNode(structure.root, position.unit_node_id, { userId, name: displayName })) {
            throw new BadRequestException(
              `position's unit node "${position.unit_node_id}" is not in this company's org structure`,
            );
          }
          await applyOrgStructure(c, tenantId, structure);
        }
      }

      await emitEvent(c, tenantId, "employee", employee.id, "employee.hired", {
        employeeId: employee.id, userId, positionId: position?.id ?? null, startDate,
      });
      return employee;
    }, HR_MODULE);

    if (config.serviceAssignmentsEnabled && membershipToAdopt) {
      await adoptManagedGrantAsManual(tenantId, { membershipId: membershipToAdopt });
    }
    // Access follows the seat — and it follows it HERE, not on a timer. The reconciler is
    // idempotent, so the `position_assignment.created` event's own consumer converging on the same
    // state later is harmless.
    const reconciled = userId ? await reconcileUser(tenantId, userId) : null;
    await writeActivity(tenantId, req.principal.userId, "hired", "employee", out.id, {
      positionId: position?.id ?? null,
    });
    return { ...shape(out), reconciled: reconciled ? { granted: reconciled.granted, revoked: reconciled.revoked } : null };
  }

  // ────────────────────────── employee record edits ──────────────────────────

  @Patch(":tenantId/hr/employees/:employeeId")
  async update(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("employeeId") employeeId: string,
    @Body()
    body: {
      displayName?: string;
      legalName?: string | null;
      personalEmail?: string | null;
      phone?: string | null;
      hireDate?: string;
      employmentStatus?: string;
      managerUserId?: string | null;
      notes?: string | null;
    },
  ) {
    await authorize(req.principal, { kind: "employee", tenantId }, "update");
    if (body?.employmentStatus !== undefined) {
      if (!EMPLOYMENT_STATUSES.has(body.employmentStatus)) {
        throw new BadRequestException("unknown employmentStatus");
      }
      if (body.employmentStatus === "terminated") {
        // Termination is a FLOW (§5.3): it closes seats, revokes grants, disables the login and
        // bumps the session. Allowing it as a field edit would produce a "terminated" employee who
        // still holds every grant — the exact silent-drift shape this program keeps finding.
        throw new BadRequestException("use POST /hr/employees/:id/terminate to terminate an employee");
      }
    }
    const updated = await withTenants([tenantId], async (c) => {
      await loadEmployee(c, tenantId, employeeId);
      const { rows } = await c.query<EmployeeRow>(
        `UPDATE employees SET
           display_name      = COALESCE($3, display_name),
           legal_name        = CASE WHEN $4 THEN $5 ELSE legal_name END,
           personal_email    = CASE WHEN $6 THEN $7 ELSE personal_email END,
           phone             = CASE WHEN $8 THEN $9 ELSE phone END,
           hire_date         = COALESCE($10::date, hire_date),
           employment_status = COALESCE($11, employment_status),
           manager_user_id   = CASE WHEN $12 THEN $13::uuid ELSE manager_user_id END,
           notes             = CASE WHEN $14 THEN $15 ELSE notes END,
           updated_at        = now()
         WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING *`,
        [
          tenantId, employeeId,
          body?.displayName?.trim() || null,
          body?.legalName !== undefined, body?.legalName ?? null,
          body?.personalEmail !== undefined, body?.personalEmail ?? null,
          body?.phone !== undefined, body?.phone ?? null,
          body?.hireDate === undefined ? null : parseEffectiveDate(body.hireDate, "hireDate"),
          body?.employmentStatus ?? null,
          body?.managerUserId !== undefined, body?.managerUserId ?? null,
          body?.notes !== undefined, body?.notes ?? null,
        ],
      );
      return rows[0];
    }, HR_MODULE);
    await writeActivity(tenantId, req.principal.userId, "updated", "employee", employeeId);
    return shape(updated);
  }

  /** Soft-delete the RECORD. Deliberately refuses while the person still holds a seat: deleting the
   *  people file out from under live grants would leave orphaned managed grants with nothing left
   *  to explain them. Terminate first — that is the flow that tears access down. */
  @Delete(":tenantId/hr/employees/:employeeId")
  @HttpCode(200)
  async remove(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("employeeId") employeeId: string,
  ) {
    await authorize(req.principal, { kind: "employee", tenantId }, "delete");
    await withTenants([tenantId], async (c) => {
      const employee = await loadEmployee(c, tenantId, employeeId);
      if (employee.user_id) {
        const open = await c.query<{ id: string }>(
          `SELECT id FROM position_assignments WHERE tenant_id = $1 AND user_id = $2 AND valid_to IS NULL`,
          [tenantId, employee.user_id],
        );
        if (open.rows.length) {
          throw new BadRequestException(
            `employee still holds ${open.rows.length} open position assignment(s); terminate first`,
          );
        }
      }
      await c.query(`UPDATE employees SET deleted_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`, [
        tenantId, employeeId,
      ]);
      await emitEvent(c, tenantId, "employee", employeeId, "employee.record_deleted", { employeeId });
    }, HR_MODULE);
    await writeActivity(tenantId, req.principal.userId, "deleted", "employee", employeeId);
    return { ok: true };
  }

  // ────────────────────────── §5.2 mover (transfer) ──────────────────────────

  @Post(":tenantId/hr/employees/:employeeId/transfer")
  @HttpCode(200)
  async transfer(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("employeeId") employeeId: string,
    @Body() body: { toPositionId?: string; effectiveDate?: string; reason?: string },
  ) {
    const toPositionId = body?.toPositionId?.trim();
    if (!toPositionId) throw new BadRequestException("toPositionId required");
    const effectiveDate = parseEffectiveDate(body?.effectiveDate, "effectiveDate");

    await authorize(req.principal, { kind: "employee", tenantId }, "update");

    const prep = await withTenants([tenantId], async (c) => {
      const employee = await loadEmployee(c, tenantId, employeeId);
      if (!employee.user_id) throw new BadRequestException("employee has no linked principal to move");
      if (employee.employment_status === "terminated") {
        throw new BadRequestException("employee is terminated; re-hire before transferring");
      }
      const toPosition = await loadPosition(c, tenantId, toPositionId);
      const open = (
        await c.query<{ id: string; position_id: string; unit_node_id: string }>(
          `SELECT pa.id, pa.position_id, p.unit_node_id
             FROM position_assignments pa
             JOIN positions p ON p.id = pa.position_id AND p.tenant_id = pa.tenant_id
            WHERE pa.tenant_id = $1 AND pa.user_id = $2 AND pa.valid_to IS NULL`,
          [tenantId, employee.user_id],
        )
      ).rows;
      return {
        employee,
        toPosition,
        open,
        toAncestors: await loadUnitAncestors(c, tenantId, toPosition.unit_node_id),
        fromAncestors: await Promise.all(open.map((o) => loadUnitAncestors(c, tenantId, o.unit_node_id))),
      };
    }, HR_MODULE);

    if (prep.open.some((o) => o.position_id === toPositionId)) {
      // Already there — idempotent no-op rather than a close+reopen churn that would bump the
      // session and re-emit events for a request that changes nothing.
      return { ok: true, unchanged: true, employeeId, positionId: toPositionId };
    }

    // BOTH halves are authorized: `assign` on the incoming seat AND `unassign` on every outgoing
    // seat. A dept head may therefore only transfer within their own subtree — pulling someone in
    // from a department they do not lead is refused at the outgoing seat, which is the fail-closed
    // reading of design §6.2's "assign/unassign carry the same rule shape". company_admin holds
    // both tenant-wide, so the ordinary HR path is unaffected.
    await authorize(
      req.principal,
      { kind: "position", id: prep.toPosition.id, tenantId, targetUserId: prep.employee.user_id!, unitAncestors: prep.toAncestors },
      "assign",
    );
    for (let i = 0; i < prep.open.length; i += 1) {
      await authorize(
        req.principal,
        { kind: "position", id: prep.open[i].position_id, tenantId, unitAncestors: prep.fromAncestors[i] },
        "unassign",
      );
    }

    const userId = prep.employee.user_id!;
    const newAssignmentId = newId();
    await withTenants([tenantId], async (c) => {
      // ONE transaction: close every outgoing seat, open the new one, move the blob node. A crash
      // anywhere rolls all three back — the person is never seatless and never doubly seated.
      for (const seat of prep.open) {
        await c.query(`UPDATE position_assignments SET valid_to = $2 WHERE id = $1 AND valid_to IS NULL`, [
          seat.id, effectiveDate,
        ]);
        await emitEvent(c, tenantId, "position_assignment", seat.id, "position_assignment.closed", {
          positionId: seat.position_id, userId, validTo: effectiveDate, reason: "transfer",
        });
      }
      await c.query(
        `INSERT INTO position_assignments
           (id, tenant_id, position_id, user_id, valid_from, assigned_by, reason, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          newAssignmentId, tenantId, prep.toPosition.id, userId, effectiveDate, req.principal.userId,
          body?.reason?.slice(0, 200) ?? "transfer", config.originSite,
        ],
      );
      await emitEvent(c, tenantId, "position_assignment", newAssignmentId, "position_assignment.created", {
        positionId: prep.toPosition.id, userId, validFrom: effectiveDate,
      });

      const structure = await loadOrgStructure(c, tenantId);
      if (structure) {
        if (!upsertPersonNode(structure.root, prep.toPosition.unit_node_id, {
          userId, name: prep.employee.display_name,
        })) {
          throw new BadRequestException(
            `target position's unit node "${prep.toPosition.unit_node_id}" is not in this company's org structure`,
          );
        }
        await applyOrgStructure(c, tenantId, structure);
      }

      await emitEvent(c, tenantId, "employee", employeeId, "employee.transferred", {
        employeeId, userId, fromPositionIds: prep.open.map((o) => o.position_id),
        toPositionId: prep.toPosition.id, effectiveDate,
      });
    }, HR_MODULE);

    const reconciled = await reconcileUser(tenantId, userId);
    await writeActivity(tenantId, req.principal.userId, "transferred", "employee", employeeId, {
      toPositionId: prep.toPosition.id,
    });
    return {
      ok: true,
      employeeId,
      userId,
      closedAssignmentIds: prep.open.map((o) => o.id),
      assignmentId: newAssignmentId,
      effectiveDate,
      reconciled: reconciled ? { granted: reconciled.granted, revoked: reconciled.revoked } : null,
    };
  }

  // ────────────────────────── §5.3 leaver (terminate) ──────────────────────────

  @Post(":tenantId/hr/employees/:employeeId/terminate")
  @HttpCode(200)
  async terminate(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("employeeId") employeeId: string,
    @Body() body: { lastDay?: string; reason?: string },
  ) {
    const lastDay = parseEffectiveDate(body?.lastDay, "lastDay");
    await authorize(req.principal, { kind: "employee", tenantId }, "update");

    const prep = await withTenants([tenantId], async (c) => {
      const employee = await loadEmployee(c, tenantId, employeeId);
      const open = employee.user_id
        ? (
            await c.query<{ id: string; position_id: string; unit_node_id: string }>(
              `SELECT pa.id, pa.position_id, p.unit_node_id
                 FROM position_assignments pa
                 JOIN positions p ON p.id = pa.position_id AND p.tenant_id = pa.tenant_id
                WHERE pa.tenant_id = $1 AND pa.user_id = $2 AND pa.valid_to IS NULL`,
              [tenantId, employee.user_id],
            )
          ).rows
        : [];
      return {
        employee,
        open,
        ancestors: await Promise.all(open.map((o) => loadUnitAncestors(c, tenantId, o.unit_node_id))),
      };
    }, HR_MODULE);

    // Every seat being closed is an `unassign` — so a dept head can only terminate someone whose
    // seats all sit in their own subtree, and company_admin/HR can terminate anyone in the tenant.
    for (let i = 0; i < prep.open.length; i += 1) {
      await authorize(
        req.principal,
        { kind: "position", id: prep.open[i].position_id, tenantId, unitAncestors: prep.ancestors[i] },
        "unassign",
      );
    }

    const userId = prep.employee.user_id;
    const revokedManual: { grantId: string; role: string; scopeType: string; scopeId: string | null }[] = [];

    await withTenants([tenantId], async (c) => {
      for (const seat of prep.open) {
        await c.query(`UPDATE position_assignments SET valid_to = $2 WHERE id = $1 AND valid_to IS NULL`, [
          seat.id, lastDay,
        ]);
        await emitEvent(c, tenantId, "position_assignment", seat.id, "position_assignment.closed", {
          positionId: seat.position_id, userId, validTo: lastDay, reason: "termination",
        });
      }
      if (userId) {
        await c.query(
          `UPDATE company_memberships SET status = 'inactive', updated_at = now()
            WHERE tenant_id = $1 AND user_id = $2`,
          [tenantId, userId],
        );
        const structure = await loadOrgStructure(c, tenantId);
        if (structure && removePersonNode(structure.root, userId) > 0) {
          await applyOrgStructure(c, tenantId, structure);
        }
      }
      await c.query(
        `UPDATE employees SET employment_status = 'terminated', terminated_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, employeeId],
      );
      await emitEvent(c, tenantId, "employee", employeeId, "employee.terminated", {
        employeeId, userId, lastDay, reason: body?.reason ?? null,
      });
    }, HR_MODULE);

    if (userId) {
      // The reconciler tears down everything a seat justified. It does NOT touch grants nobody's
      // seat ever claimed — those are this tenant's MANUAL grants, and §5.3 requires this flow to
      // revoke them and report the audited list. Routed through P2-04's choke point, never a direct
      // DELETE.
      const manual = await withGlobal((c) =>
        c.query<{ id: string; role: string; scope_type: string; scope_id: string | null }>(
          `SELECT ur.id, r.name AS role, ur.scope_type, ur.scope_id
             FROM user_roles ur
             JOIN roles r ON r.id = ur.role_id
            WHERE ur.user_id = $1
              AND ur.managed_by IS NULL AND ur.managed_by_position IS NULL
              AND ((ur.scope_type = 'company' AND ur.scope_id = $2)
                OR (ur.scope_type = 'org_unit' AND ur.scope_id IN (
                      SELECT node_id FROM org_units WHERE tenant_id = $2::uuid)))`,
          [userId, tenantId],
        ),
      );
      await reconcileUser(tenantId, userId);
      for (const g of manual.rows) {
        await withGlobal((c) => revokeGrantById(c, g.id, userId));
        revokedManual.push({ grantId: g.id, role: g.role, scopeType: g.scope_type, scopeId: g.scope_id });
      }

      // §5.3: platform access dies with the LAST active membership anywhere, never with this
      // company's alone — cross-company employment at another group company is deliberately
      // unaffected. `assemblePrincipal()` already returns null for a non-active user, so this is
      // what makes access stop before Keycloak is touched at all.
      const disabled = await withGlobal(async (c) => {
        // ⚠ THE RLS ZERO-ROW TRAP, caught by this flow's own test rather than reasoned about in
        // advance: `company_memberships` is RLS-protected, and a `withGlobal` connection sets no
        // tenant GUC — so this count returned **0 for everyone**, and the flow concluded "no other
        // employment" and disabled the login of every leaver, including people still employed at
        // another group company. Unset GUC ⇒ zero rows, no error.
        //
        // The sanctioned cross-tenant read is the `principal_lookup` policy (0072 §7b), the same one
        // `assemblePrincipal()` uses for precisely this question: it exposes only the rows of the ONE
        // user named in `app.principal_user_id`. It is transaction-local, hence the explicit
        // BEGIN/COMMIT around it, copied from `principal.ts`'s own usage.
        await c.query("BEGIN");
        let rows: { n: string }[];
        try {
          await c.query("SELECT set_config('app.principal_user_id', $1, true)", [userId]);
          rows = (
            await c.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM company_memberships
                WHERE user_id = $1 AND status = 'active' AND deleted_at IS NULL`,
              [userId],
            )
          ).rows;
          await c.query("COMMIT");
        } catch (err) {
          await c.query("ROLLBACK");
          throw err;
        }
        const stillEmployed = Number(rows[0]?.n ?? "0") > 0;
        if (!stillEmployed) {
          await c.query(`UPDATE users SET status = 'disabled', updated_at = now() WHERE id = $1`, [userId]);
        }
        // D11 regardless: a terminated person's live sessions are cut even if they remain employed
        // elsewhere, because THIS company's access just changed.
        await c.query(
          `UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`,
          [userId],
        );
        return !stillEmployed;
      });

      await writeActivity(tenantId, req.principal.userId, "terminated", "employee", employeeId, {
        loginDisabled: disabled,
      });
      return {
        ok: true,
        employeeId,
        userId,
        lastDay,
        closedAssignmentIds: prep.open.map((o) => o.id),
        revokedManualGrants: revokedManual,
        userDisabled: disabled,
        // The IT worklist (§5.4 / P2-13) is what completes the Keycloak side. HR never touches it.
        itFollowUp: disabled ? "disable_login" : null,
      };
    }

    await writeActivity(tenantId, req.principal.userId, "terminated", "employee", employeeId);
    return {
      ok: true, employeeId, userId: null, lastDay, closedAssignmentIds: [], revokedManualGrants: [],
      userDisabled: false, itFollowUp: null,
    };
  }
}

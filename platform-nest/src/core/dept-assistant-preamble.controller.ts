// AIP-13b (docs/plans/2026-10-27-ai-plan.md §6.2 item 7, owner ruling AIP-D10: each department head edits their own department's
// assistant preamble; docs/FRONTEND-BFF-CONTRACT.md §65; PERMISSION-CONTRACT §56) — a department's own assistant preamble:
//   GET /api/:tenantId/departments/:unitNodeId/assistant-preamble     the custom text, the default, the effective text and the preview (200)
//   PUT /api/:tenantId/departments/:unitNodeId/assistant-preamble     body { body: string }: write (1 to 1,000 characters) or reset (empty) (200)
// The Cerbos kind is `dept_assistant_preamble` (resource_dept_assistant_preamble.yaml). The rules, validation and SQL are in
// dept-assistant-preamble.service.ts; this file is routes and the order of checks. Nobody but the head of the unit (or one above it), a
// company admin and the owner reaches either route: a MEMBER does not need to, the assistant applies the text on the server
// (department-context.ts `resolvePreamble`, no Cerbos call).
//
// ── THE ORDER OF CHECKS (the dept-notices trap, §57.3) ───────────────────────────────────────────
//   (1) the unit's ancestry from the closure, computed WITH the tenant (node ids repeat across companies), BEFORE anything is looked at,
//   (2) AUTHORIZE: `manage` (the company tier) when the caller holds it, else the per-unit `read` / `edit` (the head's own rules),
//   (3) PUT only: the body (a refused caller always gets 403, never a 400),
//   (4) the department itself (`resolveDepartment`: an ACTIVE department of THIS company), 404 `department_not_found`,
//   (5) the read or the write, one `withTenants` transaction. Authorization (an HTTP call to Cerbos) is never done inside a transaction.
// A caller who may not touch a unit is refused (403) before anything says whether it exists: an id that is not in the org tree has no
// closure rows, so no head's grant matches it.
//
// ── THE COMPANY TIER IS ITS OWN ACTION (`manage`) ────────────────────────────────────────────────
// `owner` is permission-native (no Cerbos role rules) and a flat permission mirror on `read` or `edit` would let a head reach every unit,
// so the company tier (company_admin, owner) holds a separate action, IAM-14c's key split. `unitAncestors` is fed for both asks: the
// company-tier rules ignore it and the head's rules need it.
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Put, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { AuthGuard } from "../auth/guards";
import { check, type Resource } from "../rbac/cerbos";
import type { Principal } from "../rbac/principal";
import { authorize, writeActivity } from "./http";
import { loadUnitAncestors } from "./org-unit-closure";
import { resolveDepartment } from "../modules/assistant/department-context";
import * as svc from "./dept-assistant-preamble.service";

const KIND = "dept_assistant_preamble";

/** The Cerbos resource of one unit's preamble: the company and the unit's ancestry (WITH the tenant), never a body. */
const preambleResource = (tenantId: string, unitAncestors: string[]): Resource => ({ kind: KIND, tenantId, unitAncestors });

async function mapRules<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof svc.PreambleRuleError) {
      const body = { message: e.message, ...(e.field ? { field: e.field } : {}) };
      throw e.httpStatus === 404 ? new NotFoundException(body) : new BadRequestException(body);
    }
    throw e;
  }
}

/** Authorize `unitAction` on the unit, or the company tier's `manage` for a caller who holds it. The probe is a bare `check` (it writes
 *  no audit row for the head who does not hold `manage`); whichever action decides then goes through `authorize`, so the denial, the audit
 *  row and the delegation intersection are the house ones. A bot or automation principal is denied `manage` and `edit` by the policy's
 *  DENY, so it falls through to `authorize(edit)` and is refused there (and may still `read`). */
async function authorizeUnit(principal: Principal, tenantId: string, unitAncestors: string[], unitAction: "read" | "edit"): Promise<void> {
  const resource = preambleResource(tenantId, unitAncestors);
  const company = await check(principal, resource, "manage");
  await authorize(principal, resource, company.allow ? "manage" : unitAction);
}

@Controller("api/:tenantId/departments/:unitNodeId/assistant-preamble")
@UseGuards(AuthGuard)
export class DeptAssistantPreambleController {
  @Get()
  async read(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("unitNodeId") unitNodeId: string) {
    const principal = req.principal;
    const unitAncestors = await withTenants([tenantId], (c) => loadUnitAncestors(c, tenantId, unitNodeId));
    await authorizeUnit(principal, tenantId, unitAncestors, "read");
    return this.view(tenantId, unitNodeId);
  }

  @Put()
  @HttpCode(200)
  async write(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("unitNodeId") unitNodeId: string, @Body() body: unknown) {
    const principal = req.principal;
    const unitAncestors = await withTenants([tenantId], (c) => loadUnitAncestors(c, tenantId, unitNodeId));
    await authorizeUnit(principal, tenantId, unitAncestors, "edit");
    if (!principal.userId) throw new BadRequestException("no principal user");
    const userId = principal.userId;
    const input = await mapRules(() => svc.parsePutBody(body));

    const out = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        const department = await resolveDepartment(c, tenantId, unitNodeId);
        if (!department) throw svc.departmentNotFound();
        // The row is keyed by the node id the department RESOLVED to (the stored id, never the raw param's spelling).
        let changed: "edited" | "reset" | null;
        if (input.text === null) changed = (await svc.deletePreamble(c, tenantId, department.nodeId)) ? "reset" : null;
        else {
          await svc.upsertPreamble(c, tenantId, department.nodeId, input.text, userId);
          changed = "edited";
        }
        return { department, changed, row: await svc.loadPreambleRow(c, tenantId, department.nodeId) };
      }),
    );

    // Activity carries the unit and the length, never the text. A reset that found nothing to delete changed nothing and says nothing.
    if (out.changed) {
      await writeActivity(tenantId, userId, out.changed, "dept_assistant_preamble", null, {
        unitNodeId: out.department.nodeId,
        length: input.text === null ? 0 : Array.from(input.text).length,
      });
    }
    return svc.toPreambleView(out.department.nodeId, out.department, out.row);
  }

  /** The answer of GET: the department (404 when it is not an active one of this company) and its stored row. */
  private async view(tenantId: string, unitNodeId: string) {
    return mapRules(async () => {
      const out = await withTenants([tenantId], async (c) => {
        const department = await resolveDepartment(c, tenantId, unitNodeId);
        return department ? { department, row: await svc.loadPreambleRow(c, tenantId, department.nodeId) } : null;
      });
      if (!out) throw svc.departmentNotFound();
      return svc.toPreambleView(out.department.nodeId, out.department, out.row);
    });
  }
}

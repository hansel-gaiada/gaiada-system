// PV5-04b — the company's INVOICE NUMBERING settings (ruling PV-D35): its service lines and the number-code decode table.
// Tables: billing_service_lines, billing_number_codes (202610132115). Logic: ./billing-numbering.ts, ./issue.ts.
//
// An invoice number reads `{company}/{yyyy}/{mm}/{code}/{nnnn}`. The `{code}` stands for (service line, the client's
// business type) and is deliberately NOT mnemonic: a client cannot easily read it, staff decode it HERE. So everything in
// this file is staff-only, and no portal route reads either table.
//
// ── AUTHORIZATION (the same as the billing profile; runs BEFORE any validation) ─────────────────────
//   GET  service-lines, GET number-codes   : `finance_config` read   (finance_staff, finance_manager, company_admin).
//   PUT  service-lines/:key                : `finance_config` update (finance_manager, company_admin).
//   POST number-codes (pre-assign)         : `finance_config` update.
// Not gated on ModuleEnabledGuard: like the profile, this is company configuration set up BEFORE issuing is switched on.
//
// ── THE CODE IS NEVER EDITED ────────────────────────────────────────────────────────────────────────
// There is no PUT or DELETE for a code. A code is generated the first time a pair is needed (at issue, or here), and from
// then on an invoice may carry it: the table refuses any UPDATE and the runtime role has no UPDATE or DELETE.
import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { DatabaseError } from "pg";
import { newId, withTenants } from "../../db";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import registry from "../clients/centre/registry.json";
import { VALID_BUSINESS_TYPES } from "../clients/centre/validation";
import { NUMBER_CODE, SERVICE_LINE_KEY } from "./billing-numbering";

interface LineRow {
  key: string; name: string; departmentId: string | null; active: boolean; updatedAt: string; invoiceCount: number;
}
const SELECT_LINES = `
  SELECT s.key, s.name, s.department_id AS "departmentId", s.active, s.updated_at AS "updatedAt",
         (SELECT count(*)::int FROM invoices i WHERE i.tenant_id = s.tenant_id AND i.service_line_key = s.key AND i.deleted_at IS NULL) AS "invoiceCount"
    FROM billing_service_lines s WHERE s.tenant_id = $1`;

const shapeLine = (r: LineRow) => ({
  key: r.key, name: r.name, departmentId: r.departmentId, active: r.active, updatedAt: r.updatedAt, invoiceCount: Number(r.invoiceCount),
});

@Controller("api")
@UseGuards(AuthGuard)
export class BillingNumberingController {
  @Get(":tenantId/billing/service-lines")
  async lines(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "read");
    const r = await withTenants([tenantId], (c) => c.query<LineRow>(`${SELECT_LINES} ORDER BY s.name, s.key`, [tenantId]));
    return r.rows.map(shapeLine);
  }

  /** Create or edit one service line (the key is the identity and never changes; rename it with `name`). */
  @Put(":tenantId/billing/service-lines/:key")
  async putLine(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("key") key: string,
    @Body() body: { name?: unknown; departmentId?: unknown; active?: unknown },
  ) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "update");
    if (!SERVICE_LINE_KEY.test(key)) {
      throw new BadRequestException("a service line key is 2-32 characters: a lower-case letter, then lower-case letters, digits or '_'");
    }
    const b = body ?? {};
    const name = typeof b.name === "string" ? b.name.trim() : undefined;
    if (b.name !== undefined && (typeof b.name !== "string" || !name)) throw new BadRequestException("name cannot be blank");
    if (name && name.length > 120) throw new BadRequestException("name is at most 120 characters");
    let departmentId: string | null | undefined;
    if (b.departmentId !== undefined) {
      if (b.departmentId === null || b.departmentId === "") departmentId = null;
      else if (typeof b.departmentId === "string" && b.departmentId.trim() && b.departmentId.trim().length <= 120) departmentId = b.departmentId.trim();
      else throw new BadRequestException("departmentId must be a department id, or null to unlink");
    }
    if (b.active !== undefined && typeof b.active !== "boolean") throw new BadRequestException("active must be true or false");

    const actor = req.principal.userId;
    const out = await withTenants([tenantId], async (c) => {
      const prev = await c.query<{ id: string }>(`SELECT id FROM billing_service_lines WHERE tenant_id = $1 AND key = $2 FOR UPDATE`, [tenantId, key]);
      if (!prev.rows[0]) {
        if (!name) throw new BadRequestException("a new service line needs a name");
        try {
          await c.query(
            `INSERT INTO billing_service_lines (id, tenant_id, key, name, department_id, active, updated_by)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6::boolean, true), $7)`,
            [newId(), tenantId, key, name, departmentId ?? null, b.active ?? null, actor],
          );
        } catch (e) {
          // A concurrent create of the same key lost the race on the unique (tenant_id, key).
          if (e instanceof DatabaseError && e.code === "23505") throw new ConflictException({ message: `service line ${key} already exists`, reason: "conflict" });
          throw e;
        }
      } else {
        await c.query(
          `UPDATE billing_service_lines SET
              name = COALESCE($3, name),
              department_id = CASE WHEN $4::boolean THEN $5 ELSE department_id END,
              active = COALESCE($6::boolean, active),
              updated_by = $7, updated_at = now()
            WHERE tenant_id = $1 AND key = $2`,
          [tenantId, key, name ?? null, departmentId !== undefined, departmentId ?? null, b.active ?? null, actor],
        );
      }
      const row = (await c.query<LineRow>(`${SELECT_LINES} AND s.key = $2`, [tenantId, key])).rows[0];
      return { row, created: !prev.rows[0] };
    });
    await writeActivity(tenantId, actor, out.created ? "created" : "updated", "billing_service_line", null, {
      key, fields: Object.keys(b),
    });
    return shapeLine(out.row);
  }

  /** The decode table: every code assigned so far, with what it stands for. Staff only (finance_config read). */
  @Get(":tenantId/billing/number-codes")
  async codes(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "read");
    const r = await withTenants([tenantId], (c) =>
      c.query<{ serviceLineKey: string; serviceLineName: string; businessType: string; code: string; createdAt: string; invoiceCount: number }>(
        `SELECT n.service_line_key AS "serviceLineKey", s.name AS "serviceLineName", n.business_type AS "businessType",
                n.code, n.created_at AS "createdAt",
                (SELECT count(*)::int FROM invoices i WHERE i.tenant_id = n.tenant_id AND i.number_code = n.code AND i.deleted_at IS NULL) AS "invoiceCount"
           FROM billing_number_codes n
           JOIN billing_service_lines s ON s.tenant_id = n.tenant_id AND s.key = n.service_line_key
          WHERE n.tenant_id = $1
          ORDER BY s.name, n.business_type`,
        [tenantId],
      ),
    );
    const labels = new Map((registry.businessTypes as Array<{ id: string; label: string }>).map((b) => [b.id, b.label]));
    return {
      codes: r.rows.map((x) => ({
        serviceLineKey: x.serviceLineKey, serviceLineName: x.serviceLineName,
        businessType: x.businessType, businessTypeLabel: labels.get(x.businessType) ?? x.businessType,
        code: x.code, createdAt: x.createdAt, invoiceCount: Number(x.invoiceCount),
        // A code is never edited; once an invoice carries it, it could not be reassigned even if it were.
        used: Number(x.invoiceCount) > 0,
      })),
      // What the pre-assign form offers: the client business types the client centre knows.
      businessTypes: (registry.businessTypes as Array<{ id: string; label: string }>).map((b) => ({ id: b.id, label: b.label })),
    };
  }

  /**
   * Pre-assign the code of a pair before its first invoice. Body: `{ serviceLineKey, businessType, code? }`. With no `code`
   * one is generated (random, from an alphabet without O, 0, I, 1, L); with one it must be 2-4 characters of A-Z and 0-9
   * and unused in this company. A pair that already has a code is never changed: asking again for the same code (or for
   * none) answers it with `alreadyAssigned: true`, asking for a different one is a 409.
   */
  @Post(":tenantId/billing/number-codes")
  @HttpCode(200)
  async preAssign(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { serviceLineKey?: unknown; businessType?: unknown; code?: unknown },
  ) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "update");
    const b = body ?? {};
    const key = typeof b.serviceLineKey === "string" ? b.serviceLineKey.trim() : "";
    const businessType = typeof b.businessType === "string" ? b.businessType.trim() : "";
    if (!SERVICE_LINE_KEY.test(key)) throw new BadRequestException("serviceLineKey must be a service line key");
    if (!VALID_BUSINESS_TYPES.has(businessType)) throw new BadRequestException("businessType must be a client-centre business type");
    let code: string | null = null;
    if (b.code !== undefined && b.code !== null && b.code !== "") {
      if (typeof b.code !== "string" || !NUMBER_CODE.test(b.code)) throw new BadRequestException("code must be 2-4 characters of A-Z and 0-9, or omitted to generate one");
      code = b.code;
    }

    const actor = req.principal.userId;
    const out = await withTenants([tenantId], async (c) => {
      const line = await c.query(`SELECT 1 FROM billing_service_lines WHERE tenant_id = $1 AND key = $2`, [tenantId, key]);
      if (!line.rows[0]) throw new NotFoundException(`service line ${key} not found`);
      const have = async () =>
        (await c.query<{ code: string }>(
          `SELECT code FROM billing_number_codes WHERE tenant_id = $1 AND service_line_key = $2 AND business_type = $3`,
          [tenantId, key, businessType],
        )).rows[0]?.code ?? null;

      if (code === null) {
        const before = await have();
        const made = (await c.query<{ code: string }>(`SELECT billing_number_code($1, $2, $3) AS code`, [tenantId, key, businessType])).rows[0].code;
        return { code: made, alreadyAssigned: before !== null };
      }
      // A code the caller chose takes the SAME per-company lock the generator takes, so a concurrent generation cannot
      // pick it between our check and our insert.
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing_number_code:' || $1::uuid::text, 0))`, [tenantId]);
      const existing = await have();
      if (existing !== null) {
        if (existing === code) return { code: existing, alreadyAssigned: true };
        throw new ConflictException({ message: `this pair already has the code ${existing}; a code is never changed`, reason: "code_already_assigned", code: existing });
      }
      try {
        await c.query(
          `INSERT INTO billing_number_codes (tenant_id, service_line_key, business_type, code) VALUES ($1, $2, $3, $4)`,
          [tenantId, key, businessType, code],
        );
      } catch (e) {
        if (e instanceof DatabaseError && e.code === "23505") {
          throw new ConflictException({ message: `the code ${code} already stands for another pair in this company`, reason: "code_taken" });
        }
        throw e;
      }
      return { code, alreadyAssigned: false };
    });
    if (!out.alreadyAssigned) {
      await writeActivity(tenantId, actor, "created", "billing_number_code", null, { serviceLineKey: key, businessType, code: out.code });
    }
    return { serviceLineKey: key, businessType, code: out.code, alreadyAssigned: out.alreadyAssigned };
  }
}

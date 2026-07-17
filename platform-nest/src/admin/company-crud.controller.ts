// Company lifecycle (BFF §2): create / update / detail for the holding hierarchy.
// GET /api/companies (list) lives in CoreController; this adds the single-resource
// detail + the elevated write paths the platform-ui company management surface consumes.
// Companies are a GLOBAL table (no per-tenant RLS) — reads/writes go through withGlobal;
// membership + the outbox event are tenant-scoped and go through withTenants.
import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "../core/http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";

const COMPANY_COLS = "id, name, type, enabled_modules, status, parent_company_id, settings";

@Controller("api")
@UseGuards(AuthGuard)
export class CompanyCrudController {
  // Single-company detail (CompanyDetail: adds parent_company_id + settings). The UI
  // derives from the list today; this lets it fetch a single company directly.
  @Get("companies/:companyId")
  async getCompany(@Req() req: FastifyRequest, @Param("companyId") companyId: string) {
    await authorize(req.principal, { kind: "company", id: companyId, tenantId: companyId }, "read");
    const rows = await withGlobal((c) =>
      c.query(`SELECT ${COMPANY_COLS} FROM companies WHERE id = $1 AND deleted_at IS NULL`, [companyId]),
    );
    if (!rows.rows[0]) throw new NotFoundException("company not found");
    return rows.rows[0];
  }

  // Create a company (elevated: platform_admin / group_executive). The creator is added
  // as a member so the new company appears in their top-bar switcher (matches /api/me).
  @Post("companies")
  @HttpCode(201)
  async createCompany(
    @Req() req: FastifyRequest,
    @Body() body: { name?: string; type?: string; parentCompanyId?: string | null; modules?: string[] },
  ) {
    const name = body?.name?.trim();
    if (!name) throw new BadRequestException("name required");
    // Resource has no tenant yet — only the global-elevated roles clear this gate.
    await authorize(req.principal, { kind: "company" }, "create");
    const type = body?.type?.trim() || "general";
    const modules = Array.isArray(body?.modules) ? body!.modules!.filter((m) => typeof m === "string") : [];
    const parentId = body?.parentCompanyId ?? null;

    const id = newId();
    // One transaction scoped to the new company: companies has no RLS (global table);
    // membership + outbox row satisfy the tenant-isolation policy for tenant_id = id.
    await withTenants([id], async (c) => {
      if (parentId) {
        const parent = await c.query(`SELECT 1 FROM companies WHERE id = $1 AND deleted_at IS NULL`, [parentId]);
        if (!parent.rows[0]) throw new BadRequestException("parent company not found");
      }
      await c.query(
        `INSERT INTO companies (id, name, type, enabled_modules, parent_company_id, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, name, type, modules, parentId, config.originSite],
      );
      if (req.principal.userId) {
        await c.query(
          `INSERT INTO company_memberships (id, tenant_id, user_id, origin_site) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, user_id) DO NOTHING`,
          [newId(), id, req.principal.userId, config.originSite],
        );
      }
      await emitEvent(c, id, "company", id, "company.created", { name, type, parentCompanyId: parentId });
    });
    await writeActivity(id, req.principal.userId, "created", "company", id, { name });
    return { id };
  }

  // Update a company (company.manage — company_admin on the tenant, or global-elevated).
  @Patch("companies/:companyId")
  @HttpCode(200)
  async updateCompany(
    @Req() req: FastifyRequest,
    @Param("companyId") companyId: string,
    @Body() b: { name?: string; type?: string; parentCompanyId?: string | null; status?: string; modules?: string[] },
  ) {
    await authorize(req.principal, { kind: "company", id: companyId, tenantId: companyId }, "update");
    const modules = b?.modules !== undefined && Array.isArray(b.modules) ? b.modules.filter((m) => typeof m === "string") : null;
    // parentCompanyId is nullable-settable: distinguish "omitted" from "set to null".
    const setParent = Object.prototype.hasOwnProperty.call(b ?? {}, "parentCompanyId");
    await withTenants([companyId], async (c) => {
      if (setParent && b.parentCompanyId) {
        if (b.parentCompanyId === companyId) throw new BadRequestException("a company cannot be its own parent");
        const parent = await c.query(`SELECT 1 FROM companies WHERE id = $1 AND deleted_at IS NULL`, [b.parentCompanyId]);
        if (!parent.rows[0]) throw new BadRequestException("parent company not found");
      }
      const res = await c.query(
        `UPDATE companies SET
           name = COALESCE($2, name),
           type = COALESCE($3, type),
           status = COALESCE($4, status),
           enabled_modules = COALESCE($5, enabled_modules),
           parent_company_id = CASE WHEN $6 THEN $7 ELSE parent_company_id END,
           updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [companyId, b?.name ?? null, b?.type ?? null, b?.status ?? null, modules, setParent, b?.parentCompanyId ?? null],
      );
      if (res.rowCount === 0) throw new NotFoundException("company not found");
      await emitEvent(c, companyId, "company", companyId, "company.updated", { status: b?.status ?? null });
    });
    await writeActivity(companyId, req.principal.userId, "updated", "company", companyId, { status: b?.status });
    return { ok: true };
  }
}

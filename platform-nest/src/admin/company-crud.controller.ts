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
  //
  // D14-07: this is also the write path for `companies.settings.automation.approvalRetry` (OQ-5) —
  // the ticket's constraint 10 forbids a new settings table/subsystem, and this PATCH is the ONLY
  // existing company-write surface, so the retry setting rides through it as a namespaced,
  // individually-validated key rather than a generic `settings` overwrite. `companies.settings` is
  // a SHARED jsonb column (0001) other features may already have keys in, so the SQL below merges
  // via `jsonb_set(..., '{automation,approvalRetry}', ..., true)` — it touches ONLY that one nested
  // path and leaves every sibling top-level key, and every sibling key under `automation`, exactly
  // as it was. Never build a blanket `settings = $n::jsonb` overwrite here.
  @Patch("companies/:companyId")
  @HttpCode(200)
  async updateCompany(
    @Req() req: FastifyRequest,
    @Param("companyId") companyId: string,
    @Body() b: {
      name?: string; type?: string; parentCompanyId?: string | null; status?: string; modules?: string[];
      settings?: { automation?: { approvalRetry?: { autoRetryCount?: unknown } } };
    },
  ) {
    await authorize(req.principal, { kind: "company", id: companyId, tenantId: companyId }, "update");
    const modules = b?.modules !== undefined && Array.isArray(b.modules) ? b.modules.filter((m) => typeof m === "string") : null;
    // parentCompanyId is nullable-settable: distinguish "omitted" from "set to null".
    const setParent = Object.prototype.hasOwnProperty.call(b ?? {}, "parentCompanyId");

    // `undefined` (the field, or any ancestor of it, omitted) => leave `settings` completely
    // untouched; a present value is validated 0..3 (approval-execute.ts's MAX_AUTO_RETRY_COUNT
    // clamp is the read-side twin of this write-side validation — keep both if either changes).
    let autoRetryCount: number | undefined;
    const rawRetry = b?.settings?.automation?.approvalRetry?.autoRetryCount;
    if (rawRetry !== undefined) {
      if (typeof rawRetry !== "number" || !Number.isInteger(rawRetry) || rawRetry < 0 || rawRetry > 3) {
        throw new BadRequestException("settings.automation.approvalRetry.autoRetryCount must be an integer 0..3");
      }
      autoRetryCount = rawRetry;
    }
    const setRetry = autoRetryCount !== undefined;

    await withTenants([companyId], async (c) => {
      if (setParent && b.parentCompanyId) {
        if (b.parentCompanyId === companyId) throw new BadRequestException("a company cannot be its own parent");
        const parent = await c.query(`SELECT 1 FROM companies WHERE id = $1 AND deleted_at IS NULL`, [b.parentCompanyId]);
        if (!parent.rows[0]) throw new BadRequestException("parent company not found");
      }
      // NOTE on the `settings` merge below: jsonb_set with create_missing=true CANNOT create an
      // intermediate object on a multi-segment path — against a settings value with no top-level
      // 'automation' key yet, jsonb_set(settings, '{automation,approvalRetry}', ..., true) returns
      // settings UNCHANGED (documented Postgres behaviour: jsonb_set only ever creates the FINAL
      // path segment, never its ancestors; verified against this exact shape while building this
      // ticket). So this merges with the jsonb concat operator at each level instead: the inner
      // concat overlays the new 'approvalRetry' key onto whatever the existing 'automation' object
      // already has (preserving sibling keys under 'automation'); the outer concat overlays the
      // resulting 'automation' key onto the rest of `settings` (preserving every sibling TOP-LEVEL
      // key). Both COALESCEs handle a NULL `settings` and an absent/NULL 'automation' key on a
      // company that has neither yet.
      const res = await c.query(
        `UPDATE companies SET
           name = COALESCE($2, name),
           type = COALESCE($3, type),
           status = COALESCE($4, status),
           enabled_modules = COALESCE($5, enabled_modules),
           parent_company_id = CASE WHEN $6 THEN $7 ELSE parent_company_id END,
           settings = CASE WHEN $8::boolean THEN
             COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
               'automation',
               COALESCE(settings -> 'automation', '{}'::jsonb) || jsonb_build_object('approvalRetry', jsonb_build_object('autoRetryCount', $9::int))
             )
           ELSE settings END,
           updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [companyId, b?.name ?? null, b?.type ?? null, b?.status ?? null, modules, setParent, b?.parentCompanyId ?? null, setRetry, autoRetryCount ?? 0],
      );
      if (res.rowCount === 0) throw new NotFoundException("company not found");
      await emitEvent(c, companyId, "company", companyId, "company.updated", { status: b?.status ?? null });
    });
    await writeActivity(companyId, req.principal.userId, "updated", "company", companyId, { status: b?.status });
    return { ok: true };
  }
}

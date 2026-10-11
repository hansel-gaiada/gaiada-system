// PV1-06a — `GET /api/:tenantId/reports/group` (the BFF contract writes it `/api/:rootId/...`; the
// route param is named `tenantId` like every other `/api/:x` controller so the router sees one
// parametric segment). The group report of PV-D19: per-company cards plus Sum of companies, for the
// owner of the root (PV-D20) or `platform_admin`. Assembly and the summing rule: group-report.ts.
//
// ORDER, and why each step is where it is:
//   1. Cerbos, twice, on the root tenant. The group report is made of two group-tier reads, so it
//      asks for both and needs both:
//        `rollup:read`             — the group rollups of this root (resource_rollup.yaml: the root
//                                    owner rule, platform_admin, or a `core.rollup.read` holder);
//        `report_document:read_company` — the root's own Company Report (resource_report_document
//                                    .yaml: owner on the tenant, company_admin, platform_admin).
//      Owner-of-:t and platform_admin pass both. A company_admin of the root fails the first; a
//      custom role holding only `core.rollup.read` fails the second. The one residual is a person
//      holding BOTH company_admin of the root AND a delegated `core.rollup.read` — someone already
//      entitled to both halves separately. No new Cerbos action was added, because a new action
//      must be catalogued (cerbos-catalog-alignment.test.ts (b)) and that means a migration.
//   2. Root check → 404. Authorize FIRST so a member probing an id gets 403, not a 404 that tells
//      them which ids are roots ("validation must not pre-empt authz"). Cerbos cannot tell a root
//      from a child, so this code check is HALF of "owner of the root": an owner of a child passes
//      step 1 on that child and is stopped here.
//   3. Range validation → 400, the same `resolveRange` the Company Report uses.
//
// NO ModuleEnabledGuard on the root: the holding need not run `reports` itself for its group report
// to exist. Each company's card instead checks that company's own module flag, exactly the gate
// its Company Report sits behind, and a company without it gets `figures: null` — never zeros.
import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { authorize } from "../../core/http";
import { isModuleEnabled } from "../registry";
import { fetchReportDocumentForRead, resolveRange } from "./reports.controller";
import { assembleGroupReport, isRootCompany, listGroupCompanies, type GroupReport } from "./group-report";

@Controller("api/:tenantId/reports/group")
@UseGuards(AuthGuard)
export class GroupReportController {
  @Get()
  async getGroupReport(
    @Req() req: FastifyRequest,
    @Param("tenantId") rootId: string,
    @Query("periodKind") periodKindRaw?: string,
    @Query("start") start?: string,
    @Query("end") end?: string,
  ): Promise<GroupReport> {
    await authorize(req.principal, { kind: "rollup", tenantId: rootId }, "read");
    await authorize(req.principal, { kind: "report_document", tenantId: rootId, module: "reports" }, "read_company");

    if (!(await isRootCompany(rootId))) {
      throw new NotFoundException("not a root company");
    }

    const { periodKind, start: s, end: e } = resolveRange(periodKindRaw, start, end);

    const companies = await listGroupCompanies(rootId);
    // Sequential, not Promise.all: each document read opens its own tenant transaction, and a group
    // is a handful of companies — not worth N concurrent pool connections per request.
    const docs = [];
    for (const company of companies) {
      const document = (await isModuleEnabled(company.id, "reports"))
        ? await fetchReportDocumentForRead(company.id, "company", company.id, periodKind, s, e)
        : null;
      docs.push({ company, document });
    }

    return assembleGroupReport({ rootCompanyId: rootId, periodKind, start: s, end: e, companies: docs });
  }
}

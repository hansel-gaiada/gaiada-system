// TR-07 — `POST /api/:tenantId/reports/facts/recompute` (the admin/ops fact-fabric rebuild).
// TR-13 — `GET .../document`, `GET .../overview`, `GET .../metrics` (the live read surface, §6.2).
//
// The recompute endpoint is the ONE way the fact fabric is (re)built. §10 rules that n8n
// orchestrates and platform-nest gains NO scheduler, so the nightly flow is an n8n schedule
// calling this endpoint — which also means a human backfill and the nightly run take the exact
// same code path (fact-job.ts's `recomputeFactWindow`), and there is no second, differently-
// behaving implementation of "compute the facts".
//
// The three TR-13 read endpoints are thin HTTP shells: range/grain validation lives here (private
// `resolveGrain`/`resolveRange` helpers), everything else — the KPI axis, series/distributions/
// tables, header warnings, the additivity guarantee — is document-builder.ts's job. Sealed-period
// storage (TR-14/TR-15) does not exist yet, so every read is live-computed; `periods`/`export` are
// deliberately absent here (separate tickets).
//
// Route shape follows §6.2's table verbatim (`/api/:t/reports/…`, NOT `/api/:t/modules/reports/…`)
// so the endpoint set the UI and the MCP tools were specced against stays byte-accurate.
//
// Three independent walls back every write/read, same as every module surface (HR design §2.4):
//   1. Cerbos — `report_admin` (recompute, §8's "facts recompute" row) / `report_document`
//      (document/overview/metrics, §8's per-grain read matrix — cerbos/policies/
//      resource_report_document.yaml, one action per grain: `read_person`/`read_project`/
//      `read_department`/`read_company`).
//   2. The tenant choke-point — every query inside document-builder.ts/fact-job.ts runs
//      `withTenants([oneTenant], …)`.
//   3. Module-sliced RLS — `{modules:['reports','pm','hr']}`; a handler that forgot it would read
//      and write ZERO report_* rows rather than leak (fail-closed).
// Plus the per-tenant enable gate (ModuleEnabledGuard) so the surface is 404-dark for a company
// that does not have `reports` (own `enabled_modules` OR an ACTIVE service assignment).
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { AuthGuard } from "../../auth/guards";
import { authorize, writeActivity } from "../../core/http";
import { storage } from "../../core/storage";
import type { Principal } from "../../rbac/principal";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { recomputeFactWindow } from "./fact-job";
import {
  MAX_CUSTOM_RANGE_DAYS,
  buildHeadlineKpis,
  buildReportDocument,
  computeReportRangeRows,
  resolveCalendarRange,
  resolveScopeNamesBulk,
  rowGrainShape,
} from "./document-builder";
import { inclusiveDayCount } from "./metrics";
import type { ReportDocument, ReportGrain, ReportPeriodKind } from "./report-document";
import { getCalendarPeriod, getPeriodById, listPeriods, pinCustomPeriod } from "./report-periods";
import { CUSTOM_SEAL_REJECT_MESSAGE, amendPeriod, fetchSealedDocument, sealPeriod } from "./report-seal";
import { EXPORT_FORMATS, exportContentType, exportFilename, exportStorageKey, parseExportStorageKey, renderExport, type ExportFormat } from "./report-export";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GRAINS = new Set(["person", "project", "department", "company"]);
const PERIOD_KINDS = new Set(["day", "week", "month", "custom"]);

// ─────────────────────────────── shared grain/range/authz/fetch helpers ───────────────────────
// Module-level (not class methods) so TR-18's export endpoints can call the EXACT SAME validation
// and authorization a document read uses (ticket's explicit instruction: "reuse them" / standing
// ruling 1: "an export must never widen access... reuse the existing Cerbos check rather than
// adding a looser one"). Previously these were private instance methods on ReportsController with
// no callers outside the class; behaviour is unchanged, only the binding (free function vs `this`
// method) — none of them ever referenced `this`.

/** §6.2's grain validation, shared by document/overview/metrics/export. */
function resolveGrain(raw?: string): ReportGrain {
  if (!raw || !GRAINS.has(raw)) {
    throw new BadRequestException({ message: "grain must be one of person, project, department, company", field: "grain" });
  }
  return raw as ReportGrain;
}

/** §6.2's range validation, shared by document/overview/export. `end` is REQUIRED when
 *  `periodKind=custom` and IGNORED (re-derived from `start`) otherwise. */
function resolveRange(periodKindRaw?: string, start?: string, end?: string): { periodKind: ReportPeriodKind; start: string; end: string } {
  if (!periodKindRaw || !PERIOD_KINDS.has(periodKindRaw)) {
    throw new BadRequestException({ message: "periodKind must be one of day, week, month, custom", field: "periodKind" });
  }
  const periodKind = periodKindRaw as ReportPeriodKind;
  if (!start || !DATE_RE.test(start)) {
    throw new BadRequestException({ message: "start must be a YYYY-MM-DD date", field: "start" });
  }
  if (periodKind !== "custom") {
    return { periodKind, ...resolveCalendarRange(periodKind, start) };
  }
  if (!end || !DATE_RE.test(end)) {
    throw new BadRequestException({ message: "end is required when periodKind=custom", field: "end" });
  }
  if (end < start) throw new BadRequestException({ message: "end must be on or after start", field: "end" });
  const days = inclusiveDayCount(start, end);
  if (days > MAX_CUSTOM_RANGE_DAYS) {
    // §0057 rule / §15 ruling ③: the shared http-error.filter.ts flattens every HttpException to
    // {error, field} — never widen that shared filter for this one endpoint (TR-07/TR-08 hit the
    // identical wall on the recompute/read 422s; this mirrors their resolution verbatim).
    throw new UnprocessableEntityException({ message: "range_too_large", field: "end" });
  }
  return { periodKind, start, end };
}

/** `grain=company` defaults `scopeRef` to the route tenant and rejects any other value; every
 *  other grain requires an explicit `scopeRef`. Shared by document/export. */
function resolveScopeRefForGrain(grain: ReportGrain, scopeRefRaw: string | undefined, tenantId: string): string {
  const scopeRef = grain === "company" ? scopeRefRaw || tenantId : scopeRefRaw;
  if (!scopeRef) throw new BadRequestException({ message: "scopeRef is required", field: "scopeRef" });
  if (grain === "company" && scopeRef !== tenantId) {
    throw new BadRequestException({ message: "company-grain scopeRef must equal the route tenantId", field: "scopeRef" });
  }
  return scopeRef;
}

/** THE authz check for a document read (§8's per-grain matrix) — the SAME check a `GET document`
 *  call makes. Standing ruling 1: an export must never widen access, so this is the ONE place the
 *  `report_document` Cerbos resource shape is built; `getDocument` and both export endpoints
 *  (create + status/download) all call this, never a parallel, looser check. */
async function authorizeReportDocumentRead(principal: Principal, tenantId: string, grain: ReportGrain, scopeRef: string): Promise<void> {
  await authorize(
    principal,
    {
      kind: "report_document",
      tenantId,
      module: "reports",
      id: scopeRef,
      ownerId: grain === "person" ? scopeRef : undefined,
      projectId: grain === "project" ? scopeRef : undefined,
      teamId: grain === "department" ? scopeRef : undefined,
    },
    `read_${grain}`,
  );
}

/** The document-read fetch (sealed-branch-else-live), factored out of `getDocument` so the export
 *  create endpoint fetches through the IDENTICAL path — an export built from a second,
 *  independently-written fetch could silently diverge on the sealed/live branch (e.g. always
 *  live-computing and mislabelling a genuinely sealed period as ad hoc). Caller must authorize
 *  first; this function does no authz of its own. */
async function fetchReportDocumentForRead(
  tenantId: string,
  grain: ReportGrain,
  scopeRef: string,
  periodKind: ReportPeriodKind,
  start: string,
  end: string,
  servedTenantId?: string,
  revision?: number,
): Promise<ReportDocument> {
  if (periodKind !== "custom" && !servedTenantId) {
    const period = await getCalendarPeriod(tenantId, periodKind, start);
    // Only a `sealed` period serves stored storage. `amended` is a deliberately DIFFERENT state
    // (flagged for re-confirmation, not yet re-sealed) — presenting its old, now-flagged revision
    // as `header.sealed:true` would claim an authority the record no longer has, so it degrades to
    // live compute exactly like `open` until the re-seal lands.
    if (period && period.status === "sealed") {
      const stored = await fetchSealedDocument(tenantId, period.id, grain, scopeRef, revision);
      if (stored) return stored;
      if (revision !== undefined) {
        throw new NotFoundException(`no stored document at revision ${revision} for this scope`);
      }
      // Sealed period exists but this exact scope had no in-scope data at seal time (e.g. a
      // person with zero facts in range) — degrade gracefully to live compute rather than 404 a
      // legitimately-empty scope. Company grain always has exactly one scope, so this only bites
      // person/project/department.
    }
  }
  return buildReportDocument({ tenantId, grain, scopeRef, periodKind, start, end, servedTenantId });
}

/** §6.2's range ceiling, restated for the recompute path: an unbounded user-chosen window is a
 *  trivial DoS on the fact scan, and this endpoint's scan is far heavier than a read's (it writes a
 *  slice per day). 400 days covers "a year plus a comparison tail", which is the real ceiling of a
 *  management pack — and of any legitimate backfill request. */
const MAX_WINDOW_DAYS = 400;

/** Inclusive day count between two 'YYYY-MM-DD' dates. */
function inclusiveDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.floor((b - a) / 86_400_000) + 1;
}

@Controller("api/:tenantId/reports")
@UseGuards(AuthGuard, ModuleEnabledGuard("reports"))
export class ReportsController {
  /** Idempotent backfill/recompute of `report_work_facts` over an inclusive [from, to] window.
   *
   *  Idempotent by construction, not by convention: each day is a DELETE+INSERT of the whole
   *  (tenant, fact_date) slice in one transaction (§4a invariant 5), so re-running any window any
   *  number of times converges to the same rows. Safe to retry after a partial failure, and safe
   *  for an n8n flow with at-least-once delivery to call twice. */
  @Post("facts/recompute")
  @HttpCode(200)
  async recomputeFacts(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { from?: string; to?: string },
  ) {
    const from = body?.from;
    const to = body?.to;
    if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
      throw new BadRequestException("from and to are required as YYYY-MM-DD dates");
    }
    if (to < from) throw new BadRequestException("to must be on or after from");
    const days = inclusiveDays(from, to);
    if (!Number.isFinite(days) || days < 1) throw new BadRequestException("from and to must be real calendar dates");
    if (days > MAX_WINDOW_DAYS) {
      // 422 with a machine-readable reason, never a silent truncation of the window — a caller who
      // asked for 3 years of backfill and got 400 days back with a 200 would trust numbers that
      // were never computed.
      //
      // DEVIATION from §6.2's literal `{error:"range_too_large", maxDays:400}` body, flagged in the
      // ticket report: the platform-wide HttpErrorFilter (src/http-error.filter.ts) reshapes EVERY
      // HttpException to `{error}` (+ an optional `field`) for Fastify-core contract parity, so a
      // third key cannot reach the wire without changing that shared contract. The machine-readable
      // code is preserved verbatim as `error`, and `field` names the offending input. TR-13/TR-16
      // hit the same wall on the read endpoints' 422 — one decision covers all of them.
      throw new UnprocessableEntityException({ message: "range_too_large", field: "to" });
    }

    await authorize(req.principal, { kind: "report_admin", tenantId }, "recompute");

    const result = await recomputeFactWindow(tenantId, from, to);

    // Audited: a recompute changes what every downstream report and appraisal input reads, so who
    // triggered it over which window is part of the record (and `jobRunId` traces every row it
    // wrote back to this call — §4a invariant 5).
    await writeActivity(tenantId, req.principal.userId, "recomputed", "report_work_facts", result.jobRunId, {
      from,
      to,
      days: result.days,
      factRows: result.factRows,
    });

    return {
      from: result.from,
      to: result.to,
      days: result.days,
      factRows: result.factRows,
      autoMissedCheckins: result.autoMissed,
      driftFindings: result.driftFindings,
      jobRunId: result.jobRunId,
    };
  }

  // ---------------- TR-13: document/overview/metrics (§6.2, live path) ----------------

  /** THE read (§6.2). TR-15 landed sealed-period storage: a `sealed` calendar period (never
   *  `custom` — those are always live, §0057 rule 2) serves the STORED `report_documents` row
   *  instead of recomputing, at the latest revision unless `?revision=` pins one. An `amended`
   *  period (flagged for re-confirmation, not yet re-sealed) and an `open` one both fall through
   *  to live compute unchanged. Exactly the branch document-builder.ts's own header predicted —
   *  inserted BEFORE the live path, which is unchanged below as the "else". A `servedTenant`
   *  slice is never sealed (TR-15's documented scoping decision ②) so it always falls through to
   *  live compute regardless of seal state. */
  @Get("document")
  async getDocument(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("grain") grainRaw?: string,
    @Query("scopeRef") scopeRefRaw?: string,
    @Query("periodKind") periodKindRaw?: string,
    @Query("start") start?: string,
    @Query("end") end?: string,
    @Query("servedTenant") servedTenantId?: string,
    @Query("revision") revisionRaw?: string,
  ) {
    const grain = resolveGrain(grainRaw);
    const { periodKind, start: s, end: e } = resolveRange(periodKindRaw, start, end);
    const scopeRef = resolveScopeRefForGrain(grain, scopeRefRaw, tenantId);
    if (servedTenantId && grain !== "department") {
      throw new BadRequestException({ message: "servedTenant is only valid for grain=department", field: "servedTenant" });
    }
    let revision: number | undefined;
    if (revisionRaw !== undefined) {
      revision = Number(revisionRaw);
      if (!Number.isInteger(revision) || revision < 0) {
        throw new BadRequestException({ message: "revision must be a non-negative integer", field: "revision" });
      }
    }

    await authorizeReportDocumentRead(req.principal, tenantId, grain, scopeRef);

    return fetchReportDocumentForRead(tenantId, grain, scopeRef, periodKind, s, e, servedTenantId, revision);
  }

  /** List of scopes + headline KPIs for the grain (console landing, §6.2). No single `scopeRef` —
   *  a plain self/member principal is correctly denied by Cerbos (see resource_report_document.yaml:
   *  `owns`/project-membership conditions need a specific scope, which this call never sets). */
  @Get("overview")
  async getOverview(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("grain") grainRaw?: string,
    @Query("periodKind") periodKindRaw?: string,
    @Query("start") start?: string,
    @Query("end") end?: string,
  ) {
    const grain = resolveGrain(grainRaw);
    const { periodKind, start: s, end: e } = resolveRange(periodKindRaw, start, end);

    await authorize(req.principal, { kind: "report_document", tenantId, module: "reports" }, `read_${grain}`);

    if (grain === "company") {
      const doc = await buildReportDocument({ tenantId, grain, scopeRef: tenantId, periodKind, start: s, end: e });
      return { periodKind, start: s, end: e, scopes: [{ scopeRef: tenantId, scopeName: doc.header.scopeName, kpis: doc.kpis.slice(0, 3) }] };
    }

    const rows = await computeReportRangeRows(tenantId, s, e);
    const scopeRefs = [
      ...new Set(
        rows
          .filter((r) => rowGrainShape(r.dimensions ?? {}) === grain)
          .map((r) => {
            const dims = r.dimensions ?? {};
            return String(grain === "person" ? dims.userId : grain === "project" ? dims.projectId : dims.unit);
          }),
      ),
    ];
    const names = await resolveScopeNamesBulk(tenantId, grain as Exclude<ReportGrain, "company">, scopeRefs);
    return {
      periodKind,
      start: s,
      end: e,
      scopes: scopeRefs.map((scopeRef) => ({
        scopeRef,
        scopeName: names.get(scopeRef) ?? scopeRef,
        kpis: buildHeadlineKpis(grain, scopeRef, rows),
      })),
    };
  }

  /** Raw governed-metric series (power users/MCP, §6.2). Calendar periods and custom ranges both
   *  read `report_work_facts`-derived rollup rows LIVE here (never `rollup_metrics` — the same
   *  §0057 rule 3 this whole ticket follows); TR-14/TR-15 landing sealed storage later does not
   *  change this endpoint's contract, only how far back a request can be answered from a cache. */
  @Get("metrics")
  async getMetrics(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("metricKey") metricKey?: string,
    @Query("grain") grainRaw?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    if (!from || !DATE_RE.test(from)) throw new BadRequestException({ message: "from must be a YYYY-MM-DD date", field: "from" });
    if (!to || !DATE_RE.test(to)) throw new BadRequestException({ message: "to must be a YYYY-MM-DD date", field: "to" });
    if (to < from) throw new BadRequestException({ message: "to must be on or after from", field: "to" });
    if (inclusiveDayCount(from, to) > MAX_CUSTOM_RANGE_DAYS) {
      throw new UnprocessableEntityException({ message: "range_too_large", field: "to" });
    }
    const grain = grainRaw ? resolveGrain(grainRaw) : undefined;

    await authorize(req.principal, { kind: "report_document", tenantId, module: "reports" }, `read_${grain ?? "company"}`);

    const rows = await computeReportRangeRows(tenantId, from, to);
    const filtered = rows.filter((r) => (!metricKey || r.metricKey === metricKey) && (!grain || rowGrainShape(r.dimensions ?? {}) === grain));
    return filtered.map((r) => ({ metricKey: r.metricKey, numerator: r.numerator, denominator: r.denominator ?? null, dimensions: r.dimensions ?? {} }));
  }

  // ---------------- TR-15: periods (list/get/pin/seal/amend), §6.2 + §0057 ----------------

  /** `GET /reports/periods?kind&from&to` (§6.2). For a calendar `kind`, auto-vivifies every
   *  candidate period in range so its `id` is stable and ready for `/seal` (see
   *  report-periods.ts's header for why a GET is the provisioning point — no separate
   *  `POST /periods` create endpoint exists in §6.2's surface). `kind=custom` or an omitted kind
   *  lists whatever rows already exist (custom rows are only ever written by `/periods/pin`). */
  @Get("periods")
  async getPeriods(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("kind") kind?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    if (!from || !DATE_RE.test(from)) throw new BadRequestException({ message: "from must be a YYYY-MM-DD date", field: "from" });
    if (!to || !DATE_RE.test(to)) throw new BadRequestException({ message: "to must be a YYYY-MM-DD date", field: "to" });
    if (to < from) throw new BadRequestException({ message: "to must be on or after from", field: "to" });
    if (kind && !PERIOD_KINDS.has(kind)) {
      throw new BadRequestException({ message: "kind must be one of day, week, month, custom", field: "kind" });
    }
    if (inclusiveDayCount(from, to) > MAX_CUSTOM_RANGE_DAYS) {
      throw new UnprocessableEntityException({ message: "range_too_large", field: "to" });
    }

    await authorize(req.principal, { kind: "report_period", tenantId, module: "reports" }, "view");

    const periods = await listPeriods(tenantId, kind, from, to);
    return { periods };
  }

  /** `GET /reports/periods/:id` (§6.2): one period's seal state + revision. No auto-vivify — a
   *  plain lookup of whatever `/periods` or `/periods/pin` already created. */
  @Get("periods/:id")
  async getPeriod(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "report_period", tenantId, id, module: "reports" }, "view");
    const period = await getPeriodById(tenantId, id);
    if (!period) throw new NotFoundException("period not found");
    return period;
  }

  /** `POST /reports/periods/pin {start, end, label}` (§0057 rule 4). Creates (or, on the exact
   *  same range, idempotently re-labels) a `period_kind='custom'` row — snapshottable/exportable,
   *  but per rule 2 still barred from `/seal` and from appraisal generation. */
  @Post("periods/pin")
  @HttpCode(200)
  async pinPeriod(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: { start?: string; end?: string; label?: string }) {
    const start = body?.start;
    const end = body?.end;
    const label = body?.label?.trim();
    if (!start || !DATE_RE.test(start)) throw new BadRequestException({ message: "start must be a YYYY-MM-DD date", field: "start" });
    if (!end || !DATE_RE.test(end)) throw new BadRequestException({ message: "end must be a YYYY-MM-DD date", field: "end" });
    if (end < start) throw new BadRequestException({ message: "end must be on or after start", field: "end" });
    if (inclusiveDayCount(start, end) > MAX_CUSTOM_RANGE_DAYS) {
      throw new UnprocessableEntityException({ message: "range_too_large", field: "end" });
    }
    if (!label) throw new BadRequestException({ message: "label is required to pin a custom range", field: "label" });

    await authorize(req.principal, { kind: "report_period", tenantId, module: "reports" }, "pin");

    const period = await pinCustomPeriod(tenantId, start, end, label);
    await writeActivity(tenantId, req.principal.userId, "pinned", "report_period", period.id, { start, end, label });
    return period;
  }

  /** `POST /reports/periods/:id/seal` (§0057's Seal semantics). Idempotent-once-open; 409 on a
   *  period already sealed; 422 (never a silent skip, §0057 rule 2) on `period_kind='custom'`. */
  @Post("periods/:id/seal")
  @HttpCode(200)
  async sealPeriodRoute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "report_period", tenantId, id, module: "reports" }, "seal");

    const result = await sealPeriod(tenantId, id, req.principal.userId);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("period not found");
      if (result.reason === "custom_kind") throw new UnprocessableEntityException({ message: CUSTOM_SEAL_REJECT_MESSAGE, field: "periodKind" });
      throw new ConflictException("this period is already sealed");
    }

    await writeActivity(tenantId, req.principal.userId, "sealed", "report_period", id, {
      revision: result.period.revision,
      documentCount: result.documentCount,
    });
    return result.period;
  }

  /** `POST /reports/periods/:id/amend {reason}` (§0057's Seal semantics). Flags a sealed period
   *  `amended` + audits + notifies exec/leads; the actual re-seal (revision+1, keeping the old
   *  revision) happens through a subsequent call to `/seal` on the same id. */
  @Post("periods/:id/amend")
  @HttpCode(200)
  async amendPeriodRoute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: { reason?: string }) {
    await authorize(req.principal, { kind: "report_period", tenantId, id, module: "reports" }, "amend");

    const result = await amendPeriod(tenantId, id, req.principal.userId, body?.reason);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("period not found");
      if (result.reason === "reason_required") throw new BadRequestException({ message: "reason is required to amend a period", field: "reason" });
      throw new ConflictException("only a sealed period can be amended");
    }
    return result.period;
  }

  // ---------------- TR-18: XLSX/CSV export service (§6.3) ----------------
  //
  // Storage: reuses the EXISTING files plumbing (`storage()` + the `files` table,
  // core/storage.ts + core/files.controller.ts's own pattern) rather than a second path. The
  // `files` table has no free-form metadata column, so the (grain, scopeRef) an export job was
  // built for is recorded in its `storage_key` (see report-export.ts's `exportStorageKey`/
  // `parseExportStorageKey`) and re-derived on every read — never trusted from an unverified
  // client param — so `GET .../exports/:jobId` and its `/download` can re-run the IDENTICAL
  // `authorizeReportDocumentRead` check the export was created under (standing ruling 1).
  //
  // Job model: generation is SYNCHRONOUS (build + render + persist all happen inside the POST
  // handler) because xlsx/csv assembly is well under the 5s bar even at 10k rows, and there is no
  // existing async-job table in this schema to poll against (migrations are out of scope for this
  // ticket). `status` is therefore always `"completed"` today — the field exists, and is typed as
  // a union, specifically so TR-19+'s PDF path (which DOES need an async sidecar round-trip, §6.3)
  // can add `"queued"`/`"processing"`/`"failed"` later without reshaping this response.

  @Post("export")
  @HttpCode(200)
  async createExport(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { grain?: string; scopeRef?: string; periodKind?: string; start?: string; end?: string; format?: string },
  ) {
    const grain = resolveGrain(body?.grain);
    const { periodKind, start: s, end: e } = resolveRange(body?.periodKind, body?.start, body?.end);
    const scopeRef = resolveScopeRefForGrain(grain, body?.scopeRef, tenantId);
    const format = body?.format;
    if (!format || !EXPORT_FORMATS.has(format)) {
      // "pdf" is a real, named format in §6.3 but ships via the report-renderer sidecar (TR-19-21)
      // — rejecting it here (rather than silently downgrading to xlsx) keeps the contract honest
      // about what this ticket actually delivers.
      throw new BadRequestException({ message: "format must be one of xlsx, csv (pdf is a separate sidecar path, not yet available)", field: "format" });
    }

    // Standing ruling 1: THE SAME check `GET document` makes — an export must never widen access.
    await authorizeReportDocumentRead(req.principal, tenantId, grain, scopeRef);

    const doc = await fetchReportDocumentForRead(tenantId, grain, scopeRef, periodKind, s, e);

    // A sealed document's banner needs `report_periods.seal_hash`, which is not part of
    // `ReportDocument` itself (report-seal.ts's tamper-evidence hash lives on the period row).
    let sealHash: string | undefined;
    if (doc.header.sealed && doc.header.periodId) {
      const period = await getPeriodById(tenantId, doc.header.periodId);
      sealHash = period?.sealHash ?? undefined;
    }

    const jobId = newId();
    const bytes = await renderExport(doc, format as ExportFormat, { sealHash });
    const filename = exportFilename(doc, format as ExportFormat);
    const contentType = exportContentType(format as ExportFormat);
    const storageKey = exportStorageKey(tenantId, grain, scopeRef, jobId);

    await storage().put(storageKey, bytes);
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
         VALUES ($1, $2, $3, 'report_export', $1, $4, $5, $6, $7, false, $8)`,
        [jobId, tenantId, req.principal.userId, filename, contentType, bytes.byteLength, storageKey, config.originSite],
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "exported", "report_document", jobId, {
      grain,
      scopeRef,
      periodKind,
      start: s,
      end: e,
      format,
      sealed: doc.header.sealed,
    });

    return { jobId };
  }

  /** Resolves an export job row + re-derives (grain, scopeRef) from its `storage_key` — shared by
   *  the status read and the byte download below, so both re-authorize identically. */
  private async loadExportJob(tenantId: string, jobId: string) {
    const { rows } = await withTenants([tenantId], (c) =>
      c.query<{ filename: string; content_type: string; byte_size: number; storage_key: string; created_at: string }>(
        `SELECT filename, content_type, byte_size, storage_key, created_at::text AS created_at
           FROM files WHERE id = $1 AND tenant_id = $2 AND target_entity_type = 'report_export' AND deleted_at IS NULL`,
        [jobId, tenantId],
      ),
    );
    const row = rows[0];
    if (!row) return null;
    const parsed = parseExportStorageKey(row.storage_key);
    if (!parsed || parsed.tenantId !== tenantId) return null;
    return { ...row, grain: parsed.grain, scopeRef: parsed.scopeRef };
  }

  @Get("exports/:jobId")
  async getExportStatus(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("jobId") jobId: string) {
    const job = await this.loadExportJob(tenantId, jobId);
    if (!job) throw new NotFoundException("export job not found");
    await authorizeReportDocumentRead(req.principal, tenantId, job.grain as ReportGrain, job.scopeRef);

    return {
      jobId,
      status: "completed" as const,
      filename: job.filename,
      contentType: job.content_type,
      byteSize: Number(job.byte_size), // bigint column — pg returns it as a string
      createdAt: job.created_at,
      downloadUrl: `/api/${tenantId}/reports/exports/${jobId}/download`,
    };
  }

  @Get("exports/:jobId/download")
  async downloadExport(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Param("tenantId") tenantId: string, @Param("jobId") jobId: string) {
    const job = await this.loadExportJob(tenantId, jobId);
    if (!job) throw new NotFoundException("export job not found");
    await authorizeReportDocumentRead(req.principal, tenantId, job.grain as ReportGrain, job.scopeRef);

    const bytes = await storage().get(job.storage_key);
    // Same header-injection/stored-XSS guards as core/files.controller.ts's `content()` route.
    await reply
      .header("content-disposition", dispositionHeader(job.filename))
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .type(job.content_type || "application/octet-stream")
      .send(bytes);
  }
}

/** RFC 5987-safe `Content-Disposition` — the same header-injection guard
 *  `core/files.controller.ts`'s `dispositionHeader` uses, duplicated here (a 2-line pure
 *  function) rather than importing across an unrelated controller module. */
function dispositionHeader(filename: string): string {
  const ascii = filename.replace(/[\r\n"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

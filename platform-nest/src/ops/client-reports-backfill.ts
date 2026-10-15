// PV7-04a (docs/FRONTEND-BFF-CONTRACT.md §55.2) — `client-reports:backfill`: give the social and search reports delivered
// BEFORE this ticket their client report, so a client sees every report already delivered to them, not only new ones.
//
// DRY RUN BY DEFAULT. Without `--apply` it only LISTS what it would publish (and what it would skip, and why). With `--apply`
// it creates each one exactly as a delivery does today (core/client-reports.ts: its own role file with the same bytes under
// its own storage key, the deliverable link, client-wide when the engagement has no project), stamped with the original
// delivery time, WITHOUT a notice or an SSE event: these are history, not news. Idempotent: a report that already has a
// client report (any status, a withdrawn one included) is never touched, so re-running changes nothing.
//
// It ships inside the platform image (dist/ops/client-reports-backfill.js), like seal-key, because the hosts have no Node:
//
//   docker compose ... run --rm --no-deps platform node dist/ops/client-reports-backfill.js [--company <uuid>]          # list
//   docker compose ... run --rm --no-deps platform node dist/ops/client-reports-backfill.js [--company <uuid>] --apply  # create
//
// Runs only on the owner's go (plan PV7-04, "Already delivered"). Every read and write is inside withTenants([company]) with
// the social and search module scopes declared: without them the module tables read ZERO rows and the run would report
// "nothing to do" (platform-nest/CLAUDE.md, the three walls).
import { closePool, withGlobal, withTenants } from "../db";
import { storage } from "../core/storage";
import {
  deliveredReportTitle, discardStoredReportFile, publishDeliveredReport, storeClientReportFile,
} from "../core/client-reports";
import { periodDateRange as socialPeriodDateRange } from "../modules/social/reports";
import { periodDateRange as searchPeriodDateRange } from "../modules/search/reports";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODULES = { modules: ["social", "search"] };

export interface BackfillCandidate {
  source: "social_report" | "search_report";
  sourceId: string;
  clientId: string;
  clientName: string;
  projectId: string | null;
  deliverableId: string | null;
  title: string;
  periodStart: string;
  periodEnd: string;
  deliveredAt: string | null;
  /** The module's own file. */
  fileId: string | null;
  storageKey: string | null;
  filename: string | null;
  contentType: string | null;
  /** Who it is published by: the module file's uploader (the deliverer), else the report's approver. */
  publishedBy: string | null;
  /** Set when the report cannot be published; the reason is printed and nothing is written for it. */
  skip: string | null;
}

interface Row {
  id: string; kind: string; period: string | null; created_at: Date; delivered_at: string | null; deliverable_id: string | null;
  approved_by: string | null; client_id: string; client_name: string; client_is_internal: boolean; project_id: string | null;
  file_id: string | null; storage_key: string | null; filename: string | null; content_type: string | null; uploader_id: string | null;
}

function toCandidate(source: "social_report" | "search_report", r: Row): BackfillCandidate {
  const range = source === "social_report"
    ? socialPeriodDateRange(r.period, new Date(r.created_at))
    : searchPeriodDateRange(r.period ?? "", new Date(r.created_at));
  const publishedBy = r.uploader_id ?? r.approved_by;
  const skip = r.client_is_internal
    ? "internal client (never delivered to a client)"
    : !r.file_id || !r.storage_key
      ? "the delivered report has no stored file"
      : !publishedBy
        ? "no deliverer or approver on record to publish it under"
        : null;
  return {
    source, sourceId: r.id, clientId: r.client_id, clientName: r.client_name, projectId: r.project_id,
    deliverableId: r.deliverable_id, title: deliveredReportTitle(source, r.kind, r.period, range.start, range.end),
    periodStart: range.start, periodEnd: range.end, deliveredAt: r.delivered_at, fileId: r.file_id, storageKey: r.storage_key,
    filename: r.filename, contentType: r.content_type, publishedBy, skip,
  };
}

/** Delivered social and search reports of one company that have no client report yet (in any status). */
export async function findUnpublishedDeliveredReports(tenantId: string): Promise<BackfillCandidate[]> {
  return withTenants([tenantId], async (c) => {
    const select = (table: "social_reports" | "search_reports", engagements: "social_engagements" | "search_engagements", source: string) =>
      c.query<Row>(
        `SELECT sr.id, sr.kind, sr.period, sr.created_at, sr.delivered_at, sr.deliverable_id, sr.approved_by,
                se.client_id, cl.name AS client_name, cl.is_internal AS client_is_internal, se.project_id,
                f.id AS file_id, f.storage_key, f.filename, f.content_type, f.uploader_id
           FROM ${table} sr
           JOIN ${engagements} se ON se.id = sr.engagement_id
           JOIN clients cl ON cl.id = se.client_id
           LEFT JOIN files f ON f.id = sr.file_id AND f.deleted_at IS NULL
          WHERE sr.tenant_id = $1 AND sr.status = 'delivered' AND sr.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM client_reports cr
                             WHERE cr.tenant_id = sr.tenant_id AND cr.source = $2 AND cr.source_id = sr.id)
          ORDER BY sr.delivered_at NULLS LAST, sr.id`,
        [tenantId, source],
      );
    const social = await select("social_reports", "social_engagements", "social_report");
    const search = await select("search_reports", "search_engagements", "search_report");
    return [
      ...social.rows.map((r) => toCandidate("social_report", r)),
      ...search.rows.map((r) => toCandidate("search_report", r)),
    ];
  }, MODULES);
}

export interface BackfillResult {
  candidates: BackfillCandidate[];
  created: string[];
  skipped: Array<{ sourceId: string; reason: string }>;
}

/** List (and with `apply`, create) the missing client reports of one company. */
export async function backfillClientReports(tenantId: string, opts: { apply: boolean }): Promise<BackfillResult> {
  const candidates = await findUnpublishedDeliveredReports(tenantId);
  const out: BackfillResult = { candidates, created: [], skipped: [] };
  for (const cand of candidates) {
    if (cand.skip) {
      out.skipped.push({ sourceId: cand.sourceId, reason: cand.skip });
      continue;
    }
    if (!opts.apply) continue;
    const bytes = await storage().get(cand.storageKey as string);
    const stored = await storeClientReportFile(tenantId, bytes, cand.filename as string, cand.contentType ?? "application/octet-stream");
    try {
      const r = await withTenants([tenantId], (c) =>
        publishDeliveredReport(c, {
          tenantId, source: cand.source, sourceId: cand.sourceId, clientId: cand.clientId, projectId: cand.projectId,
          deliverableId: cand.deliverableId, title: cand.title, periodStart: cand.periodStart, periodEnd: cand.periodEnd,
          file: stored, publishedBy: cand.publishedBy as string, publishedAt: cand.deliveredAt, announce: false,
        }), MODULES);
      if (r.created) out.created.push(r.id);
      else {
        await discardStoredReportFile(stored);
        out.skipped.push({ sourceId: cand.sourceId, reason: "a client report appeared meanwhile" });
      }
    } catch (err) {
      await discardStoredReportFile(stored);
      throw err;
    }
  }
  return out;
}

function argMap(argv: string[]): { apply: boolean; company: string | null } {
  let apply = false;
  let company: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--dry-run") apply = false;
    else if (argv[i] === "--company") company = (argv[++i] ?? "").toLowerCase();
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (company !== null && !UUID_RE.test(company)) throw new Error("--company must be a company uuid");
  return { apply, company };
}

async function main(): Promise<number> {
  const { apply, company } = argMap(process.argv.slice(2));
  const companies = company
    ? [{ id: company, name: company }]
    : (await withGlobal((c) => c.query<{ id: string; name: string }>(`SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY name`))).rows;
  console.log(apply ? "client-reports backfill: APPLY" : "client-reports backfill: DRY RUN (nothing is written; pass --apply to create)");
  let total = 0;
  for (const co of companies) {
    const res = await backfillClientReports(co.id, { apply });
    if (!res.candidates.length) continue;
    console.log(`\n${co.name} (${co.id}): ${res.candidates.length} delivered report(s) without a client report`);
    for (const cand of res.candidates) {
      const reach = cand.projectId ? `project ${cand.projectId}` : "client-wide";
      const state = cand.skip ? `SKIP: ${cand.skip}` : apply ? "created" : "would create";
      console.log(`  ${cand.source} ${cand.sourceId}  ${cand.clientName}  ${reach}  ${cand.periodStart}..${cand.periodEnd}  "${cand.title}"  ${state}`);
    }
    total += apply ? res.created.length : res.candidates.filter((x) => !x.skip).length;
  }
  console.log(`\n${apply ? "created" : "would create"}: ${total}`);
  return 0;
}

if (require.main === module) {
  main()
    .then(async (code) => { await closePool(); process.exit(code); })
    .catch(async (e) => {
      console.error(`client-reports-backfill: ${(e as Error).message}`);
      await closePool().catch(() => undefined);
      process.exit(2);
    });
}

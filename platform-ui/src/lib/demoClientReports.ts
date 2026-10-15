import "server-only";
// DEMO_MODE fixtures for PV7-04b — client reports (docs/FRONTEND-BFF-CONTRACT.md §55).
//
// ONE stateful store of published, draft and withdrawn reports, read and written by BOTH sides so they can never
// disagree in the same demo session: publishing a draft on the staff Reports tab puts it in front of the portal contacts in
// reach, and withdrawing one takes it away from them.
//   staff   GET  /api/:t/clients/:clientId/reports        POST /api/:t/client-reports/:id/publish
//           POST /api/:t/client-reports/:id/withdraw {reason}
//   portal  GET  /api/:t/portal/reports                   POST /api/:t/portal/reports/:id/read
// plus `demoPortalNewReports` / `demoPortalReportIdForDeliverable` for the portal Overview and Deliverables payloads.
//
// It models the REAL controllers' refusals (client-reports.controller.ts, portal-reports.controller.ts): authorize FIRST and
// only then validate the body; a publish needs a draft with a file (409 `not_a_draft`, 409 `report_has_no_file`); a withdraw
// needs a reason (400 `reason_required`, 400 `reason_too_long`) and a published report (409 `not_published`); an unknown
// report is a 404; the portal read marker is 404 for a report that is not published or not in reach.
//
// Portal reach (BFF §55.4, the strict shape), per identity, following `PORTAL_SCOPE` in demoClientCentre.ts:
//   demo-client  Northwind client-wide (every Northwind report, client-wide or on a project) AND Demo Harbour Hotel through
//                ONE project only (`wide: false`): it sees that project's reports and NOT Harbour's client-wide one.
//   every other portal identity  Northwind client-wide only.
// What a portal payload never carries (status, source id, who published or withdrew it, the reason) is not here either.
import type { DemoResult } from "./demoFixtures";
import { isDemoPortalClient } from "./demoPortalClients";

type Status = "draft" | "published" | "withdrawn";
type Source = "social_report" | "search_report" | "account_summary";
interface DemoReportFile { id: string; filename: string; contentType: string; byteSize: number }
export interface DemoReport {
  id: string;
  clientId: string;
  clientName: string;
  /** The staff project id (the staff fixtures' own id space) and the portal project id (the portal fixtures'). */
  projectId: string | null;
  portalProjectId: string | null;
  projectName: string | null;
  source: Source;
  sourceId: string | null;
  deliverableId: string | null;
  title: string;
  periodStart: string;
  periodEnd: string;
  status: Status;
  file: DemoReportFile | null;
  createdAt: string;
  publishedAt: string | null;
  publishedByName: string | null;
  withdrawnAt: string | null;
  withdrawnByName: string | null;
  withdrawnReason: string | null;
}
interface Store { reports: DemoReport[]; reads: Record<string, Record<string, string>> }

const daysAgo = (n: number): string => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString(); };

const PDF = "application/pdf";
const MD = "text/markdown";

const seed = (): Store => ({
  reports: [
    // Client-wide, published, social (PDF). Nobody has opened it: New for every contact.
    {
      id: "rep-1", clientId: "cl-1", clientName: "Northwind Traders", projectId: null, portalProjectId: null, projectName: null,
      source: "social_report", sourceId: "sr-demo-1", deliverableId: null, title: "Social media performance, September 2026",
      periodStart: "2026-09-01", periodEnd: "2026-09-30", status: "published",
      file: { id: "file-report-1", filename: "social-report-2026-09.pdf", contentType: PDF, byteSize: 412_880 },
      createdAt: daysAgo(3), publishedAt: daysAgo(3), publishedByName: "Made Prabowo", withdrawnAt: null, withdrawnByName: null, withdrawnReason: null,
    },
    // On a project, published, search (Markdown). `demo-client` has already opened it. Linked to a portal deliverable.
    {
      id: "rep-2", clientId: "cl-1", clientName: "Northwind Traders", projectId: "p-web-1", portalProjectId: "proj-nw-site", projectName: "Website relaunch",
      source: "search_report", sourceId: "sx-demo-1", deliverableId: "del-2", title: "Search performance, August 2026",
      periodStart: "2026-08-01", periodEnd: "2026-08-31", status: "published",
      file: { id: "file-report-2", filename: "search-report-2026-08.md", contentType: MD, byteSize: 18_204 },
      createdAt: daysAgo(12), publishedAt: daysAgo(12), publishedByName: "Made Prabowo", withdrawnAt: null, withdrawnByName: null, withdrawnReason: null,
    },
    // A draft with its file: the one the staff e2e publishes.
    {
      id: "rep-3", clientId: "cl-1", clientName: "Northwind Traders", projectId: null, portalProjectId: null, projectName: null,
      source: "account_summary", sourceId: null, deliverableId: null, title: "Account summary, September 2026",
      periodStart: "2026-09-01", periodEnd: "2026-09-30", status: "draft",
      file: { id: "file-report-3", filename: "account-summary-2026-09.pdf", contentType: PDF, byteSize: 96_330 },
      createdAt: daysAgo(2), publishedAt: null, publishedByName: null, withdrawnAt: null, withdrawnByName: null, withdrawnReason: null,
    },
    // A draft with NO file: Publish is refused with `report_has_no_file`.
    {
      id: "rep-7", clientId: "cl-1", clientName: "Northwind Traders", projectId: null, portalProjectId: null, projectName: null,
      source: "account_summary", sourceId: null, deliverableId: null, title: "Account summary, October 2026 (file pending)",
      periodStart: "2026-10-01", periodEnd: "2026-10-31", status: "draft", file: null,
      createdAt: daysAgo(1), publishedAt: null, publishedByName: null, withdrawnAt: null, withdrawnByName: null, withdrawnReason: null,
    },
    // Withdrawn: the client no longer sees it; staff keep it with the reason.
    {
      id: "rep-4", clientId: "cl-1", clientName: "Northwind Traders", projectId: null, portalProjectId: null, projectName: null,
      source: "social_report", sourceId: "sr-demo-0", deliverableId: null, title: "Social media performance, August 2026",
      periodStart: "2026-08-01", periodEnd: "2026-08-31", status: "withdrawn",
      file: { id: "file-report-4", filename: "social-report-2026-08.pdf", contentType: PDF, byteSize: 398_112 },
      createdAt: daysAgo(40), publishedAt: daysAgo(40), publishedByName: "Made Prabowo",
      withdrawnAt: daysAgo(20), withdrawnByName: "Made Prabowo", withdrawnReason: "The ad spend figures were wrong; a corrected report will follow.",
    },
    // Demo Harbour Hotel (portal only: the staff fixtures have no such client). One on the project the project-scoped
    // contact reaches, one client-wide that this contact must NOT see.
    {
      id: "rep-5", clientId: "cl-harbour", clientName: "Demo Harbour Hotel", projectId: "p-hb-spa", portalProjectId: "proj-hb-spa", projectName: "Spa booking page",
      source: "search_report", sourceId: "sx-demo-2", deliverableId: null, title: "Search performance, September 2026 (Spa booking page)",
      periodStart: "2026-09-01", periodEnd: "2026-09-30", status: "published",
      file: { id: "file-report-5", filename: "search-report-2026-09-spa.md", contentType: MD, byteSize: 15_770 },
      createdAt: daysAgo(5), publishedAt: daysAgo(5), publishedByName: "Made Prabowo", withdrawnAt: null, withdrawnByName: null, withdrawnReason: null,
    },
    {
      id: "rep-6", clientId: "cl-harbour", clientName: "Demo Harbour Hotel", projectId: null, portalProjectId: null, projectName: null,
      source: "social_report", sourceId: "sr-demo-2", deliverableId: null, title: "Social media performance, September 2026 (Harbour, whole account)",
      periodStart: "2026-09-01", periodEnd: "2026-09-30", status: "published",
      file: { id: "file-report-6", filename: "social-report-2026-09-harbour.pdf", contentType: PDF, byteSize: 377_490 },
      createdAt: daysAgo(5), publishedAt: daysAgo(5), publishedByName: "Made Prabowo", withdrawnAt: null, withdrawnByName: null, withdrawnReason: null,
    },
  ],
  reads: { "rep-2": { "demo-client": daysAgo(10) }, "rep-5": {} },
});

const G = globalThis as unknown as { __demoClientReports?: Store };
const store = (): Store => (G.__demoClientReports ??= seed());
/** For tests: back to the seed. */
export function resetDemoClientReports(): void { G.__demoClientReports = undefined; }

const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string): DemoResult => ({ status, json: { error } });
const deny = (action: string): DemoResult => err(403, `not authorized: cerbos denied ${action} on client_report`);

// Same people as the billing fixtures (lib/demoBilling.ts): demo-hansel and demo-owner may do everything; dept-manager reads.
const READ = new Set(["demo-hansel", "demo-owner", "dept-manager"]);
const WRITE = new Set(["demo-hansel", "demo-owner"]);
const MAX_REASON = 2000;
const ACTOR_NAME: Record<string, string> = { "demo-hansel": "Hansel Gaiada", "demo-owner": "Demo Owner" };

// ── portal reach ──────────────────────────────────────────────────────────────────────────────────
interface Reach { clientId: string; wide: boolean; projects: string[] }
function reachOf(userId: string): Reach[] {
  if (!isDemoPortalClient(userId)) return [];
  return userId === "demo-client"
    ? [{ clientId: "cl-1", wide: true, projects: [] }, { clientId: "cl-harbour", wide: false, projects: ["proj-hb-spa"] }]
    : [{ clientId: "cl-1", wide: true, projects: [] }];
}
/** `clientReportInPortalScope`: published, the client is the caller's, and (the project is theirs OR they are client-wide). */
function inReach(r: DemoReport, reach: Reach[]): boolean {
  if (r.status !== "published") return false;
  const c = reach.find((x) => x.clientId === r.clientId);
  if (!c) return false;
  return c.wide || (r.portalProjectId !== null && c.projects.includes(r.portalProjectId));
}

function portalView(r: DemoReport, userId: string) {
  return {
    id: r.id, title: r.title, source: r.source, periodStart: r.periodStart, periodEnd: r.periodEnd,
    clientId: r.clientId, clientName: r.clientName, projectId: r.portalProjectId, projectName: r.projectName,
    publishedAt: r.publishedAt as string, file: r.file as DemoReportFile, readAt: store().reads[r.id]?.[userId] ?? null,
  };
}

/** `newReports` on the portal Overview: published in the last 30 days, in reach, no read marker for this user. */
export function demoPortalNewReports(userId: string): number {
  const reach = reachOf(userId);
  const since = Date.now() - 30 * 86_400_000;
  const s = store();
  return s.reports.filter((r) => inReach(r, reach) && r.publishedAt && Date.parse(r.publishedAt) >= since && !s.reads[r.id]?.[userId]).length;
}

/** `reportId` on a portal deliverable row: the published, in-reach report that links it, else null. */
export function demoPortalReportIdForDeliverable(deliverableId: string, userId: string): string | null {
  const reach = reachOf(userId);
  return store().reports.find((r) => r.deliverableId === deliverableId && inReach(r, reach))?.id ?? null;
}

/** The portal's file route in demo mode has no bytes to stream (JSON-only dispatch): a report's file answers with a small,
 *  clearly labelled stand-in, so a link to it is never mistaken for a real report. Null when the file is not a report's. */
export function demoPortalReportFile(fileId: string, userId: string): DemoResult | null {
  const r = store().reports.find((x) => x.file?.id === fileId);
  if (!r) return null;
  if (!inReach(r, reachOf(userId))) return err(404, "not found");
  return ok({ demo: true, filename: r.file!.filename, contentType: r.file!.contentType, note: `DEMO MODE: placeholder for ${r.file!.filename}. No real file is stored in demo mode.` });
}

export function portalReportsDemo(method: string, seg: string, userId: string): DemoResult | null {
  const m = method.toUpperCase();
  const s = store();
  if (seg === "reports" && m === "GET") {
    const reach = reachOf(userId);
    const rows = s.reports.filter((r) => inReach(r, reach)).sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!));
    return ok(rows.map((r) => portalView(r, userId)));
  }
  const read = seg.match(/^reports\/([^/?]+)\/read$/);
  if (read && m === "POST") {
    const r = s.reports.find((x) => x.id === read[1]);
    if (!r || !inReach(r, reachOf(userId))) return err(404, "report not found");
    const marks = (s.reads[r.id] ??= {});
    marks[userId] ??= new Date().toISOString();   // the first read is kept
    return ok({ id: r.id, readAt: marks[userId] });
  }
  return null;
}

// ── staff ─────────────────────────────────────────────────────────────────────────────────────────
function staffView(r: DemoReport) {
  const { clientName: _c, portalProjectId: _p, ...rest } = r;
  void _c; void _p;
  return {
    ...rest,
    // A client-wide contact of this client sees a published report, on a project or not.
    clientVisible: r.status === "published",
    readCount: Object.keys(store().reads[r.id] ?? {}).length,
  };
}

export function clientReportsDemo(method: string, p: string, body: string | undefined, userId: string): DemoResult | null {
  const m = method.toUpperCase();
  const s = store();
  let hit: RegExpMatchArray | null;

  if ((hit = p.match(/^\/api\/[^/]+\/clients\/([^/]+)\/reports$/)) && m === "GET") {
    if (!READ.has(userId)) return deny("read");
    const rows = s.reports.filter((r) => r.clientId === hit![1]).sort((a, b) => Date.parse(b.publishedAt ?? b.createdAt) - Date.parse(a.publishedAt ?? a.createdAt));
    return ok({ reports: rows.map(staffView) });
  }

  if ((hit = p.match(/^\/api\/[^/]+\/client-reports\/([^/]+)\/(publish|withdraw)$/)) && m === "POST") {
    const [, id, verb] = hit;
    // Authorize FIRST (read, then the action), and only then look at the body.
    if (!READ.has(userId)) return deny("read");
    const r = s.reports.find((x) => x.id === id);
    if (!r) return err(404, "report not found");
    if (!WRITE.has(userId)) return deny(verb);
    const actor = ACTOR_NAME[userId] ?? "Demo staff";
    if (verb === "publish") {
      if (r.status !== "draft") return err(409, "not_a_draft");
      if (!r.file) return err(409, "report_has_no_file");
      r.status = "published";
      r.publishedAt = new Date().toISOString();
      r.publishedByName = actor;
      return ok({ id: r.id, status: "published", publishedAt: r.publishedAt });
    }
    let parsed: { reason?: unknown } = {};
    try { parsed = body ? (JSON.parse(body) as { reason?: unknown }) : {}; } catch { parsed = {}; }
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    if (!reason) return err(400, "reason_required");
    if (reason.length > MAX_REASON) return err(400, "reason_too_long");
    if (r.status !== "published") return err(409, "not_published");
    r.status = "withdrawn";
    r.withdrawnAt = new Date().toISOString();
    r.withdrawnByName = actor;
    r.withdrawnReason = reason;
    return ok({ id: r.id, status: "withdrawn", withdrawnAt: r.withdrawnAt });
  }
  return null;
}
